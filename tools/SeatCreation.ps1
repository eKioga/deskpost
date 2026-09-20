<#
.SYNOPSIS
    The one gate both seat-creation routes pass through. Dot-sourced; never invoked directly.

.DESCRIPTION
    WHY THIS FILE EXISTS, AND IT IS A DEFECT RATHER THAN A TIDY-UP. Two helpers can create a seat:
    `Start-LibrarySeat.ps1` from a terminal, and `Enter-LibrarySeat.ps1` from a conversation that has
    already started. Until 2026-09-10 they validated different things. The launcher checked the
    project slug's SHAPE and its uniqueness in the registry and nothing else -- so
    `-Project totally-invented` created a seat bound to a Project Hub that does not exist, silently
    namespacing that seat's Notebook and `output/` under a name nothing else in the Library knows.
    `Enter-LibrarySeat.ps1` shipped with the catalog check a day earlier, which left the two routes
    disagreeing about what a seat may be created for. `PLAN-seat-launch.md` step 7 said the launcher's
    create path moves onto the same gate; this is that move.

    IT IS ALSO WHAT MAKES ONE-SEAT-PER-PROJECT AN ENFORCED RULE RATHER THAN A CONVENTION. The rule
    only bites if the project a seat names is real: a reviewer sitting beside a builder could invent
    `library-dev-review`, and the launcher would take it, so the rule read as binding while nothing
    checked it.

    THE VALIDATIONS ARE SHARED; THE APPROVAL CEREMONY IS NOT, and that is deliberate rather than an
    oversight. Q3 ruled that a new seat needs one confirmation of both slugs. A human who typed
    `-Seat x -Project y` at a terminal has confirmed both by typing them; the Librarian inferring them
    from a conversation has not, which is why `Enter-LibrarySeat.ps1` binds its creation to a
    preflight and an exact `plan_id` and the launcher does not. What must not differ is what counts as
    a legal seat, and that is everything below.

    CREATING A SEAT NOW NEEDS THE SHARED COLLECTION, AND ENTERING ONE STILL DOES NOT. The only
    authority for "this Project Hub exists and is active" is the Active Project Catalog, so a creation
    with the NAS unreachable is refused rather than guessed at. Every other seat operation -- entering,
    claiming, retiring, reading a Desk -- stays entirely offline.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')
. (Join-Path $PSScriptRoot 'RawBatchOwnership.ps1')
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')

function Get-SeatCreatingHelpers {
    <#
    .SYNOPSIS
        The helpers that create a seat, and therefore MUST call Assert-NewSeatIsCreatable. Declared
        once so the gate can compare the declaration against the code in both directions.

    .DESCRIPTION
        BOTH DIRECTIONS, because a missing check and an undeclared new creator are different faults
        and only the first is loud. A declared helper that stops calling the gate is exactly the
        divergence this file was written to end. A helper that STARTS creating seats and is not
        declared is a third route nobody decided to add, and it would begin its life with whichever
        subset of these rules its author happened to remember -- which is how the two existing routes
        came to disagree.
    #>
    @(
        'Enter-LibrarySeat.ps1',
        'Start-LibrarySeat.ps1'
    )
}

function Get-SeatDeskBuildingHelpers {
    <#
    .SYNOPSIS
        The helpers that WRITE a new seat's Desk, and therefore must call Get-NewSeatDeskEntry.
        Declared beside the list above rather than folded into it, because the two questions are
        different.

    .DESCRIPTION
        VALIDATING AND WRITING ARE NOT THE SAME ROUTE. `SeatPicker.ps1` decides that a seat may be
        created -- it runs the gate, shows the plan and takes the yes -- and then hands an approved
        `plan_id` to the launcher, which performs the whole transaction under the registry lock. So it
        belongs on the validation list and not on this one, and requiring it here would mean either a
        second Desk writer or a declaration nobody could satisfy.

        BOTH DIRECTIONS, for the reason the list above carries: a declared writer that stops calling
        this composes a Desk from whatever it remembers, and an undeclared one is a third answer to
        "what does a new seat start with" that nobody decided to add.
    #>
    @(
        'Enter-LibrarySeat.ps1',
        'Start-LibrarySeat.ps1'
    )
}

