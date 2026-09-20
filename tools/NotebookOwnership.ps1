<#
.SYNOPSIS
    Which seat owns which Notebook topic, and the quarantine a reset moves topics into.
    Dot-sourced; never invoked directly.

.DESCRIPTION
    THE PROBLEM SEATS CREATE. `notebook/` is shared by every seat, and reset removed all of it with
    one `Remove-Item -Recurse -Force` under no lock and with no journal. With one Desk that was
    merely blunt. With N seats it is the most habitual command in the system destroying another
    seat's hour-long compile.

    A SEPARATE RECORD, NOT `internal/raw-batch-owners.json`. Reusing that one would make reset
    correctness depend on unrelated source provenance: it is keyed by *batch*, and a Notebook topic
    may come from session findings with no batch at all.

    THREE SCOPES, AND THE THIRD IS WHY THE PREFLIGHT CAN BE HONEST.

        owned     a seat's own topic; that seat's reset takes it
        shared    deliberately common ground; NO seat's reset takes it
        excluded  deliberately out of scope; NO seat's reset takes it

    `shared` and `excluded` are declared rather than inferred. A reset that silently skips a topic
    and one that silently includes one are both wrong, and the reader is approving one specific set
    of moves (step 26a) -- so the preflight states which topics are shared or excluded rather than
    leaving them implicit in the difference between the owned set and what is on disk.

    THE DAY-ONE PREFLIGHT REFUSES UNTIL EVERY TOPIC IS MAPPED (step 23). A `topic-slug == seat-slug`
    fallback would have recognised only `notebook/main/` and left real directories like
    `notebook/library-dev/` unowned, reachable only by the dangerous whole-tree path. This was free
    on the day it shipped -- `notebook/` held only `_master-index.md` -- and it gets more expensive
    with every compiled topic. That is the whole reason it shipped on that day.

    RESET QUARANTINES; IT DOES NOT DELETE (ADR-0016). Each target is atomically renamed into
    `internal/notebook-reset-quarantine/<stamp>/`, the moves are journalled, the scaffold is rebuilt,
    and the purge is a separate approved operation. A metadata journal was the first design and round
    1 of review killed it: JSON cannot restore files after `Remove-Item -Recurse`, and copying every
    byte into JSON is expensive and crash-sensitive. Recoverability has to be a property of the MOVE.
    The repository already used this shape at `internal/shelf-delete-staging`.

    LOCK ORDER, RE-RULED 2026-09-09 (ADR-0019). `notebook-topic-owners` is its own global class and
    it is now the LAST one, after the per-topic locks rather than ahead of them:

        registry/Desk -> Book (sorted) -> topic (sorted) -> render -> notebook-topic-owners

    IT WAS DECLARED THIRD AND EVERY WRITER INVERTED IT. The compiler, Triage and Restore-BookSource
    all take this lock INSIDE a topic lock, because ownership is recorded at the END of promoting a
    topic. That inversion was harmless only because the reset happened to release the ownership lock
    before taking any topic lock -- so Codex's recommended fix for the race below, holding the
    ownership lock through the moves, would have turned three latent inversions into a live deadlock.

    SO THE RULE THAT REPLACED IT: **a topic's ownership changes only while that topic's lock is
    held.** This record lock serialises one small file's read-modify-write and is held for
    microseconds; the authority over what a topic's ownership MEANS is the topic's own lock. That is
    what closes the check-then-move race, and it closes it without any long-lived holder of a global
    record lock:

      - Set-NotebookTopicOwner takes the TOPIC lock first, then this one.
      - Assert-NotebookTopicLockHeld refuses an ownership decision made without that lock, so the
        rule lives in the callee rather than in this comment (the shape Assert-SeatRegistryLockHeld
        settled on for the registry lock the same day).
      - The reset revalidates each move under the topic lock it already holds, and needs this lock
        for nothing during its apply: the record is replaced atomically, so a lock-free READ is
        already a consistent snapshot. A lock is what serialises WRITES.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
# Test-SeatClaim and the seat registry live here. Loaded rather than assumed: this file reached them
# only because every caller so far happened to load LibrarySeat first.
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
# Get-NotebookTopicLockRoot, for the same reason. A topic's lock name has ONE definition, and after
# ADR-0019 this file has to name that lock rather than only the ownership record's -- so it loads the
# module that defines it instead of spelling "notebook/<topic>" a second time. NotebookIndex.ps1
# loads only BookWriteGuard.ps1, so there is no cycle.
. (Join-Path $PSScriptRoot 'NotebookIndex.ps1')

$script:NotebookOwnersLockName = 'internal/notebook-topic-owners'
$script:NotebookOwnerScopes = @('owned', 'shared', 'excluded')

# THE FILES A QUARANTINE DIRECTORY OWNS, which are the ones that are NOT restorable material. Named
# once, because three readers need the same answer and each of them means something different by
# getting it wrong: the reset must not MOVE a loose file onto one of these names, the restore must
# not put one back into notebook/, and the purge must not count one as material.
$script:NotebookQuarantineJournalNames = @('reset-journal.json', 'restore-journal.json')

function Get-NotebookOwnersLockName { $script:NotebookOwnersLockName }

function Enter-NotebookOwnersLock {
    <#
    .SYNOPSIS
        The LAST class in the total order (ADR-0019): taken after a topic lock, never before one.

    .DESCRIPTION
        A holder of this lock must acquire nothing else. It covers one file's read-modify-write and
        is meant to be held for microseconds -- which is exactly why it moved from third to last:
        conforming the writers to its old position would have meant holding a global record lock
        across an entire compile.
    #>
    param([Parameter(Mandatory = $true)][string]$Workspace, [int]$TimeoutSeconds = 20)
    Enter-BookLock -Workspace $Workspace -BookRoot $script:NotebookOwnersLockName -TimeoutSeconds $TimeoutSeconds
}

function Get-TopicLockedFunctions {
    <#
    .SYNOPSIS
        The functions that REFUSE to act on a topic's ownership without that topic's lock held,
        declared once so `desk.topic-lock-coverage` can read them rather than carry a second copy.

    .DESCRIPTION
        These are the two halves of ADR-0019's rule. Set-NotebookTopicOwner CHANGES ownership;
        Assert-NotebookTopicWritable and Move-NotebookTopicToQuarantine both READ it and then act on
        the answer, which is the same check-then-act unless the topic is held throughout.

        Read-NotebookTopicOwners is deliberately absent: reading the record is not acting on a topic,
        the file is replaced atomically, and the preflights that report ownership hold no lock by
        design.

        THE TWO RECOVERY ROUTES JOINED ON 2026-09-10, and they are the reverse of the two above.
        Restore-NotebookTopicFromQuarantine brings a topic BACK into notebook/, which is a claim
        about a name no other writer may be creating at the same moment; Remove-NotebookTopicOwner
        drops the row for material a purge has destroyed, which is an ownership change and therefore
        ADR-0019's rule exactly. Both read the live topic directory and then act on the answer, which
        is the check-then-act only the topic's own lock closes.
    #>
    @(
        'Set-NotebookTopicOwner',
        'Assert-NotebookTopicWritable',
        'Move-NotebookTopicToQuarantine',
        'Restore-NotebookTopicFromQuarantine',
        'Remove-NotebookTopicOwner'
    )
}

function Get-TopicLockedHelpers {
    <#
    .SYNOPSIS
        The helpers that act on a Notebook topic's ownership while holding that topic's lock,
        declared once so `desk.topic-lock-coverage` can compare the declaration with the code in
        both directions.

    .DESCRIPTION
        The three Notebook writers plus the reset. A new one is a new place ADR-0019's rule has to
        hold, and a name that disappears from the observed set means the write moved somewhere this
        check is not looking -- two different faults, and only the first is loud.

        Set-NotebookTopicOwner.ps1 is absent deliberately: the function takes the topic lock itself
        when its caller holds none, so invoking it is not a claim to be holding one.

        THE TWO RECOVERY HELPERS JOINED ON 2026-09-10. They are the reset's inverse -- one puts
        quarantined material back, the other destroys it for good -- and both decide what to do from
        an ownership row they have just read, which is the window the topic lock closes.
    #>
    @(
        'Compile-RawBatchToNotebook.ps1',
        'Invoke-LibraryTriage.ps1',
        'Remove-NotebookQuarantine.ps1',
        'Reset-LocalNotebook.ps1',
        'Restore-BookSource.ps1',
        'Restore-NotebookQuarantine.ps1'
    )
}

function Assert-NotebookTopicLockHeld {
    <#
    .SYNOPSIS
        Refuse to decide anything about one topic's ownership without holding that topic's lock in
        this process.

    .DESCRIPTION
        THE RULE THAT REPLACED A COMMENT (ADR-0019). Ownership can be remapped between a selection
        and the move it authorises, and per-topic locks alone did not stabilise the selected set --
        because the remap took no topic lock at all. Now it must, and so must every reader that acts
        on what it read, which makes each of those windows closed rather than narrow.

        NOT A SECURITY BOUNDARY, and the same in-process ledger caveat Assert-SeatRegistryLockHeld
        carries: a caller that spawns a child to do the locked work is refused rather than silently
        allowed, and that refusal is the point.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Topic,
        [Parameter(Mandatory = $true)][string]$Operation
    )
    if (Test-BookLockHeld -Workspace $Workspace -BookRoot (Get-NotebookTopicLockRoot $Topic)) { return $true }
    throw ("$Operation requires the lock for notebook/$Topic, and this process does not hold it. Take it with " +
           "Enter-BookLock -Workspace <workspace> -BookRoot (Get-NotebookTopicLockRoot '$Topic') and hold it across " +
           'the ownership check and the change it authorises. A topic''s ownership read without it is a snapshot ' +
           'another writer can invalidate before it is used.')
}

