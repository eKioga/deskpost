<#
.SYNOPSIS
    Bring a reset's quarantined Notebook material back: move the topics home, re-render the master
    index, and put each topic's ownership row back in a state a reset can read.

.DESCRIPTION
    THE PROMISE THIS KEEPS. `Reset-LocalNotebook.ps1` has reported `recoverable` since it shipped --
    "topics are MOVED into internal/notebook-reset-quarantine/, never deleted" -- and until
    2026-09-10 nothing could bring one back. The material was recoverable by hand and the Library
    was not; `docs/seats.md` and the playbook both named a restore and a purge as operations that
    did not exist.

    ONE QUARANTINE PER RUN, NAMED. A reset stamps its own directory
    (`<seat>-<yyyyMMdd-HHmmss>`), so "restore my Notebook" is ambiguous the moment there are two.
    `-List` shows what is there with what each holds; `-Quarantine <name>` plans exactly one.

    AND WHAT IS ACTUALLY IN ONE (2026-09-15). `-List` named topics, and a topic is a folder -- so
    "is the page I am missing in there?" needed a file browser. `-Quarantine <name> -Show` names the
    articles, one row per topic. Both reads need no seat, for the reason the roster does not: a
    reader whose session lost its seat is exactly the reader asking what survived. Do NOT seat-gate
    either to match `Get-DeskOverview.ps1`, which throws without one -- that asymmetry is why the
    Desk's quarantine block prints this command instead of only a count.

    WHAT IT NEVER DOES: OVERWRITE. A topic that exists in `notebook/` again is newer material
    somebody made after the reset, and the quarantined copy is the older one. The preflight refuses
    on it and the move refuses again under the topic lock, because between the two a compile at
    another seat can create the name. The quarantined copy is left where it is for the reader to
    merge by hand -- destroying newer work is the one thing a recovery route must not do.

    THE OWNERSHIP QUESTION, WHICH IS THE SHARP ONE. A reset LEAVES the ownership row citing the seat
    when it moves a topic out, so a restore always meets a row -- and the row it meets is not
    necessarily still the right one. Since 2026-09-10 a seat slug may be reused after a real
    retirement, so "seat `fallout`" on a row and "seat `fallout`" in the registry can be two
    different incarnations; and a whole-tree reset quarantines topics belonging to retired
    incarnations that are not this seat's at all. So every topic is classified by (seat,
    incarnation) against the registry and the retirement records, exactly as the reset's own
    selection is, and the plan states the disposition per topic:

        keep     the row already names this seat's current incarnation, or declares the name
                 `shared`/`excluded`. Nothing is written.
        record   no row names the topic and the quarantine's journal says it was this
                 incarnation's. The row is written back.
        adopt    the row (or the journal) names somebody else -- a retired incarnation, one nothing
                 can account for, or nothing at all. REFUSED unless `-Adopt` is passed, because
                 restoring here would be taking material over rather than getting it back.

    A row naming a LIVE seat is refused outright and `-Adopt` does not lift it: that seat's reset is
    still covering that topic, and handing it here would stop it covering material it is writing.
    Work at that seat, or reassign it with `tools/Set-NotebookTopicOwner.ps1` first.

    GATED LIKE THE RESET IT REVERSES. Preflight, one approval, an exact `plan_id` binding the seat,
    the quarantine, every topic WITH its current owner and disposition, and the loose files. A
    preflight that has anything to refuse issues NO `plan_id` at all: an approval for an operation
    already certain to fail is worse than no approval.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspacePath,
    # Which seat is restoring. Defaults to LIBRARY_SEAT; there is no default seat.
    [string]$Seat,
    # The stamped directory name under internal/notebook-reset-quarantine/, never a path: a reader
    # who could pass a path could point this at a directory the reset never made.
    [string]$Quarantine,
    # Narrow the restore to these topics. Empty means every topic the quarantine holds. Loose files
    # travel only with a WHOLE-quarantine restore -- a loose file belongs to no topic, so there is
    # nothing for a topic filter to mean about it, and the plan says which ones it is leaving.
    [string[]]$Topic = @(),
    # Take over a topic whose row names an incarnation that is not this seat's current one. Without
    # it such a topic is refused rather than quietly re-homed.
    [switch]$Adopt,
    [switch]$List,
    # Name the articles in ONE quarantine, with -Quarantine <name>. A read, like -List.
    [switch]$Show,
    [switch]$Preflight,
    [switch]$UserConfirmed,
    [string]$ApprovedPlanId,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'NotebookIndex.ps1')
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')