function Get-ActiveProjectSlugs {
    <#
    .SYNOPSIS
        The slugs of every ACTIVE Project Hub, read over MCP. Throws a worded refusal when the
        catalog cannot be read. TAKE NO LOCK AROUND THIS CALL.

    .DESCRIPTION
        OUTSIDE EVERY LOCK, ALWAYS (D10 of PLAN-seat-launch.md). A network round trip inside the
        registry lock stalls every other seat's Desk write for as long as the NAS takes to answer, and
        this read is a precondition rather than part of any transaction: the confirmed creation
        revalidates the registry under the lock afterwards.

        Get-RawOwnerCatalogSet rather than a fifth copy of the MCP client, and it never throws -- an
        unreadable catalog is a reported state there, which is what lets the refusal here name the
        reason instead of a stack.

        AN UNREADABLE CATALOG IS A REFUSAL, NOT A DEFAULT. Treating it as "no Projects" would refuse
        every creation with the wrong sentence; treating it as "all Projects" would bind a seat to a
        Hub nobody can confirm exists. Neither is better than saying so.
    #>
    param(
        [string]$McpUrl,
        [string]$ProjectId,
        [int]$TimeoutSeconds = 20
    )
    $McpUrl = Resolve-LibraryMcpUrl -McpUrl $McpUrl
    $ProjectId = Resolve-LibraryCollectionId -CollectionId $ProjectId

    $catalogs = Get-RawOwnerCatalogSet -McpUrl $McpUrl -ProjectId $ProjectId -TimeoutSeconds $TimeoutSeconds
    if ([string]$catalogs.active_read -cne 'ok') {
        throw ('The Active Project Catalog could not be read, so it cannot be confirmed that a Project Hub exists for ' +
               "this seat: $([string]$catalogs.active_reason). Nothing was created. A seat bound to a Project that does " +
               "not exist would namespace its Notebook and output under a name nothing else knows. Entering an EXISTING " +
               'seat needs no network and is unaffected.')
    }
    @($catalogs.active_slugs)
}

function Get-SeatSlugReuseBlockers {
    <#
    .SYNOPSIS
        The records that stop a seat slug being used again, worded. An empty list means the name is
        free.

    .DESCRIPTION
        IT USED TO BE EVERY RECORD THAT NAMED THE SLUG, AND THAT WAS RIGHT FOR ONE RELEASE. D12 of
        `PLAN-seat-launch.md` refused reuse outright because ownership rows were keyed by seat SLUG
        and nothing distinguished one incarnation from another, so a new seat under a retired seat's
        name would have inherited its Notebook topics at the first reset. That reason is gone:
        ownership rows now carry the recording incarnation's `seat_id`, and the new seat's id is
        freshly minted, so inheritance is no longer possible however the name is spelled.

        WHAT STILL BLOCKS IS A ROW NOTHING CAN ACCOUNT FOR, and the reason is stranding rather than
        inheritance. An ownership row whose incarnation has no registry entry and no retirement
        record names material the Library cannot say is finished. Taking the slug makes that
        question permanently unanswerable: retirement acts on a registry entry, the slug then
        belongs to somebody else, and no reset will ever reach the topic again. Creation is the only
        moment that can be prevented, so it is prevented here -- and the refusal names the row and
        the routes that clear it.

        A SEAT ARCHIVE IS NO LONGER A CITATION AT ALL. It is the PROOF of retirement, which is
        precisely what makes the name safe to reuse; treating it as a blocker meant a properly
        retired seat's name was refused forever, since nothing purges the archive.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][object]$Registry
    )
    $blockers = [Collections.Generic.List[string]]::new()
    $retirements = @((Read-SeatRetirementRecords -Workspace $Workspace).records)
    foreach ($row in @((Read-NotebookTopicOwners -Workspace $Workspace).topics)) {
        if ([string]$row.scope -cne 'owned' -or [string]$row.seat -cne $Seat) { continue }
        $fields = @($row.PSObject.Properties | ForEach-Object { $_.Name })
        $incarnation = if ($fields -ccontains 'seat_id') { [string]$row.seat_id } else { '' }
        if ((Get-SeatIncarnationStatus -Registry $Registry -Retirements $retirements -Seat $Seat -SeatId $incarnation) -ceq 'retired') { continue }
        $which = if ([string]::IsNullOrWhiteSpace($incarnation)) { 'the pre-identity incarnation' } else { "incarnation $incarnation" }
        [void]$blockers.Add("the Notebook ownership record assigns notebook/$([string]$row.topic) to '$Seat' ($which), and no " +
            'retirement record in internal/seat-archive/ says that incarnation is finished')
    }
    @($blockers)
}

