<#
.SYNOPSIS
    Seats: the registry, the session claim, the advisory activity record, and the migration off the
    single-Desk layout. Dot-sourced; never invoked directly.

.DESCRIPTION
    One Library, N seats (ADR-0015). `tools/BookRootSchema.ps1` owns where a seat's Desk FILES live,
    because it already owns their content schema. This file owns everything else a seat is: which
    seats exist, which Project each is bound to, whether one is being worked right now, and how a
    checkout that predates seats acquires its first one.

    THREE SYNCHRONISATION MECHANISMS, AND ONLY ONE OF THEM IS A LOCK.

    1. THE REGISTRY LOCK is an ordered lock, and the FIRST class in the total order:

           registry/Desk -> Book (sorted) -> topic (sorted) -> render -> notebook-topic-owners

       Everything that mutates the registry or any Desk takes it: seat creation, retirement,
       migration, Set-VirtualDesk, reset, rename, archive and remove. Before this, every cross-seat
       Desk inspection was check-then-act -- a seat could open a Book after archive had scanned the
       Desks, and rename could overwrite another seat's simultaneous Desk edit.

    2. THE SESSION CLAIM IS A NON-BLOCKING EXCLUSION PROBE AND IS NOT AN ORDERED LOCK. It is held by
       the launcher for the life of the session, which is a span no ordered lock may ever cover.
       Nothing waits on it. Enter-SeatClaim tries once and fails immediately, and Test-SeatClaim
       probes without blocking at all.

       THAT NON-BLOCKING PROPERTY IS LOAD-BEARING (step 9c). If claim inspection could wait while
       holding an ordered lock, reset would hold the registry lock waiting for a foreign session's
       claim while that session waited for the registry to update its own Desk. Deadlock, between
       two operations that are each individually correct.

    3. `activity.json` IS ADVICE AND MUST NEVER AUTHORIZE OR UNBLOCK A MUTATION. It is written as a
       lock-free atomic replacement through a unique temp file, needs no seat lock, and joins no
       order. It is deliberately NOT called a lease, because it is not one: nothing renews it and
       nothing may gate on it. It carries no PID unless a durable process identity is supplied --
       the hook process that would write one is dead immediately afterwards, so its PID would name
       a process that no longer exists and would read as authoritative liveness.

    LIVENESS IS THE CLAIM, NEVER THE DESK. `CONTEXT.md` defines the Desk as what is in play, not
    process liveness: an abandoned seat stays non-empty forever, and an active seat can have an
    empty Desk while writing Notebook material. Round 1 of review proposed Desk non-emptiness as the
    liveness gate and it is wrong in both directions.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
# THE MAINTENANCE BARRIER, IMPORTED IN ONE DIRECTION ONLY. Assert-SeatClaimHeld below refuses on it,
# which is how every claim-gated mutator inherits the refusal; MaintenanceBarrier.ps1 knows nothing
# about seats in return, so the pair cannot become a cycle. Who may RAISE one is the mover's
# business, not this file's.
. (Join-Path $PSScriptRoot 'MaintenanceBarrier.ps1')

# THE ORDERED LOCK CLASSES, IN THEIR ONE TOTAL ORDER. Named here so the gate check and every
# acquiring helper read the same list rather than two copies that can disagree.
#
# `notebook-topic-owners` MOVED FROM THIRD TO LAST ON 2026-09-09 (ADR-0019), and that is a ruling
# rather than a tidy-up. It had been declared third, ahead of the per-topic locks -- and all three
# Notebook writers took it INSIDE a topic lock, inverting it, harmless only because the reset
# happened to release it before taking topic locks. Making the writers conform to the old order
# would have meant holding a GLOBAL record lock across an entire compile.
#
# The ownership record lock is the narrowest thing in this system: it serialises the
# read-modify-write of one small JSON file and is held for microseconds. The authority over what a
# topic's ownership MEANS is the topic's own lock, which is why Set-NotebookTopicOwner now takes that
# first and Assert-NotebookTopicLockHeld refuses an ownership decision made without it.
$script:SeatLockOrder = @('registry', 'book', 'topic', 'render', 'notebook-topic-owners')

# The registry lock's name, in the namespace Enter-BookLock already generalises over.
$script:SeatRegistryLockName = 'registry/desk'

function Get-SeatRegistryLockName { $script:SeatRegistryLockName }
function Get-SeatLockOrder { @($script:SeatLockOrder) }

# THE GLOSSARY TERMS THIS MODEL RESTS ON, declared so `context.seat-vocabulary` can compare them
# against CONTEXT.md rather than trusting that somebody kept both in step. ADR-0015's own consequence
# is the rule -- a domain term cannot enter the code ahead of the glossary -- and ADR-0018 added
# three more the binding work is about to depend on, and 2026-09-10 added *Retirement record* --
# the term that stopped a missing directory from meaning "retired". CONTEXT.md is the authority for
# what each MEANS; this list is only the code's claim that it needs them defined.
$script:SeatVocabulary = @('Seat', 'Desk', 'Conversation', 'Binding', 'Claim holder', 'Seat incarnation', 'Retirement record')

function Get-SeatVocabulary { @($script:SeatVocabulary) }

# THE WRAPPERS THAT ACQUIRE AN ORDERED LOCK WITHOUT SPELLING Enter-BookLock, and the class each one
# takes. Declared here beside the order itself so `desk.lock-order` can see through them.
#
# WHY THIS EXISTS: that check read only `Enter-BookLock` with a LITERAL -BookRoot, so it was blind to
# every acquisition in the Notebook family -- the owners lock behind its wrapper, the render lock
# behind Invoke-NotebookRender, and every topic lock, because those are all composed
# ("notebook/$Topic") rather than literal. The result was a check that passed while three writers
# inverted the declared order, which is how ADR-0019's ruling came to be needed at all.
#
# ONE ENTRY PER FUNCTION WHOSE WHOLE JOB IS TO TAKE ONE LOCK. Invoke-NotebookRender does more than
# that -- it runs a commit block inside the render lock -- and it is here anyway, because from a
# caller's line it IS an acquisition and that is what the order is about.
$script:SeatLockAcquiringFunctions = @(
    [pscustomobject]@{ function = 'Enter-SeatRegistryLock';   class = 'registry' }
    [pscustomobject]@{ function = 'Enter-NotebookOwnersLock'; class = 'notebook-topic-owners' }
    [pscustomobject]@{ function = 'Invoke-NotebookRender';    class = 'render' }
)

function Get-SeatLockAcquiringFunctions { @($script:SeatLockAcquiringFunctions) }

function Enter-SeatRegistryLock {
    <#
    .SYNOPSIS
        Take the registry/Desk lock -- the first class in the total order, so it is always safe to
        take and never safe to take second.
    #>
    param([Parameter(Mandatory = $true)][string]$Workspace, [int]$TimeoutSeconds = 20)
    Enter-BookLock -Workspace $Workspace -BookRoot $script:SeatRegistryLockName -TimeoutSeconds $TimeoutSeconds
}

function Test-SeatRegistryLockHeld {
    <# Does THIS runspace hold the registry/Desk lock? #>
    param([Parameter(Mandatory = $true)][string]$Workspace)
    Test-BookLockHeld -Workspace $Workspace -BookRoot $script:SeatRegistryLockName
}

function Assert-SeatRegistryLockHeld {
    <#
    .SYNOPSIS
        Refuse to answer a cross-seat question, or to write a Desk, without the registry lock held
        in this process.

    .DESCRIPTION
        THE CONTRACT USED TO BE A COMMENT, AND FOUR HELPERS BROKE IT. Get-DeskEntriesAcrossSeats
        said "the caller holds the registry lock" in prose; docs/seats.md named eight helpers as
        taking it; three did. Rename, Archive, Remove and Reset scanned every seat's Desk against a
        snapshot a concurrent Set-VirtualDesk Open could invalidate, and `desk.lock-order` could not
        see it -- that check flags inversions, never absences. Found 2026-09-09 by the seats review,
        by reading and by Codex independently.

        So the rule moved from prose into the callee. A cross-seat scan whose answer is about to be
        acted on is only true while the set of seats and their Desks cannot change, and this is the
        only place that can insist on it.

        NOT A SECURITY BOUNDARY, and not trying to be: an in-process ledger answers for this
        runspace, so a caller that spawns a child to do the locked work is refused rather than
        silently allowed. That refusal is the point -- the child would deadlock on the same
        non-reentrant lock.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Operation
    )
    if (Test-SeatRegistryLockHeld -Workspace $Workspace) { return $true }
    throw ("$Operation requires the registry/Desk lock, and this process does not hold it. Take it " +
           'with Enter-SeatRegistryLock -Workspace <workspace> before the Book lock (the total order ' +
           "is $($script:SeatLockOrder -join ' -> ')), and hold it across the check and the change it " +
           'authorises. A cross-seat answer read without it is a snapshot another seat can invalidate ' +
           'before it is used.')
}

# --- The registry ---------------------------------------------------------------------------------
#
# `.claude/seats/_registry.json`. Gitignored with the rest of `.claude/seats/`, because it is this
# checkout's runtime state: a restore that rolled it back would roll back the reader's seats along
# with the code, which is the rule `.gitignore` states at the top.

function Get-EmptySeatRegistry {
    [pscustomobject]@{ schema = 1; seats = @() }
}

function Read-SeatRegistry {
    <#
    .SYNOPSIS
        The registry, or an empty one. FAILS CLOSED on anything it cannot parse (step 12).

    .DESCRIPTION
        An unreadable or malformed registry is refused rather than treated as empty. Treating it as
        empty is the dangerous reading: reset would then see no foreign seats and conclude a
        whole-tree reset was safe.
    #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory)
    $path = Get-SeatRegistryPath $StateDirectory
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return (Get-EmptySeatRegistry) }
    $raw = $null
    try { $raw = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $path)) }
    catch { throw "The seat registry at $path could not be read: $($_.Exception.Message)" }
    $parsed = $null
    try { $parsed = $raw | ConvertFrom-Json }
    catch { throw "The seat registry at $path is not valid JSON: $($_.Exception.Message). Repair it or retire the seats it names." }

    $names = @($parsed.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -cnotcontains 'seats') { throw "The seat registry at $path has no 'seats' list." }
    $seats = @($parsed.seats)
    foreach ($seat in $seats) {
        $seatNames = @($seat.PSObject.Properties | ForEach-Object { $_.Name })
        foreach ($required in @('seat', 'project')) {
            if ($seatNames -cnotcontains $required) { throw "A seat entry in $path has no '$required' field." }
        }
        if ([string]$seat.seat -cnotmatch (Get-SeatSlugPattern)) { throw "The seat registry names a malformed seat '$([string]$seat.seat)'." }
        if ([string]$seat.project -cnotmatch (Get-SeatSlugPattern)) { throw "Seat '$([string]$seat.seat)' is bound to a malformed project slug." }
    }
    # THE BINDING IS UNIQUE IN BOTH DIRECTIONS (step 22), and it is asserted on the way IN rather
    # than only at the point one is created. A registry hand-edited into a two-seats-one-project
    # state must not be usable, because notebook/<project-slug>/ and output/<project-slug>/ would
    # then have two owners and the singular topic-owner record cannot represent that safely.
    $seatKeys = @($seats | ForEach-Object { [string]$_.seat })
    if (@($seatKeys | Sort-Object -Unique).Count -ne $seatKeys.Count) { throw "The seat registry at $path names the same seat twice." }
    $projectKeys = @($seats | ForEach-Object { [string]$_.project })
    if (@($projectKeys | Sort-Object -Unique).Count -ne $projectKeys.Count) {
        throw "The seat registry at $path binds one project to two seats. A project has at most one seat; retire one with tools/Retire-Seat.ps1."
    }
    [pscustomobject]@{ schema = 1; seats = $seats }
}

function Write-SeatRegistry {
    <#
    .SYNOPSIS
        Replace the registry atomically. The caller MUST already hold the registry lock.
    #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][object]$Registry)
    $seatsRoot = Get-SeatsDirectory $StateDirectory
    if (-not (Test-Path -LiteralPath $seatsRoot -PathType Container)) { New-Item -ItemType Directory -Path $seatsRoot -Force | Out-Null }
    # Sorted, so two runs that produce the same seats produce the same bytes and a diff means a
    # change rather than an ordering accident.
    $ordered = @(@($Registry.seats) | Sort-Object -Property @{ Expression = { [string]$_.seat } })
    $body = ([pscustomobject]@{ schema = 1; seats = $ordered } | ConvertTo-Json -Depth 6)
    Write-AtomicText -Path (Get-SeatRegistryPath $StateDirectory) -Text ($body + "`n") | Out-Null
}

function Get-SeatEntry {
    param([Parameter(Mandatory = $true)][object]$Registry, [Parameter(Mandatory = $true)][string]$Seat)
    @(@($Registry.seats) | Where-Object { [string]$_.seat -ceq $Seat }) | Select-Object -First 1
}

function Get-SeatRosterSentence {
    <#
    .SYNOPSIS
        THE SEATS THAT EXIST, AS ONE SENTENCE, SPELLED ONCE (2026-09-18).

    .DESCRIPTION
        TWO REFUSALS ANSWER "WHICH SEATS ARE THERE?" RATHER THAN SENDING THE READER TO FIND OUT, and
        they must not be two spellings of it. `Assert-SeatRegistered` below is the older one.
        `Get-DeskOverview.ps1` is the newer, and it is the helper `Resolve-SeatName`'s malformed-name
        refusal NAMES as the remedy -- so until 2026-09-18 a reader who followed that remedy was
        handed the same refusal again by the thing it had sent them to.

        EACH CALLER SUPPLIES ITS OWN SOURCE OF SEATS, deliberately. This one has the registry in hand
        and the overview has the consistency report, which is a different question in a workspace
        somebody has hand-edited; a shared source here would make one of the two answer about the
        wrong thing. What is shared is the sentence.
    #>
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Seats)
    $names = @($Seats)
    if ($names.Count) { "Seats that exist: $($names -join ', ')." } else { 'No seats exist yet.' }
}

function Assert-SeatRegistered {
    <#
    .SYNOPSIS
        The `unknown` refusal, worded once. `unset` is a DIFFERENT refusal and lives in
        BookRootSchema.ps1's Resolve-SeatName -- see the ruling recorded there.
    #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Seat)
    $registry = Read-SeatRegistry -StateDirectory $StateDirectory
    $entry = Get-SeatEntry -Registry $registry -Seat $Seat
    if ($null -eq $entry) {
        $known = @(@($registry.seats) | ForEach-Object { [string]$_.seat })
        $list = Get-SeatRosterSentence -Seats $known
        throw "There is no seat named '$Seat'. $list Create one with tools/Start-LibrarySeat.ps1 -Seat $Seat -Project <project-slug>."
    }
    $entry
}

# --- The session claim ----------------------------------------------------------------------------

function Get-SeatClaimPath {
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Seat)
    Join-Path (Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat) '.claim'
}

function Enter-SeatClaim {
    <#
    .SYNOPSIS
        Take a seat's exclusive session claim, or fail IMMEDIATELY. Never waits (step 9c).

    .DESCRIPTION
        The handle holds the file open with FileShare::None for the life of the session, so the
        claim ends exactly when the process does -- including when it is killed, which is the
        property a written-down "who is active" record can never have. Returns a handle whose
        `token` the launcher exports; every seat-aware mutator requires a matching one (step 15b).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        # THE ATTEMPT THAT OWNS THIS HANDLE (plan step 4). A claim holder writes the id of the attempt
        # it was spawned for, so the helper waiting on the handshake can tell ITS holder's handle from
        # one a previous attempt left open -- a handle alone proves somebody holds the seat, never that
        # the somebody is the process this helper just started. The launcher passes none: it holds its
        # own claim in-process for the life of the session and there is no attempt to confuse it with.
        [string]$AttemptId
    )
    $deskDirectory = Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat
    if (-not (Test-Path -LiteralPath $deskDirectory -PathType Container)) { New-Item -ItemType Directory -Path $deskDirectory -Force | Out-Null }
    $claimPath = Get-SeatClaimPath -StateDirectory $StateDirectory -Seat $Seat
    $token = [guid]::NewGuid().ToString('N')
    try {
        # Create-or-truncate rather than CreateNew: a claim file left behind by a killed process is
        # not held by anyone, so it must be reusable. What excludes a second session is the SHARE
        # MODE on the live handle, not the file's existence -- which is exactly why this survives a
        # crash without a staleness timeout, and why it cannot be faked by writing the file.
        #
        # FileShare::Read, NOT ::None, and the difference is not a detail. ::None excludes every
        # other opener including a legitimate READER, so Get-SeatClaimToken could not read the token
        # of a claim that was being held -- and Assert-SeatClaimHeld then refused the very session
        # that held the seat, with "no live session". Found by running it. ::Read still excludes a
        # second claim, because Enter-SeatClaim asks for Write access with ::None and no share mode
        # permits that against a live handle; what it stops excluding is the read.
        $stream = [IO.File]::Open($claimPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    }
    catch [IO.IOException] {
        throw ("Seat '$Seat' already has a live session. One session per seat: finish or close that one, " +
               'or start work at another seat with tools/Start-LibrarySeat.ps1 -Seat <name>.')
    }
    $writer = [IO.StreamWriter]::new($stream)
    $writer.WriteLine("token=$token")
    $writer.WriteLine("pid=$PID")
    $writer.WriteLine("claimed=$([DateTime]::UtcNow.ToString('o'))")
    if (-not [string]::IsNullOrWhiteSpace($AttemptId)) { $writer.WriteLine("attempt=$AttemptId") }
    $writer.Flush()
    [pscustomobject]@{ path = $claimPath; stream = $stream; writer = $writer; seat = $Seat; token = $token; attempt_id = $AttemptId }
}

function Exit-SeatClaim {
    <# Release a claim. NEVER THROWS: almost every call site is a finally. #>
    param([Parameter(Mandatory = $true)][object]$Claim)
    if ($null -eq $Claim) { return }
    try { $Claim.writer.Dispose() } catch { }
    try { $Claim.stream.Dispose() } catch { }
    Remove-Item -LiteralPath $Claim.path -Force -ErrorAction SilentlyContinue
}

