[CmdletBinding()]
param(
    [string]$StateDirectory,
    [string]$WorkspacePath,
    [string]$Seat,
    [int]$AgentProcessId = -1,
    # Step 0d: the registry lock refuses at ~2.1 s against a held lock, and this hook runs on every
    # prompt. Two seconds is the recorder below giving up rather than a reader's turn waiting.
    [double]$DeadlineSeconds = 2,
    [string]$InputJson,
    [string]$InputJsonBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The Book-root state schema (plan item 3.2) lives in tools/BookRootSchema.ps1, and this hook reads
# it rather than carrying its own copy of the shape. Every path out of this file's catch block
# fails closed, so a schema that cannot be loaded costs the guard nothing it should have allowed.
#
# LibrarySeat.ps1 RATHER THAN THE SCHEMA ALONE SINCE 2026-09-10 (PLAN-seat-launch.md step 10): the
# status line now distinguishes a bound seat from an orphaned one, and the backstop recorder needs
# the registry lock. It dot-sources the schema, so nothing above changed. Measured cost of the
# difference: 37 ms on top of a 159 ms process start.
$script:LibraryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $script:LibraryRoot (Join-Path 'tools' 'LibrarySeat.ps1'))
. (Join-Path $PSScriptRoot 'HookContext.ps1')

function Read-StateLines([string]$Path, [string]$Pattern, [string]$Label, [switch]$Optional) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if (-not $Optional) { throw "$Label state is missing" }
        Write-AtomicText -Path $Path -Text '' | Out-Null
        return @()
    }
    $items = @(Get-DeskFileEntries -Path $Path)
    foreach ($item in $items) { if ($item -cnotmatch $Pattern) { throw "$Label state is malformed" } }
    if (@($items | Select-Object -Unique).Count -ne $items.Count) { throw "$Label state contains duplicates" }
    $items
}

try {
    if (-not $StateDirectory) { $StateDirectory = Split-Path -Parent $PSScriptRoot }
    if (-not $WorkspacePath) { $WorkspacePath = Split-Path -Parent $StateDirectory }
    $call = Read-HookPayload -BoundParameters $PSBoundParameters -InputJson $InputJson -InputJsonBase64 $InputJsonBase64
    $sessionId = [string](Get-HookField $call 'session_id')
    $agentPid = if ($AgentProcessId -ge 0) { $AgentProcessId } else { Get-CurrentAgentProcessId }
    # THIS HOOK ORIENTS; IT NEVER BLOCKS. A session with no seat is a legitimate state -- reads are
    # unaffected by the claim -- so an unresolvable seat produces guidance rather than an error. The
    # guards are what refuse; saying how to get a Desk is this hook's whole job.
    $seatState = Resolve-SeatName -Seat $Seat -StateDirectory $StateDirectory -AgentProcessId $agentPid
    $deskDirectory = if ($seatState.status -ceq 'named') { Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $seatState.seat } else { $null }
    $deskPresent = ($null -ne $deskDirectory) -and (Test-Path -LiteralPath $deskDirectory -PathType Container)
}
catch {
    $context = 'Virtual Desk state is invalid. Do not read any shared Book or Project content. Only the relevant Catalog may be used until the state is repaired.'
    @{ hookSpecificOutput = @{ hookEventName = 'UserPromptSubmit'; additionalContext = $context } } | ConvertTo-Json -Compress
    exit 0
}

