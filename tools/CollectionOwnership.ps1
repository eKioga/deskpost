<#
.SYNOPSIS
    One writable workspace per collection: the ownership record, the fence every shared write
    passes, and the four backend states. Dot-sourced; never invoked directly except with -SelfTest.

.DESCRIPTION
    PLAN-public-release.md step 21, ADR-0030. Step 20 made a workspace a real thing that can be
    created anywhere and registered; `writable` in its marker has been a REQUEST recorded at init
    time and nothing more, because nothing granted the role. This grants it.

    WHY THE ROLE EXISTS AT ALL, and it is not tidiness. Book locks live under each workspace --
    `internal/book-locks/`, see BookWriteGuard.ps1 -- so two workspaces attached to one collection
    take two different locks over the same page. Exclusion that looks present is absent. That is the
    split-lock defect ADR-0015 rejected when it refused "clone the checkout per topic", and step 20
    made cloning easy for the first time. So attachment is READ-ONLY by default and exactly one
    workspace per collection may write.

    THE RECORD IS A DIRECTORY OF PER-INCARNATION CLAIMS, AND THAT IS A DELIBERATE DEPARTURE FROM THE
    PLAN'S ONE-LINE SKETCH. The plan says "exclusive create of `collection/.owner`", which is right
    about the primitive and cannot carry a transfer: a single file has to be DELETED before the next
    owner can create it, and delete-then-create is not atomic. Two acquirers that both observed a
    release would then both delete and both create, and the second delete removes the first winner's
    own record -- two workspaces each holding incarnation N+1 and neither able to tell. So:

      collection/.owner/0001.claim.json     exclusive create IS the allocation of incarnation 1
      collection/.owner/0001.release.json   exclusive create IS the release of incarnation 1
      collection/.owner/0002.claim.json     the next owner, allocated the same way

    Nothing is ever deleted or rewritten. The current owner is DERIVED -- the highest claim with no
    matching release -- so there is no mutable pointer to disagree with the records, and every state
    a crash can leave is a state this file can name. `CreateNew` is the only mutating primitive,
    which is the one thing a network share arbitrates for us.

    THE INCARNATION IS THE FENCE. A writer that acquired at N and was force-transferred away while
    its write was in flight must not commit: Assert-CollectionWriteAllowed returns a token carrying
    the incarnation it observed, and Assert-CollectionFenceUnchanged refuses if the record has moved
    on. A one-shot helper gets the entry check; a multi-step publication re-checks before it
    commits.

    AN UNOWNED COLLECTION IS PERMITTED, AND THAT IS THE DAY-ONE RULE RATHER THAN A HOLE. Every
    collection in existence today has no ownership record, this workspace included, and a fence that
    refused on absence would brick every shared write in the Library the moment it shipped -- the
    new-invariant-versus-day-one-data failure this plan has already paid for once. So absence means
    the invariant is NOT YET ARMED, the status surface says so in those words, and the first
    successful acquire arms it permanently: after that, absence cannot recur, because nothing deletes
    a claim. Step 22's migration is where this collection acquires the role.

    THE FENCE NEEDS A FILESYSTEM VIEW OF THE COLLECTION, which is why a configured endpoint with no
    share root is `misconfigured` rather than merely unhelpful. Basic Memory's deployed MCP surface
    has no exclusive-create verb of any kind -- probed at 21 tools on 2026-09-03, see
    SharedCollectionFiles.ps1 -- so the arbitration cannot ride on the transport the writers already
    use. A writer that cannot see the collection's files cannot be fenced, and an unfenceable writer
    is the split-writer hazard itself, so it is refused and told which of the two routes to
    configure.
#>

# NO param() BLOCK, AND THAT IS NOT AN OVERSIGHT. Dot-sourcing a script that declares parameters
# BINDS them in the CALLER'S scope with their defaults, silently -- which is how
# WorkspaceRegistry.ps1 once cleared a caller's own -SelfTest and ran the real initialiser against
# this repository. Both that file and BookRootSchema.ps1 read their one flag off $args instead, and
# this file is about to be dot-sourced by ten helpers.
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')
. (Join-Path $PSScriptRoot 'SharedCollectionFiles.ps1')
# For Read-WorkspaceMarker and Get-WorkspaceMarkerField: the workspace id in the ownership record is
# the marker's id, read by the one file that owns that question rather than re-parsed here.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')

$script:CollectionOwnershipSchema = 1
$script:CollectionOwnerDirectoryName = '.owner'
$script:CollectionOwnerRecordPattern = '^(?<n>\d{4,})\.(?<kind>claim|release)\.json$'
$script:CollectionLocalFolderName = 'collection'
$script:Utf8NoBom = [Text.UTF8Encoding]::new($false)
# Initialised at load, because Set-StrictMode makes reading an unset variable a terminating error
# and Assert-LibraryWriteFenceUnchanged's whole job is to notice that nothing set it.
$script:LibraryWriteFenceToken = $null

# ==================================================================================================
# THE FOUR BACKEND STATES
# ==================================================================================================
#
# ADR-0030 names four, and each one is a DIFFERENT reason a shared-collection operation cannot
# proceed with a different fix, which is the whole reason they are not one "unavailable":
#
#   local             no endpoint is configured and the harness exposes none. Tier 0. There is no
#                     shared collection to write to, and that is a working configuration, not a
#                     fault.
#   harness-exposed   the reader's own harness config exposes a Basic Memory server and the Library
#                     is not configured against one. The Library neither uses nor guards that server
#                     and says so, rather than adopting it.
#   misconfigured     the configuration contradicts itself or is incomplete: an endpoint with no
#                     collection id, a collection id with no endpoint, or -- for ownership -- an
#                     endpoint with no filesystem view of the collection.
#   unreachable       everything is configured and the collection is not there: the share root is
#                     absent, or present and not a collection.
#
# `attached` is the fifth and is the only one that is not a refusal.
$script:CollectionBackendStates = @('attached', 'local', 'harness-exposed', 'misconfigured', 'unreachable')

function Get-HarnessExposedBasicMemoryServers {
    <#
    .SYNOPSIS
        Basic Memory MCP servers the READER'S harness config exposes, which are not the Library's.

    .DESCRIPTION
        Read, never adopted. ADR-0030 rejected Basic Memory as a peer MCP server beside the
        Library's: a guard inside the Library's server cannot intercept a separately exposed one, so
        the Library exposes one facade and Basic Memory is a backend behind it. A reader who has
        their own Basic Memory server wired into Claude or Codex still has it, and this is how the
        program can say "that one is yours, I neither use nor guard it" instead of silently
        behaving as though it were the backend.

        MATCHED ON THE SERVER'S OWN TEXT rather than a name list, because a reader names their
        servers whatever they like. The Library's own facade is excluded by name -- it IS the
        validated reader -- and a `basic-memory` mention anywhere in the entry's command, args or
        url is what identifies the rest.
    #>
    param([Parameter(Mandatory = $true)][string]$WorkspacePath)

    $found = [Collections.Generic.List[string]]::new()
    $candidates = @(
        (Join-Path $WorkspacePath '.mcp.json'),
        (Join-Path $WorkspacePath (Join-Path '.claude' 'settings.json'))
    )
    foreach ($path in $candidates) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $doc = $null
        try { $doc = [IO.File]::ReadAllText($path, $script:Utf8NoBom) | ConvertFrom-Json }
        catch { continue }   # an unreadable harness config is not this function's business to judge
        if ($null -eq $doc -or $null -eq $doc.PSObject.Properties['mcpServers']) { continue }
        $servers = $doc.mcpServers
        if ($null -eq $servers) { continue }
        foreach ($property in $servers.PSObject.Properties) {
            if ([string]$property.Name -ceq 'validated-book-reader') { continue }
            $text = ''
            try { $text = ($property.Value | ConvertTo-Json -Depth 8 -Compress) } catch { $text = '' }
            $haystack = ("$($property.Name) $text").ToLowerInvariant()
            if ($haystack -match 'basic[-_]memory') { [void]$found.Add([string]$property.Name) }
        }
    }
    # No comma-return: every call site wraps this in @(), and the two together build an array
    # holding one array, whose .Count is 1 even when nothing was found -- which read every workspace
    # as exposing a foreign Basic Memory server.
    $found | Sort-Object -Unique
}