$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$stateDirectory = Join-Path $workspace '.claude'
$notebookPath = Join-Path $workspace 'notebook'
if (-not (Test-Path -LiteralPath $notebookPath -PathType Container)) {
    throw "Restore aborted: expected Notebook directory was not found at '$notebookPath'."
}

# --- THE ROSTER, WHICH NEEDS NO SEAT ---------------------------------------------------------------
#
# Listing what is in quarantine is a READ, and reads never need a claim (docs/seats.md). A reader
# whose session lost its seat is exactly the reader who wants to know what is recoverable, and
# refusing them the list would leave them guessing at a directory name they then cannot type.
if ($List -and $Show) {
    throw ('Restore aborted: -List and -Show are two reads, not one. -List is the roster of every quarantine; ' +
           '-Quarantine <name> -Show names the articles in one of them.')
}
if ($List) {
    $rows = @(Get-NotebookQuarantineInventory -Workspace $workspace)
    Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
        operation            = 'List quarantined Notebook material'
        workspace            = $workspace
        quarantine_root      = (Join-Path $workspace 'internal/notebook-reset-quarantine')
        quarantines          = @($rows | ForEach-Object {
            # ARTICLES ARE COUNTED HERE AND NAMED BY -Show. A roster that printed every article of
            # every quarantine is the legibility problem one directory over: this workspace's own
            # Notebook would put some fifty names in a list whose job is to help the reader pick one
            # stamped directory. The count is what they pick with.
            $articleRows = @(Get-NotebookQuarantineTopicArticles -Directory ([string]$_.directory))
            $articleTotal = 0
            foreach ($articleRow in $articleRows) { $articleTotal += [int]$articleRow.article_count }
            [pscustomobject]@{
                name            = [string]$_.name
                quarantined_by  = [string]$_.seat
                quarantined_utc = [string]$_.quarantined_utc
                # WHEN IT WAS MADE AND WHO SAYS SO, beside the journal's own field rather than over
                # it: `quarantined_utc` is `''` for a quarantine whose journal is missing or
                # unreadable, and a roster that filled it in from the directory name would be
                # claiming a journal answered. `stamp_source` is how the reader tells the two apart.
                stamped_utc     = [string]$_.stamped_utc
                stamp_source    = [string]$_.stamp_source
                age_days        = $_.age_days
                whole_tree      = [bool]$_.whole_tree
                # BOTH SWITCHES OR NEITHER (2026-09-15). `whole_tree` on its own is a half-answer
                # that reads as a whole one: a sweep's quarantine is `whole_tree: false` exactly as
                # an ordinary seat-scoped one is, and it is the one holding SEVERAL seats' material.
                # The per-topic owners stay off the roster for the reason the articles do -- `-Show`
                # and the restore preflight are where per-topic detail belongs.
                all_idle_seats  = [bool]$_.all_idle_seats
                journal         = [string]$_.journal_status
                topics          = @($_.topics)
                article_count   = $articleTotal
                loose_files     = @($_.loose_files)
            }
        })
        show_route           = 'tools/Restore-NotebookQuarantine.ps1 -WorkspacePath . -Quarantine <name> -Show'
        shared_library_write = $false
    })
    return
}