function Get-NewSeatDeskEntry {
    <#
    .SYNOPSIS
        What a new seat's Desk starts with: its own Project Hub, and nothing else.

    .DESCRIPTION
        DECLARED HERE BECAUSE THE TWO CREATION ROUTES DISAGREED ABOUT IT UNTIL 2026-09-10.
        `Enter-LibrarySeat.ps1` opened the Hub on the Desk it created; `Start-LibrarySeat.ps1` left
        the Desk empty, so a seat created at a terminal had to be told to open its own Project before
        it could orient. That is the same divergence this file was written to end, one layer down:
        the validations were shared and what the seat then LOOKED like was not. Found by the terminal
        picker, whose creation plan says what the Desk will hold and was wrong on one of the two
        routes it can take.

        THE ENTRY IS RETURNED AND THE WRITE IS NOT DONE HERE, deliberately. Writing it means calling
        `Set-DeskEntryForSeat`, which asserts the registry lock -- and `desk.registry-lock-coverage`
        reads the declared set of cross-seat callers per FILE, so a write buried in this shared file
        would move both routes' cross-seat surface into a helper that takes no lock of its own.
    #>
    param([Parameter(Mandatory = $true)][string]$Project)
    "projects/$Project"
}

function Test-NewSeatIsCreatable {
    <#
    .SYNOPSIS
        The same rules as Assert-NewSeatIsCreatable, reported as {creatable, reason} instead of
        thrown. Returns the assertion's own refusal text.

    .DESCRIPTION
        IT IS THE ASSERTION, NOT A SECOND COPY OF IT. Every rule still lives in one function; this
        catches it, which is what makes the two answers incapable of disagreeing.

        WHO NEEDS A VALUE RATHER THAN A THROW. The terminal picker asks "may this seat be created"
        while the reader is still typing: an unusable name comes back to the list with the gate's own
        sentence rather than ending the session. The two creation ROUTES want the opposite -- a
        refusal that stops the transaction -- so they call the assertion directly, which is also what
        `seat.creation-gate` reads them for.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][object]$Registry,
        [Parameter(Mandatory = $true)][string]$Seat,
        [string]$Project,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$ActiveProjects,
        [switch]$SeatOnly
    )
    try {
        Assert-NewSeatIsCreatable @PSBoundParameters | Out-Null
        [pscustomobject]@{ creatable = $true; reason = '' }
    }
    catch {
        [pscustomobject]@{ creatable = $false; reason = $_.Exception.Message }
    }
}

function Get-SeatRegistryDigest {
    <#
    .SYNOPSIS
        The seat registry as one comparable string, so an approval cannot execute against a registry
        it never described.
    #>
    param([Parameter(Mandatory = $true)][object]$Registry)
    $rows = @(@($Registry.seats) | ForEach-Object { "$([string]$_.seat)=$([string]$_.project)" } | Sort-Object -CaseSensitive)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($rows -join "`n"))) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
}