function Get-CollectionBackendState {
    <#
    .SYNOPSIS
        Which of the five states this workspace's collection backend is in, and the refusal that
        belongs to it.

    .DESCRIPTION
        ONE CLASSIFIER, ONE STATE, AND THE PRECEDENCE IS THE POINT. A workspace can be
        misconfigured AND have a foreign server in its harness; reporting two states would leave
        every caller deciding which refusal to print. Contradictory configuration comes first
        because nothing can be attempted against it; then the foreign server, because a reader who
        has one will otherwise read `local` and conclude the program is broken; then local; then
        reachability, which can only be judged once the addresses are known.

        EVERY AMBIENT VALUE ARRIVES AS A PARAMETER DEFAULT, resolved here at the one boundary, so a
        fixture drives this without reaching into the environment and a caller never has to know
        which variables exist.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$WorkspacePath,
        [string]$McpUrl = (Resolve-LibraryMcpUrl -WorkspacePath $WorkspacePath -Optional),
        [string]$CollectionId = (Resolve-LibraryCollectionId -WorkspacePath $WorkspacePath -Optional),
        [string]$SharedRoot = (Resolve-LibrarySharedCollectionRoot -WorkspacePath $WorkspacePath)
    )

    $foreign = @(Get-HarnessExposedBasicMemoryServers -WorkspacePath $WorkspacePath)
    $hasEndpoint = -not [string]::IsNullOrWhiteSpace($McpUrl)
    $hasCollectionId = -not [string]::IsNullOrWhiteSpace($CollectionId)
    $hasSharedRoot = -not [string]::IsNullOrWhiteSpace($SharedRoot)

    function New-BackendState([string]$State, [string]$Refusal, [string]$OwnerRoot) {
        [pscustomobject]@{
            state              = $State
            refusal            = $Refusal
            mcp_url            = $McpUrl
            collection_id      = $CollectionId
            shared_root        = $SharedRoot
            harness_servers    = $foreign
            collection_root    = $OwnerRoot
            workspace          = $WorkspacePath
        }
    }

    if ($hasEndpoint -and -not $hasCollectionId) {
        return New-BackendState 'misconfigured' (
            "A Basic Memory endpoint is configured ($McpUrl) but no collection id is, so there is an " +
            'address and nothing to address at it. Set AI_LIBRARY_PROJECT_ID, or run ' +
            'tools/Initialize-CodexLibrary.ps1 -McpUrl <url> -CollectionId <id> once to write ' +
            '.claude/.library-project for this workspace.') ''
    }
    if ($hasCollectionId -and -not $hasEndpoint) {
        return New-BackendState 'misconfigured' (
            "A collection id is configured ($CollectionId) but no Basic Memory endpoint is, so no " +
            'shared Book or Project Hub can be reached. Set AI_LIBRARY_MCP_URL, or run ' +
            'tools/Initialize-CodexLibrary.ps1 -McpUrl <url> -CollectionId <id> once to write ' +
            '.claude/.library-mcp-url for this workspace.') ''
    }
    if (-not $hasEndpoint) {
        if ($foreign.Count) {
            return New-BackendState 'harness-exposed' (
                "This workspace has no Basic Memory backend configured, and your own harness config " +
                "exposes $($foreign.Count) Basic Memory server(s): $($foreign -join ', '). The Library " +
                'neither uses nor guards those -- a guard inside the Library''s own server cannot ' +
                'intercept a server exposed beside it (ADR-0030), so reads and writes through them are ' +
                'outside every Desk and Shelf boundary this program enforces. To give the Library a ' +
                'backend, configure it explicitly with tools/Initialize-CodexLibrary.ps1 -McpUrl <url> ' +
                '-CollectionId <id>.') ''
        }
        # The local collection folder is Phase D's durable Tier 0 store (ADR-0030). Reported when it
        # is there and left empty when it is not, rather than named as though it existed.
        $localRoot = Join-Path $WorkspacePath $script:CollectionLocalFolderName
        $localFound = ''
        if (Test-Path -LiteralPath $localRoot -PathType Container) { $localFound = $localRoot }
        return New-BackendState 'local' (
            'This workspace is in local mode: no Basic Memory endpoint is configured, so there is no ' +
            'shared collection to reach. Local-collection reads and writes are unaffected. To attach ' +
            'a shared collection, run tools/Initialize-CodexLibrary.ps1 -McpUrl <url> -CollectionId ' +
            '<id>.') $localFound
    }
    if (-not $hasSharedRoot) {
        return New-BackendState 'misconfigured' (
            "This workspace is attached to a Basic Memory collection at $McpUrl with no filesystem " +
            'view of it, so its writes cannot be fenced: one writable workspace per collection is ' +
            'arbitrated by exclusive create in the collection''s own folder, and the deployed Basic ' +
            'Memory MCP surface has no exclusive-create verb to do it over the transport. Set ' +
            'LIBRARY_SHARED_COLLECTION_ROOT, or write the path into .claude/.library-shared-root, ' +
            'and run tools/Set-CollectionOwner.ps1 -Status to confirm it.') ''
    }
    if (-not (Test-SharedCollectionRoot -Path $SharedRoot)) {
            $why = 'it is not there'
        if (Test-Path -LiteralPath $SharedRoot -PathType Container) {
            $why = 'it is a directory that carries neither books\README.md nor projects\README.md, so it is not a collection'
        }
        return New-BackendState 'unreachable' (
            "The collection's configured filesystem root is unreachable: $SharedRoot -- $why. If the " +
            'share is simply disconnected, reconnect it and try again; if the path is wrong, correct ' +
            'LIBRARY_SHARED_COLLECTION_ROOT or .claude/.library-shared-root. Nothing was attempted ' +
            'against the collection.') ''
    }
    New-BackendState 'attached' '' $SharedRoot
}

# ==================================================================================================
# THE OWNERSHIP RECORD
# ==================================================================================================
function Get-CollectionOwnerDirectory([string]$CollectionRoot) {
    Join-Path $CollectionRoot $script:CollectionOwnerDirectoryName
}

function ConvertTo-CollectionRecordName([int]$Incarnation, [string]$Kind) {
    # Zero-padded so a listing sorts the way a reader expects; the NUMBER is what is compared, parsed
    # from the name, so the padding is cosmetic and incarnation 10000 simply gets a fifth digit.
    '{0:d4}.{1}.json' -f $Incarnation, $Kind
}

function Read-CollectionOwnership {
    <#
    .SYNOPSIS
        Who holds the writable role for this collection, derived from the claim and release records.

    .DESCRIPTION
        THE STATE IS DERIVED AND NEVER STORED, so there is no pointer that can disagree with the
        records it points at. Three states:

          unowned    no claim record exists. The invariant is not armed; see the file header.
          held       the highest claim has no matching release. That workspace may write.
          released   the highest claim has a matching release. The role is free; the next acquire
                     takes the following incarnation.

        AN UNREADABLE OR CONTRADICTORY RECORD THROWS AND IS NEVER INTERPRETED. A claim whose body
        disagrees with its own filename, a record of the wrong schema, a plain release of somebody
        else's claim -- each of those is a record that was edited by hand or written by something
        that is not this file, and guessing which half to believe is how one workspace concludes it
        owns a collection another workspace is writing.
    #>
    param([Parameter(Mandatory = $true)][string]$CollectionRoot)

    $ownerDir = Get-CollectionOwnerDirectory $CollectionRoot
    $result = [ordered]@{
        collection_root = $CollectionRoot
        owner_directory = $ownerDir
        state           = 'unowned'
        incarnation     = 0
        workspace_id    = ''
        machine         = ''
        acquired        = ''
        released        = ''
        release_reason  = ''
        claims          = 0
        next_incarnation = 1
    }

    if (Test-Path -LiteralPath $ownerDir -PathType Leaf) {
        throw ("The collection's ownership record at $ownerDir is a FILE. It is a directory of " +
               'per-incarnation claim and release records, because a single file cannot be handed ' +
               'from one owner to the next atomically -- see tools/CollectionOwnership.ps1. Move that ' +
               'file aside by hand; nothing here will overwrite it.')
    }
    if (-not (Test-Path -LiteralPath $ownerDir -PathType Container)) { return [pscustomobject]$result }

    $claims = @{}
    $releases = @{}
    foreach ($file in @(Get-ChildItem -LiteralPath $ownerDir -File -ErrorAction SilentlyContinue)) {
        # An explicit Match rather than -cmatch and $Matches: the automatic variable is set as a side
        # effect of the LAST comparison anywhere in scope, and everything below this line reads it.
        $parsed = [regex]::Match($file.Name, $script:CollectionOwnerRecordPattern)
        if (-not $parsed.Success) { continue }
        $number = [int]$parsed.Groups['n'].Value
        $kind = [string]$parsed.Groups['kind'].Value
        $doc = $null
        try { $doc = [IO.File]::ReadAllText($file.FullName, $script:Utf8NoBom) | ConvertFrom-Json }
        catch {
            throw ("The collection's ownership record $($file.Name) is not readable JSON, so who may " +
                   "write to this collection cannot be determined: $($_.Exception.Message). It is at " +
                   "$($file.FullName). Nothing here will overwrite it.")
        }
        $schemaField = Get-WorkspaceMarkerField $doc 'schema'
        $declaredSchema = 'none'
        if (-not [string]::IsNullOrWhiteSpace([string]$schemaField)) { $declaredSchema = [string]$schemaField }
        if ($declaredSchema -cne [string]$script:CollectionOwnershipSchema) {
            throw ("The collection's ownership record $($file.Name) declares schema $declaredSchema, " +
                   "and this program writes and reads schema $($script:CollectionOwnershipSchema). A " +
                   'record from another version is not interpreted. Upgrade the program, or move that ' +
                   "record aside by hand: $($file.FullName).")
        }
        $recordedIncarnation = [int](Get-WorkspaceMarkerField $doc 'incarnation')
        if ($recordedIncarnation -ne $number) {
            throw ("The collection's ownership record $($file.Name) names incarnation $number in its " +
                   "filename and $recordedIncarnation in its body. One of the two was edited by hand; " +
                   'neither is trusted. Nothing here will overwrite it: ' + $file.FullName)
        }
        $workspaceId = [string](Get-WorkspaceMarkerField $doc 'workspace_id')
        if ([string]::IsNullOrWhiteSpace($workspaceId)) {
            throw ("The collection's ownership record $($file.Name) names no workspace, so it cannot " +
                   "say who holds the writable role: $($file.FullName).")
        }
        if ($kind -ceq 'claim') { $claims[$number] = $doc } else { $releases[$number] = $doc }
    }

    $result.claims = $claims.Count
    if (-not $claims.Count) {
        # A release with no claim is a record of something that never happened.
        if ($releases.Count) {
            throw ("The collection's ownership record holds $($releases.Count) release(s) and no " +
                   "claim, which cannot have happened: $(Get-CollectionOwnerDirectory $CollectionRoot). " +
                   'Nothing here will overwrite it.')
        }
        return [pscustomobject]$result
    }

    $highest = ($claims.Keys | Sort-Object -Descending | Select-Object -First 1)
    $claim = $claims[[int]$highest]
    $result.incarnation = [int]$highest
    $result.workspace_id = [string](Get-WorkspaceMarkerField $claim 'workspace_id')
    $result.machine = [string](Get-WorkspaceMarkerField $claim 'machine')
    $result.acquired = [string](Get-WorkspaceMarkerField $claim 'acquired')
    $result.next_incarnation = [int]$highest + 1

    if ($releases.ContainsKey([int]$highest)) {
        $release = $releases[[int]$highest]
        $reason = [string](Get-WorkspaceMarkerField $release 'reason')
        $releasedBy = [string](Get-WorkspaceMarkerField $release 'workspace_id')
        # A PLAIN release is the owner standing down; only a FORCED one may be written by anybody
        # else, and it says so on its face. A plain release signed by a third party is a record this
        # file did not write.
        if ($reason -cne 'forced' -and $releasedBy -cne [string]$result.workspace_id) {
            throw ("The collection's release record for incarnation $highest is signed by workspace " +
                   "$releasedBy and the claim it releases is workspace $($result.workspace_id)'s. A " +
                   'release by another workspace is only valid as a forced takeover, which records ' +
                   "reason=forced. Neither record is trusted: $(Get-CollectionOwnerDirectory $CollectionRoot).")
        }
        $result.state = 'released'
        $result.released = [string](Get-WorkspaceMarkerField $release 'released')
        $result.release_reason = $reason
    }
    else {
        $result.state = 'held'
    }
    [pscustomobject]$result
}