function Get-NotebookOwnersPath {
    param([Parameter(Mandatory = $true)][string]$Workspace)
    Join-Path $Workspace 'internal/notebook-topic-owners.json'
}

function Get-NotebookQuarantineRoot {
    param([Parameter(Mandatory = $true)][string]$Workspace)
    $dir = Join-Path $Workspace 'internal/notebook-reset-quarantine'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $dir
}

function Read-NotebookTopicOwners {
    <#
    .SYNOPSIS
        The ownership record, or an empty one. FAILS CLOSED on anything it cannot parse.

    .DESCRIPTION
        An unreadable record is refused rather than treated as empty, because empty is the DANGEROUS
        reading: reset would then see no owners, conclude every topic was unmapped, and the day-one
        preflight would be the only thing standing between a reader and another seat's work.
    #>
    param([Parameter(Mandatory = $true)][string]$Workspace)
    $path = Get-NotebookOwnersPath -Workspace $Workspace
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return [pscustomobject]@{ schema = 1; topics = @() } }
    $raw = $null
    try { $raw = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $path)) }
    catch { throw "The Notebook ownership record at $path could not be read: $($_.Exception.Message)" }
    $parsed = $null
    try { $parsed = $raw | ConvertFrom-Json }
    catch { throw "The Notebook ownership record at $path is not valid JSON: $($_.Exception.Message). Repair it before resetting anything." }

    $names = @($parsed.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -cnotcontains 'topics') { throw "The Notebook ownership record at $path has no 'topics' list." }
    $topics = @($parsed.topics)
    foreach ($entry in $topics) {
        $fields = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
        foreach ($required in @('topic', 'scope')) {
            if ($fields -cnotcontains $required) { throw "A topic entry in $path has no '$required' field." }
        }
        if ([string]$entry.topic -cnotmatch '^[a-z0-9][a-z0-9-]*$') { throw "The ownership record names a malformed topic '$([string]$entry.topic)'." }
        if ([string]$entry.scope -cnotin $script:NotebookOwnerScopes) {
            throw "Topic '$([string]$entry.topic)' has scope '$([string]$entry.scope)'; expected one of $($script:NotebookOwnerScopes -join ', ')."
        }
        if ([string]$entry.scope -ceq 'owned') {
            if ($fields -cnotcontains 'seat') { throw "Topic '$([string]$entry.topic)' is owned and names no seat." }
            if ([string]$entry.seat -cnotmatch (Get-SeatSlugPattern)) { throw "Topic '$([string]$entry.topic)' names a malformed seat." }
        }
        # THE INCARNATION, AND ABSENT IS THE ONLY WAY TO SAY "PRE-IDENTITY" (2026-09-10). A row
        # recorded before ADR-0018 carries no `seat_id` at all, and that absence compares equal to
        # the empty id of a registry entry that also predates ids -- which is what makes the whole
        # family need no backfill. An EMPTY STRING is refused rather than folded into absence: two
        # spellings of one state is how a record starts meaning different things to two readers.
        if ($fields -ccontains 'seat_id') {
            if ([string]$entry.scope -cne 'owned') { throw "Topic '$([string]$entry.topic)' is '$([string]$entry.scope)' and carries a seat_id; only an owned topic names an incarnation." }
            if ([string]$entry.seat_id -cnotmatch '^[A-Za-z0-9][A-Za-z0-9-]*$') {
                throw "Topic '$([string]$entry.topic)' names a malformed seat incarnation. Omit the field for a topic recorded before incarnations existed; never write it empty."
            }
        }
    }
    $keys = @($topics | ForEach-Object { [string]$_.topic })
    if (@($keys | Sort-Object -Unique).Count -ne $keys.Count) { throw "The Notebook ownership record at $path names the same topic twice." }
    [pscustomobject]@{ schema = 1; topics = $topics }
}

function Write-NotebookTopicOwners {
    <# Replace the record atomically. The caller MUST hold the ownership lock. #>
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][object]$Owners)
    $internal = Join-Path $Workspace 'internal'
    if (-not (Test-Path -LiteralPath $internal -PathType Container)) { New-Item -ItemType Directory -Path $internal -Force | Out-Null }
    $ordered = @(@($Owners.topics) | Sort-Object -Property @{ Expression = { [string]$_.topic } })
    $body = ([pscustomobject]@{ schema = 1; topics = $ordered } | ConvertTo-Json -Depth 6)
    Write-AtomicText -Path (Get-NotebookOwnersPath -Workspace $Workspace) -Text ($body + "`n") | Out-Null
}

function Get-NotebookTopicOwner {
    param([Parameter(Mandatory = $true)][object]$Owners, [Parameter(Mandatory = $true)][string]$Topic)
    @(@($Owners.topics) | Where-Object { [string]$_.topic -ceq $Topic }) | Select-Object -First 1
}

function Test-NotebookTopicWritable {
    <#
    .SYNOPSIS
        May this seat write into this topic? A read: no lock, no throw, so a PREFLIGHT can report it.

    .DESCRIPTION
        WHY A WRITER HAS TO ASK AT ALL. Until 2026-09-09 a valid claim at seat B authorised a write
        into a topic owned by seat A: the compiler and Triage validated the ACTING seat's claim and
        never looked at the target topic's owner. Seat A's ordinary reset then quarantined seat B's
        material as its own -- with seat B still claimed and still working. Found by Codex in the
        seats review, and the live workspace was in exactly that state: `notebook/2nd-b-vault-dev`
        owned by seat `library-dev`.

        THE FOUR ALLOWED CASES ARE DELIBERATE, and three of them are not "mine".

            owned by this seat    the ordinary case
            shared                declared common ground -- that is what the scope is FOR
            excluded              declared out of RESET scope, which says nothing about writing
            unmapped              nobody has claimed it, so nobody is being written over; the
                                  reset already refuses to guess at an unmapped topic, which is the
                                  right place for that refusal rather than here

        A PREFLIGHT USES THIS AND AN APPLY USES THE ASSERTION BELOW. A plan issued for a write that
        is certain to be refused is worse than no plan -- the rule Retire-Seat states and the reset's
        own preflight had to learn twice.

        AND IT COMPARES THE SLUG, NOT THE INCARNATION -- deliberately, where reset target selection
        compares both (2026-09-10). They answer different questions. This one protects a LIVE seat's
        material from another live seat, and two incarnations of one slug are never both live: the
        older is retired, by definition of the name having been reusable. So a topic owned by a
        retired incarnation of THIS seat's own name stays writable, and writing into it re-records
        ownership to the current incarnation, which is the sensible reading of a reader picking the
        name up again. Comparing incarnations here would produce a refusal that reads "work at seat
        'x' instead" addressed to somebody already sitting at seat x. Reset target selection cannot
        be that loose, because it decides what gets MOVED rather than who may add to it.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Topic,
        [Parameter(Mandatory = $true)][string]$Seat
    )
    $entry = Get-NotebookTopicOwner -Owners (Read-NotebookTopicOwners -Workspace $Workspace) -Topic $Topic
    if ($null -eq $entry) {
        return [pscustomobject]@{ topic = $Topic; writable = $true; scope = 'unmapped'; owner = $null; project = $null; reason = $null }
    }
    $scope = [string]$entry.scope
    $fields = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
    $owner = if ($scope -ceq 'owned') { [string]$entry.seat } else { $null }
    $project = if ($scope -ceq 'owned' -and $fields -ccontains 'project') { [string]$entry.project } else { $null }
    if ($scope -cne 'owned' -or $owner -ceq $Seat) {
        return [pscustomobject]@{ topic = $Topic; writable = $true; scope = $scope; owner = $owner; project = $project; reason = $null }
    }
    $projectNote = if ([string]::IsNullOrWhiteSpace($project)) { '' } else { " for project '$project'" }
    [pscustomobject]@{
        topic = $Topic
        writable = $false
        scope = $scope
        owner = $owner
        project = $project
        reason = ("notebook/$Topic is owned by seat '$owner'$projectNote, and seat '$Seat' may not write into it: that seat's " +
                  "ordinary reset would quarantine this material as its own. Work at seat '$owner' instead; or, if that seat " +
                  "is dormant, reassign the topic with tools/Set-NotebookTopicOwner.ps1 -Topic $Topic -Seat $Seat; or declare " +
                  "it shared with -Scope shared if it is genuinely common ground.")
    }
}