function Test-SeatClaim {
    <#
    .SYNOPSIS
        Is a live session holding this seat? Probes WITHOUT WAITING, ever (step 9c).

    .DESCRIPTION
        The probe opens the claim file for READ with FileShare::Read. If that succeeds the claim is
        dead and the handle is closed again immediately; if it throws, someone holds it. No timeout,
        no retry, no sleep -- callers reach this while holding the registry lock.

        WHY READ/READ RATHER THAN READWRITE/NONE (2026-09-15, PLAN-notebook-drain.md row 7). The
        holder opens the claim with `FileAccess::Write, FileShare::Read` (see Enter-SeatClaim), so
        asking for READ against a share mode that permits it, while offering a share mode that does
        NOT permit the holder's Write, still fails exactly when somebody holds the seat -- the
        detection is unchanged. What changes is everything else the old probe excluded:

          - A CONCURRENT READER NO LONGER READS AS A LIVE SESSION. `FileShare::None` refuses to
            coexist with any handle at all, so a probe landing while Get-SeatClaimField had the file
            open for its ordinary `FileShare::ReadWrite` read returned $true with nobody holding the
            seat. That is a false positive on the function every overview, guard and sweep consults.
          - TWO PROBES NO LONGER COLLIDE. A cross-seat sweep and a Desk overview could each report a
            live session that was only the other one looking.

        WHAT THIS DOES NOT CLOSE, stated rather than implied: a legitimate Enter-SeatClaim asks for
        WRITE access, and no share mode this probe could offer permits that while its own handle is
        open -- offering ::ReadWrite would stop the probe detecting the holder at all, which is the
        whole function. So a claim entry landing inside the microseconds this handle exists still
        fails with "already has a live session". What bounds it is the CALLER: a sweep resolves each
        distinct (seat, seat_id) once per pass (Resolve-SeatSweepDispositions) rather than once per
        ownership row, so the exposure is one probe per seat per pass rather than one per topic.
    #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Seat)
    $claimPath = Get-SeatClaimPath -StateDirectory $StateDirectory -Seat $Seat
    if (-not (Test-Path -LiteralPath $claimPath -PathType Leaf)) { return $false }
    try {
        $probe = [IO.File]::Open($claimPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $probe.Dispose()
        return $false
    }
    catch [IO.IOException] { return $true }
    catch [UnauthorizedAccessException] { return $true }
}

function Get-SeatClaimField {
    <#
    .SYNOPSIS
        One `name=value` field out of a live claim file, or `$null`. Read-only; takes no lock and
        never waits.

    .DESCRIPTION
        FileShare::ReadWrite, because the holder still has the file open for writing -- which is the
        point of the claim -- and any narrower share mode would refuse the very reads that verify it.
        Every value here is 32 hex characters, so the pattern is anchored rather than split on '='.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][ValidateSet('token', 'attempt')][string]$Name
    )
    $claimPath = Get-SeatClaimPath -StateDirectory $StateDirectory -Seat $Seat
    if (-not (Test-Path -LiteralPath $claimPath -PathType Leaf)) { return $null }
    try {
        $stream = [IO.File]::Open($claimPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            $reader = [IO.StreamReader]::new($stream)
            $text = $reader.ReadToEnd()
        }
        finally { $stream.Dispose() }
    }
    catch { return $null }
    foreach ($line in ($text -split "`r?`n")) {
        if ($line -cmatch "^$Name=([0-9a-f]{32})$") { return $Matches[1] }
    }
    $null
}

function Get-SeatClaimToken {
    <# The token recorded in a live claim file, or $null. #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Seat)
    Get-SeatClaimField -StateDirectory $StateDirectory -Seat $Seat -Name 'token'
}

function Get-SeatClaimAttemptId {
    <# The holder attempt that opened the live claim handle, or $null. #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Seat)
    Get-SeatClaimField -StateDirectory $StateDirectory -Seat $Seat -Name 'attempt'
}

# --- The binding's WRITERS. The record itself is defined in BookRootSchema.ps1 -------------------
#
# THE READER MOVED DOWN ON 2026-09-09 AND THE WRITERS DID NOT, and the line between them is the
# registry lock. Reading a binding is how a seat is IDENTIFIED, and the two guards, the Desk hook and
# the reader adapter all identify a seat while dot-sourcing BookRootSchema.ps1 and nothing else -- so
# Get-SeatBindingPath, Read-SeatBinding, Get-AgentProcessIdentity, Test-SeatAgentAlive and
# Get-CurrentAgentProcessId live there, beside Resolve-SeatName, which now consults them. Writing one
# asserts the registry lock, and the registry lock is this file's, so Write-SeatBinding and
# Remove-SeatBinding stay here. Nothing changed for any caller of this file: it dot-sources the
# schema, so every moved function is still in scope.

function Write-SeatBinding {
    <#
    .SYNOPSIS
        Write a seat's binding atomically. THE CALLER MUST HOLD THE REGISTRY LOCK.

    .DESCRIPTION
        The lock is asserted rather than documented, for the reason Assert-SeatRegistryLockHeld
        already carries: this record decides which agent owns a seat, so a write against a snapshot
        another seat can invalidate is the same check-then-act the cross-seat Desk scans had.

        A COMMITTED BINDING WHOSE AGENT IS ALIVE IS NOT OVERWRITTEN. That refusal is the whole
        protection, so it lives here rather than in each caller -- and it exempts a rewrite by the
        SAME agent, which is how `pending` becomes `committed` at the end of the handshake.

        IT ALSO WRITES THE CONVERSATION HISTORY, AND THAT IS WHY IT IS HERE RATHER THAN AT THE CALL
        SITES (plan step 8). Four paths commit a binding carrying a conversation -- the creation
        bind, the ordinary enter, the claim holder's commit and Update-SeatConversationRecord's
        rewrite -- and every one of them holds the registry lock this function already asserts.
        Recording at each of them instead is the shape docs/seats.md has already paid for four times:
        one rule, four copies, and the copy that falls behind is silent.

        THE RECORD IS WRITTEN FIRST AND THE BINDING SECOND, deliberately. A crash between them leaves
        a history naming a seat this conversation never bound, which costs the resume lookup one
        offer that the state matrix then decides on -- the record locates and never authorises. The
        other order leaves a bound conversation with no history, which is silent and is precisely the
        defect step 8 exists to close.

        A `pending` BINDING RECORDS NOTHING. It belongs to an attempt that has not committed and
        names a conversation that may never have sat anywhere.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][int]$AgentProcessId,
        [string]$AgentStartUtc,
        [string]$SessionId,
        [string]$SeatId,
        [Parameter(Mandatory = $true)][ValidateSet('pending', 'committed')][string]$State
    )
    Assert-SeatRegistryLockHeld -Workspace $Workspace -Operation 'Writing a seat binding' | Out-Null
    $existing = Read-SeatBinding -StateDirectory $StateDirectory -Seat $Seat
    if ($null -ne $existing -and [string]$existing.state -ceq 'committed') {
        $existingStart = if (@($existing.PSObject.Properties | ForEach-Object { $_.Name }) -ccontains 'agent_start_utc') { [string]$existing.agent_start_utc } else { '' }
        if ((Test-SeatAgentAlive -ProcessId ([int]$existing.agent_pid) -StartUtc $existingStart) -and ([int]$existing.agent_pid -ne $AgentProcessId)) {
            throw ("Seat '$Seat' is bound to agent process $([int]$existing.agent_pid), which is still running. A committed " +
                   'binding is never overwritten while its agent is alive: one agent process holds one seat for the life of ' +
                   'that process. Work at another seat, or wait for that one to end.')
        }
    }
    if ([string]::IsNullOrWhiteSpace($AgentStartUtc)) { $AgentStartUtc = [string](Get-AgentProcessIdentity -ProcessId $AgentProcessId) }
    # THE SEED RUNS AGAINST THE BINDING STILL ON DISK, and it runs for a `pending` write too. The
    # pending write is the one that destroys a pre-step-8 seat's committed record, so seeding only on
    # the committed path would read a binding this function had already overwritten -- measured by
    # running tools/Enter-LibrarySeat.ps1 for real, where the pending write comes first.
    Sync-SeatConversationSeed -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat | Out-Null
    if ($State -ceq 'committed' -and -not [string]::IsNullOrWhiteSpace($SessionId)) {
        $conversationPlan = Get-SeatConversationDocument -StateDirectory $StateDirectory -Seat $Seat `
            -SessionId $SessionId -SeatId $SeatId -Source 'binding'
        Save-SeatConversationDocument -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat `
            -Document $conversationPlan.document | Out-Null
    }
    $record = [ordered]@{
        seat = $Seat
        seat_id = $SeatId
        agent_pid = $AgentProcessId
        agent_start_utc = $AgentStartUtc
        session_id = $SessionId
        bound_utc = [DateTime]::UtcNow.ToString('o')
        state = $State
    }
    $path = Get-SeatBindingPath -StateDirectory $StateDirectory -Seat $Seat
    Write-AtomicText -Path $path -Text (([pscustomobject]$record | ConvertTo-Json -Depth 4) + "`n") | Out-Null
    $path
}

function Remove-SeatBinding {
    <#
    .SYNOPSIS
        Remove a seat's binding. THE CALLER MUST HOLD THE REGISTRY LOCK, and a live agent's
        committed binding is refused.

    .DESCRIPTION
        Retirement archives the binding and a failed creation removes its own provisional one; a
        HOOK never removes one, which is why this is a registry-locked helper rather than a
        file delete at each call site. `-Stale` is the archiving path: it accepts a committed
        binding whose agent is gone, which is the only case in which one may be cleared.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [switch]$Stale
    )
    Assert-SeatRegistryLockHeld -Workspace $Workspace -Operation 'Removing a seat binding' | Out-Null
    $existing = Read-SeatBinding -StateDirectory $StateDirectory -Seat $Seat
    if ($null -eq $existing) { return $false }
    if ([string]$existing.state -ceq 'committed') {
        $existingStart = if (@($existing.PSObject.Properties | ForEach-Object { $_.Name }) -ccontains 'agent_start_utc') { [string]$existing.agent_start_utc } else { '' }
        $alive = Test-SeatAgentAlive -ProcessId ([int]$existing.agent_pid) -StartUtc $existingStart
        if ($alive -and -not $Stale) {
            throw ("Seat '$Seat' is bound to agent process $([int]$existing.agent_pid), which is still running; its binding " +
                   'is not removable. Wait for that agent to end.')
        }
        if ($alive -and $Stale) {
            throw ("Seat '$Seat' has a LIVE agent process $([int]$existing.agent_pid), so its binding is not stale. " +
                   'Nothing was removed.')
        }
    }
    Remove-Item -LiteralPath (Get-SeatBindingPath -StateDirectory $StateDirectory -Seat $Seat) -Force
    $true
}

# --- conversations.json: a history, where the binding is one record (plan step 8) -----------------
#
# WHAT THIS CLOSES, AND IT WAS A KNOWN COST RATHER THAN A DISCOVERY. Until 2026-09-10 the resume
# lookup read the BINDING's own `session_id`. That works -- a binding carries `seat_id` and
# `bound_utc`, and nothing in the shipped code removes a stale one -- but a seat holds ONE binding,
# so a seat re-bound by a different conversation forgot the one before it and resuming that older
# conversation was offered the roster instead of its own seat. Degraded rather than wrong, written
# into docs/seats.md, and this is what turns the record into a history.
#
# NO AUTOMATIC PRUNING (plan step 8, round 2 #10). A transcript not found under the current
# configuration is not a deleted transcript: a different CLAUDE_CONFIG_DIR, a different machine or a
# pruned history all look identical from here, and dropping a record on any of them would throw away
# the one thing that can put a reader back at their seat. The file grows by one record per
# conversation per seat and is archived whole by retirement.
#
# THE RECORD LOCATES; IT NEVER AUTHORISES (ADR-0018, plan step 8 round 3 #5). Everything read out of
# here decides which seat to OFFER. The caller still enters through tools/Enter-LibrarySeat.ps1 and
# meets the operation-by-state matrix exactly as a typed -Seat would, which is why a record written
# by the LAUNCHER -- minted rather than verified -- may sit in the same file as one written by a
# verified binding. `source` says which, and nothing reads it as identity.
#
# WRITTEN ONLY UNDER THE REGISTRY LOCK, which is the difference between this and activity.json. That
# one is advisory, lock-free, replaced whole by every entry, and displays a seat's LAST conversation;
# this one is durable, ordered against every other seat operation, and answers the opposite question
# -- which seats one conversation has sat at. Get-SeatConversationRecord in SeatConversation.ps1
# still derives the display answer from the binding and activity.json, deliberately: that is "which
# conversation was last at THIS seat", a different question with a different newest-record rule.

$script:SeatConversationsSchema = 1

function Get-SeatConversationsPath {
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Seat)
    Join-Path (Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat) 'conversations.json'
}

function Read-SeatConversations {
    <#
    .SYNOPSIS
        A seat's conversation history, or `$null` when it has none. FAILS CLOSED on anything it
        cannot parse, and on a schema this build does not know.

    .DESCRIPTION
        THE SAME REFUSAL Read-SeatBinding AND Read-SeatRegistry ALREADY MAKE, for the same reason: a
        record that is present and unusable is not an absent record, and reporting it as absent would
        say "this conversation has never sat anywhere" about a seat whose file is merely damaged. The
        caller degrades to the roster and says which seat it could not read.

        THE SCHEMA IS CHECKED RATHER THAN CARRIED. A future build that adds a field bumps this
        number, and an older checkout meeting that file refuses instead of dropping the fields it
        does not understand and writing the loss back -- which is how "no automatic pruning" would
        be defeated by an upgrade rather than by a prune.
    #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Seat)
    $path = Get-SeatConversationsPath -StateDirectory $StateDirectory -Seat $Seat
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $raw = $null
    try { $raw = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $path)) }
    catch { throw "The seat conversation record at $path could not be read: $($_.Exception.Message)" }
    $parsed = $null
    try { $parsed = $raw | ConvertFrom-Json }
    catch { throw "The seat conversation record at $path is not valid JSON: $($_.Exception.Message). Remove it to lose this seat's conversation history and keep working; nothing else reads it." }
    $fields = @($parsed.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($required in @('schema', 'conversations')) {
        if ($fields -cnotcontains $required) { throw "The seat conversation record at $path has no '$required' field." }
    }
    $schema = 0
    if (-not [int]::TryParse([string]$parsed.schema, [ref]$schema) -or $schema -ne $script:SeatConversationsSchema) {
        throw ("The seat conversation record at $path declares schema '$([string]$parsed.schema)'; this build writes " +
               "schema $($script:SeatConversationsSchema). A newer Library wrote it -- update this checkout rather than overwriting it.")
    }
    # AN EMPTY COLLECTION UNROLLS TO NOTHING and a hand-edited `null` unrolls to one $null, so neither
    # is read through @() alone. Both mean "no conversations recorded", which is a legal file.
    $entries = @()
    if ($null -ne $parsed.conversations) { $entries = @(@($parsed.conversations) | Where-Object { $null -ne $_ }) }
    $seen = [Collections.Generic.List[string]]::new()
    foreach ($entry in $entries) {
        $entryFields = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
        if ($entryFields -cnotcontains 'session_id' -or [string]::IsNullOrWhiteSpace([string]$entry.session_id)) {
            throw "The seat conversation record at $path holds an entry with no 'session_id'."
        }
        # KEYED BY CONVERSATION ID, asserted on the way IN. Two entries for one conversation would
        # make "the newest record" a coin toss between two rows of the same file.
        if ($seen -ccontains [string]$entry.session_id) {
            throw "The seat conversation record at $path names conversation '$([string]$entry.session_id)' twice."
        }
        [void]$seen.Add([string]$entry.session_id)
    }
    [pscustomobject]@{ schema = $schema; seat = $Seat; conversations = $entries }
}

function Sync-SeatConversationSeed {
    <#
    .SYNOPSIS
        THE DAY-ONE MIGRATION. Give a seat that has no history the one record its committed binding
        already implies. Returns `seeded`, `present` (it has a history) or `nothing` (no binding to
        seed from). THE CALLER MUST HOLD THE REGISTRY LOCK.

    .DESCRIPTION
        WHAT IT PREVENTS, AND IT IS A REGRESSION THIS FEATURE WOULD OTHERWISE HAVE CAUSED. A seat
        bound before `conversations.json` existed carries its conversation only on `binding.json`,
        which is what the resume lookup used to read. The moment anything else sits at that seat the
        binding moves on, and a history that never knew the earlier conversation would leave it
        unresumable -- worse than before step 8, at exactly the seats that were working.

        IT RUNS AT EVERY REGISTRY-LOCKED COMMIT POINT, AND THAT IS NOT BELT-AND-BRACES. Found by
        running the real helper rather than by reasoning about it: `tools/Enter-LibrarySeat.ps1`
        writes a `pending` binding BEFORE it commits the new one, and that write is what destroys the
        committed record being migrated -- so seeding only where a conversation is recorded seeds
        from a binding that has already been overwritten. The recovery path
        (Complete-SeatClaimHolder with no -CommitBinding) writes no binding at all and records no
        conversation, so it too would leave a pre-upgrade seat unmigrated.

        IDEMPOTENT AND BOUNDED. It does nothing once a history exists -- so it never re-adds a
        conversation a later Library removed, and it can never be the thing that keeps a record
        alive. One record, the binding's own, stamped with `bound_utc` rather than now so it sorts
        older than anything recorded on top of it.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat
    )
    # NO ASSERTION OF ITS OWN. Save-SeatConversationDocument below asserts the lock at the write, and
    # every path here that changes anything reaches it -- so a second assertion at this entry would be
    # the redundant guard that keeps a suite green while the load-bearing one is deleted. Found by
    # falsification: removing the entry assertion left the suite green, because the write's assertion
    # answered instead. One check, at the write.
    if (Test-Path -LiteralPath (Get-SeatConversationsPath -StateDirectory $StateDirectory -Seat $Seat) -PathType Leaf) { return 'present' }
    $binding = Read-SeatBinding -StateDirectory $StateDirectory -Seat $Seat
    if ($null -eq $binding) { return 'nothing' }
    $bindingFields = @($binding.PSObject.Properties | ForEach-Object { $_.Name })
    $priorSession = if ($bindingFields -ccontains 'session_id') { [string]$binding.session_id } else { '' }
    if ([string]$binding.state -cne 'committed' -or [string]::IsNullOrWhiteSpace($priorSession)) { return 'nothing' }
    $priorBound = if ($bindingFields -ccontains 'bound_utc') { [string]$binding.bound_utc } else { '' }
    $document = [pscustomobject]@{
        schema = $script:SeatConversationsSchema
        seat = $Seat
        conversations = @([pscustomobject]@{
            session_id     = $priorSession
            seat_id        = if ($bindingFields -ccontains 'seat_id') { [string]$binding.seat_id } else { '' }
            source         = 'binding'
            first_seen_utc = $priorBound
            last_seen_utc  = $priorBound
        })
    }
    Save-SeatConversationDocument -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat -Document $document | Out-Null
    'seeded'
}