# --- WHAT IS ACTUALLY IN ONE OF THEM, WHICH ALSO NEEDS NO SEAT (2026-09-15) -----------------------
#
# The roster answers "what survived"; this answers "is the page I lost in there". Same read, same
# seatless rule, one quarantine at a time -- and it plans nothing, issues no plan_id and takes no
# lock, so it is deliberately BEFORE the seat resolution rather than a mode of the preflight.
if ($Show) {
    if ($Preflight -or $UserConfirmed) {
        throw ('Restore aborted: -Show is a read and plans nothing. Run it on its own, then rerun with -Preflight ' +
               'to plan the restore it showed you.')
    }
    if ([string]::IsNullOrWhiteSpace($Quarantine)) {
        throw ('Restore aborted: name the quarantine to show with -Quarantine <name>. Run this helper with -List to ' +
               'see which ones there are.')
    }
    $shown = @(Get-NotebookQuarantineInventory -Workspace $workspace -Name $Quarantine)
    if (-not $shown.Count) {
        $known = @(@(Get-NotebookQuarantineInventory -Workspace $workspace) | ForEach-Object { [string]$_.name })
        $because = if ($known.Count) { "There are: $($known -join ', ')." } else { 'This workspace holds no quarantined material at all.' }
        throw "Restore aborted: internal/notebook-reset-quarantine/$Quarantine does not exist. $because"
    }
    $shownRow = $shown[0]
    $shownTopics = @(Get-NotebookQuarantineTopicArticles -Directory ([string]$shownRow.directory))
    $shownArticles = 0
    foreach ($topicRow in $shownTopics) { $shownArticles += [int]$topicRow.article_count }
    Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
        operation            = 'Show one quarantine''s contents'
        workspace            = $workspace
        quarantine           = [string]$shownRow.name
        directory            = [string]$shownRow.directory
        quarantined_by       = [string]$shownRow.seat
        quarantined_utc      = [string]$shownRow.quarantined_utc
        stamped_utc          = [string]$shownRow.stamped_utc
        stamp_source         = [string]$shownRow.stamp_source
        age_days             = $shownRow.age_days
        whole_tree           = [bool]$shownRow.whole_tree
        all_idle_seats       = [bool]$shownRow.all_idle_seats
        journal              = [string]$shownRow.journal_status
        journal_reason       = [string]$shownRow.journal_reason
        # THE STRING ARRAY IS UNTOUCHED and `topic_articles` sits beside it. `topics` is consumed by
        # Remove-NotebookQuarantine.ps1 and by this helper's own restore path as a string array;
        # enriching it in place would have changed a shape three call sites read.
        topics               = @($shownRow.topics)
        topic_articles       = @($shownTopics)
        # WHOSE EACH TOPIC WAS, WHICH NOTHING ELSE NOW KNOWS. A sweep writes ONE quarantine across
        # several seats' topics, and the ownership rows it leaves behind in
        # internal/notebook-topic-owners.json are taken by a purge -- so without this the reader
        # asking "can this go back to the seat it came from?" has no read that answers, and the
        # restore preflight needs a seat while this one deliberately does not. Empty for a journal
        # written before the 2026-09-10 `targets` field, which is reported rather than invented.
        recorded_owners      = @($shownRow.recorded_owners)
        article_count        = $shownArticles
        loose_files          = @($shownRow.loose_files)
        # WHAT THIS READ IS NOT. Names and counts, never page content -- and `file_count` per topic
        # is how a topic holding something this listing does not name says so, rather than looking
        # empty.
        scope                = ('Read-only: the names of the files in one quarantine directory. No page content was ' +
                                'read, nothing was moved, and no lock was taken. `_index.md` is rendered from a topic ' +
                                'rather than written into it, so it is counted in file_count and not named as an article.')
        restore_route        = "tools/Restore-NotebookQuarantine.ps1 -WorkspacePath . -Quarantine $($shownRow.name) -Preflight"
        shared_library_write = $false
    })
    return
}

$seatState = Resolve-SeatName -Seat $Seat -StateDirectory $stateDirectory
if ($seatState.status -cne 'named') { throw $seatState.message }
$Seat = $seatState.seat

if ([string]::IsNullOrWhiteSpace($Quarantine)) {
    throw ('Restore aborted: name the quarantine to restore with -Quarantine <name>. Run this helper with -List to ' +
           'see what is there; a restore plans one stamped directory, because "restore my Notebook" is ambiguous the ' +
           'moment a second reset has run.')
}
$inventory = @(Get-NotebookQuarantineInventory -Workspace $workspace -Name $Quarantine)
if (-not $inventory.Count) {
    $known = @(@(Get-NotebookQuarantineInventory -Workspace $workspace) | ForEach-Object { [string]$_.name })
    $because = if ($known.Count) { "There are: $($known -join ', ')." } else { 'This workspace holds no quarantined material at all.' }
    throw "Restore aborted: internal/notebook-reset-quarantine/$Quarantine does not exist. $because"
}
$quarantineRow = $inventory[0]

