<#
.SYNOPSIS
    Show, acquire, or release the writable role for this workspace's collection.

.DESCRIPTION
    PLAN-public-release.md step 21. Attachment to a collection is READ-ONLY by default; exactly one
    workspace at a time may write to it. This is the reader-facing surface over that role.
    tools/CollectionOwnership.ps1 holds the protocol and the reasoning; this file is the three verbs.

    -Status IS THE DEFAULT, AND IT NEVER WRITES. It reports the backend state, the collection root,
    who holds the role and at which incarnation -- and, when the role is unheld or held elsewhere,
    the refusal a shared write would receive, in the words it would receive it. A reader asking
    "why was that refused" gets the same sentence from here as from the write that refused.

    -Acquire IS ADDITIVE AND REVERSIBLE, so it applies directly: it writes one claim record and
    removes nothing, and -Release gives the role back. Re-running it is idempotent. What it cannot do
    is take a role another workspace holds -- that refusal names both remedies.

    -Acquire -Force DISPLACES ANOTHER WORKSPACE, and is the one thing here that is not reversible by
    the party it affects: the displaced workspace's next write is refused wherever it is running, and
    it has no way to undo this from there. So -Force without -UserConfirmed is a PREFLIGHT: it
    reports exactly what it would displace and writes nothing. Confirm it only when that workspace is
    genuinely gone; if it is merely idle, -Release run there is the correct route and leaves no
    forced-takeover record behind.

    -Release REFUSES WHILE THIS WORKSPACE HOLDS A BOOK LOCK, which is the handoff's whole safety: a
    release states that no write of ours is in flight, and the next owner starts writing immediately.
#>
[CmdletBinding()]
param(
    [switch]$Status,
    [switch]$Acquire,
    [switch]$Release,
    [switch]$Force,
    [switch]$UserConfirmed,
    # Which workspace's collection. Order: this, then LIBRARY_WORKSPACE, then the nearest marker
    # above the working directory, then the program's own root where that really is a workspace.
    [string]$WorkspacePath,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'CollectionOwnership.ps1')
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')

$modes = @($Acquire, $Release) | Where-Object { $_ }
if (@($modes).Count -gt 1) {
    throw 'Pass one of -Acquire or -Release, or neither for -Status. Acquiring and releasing in one run would be two decisions in one command.'
}

$workspace = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
$backend = Get-CollectionBackendState -WorkspacePath $workspace
$marker = Read-WorkspaceMarker -Workspace $workspace
$workspaceId = [string](Get-WorkspaceMarkerField $marker 'id')

if ([string]$backend.state -cne 'attached') {
    if ($Acquire -or $Release) {
        throw ('The writable role cannot be ' + $(if ($Acquire) { 'acquired' } else { 'released' }) +
               ': ' + [string]$backend.refusal)
    }
    $result = [ordered]@{
        operation       = 'collection ownership'
        mode            = 'status'
        workspace       = $workspace
        workspace_id    = $workspaceId
        backend         = [string]$backend.state
        collection_root = [string]$backend.collection_root
        harness_servers = @($backend.harness_servers)
        role            = 'unavailable'
        refusal         = [string]$backend.refusal
    }
    Write-LibraryResult -Result ([pscustomobject]$result) -Json:$Json
    return
}

if ([string]::IsNullOrWhiteSpace($workspaceId)) {
    throw ("$workspace carries no workspace marker, so it has no identity to record against the " +
           'collection. Run tools/Initialize-LibraryWorkspace.ps1 to make it a workspace first.')
}

$collectionRoot = [string]$backend.collection_root
$record = Read-CollectionOwnership -CollectionRoot $collectionRoot