function Get-SeatConversationDocument {
    <#
    .SYNOPSIS
        The document this seat's conversation record WOULD become with one conversation recorded on
        it, as {document, outcome}. Pure: it reads, it never writes, and it takes no lock.

    .DESCRIPTION
        SPLIT FROM THE WRITE SO THE BINDING CAN ORDER THE TWO. Write-SeatBinding records a
        conversation as part of committing a binding, and wants the merge computed against state it
        has already read.

        IT MERGES ONTO WHAT IS ON DISK AND SEEDS NOTHING. Migrating a pre-step-8 seat is
        Sync-SeatConversationSeed's job and every caller of this runs it first, under the same lock
        -- because the seed has to happen at commit points this function is not called from at all.
        Two implementations of one migration is how the two come to disagree about which one ran.

        `first_seen_utc` NEVER MOVES AND `last_seen_utc` ALWAYS DOES. The first is what a reader
        would use to ask when a conversation began at a seat; the second is what the resume lookup
        sorts on, and re-recording the same conversation at a seat it has come back to must make it
        the newest again.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][string]$SessionId,
        [string]$SeatId,
        [Parameter(Mandatory = $true)][ValidateSet('binding', 'launcher')][string]$Source
    )
    $existing = Read-SeatConversations -StateDirectory $StateDirectory -Seat $Seat
    $records = [Collections.Generic.List[object]]::new()
    if ($null -ne $existing) {
        foreach ($entry in @($existing.conversations)) { [void]$records.Add($entry) }
    }

    $now = [DateTime]::UtcNow.ToString('o')
    $outcome = 'recorded'
    $merged = [Collections.Generic.List[object]]::new()
    foreach ($entry in $records) {
        if ([string]$entry.session_id -cne $SessionId) { [void]$merged.Add($entry); continue }
        $outcome = 'updated'
        $entryFields = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
        $first = if ($entryFields -ccontains 'first_seen_utc') { [string]$entry.first_seen_utc } else { $now }
        if ([string]::IsNullOrWhiteSpace($first)) { $first = $now }
        [void]$merged.Add([pscustomobject]@{
            session_id     = $SessionId
            seat_id        = $SeatId
            source         = $Source
            first_seen_utc = $first
            last_seen_utc  = $now
        })
    }
    if ($outcome -ceq 'recorded') {
        [void]$merged.Add([pscustomobject]@{
            session_id = $SessionId; seat_id = $SeatId; source = $Source
            first_seen_utc = $now; last_seen_utc = $now
        })
    }
    # OLDEST FIRST ON DISK, so a file read by eye tells the seat's story in order and two runs that
    # recorded the same conversations produce the same bytes. The lookup sorts for itself.
    $ordered = @(@($merged) | Sort-Object -Property @{ Expression = { [string]$_.last_seen_utc } })
    [pscustomobject]@{
        outcome  = $outcome
        document = [pscustomobject]@{ schema = $script:SeatConversationsSchema; seat = $Seat; conversations = $ordered }
    }
}

function Save-SeatConversationDocument {
    <# Replace a seat's conversation record atomically. THE CALLER MUST HOLD THE REGISTRY LOCK. #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][object]$Document
    )
    Assert-SeatRegistryLockHeld -Workspace $Workspace -Operation 'Writing a seat conversation record' | Out-Null
    $path = Get-SeatConversationsPath -StateDirectory $StateDirectory -Seat $Seat
    Write-AtomicText -Path $path -Text (($Document | ConvertTo-Json -Depth 5) + "`n") | Out-Null
    $path
}

function Write-SeatConversationRecord {
    <#
    .SYNOPSIS
        Record one conversation as having sat at one seat. THE CALLER MUST HOLD THE REGISTRY LOCK.
        Returns `recorded`, `updated`, `no-conversation` or `no-desk`.

    .DESCRIPTION
        THE ROUTE FOR AN ENTRY THAT WRITES NO BINDING, which is the launcher and only the launcher: it
        holds the claim handle itself, so the agent inside it is refused a binding by the
        `enter`/`held` row of the matrix, deliberately. It mints the id it passes to
        `claude --session-id`, so it is the one process that knows which conversation is sitting
        there. Every other route commits a binding, and Write-SeatBinding records from there.

        A SEAT WITH NO DESK DIRECTORY IS NOT AN ERROR HERE. Write-SeatActivity already answers that
        way, and the two are called from the same places.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [string]$SessionId,
        [string]$SeatId,
        [Parameter(Mandatory = $true)][ValidateSet('binding', 'launcher')][string]$Source
    )
    # THE LOCK IS ASSERTED AT THE WRITE, NOT HERE, for Sync-SeatConversationSeed's reason: a second
    # assertion at this entry is what shadowed the falsification of the real one. The two early
    # returns below write nothing, so an unlocked caller reaching either has changed nothing either.
    if ([string]::IsNullOrWhiteSpace($SessionId)) { return 'no-conversation' }
    if (-not (Test-Path -LiteralPath (Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat) -PathType Container)) { return 'no-desk' }
    Sync-SeatConversationSeed -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat | Out-Null
    $plan = Get-SeatConversationDocument -StateDirectory $StateDirectory -Seat $Seat -SessionId $SessionId -SeatId $SeatId -Source $Source
    Save-SeatConversationDocument -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat -Document $plan.document | Out-Null
    [string]$plan.outcome
}

function Get-SeatsForConversation {
    <#
    .SYNOPSIS
        WHICH SEATS THIS CONVERSATION HAS SAT AT, newest first, as {seat, seat_id, source,
        first_seen_utc, last_seen_utc}. A read: no lock, changes nothing. The lookup a resumed
        session's SessionStart hook makes before it re-binds anything.

    .DESCRIPTION
        IT REPLACED Get-SeatBindingForConversation ON 2026-09-10 (plan step 8), which answered the
        same question off the binding and could therefore remember only the conversation currently
        bound at each seat. Nothing reads the binding for this any more: one question, one source.

        IT DOES NOT VERIFY LIVENESS AND MUST NOT. The whole point is to find a seat whose agent is
        GONE -- a hibernated conversation's own -- so the caller reads the state separately and
        decides from Get-SeatClaimState, which is where `free`, `held` and `orphaned` are worded.

        A FAULT IS NOT SWALLOWED. Read-SeatConversations throws on a record it cannot parse, and
        catching that here would report "this conversation has never sat anywhere" for a seat whose
        file is merely unreadable -- absence standing in for a fault, which is the reading this file
        refuses everywhere else. The caller degrades to the roster and says what it could not read.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$SessionId
    )
    if ([string]::IsNullOrWhiteSpace($SessionId)) { return @() }
    $found = [Collections.Generic.List[object]]::new()
    foreach ($seatName in @(Get-SeatDirectoryNames -StateDirectory $StateDirectory)) {
        $record = Read-SeatConversations -StateDirectory $StateDirectory -Seat $seatName
        if ($null -eq $record) { continue }
        foreach ($entry in @($record.conversations)) {
            if ([string]$entry.session_id -cne $SessionId) { continue }
            $entryFields = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
            [void]$found.Add([pscustomobject]@{
                seat           = $seatName
                seat_id        = if ($entryFields -ccontains 'seat_id') { [string]$entry.seat_id } else { '' }
                source         = if ($entryFields -ccontains 'source') { [string]$entry.source } else { '' }
                first_seen_utc = if ($entryFields -ccontains 'first_seen_utc') { [string]$entry.first_seen_utc } else { '' }
                last_seen_utc  = if ($entryFields -ccontains 'last_seen_utc') { [string]$entry.last_seen_utc } else { '' }
            })
        }
    }
    # NEWEST FIRST, by when the conversation was last recorded at each seat. A conversation resumed in
    # two processes sat at two seats legitimately (D9), so the caller takes the first and MENTIONS the
    # rest rather than picking silently.
    @(@($found) | Sort-Object -Property @{ Expression = { [string]$_.last_seen_utc }; Descending = $true })
}

function Update-SeatConversationRecord {
    <#
    .SYNOPSIS
        Record which conversation is sitting at a seat this agent already holds. Returns what it
        did: `recorded`, `already-recorded`, `no-conversation`, `not-this-agent` or `no-binding`.
        Takes the registry lock ONLY when there is something to write.

    .DESCRIPTION
        WHY THIS IS ONE FUNCTION AND NOT THREE CALL SITES. Three places have to answer "is this
        conversation on record at this seat, and if not, put it there": the SessionStart hook's bound
        rows, the Desk context hook's backstop on every prompt, and `Enter-LibrarySeat.ps1`'s
        already-bound no-op. Three copies of "when may a binding be rewritten" is the shape this
        repository has paid for four times in docs/seats.md alone.

        IT WRITES THE BINDING, AND THE BINDING WRITES THE HISTORY. The binding's `session_id` is
        which conversation is sitting here NOW, which is what the two guards and both hooks read;
        `conversations.json` is every conversation that has sat here, which is what a resume looks
        itself up in (plan step 8, landed 2026-09-10). Write-SeatBinding records the second from the
        first under the lock this function detects, so there is one write here and one rule there.

        THE READ IS OUTSIDE THE LOCK AND THE WRITE IS INSIDE IT. The common case, on every prompt of
        every bound session, is a binding that already names this conversation -- that case must cost
        one file read and must never touch an ordered lock. The re-read under the lock is what makes
        the write safe; the read outside it is only a filter.

        IT REWRITES NOTHING BUT THIS AGENT'S OWN COMMITTED BINDING. Write-SeatBinding's protection
        exempts a rewrite by the same agent, which is what makes this legal at all; every other case
        returns a reason and writes nothing. A binding naming a different agent, a `pending` binding,
        and an agent whose recorded start time no longer matches are each refused here rather than
        being handed to a writer that would have to refuse them.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][int]$AgentProcessId,
        [string]$SessionId,
        [double]$DeadlineSeconds = 2
    )
    if ([string]::IsNullOrWhiteSpace($SessionId)) { return 'no-conversation' }

    function Test-BindingIsThisAgent($Binding, [int]$Agent) {
        if ($null -eq $Binding) { return $false }
        if ([string]$Binding.state -cne 'committed') { return $false }
        if ([int]$Binding.agent_pid -ne $Agent) { return $false }
        $names = @($Binding.PSObject.Properties | ForEach-Object { $_.Name })
        $startUtc = if ($names -ccontains 'agent_start_utc') { [string]$Binding.agent_start_utc } else { '' }
        Test-SeatAgentAlive -ProcessId $Agent -StartUtc $startUtc
    }
    function Get-BindingField($Binding, [string]$Name) {
        $names = @($Binding.PSObject.Properties | ForEach-Object { $_.Name })
        if ($names -cnotcontains $Name) { return '' }
        [string]$Binding.$Name
    }

    $binding = Read-SeatBinding -StateDirectory $StateDirectory -Seat $Seat
    if ($null -eq $binding) { return 'no-binding' }
    if (-not (Test-BindingIsThisAgent $binding $AgentProcessId)) { return 'not-this-agent' }
    if ((Get-BindingField $binding 'session_id') -ceq $SessionId) { return 'already-recorded' }

    # THE LOCK IS DETECTED, NEVER DECLARED, which is the same call Set-NotebookTopicOwner makes and
    # for the same reason: Enter-LibrarySeat.ps1 calls this from INSIDE its own registry-locked
    # transaction, and Enter-BookLock is not re-entrant, so a -LockHeld switch a caller could pass
    # wrongly would be a deadlock against its own parent. The lock primitive's in-process ledger
    # answers the question directly.
    $alreadyHeld = Test-SeatRegistryLockHeld -Workspace $Workspace
    $lock = if ($alreadyHeld) { $null } else { Enter-SeatRegistryLock -Workspace $Workspace -TimeoutSeconds ([int][Math]::Ceiling($DeadlineSeconds)) }
    try {
        # RE-READ UNDER THE LOCK. The filter above ran against a snapshot another seat's operation
        # could have invalidated -- a retirement, or this agent's own binding being archived as stale.
        # THE RE-READ CHECKS WHO, AND DELIBERATELY NOT WHICH CONVERSATION. A second session
        # comparison here would be unfalsifiable by construction: it is reachable only when the
        # binding changed between the filter above and this line, a race no test can stage, and its
        # entire effect would be to skip a rewrite that is IDEMPOTENT anyway -- the same session id
        # with a fresher timestamp. That is the shape this repository has already paid for twice, a
        # second check over one property keeping the suite green while the load-bearing one is
        # deleted. There is one comparison per property: the conversation above, the agent here.
        $current = Read-SeatBinding -StateDirectory $StateDirectory -Seat $Seat
        if ($null -eq $current) { return 'no-binding' }
        if (-not (Test-BindingIsThisAgent $current $AgentProcessId)) { return 'not-this-agent' }
        Write-SeatBinding -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat `
            -AgentProcessId $AgentProcessId -AgentStartUtc (Get-BindingField $current 'agent_start_utc') `
            -SessionId $SessionId -SeatId (Get-BindingField $current 'seat_id') -State 'committed' | Out-Null
        'recorded'
    }
    finally { if ($null -ne $lock) { Exit-BookLock -Lock $lock } }
}

# --- The holder attempt, and the readiness handshake (ADR-0018, PLAN-seat-launch.md step 4) -------
#
# WHY AN ATTEMPT IS A RECORD AND NOT A FUNCTION CALL. A claim is an open file handle, and the process
# that must hold it is not the process that decides to. A helper invoked from a Claude tool call
# lives for a second; the agent it is binding lives for hours. So the helper SPAWNS a holder and then
# has to answer a question it cannot answer from the handle alone: is this handle MINE? A live handle
# proves somebody holds the seat. The attempt id proves it is the process this helper just started,
# and not one a previous, timed-out attempt left behind.
#
# EVERY LAUNCH IS SELF-ABANDONING. The attempt carries its own deadline, and the holder polls its own
# record: if the deadline passes with the record still `pending`, or the record is `abandoned` or
# gone, the holder releases the handle and exits. That is what makes a helper killed mid-handshake
# safe -- without it, a holder whose parent died would hold a seat nobody could release (round 3, #3).
#
# THE HELPER HOLDS THE REGISTRY LOCK ACROSS THE WAIT, and that is deliberate rather than overlooked.
# The alternative is committing a binding against a snapshot another seat can invalidate, which is the
# check-then-act the cross-seat Desk scans already paid for. The cost is bounded and was measured
# (step 0d, 2026-09-09): a real Desk write holds this lock for well under a millisecond, and a seat
# entry happens once per conversation, so a ~2 second worst case at entry is not a latency the other
# seats can feel.

$script:SeatHolderAttemptFileName = 'holder-attempt.json'
$script:SeatHolderAttemptStates = @('pending', 'committed', 'abandoned')

function Get-SeatHolderAttemptPath {
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Seat)
    Join-Path (Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat) $script:SeatHolderAttemptFileName
}

function Read-SeatHolderAttempt {
    <#
    .SYNOPSIS
        A seat's holder attempt, or `$null`. LOCK-FREE ON PURPOSE, and FAILS CLOSED on anything it
        cannot parse.

    .DESCRIPTION
        THE HOLDER READS THIS WHILE THE HELPER HOLDS THE REGISTRY LOCK, so it must take no lock of its
        own: a holder that waited for the registry lock would wait for the very helper that is waiting
        for it. That deadlock is the same shape the claim probe's non-blocking rule exists to prevent,
        and it is why this is a read and the writers below are not.

        An unparseable attempt throws rather than reading as absent, for Read-SeatBinding's reason:
        absent means "abandon", and abandoning on a record we simply could not read would release a
        handle whose attempt may well have committed.
    #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Seat)
    $path = Get-SeatHolderAttemptPath -StateDirectory $StateDirectory -Seat $Seat
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $raw = $null
    try { $raw = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $path)) }
    catch { throw "The holder attempt at $path could not be read: $($_.Exception.Message)" }
    $parsed = $null
    try { $parsed = $raw | ConvertFrom-Json }
    catch { throw "The holder attempt at $path is not valid JSON: $($_.Exception.Message)." }
    $fields = @($parsed.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($required in @('attempt_id', 'state', 'deadline_utc')) {
        if ($fields -cnotcontains $required) { throw "The holder attempt at $path has no '$required' field." }
    }
    if ([string]$parsed.state -cnotin $script:SeatHolderAttemptStates) {
        throw "The holder attempt at $path has state '$([string]$parsed.state)'; expected one of $($script:SeatHolderAttemptStates -join ', ')."
    }
    $parsed
}

function Write-SeatHolderAttempt {
    <# Write a seat's holder attempt atomically. THE CALLER MUST HOLD THE REGISTRY LOCK. #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][string]$AttemptId,
        [Parameter(Mandatory = $true)][string]$DeadlineUtc,
        [Parameter(Mandatory = $true)][ValidateSet('pending', 'committed', 'abandoned')][string]$State,
        [int]$HolderProcessId = 0,
        [string]$StartedUtc
    )
    Assert-SeatRegistryLockHeld -Workspace $Workspace -Operation 'Writing a seat holder attempt' | Out-Null
    if ([string]::IsNullOrWhiteSpace($StartedUtc)) { $StartedUtc = [DateTime]::UtcNow.ToString('o') }
    $record = [ordered]@{
        seat         = $Seat
        attempt_id   = $AttemptId
        holder_pid   = $HolderProcessId
        started_utc  = $StartedUtc
        deadline_utc = $DeadlineUtc
        state        = $State
    }
    $path = Get-SeatHolderAttemptPath -StateDirectory $StateDirectory -Seat $Seat
    Write-AtomicText -Path $path -Text (([pscustomobject]$record | ConvertTo-Json -Depth 4) + "`n") | Out-Null
    $path
}