function Assert-NotebookTopicWritable {
    <#
    .SYNOPSIS
        The writers' gate: refuse a foreign-owned topic, with the topic's own lock held so the answer
        cannot change under the write it authorises.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Topic,
        [Parameter(Mandatory = $true)][string]$Seat
    )
    Assert-NotebookTopicLockHeld -Workspace $Workspace -Topic $Topic -Operation 'Writing into a Notebook topic' | Out-Null
    $verdict = Test-NotebookTopicWritable -Workspace $Workspace -Topic $Topic -Seat $Seat
    if (-not $verdict.writable) { throw [string]$verdict.reason }
    $true
}

function Set-NotebookTopicOwner {
    <#
    .SYNOPSIS
        Record or reassign who owns a topic. Every Notebook writer calls this for the topic it
        creates, and it is the only route by which an existing topic changes hands.

    .DESCRIPTION
        TWO LOCKS, IN THE ONE ORDER (ADR-0019). The TOPIC's lock first, because that is what makes
        this change safe against a concurrent writer or a reset; then the ownership record's, for
        the read-modify-write of the file. Both are taken only if this process does not already hold
        them, DETECTED rather than declared: the old `-LockHeld` switch could be passed wrongly by a
        caller inside a critical section, and Test-BookLockHeld answers the same question from the
        lock primitive's own ledger.

        REASSIGNMENT AWAY FROM ANOTHER LIVE SEAT IS REFUSED. It used to be ungated in every
        direction: a session could take a live seat's topic and reset it as its own. Three cases now,
        and the middle one is the reason `-ActingSeat` exists rather than the rule reading off `-Seat`
        alone:

            the acting seat IS the current owner   allowed -- handing over your own material is a
                                                   decision that seat is entitled to make
            another seat, agent running            refused -- its reset would stop covering material
                                                   it is still writing
            another seat, dormant                  allowed -- the recovery route the reset's own
                                                   refusal names

        Written the simpler way first, and the live workspace was the counter-example: seat
        `library-dev` owned `notebook/2nd-b-vault-dev` and could not hand it to the seat named for
        that project, because a rule that only asked "is the current owner live" refused the owner
        itself.

        The ACTING session's claim is asserted by Set-NotebookTopicOwner.ps1 rather than here, and
        `desk.claim-coverage` reads that declaration. This function is also called by the three
        writers, which have already asserted their own claim.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Topic,
        [string]$Seat,
        # The seat this session is WORKING AT, which is a different question from -Seat's assignee.
        # Left unset it resolves from the environment; unresolvable, the strict rule applies, because
        # "I cannot tell who is asking" must not read as "the owner is asking".
        [string]$ActingSeat,
        [string]$Project,
        [ValidateSet('owned', 'shared', 'excluded')][string]$Scope = 'owned',
        # Declare `excluded` over the evidence that the topic is reproducible. See
        # Assert-NotebookTopicExclusionEarned: the declaration stays the human's, it just has to
        # survive being looked at.
        [switch]$AcceptReproducible
    )
    if ($Topic -cnotmatch '^[a-z0-9][a-z0-9-]*$') { throw "Topic '$Topic' is malformed: lowercase letters, digits and hyphens only." }
    # ADR-0025, ENCODED HERE RATHER THAN AT A CALLER. This function is the only writer of an
    # ownership row, so a guard at one of its callers is a guard the next caller does not get.
    # OUTSIDE BOTH LOCKS DELIBERATELY: it reads the Notebook and the publication journals and takes
    # no lock of its own, and a refusal costs less before a lock than inside one.
    # The evidence is discarded rather than returned -- this function has always emitted nothing,
    # and a value leaking out of it would land in every writer that calls it.
    if ($Scope -ceq 'excluded') {
        $null = Assert-NotebookTopicExclusionEarned -Workspace $Workspace -Topic $Topic -AcceptReproducible:$AcceptReproducible
    }
    if ($Scope -ceq 'owned') {
        $resolved = Resolve-SeatName -Seat $Seat -StateDirectory (Join-Path $Workspace '.claude')
        if ($resolved.status -cne 'named') { throw $resolved.message }
        $Seat = $resolved.seat
    }
    $stateDirectory = Join-Path $Workspace '.claude'
    # THE REGISTRY ENTRY IS READ ONCE AND ANSWERS BOTH QUESTIONS. The project has always come from
    # here rather than from the caller -- a caller that restated it could disagree with the registry,
    # and then two records would describe one topic -- and since 2026-09-10 the INCARNATION comes
    # from the same read, for a stronger version of the same reason. `seat_id` is deliberately NOT a
    # parameter: a caller that could pass one could stamp a row with an incarnation the seat does
    # not have, and an ownership row's whole job after this change is to say which incarnation a
    # reset may hand the topic to.
    $seatId = ''
    if ($Scope -ceq 'owned') {
        $entry = Get-SeatEntry -Registry (Read-SeatRegistry -StateDirectory $stateDirectory) -Seat $Seat
        $seatId = Get-SeatEntryIncarnation -Entry $entry
        if ([string]::IsNullOrWhiteSpace($Project) -and $null -ne $entry) { $Project = [string]$entry.project }
    }

    # THE LOCK ROOT IS COMPOSED INLINE RATHER THAN THROUGH A VARIABLE, and that is for the gate's
    # benefit: `desk.lock-order` classifies an acquisition from the -BookRoot it can see at the call,
    # so hiding this one behind `$topicRoot` would make the topic-then-owners sequence below --
    # exactly the sequence ADR-0019 rules on -- invisible to the check that exists to hold it.
    $topicLock = $null
    if (-not (Test-BookLockHeld -Workspace $Workspace -BookRoot (Get-NotebookTopicLockRoot $Topic))) {
        $topicLock = Enter-BookLock -Workspace $Workspace -BookRoot (Get-NotebookTopicLockRoot $Topic)
    }
    try {
        Assert-NotebookTopicLockHeld -Workspace $Workspace -Topic $Topic -Operation 'Recording a Notebook topic''s owner' | Out-Null
        # UNDER THE TOPIC LOCK, so a foreign owner cannot appear between this check and the write.
        $previous = Get-NotebookTopicOwner -Owners (Read-NotebookTopicOwners -Workspace $Workspace) -Topic $Topic
        if ($null -ne $previous -and [string]$previous.scope -ceq 'owned' -and [string]$previous.seat -cne $Seat) {
            $owner = [string]$previous.seat
            $acting = $ActingSeat
            if ([string]::IsNullOrWhiteSpace($acting)) {
                # -ActingSeatOnly for the same reason as Set-NotebookTopicOwner.ps1's call: this
                # function's `-Seat` is the assignee. Nothing surfaces this message today -- only
                # `named` is read -- and the switch is here anyway, because the construction is what
                # decays, and one `throw $actingState.message` added later would ship the circle.
                $actingState = Resolve-SeatName -StateDirectory $stateDirectory -ActingSeatOnly `
                    -SeatArgumentMeans "the topic's assignee, which may be any seat"
                if ($actingState.status -ceq 'named') { $acting = [string]$actingState.seat }
            }
            # The owner giving its own topic away is entitled to; anyone else is not, while that
            # owner's agent is running.
            if ($owner -cne $acting) {
                $ownerState = [string](Get-SeatClaimState -StateDirectory $stateDirectory -Seat $owner).state
                if ($ownerState -cne 'free') {
                    $because = if ($ownerState -ceq 'held') { 'has a live session' } else { 'has a live agent process whose claim holder was lost' }
                    throw ("notebook/$Topic is owned by seat '$owner', which $because, so it may not be reassigned. Its reset " +
                           'would otherwise stop covering material it is still writing. Wait for that session to end, or make ' +
                           'the change from that seat.')
                }
            }
        }
        $ownersLock = $null
        if (-not (Test-BookLockHeld -Workspace $Workspace -BookRoot $script:NotebookOwnersLockName)) {
            $ownersLock = Enter-NotebookOwnersLock -Workspace $Workspace
        }
        try {
            $owners = Read-NotebookTopicOwners -Workspace $Workspace
            $kept = @(@($owners.topics) | Where-Object { [string]$_.topic -cne $Topic })
            $entry = [ordered]@{ topic = $Topic; scope = $Scope; recorded_utc = [DateTime]::UtcNow.ToString('o') }
            if ($Scope -ceq 'owned') {
                $entry['seat'] = $Seat
                $entry['project'] = $Project
                # OMITTED WHEN THE SEAT HAS NO INCARNATION, never written empty: absence is the one
                # spelling of "recorded before ids existed", and Read-NotebookTopicOwners refuses
                # the other one.
                if (-not [string]::IsNullOrWhiteSpace($seatId)) { $entry['seat_id'] = $seatId }
            }
            Write-NotebookTopicOwners -Workspace $Workspace -Owners ([pscustomobject]@{ schema = 1; topics = @($kept + [pscustomobject]$entry) })
        }
        finally { if ($null -ne $ownersLock) { Exit-BookLock -Lock $ownersLock } }
    }
    finally { if ($null -ne $topicLock) { Exit-BookLock -Lock $topicLock } }
}

function Get-NotebookTopicDirectories {
    <# Every topic directory on disk, defensively. Reparse points are refused, not followed. #>
    param([Parameter(Mandatory = $true)][string]$Workspace)
    $notebook = Join-Path $Workspace 'notebook'
    if (-not (Test-Path -LiteralPath $notebook -PathType Container)) { return @() }
    $names = [Collections.Generic.List[string]]::new()
    foreach ($directory in @(Get-ChildItem -LiteralPath $notebook -Directory -Force -ErrorAction Stop)) {
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq [IO.FileAttributes]::ReparsePoint) {
            throw "notebook/$($directory.Name) is a reparse point; ownership refuses to map material that lives outside the workspace."
        }
        [void]$names.Add($directory.Name)
    }
    @($names | Sort-Object -CaseSensitive)
}

function Get-NotebookOwnershipInventory {
    <#
    .SYNOPSIS
        Every topic on disk beside what the record says about it. The preflight's evidence.

    .DESCRIPTION
        Reports `unmapped` explicitly rather than folding it into "not mine". The difference between
        "no seat owns this" and "another seat owns this" is the difference between a mapping job and
        a refusal, and a preflight that blurred them would ask the reader to approve the wrong one.
    #>
    param([Parameter(Mandatory = $true)][string]$Workspace)
    $owners = Read-NotebookTopicOwners -Workspace $Workspace
    $rows = [Collections.Generic.List[object]]::new()
    foreach ($topic in @(Get-NotebookTopicDirectories -Workspace $Workspace)) {
        $entry = Get-NotebookTopicOwner -Owners $owners -Topic $topic
        if ($null -eq $entry) {
            [void]$rows.Add([pscustomobject]@{ topic = $topic; scope = 'unmapped'; seat = $null; seat_id = ''; project = $null })
            continue
        }
        $entryFields = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
        $seat = if ([string]$entry.scope -ceq 'owned') { [string]$entry.seat } else { $null }
        $project = $null
        if ([string]$entry.scope -ceq 'owned' -and $entryFields -ccontains 'project') {
            $project = [string]$entry.project
        }
        # '' RATHER THAN $null FOR A ROW WITH NO INCARNATION, so every comparison downstream is a
        # string compare against a registry entry that reports the same way. A $null here would make
        # the pre-identity case the one branch nobody wrote.
        $seatId = ''
        if ([string]$entry.scope -ceq 'owned' -and $entryFields -ccontains 'seat_id') { $seatId = [string]$entry.seat_id }
        [void]$rows.Add([pscustomobject]@{ topic = $topic; scope = [string]$entry.scope; seat = $seat; seat_id = $seatId; project = $project })
    }
    @($rows)
}

function Get-NotebookTopicJournalEvidence {
    <#
    .SYNOPSIS
        Whether a completed publication journal names a Book of this topic's slug -- the fact that
        separates a Notebook topic whose loss is reproducible from one whose loss is final.

    .DESCRIPTION
        WHY A RESET NEEDS THIS (2026-09-15). `notebook/orca-ide` was declared `excluded` to shield a
        published Book's refresh source from a reset. That declaration put the topic outside every
        reset scope at once, so a reader who asked for an empty Notebook could not have one, and the
        only route past it is an ownership edit the Reset playbook never mentions. The shield was not
        needed: Restore-BookSource.ps1's own header says a Reset clearing a Book source "is the
        ordinary way it goes", and rebuilds that source from the published Book against the
        publication journal. A topic with such a journal is not precious; it is reproducible.

        IT REPORTS EVIDENCE, NEVER A VERDICT, and that distinction is the whole point of the
        function. It says a completed journal EXISTS and names the route. It does NOT say a restore
        will succeed: Restore-BookSource also requires the Book OPEN on the Desk, refuses any
        existing notebook/<slug>, and aborts the entire run on one page-hash mismatch. A reader acts
        on this field destructively, so promising more than was checked is the failure to avoid.

        IT IS NOT A SECOND COPY OF THE SELECTOR. Restore-BookSource picks the journal with the
        greatest `timestamp_utc` among those whose `state` is `complete`; this keys on those same
        fields to COUNT them and stops there. WHICH journal wins is the restorer's ruling, and
        re-deriving that here would be a lookalike free to disagree with the real one. The four
        skip conditions are kept in the same order the selector applies them, so the count is the
        size of the set that selector would call usable rather than a looser one.

        AN UNPARSEABLE JOURNAL IS SKIPPED RATHER THAN FATAL, the same rule the selector applies,
        because this runs inside a preflight whose job is to describe the workspace rather than to
        refuse it.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Topic
    )

    $root = Join-Path $Workspace 'internal/publication-journals'
    $complete = 0
    $newest = ''
    $newestWhen = [DateTime]::MinValue
    if (Test-Path -LiteralPath $root -PathType Container) {
        foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter "$Topic-*.json" -File)) {
            $body = $null
            try { $body = ([IO.File]::ReadAllText($file.FullName, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json) }
            catch { continue }
            if ($null -eq $body) { continue }
            $names = @($body.PSObject.Properties | ForEach-Object { $_.Name })
            if ($names -cnotcontains 'state' -or $names -cnotcontains 'book_slug' -or $names -cnotcontains 'timestamp_utc') { continue }
            if ([string]$body.state -cne 'complete') { continue }
            if ([string]$body.book_slug -cne $Topic) { continue }
            $when = [DateTime]::MinValue
            if (-not [DateTime]::TryParse([string]$body.timestamp_utc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$when)) { continue }
            $complete++
            $whenUtc = $when.ToUniversalTime()
            if ($whenUtc -gt $newestWhen) { $newestWhen = $whenUtc; $newest = [string]$body.timestamp_utc }
        }
    }

    [pscustomobject]@{
        topic = $Topic
        complete_publication_journals = $complete
        newest_publication_utc = $newest
        # THE SENTENCE THE READER GETS, composed once here so a reset and any later caller cannot
        # word this differently -- the way two authorities in this repository always come to
        # disagree. It names the route and states that route's preconditions rather than promising
        # an outcome.
        note = if ($complete -gt 0) {
            "a published Book of this slug has $complete completed publication journal(s), newest $newest. This topic's source can be rebuilt with tools/Restore-BookSource.ps1 -Book $Topic, which needs that Book OPEN on the Desk, refuses to overwrite an existing notebook/$Topic, and aborts if any page fails its hash. Evidence that a route exists, not a promise that it will run."
        }
        else {
            'no completed publication journal names a Book of this slug, so nothing here can rebuild this topic if it is lost. Treat it as the only copy.'
        }
    }
}

function Get-NotebookTopicReproducibility {
    <#
    .SYNOPSIS
        Whether every page of a Notebook topic is a proven copy of a published Book -- the fact that
        decides whether declaring that topic `excluded` is earned.

    .DESCRIPTION
        ADR-0025 IN CODE RATHER THAN IN PROSE. `notebook/orca-ide` was declared `excluded` on
        2026-09-15 to shield a published Book's refresh source, and the shield was never earned:
        Restore-BookSource.ps1 rebuilds exactly that source from the Book, and its own header calls a
        Reset clearing one "the ordinary way it goes". The declaration stays AUTHORITATIVE -- ADR-0025
        considered deriving protection instead of declaring it and rejected that -- but it now has to
        survive being looked at, and this function is the look.

        TWO HALVES, AND THE SECOND IS THE LOAD-BEARING ONE. A completed publication journal says a
        route back exists. It does NOT say the Notebook holds nothing the Book does not: a page whose
        recorded hash differs from the one on disk has DRIFTED, and a rebuild from the Book would
        lose that newer text. A topic like that is legitimately excluded, so a guard carrying only
        the first half refuses a real use.

        THE PROOF RULE IS ADR-0022'S, NOT A SECOND ONE WRITTEN HERE. `pages_without_current_copy` is
        the field that carries "only known-current-copy is proof" into the data, and drift is one of
        THREE ways it goes above zero: a legacy record binds no content, and an unrecorded page was
        never published at all. Keying on `known_copy_drifted_count` alone would call a topic holding
        a brand new unpublished page reproducible -- the same misreading in a quieter spelling -- so
        the drifted count is REPORTED here and the verdict is taken from the wider field.

        IT READS THE REPORT THE RESET ALREADY RENDERS. Get-LibraryTriageInventory.ps1 groups by topic
        and hash-binds every page against the journals; re-deriving copy status here would be a
        lookalike free to disagree with the one the reader is shown, which is the failure
        Get-NotebookTopicJournalEvidence is written to avoid for the journal selector.

        EVIDENCE ABSENT IS NEVER A REFUSAL. An inventory that cannot be read, and a topic with no
        pages on disk, both report `pages_measured` false and `provably_reproducible` false. A guard
        that refused on a measurement it did not take would brick this surface on the day its data is
        thinnest, and a topic with nothing in it has nothing to lose either way.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Topic
    )

    $journals = Get-NotebookTopicJournalEvidence -Workspace $Workspace -Topic $Topic

    $row = $null
    $inventoryError = ''
    try {
        $inventory = & (Join-Path $PSScriptRoot 'Get-LibraryTriageInventory.ps1') -WorkspacePath $Workspace
        # Taken through a count rather than by indexing: a topic with no pages produces no row at
        # all, and an empty array indexed at zero is the one branch nobody writes a test for.
        $matching = @(@($inventory.topics) | Where-Object { [string]$_.topic -ceq $Topic })
        if ($matching.Count) { $row = $matching[0] }
    }
    catch { $inventoryError = $_.Exception.Message }

    $measured = ($null -ne $row)
    $pageCount = if ($measured) { [int]$row.page_count } else { 0 }
    $drifted = if ($measured) { [int]$row.known_copy_drifted_count } else { 0 }
    $unproven = if ($measured) { [int]$row.pages_without_current_copy } else { 0 }
    $completeJournals = [int]$journals.complete_publication_journals
    $reproducible = ($completeJournals -gt 0) -and $measured -and ($pageCount -gt 0) -and ($unproven -eq 0)

    [pscustomobject]@{
        topic                         = $Topic
        complete_publication_journals = $completeJournals
        newest_publication_utc        = [string]$journals.newest_publication_utc
        # FALSE MEANS NOT MEASURED, which reads differently from a measured zero. The distinction is
        # the reason a failed inventory read cannot be mistaken for a topic holding nothing.
        pages_measured                = $measured
        page_count                    = $pageCount
        known_copy_drifted_count      = $drifted
        pages_without_current_copy    = $unproven
        provably_reproducible         = $reproducible
        inventory_error               = $inventoryError
        # THE SENTENCE THE READER GETS, composed once here so the refusal below and any later caller
        # cannot word this differently -- the way two authorities in this repository come to disagree.
        note                          = if ($reproducible) {
            "all $pageCount page(s) of notebook/$Topic are hash-bound current copies of a published Book, named by $completeJournals completed publication journal(s), newest $($journals.newest_publication_utc). Nothing in this topic would be lost that tools/Restore-BookSource.ps1 -Book $Topic could not rebuild."
        }
        elseif (-not $measured) {
            $because = if ($inventoryError) { "the Notebook inventory could not be read: $inventoryError" } else { 'no page of it was found on disk' }
            "notebook/$Topic's pages could not be measured, because $because. Nothing here says whether it is reproducible, and an unmeasured topic is not a proven one."
        }
        elseif ($completeJournals -le 0) {
            "no completed publication journal names a Book of this slug, so nothing here can rebuild notebook/$Topic if it is lost. Treat it as the only copy."
        }
        else {
            "$unproven of notebook/$Topic's $pageCount page(s) have no hash-bound current copy in a published Book, $drifted of them drifted -- holding a version the Book does not. A rebuild from the Book would lose that, so this topic holds more than it can get back."
        }
    }
}

function Assert-NotebookTopicExclusionEarned {
    <#
    .SYNOPSIS
        Refuse a `-Scope excluded` declaration on a topic that is provably reproducible, and return
        the evidence either way.

    .DESCRIPTION
        WHY A REFUSAL RATHER THAN A REPORT. `excluded` puts a topic outside EVERY seat's reset at
        every scope, and the only route back is an ownership edit the Reset playbook never mentions.
        The 2026-09-15 episode was three separate readings -- the declaring session, the triaging
        session, and the reader's own -- each reasoning from the declaration's EXISTENCE rather than
        from whether it was still earned. Nothing asked. This asks, at the one moment an answer can
        still change what gets written.

        AND THE READER KEEPS THE LAST WORD. -AcceptReproducible writes the declaration anyway and
        reports that it was taken over the evidence. Without that switch this would be a derivation
        silently overriding a deliberate human declaration, which is the shape ADR-0025 weighed and
        rejected; with it, the declaration stays authoritative and merely has to survive the look.

        IT GUARDS `excluded` AND NOT `shared`, deliberately. Both are protected, but `shared` means
        deliberately common ground -- a house-style topic that is also a published Book is an
        ordinary, correct use of it -- whereas `excluded` is the word a session reaches for when it
        believes a topic is precious, which is the belief this checks.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Topic,
        [switch]$AcceptReproducible
    )
    $evidence = Get-NotebookTopicReproducibility -Workspace $Workspace -Topic $Topic
    if ($evidence.provably_reproducible -and -not $AcceptReproducible) {
        throw ("notebook/$Topic may not be declared -Scope excluded: it is provably reproducible (ADR-0025). " +
               [string]$evidence.note + ' An excluded topic sits outside every seat''s reset at every scope, so this ' +
               'declaration would make a rebuildable topic unreachable -- which is the 2026-09-15 episode ADR-0025 ' +
               'records, and a judgement two sessions have already got wrong. Let a reset clear it and rebuild with ' +
               "tools/Restore-BookSource.ps1 -Book $Topic, which needs that Book open on the Desk. If this topic must " +
               'be excluded regardless, pass -AcceptReproducible and the record is written with that choice reported.')
    }
    $evidence
}

function Get-NotebookResetTargets {
    <#
    .SYNOPSIS
        Which topics a reset at this seat may move, and why every other one is out.

    .DESCRIPTION
        THE OUTCOMES THE PREFLIGHT MUST STATE SEPARATELY (step 26a):

            targets      this seat's own incarnation, plus -- under -WholeTree -- provably retired ones
            protected    shared or excluded by declaration -- no seat's reset takes them
            foreign      owned by an incarnation that is still in the registry
            retired      owned by a provably retired incarnation; a target only under -WholeTree
            unaccounted  owned by an incarnation that is neither registered nor retired
            unmapped     owned by nobody

        AND UNDER -AllIdleSeats, `foreign` IS FILTERED BY THE SWEEP PREDICATE (ADR-0023, 2026-09-15).
        Every row it answers `allow` for joins `targets`; the rest are reported in `skipped` with the
        distinct reason and the reader-facing note the predicate carries. NOTHING ELSE MOVES:
        `retired` stays -WholeTree's, `unaccounted` stays refused, `protected` stays untouched, and
        `unmapped` still stops the run. The rows a sweep takes STAY in `foreign` as well -- that list
        classifies by ownership and the sweep does not change whose a topic is, only where it goes.

        THE TWO SWITCHES ARE REFUSED TOGETHER, and that refusal is the flag being load-bearing rather
        than cosmetic. ADR-0023 rejected extending `-WholeTree` to idle unretired seats by name: it
        is a word that claims completeness, so silently excluding a seat makes the name false and
        including one bypasses retirement. If `-AllIdleSeats` could be passed beside it, the foreign
        refusal that keeps ADR-0016's third case refused would be half-silenced by a second flag, and
        the next reader would find `-WholeTree` reaching idle seats and no decision saying it may.
        The two are composable in sequence instead -- sweep first, then whole-tree, each with its own
        preflight and its own approval -- which is what the reset's own primitives already rule
        (`Reset-LocalNotebook.ps1`, the -ClearDesk note).

        A whole-tree reset covers the current claiming seat plus explicitly retired seats, and
        HARD-REFUSES every other seat, claimed or dormant (ADR-0016). The round-1 revision had this
        backwards -- "claimed" means active, so including other claimed seats is precisely what must
        never happen -- and the round-2 revision left a third case undefined: an unclaimed, unretired
        foreign seat fits neither branch. Silently excluding it makes "whole-tree" a false name;
        including it bypasses retirement. So it is refused, with the remedy that fits its state:
        WAIT for a claimed seat, RETIRE a dormant one.

        RETIRED IS A RECORD, NOT AN ABSENCE (2026-09-10). This used to read `.claude/seats/` and
        call any owned seat missing from it retired. That directory is gitignored and holds nothing
        a commit restores, so deleting one seat's folder by hand made every topic it owned
        whole-tree eligible at the next seat, silently and with no refusal -- measured. Retirement
        is now `Get-SeatIncarnationStatus`: an archive record naming the incarnation AND no registry
        entry naming it. The hand-deleted directory leaves the seat REGISTERED, so it is foreign and
        the refusal sends the reader to retirement, which works on a seat whose Desk is gone.

        AND IT COMPARES INCARNATIONS, WHICH IS WHAT LETS A SLUG BE REUSED. The acting seat's id
        comes from its registry entry, so an ownership row naming this slug under an OLDER
        incarnation is not this reset's -- it is the retired one's, eligible only whole-tree. An
        empty id is a real incarnation meaning "recorded before ids existed" and compares equal only
        to a registry entry that also has none, which is why a pre-identity seat behaves exactly as
        it did.

        THE ACTING SEAT MUST BE REGISTERED, asserted here rather than assumed. Without it a session
        whose registry entry has vanished would resolve its own incarnation to '' and match every
        pre-identity row in the record -- reintroducing this whole family from the other end.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Seat,
        [switch]$WholeTree,
        # Sweep the Notebook topics of every IDLE foreign seat as well as this seat's own, naming
        # and skipping the ones in use (ADR-0023). Its own flag, never reachable through -WholeTree.
        [switch]$AllIdleSeats
    )
    if ($WholeTree -and $AllIdleSeats) {
        throw ('A whole-tree reset and an idle-seat sweep are two different authorisations and cannot be ' +
               'combined: -WholeTree covers this seat plus explicitly RETIRED ones (ADR-0016), and ' +
               '-AllIdleSeats covers seats that are merely idle now (ADR-0023). Run the sweep first and ' +
               'the whole-tree reset after, each with its own preflight and its own approval.')
    }
    # THE REGISTRY LOCK, because this is a cross-seat read and this function's whole job is to decide
    # which incarnations are retired from it. A seat that is created or retired between this scan and
    # the moves it authorises changes the answer, and the reset used to take no lock at all here
    # (2026-09-09 seats review). Declared in Get-RegistryLockedFunctions.
    Assert-SeatRegistryLockHeld -Workspace $Workspace -Operation 'Selecting a reset''s targets' | Out-Null
    $stateDirectory = Join-Path $Workspace '.claude'
    $registry = Read-SeatRegistry -StateDirectory $stateDirectory
    $actingEntry = Assert-SeatRegistered -StateDirectory $stateDirectory -Seat $Seat
    $actingIncarnation = Get-SeatEntryIncarnation -Entry $actingEntry
    $retirements = @((Read-SeatRetirementRecords -Workspace $Workspace).records)
    $inventory = @(Get-NotebookOwnershipInventory -Workspace $Workspace)

    $targets = [Collections.Generic.List[object]]::new()
    $protected = [Collections.Generic.List[object]]::new()
    $foreign = [Collections.Generic.List[object]]::new()
    $retired = [Collections.Generic.List[object]]::new()
    $unaccounted = [Collections.Generic.List[object]]::new()
    $unmapped = [Collections.Generic.List[object]]::new()

    foreach ($row in $inventory) {
        switch ($row.scope) {
            'unmapped' { [void]$unmapped.Add($row); continue }
            'shared'   { [void]$protected.Add($row); continue }
            'excluded' { [void]$protected.Add($row); continue }
        }
        if ($row.scope -cne 'owned') { continue }
        if ($row.seat -ceq $Seat -and [string]$row.seat_id -ceq $actingIncarnation) { [void]$targets.Add($row); continue }
        switch (Get-SeatIncarnationStatus -Registry $registry -Retirements $retirements -Seat ([string]$row.seat) -SeatId ([string]$row.seat_id)) {
            'live'    { [void]$foreign.Add($row) }
            'retired' {
                # Eligible, and ONLY in a whole-tree reset. Kept in its own list either way so the
                # preflight can say "these belong to a retired seat" rather than leaving the reader
                # to infer it from a topic appearing in a set it did not expect.
                [void]$retired.Add($row)
                if ($WholeTree) { [void]$targets.Add($row) }
            }
            default   { [void]$unaccounted.Add($row) }
        }
    }

    # --- THE SWEEP PASS (ADR-0023) ---------------------------------------------------------------
    #
    # ONE RESOLUTION PER DISTINCT (seat, seat_id), not one per row. Resolve-SeatSweepDispositions
    # carries that memo and reports how many probes it actually cost, so a selection over a seat
    # owning three topics probes it once -- which is a consistency property before it is a cost one,
    # since two probes of one seat can disagree and this pass has to answer the same way for every
    # row of it.
    #
    # THE PREDICATE IS GIVEN `foreign` AND NOTHING ELSE. Every row here already classified as `live`,
    # so its retired and unaccounted branches are unreachable from this call site by construction --
    # they stay as the guard that catches a future misclassification rather than as live paths, and
    # `skipped` reports whatever reason it gives.
    $swept = [Collections.Generic.List[object]]::new()
    $skipped = [Collections.Generic.List[object]]::new()
    $sweepProbes = 0
    $sweepSeats = 0
    if ($AllIdleSeats) {
        $dispositions = Resolve-SeatSweepDispositions -StateDirectory $stateDirectory -Registry $registry `
            -Retirements $retirements -Rows @($foreign) -ActingSeat $Seat -ActingSeatId $actingIncarnation
        $sweepProbes = [int]$dispositions.probes
        $sweepSeats = [int]$dispositions.seats
        $byTopic = @{}
        foreach ($answer in @($dispositions.rows)) { $byTopic[[string]$answer.topic] = $answer }
        foreach ($row in @($foreign)) {
            $answer = $byTopic[[string]$row.topic]
            if ($null -eq $answer) { continue }
            if ([string]$answer.decision -ceq 'allow') {
                [void]$targets.Add($row)
                [void]$swept.Add($answer)
            }
            else { [void]$skipped.Add($answer) }
        }
    }

    $refusals = [Collections.Generic.List[string]]::new()
    if ($unmapped.Count) {
        $refusals.Add("these Notebook topics are owned by no seat: $(@($unmapped | ForEach-Object { $_.topic }) -join ', '). " +
            'Map each one with tools/Set-NotebookTopicOwner, or declare it shared or excluded. A reset will not ' +
            'guess at material nobody has claimed.') | Out-Null
    }
    if ($WholeTree -and $foreign.Count) {
        # THE REMEDY FITS THE SEAT'S STATE, and there are three of them now rather than two. An
        # `orphaned` seat used to read as dormant, so this text told the reader to RETIRE a seat
        # whose agent was still running -- which would have made its topics whole-tree eligible
        # underneath it. Retirement refuses that seat anyway, so the old advice sent the reader to a
        # helper certain to refuse them.
        # $row, NOT $_, INSIDE THE SWITCH. A `switch` rebinds $_ to its own condition value, so
        # `$_.seat` in a branch reads the STATE STRING rather than the row -- a PropertyNotFound
        # under StrictMode, and found by running the two-seat suite rather than by reading this.
        $detail = @($foreign | ForEach-Object {
            $row = $_
            $remedy = switch ([string](Get-SeatClaimState -StateDirectory $stateDirectory -Seat $row.seat).state) {
                'held'     { 'wait for that session to end' }
                'orphaned' { 'that seat''s agent is still running with its claim holder lost; wait for it to end, or re-bind and close it from that conversation' }
                default    { "retire it with tools/Retire-Seat.ps1 -Seat $($row.seat)" }
            }
            "$($row.topic) (seat $($row.seat): $remedy)"
        }) -join '; '
        $refusals.Add("a whole-tree reset will not touch another seat's material: $detail") | Out-Null
    }
    if ($WholeTree -and $unaccounted.Count) {
        # THE CASE THAT USED TO BE READ AS RETIREMENT. An incarnation with no registry entry and no
        # archive record is one nothing can speak for, and a whole-tree reset is exactly the
        # operation that would move its material. Three routes actually clear it, so all three are
        # named: adopt the topic at a live seat, declare it common ground, or put the seat back.
        $detail = @($unaccounted | ForEach-Object {
            $which = if ([string]::IsNullOrWhiteSpace([string]$_.seat_id)) { 'the pre-identity incarnation' } else { "incarnation $([string]$_.seat_id)" }
            "$($_.topic) (seat $($_.seat), $which)"
        }) -join '; '
        $refusals.Add("a whole-tree reset will not touch material whose owning seat cannot be accounted for: $detail. " +
            'No registry entry names those incarnations and internal/seat-archive/ holds no retirement record for them, so ' +
            'nothing can say the work there is finished -- and a seat directory deleted by hand is not a retirement. Take the ' +
            'topic over with tools/Set-NotebookTopicOwner.ps1 -Topic <topic> -Seat ' + $Seat + ', declare it with -Scope shared ' +
            'if it is common ground, or recreate the seat and retire it properly.') | Out-Null
    }

    [pscustomobject]@{
        seat = $Seat
        seat_id = $actingIncarnation
        whole_tree = [bool]$WholeTree
        all_idle_seats = [bool]$AllIdleSeats
        targets = @($targets)
        protected = @($protected)
        foreign = @($foreign)
        retired = @($retired)
        unaccounted = @($unaccounted)
        unmapped = @($unmapped)
        # THE SWEEP'S OWN TWO LISTS, both empty without -AllIdleSeats. `swept` names what the sweep
        # ADDED to targets and `skipped` names the foreign topics it deliberately left, each with the
        # rule that left it and the sentence the predicate wrote for the reader -- never a second copy
        # of that sentence composed here, which is how this repository's two authorities always come
        # to disagree. `sweep_probes` is the number of claim probes the pass really cost, reported so
        # a caller can hold the memo to account rather than trusting it.
        swept = @($swept)
        skipped = @($skipped)
        sweep_probes = $sweepProbes
        sweep_seats = $sweepSeats
        refusals = @($refusals)
    }
}

function Move-NotebookTopicToQuarantine {
    <#
    .SYNOPSIS
        Atomically rename one topic into the reset quarantine, revalidating ownership first.

    .DESCRIPTION
        REVALIDATED IMMEDIATELY BEFORE THE MOVE (step 25). Ownership can be remapped between
        selection and deletion, so the record is read again here and a topic that changed hands since
        selection is left alone and reported rather than moved.

        AND THAT REVALIDATION IS ONLY WORTH ANYTHING BECAUSE THE TOPIC LOCK IS HELD (ADR-0019).
        It used to be a comment claiming the lock stabilised the answer while the remap took no
        topic lock at all -- so a reassignment could land between this read and the Directory.Move
        below, which is the check-then-move Codex reported. Both halves changed: the remap takes the
        topic lock, and this refuses without it rather than assuming its caller took it.

        THE INCARNATION IS PART OF THE EXPECTATION (2026-09-10), and this is where that comparison
        has to bite. Selection classifies a row by (seat, seat_id); a revalidation that compared the
        SLUG alone would let a topic that changed hands between the two -- to a new incarnation of
        the same name, which is exactly what reuse makes possible -- be moved on an approval that
        described the old one. `-ExpectedSeatId` is empty for a pre-identity incarnation, and empty
        matches only empty.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Topic,
        [Parameter(Mandatory = $true)][string]$ExpectedSeat,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ExpectedSeatId,
        [Parameter(Mandatory = $true)][string]$QuarantineDirectory
    )
    Assert-NotebookTopicLockHeld -Workspace $Workspace -Topic $Topic -Operation 'Quarantining a Notebook topic' | Out-Null
    $source = Join-Path (Join-Path $Workspace 'notebook') $Topic
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        return [pscustomobject]@{ topic = $Topic; moved = $false; reason = 'absent' }
    }
    $owners = Read-NotebookTopicOwners -Workspace $Workspace
    $entry = Get-NotebookTopicOwner -Owners $owners -Topic $Topic
    $currentIncarnation = ''
    if ($null -ne $entry -and @($entry.PSObject.Properties | ForEach-Object { $_.Name }) -ccontains 'seat_id') { $currentIncarnation = [string]$entry.seat_id }
    if ($null -eq $entry -or [string]$entry.scope -cne 'owned' -or [string]$entry.seat -cne $ExpectedSeat -or $currentIncarnation -cne $ExpectedSeatId) {
        return [pscustomobject]@{ topic = $Topic; moved = $false; reason = 'ownership changed since the preflight; left in place' }
    }
    $destination = Join-Path $QuarantineDirectory $Topic
    # A MOVE, not a copy-and-delete: the recoverability is the move's own property, which is the
    # whole reason a metadata journal was rejected.
    [IO.Directory]::Move($source, $destination)
    [pscustomobject]@{ topic = $Topic; moved = $true; source = "notebook/$Topic"; destination = $destination }
}