function Write-CollectionOwnershipRecord {
    <#
    .SYNOPSIS
        Create one ownership record, or report that it already exists. Exclusive create, always.

    .DESCRIPTION
        THE CREATE OF THE FINAL NAME IS THE ARBITRATION, and it is a MOVE rather than an open. Both
        are atomic and both fail when the name is already taken -- `File.Move` without
        replace-existing raises ERROR_ALREADY_EXISTS on NTFS and on an SMB share exactly as
        `CreateNew` does -- but `CreateNew` makes the file VISIBLE, at zero bytes, before its body
        has been written. A concurrent reader landing in that window would read an empty record and
        report the collection's ownership as corrupt: a frightening integrity refusal manufactured by
        two correct operations overlapping. So the body is written under a staging name first and the
        record appears, complete, in one step. `Read-CollectionOwnership` is strict with no retries
        BECAUSE of that: an unreadable record really is a damaged one.

        NOTHING IS EVER DELETED OR REWRITTEN except a staging file this call made itself. A process
        killed between the write and the move leaves one behind; it does not match the record name
        pattern, so the reader ignores it, and it costs a few hundred bytes.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$OwnerDirectory,
        [Parameter(Mandatory = $true)][int]$Incarnation,
        [Parameter(Mandatory = $true)][ValidateSet('claim', 'release')][string]$Kind,
        [Parameter(Mandatory = $true)][hashtable]$Body
    )
    if (-not (Test-Path -LiteralPath $OwnerDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $OwnerDirectory -Force | Out-Null
    }
    $path = Join-Path $OwnerDirectory (ConvertTo-CollectionRecordName $Incarnation $Kind)
    $json = ([pscustomobject]$Body | ConvertTo-Json -Depth 6)
    $staging = Join-Path $OwnerDirectory ('.staging-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($staging, $json, $script:Utf8NoBom)
    try {
        [IO.File]::Move($staging, $path)
    }
    catch [IO.IOException] {
        Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
        return [pscustomobject]@{ created = $false; path = $path }
    }
    [pscustomobject]@{ created = $true; path = $path }
}

function Enter-CollectionOwnership {
    <#
    .SYNOPSIS
        Acquire the writable role for this collection, or refuse and name who holds it.

    .DESCRIPTION
        RE-ACQUIRING IS IDEMPOTENT, BECAUSE THE ROLE IS THE WORKSPACE'S AND NOT THE PROCESS'S. The
        first thing anybody does with a new tool is run it twice, and a workspace that already holds
        incarnation N holds it from every process on that machine. So a second acquire reports the
        incarnation it already has and writes nothing.

        A HELD ROLE IS NOT STOLEN. If another workspace holds it, this refuses and names the
        workspace, the incarnation, the machine and the time -- and names both remedies: that
        workspace releases, or -Force records a forced takeover here. -Force is not a repair; it is a
        statement that the other workspace is gone, written down with the forcer's name on it so the
        collection's history says who decided.

        LOSING THE CREATE RACE IS A REFUSAL, NOT A RETRY. Two acquirers that both saw the role free
        both try to create the same incarnation's claim; one wins. Retrying at N+2 would be a second
        writer politely taking a second role over the same collection, which is the entire defect
        this exists to prevent.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$CollectionRoot,
        [Parameter(Mandatory = $true)][string]$WorkspaceId,
        [string]$WorkspacePath = '',
        [switch]$Force
    )

    $ownerDir = Get-CollectionOwnerDirectory $CollectionRoot
    $before = Read-CollectionOwnership -CollectionRoot $CollectionRoot

    if ([string]$before.state -ceq 'held') {
        if ([string]$before.workspace_id -ceq $WorkspaceId) {
            # THE SAME PROPERTY SET AS THE `acquired` RETURN, INCLUDING `displaced`. Two outcomes of
            # one function returning two different shapes is a caller that reads a field on one path
            # and dies on the other under Set-StrictMode, which is exactly what
            # Set-CollectionOwner.ps1 did on the second run of an acquire -- found by driving the
            # helper rather than the primitive. Asserted by name in the self-test.
            return [pscustomobject]@{
                outcome = 'already_held'; incarnation = [int]$before.incarnation
                workspace_id = $WorkspaceId; collection_root = $CollectionRoot
                owner_directory = $ownerDir
                path = (Join-Path $ownerDir (ConvertTo-CollectionRecordName ([int]$before.incarnation) 'claim'))
                displaced = ''
            }
        }
        if (-not $Force) {
            throw ("Workspace $($before.workspace_id) holds the writable role for this collection at " +
                   "incarnation $($before.incarnation), acquired $($before.acquired) on " +
                   "$($before.machine). One writable workspace per collection: book locks live under " +
                   'each workspace, so a second writer would take a different lock over the same page ' +
                   '(ADR-0015, ADR-0030). Either release it there with ' +
                   'tools/Set-CollectionOwner.ps1 -Release, or -- only if that workspace is gone for ' +
                   'good -- take it over here with tools/Set-CollectionOwner.ps1 -Acquire -Force, which ' +
                   "records the takeover under this workspace's name. Record: $ownerDir")
        }
        # A forced release of the incumbent's incarnation, signed by the forcer. If it loses that
        # create, somebody released concurrently, which is the outcome we wanted anyway.
        Write-CollectionOwnershipRecord -OwnerDirectory $ownerDir -Incarnation ([int]$before.incarnation) -Kind 'release' -Body @{
            schema        = $script:CollectionOwnershipSchema
            incarnation   = [int]$before.incarnation
            workspace_id  = $WorkspaceId
            released      = [DateTime]::UtcNow.ToString('o')
            reason        = 'forced'
            displaced     = [string]$before.workspace_id
            machine       = [string]$env:COMPUTERNAME
        } | Out-Null
        $before = Read-CollectionOwnership -CollectionRoot $CollectionRoot
    }

    $next = [int]$before.next_incarnation
    $body = @{
        schema        = $script:CollectionOwnershipSchema
        incarnation   = $next
        workspace_id  = $WorkspaceId
        workspace_path = [string]$WorkspacePath
        machine       = [string]$env:COMPUTERNAME
        pid           = $PID
        acquired      = [DateTime]::UtcNow.ToString('o')
    }
    $written = Write-CollectionOwnershipRecord -OwnerDirectory $ownerDir -Incarnation $next -Kind 'claim' -Body $body
    if (-not $written.created) {
        $after = Read-CollectionOwnership -CollectionRoot $CollectionRoot
        throw ("Another workspace acquired incarnation $next of this collection's writable role while " +
               "this acquire was in flight; it is now held by $($after.workspace_id) on " +
               "$($after.machine). Nothing was written here. Run tools/Set-CollectionOwner.ps1 -Status " +
               'to see the current record.')
    }
    [pscustomobject]@{
        outcome = 'acquired'; incarnation = $next; workspace_id = $WorkspaceId
        collection_root = $CollectionRoot; owner_directory = $ownerDir; path = $written.path
        displaced = if ([string]$before.release_reason -ceq 'forced') { [string]$before.workspace_id } else { '' }
    }
}

function Get-HeldBookLockFiles {
    <#
    .SYNOPSIS
        The book-lock files present in this workspace, read off disk rather than from a ledger.

    .DESCRIPTION
        OFF DISK, DELIBERATELY. BookWriteGuard's in-process ledger answers "does THIS runspace hold
        the lock", which is the right question for a callee assuming its caller excluded everyone --
        and the wrong one here. A release must be refused while ANY process in this workspace holds a
        Book, including the session in the next window, and the lock file is the only thing both can
        see.
    #>
    param([Parameter(Mandatory = $true)][string]$WorkspacePath)
    # NO COMMA-RETURN HERE, and the caller's @() is why. A `, @()` return and an `@()` at the call
    # site are mutually exclusive: together they produce an array holding one empty array, whose
    # .Count is 1 and whose -join is 'System.Object[]', so the release refused every time and named
    # a lock that was not there. The first run of this suite found exactly that.
    $lockDir = Join-Path $WorkspacePath 'internal/book-locks'
    if (-not (Test-Path -LiteralPath $lockDir -PathType Container)) { return }
    Get-ChildItem -LiteralPath $lockDir -Filter '*.lock' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }
}

function Exit-CollectionOwnership {
    <#
    .SYNOPSIS
        Release the writable role, only while this workspace holds no Book lock.

    .DESCRIPTION
        THE OUTSTANDING-LOCK CHECK IS THE HANDOFF'S WHOLE SAFETY. A release says "no write of mine
        is in flight"; a workspace holding a Book lock is making exactly the opposite claim, and the
        next owner would begin writing pages this one is mid-way through. So the release is refused
        while any lock file is present, and it names them.

        A RELEASE THAT ALREADY EXISTS IS REPORTED, NOT REWRITTEN. Running the release twice is not an
        error, and the second run must not replace a record of when the first happened.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$CollectionRoot,
        [Parameter(Mandatory = $true)][string]$WorkspaceId,
        [Parameter(Mandatory = $true)][string]$WorkspacePath,
        [string]$Reason = 'released'
    )

    $ownerDir = Get-CollectionOwnerDirectory $CollectionRoot
    $state = Read-CollectionOwnership -CollectionRoot $CollectionRoot

    if ([string]$state.state -ceq 'unowned') {
        throw ('No workspace holds the writable role for this collection, so there is nothing to ' +
               "release. Record: $ownerDir")
    }
    if ([string]$state.workspace_id -cne $WorkspaceId) {
        throw ("This workspace ($WorkspaceId) does not hold the writable role for this collection; " +
               "workspace $($state.workspace_id) holds incarnation $($state.incarnation). A release " +
               'by another workspace is only valid as a forced takeover: ' +
               "tools/Set-CollectionOwner.ps1 -Acquire -Force. Record: $ownerDir")
    }
    if ([string]$state.state -ceq 'released') {
        return [pscustomobject]@{
            outcome = 'already_released'; incarnation = [int]$state.incarnation
            workspace_id = $WorkspaceId; released = [string]$state.released
            reason = [string]$state.release_reason; owner_directory = $ownerDir
        }
    }

    $locks = @(Get-HeldBookLockFiles -WorkspacePath $WorkspacePath)
    if ($locks.Count) {
        throw ("This workspace holds $($locks.Count) Book lock(s), so the writable role cannot be " +
               "released: $($locks -join ', '). A release states that no write of this workspace's is " +
               'in flight, and the next owner would otherwise begin writing pages this one is part ' +
               'way through. Wait for the writer to finish; if no writer is running, those files are a ' +
               "crashed run's leftovers in $(Join-Path $WorkspacePath 'internal/book-locks') and " +
               'removing them is safe.')
    }

    $written = Write-CollectionOwnershipRecord -OwnerDirectory $ownerDir -Incarnation ([int]$state.incarnation) -Kind 'release' -Body @{
        schema       = $script:CollectionOwnershipSchema
        incarnation  = [int]$state.incarnation
        workspace_id = $WorkspaceId
        released     = [DateTime]::UtcNow.ToString('o')
        reason       = $Reason
        machine      = [string]$env:COMPUTERNAME
    }
    [pscustomobject]@{
        outcome = if ($written.created) { 'released' } else { 'already_released' }
        incarnation = [int]$state.incarnation; workspace_id = $WorkspaceId
        reason = $Reason; owner_directory = $ownerDir; path = $written.path
    }
}