function Remove-SeatHolderAttempt {
    <#
    .SYNOPSIS
        Remove a seat's holder attempt. THE CALLER MUST HOLD THE REGISTRY LOCK, and a LIVE handle is
        refused unless -Force.

    .DESCRIPTION
        The record is what tells a holder to let go, so removing it under a live handle destroys the
        only instruction that holder is listening for. The abort path marks the attempt `abandoned`,
        waits for the handle to read free, and removes it only then.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [switch]$Force
    )
    Assert-SeatRegistryLockHeld -Workspace $Workspace -Operation 'Removing a seat holder attempt' | Out-Null
    $path = Get-SeatHolderAttemptPath -StateDirectory $StateDirectory -Seat $Seat
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    if (-not $Force -and (Test-SeatClaim -StateDirectory $StateDirectory -Seat $Seat)) {
        throw ("Seat '$Seat' has a LIVE claim handle, so its holder attempt is not removable: that record is the " +
               'only thing telling the holder to let go. Mark the attempt abandoned and wait for the handle to close.')
    }
    Remove-Item -LiteralPath $path -Force
    $true
}

function Get-SeatClaimHolderPath {
    <# The holder script, named once so the spawn and the gate read the same path. #>
    Join-Path $PSScriptRoot 'Invoke-SeatClaimHolder.ps1'
}

function Start-SeatClaimHolder {
    <#
    .SYNOPSIS
        Spawn a claim holder for one seat and wait for it to have the handle. THE CALLER MUST HOLD THE
        REGISTRY LOCK. Returns the attempt on success; throws having cleaned up on failure.

    .DESCRIPTION
        A PLAIN Start-Process IS ENOUGH, MEASURED RATHER THAN ASSUMED (step 0a, 2026-09-09). A child
        spawned from either Claude Code tool path survives the call that spawned it, and a holder
        spawned by a middle process survived that process being force-killed. The PowerShell tool runs
        inside a job object and the Bash tool does not, but the job does not carry kill-on-close -- so
        no CREATE_BREAKAWAY_FROM_JOB, and no fallback to the launcher route.

        THE RECORD IS WRITTEN BEFORE THE SPAWN, because a missing record means ABANDON to the holder,
        and a holder that started before its record existed would read "gone" and let go immediately.
        `holder_pid` is filled in afterwards, still under the lock and still `pending`: the holder
        reads only `state` and `deadline_utc`, so learning its own PID late changes nothing for it.

        WHAT COUNTS AS READY IS THE ATTEMPT ID, NOT THE HANDLE. A live handle proves somebody holds the
        seat; only the attempt id in the claim file proves it is the holder this call spawned.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][int]$AgentProcessId,
        [Parameter(Mandatory = $true)][string]$AgentStartUtc,
        # Step 0d measured the registry lock refusing at 2108 ms against a holder past its deadline, so
        # a two-second handshake degrades to a refusal rather than to a blocked reader.
        [double]$DeadlineSeconds = 2
    )
    Assert-SeatRegistryLockHeld -Workspace $Workspace -Operation 'Starting a seat claim holder' | Out-Null
    $attemptId = [guid]::NewGuid().ToString('N')
    $deadline = [DateTime]::UtcNow.AddSeconds($DeadlineSeconds)
    $deadlineUtc = $deadline.ToString('o')
    Write-SeatHolderAttempt -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat `
        -AttemptId $attemptId -DeadlineUtc $deadlineUtc -State 'pending' | Out-Null

    $holderScript = Get-SeatClaimHolderPath
    if (-not (Test-Path -LiteralPath $holderScript -PathType Leaf)) {
        Remove-SeatHolderAttempt -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat -Force | Out-Null
        throw "The claim holder script is missing at $holderScript; a seat cannot be bound without it."
    }
    $holder = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $holderScript,
        '-WorkspacePath', $Workspace, '-Seat', $Seat, '-AttemptId', $attemptId,
        '-AgentProcessId', ([string]$AgentProcessId), '-AgentStartUtc', $AgentStartUtc)
    Write-SeatHolderAttempt -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat `
        -AttemptId $attemptId -DeadlineUtc $deadlineUtc -State 'pending' -HolderProcessId ([int]$holder.Id) | Out-Null

    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ((Test-SeatClaim -StateDirectory $StateDirectory -Seat $Seat) -and
            (Get-SeatClaimAttemptId -StateDirectory $StateDirectory -Seat $Seat) -ceq $attemptId) { $ready = $true; break }
        if ($holder.HasExited) { break }
        Start-Sleep -Milliseconds 40
    }

    if (-not $ready) {
        # THE ABORT, IN THIS ORDER. Mark the attempt abandoned FIRST -- that is the instruction a
        # holder still starting up will read -- then wait, bounded, for the handle to close, and only
        # then remove the record. Removing it first would take away the instruction.
        Write-SeatHolderAttempt -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat `
            -AttemptId $attemptId -DeadlineUtc $deadlineUtc -State 'abandoned' -HolderProcessId ([int]$holder.Id) | Out-Null
        $freeBy = [DateTime]::UtcNow.AddSeconds($DeadlineSeconds)
        while ([DateTime]::UtcNow -lt $freeBy) {
            if (-not (Test-SeatClaim -StateDirectory $StateDirectory -Seat $Seat)) { break }
            Start-Sleep -Milliseconds 40
        }
        if (-not (Test-SeatClaim -StateDirectory $StateDirectory -Seat $Seat)) {
            Remove-SeatHolderAttempt -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat | Out-Null
        }
        throw ("The claim holder for seat '$Seat' did not take the seat's handle within $DeadlineSeconds second(s), so " +
               'nothing was bound. The attempt is marked abandoned and the holder releases itself; try again, or start ' +
               "work at the seat from a terminal with tools/Start-LibrarySeat.ps1 -Seat $Seat.")
    }

    [pscustomobject]@{
        attempt_id   = $attemptId
        holder_pid   = [int]$holder.Id
        deadline_utc = $deadlineUtc
        token        = (Get-SeatClaimToken -StateDirectory $StateDirectory -Seat $Seat)
    }
}

function Complete-SeatClaimHolder {
    <#
    .SYNOPSIS
        Commit a readied attempt. THE CALLER MUST HOLD THE REGISTRY LOCK, and the ORDER IS THE POINT.

    .DESCRIPTION
        THE BINDING COMMITS FIRST AND THE ATTEMPT SECOND (round 4 of review, and it is the only thing
        round 4 found). A helper that dies between the two writes leaves a committed binding whose
        holder never sees its attempt committed -- so the holder abandons itself at its deadline, the
        seat reads `orphaned`, and the same agent's Enter repairs it, which is a row the matrix already
        has. The reverse order leaves a permanently held handle over a binding nothing can repair,
        because a committed attempt tells the holder to hold forever while the absent binding means no
        Enter can recognise the agent that would fix it.

        Recovery from an orphan passes no binding: a committed binding is never rewritten while its
        agent is alive, and rewriting it is exactly what recovery must not do (round 3, #2).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][object]$Attempt,
        [int]$AgentProcessId = 0,
        [string]$AgentStartUtc,
        [string]$SessionId,
        [string]$SeatId,
        [switch]$CommitBinding
    )
    Assert-SeatRegistryLockHeld -Workspace $Workspace -Operation 'Committing a seat claim holder' | Out-Null
    if ($CommitBinding) {
        Write-SeatBinding -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat `
            -AgentProcessId $AgentProcessId -AgentStartUtc $AgentStartUtc -SessionId $SessionId -SeatId $SeatId `
            -State 'committed' | Out-Null
    }
    else {
        # RECOVERY WRITES NO BINDING AND RECORDS NO CONVERSATION, so it is the one commit point that
        # would leave a pre-step-8 seat unmigrated: its committed binding survives untouched and
        # nothing else here reads it. The seed is idempotent and does nothing at a seat that already
        # has a history, which is every seat but that one.
        Sync-SeatConversationSeed -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat | Out-Null
    }
    Write-SeatHolderAttempt -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat `
        -AttemptId ([string]$Attempt.attempt_id) -DeadlineUtc ([string]$Attempt.deadline_utc) `
        -State 'committed' -HolderProcessId ([int]$Attempt.holder_pid) | Out-Null
    $true
}

function Stop-SeatClaimHolder {
    <#
    .SYNOPSIS
        Abandon a readied attempt and wait for its handle to close. THE CALLER MUST HOLD THE REGISTRY
        LOCK. Used by the creation abort, which must not leave a handle over a seat it is deleting.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][object]$Attempt,
        [double]$DeadlineSeconds = 5
    )
    Assert-SeatRegistryLockHeld -Workspace $Workspace -Operation 'Abandoning a seat claim holder' | Out-Null
    Write-SeatHolderAttempt -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat `
        -AttemptId ([string]$Attempt.attempt_id) -DeadlineUtc ([string]$Attempt.deadline_utc) `
        -State 'abandoned' -HolderProcessId ([int]$Attempt.holder_pid) | Out-Null
    $freeBy = [DateTime]::UtcNow.AddSeconds($DeadlineSeconds)
    while ([DateTime]::UtcNow -lt $freeBy) {
        if (-not (Test-SeatClaim -StateDirectory $StateDirectory -Seat $Seat)) { break }
        Start-Sleep -Milliseconds 40
    }
    $free = -not (Test-SeatClaim -StateDirectory $StateDirectory -Seat $Seat)
    if ($free) { Remove-SeatHolderAttempt -Workspace $Workspace -StateDirectory $StateDirectory -Seat $Seat | Out-Null }
    $free
}

function Get-SeatClaimState {
    <#
    .SYNOPSIS
        `free`, `held` or `orphaned` for one seat, with the agent identity behind the answer.

    .DESCRIPTION
        THE THIRD STATE IS THE POINT. Until now a seat was claimed or not, and a claim holder that
        died while its agent kept running read as "not claimed" -- so the seat looked free, another
        agent could take it, and the live agent's mutations would start refusing with a message about
        somebody else's session. That state has a name now and a remedy of its own:

            free       no live handle, and no committed binding with a living agent
            held       a live claim handle
            orphaned   no live handle, a COMMITTED binding, and its agent still alive

        A `pending` binding leaves a seat FREE: it is provisional state belonging to an attempt that
        has not committed, and treating it as occupancy would let a crashed attempt hold a seat
        forever.

        A COMMITTED BINDING WHOSE AGENT IS GONE IS STALE, and reads `free`. It is archived by the
        next registry-locked operation that touches the seat, never by a hook and never by this
        read: a function every hook and every overview calls must take no lock and change nothing.

        TEST-SEATCLAIM STAYS BOOLEAN AND IS NOT REPLACED. In Windows PowerShell 5.1 every non-empty
        string converts to `$true`, so returning 'free' from the existing Boolean function would make
        every `-not (Test-SeatClaim ...)` in the repository stop detecting a free seat -- a silent
        inversion in the launcher, retirement, the overview and the reset's remedy text at once.
        Measured by Codex in round 2 of review. Each decision migrates to an explicit comparison on
        this function instead.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        # This process's own agent, so a caller can ask "is that ME?" -- supplied explicitly by
        # fixtures and by any caller that resolved it another way.
        [int]$AgentProcessId = -1
    )
    if ($AgentProcessId -lt 0) { $AgentProcessId = Get-CurrentAgentProcessId }
    $binding = Read-SeatBinding -StateDirectory $StateDirectory -Seat $Seat
    $bindingState = $null
    $bindingPid = 0
    $bindingStart = ''
    $sessionId = $null
    $seatId = $null
    $boundUtc = ''
    if ($null -ne $binding) {
        $fields = @($binding.PSObject.Properties | ForEach-Object { $_.Name })
        $bindingState = [string]$binding.state
        $bindingPid = [int]$binding.agent_pid
        if ($fields -ccontains 'agent_start_utc') { $bindingStart = [string]$binding.agent_start_utc }
        if ($fields -ccontains 'session_id') { $sessionId = [string]$binding.session_id }
        if ($fields -ccontains 'seat_id') { $seatId = [string]$binding.seat_id }
        # WHEN THE SEAT WAS BOUND, carried since 2026-09-10 so the Desk overview's own line can say
        # it (plan step 14). Read HERE rather than by a second Read-SeatBinding at the call site: the
        # overview already comments that two reads of one seat's state could disagree, and a bind
        # time taken from a different read than the pid beside it is exactly that disagreement.
        if ($fields -ccontains 'bound_utc') { $boundUtc = [string]$binding.bound_utc }
    }
    $committed = ($bindingState -ceq 'committed')
    $agentAlive = $committed -and (Test-SeatAgentAlive -ProcessId $bindingPid -StartUtc $bindingStart)
    $handleLive = Test-SeatClaim -StateDirectory $StateDirectory -Seat $Seat

    $state = 'free'
    if ($handleLive) { $state = 'held' }
    elseif ($agentAlive) { $state = 'orphaned' }

    [pscustomobject]@{
        seat = $Seat
        state = $state
        binding_state = $bindingState
        agent_pid = $bindingPid
        agent_start_utc = $bindingStart
        bound_utc = $boundUtc
        session_id = $sessionId
        seat_id = $seatId
        # Whether the binding names THIS process's agent. False whenever either side is unknown,
        # which is what keeps an unbound seat behaving exactly as it did before bindings existed.
        #
        # $agentAlive IS PART OF THE ANSWER AND WAS NOT UNTIL 2026-09-09 (plan step 6). It compares
        # the RECORDED start time against the process now at that PID, so a reused PID -- the same
        # number, a different process -- reports false here instead of inheriting the binding.
        # Without it, a recycled PID arriving while another agent legitimately HELD the seat read as
        # the same agent and was admitted by Assert-SeatClaimHeld below: identity by number alone,
        # which is exactly what recording a start time exists to prevent.
        this_agent = ($committed -and $agentAlive -and $AgentProcessId -gt 0 -and $bindingPid -eq $AgentProcessId)
        # A committed binding whose agent is gone. Reported so the next registry-locked operation can
        # archive it; never acted on by this read.
        binding_stale = ($committed -and -not $agentAlive)
    }
}

function Get-SeatStateMatrix {
    <#
    .SYNOPSIS
        ONE table governing what each operation does in each claim state, declared once so the gate
        can pin it and every consumer can read it instead of re-deriving it.

    .DESCRIPTION
        Rows are `operation`, `state`, `same_agent`, `decision`. `same_agent` is `$null` where the
        decision does not depend on it.

        RETIREMENT AND MUTATION ARE DIFFERENT ROWS, and round 3 of review is why. A mutator acts
        FROM a seat and is authorised by that seat's held claim; retirement acts ON a seat and is
        authorised by that seat being idle. One combined row either refused every legitimate reset or
        let a foreign seat's mere freeness widen a whole-tree reset past retirement.

        A WHOLE-TREE RESET'S OTHER SEATS ARE ON NO ROW HERE, deliberately, and the `sweep` rows
        below are not that row. ADR-0016 admits only explicitly retired seats, whatever their
        liveness, so liveness is not the question `-WholeTree` asks -- and putting it on this table
        would invite a future reader to answer it from here. That warning is unchanged, and it is now
        ENFORCED rather than written: `seat.resolution-contract` pins this table's operation set at
        exactly the four below, so a `reset-whole-tree` row goes red there and sends its author back
        to ADR-0016 before it can be read as an answer.

        `sweep` IS A DIFFERENT OPERATION, NOT THE SAME QUESTION ASKED AGAIN (ADR-0023). It acts ON a
        foreign seat's Notebook topics and is authorised by that seat being idle -- the rule
        Set-NotebookTopicOwner has enforced since 2026-09-09 for the one-topic reassignment route,
        which ADR-0016's own refusal text points the reader at. It widens no whole-tree reset: a
        RETIRED incarnation stays -WholeTree's alone and an UNACCOUNTED one stays refused, and
        neither is decidable from a claim state at all -- which is why Get-SeatSweepDisposition asks
        the incarnation question BEFORE it probes.

        AND `skip` IS NOT `refuse`. A refused operation stops and changes nothing; a sweep names the
        seat it skipped and carries on, because one busy seat must not cancel "clear every idle
        seat". One word for both would leave a reader unable to tell a disclosure from an abort.
    #>
    @(
        # Entering a seat: the launcher today, tools/Enter-LibrarySeat.ps1 when step 7 lands.
        [pscustomobject]@{ operation = 'enter';  state = 'free';     same_agent = $null; decision = 'allow' }
        [pscustomobject]@{ operation = 'enter';  state = 'held';     same_agent = $true;  decision = 'no-op' }
        [pscustomobject]@{ operation = 'enter';  state = 'held';     same_agent = $false; decision = 'refuse' }
        [pscustomobject]@{ operation = 'enter';  state = 'orphaned'; same_agent = $true;  decision = 'restore' }
        [pscustomobject]@{ operation = 'enter';  state = 'orphaned'; same_agent = $false; decision = 'refuse' }
        # Every claim-gated mutator, reset included, at the seat it is acting FROM.
        [pscustomobject]@{ operation = 'mutate'; state = 'free';     same_agent = $null; decision = 'refuse' }
        [pscustomobject]@{ operation = 'mutate'; state = 'held';     same_agent = $true;  decision = 'allow' }
        [pscustomobject]@{ operation = 'mutate'; state = 'held';     same_agent = $false; decision = 'refuse' }
        [pscustomobject]@{ operation = 'mutate'; state = 'orphaned'; same_agent = $true;  decision = 'refuse' }
        [pscustomobject]@{ operation = 'mutate'; state = 'orphaned'; same_agent = $false; decision = 'refuse' }
        # Retiring the seat named as the TARGET.
        [pscustomobject]@{ operation = 'retire'; state = 'free';     same_agent = $null; decision = 'allow' }
        [pscustomobject]@{ operation = 'retire'; state = 'held';     same_agent = $null; decision = 'refuse' }
        [pscustomobject]@{ operation = 'retire'; state = 'orphaned'; same_agent = $null; decision = 'refuse' }
        # Sweeping the Notebook topics of a seat named as the TARGET, without retiring it (ADR-0023).
        # Same shape as retirement -- it acts ON a seat, so `same_agent` is not the question -- and a
        # different answer in the two non-free states: retirement refuses outright, a sweep skips
        # that seat and keeps going.
        [pscustomobject]@{ operation = 'sweep';  state = 'free';     same_agent = $null; decision = 'allow' }
        [pscustomobject]@{ operation = 'sweep';  state = 'held';     same_agent = $null; decision = 'skip' }
        [pscustomobject]@{ operation = 'sweep';  state = 'orphaned'; same_agent = $null; decision = 'skip' }
    )
}

function Get-SeatStateDecision {
    <#
    .SYNOPSIS
        What the matrix says for one operation, state and same-agent answer. Throws on a combination
        the table does not cover, rather than guessing at a default.
    #>
    param(
        [Parameter(Mandatory = $true)][ValidateSet('enter', 'mutate', 'retire', 'sweep')][string]$Operation,
        [Parameter(Mandatory = $true)][ValidateSet('free', 'held', 'orphaned')][string]$State,
        [bool]$SameAgent = $false
    )
    foreach ($row in @(Get-SeatStateMatrix)) {
        if ([string]$row.operation -cne $Operation) { continue }
        if ([string]$row.state -cne $State) { continue }
        if ($null -ne $row.same_agent -and [bool]$row.same_agent -ne $SameAgent) { continue }
        return [string]$row.decision
    }
    throw "No seat-state rule covers operation '$Operation' in state '$State' (same agent: $SameAgent). Add the row to Get-SeatStateMatrix rather than defaulting."
}

function Get-SeatSweepDisposition {
    <#
    .SYNOPSIS
        May a sweep take this ownership row's Notebook topic, and if not, which rule says no
        (ADR-0023)? One row in, one answer out, total over every row a Notebook can produce.

    .DESCRIPTION
        THE ORDER OF THE TESTS IS THE RULING, not an implementation detail.

            acting incarnation       allow  `acting-seat`              its own held claim authorises it
            retired incarnation      skip   `retired-incarnation`      -WholeTree's alone (ADR-0016)
            unaccounted incarnation  skip   `unaccounted-incarnation`  nothing can say it is finished
            claim state free         allow  `idle`                     nobody is writing it
            claim state held         skip   `live-session`             somebody is working there now
            claim state orphaned     skip   `lost-holder`              the agent is still running

        THE INCARNATION QUESTION COMES BEFORE THE PROBE, AND THAT ORDERING IS THE GUARD. A claim
        state answers about a SLUG; an ownership row names a slug AND an incarnation (ADR-0018). A
        seat retired and created again under the same name is a different seat, so a predicate that
        probed first would read the NEW seat's idleness and sweep the OLD one's topics -- silently
        widening -WholeTree for every retired row, and for an unaccounted row reopening the hole
        closed on 2026-09-10, where a hand-deleted seat directory made another seat's material
        eligible with no refusal at all. Neither case is decidable from a claim state.

        THE ACTING SEAT IS ANSWERED FIRST AND IS NEVER PROBED. Its own incarnation is held by the
        session doing the sweeping, so a matrix consult would read `held` and skip the one seat whose
        claim IS the authorisation -- that is the `mutate` row, not the `sweep` row. `claim_state`
        comes back `not-probed` rather than an assumed 'held', because a field that reports what a
        probe found must never carry a value no probe produced.

        A DISTINCT REASON PER RULE, never one shared silence. A preflight has to be able to say which
        rule left a topic alone, and `held` and `orphaned` need different words to the reader. The
        note beside each is the sentence a preflight shows; it lives here rather than at the call
        site so the sweep and this table cannot come to disagree about why.

        TAKES NO LOCK, AND TAKES THE REGISTRY AND THE ARCHIVE FROM ITS CALLER. Both are passed in so
        one sweep reads them once, and so this keeps the lock-free shape Get-SeatIncarnationStatus
        already has. The DECISION that rests on it -- a sweep's target selection -- takes the registry
        lock and re-reads there, exactly as Get-NotebookResetTargets does.

        KNOWN, AND DELIBERATELY NOT FIXED HERE: THE PROBE-CONTENTION WINDOW. Test-SeatClaim probes
        with FileShare::None, so for as long as that probe's handle is open a legitimate
        Enter-SeatClaim at the same seat fails with "already has a live session" -- and a sweep probes
        every seat, twice over if its preflight and its apply each ask. Recorded where a reader meets
        it; closing it belongs to the sweep's own build (PLAN-notebook-drain.md row 7).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][object]$Registry,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Retirements,
        # THE OWNERSHIP ROW'S OWNER: a slug AND its incarnation, which is what makes the row
        # comparable to a registry entry at all. '' is a real incarnation -- the pre-identity one --
        # and compares equal only to another record of that same pre-identity incarnation.
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$SeatId,
        [Parameter(Mandatory = $true)][string]$ActingSeat,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ActingSeatId,
        [int]$AgentProcessId = -1
    )
    if ($Seat -ceq $ActingSeat -and $SeatId -ceq $ActingSeatId) {
        return [pscustomobject]@{
            seat = $Seat; seat_id = $SeatId; incarnation_status = 'acting'; claim_state = 'not-probed'
            decision = 'allow'; reason = 'acting-seat'
            note = "notebook/<topic> belongs to this seat's own incarnation; a reset takes it on the claim this session holds, not because any seat is idle."
        }
    }

    $status = Get-SeatIncarnationStatus -Registry $Registry -Retirements $Retirements -Seat $Seat -SeatId $SeatId
    if ($status -cne 'live') {
        # ONE SPELLING FOR "NO INCARNATION", the same one Get-NotebookResetTargets' refusal uses.
        $which = if ([string]::IsNullOrWhiteSpace($SeatId)) { 'the pre-identity incarnation' } else { "incarnation $SeatId" }
        if ($status -ceq 'retired') {
            return [pscustomobject]@{
                seat = $Seat; seat_id = $SeatId; incarnation_status = $status; claim_state = 'not-probed'
                decision = 'skip'; reason = 'retired-incarnation'
                note = "seat '$Seat' ($which) is retired, so its topics belong to a whole-tree reset rather than to a sweep (ADR-0016). Include them with -WholeTree."
            }
        }
        return [pscustomobject]@{
            seat = $Seat; seat_id = $SeatId; incarnation_status = $status; claim_state = 'not-probed'
            decision = 'skip'; reason = 'unaccounted-incarnation'
            note = ("no registry entry and no retirement record name $which of seat '$Seat', so nothing can say the work there is finished -- " +
                    "and a seat directory deleted by hand is not a retirement. Take the topic over with tools/Set-NotebookTopicOwner.ps1, declare it shared, or recreate the seat and retire it properly.")
        }
    }

    $state = [string](Get-SeatClaimState -StateDirectory $StateDirectory -Seat $Seat -AgentProcessId $AgentProcessId).state
    # THE ANSWER COMES FROM THE TABLE, never from a second copy of it here. The reason and the note
    # are worded from the STATE, so a row edited in the matrix changes the decision while the words
    # still describe the seat -- rather than the two drifting into disagreement.
    $decision = Get-SeatStateDecision -Operation 'sweep' -State $state
    if (@('allow', 'skip') -cnotcontains $decision) {
        throw "The seat-state matrix answers '$decision' for a sweep of a $state seat, and a sweep can only allow or skip. A sweep that refuses would abort over one busy seat; correct the sweep rows in Get-SeatStateMatrix."
    }
    $reason = 'idle'
    $note = "seat '$Seat' is idle, so its Notebook topics may be set aside; the quarantine journal records that they were its."
    if ($state -ceq 'held') {
        $reason = 'live-session'
        $note = "seat '$Seat' has a live session, so its Notebook topics are left alone. Wait for that session to end."
    }
    elseif ($state -ceq 'orphaned') {
        $reason = 'lost-holder'
        $note = "seat '$Seat' has a live agent process whose claim holder was lost, so its Notebook topics are left alone. Wait for it to end, or re-bind and close it from that conversation."
    }
    [pscustomobject]@{
        seat = $Seat; seat_id = $SeatId; incarnation_status = $status; claim_state = $state
        decision = $decision; reason = $reason; note = $note
    }
}

function Resolve-SeatSweepDispositions {
    <#
    .SYNOPSIS
        Get-SeatSweepDisposition over a whole set of ownership rows, asking about each distinct
        (seat, seat_id) EXACTLY ONCE and reusing the answer for every row that names it.

    .DESCRIPTION
        THE PREDICATE ANSWERS ONE ROW, AND A SWEEP HAS ROWS, NOT SEATS. A loop that called it
        directly would probe one seat once per TOPIC, and a seat owning several topics is the
        ordinary case rather than a corner one. Two things make that wrong rather than merely
        wasteful:

          - CORRECTNESS FIRST. Two probes of one seat can disagree -- a session can end, or start,
            between them -- so a selection built row by row can put one of a seat's topics in the
            target set and leave its sibling out, from one pass over one record. The preflight and
            the apply each run a pass, and the plan digest compares them; a pass that is not
            internally consistent turns that comparison into a coin toss.
          - THEN COST, AND IT IS THE CONTENTION WINDOW. Each probe opens the claim file, and for as
            long as that handle is open a legitimate Enter-SeatClaim at the same seat fails (see
            Test-SeatClaim). One probe per seat per pass is the smallest number that still answers
            the question.

        `probes` IS A REAL COUNTER, NOT A DERIVED ONE. It is incremented where the predicate is
        actually called, so a caller can assert that N rows over M seats cost M probes -- and an
        implementation that dropped the memo would report N and go red. A `seats` field computed
        from the distinct rows would agree with itself whatever the code did.

        THE KEY JOINS THE SLUG AND THE INCARNATION on a newline, which neither can contain: a slug
        is a lowercase name and an incarnation is hex or the empty pre-identity value. Keying on the
        slug alone would merge two incarnations of one name -- exactly the confusion the predicate's
        test order exists to prevent.

        TAKES NO LOCK, exactly as the predicate does not. The caller that acts on this holds the
        registry lock, which is where the answer is allowed to mean something.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][object]$Registry,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Retirements,
        # The ownership rows to classify: each carries `topic`, `seat` and -- where the record has
        # one -- `seat_id`. A row with no seat_id names the pre-identity incarnation, which is a real
        # incarnation and not a missing value.
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Rows,
        [Parameter(Mandatory = $true)][string]$ActingSeat,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ActingSeatId,
        [int]$AgentProcessId = -1
    )
    $memo = @{}
    $probes = 0
    $answers = [Collections.Generic.List[object]]::new()
    foreach ($row in @($Rows)) {
        if ($null -eq $row) { continue }
        $fields = @($row.PSObject.Properties | ForEach-Object { $_.Name })
        $rowSeat = [string]$row.seat
        $rowSeatId = if ($fields -ccontains 'seat_id') { [string]$row.seat_id } else { '' }
        $key = "$rowSeat`n$rowSeatId"
        if (-not $memo.ContainsKey($key)) {
            $probes++
            $memo[$key] = Get-SeatSweepDisposition -StateDirectory $StateDirectory -Registry $Registry `
                -Retirements $Retirements -Seat $rowSeat -SeatId $rowSeatId `
                -ActingSeat $ActingSeat -ActingSeatId $ActingSeatId -AgentProcessId $AgentProcessId
        }
        $answer = $memo[$key]
        [void]$answers.Add([pscustomobject]@{
            topic = [string]$row.topic
            seat = [string]$answer.seat
            seat_id = [string]$answer.seat_id
            incarnation_status = [string]$answer.incarnation_status
            claim_state = [string]$answer.claim_state
            decision = [string]$answer.decision
            reason = [string]$answer.reason
            note = [string]$answer.note
        })
    }
    [pscustomobject]@{ rows = @($answers); probes = $probes; seats = $memo.Count }
}