# --- WHAT EACH TOPIC'S OWNERSHIP ROW MEANS NOW ----------------------------------------------------
#
# THE REGISTRY LOCK, for Get-NotebookResetTargets' reason: this classifies by (seat, incarnation)
# against the registry and the retirement records, and a seat created or retired under the scan
# changes the answer. Released before the reader is asked, and retaken for the apply -- holding an
# ordered lock across a human decision blocks every Desk write for as long as they take to read.
function Get-RestoreDispositions {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$ActingSeat,
        [Parameter(Mandatory = $true)][object]$Quarantine,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Topics,
        [Parameter(Mandatory = $true)][bool]$AdoptForeign
    )
    $stateDirectory = Join-Path $Workspace '.claude'
    $registry = Read-SeatRegistry -StateDirectory $stateDirectory
    # THE ACTING SEAT MUST BE REGISTERED, the same assertion Get-NotebookResetTargets makes and for
    # the same reason: without an entry its incarnation resolves to '' and would compare equal to
    # every row written before incarnations existed.
    $actingEntry = Assert-SeatRegistered -StateDirectory $stateDirectory -Seat $ActingSeat
    $actingIncarnation = Get-SeatEntryIncarnation -Entry $actingEntry
    $retirements = @((Read-SeatRetirementRecords -Workspace $Workspace).records)
    $owners = Read-NotebookTopicOwners -Workspace $Workspace

    $rows = [Collections.Generic.List[object]]::new()
    foreach ($name in @($Topics)) {
        $recorded = @(@($Quarantine.recorded_owners) | Where-Object { [string]$_.topic -ceq $name }) | Select-Object -First 1
        $recordedSeat = if ($null -ne $recorded) { [string]$recorded.seat } else { '' }
        $recordedIncarnation = if ($null -ne $recorded) { [string]$recorded.seat_id } else { '' }

        $entry = Get-NotebookTopicOwner -Owners $owners -Topic $name
        $scope = ''
        $currentSeat = ''
        $currentIncarnation = ''
        if ($null -ne $entry) {
            $fields = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
            $scope = [string]$entry.scope
            if ($scope -ceq 'owned') {
                $currentSeat = [string]$entry.seat
                if ($fields -ccontains 'seat_id') { $currentIncarnation = [string]$entry.seat_id }
            }
        }

        $action = ''
        $reason = ''
        $status = ''
        if (Test-Path -LiteralPath (Join-Path (Join-Path $Workspace 'notebook') $name)) {
            $action = 'blocked'
            $reason = 'a topic of that name exists in notebook/ again, and a restore never writes over newer material; move or merge it by hand'
        }
        elseif ($null -ne $entry -and $scope -cne 'owned') {
            $action = 'keep'
            $reason = "the record declares that name '$scope', which no seat's reset moves"
        }
        elseif ($null -ne $entry -and $currentSeat -ceq $ActingSeat -and $currentIncarnation -ceq $actingIncarnation) {
            $action = 'keep'
            $reason = 'the row already names this seat''s current incarnation'
        }
        elseif ($null -ne $entry) {
            $status = Get-SeatIncarnationStatus -Registry $registry -Retirements $retirements -Seat $currentSeat -SeatId $currentIncarnation
            $which = if ([string]::IsNullOrWhiteSpace($currentIncarnation)) { 'the pre-identity incarnation' } else { "incarnation $currentIncarnation" }
            if ($status -ceq 'live') {
                # NOT LIFTABLE BY -Adopt, DELIBERATELY. That seat's reset still covers this topic;
                # taking it here would stop it covering material that seat is writing, which is the
                # rule Set-NotebookTopicOwner already enforces for a reassignment.
                $action = 'blocked'
                $reason = ("notebook/$name is owned by seat '$currentSeat' ($which), which is still registered. Restore it from " +
                           "that seat, or reassign it first with tools/Set-NotebookTopicOwner.ps1 -Topic $name -Seat $ActingSeat")
            }
            elseif ($AdoptForeign) {
                $action = 'adopt'
                $reason = "the row names seat '$currentSeat' ($which), which is $status; -Adopt takes the topic over"
            }
            else {
                $action = 'blocked'
                $reason = ("notebook/$name is owned by seat '$currentSeat' ($which), which is $status rather than this seat. " +
                           'Pass -Adopt to take it over, or restore it from a seat that owns it')
            }
        }
        elseif (-not [string]::IsNullOrWhiteSpace($recordedSeat) -and $recordedSeat -ceq $ActingSeat -and $recordedIncarnation -ceq $actingIncarnation) {
            $action = 'record'
            $reason = 'no row names the topic and the quarantine records it as this incarnation''s, so the row is written back'
        }
        elseif ($AdoptForeign) {
            $action = 'adopt'
            $reason = if ([string]::IsNullOrWhiteSpace($recordedSeat)) { 'no row names the topic and nothing records who owned it; -Adopt takes it over' }
                      else { "no row names the topic and the quarantine records it as seat '$recordedSeat''s'; -Adopt takes it over" }
        }
        else {
            $action = 'blocked'
            $reason = if ([string]::IsNullOrWhiteSpace($recordedSeat)) {
                "no ownership row names notebook/$name and nothing records who owned it, so restoring it here would be taking it over rather than getting it back. Pass -Adopt to do that deliberately"
            }
            else {
                "no ownership row names notebook/$name and the quarantine records it as seat '$recordedSeat''s. Pass -Adopt to take it over"
            }
        }

        [void]$rows.Add([pscustomobject]@{
            topic               = $name
            action              = $action
            reason              = $reason
            current_scope       = $scope
            current_seat        = $currentSeat
            current_seat_id     = $currentIncarnation
            current_status      = $status
            recorded_seat       = $recordedSeat
            recorded_seat_id    = $recordedIncarnation
        })
    }
    [pscustomobject]@{ seat_id = $actingIncarnation; rows = @($rows) }
}