# ==================================================================================================
# THE FENCE
# ==================================================================================================
function Assert-CollectionWriteAllowed {
    <#
    .SYNOPSIS
        May this workspace write to its shared collection? Returns a fence token, or throws.

    .DESCRIPTION
        THE ONE DOOR EVERY SHARED WRITE PASSES, reached through Resolve-LibraryWriteEndpoint, which
        is further down THIS file rather than beside the resolver it wraps in LibraryDeployment.ps1 --
        that file would have had to dot-source this one, and this one dot-sources it, which is an
        unbounded load loop rather than a tidier arrangement. Enforced at one door for the reason
        Assert-NoMaintenanceBarrier is enforced inside Assert-SeatClaimHeld: the writers already
        share one line, and a guard added at nine of ten call sites is a guard that is absent.

        THE TOKEN IS WHAT MAKES IT A FENCE RATHER THAN A CHECK. It carries the incarnation this
        writer observed; Assert-CollectionFenceUnchanged refuses if the record has moved on since.
        A one-shot helper needs only the entry check. A multi-step publication re-checks before it
        commits, because that is the window in which a forced takeover can land.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$WorkspacePath,
        [string]$Operation = 'this shared write',
        [object]$BackendState
    )

    $state = if ($null -ne $BackendState) { $BackendState } else { Get-CollectionBackendState -WorkspacePath $WorkspacePath }

    # AN UNREACHABLE COLLECTION PERMITS, AND THAT IS AN EXISTING RULING RATHER THAN A NEW ONE.
    # SharedCollectionFiles.ps1 exists because "an unreachable share resolves to $null rather than
    # throwing: every caller degrades to unavailable and says so" -- turning a disconnected NAS
    # morning into a crash is the behaviour that file was written to end. The share and the HTTP
    # endpoint are different services, so a writer can be able to write while the arbitration cannot
    # be read, and refusing there would make every shared write depend on a mount. The residual risk
    # is named rather than hidden: while the share is down this fence cannot tell whether another
    # workspace holds the role, so it says `unreachable-view` in the token and permits.
    #
    # A CONFIGURED ENDPOINT WITH NO SHARE ROOT AT ALL IS DIFFERENT AND STILL REFUSES. That is a
    # static configuration fault rather than a transient one: the reader has never given the program
    # a filesystem view of the collection, so no write from that workspace can ever be fenced.
    if ([string]$state.state -ceq 'unreachable') {
        $marker = Read-WorkspaceMarker -Workspace $WorkspacePath
        return [pscustomobject]@{
            collection_root = ''
            workspace       = $WorkspacePath
            workspace_id    = if ($null -ne $marker) { [string](Get-WorkspaceMarkerField $marker 'id') } else { '' }
            incarnation     = 0
            state           = 'unreachable'
            reason          = 'unreachable-view'
        }
    }
    if ([string]$state.state -cne 'attached') {
        throw ("$Operation is refused: " + [string]$state.refusal)
    }

    $collectionRoot = [string]$state.collection_root
    $record = Read-CollectionOwnership -CollectionRoot $collectionRoot
    $marker = Read-WorkspaceMarker -Workspace $WorkspacePath
    $workspaceId = if ($null -ne $marker) { [string](Get-WorkspaceMarkerField $marker 'id') } else { '' }

    $token = [ordered]@{
        collection_root = $collectionRoot
        workspace       = $WorkspacePath
        workspace_id    = $workspaceId
        incarnation     = [int]$record.incarnation
        state           = [string]$record.state
        reason          = ''
    }

    if ([string]$record.state -ceq 'unowned') {
        # DAY ONE. See the file header: absence means the invariant is not armed, and the first
        # acquire arms it for good. Said out loud in the token so a caller can report it and a future
        # change to refuse here is a deliberate edit to a pinned string rather than a drift.
        $token.reason = 'unowned'
        return [pscustomobject]$token
    }
    if ([string]$record.state -ceq 'released') {
        throw ("$Operation is refused: no workspace holds the writable role for this collection. " +
               "Incarnation $($record.incarnation) was released by $($record.workspace_id) at " +
               "$($record.released). Acquire it here with tools/Set-CollectionOwner.ps1 -Acquire.")
    }
    if ([string]::IsNullOrWhiteSpace($workspaceId)) {
        throw ("$Operation is refused: workspace $($record.workspace_id) holds the writable role for " +
               "this collection at incarnation $($record.incarnation), and this directory " +
               "($WorkspacePath) carries no workspace marker, so it cannot be that workspace. Run " +
               'tools/Initialize-LibraryWorkspace.ps1 to make it a workspace.')
    }
    if ([string]$record.workspace_id -cne $workspaceId) {
        throw ("$Operation is refused: workspace $($record.workspace_id) holds the writable role for " +
               "this collection at incarnation $($record.incarnation), on $($record.machine). This " +
               "workspace ($workspaceId) is attached read-only. Release it there, or take it over " +
               'here with tools/Set-CollectionOwner.ps1 -Acquire -Force if that workspace is gone.')
    }
    $token.reason = 'held'
    [pscustomobject]$token
}

function Assert-CollectionFenceUnchanged {
    <#
    .SYNOPSIS
        Refuse to commit a shared write whose ownership moved while it was in flight.

    .DESCRIPTION
        THE STALE INCARNATION IS THE THING BEING CAUGHT. A writer acquired at N, a forced takeover
        recorded N+1 for somebody else, and this writer is about to commit pages the new owner may
        already be writing. The record's incarnation is compared against the token's, so a move in
        either direction refuses.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Token,
        [string]$Operation = 'this shared write'
    )
    # A token taken while the collection's filesystem view was unreachable carries no root to
    # re-read, and inventing one would turn "we could not check" into "we checked". It permits for
    # the reason the entry check permitted, and the token says which.
    if ([string]$Token.reason -ceq 'unreachable-view') { return $true }
    $record = Read-CollectionOwnership -CollectionRoot ([string]$Token.collection_root)
    if ([string]$Token.reason -ceq 'unowned') {
        if ([string]$record.state -ceq 'unowned') { return $true }
        throw ("$Operation is refused: this collection had no owner when the write began and " +
               "workspace $($record.workspace_id) has since acquired incarnation " +
               "$($record.incarnation). Nothing was committed. Re-run the operation.")
    }
    if ([int]$record.incarnation -ne [int]$Token.incarnation) {
        throw ("$Operation is refused: this write began under incarnation $($Token.incarnation) of " +
               "the collection's writable role and the record now reads incarnation " +
               "$($record.incarnation), held by $($record.workspace_id). The role moved while the " +
               'write was in flight, so this one is stale and nothing was committed.')
    }
    if ([string]$record.state -cne 'held') {
        throw ("$Operation is refused: the writable role at incarnation $($Token.incarnation) was " +
               "released while this write was in flight ($($record.release_reason)). Nothing was " +
               'committed. Acquire the role again with tools/Set-CollectionOwner.ps1 -Acquire.')
    }
    if ([string]$record.workspace_id -cne [string]$Token.workspace_id) {
        throw ("$Operation is refused: incarnation $($Token.incarnation) of this collection's " +
               "writable role is recorded for workspace $($record.workspace_id), not " +
               "$($Token.workspace_id). Nothing was committed.")
    }
    $true
}

function Resolve-LibraryWriteEndpoint {
    <#
    .SYNOPSIS
        The Basic Memory endpoint a helper may WRITE through: resolved, then fenced.

    .DESCRIPTION
        THE ONE DOOR, AND IT IS A DIFFERENT DOOR FROM THE READER'S ON PURPOSE. Every shared writer in
        this tree already resolved its endpoint on exactly one line, at the top of the script, with
        `Resolve-LibraryMcpUrl`; every shared READER resolved it the same way. One flag on that
        resolver would have made one expression do two jobs -- which is the defect S11 paid a session
        for -- so writing gets its own name. A reader that calls this is a reader that has been
        mislabelled, and `collection.write-fence-coverage` says so in both directions.

        -Optional IS THE SELF-TEST ESCAPE AND SKIPS THE FENCE ENTIRELY, exactly as it skips the
        refusal in Resolve-LibraryMcpUrl. A suite that runs offline against fixtures has no
        deployment and no collection, so there is nothing to be the one writer of; requiring one
        would make the gate unrunnable on the fresh clone Phase B is measured on.

        THE TOKEN IS KEPT so a multi-step writer can re-check before it commits, without threading a
        variable through every function between here and the transport.
        Assert-LibraryWriteFenceUnchanged is that re-check.
    #>
    [CmdletBinding()]
    param(
        [string]$McpUrl,
        [string]$WorkspacePath,
        [switch]$Optional,
        [string]$Operation = 'this shared write'
    )
    # THE ENDPOINT RESOLVES EXACTLY AS IT DID BEFORE THIS DOOR EXISTED, and passing $WorkspacePath
    # to it was a regression this session caught with the full gate. All ten writers called
    # `Resolve-LibraryMcpUrl -McpUrl $McpUrl` with NO workspace, so the deployment files come from
    # the program root; handing it a workspace instead made every offline suite that drives a helper
    # against a scratch workspace refuse with "no Basic Memory endpoint is configured". Which
    # workspace holds the writable role and which directory holds the deployment files are two
    # questions, and this door must not answer the second one differently from its callers.
    $resolved = Resolve-LibraryMcpUrl -McpUrl $McpUrl -Optional:$Optional
    if ($Optional) {
        $script:LibraryWriteFenceToken = $null
        return $resolved
    }
    $workspace = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
    # The deployment values are handed in from the same chain the writer used, so the state the
    # fence judges cannot disagree with the address the writer is about to send to. Only the
    # workspace-level facts -- the marker id and the harness config -- come from $workspace.
    $state = Get-CollectionBackendState -WorkspacePath $workspace -McpUrl $resolved `
        -CollectionId (Resolve-LibraryCollectionId -Optional) -SharedRoot (Resolve-LibrarySharedCollectionRoot)
    $script:LibraryWriteFenceToken = Assert-CollectionWriteAllowed -WorkspacePath $workspace `
        -Operation $Operation -BackendState $state
    $resolved
}