# --- THE OTHER END OF THE MOVE (2026-09-10) -------------------------------------------------------
#
# `recoverable` has said "topics are MOVED into internal/notebook-reset-quarantine/, never deleted"
# since the reset shipped, and until now nothing could actually bring one back -- the promise was
# true of the material and false of the Library. These are the two routes that make it a promise the
# workspace keeps: one puts a quarantined topic back, the other destroys it for good and takes its
# ownership row with it.
#
# WHY THE ROW HAS TO BE PART OF BOTH. A reset LEAVES the ownership row citing the seat when it moves
# the topic out, deliberately -- the row is what a restore reads to find out whose material it is,
# and dropping it at quarantine time would make every restore a guess. The consequence is that a
# purge which only deleted files would leave a row naming material that exists nowhere: a permanent
# blocker on that seat's slug, and a row no reset can ever clear because reset acts on directories.

function Get-NotebookQuarantineJournalNames { @($script:NotebookQuarantineJournalNames) }

function Read-NotebookQuarantineJournal {
    <#
    .SYNOPSIS
        One quarantine's `reset-journal.json`, or a `status` saying why there is none. NEVER throws
        for a directory nobody asked about.

    .DESCRIPTION
        FAILS SOFT, UNLIKE THE OWNERSHIP RECORD, and the asymmetry is deliberate. The ownership
        record decides what a reset may move, so an unreadable one must refuse. A quarantine journal
        is PROVENANCE: it says which seat quarantined this, when, and who owned each topic at the
        time. A restore that refused to run because the journal was corrupt would be refusing to give
        material back over a note about it -- so the journal's absence downgrades what the plan can
        SAY, and the material is still restorable.
    #>
    param([Parameter(Mandatory = $true)][string]$Directory)
    $path = Join-Path $Directory 'reset-journal.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return [pscustomobject]@{ status = 'missing'; journal = $null; reason = 'this quarantine carries no reset-journal.json, so nothing records which seat made it or who owned each topic' }
    }
    try {
        $parsed = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $path)) | ConvertFrom-Json
        [pscustomobject]@{ status = 'read'; journal = $parsed; reason = '' }
    }
    catch {
        [pscustomobject]@{ status = 'unreadable'; journal = $null; reason = "reset-journal.json could not be read: $($_.Exception.Message)" }
    }
}