function Get-ClaimGatedHelpers {
    <#
    .SYNOPSIS
        The helpers that MUST call Assert-SeatClaimHeld, declared once so the gate can read them.

    .DESCRIPTION
        These are the ones that write `notebook/` or a Desk -- the two surfaces a reset judges. The
        claim exists so reset can tell live work from dormant, so this set is deliberately NOT
        "everything that mutates": it is everything whose output a reset would otherwise
        misclassify.

        REMOVE-SHELFBOOK JOINED ON 2026-09-09, AND ITS ARRIVAL CHANGED NOTHING FOR THE READER. It
        always required a claim to delete an OPEN Book, because it closed the Desk by shelling out to
        Set-VirtualDesk, which demands one. That child process cannot survive the registry lock the
        deletion now holds -- the same non-reentrant lock, so it would wait on its own parent -- so
        the Desk write moved in-process, and the claim assertion had to move with it or be silently
        dropped. It is called on the Desk-writing path only: deleting a CLOSED Book still needs no
        claim, exactly as before. This check proves the assertion is INVOKED, not that it is reached
        on every path, which is why that conditional is honest here and would not be everywhere.

        SET-NOTEBOOKTOPICOWNER JOINED ON 2026-09-09, AND THE QUESTION IT ASKS IS A DIFFERENT ONE.
        This entry used to explain its absence: its `-Seat` names the topic's ASSIGNEE rather than
        the acting session, so demanding THAT seat's claim would answer the wrong question -- a topic
        may be assigned to a seat that is deliberately dormant. All of that is still true, and it
        was the wrong conclusion. What the helper needed was the ACTING session's claim, which is the
        same question every other member of this set is asked. Without it, a session holding no seat
        could reassign a live seat's Notebook topic to itself, and the reset it then ran would
        quarantine that seat's work as its own -- reachable with an ordinary file tool and no
        concurrency at all (2026-09-09 seats review).

        THE OTHER SEAT-AWARE MUTATORS ARE ABSENT ON PURPOSE. Edit-ProjectHub and both manifest
        updaters consult this seat's Desk for entitlement and write outside `notebook/`, so no reset
        ever judges their output.

        DECLARED HERE RATHER THAN RESTATED IN THE GATE, for the reason desk.lock-order already
        records: a second copy is how the check and the code come to disagree about the one thing
        the check exists to be right about. Until 2026-09-08 three documents said EVERY seat-aware
        mutator required a claim -- false for those four, and Start-LibrarySeat.ps1's help named
        editing a Hub specifically. Nothing in the gate could have caught it, because prose is not
        checked for truth; desk.claim-coverage closes the code half of that.

        THE TWO RECOVERY HELPERS JOINED ON 2026-09-10, and they are this set's own definition read
        backwards. Restore-NotebookQuarantine.ps1 WRITES `notebook/` -- it is the reset's inverse, so
        if the reset needs a claim so does it. Remove-NotebookQuarantine.ps1 writes no topic
        directory and is here anyway, for Set-NotebookTopicOwner.ps1's reason: it changes the
        ownership record, and a session holding no seat that could drop another seat's row would
        make that seat's material unreachable by its own reset. Remove-SeatArchive.ps1 is absent for
        Retire-Seat.ps1's reason -- it writes neither surface, and the only direction it can move a
        reset is toward refusing more.
    #>
    @(
        'Compile-RawBatchToNotebook.ps1',
        'Invoke-LibraryTriage.ps1',
        'Remove-NotebookQuarantine.ps1',
        'Remove-ShelfBook.ps1',
        'Reset-LocalNotebook.ps1',
        'Restore-BookSource.ps1',
        'Restore-NotebookQuarantine.ps1',
        'Set-NotebookTopicOwner.ps1',
        'Set-VirtualDesk.ps1'
    )
}