function Get-SeatCreationPlanId {
    <#
    .SYNOPSIS
        The `plan_id` a seat creation is approved against: this seat, this Project, and the registry
        as it stands.

    .DESCRIPTION
        ONE DERIVATION FOR EVERY CONFIRMED CREATION ROUTE. `Enter-LibrarySeat.ps1` computed this
        inline until 2026-09-10, when the terminal picker became a second route that shows a plan and
        asks for a yes. A second copy of an approval's derivation is worse than a second copy of a
        validation: the two would agree until one of them changed, and the failure would be an
        approval that silently stops binding what the reader was shown. The validations are already
        shared here (Assert-NewSeatIsCreatable) for the same reason.

        THE MATERIAL IS UNCHANGED from the inline version it replaces, deliberately -- a different
        string would invalidate every id in flight and would make `seat.create-acceptance`'s stale
        approval case pass for a new reason.
    #>
    param(
        [Parameter(Mandatory = $true)][object]$Registry,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][string]$Project
    )
    $digest = Get-SeatRegistryDigest -Registry $Registry
    $sha = [Security.Cryptography.SHA256]::Create()
    try { (-join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$Seat|$Project|$digest")) | ForEach-Object { $_.ToString('x2') })).Substring(0, 16) }
    finally { $sha.Dispose() }
}

function Assert-NewSeatIsCreatable {
    <#
    .SYNOPSIS
        Every rule a new seat must satisfy, in one place. Throws the refusal; returns `$true` when the
        seat may be created. The caller supplies the registry it read and the active Project slugs.

    .DESCRIPTION
        THE REGISTRY AND THE CATALOG ARE PASSED IN RATHER THAN READ HERE, and the split is the lock.
        The catalog read is a network call that must happen OUTSIDE every lock; the registry read must
        happen INSIDE the one this creation commits under, and be re-read there so the answer cannot
        be stale. A function that did both could only be called in one place and would be wrong in the
        other.

        SO THIS IS CALLED TWICE ON THE APPROVED ROUTE -- once to build the preflight and once under
        the registry lock before the write -- and once on the launcher's route, which holds the lock
        throughout. Every check is pure given its arguments, so calling it twice costs nothing and
        the second call is the one that decides.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][object]$Registry,
        [Parameter(Mandatory = $true)][string]$Seat,
        [string]$Project,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$ActiveProjects,
        # Stop after the checks that are about the SEAT. `Enter-LibrarySeat.ps1` offers the reader a
        # list of active Projects when they named none or named one that is not active -- and that
        # offer is only honest once the seat name itself is known to be usable. A reader whose real
        # problem is a slug an ownership row still cites must not be handed a Project list.
        [switch]$SeatOnly
    )
    if ($null -ne (Get-SeatEntry -Registry $Registry -Seat $Seat)) {
        throw ("Seat '$Seat' already exists. Enter it with tools/Enter-LibrarySeat.ps1 -Seat $Seat, or work at it from a " +
               "terminal with tools/Start-LibrarySeat.ps1 -Seat $Seat; creation is for a seat that does not exist yet.")
    }

    # THE SLUG BEFORE THE PROJECT. A name that can never be a seat is the reader's typo, and telling
    # them about the Project first sends them to fix the wrong argument.
    $blockers = @(Get-SeatSlugReuseBlockers -Workspace $Workspace -Seat $Seat -Registry $Registry)
    if ($blockers.Count) {
        throw ("Seat name '$Seat' cannot be used yet: $($blockers -join '; '). Taking the name would strand that material " +
               'for good -- the slug would belong to the new seat, so the old incarnation could never be retired and no ' +
               "reset would reach the topic again. Take it over with tools/Set-NotebookTopicOwner.ps1 -Topic <topic> -Seat " +
               '<a seat that exists>, or declare it with -Scope shared, and then this name is free.')
    }

    if ($SeatOnly) { return $true }

    if ([string]::IsNullOrWhiteSpace($Project)) {
        throw ("Seat '$Seat' does not exist yet, so it needs the Project it is for: -Project <project-slug>. A seat is " +
               'bound to exactly one Project, which is what makes its Notebook and output namespaces unambiguous. ' +
               "Active Projects: $((@($ActiveProjects) | Sort-Object -CaseSensitive) -join ', ').")
    }
    if ($Project -cnotmatch (Get-SeatSlugPattern)) {
        throw "Project slug '$Project' is malformed: lowercase letters, digits and hyphens only."
    }

    # THE HUB MUST ACTUALLY EXIST AND BE ACTIVE, which is the check the launcher never had. Without
    # it, one-seat-per-project is a rule about invented names: a second seat on a real project is
    # refused while a seat on a project that does not exist is waved through.
    if (@($ActiveProjects) -cnotcontains $Project) {
        throw ("There is no active Project Hub '$Project', so a seat cannot be bound to it. Active Projects: " +
               "$((@($ActiveProjects) | Sort-Object -CaseSensitive) -join ', '). Create the Hub first with " +
               'tools/New-ProjectHub.ps1, or name one of those.')
    }

    # UNIQUE IN BOTH DIRECTIONS. Two seats bound to one project would both target
    # notebook/<project-slug>/ and output/<project-slug>/, and the singular topic-owner record cannot
    # represent two owners safely.
    $clash = @(@($Registry.seats) | Where-Object { [string]$_.project -ceq $Project }) | Select-Object -First 1
    if ($null -ne $clash) {
        throw ("Project '$Project' is already bound to seat '$([string]$clash.seat)'. A project has at most one seat: " +
               "work it there, or retire that seat first with tools/Retire-Seat.ps1 -Seat $([string]$clash.seat).")
    }
    $true
}