# THE PLAN DIGEST. The seat and its incarnation, the quarantine, the adopt switch, and every topic
# with the owner and disposition the reader was shown -- so an approval cannot execute against a
# topic whose row changed, or a different disposition for the same topic. The loose files travel too,
# for the reason the reset's do: they are part of the set being approved.
function Get-RestorePlanId {
    param(
        [Parameter(Mandatory = $true)][string]$ActingSeat,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ActingSeatId,
        [Parameter(Mandatory = $true)][string]$QuarantineName,
        [Parameter(Mandatory = $true)][bool]$AdoptForeign,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Rows,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$LooseFiles
    )
    $lines = @(
        'action=restore-notebook-quarantine',
        "seat=$ActingSeat",
        "seat_id=$ActingSeatId",
        "quarantine=$QuarantineName",
        "adopt=$($AdoptForeign.ToString().ToLowerInvariant())"
    ) +
        @(@($Rows | ForEach-Object { "topic=$($_.topic):$($_.current_seat):$($_.current_seat_id):$($_.action)" }) | Sort-Object -CaseSensitive) +
        @(@($LooseFiles | Sort-Object -CaseSensitive) | ForEach-Object { "loose=$_" })
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hex = -join ($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes(($lines -join "`n"))) | ForEach-Object { $_.ToString('x2') })
    }
    finally { $sha.Dispose() }
    "restore-notebook-quarantine-$hex"
}

function Get-RestoreSelection {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$ActingSeat,
          [Parameter(Mandatory = $true)][object]$Quarantine, [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Topics,
          [Parameter(Mandatory = $true)][bool]$AdoptForeign)
    $registryLock = Enter-SeatRegistryLock -Workspace $Workspace
    try { Get-RestoreDispositions -Workspace $Workspace -ActingSeat $ActingSeat -Quarantine $Quarantine -Topics $Topics -AdoptForeign $AdoptForeign }
    finally { Exit-BookLock -Lock $registryLock }
}