function Assert-McpWriteNotConflicted {
    <#
    .SYNOPSIS
        Refuse a `write_note` that Basic Memory answered with `action: conflict`.

    .DESCRIPTION
        A NO-OVERWRITE WRITE THAT FINDS A NOTE IS NOT AN ERROR TO BASIC MEMORY (measured against the
        NAS 2026-09-22, S33): `isError` is false, and the refusal is `action: "conflict"`,
        `error: "NOTE_ALREADY_EXISTS"` in the structured result. Every writer here read only `isError`,
        so a note another writer landed between this run's read and its write came back as a success,
        and the readback that followed read THAT writer's note. New-ProjectHub.ps1 reported `created`
        over it (S33); Archive-ProjectHub, Archive-SharedBook, Copy-LocalPagesToProject and
        Publish-SharedBookCandidate refused later under a sentence about a readback, a manifest offset
        or a Catalog line (S34, 4 of 272 red in Test-McpHelpers.ps1 before this). One check, one
        sentence, called straight after the `isError` test by every no-overwrite writer.
    #>
    param([Parameter(Mandatory = $true)]$Response, [Parameter(Mandatory = $true)][string]$Path)
    $written = $null
    $result = $Response.PSObject.Properties['result']
    if ($null -ne $result -and $null -ne $result.Value) {
        $structured = $result.Value.PSObject.Properties['structuredContent']
        if ($null -ne $structured -and $null -ne $structured.Value -and $null -ne $structured.Value.PSObject.Properties['result']) { $written = $structured.Value.result }
    }
    if ($null -ne $written -and $null -ne $written.PSObject.Properties['action'] -and [string]$written.action -ceq 'conflict') {
        throw "Write '$Path' was refused: a note already exists there, written by someone else since this run read the collection. Nothing was overwritten."
    }
}

function Assert-LibraryWriteFenceUnchanged {
    <#
    .SYNOPSIS
        Re-check, before committing, that the writable role has not moved since the write began.

    .DESCRIPTION
        FOR THE MULTI-STEP WRITERS. A publication reads, journals, writes several pages and then
        updates a manifest; a forced takeover landing anywhere in that window leaves the rest of it
        writing pages the new owner may already be writing. A one-shot edit does not need this and is
        not asked for it.

        NO TOKEN IS A FAULT IN THE CALLER, not a pass. Reaching a commit-time fence check without
        having passed the entry one means the writer resolved its endpoint somewhere this file cannot
        see, which is the state collection.write-fence-coverage exists to prevent.
    #>
    [CmdletBinding()]
    param([string]$Operation = 'this shared write')
    if ($null -eq $script:LibraryWriteFenceToken) {
        throw ("$Operation reached its commit-time ownership check without having passed the entry " +
               'one, so there is no incarnation to compare against. The writer must resolve its ' +
               'endpoint through Resolve-LibraryWriteEndpoint.')
    }
    Assert-CollectionFenceUnchanged -Token $script:LibraryWriteFenceToken -Operation $Operation
}

function Get-CollectionWriteHelpers {
    <#
    .SYNOPSIS
        The helpers that write to the shared collection, declared once so the gate can read them.

    .DESCRIPTION
        DECLARED HERE RATHER THAN RESTATED IN THE CHECK, for the reason desk.claim-coverage already
        records: a second copy is how the check and the code come to disagree about the one thing the
        check exists to be right about. `collection.write-fence-coverage` reads this list and the
        AST of every helper, both ways.

        WHAT MAKES A HELPER A MEMBER: it issues a write verb against the collection -- write_note,
        edit_note, move_note, delete_note -- or delegates to one that does. Invoke-LibraryTriage is
        a member on the second ground: it performs some destinations inline and delegates the rest.

        THE READERS ARE ABSENT ON PURPOSE AND ARE NOT AN OVERSIGHT. SharedBookSource.ps1,
        McpDirectoryListing.ps1, Get-BookCurrency.ps1 and the validated reader adapter resolve the
        same endpoint to READ; a read is not fenced, because read-only attachment is the default and
        the point. SeatCreation.ps1 reads the Active Project Catalog to confirm a Hub exists and
        writes nothing to the collection. Initialize-CodexLibrary.ps1 writes harness config in the
        workspace, not pages in the collection.
    #>
    @(
        'Add-CatalogEntry.ps1',
        'Archive-ProjectHub.ps1',
        'Archive-SharedBook.ps1',
        'Copy-LocalPagesToProject.ps1',
        'Edit-ProjectHub.ps1',
        'Invoke-LibraryTriage.ps1',
        'New-ProjectHub.ps1',
        'Publish-SharedBookCandidate.ps1',
        'Remove-MemoryProject.ps1',
        'Remove-SharedEntry.ps1'
    )
}