function Assert-SeatClaimHeld {
    <#
    .SYNOPSIS
        The mutators that write `notebook/` or a Desk require a matching live claim token and fail
        closed without one (step 15b, ruled by Eric 2026-09-07). Get-ClaimGatedHelpers declares them,
        and it is the only place their number is knowable -- this synopsis has said "every seat-aware
        mutator" (false) and then "the five" (stale within a day), so it now names no count at all.
        READS ARE UNAFFECTED, and so are the seat-aware mutators that write neither surface;
        docs/seats.md carries which and why.

        IT ALSO CARRIES THE MAINTENANCE BARRIER (2026-09-19). A cutover stops the whole tree, and
        this is the one door the declared set already goes through, so the barrier is enforced here
        rather than in each of them. See the comment on the check itself below.

    .DESCRIPTION
        Without this the claim is bypassable and the whole liveness model is advisory: an agent
        launched directly, inheriting or being handed a LIBRARY_SEAT, would carry no claim and could
        still change its Desk or its Notebook -- and reset would then classify genuinely active work
        as dormant and quarantine it.

        The deciding argument for making the launcher mandatory was that a per-pane mechanism to set
        LIBRARY_SEAT is needed regardless, so the launcher IS that mechanism rather than an extra
        step. The cost is stated in ADR-0015 and in the refusal below: a bare agent invocation can
        read and answer, and cannot compile, open a Book, or reset.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [string]$Token,
        # This process's agent, for the second proof below. Supplied by fixtures; resolved from the
        # environment otherwise.
        [int]$AgentProcessId = -1,
        # The workspace the barrier lives under. DERIVED from -StateDirectory by default, because
        # every one of the declared helpers passes `Join-Path $workspace '.claude'` and a second
        # parameter each of them had to remember is a coverage hole waiting to open. A caller whose
        # state directory is spelled some other way passes this rather than being guarded silently
        # against the wrong tree.
        [string]$WorkspacePath = ''
    )
    if ([string]::IsNullOrWhiteSpace($Token)) { $Token = [string]$env:LIBRARY_SEAT_CLAIM }

    # --- THE MAINTENANCE BARRIER COMES FIRST, AND IT IS ITS OWN STOP REASON ------------------------
    #
    # BEFORE the claim is evaluated, deliberately. A barrier cannot go up while any claim is live, so
    # under one the claim check would refuse with "seat 'x' has no live session" -- true, useless,
    # and it sends the reader to Start-LibrarySeat.ps1, which the barrier refuses too for a reason
    # the first message never mentioned. One refusal per guard, each naming its own fix.
    #
    # THIS IS WHERE THE WHOLE CLAIM-GATED SET INHERITS IT. Get-ClaimGatedHelpers declares that set
    # and desk.claim-coverage already proves every member reaches this function, so the barrier's
    # coverage is DERIVED from a checked declaration rather than copied into nine files that can
    # fall out of step one at a time.
    if ([string]::IsNullOrWhiteSpace($WorkspacePath)) {
        $leaf = Split-Path -Leaf $StateDirectory
        if ($leaf -cne '.claude') {
            throw ("Assert-SeatClaimHeld was given a state directory whose leaf is '$leaf' rather than '.claude', so " +
                   'the workspace holding the maintenance barrier cannot be derived from it. Pass -WorkspacePath ' +
                   'explicitly; guarding the wrong tree would be worse than refusing here.')
        }
        $WorkspacePath = Split-Path -Parent $StateDirectory
    }
    Assert-NoMaintenanceBarrier -Workspace $WorkspacePath -Operation "changing anything at seat '$Seat'" | Out-Null
    # AND THE SAME FOR A COLLECTION EXPORT (PLAN-public-release.md step 15, contract (a)). The
    # claim-gated set is publication, refresh and archive -- exactly the writers whose output the
    # vault exporter is copying -- and this is the one function all of them reach. A second guard
    # with its own refusal rather than a clause added to the barrier's: the two stop different work
    # for different reasons, and a reader sent to the wrong remedy is worse than a longer message.
    Assert-NoCollectionExport -Workspace $WorkspacePath -Operation "changing anything at seat '$Seat'" | Out-Null

    $claim = Get-SeatClaimState -StateDirectory $StateDirectory -Seat $Seat -AgentProcessId $AgentProcessId
    $held = Get-SeatClaimToken -StateDirectory $StateDirectory -Seat $Seat

    # EITHER PROOF IS ENOUGH, AND BOTH ANSWER THE SAME QUESTION (ADR-0018, step 6). The token proves
    # this session was handed the claim by the launcher; a committed binding naming this process's
    # agent proves the seat was bound to it. A session that has one and not the other is not a
    # different case -- an agent bound by a hook never sees a token, and a launcher-started agent
    # carries a token before any binding exists.
    $sameAgent = ([bool]$claim.this_agent) -or ((-not [string]::IsNullOrWhiteSpace($held)) -and $Token -ceq $held)
    switch (Get-SeatStateDecision -Operation 'mutate' -State ([string]$claim.state) -SameAgent $sameAgent) {
        'allow' { return $true }
    }

    # ONE REFUSAL PER STATE, EACH NAMING ITS OWN FIX. A reader told the wrong one takes the wrong
    # action: "start a session" is useless to somebody whose agent is running and whose holder died,
    # and "re-bind" is meaningless to somebody who never had a seat.
    if ([string]$claim.state -ceq 'orphaned') {
        throw ("Seat '$Seat' is bound to agent process $([int]$claim.agent_pid), which is still running, but its claim " +
               'holder is gone -- so nothing may be changed at it until the seat is re-bound. Re-bind it from that ' +
               'conversation; the material is untouched and the binding is intact.')
    }
    if ([string]$claim.state -ceq 'free') {
        throw ("Seat '$Seat' has no live session, so nothing may be changed at it. Start work with " +
               "tools/Start-LibrarySeat.ps1 -Seat $Seat, which holds the seat for the life of the session. " +
               'Reading is unaffected.')
    }
    # THE `held`-BY-SOMEBODY-ELSE REFUSAL, AND IT NAMES WHERE THIS AGENT ACTUALLY SITS when it sits
    # anywhere. "Another session is working that seat" is the right sentence for a session with no
    # seat and the wrong one for a session bound to a DIFFERENT seat, whose real mistake is the seat
    # it named -- one agent process holds one seat for its life (ADR-0018, D11), so the fix is to
    # name its own seat, not to start a session it already has. The lookup is the resolver's own, so
    # this cannot disagree with what Resolve-SeatName would say.
    $boundElsewhere = $null
    try { $boundElsewhere = Get-SeatBindingForAgent -StateDirectory $StateDirectory -AgentProcessId $AgentProcessId }
    catch { $boundElsewhere = $null }
    if ($null -ne $boundElsewhere -and [string]$boundElsewhere.seat -cne $Seat) {
        throw ("This agent process is bound to seat '$([string]$boundElsewhere.seat)', not to '$Seat', so it may not " +
               "change anything at '$Seat'. One agent process holds one seat for the life of that process. Work at " +
               "'$([string]$boundElsewhere.seat)', or end this conversation and sit down at '$Seat' in a new one.")
    }
    throw ("This session does not hold seat '$Seat' -- neither LIBRARY_SEAT_CLAIM nor this agent process matches the " +
           'live claim. Another session is working that seat. Start your own with tools/Start-LibrarySeat.ps1 -Seat <name>.')
}

# --- activity.json: advice, and never a gate ------------------------------------------------------

function Get-SeatActivityPath {
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Seat)
    Join-Path (Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat) 'activity.json'
}

function Write-SeatActivity {
    <#
    .SYNOPSIS
        Record when a seat was last touched. ADVISORY ONLY -- see the schema note it writes.

    .DESCRIPTION
        A LOCK-FREE ATOMIC REPLACEMENT through a unique temp file, so it needs no seat lock and joins
        no lock order. It carries a PID only when the caller supplies a durable process identity,
        because the hook that would otherwise write one dies immediately afterwards and would leave
        a PID that reads as liveness and is not.

        `-Conversation` IS FOR THE ONE ENTRY ROUTE A BINDING CANNOT COVER, and it is advisory like
        everything else here. A launcher-started session holds the claim handle in the LAUNCHER, so
        the agent inside it is refused a binding by the `enter`/`held` row of the matrix -- which
        means nothing records which conversation is sitting at that seat, and the terminal picker's
        resume column would be permanently empty at exactly the seats terminal readers use. The
        launcher mints the conversation id it passes to `claude --session-id`, so it is the one
        process that knows it. It is written here rather than into the binding because it is NOT
        verified identity: no process has been checked, and this record must never be read as one.
        `PLAN-seat-launch.md` step 8's `conversations.json` is what turns it into a history.

        AND IT IS REPLACED WHOLE BY THE NEXT ENTRY, deliberately. An entry that did not mint a
        conversation cannot name the one it started, so carrying the previous id forward would claim
        a conversation that is no longer this seat's last.

        `-KeepConversation` IS FOR A WRITE THAT STARTS NO CONVERSATION AT ALL. Clearing there would
        erase a real record on behalf of a conversation that never happened -- found by running the
        picker twice against one fixture, where the second roster had forgotten what the first one
        displayed. Two callers pass it, and the second one is what "replaced whole by the next ENTRY"
        had quietly not accounted for: `-NoLaunch`, a script that entered a seat and returned, and
        `tools/Set-VirtualDesk.ps1`, where opening or closing a Book is not an entry at all. A Desk
        write that cleared the record left a launcher-started seat -- which has no binding to fall
        back on -- with nothing naming the conversation sitting at it.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [string]$Note,
        [int]$DurableProcessId = 0,
        [string]$Conversation,
        [switch]$KeepConversation
    )
    $deskDirectory = Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat
    if (-not (Test-Path -LiteralPath $deskDirectory -PathType Container)) { return $null }
    $record = [ordered]@{
        advisory = 'ADVICE ONLY. This record never authorizes or unblocks a mutation, and it is not a lease. Liveness is the seat claim.'
        seat = $Seat
        last_seen_utc = [DateTime]::UtcNow.ToString('o')
        note = $Note
    }
    if ($DurableProcessId -gt 0) { $record['pid'] = $DurableProcessId }
    if ([string]::IsNullOrWhiteSpace($Conversation) -and $KeepConversation) {
        $previous = Read-SeatActivity -StateDirectory $StateDirectory -Seat $Seat
        if ($null -ne $previous) {
            $previousFields = @($previous.PSObject.Properties | ForEach-Object { $_.Name })
            if ($previousFields -ccontains 'session_id' -and $previousFields -ccontains 'conversation_recorded_utc') {
                $record['session_id'] = [string]$previous.session_id
                # THE ORIGINAL STAMP TRAVELS WITH IT. Re-stamping would make an old conversation look
                # newer than a binding written since, which is the comparison the picker's roster
                # makes to decide which record is a seat's last.
                $record['conversation_recorded_utc'] = [string]$previous.conversation_recorded_utc
            }
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($Conversation)) {
        $record['session_id'] = $Conversation
        # ITS OWN TIMESTAMP, not last_seen_utc. A reader of this record has to compare it against the
        # BINDING's bound_utc to know which conversation is a seat's last, and last_seen_utc moves
        # every time anything touches the seat -- so it would win that comparison while naming a
        # conversation recorded much earlier.
        $record['conversation_recorded_utc'] = [DateTime]::UtcNow.ToString('o')
    }
    $path = Get-SeatActivityPath -StateDirectory $StateDirectory -Seat $Seat
    Write-AtomicText -Path $path -Text (([pscustomobject]$record | ConvertTo-Json -Depth 4) + "`n") | Out-Null
    $path
}

function Read-SeatActivity {
    <# Advisory, so an unreadable record is reported as absent rather than raised. #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Seat)
    $path = Get-SeatActivityPath -StateDirectory $StateDirectory -Seat $Seat
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try { return ([Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $path)) | ConvertFrom-Json) }
    catch { return $null }
}

# --- Creating and retiring a seat -----------------------------------------------------------------

function New-SeatDirectory {
    <# Create a seat's directory with BOTH Desk files. Caller holds the registry lock. #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Seat)
    $deskDirectory = Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat
    if (-not (Test-Path -LiteralPath $deskDirectory -PathType Container)) { New-Item -ItemType Directory -Path $deskDirectory -Force | Out-Null }
    # BOTH files, always. Creating only .open-books is the same omission step 20 refuses in the
    # migration: it strands day-one Project Hub state, and every reader of the pair throws on a
    # missing file rather than treating it as empty.
    foreach ($kind in @('books', 'projects')) {
        $path = Get-DeskFilePath -StateDirectory $StateDirectory -Seat $Seat -Kind $kind
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Write-AtomicText -Path $path -Text '' | Out-Null }
    }
    $deskDirectory
}

function Get-SeatArchiveDirectory {
    <#
    .SYNOPSIS
        Where retired seats are archived. ONE definition of the path; it no longer creates it.

    .DESCRIPTION
        IT USED TO CREATE THE DIRECTORY, AND THAT STOPPED BEING FREE ON 2026-09-10. Retirement is
        now a thing other code READS -- the reset asks whether a seat was retired, the creation gate
        asks whether a slug is still cited, and the Desk overview reports both -- so a read of the
        archive would have created an empty `internal/seat-archive/` on every Desk overview in a
        workspace that has never retired anything. Nothing needed the creation: the one writer makes
        its stamped subdirectory with `New-Item -Force`, which creates this parent on the way.
    #>
    param([Parameter(Mandatory = $true)][string]$Workspace)
    Join-Path $Workspace 'internal/seat-archive'
}

# --- RETIREMENT HAS AN IDENTITY (2026-09-10) ------------------------------------------------------
#
# WHAT WAS WRONG, AND IT WAS REACHABLE WITH ONE `rm -rf`. "Retired" was read off the SEAT DIRECTORY:
# `Get-NotebookResetTargets` treated any owned seat absent from `.claude/seats/` as retired and made
# its Notebook topics whole-tree eligible. That directory is gitignored, so deleting one seat's
# folder by hand -- the obvious thing to try when a stale claim will not clear -- silently handed
# every topic it owned to the next seat's whole-tree reset, with NO refusal. Measured before this
# changed: with `.claude/seats/library-dev` deleted and the registry still naming it, a whole-tree
# reset at the other seat selected `basic-memory` and `orca-ide` and refused nothing.
#
# SO RETIREMENT IS NOW A RECORD RATHER THAN AN ABSENCE. A seat incarnation is retired when
# `internal/seat-archive/<seat>-<stamp>/seat.json` names it AND no registry entry does. Both halves
# are load-bearing: the archive record is written only by `Retire-Seat.ps1`, which is gated, refuses
# a live seat and reads back what it wrote; and the registry is the durable list a missing directory
# does not change. A deleted directory now leaves the seat REGISTERED and therefore foreign, which
# refuses with the remedy that fits -- retire it, which works on a seat whose Desk is gone.
#
# AND THE COMPARISON IS PER INCARNATION, NOT PER NAME (ADR-0018). Ownership rows carry the
# `seat_id` of the incarnation that recorded them, so a slug reused after a retirement cannot inherit
# the retired incarnation's topics: the new seat's id differs, so its ordinary reset does not see
# them and its whole-tree reset sees them as the RETIRED incarnation's. A record written before ids
# existed carries none, and an empty id is a real value meaning "the pre-identity incarnation of this
# slug" -- it compares equal only to another record of that same pre-identity incarnation, which is
# why no backfill is needed and why one would have been the dangerous half of this change.

function Get-SeatEntryIncarnation {
    <#
    .SYNOPSIS
        A registry entry's incarnation id, or '' when the entry predates ADR-0018. Never $null, so
        every comparison in this family is a string compare with no null branch.
    #>
    param([object]$Entry)
    if ($null -eq $Entry) { return '' }
    $names = @($Entry.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -cnotcontains 'seat_id') { return '' }
    [string]$Entry.seat_id
}

function Read-SeatRetirementRecords {
    <#
    .SYNOPSIS
        Every readable retirement record under `internal/seat-archive/`, as
        {seat, seat_id, retired_utc, directory}. Unreadable archives come back separately as faults.

    .DESCRIPTION
        FAILS CLOSED PER ARCHIVE RATHER THAN FOR THE WHOLE READ. An archive whose `seat.json` is
        missing, unparseable or nameless is NOT a retirement record here -- it is a fault the caller
        reports -- because the only thing a retirement record licenses is a whole-tree reset moving
        somebody's topics, and a half-written archive must never license that. Throwing instead
        would take the Desk overview down over a directory nobody is asking about.

        A LOCK-FREE READ. Every reader of this is a report or a preflight; the one DECISION that
        rests on it -- reset target selection -- takes the registry lock and re-reads there.
    #>
    param([Parameter(Mandatory = $true)][string]$Workspace)
    $root = Get-SeatArchiveDirectory -Workspace $Workspace
    $records = [Collections.Generic.List[object]]::new()
    $faults = [Collections.Generic.List[string]]::new()
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        return [pscustomobject]@{ records = @(); faults = @() }
    }
    foreach ($directory in @(Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction SilentlyContinue)) {
        $recordPath = Join-Path $directory.FullName 'seat.json'
        if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) {
            [void]$faults.Add("internal/seat-archive/$($directory.Name) carries no seat.json, so it records no retirement; nothing treats the seat it is named for as retired")
            continue
        }
        $parsed = $null
        try { $parsed = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $recordPath)) | ConvertFrom-Json }
        catch {
            [void]$faults.Add("internal/seat-archive/$($directory.Name)/seat.json could not be read: $($_.Exception.Message)")
            continue
        }
        $fields = @($parsed.PSObject.Properties | ForEach-Object { $_.Name })
        if ($fields -cnotcontains 'seat') {
            [void]$faults.Add("internal/seat-archive/$($directory.Name)/seat.json names no seat")
            continue
        }
        [void]$records.Add([pscustomobject]@{
            seat        = [string]$parsed.seat
            # ABSENT IS '' AND MEANS THE PRE-IDENTITY INCARNATION, exactly as it does on a registry
            # entry and an ownership row. A retirement archived before 2026-09-10 carries no id.
            seat_id     = if ($fields -ccontains 'seat_id') { [string]$parsed.seat_id } else { '' }
            retired_utc = if ($fields -ccontains 'retired_utc') { [string]$parsed.retired_utc } else { '' }
            project     = if ($fields -ccontains 'project') { [string]$parsed.project } else { '' }
            directory   = $directory.Name
        })
    }
    [pscustomobject]@{ records = @($records); faults = @($faults) }
}

function Get-SeatIncarnationStatus {
    <#
    .SYNOPSIS
        What one (seat, incarnation) pair is now: `live`, `retired` or `unaccounted`. THE one
        derivation every consumer of retirement uses.

    .DESCRIPTION
        THREE ANSWERS AND THE THIRD IS THE WHOLE POINT. Before this there were two, inferred from
        one directory listing, and the case that fits neither -- a seat that is gone from the
        registry with no retirement record, which is what a `git clean -fdx` or a hand-edited
        registry leaves -- was read as retired. `unaccounted` is refused rather than guessed at, the
        same shape `Get-NotebookResetTargets` already uses for an unclaimed, unretired foreign seat.

            live          the registry names this slug AND its entry carries this same incarnation
            retired       not live, and an archive record names this slug and this incarnation
            unaccounted   neither -- nothing can say whether that incarnation is finished

        LIVE IS CHECKED FIRST, so a slug that is in the registry is never read off an archive. That
        matters for a reused slug: the archive record of the OLD incarnation is still on disk, and a
        reader that consulted it first would answer `retired` about the seat somebody is sitting at.
    #>
    param(
        [Parameter(Mandatory = $true)][object]$Registry,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Retirements,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$SeatId
    )
    $entry = Get-SeatEntry -Registry $Registry -Seat $Seat
    if ($null -ne $entry -and (Get-SeatEntryIncarnation -Entry $entry) -ceq $SeatId) { return 'live' }
    foreach ($record in @($Retirements)) {
        if ([string]$record.seat -ceq $Seat -and [string]$record.seat_id -ceq $SeatId) { return 'retired' }
    }
    'unaccounted'
}