# --- WHICH TOPICS, AND WHICH LOOSE FILES ----------------------------------------------------------
$held = @($quarantineRow.topics)
$wholeQuarantine = (-not @($Topic).Count)
$selectedTopics = if ($wholeQuarantine) { @($held) } else { @(@($Topic) | Sort-Object -Unique -CaseSensitive) }
$unknownTopics = @(@($selectedTopics) | Where-Object { $held -cnotcontains $_ })
if ($unknownTopics.Count) {
    throw ("Restore aborted: internal/notebook-reset-quarantine/$Quarantine holds no topic named " +
           "$($unknownTopics -join ', '). It holds: $(if (@($held).Count) { @($held) -join ', ' } else { '(no topics)' }).")
}
# A loose file belongs to no topic, so a topic filter says nothing about it. Named either way, so the
# reader sees what a narrowed restore is leaving behind rather than inferring it.
$looseToRestore = if ($wholeQuarantine) { @($quarantineRow.loose_files) } else { @() }
$looseLeft = if ($wholeQuarantine) { @() } else { @($quarantineRow.loose_files) }
$looseColliding = @(@($looseToRestore) | Where-Object { Test-Path -LiteralPath (Join-Path $notebookPath $_) })
$looseToRestore = @(@($looseToRestore) | Where-Object { $looseColliding -cnotcontains $_ })

$selection = Get-RestoreSelection -Workspace $workspace -ActingSeat $Seat -Quarantine $quarantineRow `
    -Topics $selectedTopics -AdoptForeign ([bool]$Adopt)
$rows = @($selection.rows)
$blocked = @(@($rows) | Where-Object { [string]$_.action -ceq 'blocked' })
$movable = @(@($rows) | Where-Object { [string]$_.action -cne 'blocked' })

$refusals = [Collections.Generic.List[string]]::new()
foreach ($row in $blocked) { [void]$refusals.Add("$($row.topic): $($row.reason).") }
foreach ($name in $looseColliding) {
    [void]$refusals.Add("$($name): a file of that name is already directly under notebook/, and a restore never writes over it.")
}

$planId = ''
if (-not $refusals.Count) {
    $planId = Get-RestorePlanId -ActingSeat $Seat -ActingSeatId ([string]$selection.seat_id) -QuarantineName $Quarantine `
        -AdoptForeign ([bool]$Adopt) -Rows @($movable) -LooseFiles @($looseToRestore)
}

$result = [ordered]@{
    operation             = 'Restore quarantined Notebook material'
    workspace             = $workspace
    seat                  = $Seat
    seat_id               = [string]$selection.seat_id
    quarantine            = [string]$quarantineRow.name
    quarantine_directory  = [string]$quarantineRow.directory
    quarantined_by_seat   = [string]$quarantineRow.seat
    quarantined_utc       = [string]$quarantineRow.quarantined_utc
    journal_status        = [string]$quarantineRow.journal_status
    journal_note          = [string]$quarantineRow.journal_reason
    scope                 = if ($wholeQuarantine) { 'the whole quarantine: every topic it holds, and the loose files beside them' }
                            else { 'only the named topics. Loose files travel with a whole-quarantine restore, so they are left where they are.' }
    topics_to_restore     = @($movable | ForEach-Object { "$($_.topic) (ownership: $($_.action) -- $($_.reason))" })
    topics_blocked        = @($blocked | ForEach-Object { "$($_.topic): $($_.reason)" })
    loose_files_to_restore = @($looseToRestore)
    loose_files_left      = @(@($looseLeft) + @($looseColliding) | Sort-Object -CaseSensitive)
    adopt                 = [bool]$Adopt
    refusals              = @($refusals)
    # NO plan_id WHEN THERE IS ANYTHING TO REFUSE. An approval for an operation already certain to
    # fail is worse than no approval, and this is the shape Retire-Seat and Archive-ShelfBook use for
    # a destination collision. The apply revalidates all of it anyway, under the lock.
    plan_id               = $planId
    confirmation_required = (-not $refusals.Count)
    shared_library_write  = $false
}

