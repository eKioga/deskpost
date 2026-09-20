[CmdletBinding()]
param(
    [string]$StateDirectory,
    [string]$WorkspacePath,
    # Fixtures name the seat and the agent explicitly; an ordinary session names neither and both are
    # resolved -- the seat from this process's binding, the agent from CLAUDE_PID.
    [string]$Seat,
    [int]$AgentProcessId = -1,
    # Step 0d measured the registry lock refusing at 2108 ms against a held lock, and a real Desk
    # write holds it for under a millisecond. Two seconds is a bind that degrades to the roster
    # rather than a reader's first turn hanging on another seat.
    [double]$DeadlineSeconds = 2,
    [Parameter(ValueFromPipeline = $true)]
    [string]$InputJson,
    [string]$InputJsonBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
    THE ONE-CLICK HALF OF SITTING DOWN AT A SEAT. `PLAN-seat-launch.md` step 9.

    THE PROBLEM IT CLOSES. Orca's Claude button starts a bare agent, so the session it produces holds
    no seat: it can read the Library's own files and open nothing. The reader's alternative was five
    steps and two remembered names at a terminal. This hook is what makes the button enough -- it
    notices at session start that there is no seat, hands the Librarian the roster and the
    instruction to ask, and on a RESUMED conversation puts the reader back at the seat that
    conversation last held, without asking, if it is still free.

    IT HOLDS NO RULE OF ITS OWN (ADR-0014). The instruction is a named section of docs/seats.md,
    served verbatim; `seats.session-start-section-resolves` fails the gate if that heading is
    renamed, which is the failure mode a hook carrying its own copy cannot have. What this file adds
    to the served text is STATE -- which seats exist, which are free -- and state is the one thing a
    tracked document must not hold, because a written roster is stale the moment a seat is created.

    IT DECIDES NOTHING AND AUTHORISES NOTHING (ADR-0018). The re-bind on resume goes through
    `tools/Enter-LibrarySeat.ps1`, which applies the operation-by-state matrix exactly as it would
    for a seat the reader typed: a held seat refuses, an orphan belonging to another agent refuses,
    and this hook reports the refusal rather than working around it. A conversation id LOCATES a
    seat here and never authorises one.

    ITS FAILURE IS THE ROSTER, NEVER A BLOCKED SESSION (step 0d, risk 6). Every path out of the
    catch block below emits guidance or nothing; there is no path that denies, and none that exits
    non-zero. A lock it cannot take within the deadline, a helper that will not run, a binding it
    cannot parse -- each degrades to the roster with one line saying which, because a reader whose
    first turn hangs on another seat's Desk write is worse off than a reader who is asked a question.

    WHY IT IS A SECOND FILE RATHER THAN A REWRITE OF Restore-CompactedGuidance.ps1. That hook is
    registered on SessionStart too, and step 9 was written as a rewrite of it. It is not one, for a
    reason that only appeared on reading: the two jobs share an event and nothing else, and folding
    them together would have meant renaming that file -- whose name is quoted in
    docs/adr/0014-a-hook-delivers-a-document-it-does-not-hold-a-rule.md, a decision record, which is
    history and is not edited to follow a later rename. Its two measured faults (`startup_reason`
    for `source`, `systemMessage` for `additionalContext`) are fixed in place instead, and this file
    reads the same `source` field for its own table.
#>

. (Join-Path $PSScriptRoot 'HookContext.ps1')
# THE CODE AND THE DOCUMENT COME FROM THE CHECKOUT THIS HOOK SHIPS WITH; THE STATE COMES FROM
# -WorkspacePath. In an ordinary session the two are the same directory, which is exactly why the
# first version of this file composed `<workspace>/tools/Enter-LibrarySeat.ps1` and nothing noticed:
# it is right in production and wrong everywhere else, and the first fixture run failed on it with a
# refusal that read as a seat problem. The helper is a SIBLING of this hook, and so is the section it
# serves; a workspace is data.
$script:LibraryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# LibrarySeat.ps1 brings BookRootSchema.ps1 with it. Measured cost of the extra dot-source: 37 ms on
# top of a 159 ms process start, against a two-second deadline.
. (Join-Path $script:LibraryRoot (Join-Path 'tools' 'LibrarySeat.ps1'))

$paragraphs = [Collections.Generic.List[string]]::new()
function Add-Paragraph([string]$Text) {
    if (-not [string]::IsNullOrWhiteSpace($Text)) { [void]$paragraphs.Add($Text.TrimEnd()) }
}

# ONE SEAT'S LIVENESS, OR A NAMED FAILURE TO READ IT. A seat whose binding cannot be parsed must not
# take the whole roster down with it: the roster is what a reader acts on, and "I could not read
# seat X" is an answer while an empty roster is a wrong one.
#
# THIS CATCH IS REACHABLE, WHICH IS WHY IT IS HERE. It looks redundant beside Resolve-SeatName, which
# fails closed on a binding it cannot read -- but Get-SeatBindingForAgent returns before reading ANY
# binding when this process has no agent identity, which is precisely the seatless case that gets a
# roster. So a corrupt binding is invisible at resolution and lands here instead.
function Get-SeatStateLabel([string]$SeatName, [int]$AgentPid) {
    try {
        $state = Get-SeatClaimState -StateDirectory $StateDirectory -Seat $SeatName -AgentProcessId $AgentPid
        $label = [string]$state.state
        if ($label -ceq 'held' -and [bool]$state.this_agent) { return 'held by this conversation' }
        if ($label -ceq 'orphaned') { return 'orphaned (agent alive, claim holder gone)' }
        return $label
    }
    catch { return "unreadable: $($_.Exception.Message)" }
}

function Get-SeatRoster([int]$AgentPid) {
    $registry = Read-SeatRegistry -StateDirectory $StateDirectory
    $entries = @(@($registry.seats) | Sort-Object -Property @{ Expression = { [string]$_.seat } })
    if (-not $entries.Count) {
        return 'No seat exists in this checkout yet. Ask the reader what they are working on, then create the first seat with the confirmed route above.'
    }
    $rows = @($entries | ForEach-Object {
        $seatName = [string]$_.seat
        $activity = Read-SeatActivity -StateDirectory $StateDirectory -Seat $seatName
        $lastSeen = ''
        if ($null -ne $activity) {
            $activityFields = @($activity.PSObject.Properties | ForEach-Object { $_.Name })
            if ($activityFields -ccontains 'last_seen_utc') { $lastSeen = "  last active $([string]$activity.last_seen_utc)" }
        }
        "  $seatName  ->  project $([string]$_.project)  [$(Get-SeatStateLabel $seatName $AgentPid)]$lastSeen"
    })
    "The seats in this checkout, read now rather than remembered:`n" + ($rows -join "`n")
}

try {
    if (-not $StateDirectory) { $StateDirectory = Split-Path -Parent $PSScriptRoot }
    if (-not $WorkspacePath) { $WorkspacePath = Split-Path -Parent $StateDirectory }
    $call = Read-HookPayload -BoundParameters $PSBoundParameters -InputJson $InputJson -InputJsonBase64 $InputJsonBase64

    # `source`, MEASURED (step 0c). The sibling hook read `startup_reason` for four days and never
    # fired once; this one is written against a captured payload from the start.
    $source = [string](Get-HookField $call 'source')
    $sessionId = [string](Get-HookField $call 'session_id')

    $agentPid = if ($AgentProcessId -ge 0) { $AgentProcessId } else { Get-CurrentAgentProcessId }
    $resolution = Resolve-SeatName -Seat $Seat -StateDirectory $StateDirectory -AgentProcessId $agentPid

    # A BINDING IS THE ONLY THING THAT COUNTS AS BOUND. `LIBRARY_SEAT` names a seat and authenticates
    # nothing, so a launcher-started session is neither bound nor seatless: it has a Desk and a claim
    # held by the launcher, and offering it the roster would be telling it to leave a seat it is
    # already working at.
    $boundSeat = if ($resolution.status -ceq 'named' -and $resolution.source -ceq 'binding') { [string]$resolution.seat } else { '' }

    if ($resolution.status -ceq 'malformed') {
        # NO ROSTER HERE. Seat state that cannot be trusted is exactly when a list of seats would be
        # a claim rather than a report, and the resolver's own message already names the fix.
        Add-Paragraph ('Seat state at session start: ' + [string]$resolution.message)
    }
    elseif ($boundSeat) {
        # ==== BOUND TO A SEAT =====================================================================
        # Reachable at `compact` and `clear`, which fire inside a live process, and by a fixture. A
        # `startup` or `resume` mints a new process, which by construction holds no binding yet.
        if ($source -cne 'compact') {
            Add-Paragraph "Virtual Desk: seat '$boundSeat' is bound to this conversation, verified by process identity."
        }
        if ($source -ceq 'resume') {
            # THE CROSS-SEAT RESUME INFORMS AND NEVER MOVES. One agent process holds one seat for its
            # life, so a conversation that last sat elsewhere cannot be carried over -- saying so is
            # the whole of what this row does. Read before the record below out of habit rather than
            # necessity now: until step 8 landed this read the BINDING, which the record was about to
            # overwrite; `conversations.json` keeps both seats and does not prune, so the fact being
            # reported survives the write either way.
            $elsewhere = @(@(Get-SeatsForConversation -StateDirectory $StateDirectory -SessionId $sessionId) |
                Where-Object { [string]$_.seat -cne $boundSeat })
            if ($elsewhere.Count) {
                Add-Paragraph ("This conversation last sat at seat '$([string]$elsewhere[0].seat)'; it is at '$boundSeat' now. " +
                    'One agent process holds one seat for its life, so nothing moves: end this conversation and start a new one ' +
                    'if the other seat is the one you want.')
            }
        }
        # RECORDED IDEMPOTENTLY, and the shared function decides whether there is anything to write.
        # Reachable at `clear`, which mints a conversation inside a process whose binding still names
        # the one before it. Its failure costs the resume lookup and nothing else, so it is swallowed.
        try {
            Update-SeatConversationRecord -Workspace $WorkspacePath -StateDirectory $StateDirectory -Seat $boundSeat `
                -AgentProcessId $agentPid -SessionId $sessionId -DeadlineSeconds $DeadlineSeconds | Out-Null
        }
        catch { }
    }
    elseif ($resolution.status -ceq 'named') {
        # Named by LIBRARY_SEAT or by an explicit -Seat: a name, not a verified binding.
        if ($source -cne 'compact') {
            Add-Paragraph ("Virtual Desk: seat '$([string]$resolution.seat)', named by the environment rather than by a " +
                'verified binding. Its claim is held by whatever started this session.')
        }
    }
    elseif ($source -ceq 'compact') {
        # NOTHING NEW. A compaction inside a seatless session has already been told, on every prompt,
        # by the Desk context hook; repeating it here would spend the reader's context to say what
        # the next line says anyway.
    }
    elseif ($source -ceq 'resume') {
        # ==== RESUMED, AND SEATLESS: the row that makes Orca's Resume put the reader back =========
        # NOT $matches: that is an automatic variable, written by every -match and -cmatch in scope,
        # and Get-MarkdownSection below uses it. Defect family 5 wearing an automatic's clothing.
        $priorSeats = @(Get-SeatsForConversation -StateDirectory $StateDirectory -SessionId $sessionId)
        if (-not $priorSeats.Count) {
            Add-Paragraph 'This conversation is being resumed and holds no seat, and no seat records having been sat at by it.'
            Add-Paragraph (Get-MarkdownSection -Path (Join-Path $script:LibraryRoot 'docs/seats.md') -Heading '## Sitting down at a seat')
            Add-Paragraph (Get-SeatRoster $agentPid)
        }
        else {
            $candidate = $priorSeats[0]
            $wanted = [string]$candidate.seat
            $registry = Read-SeatRegistry -StateDirectory $StateDirectory
            $entry = Get-SeatEntry -Registry $registry -Seat $wanted
            $entrySeatId = ''
            if ($null -ne $entry) {
                $entryFields = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
                if ($entryFields -ccontains 'seat_id') { $entrySeatId = [string]$entry.seat_id }
            }
            $refusal = ''
            if ($null -eq $entry) {
                $refusal = "The seat this conversation last sat at ('$wanted') no longer exists; it has been retired since."
            }
            elseif ($entrySeatId -and [string]$candidate.seat_id -and $entrySeatId -cne [string]$candidate.seat_id) {
                # A DIFFERENT INCARNATION UNDER THE SAME NAME. The slug was reused, so this
                # conversation's material is not the material behind that name now.
                $refusal = "Seat '$wanted' exists but is a different seat under the same name; it was retired and recreated since this conversation sat there."
            }
            else {
                $state = Get-SeatClaimState -StateDirectory $StateDirectory -Seat $wanted -AgentProcessId $agentPid
                switch -CaseSensitive ([string]$state.state) {
                    'free' {
                        # THE ONE WRITE THIS HOOK CAUSES, AND IT CAUSES IT THROUGH THE GATE. Every
                        # refusal the Librarian would be given, this call is given too.
                        $helper = Join-Path $script:LibraryRoot 'tools/Enter-LibrarySeat.ps1'
                        $preference = $ErrorActionPreference
                        $ErrorActionPreference = 'Continue'
                        $output = @()
                        # A CODE THIS CALL ACTUALLY SET. $LASTEXITCODE survives from whatever ran
                        # before, so a helper that never starts would otherwise be read as the
                        # success of some earlier process and announced as a bind that did not happen.
                        $exitCode = 1
                        try {
                            $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper `
                                -Seat $wanted -WorkspacePath $WorkspacePath -AgentProcessId $agentPid `
                                -SessionId $sessionId -DeadlineSeconds $DeadlineSeconds -Json 2>&1)
                            $exitCode = $LASTEXITCODE
                        }
                        finally { $ErrorActionPreference = $preference }
                        if ($exitCode -eq 0) {
                            Add-Paragraph ("Virtual Desk: this conversation was resumed and has been re-bound to the seat it last held, " +
                                "'$wanted' (project $([string]$entry.project)). Its Desk is exactly as it was left.")
                        }
                        else {
                            # THE REFUSAL, NOT THE STACK. A child's `throw` renders its message
                            # followed by `At <path>:<line> char:`, the source line, a CategoryInfo
                            # and a FullyQualifiedErrorId that repeats the message a second time --
                            # roughly 700 characters of PowerShell diagnostics injected into a
                            # reader's first turn. Found by falsification: forcing this path is what
                            # put the blob on screen, and reading the code would not have. The cut is
                            # at the marker PowerShell itself writes, with a length cap behind it for
                            # any renderer that does not write one.
                            $why = ((@($output | ForEach-Object { [string]$_ }) -join ' ') -replace '\s+', ' ').Trim()
                            $stackAt = $why.IndexOf(' At ')
                            if ($stackAt -gt 0) { $why = $why.Substring(0, $stackAt) }
                            if ($why.Length -gt 400) { $why = $why.Substring(0, 400).TrimEnd() + ' [...]' }
                            $refusal = "Seat '$wanted' is the one this conversation last held and it is free, but binding it failed: $why"
                        }
                    }
                    'orphaned' {
                        $refusal = ("Seat '$wanted' is the one this conversation last held. It is bound to agent process " +
                            "$([int]$state.agent_pid), which is still running, and its claim holder is gone -- that is not the same as free. " +
                            'It has to be re-bound from that conversation.')
                    }
                    default {
                        # A launcher-held seat has a live handle and NO binding, so agent_pid is 0.
                        # Printing "process 0" would send the reader looking for a process that has
                        # never existed.
                        $who = if ([int]$state.agent_pid -gt 0) { " (process $([int]$state.agent_pid))" } else { '' }
                        $refusal = "Seat '$wanted' is the one this conversation last held, and another live session is at it now$who."
                    }
                }
            }
            if ($refusal) {
                Add-Paragraph $refusal
                Add-Paragraph (Get-MarkdownSection -Path (Join-Path $script:LibraryRoot 'docs/seats.md') -Heading '## Sitting down at a seat')
                Add-Paragraph (Get-SeatRoster $agentPid)
            }
            elseif ($priorSeats.Count -gt 1) {
                # A conversation resumed in two processes sat at two seats legitimately (D9). The
                # newest is taken and the rest are NAMED rather than silently dropped.
                $others = @(@($priorSeats | Select-Object -Skip 1) | ForEach-Object { "'$([string]$_.seat)'" })
                Add-Paragraph ("This conversation also has a record at $($others -join ', '). The most recent was taken; nothing else moved.")
            }
        }
    }
    else {
        # ==== startup, clear, fork, or a source value the documentation has not named =============
        # Treated as a fresh start, which is the safe default: the worst it costs is a question the
        # reader did not need, and the worst the other default costs is a session that never notices
        # it has no seat.
        Add-Paragraph 'Virtual Desk: this session holds no seat.'
        Add-Paragraph (Get-MarkdownSection -Path (Join-Path $script:LibraryRoot 'docs/seats.md') -Heading '## Sitting down at a seat')
        Add-Paragraph (Get-SeatRoster $agentPid)
    }
}
catch {
    # NEVER BLOCKS, AND NEVER SILENT ABOUT WHY. Anything already gathered is still emitted below.
    Add-Paragraph ("Seat state could not be read at session start, so no roster is offered: $($_.Exception.Message) " +
        'Sit down at a seat with tools/Enter-LibrarySeat.ps1 -Seat <name>, or ask the reader which seat they want.')
}

if ($paragraphs.Count) {
    Write-HookOutput 'SessionStart' @{ additionalContext = (@($paragraphs) -join "`n`n") }
}
exit 0