function Get-SeatRegistryConsistency {
    <#
    .SYNOPSIS
        Does the registry agree with `.claude/seats/`, and is every archive a readable retirement?
        A lock-free report: one row per slug either source knows, plus worded faults.

    .DESCRIPTION
        WHY IT IS REPORTED AT ALL. The registry and the seat directories are written in one
        registry-locked transaction, so they can only disagree because something OUTSIDE this
        system touched them -- a hand deletion, a hand-edited registry, a partial `git clean`. Both
        live in gitignored trees, so no commit restores either, and until 2026-09-10 a disagreement
        was not merely unreported: it was READ AS RETIREMENT and changed what a reset would move.
        It is now inert, which is the fix -- and inert and invisible is how a workspace stays broken,
        which is why it is on the Desk overview and in the gate.

            ok             registered, and its Desk directory is there
            desk-missing   registered with no directory: the Desk is gone, the seat is NOT retired
            unregistered   a directory no registry entry names: no helper can enter or retire it

        THE FAULTS NAME A ROUTE THAT WORKS. `desk-missing` says retire it, and retirement really
        does work on a seat whose Desk files are gone -- it archives what is there, which is
        nothing, writes the record and drops the registry entry. `unregistered` cannot say that,
        because retirement asserts the registry entry first, so it says what the directory holds and
        leaves the decision with the reader.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory
    )
    # A REPORT ANSWERS; IT DOES NOT FAIL CLOSED. Every DECISION in this family refuses an unreadable
    # registry or an unnameable seat directory, which is right -- but this is the Desk overview's
    # source, and a reader whose registry has been hand-edited into nonsense needs to be TOLD that
    # rather than to lose the orientation tool that would say so. The refusal's own wording is
    # carried through as the fault, so the reader sees the same sentence a mutation would give them.
    $registry = Get-EmptySeatRegistry
    $onDisk = @()
    $faults = [Collections.Generic.List[string]]::new()
    $readable = $true
    try { $registry = Read-SeatRegistry -StateDirectory $StateDirectory }
    catch { $readable = $false; [void]$faults.Add([string]$_.Exception.Message) }
    try { $onDisk = @(Get-SeatDirectoryNames -StateDirectory $StateDirectory) }
    catch { $readable = $false; [void]$faults.Add([string]$_.Exception.Message) }
    $registered = @(@($registry.seats) | ForEach-Object { [string]$_.seat })
    $retirement = Read-SeatRetirementRecords -Workspace $Workspace

    $rows = [Collections.Generic.List[object]]::new()
    foreach ($seat in @(@($registered + $onDisk) | Sort-Object -Unique -CaseSensitive)) {
        $inRegistry = @($registered) -ccontains $seat
        $hasDirectory = @($onDisk) -ccontains $seat
        # `unknown` RATHER THAN A GUESS when one of the two sources could not be read at all. With
        # an unreadable registry every seat would otherwise read `unregistered`, which is a
        # different fault with a different remedy and would send the reader to delete Desks.
        $state = if (-not $readable) { 'unknown' }
            elseif ($inRegistry -and $hasDirectory) { 'ok' }
            elseif ($inRegistry) { 'desk-missing' }
            else { 'unregistered' }
        [void]$rows.Add([pscustomobject]@{
            seat = $seat
            in_registry = $inRegistry
            has_directory = $hasDirectory
            seat_id = (Get-SeatEntryIncarnation -Entry (Get-SeatEntry -Registry $registry -Seat $seat))
            state = $state
        })
        if ($state -ceq 'unknown') { continue }
        if ($state -ceq 'desk-missing') {
            [void]$faults.Add("seat '$seat' is in the registry with no .claude/seats/$seat directory: its Desk is gone and " +
                'nothing treats it as retired, so its Notebook topics stay out of every other seat''s reset. Retire it with ' +
                "tools/Retire-Seat.ps1 -Seat $seat to record that it is finished, or recreate its Desk by entering it.")
        }
        elseif ($state -ceq 'unregistered') {
            [void]$faults.Add(".claude/seats/$seat exists and no registry entry names it, so no helper can enter, retire or " +
                'reset it. Copy anything you need out of that directory and remove it, or restore the registry entry.')
        }
    }
    foreach ($fault in @($retirement.faults)) { [void]$faults.Add($fault) }

    [pscustomobject]@{
        seats = @($rows)
        retirements = @(@($retirement.records) | ForEach-Object {
            [pscustomobject]@{ seat = [string]$_.seat; seat_id = [string]$_.seat_id; retired_utc = [string]$_.retired_utc; directory = [string]$_.directory }
        })
        faults = @($faults)
        consistent = (@($faults).Count -eq 0)
    }
}

# --- RESTORING A DESK FROM AN ARCHIVE (2026-09-10) ------------------------------------------------
#
# THE OTHER HALF OF RETIREMENT. `Retire-Seat.ps1` archives the Desk because it is the only durable
# record of what a reader had open (ADR-0010) -- and until now nothing read it back, so "archived
# rather than discarded" was true of the bytes and false of the Library. `docs/seats.md` and the
# playbook both named a restore that did not exist.
#
# ADDITIVE, AND THAT IS THE WHOLE SAFETY ARGUMENT. It OPENS what the archive had open and closes
# nothing, so a Desk that already holds this seat's own Project Hub keeps it. A write that provably
# cannot lose text applies directly; this one is still gated, because what a reader has open is what
# they can read, and a Desk that silently gained two Books is a changed reader experience rather than
# a changed file.

function Get-SeatConversationRestoreDocument {
    <#
    .SYNOPSIS
        This seat's conversation record with an archive's entries merged in, as {document, added,
        kept}. Pure: it reads, it never writes, it takes no lock.

    .DESCRIPTION
        THE LIVE RECORD WINS, ENTRY BY ENTRY. A conversation already on this seat's record has
        stamps from a session that really sat here; an archived entry for the same conversation is
        older by construction. Overwriting the live one would drag `last_seen_utc` backwards, and
        that field is what the cross-seat resume lookup sorts on -- so a restore could send a
        resumed conversation to a seat it left.

        AND EACH RESTORED ENTRY KEEPS THE `seat_id` IT WAS WRITTEN WITH. It says which INCARNATION
        that conversation sat at, and the archive is by definition a retired one. Restamping it with
        the live seat's id would be a backfill of exactly the kind retirement's identity refused: it
        would claim a conversation sat at an incarnation that did not exist yet.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Archived
    )
    $existing = Read-SeatConversations -StateDirectory $StateDirectory -Seat $Seat
    $records = [Collections.Generic.List[object]]::new()
    $known = [Collections.Generic.List[string]]::new()
    if ($null -ne $existing) {
        foreach ($entry in @($existing.conversations)) {
            [void]$records.Add($entry)
            [void]$known.Add([string]$entry.session_id)
        }
    }
    $added = [Collections.Generic.List[string]]::new()
    foreach ($entry in @($Archived)) {
        if ($null -eq $entry) { continue }
        $fields = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
        if ($fields -cnotcontains 'session_id') { continue }
        $id = [string]$entry.session_id
        if ([string]::IsNullOrWhiteSpace($id) -or $known -ccontains $id) { continue }
        [void]$known.Add($id)
        [void]$added.Add($id)
        [void]$records.Add([pscustomobject]@{
            session_id     = $id
            seat_id        = if ($fields -ccontains 'seat_id') { [string]$entry.seat_id } else { '' }
            source         = if ($fields -ccontains 'source') { [string]$entry.source } else { 'binding' }
            first_seen_utc = if ($fields -ccontains 'first_seen_utc') { [string]$entry.first_seen_utc } else { '' }
            last_seen_utc  = if ($fields -ccontains 'last_seen_utc') { [string]$entry.last_seen_utc } else { '' }
        })
    }
    # Oldest first on disk, the same order Get-SeatConversationDocument writes, so two records that
    # hold the same conversations produce the same bytes whichever route wrote them.
    $ordered = @(@($records) | Sort-Object -Property @{ Expression = { [string]$_.last_seen_utc } })
    [pscustomobject]@{
        added    = @($added)
        kept     = @(@($records) | Where-Object { $added -cnotcontains [string]$_.session_id } | ForEach-Object { [string]$_.session_id })
        document = [pscustomobject]@{ schema = $script:SeatConversationsSchema; seat = $Seat; conversations = $ordered }
    }
}

function Get-SeatDeskRestorePlan {
    <#
    .SYNOPSIS
        What restoring one archive onto one seat's Desk would do, with the `plan_id` that binds it.
        A read: no lock of its own, no writes. The caller holds the registry lock.

    .DESCRIPTION
        THE CONVERSATION HISTORY TRAVELS ONLY ONTO ITS OWN SLUG, and this is the decision the
        archive's new contents forced. Since 2026-09-10 an archive holds `conversations.json` beside
        the two Desk files, so a restore HAS a history to put back -- but a conversation record is a
        claim that a named conversation sat at a named seat. Copying `fallout`'s history onto
        `fallout-2` would make that claim about a seat the conversation has never been at, and
        `Get-SeatsForConversation` would then send a resumed session there. Desk lines carry no such
        claim: `books/basic-memory` is a Book that was open, and it is equally true wherever it is
        reopened. So the Desk restores anywhere and the history restores only onto its own name,
        which the plan states rather than leaving to be noticed.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][string]$Archive
    )
    $directory = Join-Path (Get-SeatArchiveDirectory -Workspace $Workspace) $Archive
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw ("No seat archive named '$Archive' exists under internal/seat-archive/. List them with " +
               'tools/Remove-SeatArchive.ps1 -List, which reports what each one holds.')
    }
    $faults = [Collections.Generic.List[string]]::new()
    $archivedSeat = ''
    $archivedSeatId = ''
    $recordPath = Join-Path $directory 'seat.json'
    if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        try {
            $parsed = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $recordPath)) | ConvertFrom-Json
            $fields = @($parsed.PSObject.Properties | ForEach-Object { $_.Name })
            if ($fields -ccontains 'seat') { $archivedSeat = [string]$parsed.seat }
            if ($fields -ccontains 'seat_id') { $archivedSeatId = [string]$parsed.seat_id }
        }
        catch { [void]$faults.Add("internal/seat-archive/$Archive/seat.json could not be read, so nothing says which seat this Desk belonged to: $($_.Exception.Message)") }
    }
    else {
        [void]$faults.Add("internal/seat-archive/$Archive carries no seat.json, so nothing says which seat this Desk belonged to")
    }

    function Read-ArchivedDeskLines([string]$Path) {
        # THE SAME READER THE LIVE DESK USES, over an archived copy of one. Retire-Seat writes these
        # files and a restore reads them, so the two can meet; and the plain-strings property this
        # wrapper existed to hand-roll -- Get-Content decorates every line with note properties whose
        # PSProvider reaches the whole provider graph, which cost a session through ConvertTo-Json --
        # is now structural, because a split of a decoded string cannot carry them.
        @(Get-DeskFileEntries -Path $Path)
    }
    $plan = @{}
    foreach ($kind in @('books', 'projects')) {
        $archived = @(Read-ArchivedDeskLines (Join-Path $directory ".open-$kind"))
        $current = @(Get-DeskEntriesForSeat -StateDirectory $StateDirectory -Seat $Seat -Kind $kind)
        $plan[$kind] = [pscustomobject]@{
            archived = @($archived)
            to_open  = @(@($archived) | Where-Object { $current -cnotcontains $_ })
            already  = @(@($archived) | Where-Object { $current -ccontains $_ })
        }
    }

    $archivedConversations = @()
    $historyAction = 'none'
    $historyReason = 'the archive holds no conversation history'
    $conversationsPath = Join-Path $directory 'conversations.json'
    if (Test-Path -LiteralPath $conversationsPath -PathType Leaf) {
        if ($archivedSeat -cne $Seat) {
            $historyAction = 'skipped'
            $historyReason = ("the archive records seat '$archivedSeat' and this is seat '$Seat'; a conversation record says which " +
                              'seat a conversation sat at, so copying it onto another name would make a claim that is not true')
        }
        else {
            try {
                $parsed = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $conversationsPath)) | ConvertFrom-Json
                if ($null -ne $parsed.conversations) { $archivedConversations = @(@($parsed.conversations) | Where-Object { $null -ne $_ }) }
                $historyAction = 'merge'
                $historyReason = 'the archive records this same seat, so its conversations are merged in; a conversation already on this seat''s record keeps its own stamps'
            }
            catch {
                $historyAction = 'skipped'
                $historyReason = "the archive's conversations.json could not be read: $($_.Exception.Message)"
                [void]$faults.Add($historyReason)
            }
        }
    }
    $merge = Get-SeatConversationRestoreDocument -StateDirectory $StateDirectory -Seat $Seat -Archived $archivedConversations

    $material = @("archive=$Archive", "seat=$Seat", "archived_seat=$archivedSeat", "archived_seat_id=$archivedSeatId",
                  "history=$historyAction") +
        @(@($plan['books'].to_open | Sort-Object -CaseSensitive) | ForEach-Object { "books=$_" }) +
        @(@($plan['projects'].to_open | Sort-Object -CaseSensitive) | ForEach-Object { "projects=$_" }) +
        @(@($merge.added | Sort-Object -CaseSensitive) | ForEach-Object { "conversation=$_" })
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $planId = (-join ($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes(($material -join "`n"))) | ForEach-Object { $_.ToString('x2') })).Substring(0, 16) }
    finally { $sha.Dispose() }

    [pscustomobject]@{
        archive              = $Archive
        directory            = $directory
        archived_seat        = $archivedSeat
        archived_seat_id     = $archivedSeatId
        books_to_open        = @($plan['books'].to_open)
        books_already_open   = @($plan['books'].already)
        projects_to_open     = @($plan['projects'].to_open)
        projects_already_open = @($plan['projects'].already)
        history_action       = $historyAction
        history_reason       = $historyReason
        conversations_to_add = @($merge.added)
        conversation_document = $merge.document
        faults               = @($faults)
        plan_id              = "restore-desk-$planId"
    }
}

# --- Migration off the single-Desk layout (step 20) -----------------------------------------------

function Get-LegacyDeskPaths {
    <# The pre-seat layout: two loose files directly under .claude. #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory)
    # The pre-seat layout is exactly "the Desk directory IS the state directory", so it resolves
    # through the same function rather than spelling the two filenames a second time. Caught by
    # desk.seat-paths-resolve on its first run, here of all places.
    [pscustomobject]@{
        books    = Get-DeskFileInDirectory -DeskDirectory $StateDirectory -Kind 'books'
        projects = Get-DeskFileInDirectory -DeskDirectory $StateDirectory -Kind 'projects'
    }
}

function Get-DeskMigrationPlan {
    <#
    .SYNOPSIS
        What migrating this checkout's Desk to a seat would do. Reads only; changes nothing.

    .DESCRIPTION
        MIGRATION IS ONE UNIT COVERING BOTH DESK FILES (step 20). Naming only `.open-books` strands
        day-one Project Hub state -- and `.open-projects` is where this workspace's own
        `projects/library-dev` lives, so the omission would have been immediate rather than
        theoretical.

        A destination that already exists and DIFFERS is refused with a byte-level diagnosis rather
        than overwritten: the file on disk is the authority the moment it exists, which is the same
        rule ShelfCatalog's migration settled on in Release 1.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat
    )
    $legacy = Get-LegacyDeskPaths -StateDirectory $StateDirectory
    $files = @()
    foreach ($kind in @('books', 'projects')) {
        $source = if ($kind -ceq 'books') { $legacy.books } else { $legacy.projects }
        $destination = Get-DeskFilePath -StateDirectory $StateDirectory -Seat $Seat -Kind $kind
        $sourceExists = Test-Path -LiteralPath $source -PathType Leaf
        $destinationExists = Test-Path -LiteralPath $destination -PathType Leaf
        # ASSIGNED IN A STATEMENT, NEVER FROM ONE. An `if` statement's value travels the pipeline,
        # and the pipeline UNROLLS a collection -- so an EMPTY Desk file's byte[0] arrived here as
        # $null and `.Length` below threw PropertyNotFound under StrictMode. Not theoretical: a
        # seat's Desk files are CREATED empty, so between creating a seat and opening anything at it
        # the seat could not be entered, or even preflighted, at all. Found 2026-09-09 by
        # seat.lifecycle's first run and confirmed against the live 2nd-b-vault-dev seat, whose two
        # Desk files were 0 bytes. Defect family `unroll`, in the direction the gate's AST check does
        # not read: its risky-right-hand-side test looks at pipelines, and this one was a statement.
        $sourceBytes = $null
        if ($sourceExists) { $sourceBytes = [IO.File]::ReadAllBytes($source) }
        $destinationBytes = $null
        if ($destinationExists) { $destinationBytes = [IO.File]::ReadAllBytes($destination) }
        $identical = $false
        if ($sourceExists -and $destinationExists) {
            $identical = ([Convert]::ToBase64String($sourceBytes) -ceq [Convert]::ToBase64String($destinationBytes))
        }
        $action = if (-not $sourceExists -and -not $destinationExists) { 'create-empty' }
        elseif (-not $sourceExists) { 'keep-destination' }
        elseif (-not $destinationExists) { 'copy' }
        elseif ($identical) { 'already-migrated' }
        else { 'conflict' }
        $files += [pscustomobject]@{
            kind = $kind
            source = $source
            destination = $destination
            source_bytes = if ($sourceExists) { $sourceBytes.Length } else { $null }
            destination_bytes = if ($destinationExists) { $destinationBytes.Length } else { $null }
            action = $action
        }
    }
    [pscustomobject]@{
        seat = $Seat
        files = $files
        conflicts = @($files | Where-Object { $_.action -ceq 'conflict' })
    }
}

function Invoke-DeskMigration {
    <#
    .SYNOPSIS
        Move this checkout's Desk into a seat, both files together. Caller holds the registry lock.

    .DESCRIPTION
        Stage, publish, VERIFY EXACT BYTES AT THE DESTINATION, and only then retire the legacy file.
        Verifying before retiring is the whole of the safety here: a copy that half-succeeded and a
        legacy file already deleted is a Desk nobody can reconstruct, and ADR-0010 records that the
        Desk is the only durable record of what a reader had open.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [switch]$RetireLegacy
    )
    $plan = Get-DeskMigrationPlan -StateDirectory $StateDirectory -Seat $Seat
    if (@($plan.conflicts).Count) {
        $detail = @($plan.conflicts | ForEach-Object { "$($_.kind): legacy $($_.source_bytes) bytes vs seat $($_.destination_bytes) bytes" }) -join '; '
        throw ("Refusing to migrate the Desk: legacy and seat state both exist and differ ($detail). " +
               'The seat file is the authority once it exists -- reconcile them by hand, then rerun.')
    }
    New-SeatDirectory -StateDirectory $StateDirectory -Seat $Seat | Out-Null
    $moved = @()
    foreach ($file in $plan.files) {
        if ($file.action -ceq 'copy') {
            $text = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $file.source))
            Write-AtomicText -Path $file.destination -Text $text | Out-Null
            # READ BACK AND COMPARE BYTES, not lengths: two Desk files of equal length can differ.
            $writtenBytes = [IO.File]::ReadAllBytes($file.destination)
            $sourceBytes = [IO.File]::ReadAllBytes($file.source)
            if ([Convert]::ToBase64String($writtenBytes) -cne [Convert]::ToBase64String($sourceBytes)) {
                throw "Desk migration wrote $($file.destination) and the bytes did not match $($file.source). The legacy file is untouched."
            }
            $moved += $file.kind
        }
    }
    if ($RetireLegacy) {
        foreach ($file in $plan.files) {
            if ($file.action -cin @('copy', 'already-migrated') -and (Test-Path -LiteralPath $file.source -PathType Leaf)) {
                Remove-Item -LiteralPath $file.source -Force
            }
        }
    }
    [pscustomobject]@{ seat = $Seat; migrated = $moved; legacy_retired = [bool]$RetireLegacy; files = $plan.files }
}