# ==================================================================================================
# ACQUIRE
# ==================================================================================================
if ($Acquire) {
    # THE PREFLIGHT HALF OF -Force. Reported before anything is written, because the reader is being
    # asked to confirm the displacement of a workspace they may not be sitting at.
    if ($Force -and -not $UserConfirmed -and [string]$record.state -ceq 'held' -and [string]$record.workspace_id -cne $workspaceId) {
        $preflight = [ordered]@{
            operation        = 'collection ownership'
            mode             = 'acquire-preflight'
            workspace        = $workspace
            workspace_id     = $workspaceId
            collection_root  = $collectionRoot
            would_displace   = [string]$record.workspace_id
            displaced_machine = [string]$record.machine
            displaced_since  = [string]$record.acquired
            incarnation_now  = [int]$record.incarnation
            incarnation_next = [int]$record.next_incarnation
            confirmed        = $false
            advice           = ("Re-run with -Force -UserConfirmed only if workspace $($record.workspace_id) " +
                                "on $($record.machine) is gone for good. If it is merely idle, run " +
                                'tools/Set-CollectionOwner.ps1 -Release there instead: a forced takeover is ' +
                                "recorded permanently and the displaced workspace's next shared write is refused " +
                                'wherever it is running.')
        }
        Write-LibraryResult -Result ([pscustomobject]$preflight) -Json:$Json
        return
    }

    $acquired = Enter-CollectionOwnership -CollectionRoot $collectionRoot -WorkspaceId $workspaceId `
        -WorkspacePath $workspace -Force:$Force
    $result = [ordered]@{
        operation       = 'collection ownership'
        mode            = 'acquire'
        outcome         = [string]$acquired.outcome
        workspace       = $workspace
        workspace_id    = $workspaceId
        collection_root = $collectionRoot
        incarnation     = [int]$acquired.incarnation
        displaced       = [string]$acquired.displaced
        record          = [string]$acquired.path
    }
    Write-LibraryResult -Result ([pscustomobject]$result) -Json:$Json
    return
}

# ==================================================================================================
# RELEASE
# ==================================================================================================
if ($Release) {
    $released = Exit-CollectionOwnership -CollectionRoot $collectionRoot -WorkspaceId $workspaceId -WorkspacePath $workspace
    $result = [ordered]@{
        operation       = 'collection ownership'
        mode            = 'release'
        outcome         = [string]$released.outcome
        workspace       = $workspace
        workspace_id    = $workspaceId
        collection_root = $collectionRoot
        incarnation     = [int]$released.incarnation
    }
    Write-LibraryResult -Result ([pscustomobject]$result) -Json:$Json
    return
}

# ==================================================================================================
# STATUS
# ==================================================================================================
# THE ROLE IS REPORTED AS THIS WORKSPACE SEES IT, and the refusal a write would get is reported with
# it -- derived by asking the fence, never by composing a second sentence that could drift from the
# one the writers actually print.
$role = 'read-only'
$refusal = ''
if ([string]$record.state -ceq 'unowned') { $role = 'unowned' }
elseif ([string]$record.workspace_id -ceq $workspaceId -and [string]$record.state -ceq 'held') { $role = 'writable' }

try {
    # The state this helper already resolved is handed in rather than resolved a second time: two
    # reads of the same question in one run are two chances to report different answers, and the
    # whole point of this line is that the refusal shown here is the refusal a write would get.
    $token = Assert-CollectionWriteAllowed -WorkspacePath $workspace -Operation 'a shared write' -BackendState $backend
    if ([string]$token.reason -ceq 'unowned') {
        $refusal = ('No workspace owns this collection yet, so shared writes are not fenced. ' +
                    'tools/Set-CollectionOwner.ps1 -Acquire claims the writable role for this workspace ' +
                    'and refuses every other workspace from then on.')
    }
}
catch { $refusal = [string]$_.Exception.Message }

$result = [ordered]@{
    operation       = 'collection ownership'
    mode            = 'status'
    workspace       = $workspace
    workspace_id    = $workspaceId
    backend         = [string]$backend.state
    collection_root = $collectionRoot
    harness_servers = @($backend.harness_servers)
    role            = $role
    state           = [string]$record.state
    incarnation     = [int]$record.incarnation
    held_by         = [string]$record.workspace_id
    held_on         = [string]$record.machine
    acquired        = [string]$record.acquired
    released        = [string]$record.released
    release_reason  = [string]$record.release_reason
    incarnations    = [int]$record.claims
    record          = [string]$record.owner_directory
    refusal         = $refusal
}
Write-LibraryResult -Result ([pscustomobject]$result) -Json:$Json