function Get-NotebookQuarantineStamp {
    <#
    .SYNOPSIS
        When a quarantine was made, from the journal if it has one and from its own directory name
        if it has not -- and which of the two answered.

    .DESCRIPTION
        THE JOURNAL IS ALLOWED TO BE ABSENT, which is what makes this function necessary rather than
        a convenience. `Read-NotebookQuarantineJournal` fails soft on purpose (a corrupt note about
        the material must never stop the material coming back), so `quarantined_utc` is `''` for
        every quarantine whose journal is missing or unreadable -- and an age read off that field
        alone reports the oldest quarantine in a workspace as the one with no age at all.

        THE DIRECTORY NAME IS A REAL SECOND SOURCE. `Reset-LocalNotebook.ps1` names the directory
        `<seat>-<yyyyMMdd-HHmmss>` in UTC at the instant it creates it, a second or so before it
        writes the journal's own timestamp -- near enough for an age in days, and it cannot go
        missing without the quarantine going with it.

        IT NEVER FILLS `quarantined_utc` IN. The caller gets `stamped_utc` and `stamp_source`
        beside the journal's own field, left exactly as the journal gave it. A blank field and a
        field filled in from somewhere else look identical to a reader, and only one of them says
        where the answer came from.

        THE SEAT SLUG MAY CONTAIN HYPHENS, so the stamp is matched at the END of the name rather
        than by splitting on '-' and taking the last two parts of a `library-dev-20260915-041200`.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$JournalUtc = '',
        [datetime]$Now = [datetime]::UtcNow
    )
    $stamped = ''
    $source = 'unknown'
    if (-not [string]::IsNullOrWhiteSpace($JournalUtc)) {
        $parsed = [datetime]::MinValue
        if ([datetime]::TryParse($JournalUtc, [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) {
            $stamped = $parsed.ToUniversalTime()
            $source = 'journal'
        }
    }
    if ($source -ceq 'unknown' -and $Name -cmatch '-(\d{8})-(\d{6})$') {
        $parsed = [datetime]::MinValue
        if ([datetime]::TryParseExact(($Matches[1] + $Matches[2]), 'yyyyMMddHHmmss', [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) {
            $stamped = $parsed.ToUniversalTime()
            $source = 'directory-name'
        }
    }
    # A NEGATIVE AGE IS REPORTED AS IT IS, not clamped: a stamp in the future means a clock moved or
    # a directory was renamed by hand, and rounding it to zero hides exactly that.
    [pscustomobject]@{
        stamped_utc  = if ($source -ceq 'unknown') { '' } else { ([datetime]$stamped).ToString('o') }
        stamp_source = $source
        age_days     = if ($source -ceq 'unknown') { $null } else { [math]::Round(($Now.ToUniversalTime() - [datetime]$stamped).TotalDays, 1) }
    }
}

function Get-NotebookQuarantineTopicArticles {
    <#
    .SYNOPSIS
        One row per topic in a quarantine directory, naming the articles it holds. A lock-free read.

    .DESCRIPTION
        DELIBERATELY NOT PART OF `Get-NotebookQuarantineInventory`. That function is on the Desk
        overview's path, where it pays for a directory listing and a small journal read per
        quarantine; walking every topic's files there would put a recursive enumeration on a surface
        that only wants a count and an age. The two reads that name articles ask for this one.

        `_index.md` IS NOT AN ARTICLE, the same rule `Get-DeskOverview.ps1` already applies to
        `notebook/`: it is rendered from the topic rather than written into it. `file_count` counts
        every file regardless, so a topic holding something this listing does not name -- an
        attachment, a stray `.txt` -- says so with a number instead of looking empty.
    #>
    param([Parameter(Mandatory = $true)][string]$Directory)
    $rows = [Collections.Generic.List[object]]::new()
    foreach ($topic in @(Get-ChildItem -LiteralPath $Directory -Directory -Force -ErrorAction SilentlyContinue | Sort-Object -Property Name)) {
        $files = @(Get-ChildItem -LiteralPath $topic.FullName -Recurse -File -Force -ErrorAction SilentlyContinue)
        $articles = @(@($files | Where-Object { $_.Extension -ieq '.md' -and $_.Name -cne '_index.md' }) |
            ForEach-Object { $_.FullName.Substring($topic.FullName.Length).TrimStart('\', '/') -replace '\\', '/' } |
            Sort-Object -CaseSensitive)
        [void]$rows.Add([pscustomobject]@{
            topic         = $topic.Name
            article_count = $articles.Count
            file_count    = $files.Count
            articles      = @($articles)
        })
    }
    @($rows)
}

function Get-NotebookQuarantineInventory {
    <#
    .SYNOPSIS
        Every quarantine directory with what it actually holds, newest last. A lock-free read.

    .DESCRIPTION
        WHAT IS ON DISK IS THE INVENTORY; THE JOURNAL ONLY EXPLAINS IT. A restore driven from the
        journal's move list would put back whatever the journal claims rather than whatever is
        there -- and the whole point of quarantining by MOVE is that the material, not the note
        about it, is the record. So topics are the directories present and loose files are the files
        present, and the journal contributes the owner each topic had, which nothing else now knows.
    #>
    param([Parameter(Mandatory = $true)][string]$Workspace, [string]$Name)
    $root = Join-Path $Workspace 'internal/notebook-reset-quarantine'
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return @() }
    $rows = [Collections.Generic.List[object]]::new()
    foreach ($directory in @(Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction SilentlyContinue | Sort-Object -Property Name)) {
        if (-not [string]::IsNullOrWhiteSpace($Name) -and $directory.Name -cne $Name) { continue }
        $read = Read-NotebookQuarantineJournal -Directory $directory.FullName
        $recorded = [Collections.Generic.List[object]]::new()
        $seat = ''
        $stamped = ''
        $wholeTree = $false
        $allIdleSeats = $false
        if ([string]$read.status -ceq 'read') {
            $fields = @($read.journal.PSObject.Properties | ForEach-Object { $_.Name })
            if ($fields -ccontains 'seat') { $seat = [string]$read.journal.seat }
            if ($fields -ccontains 'quarantined_utc') { $stamped = [string]$read.journal.quarantined_utc }
            if ($fields -ccontains 'whole_tree') { $wholeTree = [bool]$read.journal.whole_tree }
            # THE OTHER WAY ONE QUARANTINE COMES TO HOLD SEVERAL SEATS' TOPICS (2026-09-15,
            # ADR-0023). A journal written before the sweep existed carries no such field and reads
            # $false, which is true of it: nothing before that date was a sweep.
            if ($fields -ccontains 'all_idle_seats') { $allIdleSeats = [bool]$read.journal.all_idle_seats }
            # `targets` is the 2026-09-10 field and a journal written before it carries none. An
            # older quarantine is still restorable; what it loses is the recorded owner, which the
            # restore then reports as unknown rather than inventing.
            if ($fields -ccontains 'targets') {
                foreach ($row in @($read.journal.targets)) {
                    if ($null -eq $row) { continue }
                    $rowFields = @($row.PSObject.Properties | ForEach-Object { $_.Name })
                    if ($rowFields -cnotcontains 'topic') { continue }
                    [void]$recorded.Add([pscustomobject]@{
                        topic   = [string]$row.topic
                        seat    = if ($rowFields -ccontains 'seat') { [string]$row.seat } else { '' }
                        seat_id = if ($rowFields -ccontains 'seat_id') { [string]$row.seat_id } else { '' }
                    })
                }
            }
        }
        $journalNames = @($script:NotebookQuarantineJournalNames)
        $stamp = Get-NotebookQuarantineStamp -Name $directory.Name -JournalUtc $stamped
        [void]$rows.Add([pscustomobject]@{
            name             = $directory.Name
            directory        = $directory.FullName
            seat             = $seat
            quarantined_utc  = $stamped
            # BESIDE the journal's own field and never over it (2026-09-15). `quarantined_utc` stays
            # empty when no journal answered; these two say when the quarantine was made anyway, and
            # which source said so, so the Desk can report an age for a quarantine whose journal is
            # gone without claiming the journal supplied it.
            stamped_utc      = [string]$stamp.stamped_utc
            stamp_source     = [string]$stamp.stamp_source
            age_days         = $stamp.age_days
            whole_tree       = $wholeTree
            all_idle_seats   = $allIdleSeats
            journal_status   = [string]$read.status
            journal_reason   = [string]$read.reason
            recorded_owners  = @($recorded)
            topics           = @(@(Get-ChildItem -LiteralPath $directory.FullName -Directory -Force -ErrorAction SilentlyContinue) |
                                    ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
            loose_files      = @(@(Get-ChildItem -LiteralPath $directory.FullName -File -Force -ErrorAction SilentlyContinue) |
                                    Where-Object { $journalNames -cnotcontains $_.Name } | ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
        })
    }
    @($rows)
}

function Restore-NotebookTopicFromQuarantine {
    <#
    .SYNOPSIS
        Atomically rename one quarantined topic back into `notebook/`. The caller MUST hold that
        topic's lock, and the render lock is the caller's to take around this.

    .DESCRIPTION
        THE COLLISION IS CHECKED HERE AND NOT ONLY IN THE PREFLIGHT, because the preflight's answer
        is a snapshot and a compile at another seat can create the name in between. Under the topic
        lock that window is closed: a writer creating `notebook/<topic>` holds this same lock.

        IT NEVER OVERWRITES. A topic that has come back into existence since the reset is material
        somebody made after the quarantine, and the quarantined copy is the older one -- so the move
        is refused and REPORTED, and the quarantine keeps its copy for the reader to merge by hand.
        Restoring over it would destroy the newer work with no record at all, which is the one thing
        a recovery route must not do.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Topic,
        [Parameter(Mandatory = $true)][string]$QuarantineDirectory
    )
    Assert-NotebookTopicLockHeld -Workspace $Workspace -Topic $Topic -Operation 'Restoring a Notebook topic from quarantine' | Out-Null
    $source = Join-Path $QuarantineDirectory $Topic
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        return [pscustomobject]@{ topic = $Topic; restored = $false; reason = 'absent from the quarantine' }
    }
    $destination = Join-Path (Join-Path $Workspace 'notebook') $Topic
    if (Test-Path -LiteralPath $destination) {
        return [pscustomobject]@{ topic = $Topic; restored = $false
            reason = 'a topic of that name exists in notebook/ again; the quarantined copy was left where it is rather than written over newer material' }
    }
    [IO.Directory]::Move($source, $destination)
    [pscustomobject]@{ topic = $Topic; restored = $true; source = $source; destination = "notebook/$Topic" }
}

function Remove-NotebookTopicOwner {
    <#
    .SYNOPSIS
        Drop one topic's ownership row, for material that no longer exists anywhere. The caller MUST
        hold that topic's lock.

    .DESCRIPTION
        THE ONLY CALLER IS THE PURGE, AND THE GUARD IS WHY. A row is removable exactly when the
        topic it names exists neither in `notebook/` nor in the quarantine being destroyed -- so the
        live directory is checked HERE, under the lock, rather than trusted from a preflight. The
        sequence this defends against is ordinary: a reset quarantines `foo`, the seat compiles
        `foo` again, and a purge of that quarantine must take the destroyed material's row with it
        and leave the LIVE topic's row exactly where it is. Both rows are spelled the same; only the
        directory tells them apart.

        IT REFUSES A ROW THAT IS NOT `owned`. `shared` and `excluded` are declarations about a NAME
        rather than records of material, so a purge has no standing to retract one.

        AND IT COMPARES THE INCARNATION, for Move-NotebookTopicToQuarantine's reason: a row that
        changed hands between the preview and the run describes somebody else's material now.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Topic,
        [Parameter(Mandatory = $true)][string]$ExpectedSeat,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ExpectedSeatId
    )
    Assert-NotebookTopicLockHeld -Workspace $Workspace -Topic $Topic -Operation 'Removing a Notebook topic''s ownership row' | Out-Null
    if (Test-Path -LiteralPath (Join-Path (Join-Path $Workspace 'notebook') $Topic) -PathType Container) {
        return [pscustomobject]@{ topic = $Topic; removed = $false
            reason = 'a topic of that name exists in notebook/, so its row describes live material rather than what was purged' }
    }
    $ownersLock = $null
    if (-not (Test-BookLockHeld -Workspace $Workspace -BookRoot $script:NotebookOwnersLockName)) {
        $ownersLock = Enter-NotebookOwnersLock -Workspace $Workspace
    }
    try {
        $owners = Read-NotebookTopicOwners -Workspace $Workspace
        $entry = Get-NotebookTopicOwner -Owners $owners -Topic $Topic
        if ($null -eq $entry) { return [pscustomobject]@{ topic = $Topic; removed = $false; reason = 'no ownership row names it' } }
        if ([string]$entry.scope -cne 'owned') {
            return [pscustomobject]@{ topic = $Topic; removed = $false
                reason = "the record declares that name '$([string]$entry.scope)', which is a declaration rather than a record of material; it was left alone" }
        }
        $currentIncarnation = ''
        if (@($entry.PSObject.Properties | ForEach-Object { $_.Name }) -ccontains 'seat_id') { $currentIncarnation = [string]$entry.seat_id }
        if ([string]$entry.seat -cne $ExpectedSeat -or $currentIncarnation -cne $ExpectedSeatId) {
            return [pscustomobject]@{ topic = $Topic; removed = $false; reason = 'ownership changed since the preflight; the row was left in place' }
        }
        $kept = @(@($owners.topics) | Where-Object { [string]$_.topic -cne $Topic })
        Write-NotebookTopicOwners -Workspace $Workspace -Owners ([pscustomobject]@{ schema = 1; topics = @($kept) })
        [pscustomobject]@{ topic = $Topic; removed = $true; seat = $ExpectedSeat; seat_id = $ExpectedSeatId }
    }
    finally { if ($null -ne $ownersLock) { Exit-BookLock -Lock $ownersLock } }
}