# --- Every seat's Desk (step 27) ------------------------------------------------------------------
#
# TWO DIFFERENT QUESTIONS, AND CONFUSING THEM WIDENS A BOUNDARY.
#
#   "Is this material in play anywhere?"  -- the UNION across every seat. Archive, remove and rename
#   ask this, because they change or destroy material the whole Library shares. A missed seat here
#   reports "nothing has this open" and is WRONG, which is worse than not checking at all: rename
#   would leave that seat holding a dangling `shelf/<old-slug>` entry, and that entry would grant
#   read access to any future Book that lands on the slug.
#
#   "May THIS session read or change it?"  -- this seat's Desk ALONE. Edit-ProjectHub's gate and the
#   manifest updaters' closed-content rule ask this. Answering them from the union would let another
#   seat's open Book entitle this one, which is a widening rather than a migration.
#
# The caller holds the registry lock for the first question, so the set of seats cannot change under
# the scan -- and since 2026-09-09 that is ENFORCED rather than asserted in this comment. Each of
# the three functions below calls Assert-SeatRegistryLockHeld, which is why they take a -Workspace
# they otherwise would not need: the lock is per workspace, and a mandatory parameter is what forced
# every existing call site to be revisited rather than silently keep its old behaviour.

function Get-RegistryLockedFunctions {
    <#
    .SYNOPSIS
        The functions that REFUSE to run without the registry/Desk lock, declared once so
        desk.registry-lock-coverage can read them instead of carrying a second copy of the list.

    .DESCRIPTION
        The first three read or rewrite every seat's Desk. Set-DeskEntryForSeat writes one seat's,
        and belongs here because it is the lock-held route a caller uses INSTEAD of Set-VirtualDesk
        when it already holds the lock -- so "the lock is held" is its precondition rather than
        something it can take for itself.

        Get-NotebookResetTargets lives in NotebookOwnership.ps1, not here, and that is why the gate
        finds each definition by scanning rather than by looking in one file. It is on this list
        because it decides which seats count as RETIRED by reading the seat directory, which is the
        same cross-seat question under a different name.
    #>
    @(
        'Get-DeskEntriesAcrossSeats',
        'Get-SeatsHoldingEntry',
        'Update-DeskEntryAcrossSeats',
        'Set-DeskEntryForSeat',
        'Get-NotebookResetTargets'
    )
}

function Get-RegistryLockedHelpers {
    <#
    .SYNOPSIS
        The helpers entitled to call one of Get-RegistryLockedFunctions, declared once so the gate
        can compare the declaration against the code in both directions.

    .DESCRIPTION
        WHY A DECLARED SET AND NOT JUST "MUST TAKE THE LOCK". Both faults are real and only one is
        loud. A declared helper that STOPS taking the lock is a cross-seat scan gone back to
        check-then-act, which is precisely the 2026-09-09 finding. A helper that STARTS calling one
        of these functions and is not declared is a new cross-seat operation nobody decided to add:
        it needs the lock, the ordering, and a line in `docs/seats.md`, and until 2026-09-09 that
        document named eight helpers as taking this lock while three did.

        Set-VirtualDesk and Retire-Seat take the lock and call none of these functions, so they are
        not listed -- this set is about the cross-seat surface, not about every lock acquisition.
        desk.lock-order covers the ordering of what they do take.

        START-LIBRARYSEAT JOINED ON 2026-09-10, and by the same road as the two below it: its
        creation path opens the new seat's own Project Hub on the Desk it just created, in-process,
        because Set-VirtualDesk.ps1 takes this same non-reentrant lock and would wait on its own
        parent. Before that it created the Desk and left it empty, which is how one creation route
        came to produce a seat that could not orient itself while the other did not.

        ENTER-LIBRARYSEAT JOINED ON 2026-09-09 FOR ONE CALL ON ONE PATH, and the check found it rather
        than the author remembering. Creating a seat writes the new Desk through Set-DeskEntryForSeat
        because the whole creation is one registry-locked transaction, and Set-VirtualDesk.ps1 -- the
        ordinary route -- takes this same non-reentrant lock and would wait on its own parent. It is
        the same reason Remove-ShelfBook.ps1 is here, arriving by the same road.
    #>
    @(
        'Archive-ShelfBook.ps1',
        'Enter-LibrarySeat.ps1',
        'Remove-ShelfBook.ps1',
        'Rename-ShelfBook.ps1',
        'Reset-LocalNotebook.ps1',
        'Start-LibrarySeat.ps1'
    )
}

function Get-DeskEntriesForSeat {
    <#
    .SYNOPSIS
        ONE seat's Desk lines of one kind, as plain strings. A read: no lock, and none is needed --
        the file is replaced atomically, so a reader sees the whole old file or the whole new one.

        THAT SENTENCE WAS NOT TRUE WHEN IT WAS WRITTEN, and it is true as of 2026-09-18. Both Desk
        writers used a truncating WriteAllText until then, so the justification for holding no lock
        rested on a guarantee nothing provided. The repair was to make the claim true rather than to
        take a lock here: Get-DeskFileEntries reads through Read-AtomicBytes and both writers publish
        by rename.

    .DESCRIPTION
        DELIBERATELY NOT REGISTRY-LOCKED, unlike the cross-seat scan below. That one exists because
        a decision made over MANY seats must see them all at one instant; this answers about one
        seat, which is exactly what an atomic replacement already guarantees. Adding the assertion
        would make every reader of a single Desk an ordered-lock holder for no consistency gained.

        PLAIN STRINGS, AND THAT IS THE POINT OF HAVING IT AT ALL. Every Get-Content line carries
        PSPath, PSProvider and the rest, and PSProvider reaches the whole provider graph -- which on
        this machine lists the NAS. Retire-Seat.ps1 paid a session for handing those to
        ConvertTo-Json, and this reader is what stops the next caller re-deriving the same trap.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][ValidateSet('books', 'projects')][string]$Kind
    )
    @(Get-DeskFileEntries -Path (Get-DeskFilePath -StateDirectory $StateDirectory -Seat $Seat -Kind $Kind))
}

function Get-DeskEntriesAcrossSeats {
    <# Every seat's Desk lines of one kind, as {seat, entries}. Caller holds the registry lock. #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][ValidateSet('books', 'projects')][string]$Kind
    )
    Assert-SeatRegistryLockHeld -Workspace $Workspace -Operation 'Scanning every seat''s Desk' | Out-Null
    $rows = [Collections.Generic.List[object]]::new()
    foreach ($seat in @(Get-SeatDirectoryNames -StateDirectory $StateDirectory)) {
        $entries = @(Get-DeskFileEntries -Path (Get-DeskFilePath -StateDirectory $StateDirectory -Seat $seat -Kind $Kind))
        [void]$rows.Add([pscustomobject]@{ seat = $seat; entries = $entries })
    }
    @($rows)
}

function Get-SeatsHoldingEntry {
    <#
    .SYNOPSIS
        The seats whose Desk names this entry. Empty means nothing anywhere has it open. Caller
        holds the registry lock.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][ValidateSet('books', 'projects')][string]$Kind,
        [Parameter(Mandatory = $true)][string]$Entry
    )
    Assert-SeatRegistryLockHeld -Workspace $Workspace -Operation "Asking which seats hold '$Entry'" | Out-Null
    @(@(Get-DeskEntriesAcrossSeats -Workspace $Workspace -StateDirectory $StateDirectory -Kind $Kind) |
        Where-Object { $Entry -cin @($_.entries) } | ForEach-Object { $_.seat })
}

function Update-DeskEntryAcrossSeats {
    <#
    .SYNOPSIS
        Rewrite one Desk entry at EVERY seat that holds it. Caller holds the registry lock.

    .DESCRIPTION
        Rename's half of step 27. Rewriting only the current seat leaves every other seat pointing at
        a slug that no longer exists -- and worse, at one a future Book could occupy, which would
        hand that seat read access to a Book nobody opened there.

        Each Desk is written by ATOMIC REPLACEMENT, so a seat whose session reads its Desk during the
        sweep sees the whole old file or the whole new one.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][ValidateSet('books', 'projects')][string]$Kind,
        [Parameter(Mandatory = $true)][string]$From,
        [string]$To
    )
    Assert-SeatRegistryLockHeld -Workspace $Workspace -Operation "Rewriting '$From' on every seat's Desk" | Out-Null
    $changed = [Collections.Generic.List[string]]::new()
    foreach ($row in @(Get-DeskEntriesAcrossSeats -Workspace $Workspace -StateDirectory $StateDirectory -Kind $Kind)) {
        if ($From -cnotin @($row.entries)) { continue }
        $rewritten = if ([string]::IsNullOrWhiteSpace($To)) {
            @(@($row.entries) | Where-Object { $_ -cne $From })
        }
        else {
            @(@($row.entries) | ForEach-Object { if ($_ -ceq $From) { $To } else { $_ } })
        }
        $path = Get-DeskFilePath -StateDirectory $StateDirectory -Seat $row.seat -Kind $Kind
        $body = if (@($rewritten).Count) { (@($rewritten) -join "`n") + "`n" } else { '' }
        Write-AtomicText -Path $path -Text $body | Out-Null
        [void]$changed.Add($row.seat)
    }
    @($changed)
}

function Set-DeskEntryForSeat {
    <#
    .SYNOPSIS
        Add or remove ONE Desk entry at ONE named seat, with the registry lock already held.
        Returns $true when the file changed.

    .DESCRIPTION
        The lock-held route Set-VirtualDesk.ps1 cannot be for a caller that already holds the
        registry lock: that helper takes the same non-reentrant lock itself, so a helper shelling
        out to it from inside the lock would wait on itself forever. Remove-ShelfBook.ps1 did
        exactly that shelling-out, which is how a deletion came to close only the CALLER's Desk
        while foreign seats kept an entry entitling them to whatever Book landed on the slug next.

        THIS FUNCTION DOES NOT CHECK THE CLAIM, deliberately. The claim answers "may this session
        change things at this seat", which is the caller's question and belongs at the caller, where
        desk.claim-coverage can see it -- a claim assertion buried in this file would be invisible to
        that check, since it skips its own declaring file.

        Atomic replacement, like the cross-seat sweep above, so a session reading its Desk mid-write
        sees the whole old file or the whole new one.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][ValidateSet('books', 'projects')][string]$Kind,
        [Parameter(Mandatory = $true)][string]$Entry,
        [Parameter(Mandatory = $true)][ValidateSet('Add', 'Remove')][string]$Action
    )
    Assert-SeatRegistryLockHeld -Workspace $Workspace -Operation "Writing seat '$Seat' Desk entry '$Entry'" | Out-Null
    $path = Get-DeskFilePath -StateDirectory $StateDirectory -Seat $Seat -Kind $Kind
    $entries = @(Get-DeskEntriesForSeat -StateDirectory $StateDirectory -Seat $Seat -Kind $Kind)
    $updated = if ($Action -ceq 'Remove') { @(@($entries) | Where-Object { $_ -cne $Entry }) }
               elseif ($Entry -cin @($entries)) { @($entries) }
               else { @($entries) + @($Entry) }
    # Compared as joined text rather than by Count: Add is a no-op when the entry is already there,
    # and both sides keep their order, so one case-sensitive string comparison answers exactly
    # "would this write change the file".
    if ((@($entries) -join "`n") -ceq (@($updated) -join "`n")) { return $false }
    $body = if (@($updated).Count) { (@($updated) -join "`n") + "`n" } else { '' }
    Write-AtomicText -Path $path -Text $body | Out-Null
    $true
}

# --- Fixtures go through the real path, never a retyped copy --------------------------------------

function Initialize-SeatForFixture {
    <#
    .SYNOPSIS
        Give a fixture workspace a real seat. Used by every self-test that needs Desk state.

    .DESCRIPTION
        THE SAME REASON Initialize-ShelfCatalogForFixture EXISTS. A fixture that composes
        `.claude/.open-books` itself keeps passing while the real layout moves underneath it -- and
        this is not hypothetical: three suites failed the moment the guard became seat-aware,
        because every one of them wrote the pre-seat path by hand. Fixtures resolve their Desk
        through Get-DeskFilePath like production does, so a fixture cannot pass against a layout
        production no longer uses.

        -SeatId ARRIVED 2026-09-10, AND ITS DEFAULT IS THE OLD BEHAVIOUR. Omitted, the entry carries
        no `seat_id` at all -- the PRE-IDENTITY shape, which is what every existing caller wants and
        what the two-seat suite is about. A suite that needs incarnations to differ passes one, and
        the rows it then writes get their ids from the real Set-NotebookTopicOwner reading this real
        entry. The alternative was each such suite hand-writing a registry entry, which is the second
        copy of the layout this helper exists to prevent.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [string]$Seat = 'fixture',
        [string]$Project = 'fixture',
        [string]$SeatId = '',
        [string[]]$OpenBooks = @(),
        [string[]]$OpenProjects = @()
    )
    New-SeatDirectory -StateDirectory $StateDirectory -Seat $Seat | Out-Null
    # Through BookRootSchema's fixture entry point, not a second copy of the same two writes.
    $bookBody = if (@($OpenBooks).Count) { (@($OpenBooks) -join "`n") + "`n" } else { '' }
    $projectBody = if (@($OpenProjects).Count) { (@($OpenProjects) -join "`n") + "`n" } else { '' }
    Initialize-FixtureDesk -StateDirectory $StateDirectory -Seat $Seat -Books $bookBody -Projects $projectBody | Out-Null
    # EVERY SEAT IS REGISTERED, NOT JUST THE FIRST. Until 2026-09-09 this wrote the registry only when
    # the file did not exist, so a fixture that called it twice got one seat on disk and in the
    # registry and a second on disk alone -- a shape no production path can produce, and one that
    # makes a helper answer "there is no seat named beta" about a seat whose Desk is right there. The
    # two-seat suite never saw it because it writes its own registry; the first caller that did not
    # spent a debugging round on it. Idempotent by seat name, so repeated calls stay safe.
    $registry = Read-SeatRegistry -StateDirectory $StateDirectory
    if ($null -eq (Get-SeatEntry -Registry $registry -Seat $Seat)) {
        $entry = [ordered]@{ seat = $Seat; project = $Project; created_utc = [DateTime]::UtcNow.ToString('o') }
        # OMITTED WHEN EMPTY, never written blank: absence is the one spelling of "recorded before
        # incarnations existed", exactly as it is on an ownership row and in an archive record.
        if (-not [string]::IsNullOrWhiteSpace($SeatId)) { $entry['seat_id'] = $SeatId }
        $seats = @(@($registry.seats) + [pscustomobject]$entry)
        Write-SeatRegistry -StateDirectory $StateDirectory -Registry ([pscustomobject]@{ schema = 1; seats = $seats })
    }
    Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat
}

function Enter-FixtureSeatClaim {
    <#
    .SYNOPSIS
        Hold a fixture's seat claim for the life of the test process, idempotently.

    .DESCRIPTION
        A suite that drives a MUTATOR has to hold a claim, because mutators require one (step 15b).
        Holding it is the faithful test rather than an exemption.

        IDEMPOTENT, AND THAT IS THE WHOLE REASON THIS IS A FUNCTION. The first version put the claim
        in a local variable inside a suite's `New-Fixture`, which is called repeatedly: the handle
        fell out of scope on return and was finalised, so the claim died between fixtures and every
        mutation after the first was refused. `$script:` here is the DOT-SOURCING CALLER's scope, so
        the handle lives as long as the test process -- which is exactly what a claim is.
    #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [string]$Seat = 'fixture')
    # Test-Path variable:, not `$null -ne`: under Set-StrictMode -Version Latest, READING a variable
    # that has never been assigned throws rather than yielding $null, so the first call could not ask
    # about its own cache. This is defect family 4 in .claude/rules/library-development.md, in its
    # other direction.
    if (Test-Path 'variable:script:FixtureSeatClaim') { Exit-SeatClaim -Claim $script:FixtureSeatClaim }
    $script:FixtureSeatClaim = Enter-SeatClaim -StateDirectory $StateDirectory -Seat $Seat
    $env:LIBRARY_SEAT_CLAIM = $script:FixtureSeatClaim.token
    $script:FixtureSeatClaim
}

function Exit-FixtureSeatClaim {
    <#
    .SYNOPSIS
        Release the fixture's claim so its directory can be removed.

    .DESCRIPTION
        A claim is an open file handle held with FileShare::Read, which is exactly why it survives a
        crash and cannot be faked -- and exactly why a fixture holding one cannot be deleted. A suite
        that rebuilds its fixture must let go first. Safe to call when no claim is held.
    #>
    if (Test-Path 'variable:script:FixtureSeatClaim') {
        Exit-SeatClaim -Claim $script:FixtureSeatClaim
        Remove-Variable -Name 'FixtureSeatClaim' -Scope Script -ErrorAction SilentlyContinue
    }
    $env:LIBRARY_SEAT_CLAIM = ''
}

function Set-FixtureDeskLines {
    <# Write one Desk file's lines through the real resolver. #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][ValidateSet('books', 'projects')][string]$Kind,
        [AllowEmptyCollection()][string[]]$Lines = @()
    )
    $path = Get-DeskFilePath -StateDirectory $StateDirectory -Seat $Seat -Kind $Kind
    $body = if (@($Lines).Count) { (@($Lines) -join "`n") + "`n" } else { '' }
    Write-AtomicText -Path $path -Text $body | Out-Null
    $path
}