try {
    if ($seatState.status -cne 'named') {
        # THE ANSWER IS A SENTENCE FROM THE READER, NOT A COMMAND THEY HAVE TO LOOK UP. The resolver's
        # own message already names both helpers, which is why nothing is restated here (ADR-0014):
        # what this adds is that the reader may simply say which seat.
        $context = 'Virtual Desk - no seat. ' + $seatState.message +
            ' Until a seat is entered no Book or Project can be opened or read, and nothing in the Library can be changed.' +
            ' Reading the Library''s own files is unaffected. Ask the reader which seat they want and bind it; a plain answer is enough.'
        @{ hookSpecificOutput = @{ hookEventName = 'UserPromptSubmit'; additionalContext = $context } } | ConvertTo-Json -Compress
        exit 0
    }
    if (-not $deskPresent) {
        $context = "Virtual Desk - seat '$($seatState.seat)' has no Desk in this workspace. " +
            "Create it with tools/Start-LibrarySeat.ps1 -Seat $($seatState.seat) -Project <project-slug>."
        @{ hookSpecificOutput = @{ hookEventName = 'UserPromptSubmit'; additionalContext = $context } } | ConvertTo-Json -Compress
        exit 0
    }
    # --- WHO IS AT THIS SEAT, AND IS IT STILL HELD (PLAN-seat-launch.md step 10) -------------------
    #
    # A SEAT NAME IS NOT A SEAT STATE, and until this landed the line said the same thing whether the
    # seat was bound to this conversation by verified identity, inherited from an environment variable
    # nothing had checked, or held by a claim holder that had died half an hour ago. The third is the
    # one that matters: an orphaned seat READS normally and refuses every write, so a session that is
    # not told finds out at the moment it tries to change something.
    $seatNote = ''
    $seatWarning = ''
    if ($seatState.source -ceq 'binding') {
        $seatNote = ', bound to this conversation'
        $claimState = Get-SeatClaimState -StateDirectory $StateDirectory -Seat $seatState.seat -AgentProcessId $agentPid
        if ([string]$claimState.state -ceq 'orphaned') {
            $seatNote = ', holder lost'
            $seatWarning = " This seat's claim holder is gone while this conversation is still bound to it, so every write will refuse." +
                " Re-bind before changing anything: tools/Enter-LibrarySeat.ps1 -Seat $($seatState.seat)."
        }
        # THE BACKSTOP RECORDER. The SessionStart hook records the conversation when it binds one, and
        # this covers every route that did not go through it -- a seat entered by hand mid-session, a
        # conversation cleared inside a live process, a session start whose hook did not run.
        #
        # THE LOCK IS TAKEN ONLY WHEN THERE IS SOMETHING TO WRITE. Update-SeatConversationRecord reads
        # the binding first and returns `already-recorded` without touching an ordered lock, which is
        # every prompt after the first. The ledger is what stops a PERSISTENTLY failing write being
        # retried on every prompt: this hook runs before each turn, and a two-second lock timeout paid
        # every time would be a tax on a reader whose seat state is already wrong.
        try {
            $ledgerKey = "seat-conversation:$($seatState.seat):$sessionId"
            if (-not (Test-HookServed $StateDirectory $sessionId $ledgerKey)) {
                $recorded = Update-SeatConversationRecord -Workspace $WorkspacePath -StateDirectory $StateDirectory `
                    -Seat $seatState.seat -AgentProcessId $agentPid -SessionId $sessionId -DeadlineSeconds $DeadlineSeconds
                if ([string]$recorded -cne 'already-recorded') { Set-HookServed $StateDirectory $sessionId $ledgerKey }
            }
        }
        catch { }
    }
    else {
        # A NAME, NOT A VERIFIED BINDING (ADR-0018). Said plainly rather than left to look identical
        # to the line above, because a resumed conversation cannot find this seat again -- nothing
        # recorded it. The two unbound sources are worded apart: `environment` is what a
        # launcher-started session inherits, and `explicit` is a one-shot run that named its own seat,
        # and a reader told the wrong one looks for the wrong thing to change.
        $namedBy = if ($seatState.source -ceq 'environment') { 'named by LIBRARY_SEAT' } else { 'named explicitly' }
        $seatNote = ", $namedBy and not bound to this conversation"
    }

    $openBooks = @(Read-StateLines -Path (Get-DeskFileInDirectory -DeskDirectory $deskDirectory -Kind 'books') -Pattern (Get-BookRootAcceptPattern) -Label 'open-book' |
        ForEach-Object { Get-BookRootLabel $_ })
    $openProjects = @(Read-StateLines -Path (Get-DeskFileInDirectory -DeskDirectory $deskDirectory -Kind 'projects') -Pattern '^(projects|archive/projects)/[a-z0-9][a-z0-9-]*$' -Label 'open-project' -Optional)
    $books = if ($openBooks.Count) { $openBooks -join ', ' } else { '(none)' }
    $projects = if ($openProjects.Count) { $openProjects -join ', ' } else { '(none)' }
    # NAMING THE CALLABLE TOOL, NOT JUST THE RULE. "through the validated reader" is a rule a
    # session can only obey if it knows the reader is actually connected, and a lazily discoverable
    # MCP tool looks exactly like a missing connection -- a Codex session rooted here mistook one
    # for the other and went looking for another way in. So the capability is advertised by its
    # exact callable name. The prefix is mcp__validated-book-reader__, with hyphens: that is the
    # server name in BOTH .mcp.json and .codex/config.toml, and this one hook serves both clients.
    #
    # Advertised for the kind of material actually OPEN, because a tool named for nothing open is
    # noise the reader pays for on every prompt. This widens no boundary: every tool named here
    # serves open material only and enforces the Desk gate itself, and the catch block below still
    # advertises nothing at all, because a session that cannot trust the Desk state must not be
    # handed a reader to use against it.
    $readerCalls = [Collections.Generic.List[string]]::new()
    if ($openBooks.Count) { [void]$readerCalls.Add('mcp__validated-book-reader__read_open_book_page for an open Book') }
    if ($openProjects.Count) { [void]$readerCalls.Add('mcp__validated-book-reader__read_open_project_page for an open Project Hub') }
    $capability = if ($readerCalls.Count) {
        ' The validated reader is connected: call ' + ($readerCalls -join ', ') + '.'
    } else {
        ' The validated reader is connected: call mcp__validated-book-reader__read_book_catalog or mcp__validated-book-reader__read_project_catalog to see what could be opened.'
    }
    $context = "Virtual Desk (seat $($seatState.seat)$seatNote) - Books: $books. Projects: $projects. Read Book and Project pages only through the validated reader, and only these open ones. Shelf Book pages are not readable with the Read tool while closed.$capability$seatWarning"
}
catch {
    $context = 'Virtual Desk state is invalid. Do not read any shared Book or Project content. Only the relevant Catalog may be used until the state is repaired.'
}
@{ hookSpecificOutput = @{ hookEventName = 'UserPromptSubmit'; additionalContext = $context } } | ConvertTo-Json -Compress