# THE CLAIM IS PROBED BEFORE THE PLAN IS ISSUED, exactly as the reset does: this writes notebook/,
# so a claimless session is certain to be refused and must not be handed a plan first.
Assert-SeatClaimHeld -StateDirectory $stateDirectory -Seat $Seat | Out-Null
if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$result) -Json:$Json; return }
if (-not $UserConfirmed) { throw 'Restore aborted: run with -Preflight, show the reader what it reports, and rerun with -UserConfirmed and the exact -ApprovedPlanId after one clear yes.' }

# --- THE APPLY ------------------------------------------------------------------------------------
#
# Registry lock, then each topic's lock in sorted order, then the render -- the total order,
# outermost first. The ownership writes happen after the render and inside the topic locks, which is
# where ADR-0019 requires them and which leaves the render lock held for the move alone.
$topicLocks = [Collections.Generic.List[object]]::new()
$applyRegistryLock = Enter-SeatRegistryLock -Workspace $workspace
try {
    $current = Get-RestoreDispositions -Workspace $workspace -ActingSeat $Seat -Quarantine `
        (@(Get-NotebookQuarantineInventory -Workspace $workspace -Name $Quarantine))[0] `
        -Topics $selectedTopics -AdoptForeign ([bool]$Adopt)
    $currentRows = @(@($current.rows) | Where-Object { [string]$_.action -cne 'blocked' })
    $currentBlocked = @(@($current.rows) | Where-Object { [string]$_.action -ceq 'blocked' })
    $currentLoose = @(@($looseToRestore) | Where-Object { -not (Test-Path -LiteralPath (Join-Path $notebookPath $_)) })
    $currentPlanId = Get-RestorePlanId -ActingSeat $Seat -ActingSeatId ([string]$current.seat_id) -QuarantineName $Quarantine `
        -AdoptForeign ([bool]$Adopt) -Rows @($currentRows) -LooseFiles @($currentLoose)
    if ($currentPlanId -cne $ApprovedPlanId) {
        $because = if ([string]::IsNullOrWhiteSpace($ApprovedPlanId)) { 'no plan_id was passed' }
                   else { 'the seat, the quarantine, the topics selected, their owners, their dispositions, or the loose files are not what that plan described' }
        throw ("Restore aborted and nothing was moved: $because. Rerun the current preflight and pass its exact plan_id " +
               'as -ApprovedPlanId.')
    }
    if (@($currentBlocked).Count) {
        throw ('Restore aborted and nothing was moved: ' + (@($currentBlocked | ForEach-Object { "$($_.topic): $($_.reason)" }) -join '; '))
    }

    foreach ($name in @(@($currentRows | ForEach-Object { [string]$_.topic }) | Sort-Object -CaseSensitive)) {
        [void]$topicLocks.Add((Enter-BookLock -Workspace $workspace -BookRoot "notebook/$name"))
    }

    # ONE ARGUMENT, AND IT IS AN OBJECT: `@(...)` FLATTENS a nested array, so passing the rows as one
    # element of a splatted array would bind only the first of them. The trap this codebase has paid
    # for, and Reset-LocalNotebook carries the same note for the same call.
    $commitContext = [pscustomobject]@{
        workspace     = $workspace
        notebook_path = $notebookPath
        quarantine    = [string]$quarantineRow.directory
        rows          = @($currentRows)
        loose_files   = @($currentLoose)
    }
    $render = Invoke-NotebookRender -Workspace $workspace -CommitArgument @($commitContext) -Commit {
        param($Context)
        $moved = @()
        foreach ($row in @($Context.rows)) {
            $moved += Restore-NotebookTopicFromQuarantine -Workspace $Context.workspace -Topic ([string]$row.topic) `
                -QuarantineDirectory $Context.quarantine
        }
        $looseMoved = @()
        foreach ($name in @($Context.loose_files)) {
            $source = Join-Path $Context.quarantine $name
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
            $destination = Join-Path $Context.notebook_path $name
            # NO -Force, DELIBERATELY. -Force here would overwrite a file that appeared under
            # notebook/ since the plan was revalidated, which is the one thing this helper promises
            # not to do. Move-Item without it fails on a collision, so the file is skipped and named.
            if (Test-Path -LiteralPath $destination) { continue }
            Move-Item -LiteralPath $source -Destination $destination
            $looseMoved += $name
        }
        # Returned behind a comma as ONE object: a commit's result travels the pipeline, which
        # unrolls a collection and would deliver an empty move list as $null.
        , ([pscustomobject]@{ topics = @($moved); loose_moved = @($looseMoved) })
    }
    $commit = $render.commit_result
    $moves = @($commit.topics)
    $looseMoved = @($commit.loose_moved)

    # --- THE OWNERSHIP ROWS, WRITTEN AFTER THE MATERIAL IS BACK ----------------------------------
    #
    # AFTER, NOT BEFORE, so a failed move never leaves a row claiming material that is still in
    # quarantine. Each topic's lock is still held here, which is what ADR-0019 requires of an
    # ownership change; Set-NotebookTopicOwner detects that and takes only the owners lock.
    #
    # A `keep` ROW IS NOT REWRITTEN. Rewriting it would restamp `recorded_utc` for no change and, for
    # a `shared` or `excluded` declaration, would silently convert it to `owned`.
    $ownership = @()
    foreach ($row in @($currentRows)) {
        $restored = @(@($moves) | Where-Object { [string]$_.topic -ceq [string]$row.topic -and [bool]$_.restored }) | Select-Object -First 1
        if ($null -eq $restored) { continue }
        if ([string]$row.action -ceq 'keep') {
            $ownership += [pscustomobject]@{ topic = [string]$row.topic; ownership = 'kept'; seat = [string]$row.current_seat; scope = [string]$row.current_scope }
            continue
        }
        Set-NotebookTopicOwner -Workspace $workspace -Topic ([string]$row.topic) -Seat $Seat -ActingSeat $Seat
        $ownership += [pscustomobject]@{ topic = [string]$row.topic; ownership = [string]$row.action; seat = $Seat; scope = 'owned' }
    }

    # The record of what came back, written into the quarantine beside the reset's own journal. A
    # partially restored quarantine is a real state -- a named-topic restore leaves the rest -- so
    # the directory has to say what left it and what is still there.
    $journalBody = ([pscustomobject]@{
        operation      = 'Restore quarantined Notebook material'
        seat           = $Seat
        seat_id        = [string]$current.seat_id
        plan_id        = $ApprovedPlanId
        adopt          = [bool]$Adopt
        restored_utc   = [DateTime]::UtcNow.ToString('o')
        topics         = @($moves)
        ownership      = @($ownership)
        loose_files    = @($looseMoved)
    } | ConvertTo-Json -Depth 6)
    Write-AtomicText -Path (Join-Path ([string]$quarantineRow.directory) 'restore-journal.json') -Text ($journalBody + "`n") | Out-Null
}
finally {
    foreach ($lock in $topicLocks) { Exit-BookLock -Lock $lock }
    Exit-BookLock -Lock $applyRegistryLock
}

$remaining = @(Get-NotebookQuarantineInventory -Workspace $workspace -Name $Quarantine)
$result.status = 'completed'
$result.restored = @($moves | Where-Object { $_.restored } | ForEach-Object { $_.topic })
# A topic the move refused is REPORTED rather than silently skipped: the reader approved a set, and
# this is how they learn the set was not what ran.
$result.left_in_quarantine = @($moves | Where-Object { -not $_.restored } | ForEach-Object { "$($_.topic): $($_.reason)" })
$result.ownership_recorded = @($ownership | ForEach-Object { "$($_.topic): $($_.ownership) (seat $($_.seat), $($_.scope))" })
$result.loose_files_restored = @($looseMoved)
# Read from the render rather than asserted: a restore whose index did not gain the topics would be
# a restore the reader cannot see.
$result.master_index_topic_count = $render.topic_count
# Read back from disk, because "what is still recoverable" is the question a reader asks next.
$result.quarantine_topics_remaining = @(if ($remaining.Count) { @($remaining[0].topics) })
$result.quarantine_loose_files_remaining = @(if ($remaining.Count) { @($remaining[0].loose_files) })
$result.basic_memory_write = $false
Write-LibraryResult -Result ([pscustomobject]$result) -Json:$Json