# ==================================================================================================
# THE SELF-TEST
# ==================================================================================================
#
# THE RACE IS RUN WITH REAL PROCESSES, and that is the one case here that could not be modelled. Six
# `powershell.exe` children dot-source this file, spin on a gate file, and all call
# Enter-CollectionOwnership against one collection at the same instant. A fixture that called the
# function twice in sequence would exercise the "already held" branch and never the create race --
# it would prove the code works when the interleaving cannot happen, which is the shape of proof
# this plan has already paid for. Exactly one child must win, five must refuse naming the winner,
# and the collection must carry exactly one claim.
#
# EVERY AMBIENT DEPLOYMENT VALUE IS CLEARED FOR THE DURATION. Get-CollectionBackendState resolves
# its inputs through the real LibraryDeployment chain, so this machine's own endpoint and share root
# would otherwise decide what the `local` and `misconfigured` fixtures see, and the suite would pass
# or fail depending on whose workstation ran it.
function Invoke-CollectionOwnershipSelfTest {
    $failures = [Collections.Generic.List[string]]::new()
    $script:coChecks = 0
    function Check([bool]$Condition, [string]$Message) {
        $script:coChecks++
        if (-not $Condition) { [void]$failures.Add($Message) }
    }
    function CheckThrows([scriptblock]$Action, [string]$Pattern, [string]$What) {
        $script:coChecks++
        $message = ''
        try { & $Action | Out-Null }
        catch { $message = [string]$_.Exception.Message }
        if ([string]::IsNullOrEmpty($message)) { [void]$failures.Add("$What did not refuse at all") }
        elseif ($message -notmatch $Pattern) { [void]$failures.Add("$What refused with the wrong reason: $message") }
    }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('collection-own-' + [guid]::NewGuid().ToString('N'))
    $savedEnv = @{}
    foreach ($name in @('AI_LIBRARY_MCP_URL', 'AI_LIBRARY_PROJECT_ID', 'LIBRARY_SHARED_COLLECTION_ROOT')) {
        $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name)
        Set-Item -Path "env:$name" -Value ''
    }

    # One collection fixture builder, so every case starts from a real collection rather than a bare
    # directory: Test-SharedCollectionRoot admits a path only when it carries both markers.
    function New-CollectionFixture([string]$Path) {
        foreach ($area in @('books', 'projects')) {
            New-Item -ItemType Directory -Path (Join-Path $Path $area) -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $Path "$area\README.md"), "# $area`n", [Text.UTF8Encoding]::new($false))
        }
        $Path
    }
    function New-WorkspaceFixture([string]$Path, [string]$Id) {
        New-Item -ItemType Directory -Path (Join-Path $Path '.library') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $Path '.claude') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $Path '.library\workspace.json'),
            (@{ id = $Id; backend = 'basic-memory'; writable = $false } | ConvertTo-Json),
            [Text.UTF8Encoding]::new($false))
        $Path
    }
    function Write-Deployment([string]$Workspace, [string]$FileName, [string]$Value) {
        [IO.File]::WriteAllText((Join-Path $Workspace (Join-Path '.claude' $FileName)), $Value, [Text.UTF8Encoding]::new($false))
    }
    function Get-ClaimCount([string]$Root) {
        @(Get-ChildItem -LiteralPath (Get-CollectionOwnerDirectory $Root) -Filter '*.claim.json' -File -ErrorAction SilentlyContinue).Count
    }

    try {
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null

        # ==========================================================================================
        # 1. THE RECORD: acquire, re-acquire, refuse, release, hand over
        # ==========================================================================================
        $collection = New-CollectionFixture (Join-Path $tmp 'collection')
        $idA = 'aaaaaaaa-0000-0000-0000-00000000000a'
        $idB = 'bbbbbbbb-0000-0000-0000-00000000000b'

        $unowned = Read-CollectionOwnership -CollectionRoot $collection
        Check ([string]$unowned.state -ceq 'unowned') "a collection with no record read state '$($unowned.state)' rather than unowned"
        Check ([int]$unowned.next_incarnation -eq 1) "the first incarnation of an unowned collection is $($unowned.next_incarnation) rather than 1"

        $acquired = Enter-CollectionOwnership -CollectionRoot $collection -WorkspaceId $idA
        Check ([string]$acquired.outcome -ceq 'acquired') "the first acquire reported '$($acquired.outcome)'"
        Check ([int]$acquired.incarnation -eq 1) "the first acquire took incarnation $($acquired.incarnation) rather than 1"
        Check (Test-Path -LiteralPath $acquired.path -PathType Leaf) 'the first acquire wrote no claim record'

        $held = Read-CollectionOwnership -CollectionRoot $collection
        Check ([string]$held.state -ceq 'held') "after an acquire the record reads '$($held.state)' rather than held"
        Check ([string]$held.workspace_id -ceq $idA) "the record names workspace '$($held.workspace_id)' rather than the acquirer"

        # RE-ACQUIRING IS IDEMPOTENT. The role belongs to the workspace, not to the process that took
        # it, so a second run must not allocate a second incarnation to the same workspace.
        $again = Enter-CollectionOwnership -CollectionRoot $collection -WorkspaceId $idA
        Check ([string]$again.outcome -ceq 'already_held') "a re-acquire by the holder reported '$($again.outcome)'"
        # SHAPE BEFORE VALUES. Both outcomes of this function must carry the same properties, or a
        # caller reads a field on one path and dies on the other under Set-StrictMode --
        # Set-CollectionOwner.ps1 did exactly that on `displaced`, on the second run of an acquire,
        # and no assertion about VALUES would have caught it.
        $acquiredNames = @($acquired.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
        $againNames = @($again.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
        Check (($acquiredNames -join ',') -ceq ($againNames -join ',')) `
            ("the two acquire outcomes carry different properties: acquired={$($acquiredNames -join ',')} " +
             "already_held={$($againNames -join ',')}")
        Check ([int]$again.incarnation -eq 1) "a re-acquire moved the incarnation to $($again.incarnation)"
        Check ((Get-ClaimCount $collection) -eq 1) "a re-acquire left $(Get-ClaimCount $collection) claim(s) rather than 1"

        CheckThrows { Enter-CollectionOwnership -CollectionRoot $collection -WorkspaceId $idB } `
            ([regex]::Escape($idA) + '.*holds the writable role') 'a second workspace acquiring a held role'

        # A release needs the workspace it is released from, because the outstanding-lock check is a
        # question about that workspace's disk.
        $wsA = New-WorkspaceFixture (Join-Path $tmp 'ws-a') $idA
        CheckThrows { Exit-CollectionOwnership -CollectionRoot $collection -WorkspaceId $idB -WorkspacePath $wsA } `
            'does not hold the writable role' 'a release by a workspace that does not hold the role'

        # THE OUTSTANDING-LOCK REFUSAL, read off disk rather than out of a ledger.
        $lockDir = Join-Path $wsA 'internal\book-locks'
        New-Item -ItemType Directory -Path $lockDir -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $lockDir 'shelf-demo.lock'), "pid=$PID`n", [Text.UTF8Encoding]::new($false))
        CheckThrows { Exit-CollectionOwnership -CollectionRoot $collection -WorkspaceId $idA -WorkspacePath $wsA } `
            'shelf-demo\.lock' 'a release while a Book lock is held'
        Check ([string](Read-CollectionOwnership -CollectionRoot $collection).state -ceq 'held') `
            'a refused release released the role anyway'
        Remove-Item -LiteralPath (Join-Path $lockDir 'shelf-demo.lock') -Force

        $released = Exit-CollectionOwnership -CollectionRoot $collection -WorkspaceId $idA -WorkspacePath $wsA
        Check ([string]$released.outcome -ceq 'released') "the release reported '$($released.outcome)'"
        $afterRelease = Read-CollectionOwnership -CollectionRoot $collection
        Check ([string]$afterRelease.state -ceq 'released') "after a release the record reads '$($afterRelease.state)'"
        Check ([int]$afterRelease.next_incarnation -eq 2) "the next incarnation after release 1 is $($afterRelease.next_incarnation)"

        $twice = Exit-CollectionOwnership -CollectionRoot $collection -WorkspaceId $idA -WorkspacePath $wsA
        Check ([string]$twice.outcome -ceq 'already_released') "a second release reported '$($twice.outcome)'"
        Check (@(Get-ChildItem -LiteralPath (Get-CollectionOwnerDirectory $collection) -Filter '*.release.json' -File).Count -eq 1) `
            'a second release wrote a second release record'

        # THE HANDOVER, which is the point of the release record: B may now take it, and takes the
        # NEXT incarnation rather than reusing A's.
        $handover = Enter-CollectionOwnership -CollectionRoot $collection -WorkspaceId $idB
        Check ([string]$handover.outcome -ceq 'acquired') "the handover acquire reported '$($handover.outcome)'"
        Check ([int]$handover.incarnation -eq 2) "the handover took incarnation $($handover.incarnation) rather than 2"

        # THE FORCED TAKEOVER is a distinct, recorded act and not a silent steal.
        $forced = Enter-CollectionOwnership -CollectionRoot $collection -WorkspaceId $idA -Force
        Check ([int]$forced.incarnation -eq 3) "a forced takeover took incarnation $($forced.incarnation) rather than 3"
        Check ([string]$forced.displaced -ceq $idB) "the forced takeover recorded displaced='$($forced.displaced)'"
        $forcedRecord = Read-CollectionOwnership -CollectionRoot $collection
        Check ([string]$forcedRecord.workspace_id -ceq $idA) "after a forced takeover the record names '$($forcedRecord.workspace_id)'"
        $forcedRelease = Join-Path (Get-CollectionOwnerDirectory $collection) '0002.release.json'
        Check (Test-Path -LiteralPath $forcedRelease -PathType Leaf) 'a forced takeover wrote no release for the incarnation it displaced'
        $forcedDoc = [IO.File]::ReadAllText($forcedRelease) | ConvertFrom-Json
        Check ([string]$forcedDoc.reason -ceq 'forced') "the displacing release records reason '$($forcedDoc.reason)' rather than forced"

        # No staging file survives a run in which every write succeeded.
        $staging = @(Get-ChildItem -LiteralPath (Get-CollectionOwnerDirectory $collection) -Filter '.staging-*' -File -Force -ErrorAction SilentlyContinue)
        Check ($staging.Count -eq 0) "$($staging.Count) staging file(s) were left behind by successful writes"

        # ==========================================================================================
        # 2. THE RACE, with real processes
        # ==========================================================================================
        $raceRoot = New-CollectionFixture (Join-Path $tmp 'race')
        $gate = Join-Path $tmp 'race-gate'
        $racerPath = Join-Path $tmp 'racer.ps1'
        $racer = @'
param([string]$Tools, [string]$Root, [string]$WorkspaceId, [string]$Gate, [string]$Out)
Set-StrictMode -Version Latest
. (Join-Path $Tools 'CollectionOwnership.ps1')
# The gate is opened only once every child has loaded, so the contention is real rather than a
# function of how long each child took to start.
while (-not (Test-Path -LiteralPath $Gate)) { Start-Sleep -Milliseconds 5 }
$line = ''
try {
    $result = Enter-CollectionOwnership -CollectionRoot $Root -WorkspaceId $WorkspaceId
    $line = "won $($result.outcome) $($result.incarnation)"
}
catch {
    $line = "lost $($_.Exception.Message -replace '\s+', ' ')"
}
[IO.File]::WriteAllText($Out, $line, [Text.UTF8Encoding]::new($false))
'@
        [IO.File]::WriteAllText($racerPath, $racer, [Text.UTF8Encoding]::new($false))

        $racers = @()
        $outputs = @()
        for ($i = 1; $i -le 6; $i++) {
            $out = Join-Path $tmp "race-$i.txt"
            $outputs += $out
            $racers += Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $racerPath,
                '-Tools', $PSScriptRoot, '-Root', $raceRoot,
                '-WorkspaceId', ('racer-{0:d2}' -f $i), '-Gate', $gate, '-Out', $out)
        }
        Start-Sleep -Milliseconds 1200
        [IO.File]::WriteAllText($gate, 'go', [Text.UTF8Encoding]::new($false))
        foreach ($process in $racers) { $process.WaitForExit(60000) | Out-Null }

        $lines = @($outputs | ForEach-Object {
            if (Test-Path -LiteralPath $_ -PathType Leaf) { [IO.File]::ReadAllText($_) } else { 'MISSING' }
        })
        $won = @($lines | Where-Object { $_ -match '^won ' })
        $lost = @($lines | Where-Object { $_ -match '^lost ' })
        Check ($lines.Count -eq 6) "$($lines.Count) racer result(s) were written rather than 6"
        Check (@($lines | Where-Object { $_ -ceq 'MISSING' }).Count -eq 0) 'at least one racer wrote no result at all'
        Check ($won.Count -eq 1) "$($won.Count) racer(s) won the acquire race rather than exactly 1: $($lines -join ' || ')"
        Check ($lost.Count -eq 5) "$($lost.Count) racer(s) were refused rather than 5"
        Check ((Get-ClaimCount $raceRoot) -eq 1) "the raced collection carries $(Get-ClaimCount $raceRoot) claim(s) rather than 1"
        $raceRecord = Read-CollectionOwnership -CollectionRoot $raceRoot
        Check ([string]$raceRecord.state -ceq 'held') "after the race the record reads '$($raceRecord.state)'"
        Check ([int]$raceRecord.incarnation -eq 1) "after the race the incarnation is $($raceRecord.incarnation) rather than 1"
        # EVERY LOSER NAMES THE WINNER. A refusal that did not would leave the reader with five
        # different stories about who holds a role exactly one workspace holds.
        $winner = [string]$raceRecord.workspace_id
        $unnamed = @($lost | Where-Object { $_ -notmatch [regex]::Escape($winner) })
        Check ($unnamed.Count -eq 0) "$($unnamed.Count) refusal(s) did not name the winner ($winner): $($unnamed -join ' || ')"
        Check ($won[0] -match 'won acquired 1') "the winner reported '$($won[0])'"

        # AND THE ARBITRATION ITSELF, PINNED WITHOUT CONCURRENCY. Measured on 2026-09-21, all five
        # losers above took the lost-the-create branch rather than reading an already-held record --
        # which is the branch no sequential fixture can reach, and exactly why the race is run with
        # real processes. But WHICH branch they take is a property of this machine's scheduling, so
        # the primitive underneath is also asserted directly: a second write of one incarnation's
        # record reports `created = $false` and does not touch the first.
        $second = Write-CollectionOwnershipRecord -OwnerDirectory (Get-CollectionOwnerDirectory $raceRoot) `
            -Incarnation 1 -Kind 'claim' -Body @{ schema = 1; incarnation = 1; workspace_id = 'interloper' }
        Check (-not $second.created) 'a second write of an existing ownership record reported created'
        Check ([string](Read-CollectionOwnership -CollectionRoot $raceRoot).workspace_id -ceq $winner) `
            'a losing write replaced the winner''s record'
        $leftovers = @(Get-ChildItem -LiteralPath (Get-CollectionOwnerDirectory $raceRoot) -Filter '.staging-*' -File -Force -ErrorAction SilentlyContinue)
        Check ($leftovers.Count -eq 0) "a losing write left $($leftovers.Count) staging file(s) behind"

        # ==========================================================================================
        # 3. THE FENCE
        # ==========================================================================================
        $fenceCollection = New-CollectionFixture (Join-Path $tmp 'fenced')
        $wsF = New-WorkspaceFixture (Join-Path $tmp 'ws-f') $idA
        Write-Deployment $wsF '.library-mcp-url' 'http://example.invalid:8000/mcp'
        Write-Deployment $wsF '.library-project' 'fixture-collection-id'
        Write-Deployment $wsF '.library-shared-root' $fenceCollection

        $fenceState = Get-CollectionBackendState -WorkspacePath $wsF
        Check ([string]$fenceState.state -ceq 'attached') "the fence fixture's backend state is '$($fenceState.state)' rather than attached"

        # UNOWNED IS PERMITTED AND SAYS SO. This is the day-one rule, pinned to a literal so that
        # changing it is an edit to this line rather than a drift nobody notices.
        $unownedToken = Assert-CollectionWriteAllowed -WorkspacePath $wsF -Operation 'a probe write'
        Check ([string]$unownedToken.reason -ceq 'unowned') "an unowned collection fenced with reason '$($unownedToken.reason)'"
        Check ((Assert-CollectionFenceUnchanged -Token $unownedToken) -eq $true) 'an unowned token failed its own re-check'

        Enter-CollectionOwnership -CollectionRoot $fenceCollection -WorkspaceId $idA | Out-Null
        # A token taken before the collection had an owner must NOT commit once one exists.
        CheckThrows { Assert-CollectionFenceUnchanged -Token $unownedToken } `
            'had no owner when the write began' 'a write that began on an unowned collection that has since been claimed'

        $heldToken = Assert-CollectionWriteAllowed -WorkspacePath $wsF -Operation 'a probe write'
        Check ([string]$heldToken.reason -ceq 'held') "the owner's own write fenced with reason '$($heldToken.reason)'"
        Check ([int]$heldToken.incarnation -eq 1) "the owner's token carries incarnation $($heldToken.incarnation) rather than 1"
        Check ((Assert-CollectionFenceUnchanged -Token $heldToken) -eq $true) "the owner's token failed its own re-check"

        # THE STALE INCARNATION, which is the whole reason the token carries one: the role moved
        # while this write was in flight.
        Enter-CollectionOwnership -CollectionRoot $fenceCollection -WorkspaceId $idB -Force | Out-Null
        CheckThrows { Assert-CollectionFenceUnchanged -Token $heldToken } `
            'began under incarnation 1 .*now reads incarnation 2' 'a write whose ownership moved while it was in flight'
        CheckThrows { Assert-CollectionWriteAllowed -WorkspacePath $wsF -Operation 'a probe write' } `
            ([regex]::Escape($idB) + '.*holds the writable role') 'a write from a workspace the role has moved away from'

        # A RELEASED ROLE IS NOT AN OWNED ONE. The collection has an owner record and nobody holds
        # it, which is a different refusal from somebody else holding it.
        $wsB = New-WorkspaceFixture (Join-Path $tmp 'ws-b') $idB
        Exit-CollectionOwnership -CollectionRoot $fenceCollection -WorkspaceId $idB -WorkspacePath $wsB | Out-Null
        CheckThrows { Assert-CollectionWriteAllowed -WorkspacePath $wsF -Operation 'a probe write' } `
            'no workspace holds the writable role' 'a write against a collection whose role is released'

        # A DIRECTORY WITH NO MARKER CANNOT BE THE OWNER, however the record reads.
        Enter-CollectionOwnership -CollectionRoot $fenceCollection -WorkspaceId $idA | Out-Null
        $markerless = Join-Path $tmp 'ws-markerless'
        New-Item -ItemType Directory -Path (Join-Path $markerless '.claude') -Force | Out-Null
        Write-Deployment $markerless '.library-mcp-url' 'http://example.invalid:8000/mcp'
        Write-Deployment $markerless '.library-project' 'fixture-collection-id'
        Write-Deployment $markerless '.library-shared-root' $fenceCollection
        CheckThrows { Assert-CollectionWriteAllowed -WorkspacePath $markerless -Operation 'a probe write' } `
            'carries no workspace marker' 'a write from a directory that is not a workspace'

        # ------------------------------------------------------------------------------------------
        # 3b. THE DOOR every shared writer goes through, and the commit-time re-check
        # ------------------------------------------------------------------------------------------
        # THE DEPLOYMENT IS REDIRECTED THROUGH THE ENVIRONMENT, which is route 2 of the three
        # Resolve-LibraryMcpUrl documents and not a test-only door. The write door deliberately
        # resolves the endpoint, the collection id and the share root WITHOUT a workspace -- the way
        # all ten writers do, from the program root -- so a fixture cannot redirect them by writing
        # files into a scratch directory. Setting the variables the resolvers read first is how a
        # fixture drives the real chain rather than a parameter that exists only for it.
        $env:AI_LIBRARY_MCP_URL = 'http://example.invalid:8000/mcp'
        $env:AI_LIBRARY_PROJECT_ID = 'fixture-collection-id'
        $env:LIBRARY_SHARED_COLLECTION_ROOT = $fenceCollection

        # The fence fixture is held by $idA, which is $wsF's own marker id, so this is the owner
        # writing: the endpoint comes back and a token is kept.
        $script:LibraryWriteFenceToken = $null
        CheckThrows { Assert-LibraryWriteFenceUnchanged -Operation 'a probe write' } `
            'without having passed the entry one' 'a commit-time fence check with no entry check behind it'

        $endpoint = Resolve-LibraryWriteEndpoint -WorkspacePath $wsF -Operation 'a probe write'
        Check ($endpoint -ceq 'http://example.invalid:8000/mcp') "the write door returned endpoint '$endpoint'"
        Check ($null -ne $script:LibraryWriteFenceToken) 'the write door took no fence token'
        Check ((Assert-LibraryWriteFenceUnchanged -Operation 'a probe write') -eq $true) `
            'the commit-time re-check refused the owner immediately after the entry check'

        # THE WINDOW THIS EXISTS FOR: the role moves after the write has begun.
        Enter-CollectionOwnership -CollectionRoot $fenceCollection -WorkspaceId $idB -Force | Out-Null
        CheckThrows { Assert-LibraryWriteFenceUnchanged -Operation 'a probe write' } `
            'role moved while the write was in flight' 'a commit whose ownership moved mid-write'
        CheckThrows { Resolve-LibraryWriteEndpoint -WorkspacePath $wsF -Operation 'a probe write' } `
            ([regex]::Escape($idB) + '.*holds the writable role') 'the write door for a workspace the role moved away from'

        # -Optional IS THE OFFLINE ESCAPE: no refusal, and no token to re-check against.
        $bare = Join-Path $tmp 'ws-unconfigured'
        New-Item -ItemType Directory -Path $bare -Force | Out-Null
        $script:LibraryWriteFenceToken = [pscustomobject]@{ stale = $true }
        Check ((Resolve-LibraryWriteEndpoint -WorkspacePath $bare -Optional) -ceq 'http://example.invalid:8000/mcp') `
            '-Optional did not resolve the configured endpoint at the write door'
        Check ($null -eq $script:LibraryWriteFenceToken) `
            '-Optional left a fence token behind, so a later commit-time check would compare against a stale one'
        # And -Optional does not refuse a configured workspace it cannot fence either: a suite runs
        # offline, and the markerless fixture is exactly what a scratch sandbox looks like.
        Check ((Resolve-LibraryWriteEndpoint -WorkspacePath $markerless -Optional) -ceq 'http://example.invalid:8000/mcp') `
            '-Optional refused a configured endpoint at the write door'
        Enter-CollectionOwnership -CollectionRoot $fenceCollection -WorkspaceId $idA -Force | Out-Null

        # Cleared again, so the backend-state cases below see the fixtures' own files rather than
        # this section's environment.
        foreach ($name in @('AI_LIBRARY_MCP_URL', 'AI_LIBRARY_PROJECT_ID', 'LIBRARY_SHARED_COLLECTION_ROOT')) {
            Set-Item -Path "env:$name" -Value ''
        }
        # AND THE DOOR DOES NOT ALTER THE RESOLUTION, asserted against the resolver itself rather
        # than against a literal. "-Optional yields empty when nothing is configured" is
        # library-deployment.selftest's property and cannot be re-asserted here as a literal,
        # because this tree's own program root really does carry a deployment -- a check written as
        # `-ceq ''` would have to be skipped on the only machine that runs it, and a conditional
        # assertion that never fires is not coverage. What belongs here is that the door passes
        # -Optional through unchanged, whatever the machine answers.
        Check ((Resolve-LibraryWriteEndpoint -WorkspacePath $bare -Optional) -ceq (Resolve-LibraryMcpUrl -Optional)) `
            'the write door altered the endpoint resolution under -Optional'

        # ==========================================================================================
        # 4. THE FOUR BACKEND STATES, each with its own refusal
        # ==========================================================================================
        $states = [ordered]@{}

        $wsLocal = New-WorkspaceFixture (Join-Path $tmp 'ws-local') 'ws-local'
        # A LIVE CONTROL, not an absence: the workspace has a real .mcp.json carrying the Library's
        # own server, so `local` is a judgement about a populated config rather than a missing file.
        [IO.File]::WriteAllText((Join-Path $wsLocal '.mcp.json'),
            (@{ mcpServers = @{ 'validated-book-reader' = @{ command = 'powershell.exe' } } } | ConvertTo-Json -Depth 5),
            [Text.UTF8Encoding]::new($false))
        $states['local'] = Get-CollectionBackendState -WorkspacePath $wsLocal

        $wsForeign = New-WorkspaceFixture (Join-Path $tmp 'ws-foreign') 'ws-foreign'
        [IO.File]::WriteAllText((Join-Path $wsForeign '.mcp.json'),
            (@{ mcpServers = [ordered]@{
                'validated-book-reader' = @{ command = 'powershell.exe' }
                'my-notes'              = @{ command = 'uvx'; args = @('basic-memory', 'mcp') }
            } } | ConvertTo-Json -Depth 5),
            [Text.UTF8Encoding]::new($false))
        $states['harness-exposed'] = Get-CollectionBackendState -WorkspacePath $wsForeign

        $wsNoId = New-WorkspaceFixture (Join-Path $tmp 'ws-no-id') 'ws-no-id'
        Write-Deployment $wsNoId '.library-mcp-url' 'http://example.invalid:8000/mcp'
        $states['misconfigured-no-collection-id'] = Get-CollectionBackendState -WorkspacePath $wsNoId

        $wsNoUrl = New-WorkspaceFixture (Join-Path $tmp 'ws-no-url') 'ws-no-url'
        Write-Deployment $wsNoUrl '.library-project' 'fixture-collection-id'
        $states['misconfigured-no-endpoint'] = Get-CollectionBackendState -WorkspacePath $wsNoUrl

        $wsNoView = New-WorkspaceFixture (Join-Path $tmp 'ws-no-view') 'ws-no-view'
        Write-Deployment $wsNoView '.library-mcp-url' 'http://example.invalid:8000/mcp'
        Write-Deployment $wsNoView '.library-project' 'fixture-collection-id'
        $states['misconfigured-no-view'] = Get-CollectionBackendState -WorkspacePath $wsNoView

        $wsUnreachable = New-WorkspaceFixture (Join-Path $tmp 'ws-unreachable') 'ws-unreachable'
        $notACollection = Join-Path $tmp 'not-a-collection'
        New-Item -ItemType Directory -Path $notACollection -Force | Out-Null
        Write-Deployment $wsUnreachable '.library-mcp-url' 'http://example.invalid:8000/mcp'
        Write-Deployment $wsUnreachable '.library-project' 'fixture-collection-id'
        Write-Deployment $wsUnreachable '.library-shared-root' $notACollection
        $states['unreachable-not-a-collection'] = Get-CollectionBackendState -WorkspacePath $wsUnreachable

        $wsGone = New-WorkspaceFixture (Join-Path $tmp 'ws-gone') 'ws-gone'
        Write-Deployment $wsGone '.library-mcp-url' 'http://example.invalid:8000/mcp'
        Write-Deployment $wsGone '.library-project' 'fixture-collection-id'
        Write-Deployment $wsGone '.library-shared-root' (Join-Path $tmp 'never-existed')
        $states['unreachable-absent'] = Get-CollectionBackendState -WorkspacePath $wsGone

        Check ([string]$states['local'].state -ceq 'local') "the local fixture read '$($states['local'].state)'"
        Check ([string]$states['harness-exposed'].state -ceq 'harness-exposed') `
            "the foreign-server fixture read '$($states['harness-exposed'].state)' -- a reader's own Basic Memory server must not read as local mode"
        Check (@($states['harness-exposed'].harness_servers) -contains 'my-notes') `
            "the foreign-server fixture did not name the server: $(@($states['harness-exposed'].harness_servers) -join ', ')"
        Check (@($states['local'].harness_servers).Count -eq 0) `
            "the local fixture counted the Library's own server as a foreign one: $(@($states['local'].harness_servers) -join ', ')"
        foreach ($key in @('misconfigured-no-collection-id', 'misconfigured-no-endpoint', 'misconfigured-no-view')) {
            Check ([string]$states[$key].state -ceq 'misconfigured') "the $key fixture read '$($states[$key].state)'"
        }
        foreach ($key in @('unreachable-not-a-collection', 'unreachable-absent')) {
            Check ([string]$states[$key].state -ceq 'unreachable') "the $key fixture read '$($states[$key].state)'"
        }
        Check ([string]$fenceState.refusal -ceq '') 'the attached state carries a refusal, so a healthy collection would refuse'

        # EACH STATE HAS ITS OWN REFUSAL, which is the step's written criterion and is worth
        # asserting rather than assuming: three of these are the same state name and none of the
        # three has the same fix.
        $refusals = @($states.Keys | ForEach-Object { [string]$states[$_].refusal })
        Check (@($refusals | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -eq 0) 'a refusing backend state carries no refusal text'
        $distinct = @($refusals | Sort-Object -Unique)
        Check ($distinct.Count -eq $refusals.Count) `
            "$($refusals.Count) refusing state(s) share $($distinct.Count) distinct refusal(s); each must name its own fix"
        # And each one names the route out of it, rather than only the problem.
        Check ([string]$states['misconfigured-no-collection-id'].refusal -match 'AI_LIBRARY_PROJECT_ID') 'the missing-collection-id refusal does not name its fix'
        Check ([string]$states['misconfigured-no-endpoint'].refusal -match 'AI_LIBRARY_MCP_URL') 'the missing-endpoint refusal does not name its fix'
        Check ([string]$states['misconfigured-no-view'].refusal -match 'LIBRARY_SHARED_COLLECTION_ROOT') 'the missing-filesystem-view refusal does not name its fix'
        Check ([string]$states['unreachable-not-a-collection'].refusal -match 'books\\README\.md') 'the not-a-collection refusal does not say what was missing'
        Check ([string]$states['harness-exposed'].refusal -match 'neither uses nor guards') 'the harness-exposed refusal does not say the Library leaves that server alone'
        Check ([string]$states['local'].refusal -match 'local mode') 'the local refusal does not name local mode'

        # A MISCONFIGURED OR UNREACHABLE BACKEND REFUSES THE WRITE, and with its own words: the fence
        # is the one door, so the state's refusal has to arrive through it.
        CheckThrows { Assert-CollectionWriteAllowed -WorkspacePath $wsNoView -Operation 'a probe write' } `
            'cannot be fenced' 'a shared write from a workspace with no filesystem view of its collection'
        # AN UNREACHABLE VIEW PERMITS AND SAYS SO. Pinned to the literal reason, because this is the
        # one permissive branch in the fence and changing it must be a deliberate edit to this line.
        # Both unreachable shapes are driven: a configured root that is not there, and one that is a
        # directory but not a collection.
        foreach ($unreachable in @($wsGone, $wsUnreachable)) {
            $unreachableToken = Assert-CollectionWriteAllowed -WorkspacePath $unreachable -Operation 'a probe write'
            Check ([string]$unreachableToken.reason -ceq 'unreachable-view') `
                "an unreachable collection fenced with reason '$($unreachableToken.reason)' rather than permitting"
            Check ((Assert-CollectionFenceUnchanged -Token $unreachableToken) -eq $true) `
                'an unreachable-view token failed its own re-check, which would refuse at commit time'
        }
        CheckThrows { Assert-CollectionWriteAllowed -WorkspacePath $wsLocal -Operation 'a probe write' } `
            'local mode' 'a shared write from a workspace in local mode'

        # ==========================================================================================
        # 5. INTEGRITY: a record this file did not write is never interpreted
        # ==========================================================================================
        $bent = New-CollectionFixture (Join-Path $tmp 'bent-name')
        New-Item -ItemType Directory -Path (Get-CollectionOwnerDirectory $bent) -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path (Get-CollectionOwnerDirectory $bent) '0001.claim.json'),
            (@{ schema = 1; incarnation = 7; workspace_id = $idA } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        CheckThrows { Read-CollectionOwnership -CollectionRoot $bent } 'in its filename and 7 in its body' `
            'a claim whose filename and body disagree about the incarnation'

        $bentSchema = New-CollectionFixture (Join-Path $tmp 'bent-schema')
        New-Item -ItemType Directory -Path (Get-CollectionOwnerDirectory $bentSchema) -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path (Get-CollectionOwnerDirectory $bentSchema) '0001.claim.json'),
            (@{ schema = 2; incarnation = 1; workspace_id = $idA } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        CheckThrows { Read-CollectionOwnership -CollectionRoot $bentSchema } 'declares schema 2' `
            'a claim written by another version of the program'

        $noSchema = New-CollectionFixture (Join-Path $tmp 'no-schema')
        New-Item -ItemType Directory -Path (Get-CollectionOwnerDirectory $noSchema) -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path (Get-CollectionOwnerDirectory $noSchema) '0001.claim.json'),
            (@{ incarnation = 1; workspace_id = $idA } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        CheckThrows { Read-CollectionOwnership -CollectionRoot $noSchema } 'declares schema none' `
            'a claim that declares no schema at all'

        $badJson = New-CollectionFixture (Join-Path $tmp 'bad-json')
        New-Item -ItemType Directory -Path (Get-CollectionOwnerDirectory $badJson) -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path (Get-CollectionOwnerDirectory $badJson) '0001.claim.json'), '{ not json',
            [Text.UTF8Encoding]::new($false))
        CheckThrows { Read-CollectionOwnership -CollectionRoot $badJson } 'not readable JSON' `
            'a claim that is not readable JSON'

        $strangerRelease = New-CollectionFixture (Join-Path $tmp 'stranger-release')
        New-Item -ItemType Directory -Path (Get-CollectionOwnerDirectory $strangerRelease) -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path (Get-CollectionOwnerDirectory $strangerRelease) '0001.claim.json'),
            (@{ schema = 1; incarnation = 1; workspace_id = $idA } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path (Get-CollectionOwnerDirectory $strangerRelease) '0001.release.json'),
            (@{ schema = 1; incarnation = 1; workspace_id = $idB; reason = 'released' } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        CheckThrows { Read-CollectionOwnership -CollectionRoot $strangerRelease } 'only valid as a forced takeover' `
            "a plain release of another workspace's claim"

        # THE DECOY: the same shape with reason=forced is a LEGITIMATE record, and reading it as
        # corrupt would refuse correct work. This is what keeps the check above narrow.
        $forcedFixture = New-CollectionFixture (Join-Path $tmp 'forced-ok')
        New-Item -ItemType Directory -Path (Get-CollectionOwnerDirectory $forcedFixture) -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path (Get-CollectionOwnerDirectory $forcedFixture) '0001.claim.json'),
            (@{ schema = 1; incarnation = 1; workspace_id = $idA } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path (Get-CollectionOwnerDirectory $forcedFixture) '0001.release.json'),
            (@{ schema = 1; incarnation = 1; workspace_id = $idB; reason = 'forced'; displaced = $idA } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        $forcedRead = Read-CollectionOwnership -CollectionRoot $forcedFixture
        Check ([string]$forcedRead.state -ceq 'released') "a forced release read state '$($forcedRead.state)' rather than released"

        $orphanRelease = New-CollectionFixture (Join-Path $tmp 'orphan-release')
        New-Item -ItemType Directory -Path (Get-CollectionOwnerDirectory $orphanRelease) -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path (Get-CollectionOwnerDirectory $orphanRelease) '0001.release.json'),
            (@{ schema = 1; incarnation = 1; workspace_id = $idA; reason = 'released' } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        CheckThrows { Read-CollectionOwnership -CollectionRoot $orphanRelease } 'release\(s\) and no claim' `
            'a release record with no claim to release'

        $ownerIsFile = New-CollectionFixture (Join-Path $tmp 'owner-is-file')
        [IO.File]::WriteAllText((Get-CollectionOwnerDirectory $ownerIsFile), 'workspace=someone', [Text.UTF8Encoding]::new($false))
        CheckThrows { Read-CollectionOwnership -CollectionRoot $ownerIsFile } 'is a FILE' `
            "an ownership record written as the plan's single file"

        # ==========================================================================================
        # 6. THE DECLARED WRITE SET IS REAL
        # ==========================================================================================
        $declared = @(Get-CollectionWriteHelpers)
        Check ($declared.Count -ge 1) 'Get-CollectionWriteHelpers declares no helper, so the fence-coverage check would pass vacuously'
        $absent = @($declared | Where-Object { -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $_) -PathType Leaf) })
        Check ($absent.Count -eq 0) "Get-CollectionWriteHelpers names $($absent.Count) helper(s) that do not exist: $($absent -join ', ')"
    }
    finally {
        foreach ($name in @('AI_LIBRARY_MCP_URL', 'AI_LIBRARY_PROJECT_ID', 'LIBRARY_SHARED_COLLECTION_ROOT')) {
            $value = $savedEnv[$name]
            if ($null -eq $value) { Remove-Item -Path "env:$name" -ErrorAction SilentlyContinue }
            else { Set-Item -Path "env:$name" -Value $value }
        }
        try { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }

    if ($failures.Count) {
        [Console]::Error.WriteLine("CollectionOwnership self-test FAILED ($($failures.Count) of $script:coChecks): $($failures -join '; ')")
        exit 1
    }
    Write-Host "CollectionOwnership self-test passed ($script:coChecks checks)."
    exit 0
}

# `-ne '.'` is what tells a dot-source from a direct run: a dot-sourced file must define and return,
# never execute a suite in its caller's process.
if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') { Invoke-CollectionOwnershipSelfTest }
