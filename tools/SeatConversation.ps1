<#
.SYNOPSIS
    Which conversation a seat last recorded, and what that conversation is called. Dot-sourced by
    `tools/SeatPicker.ps1` and by `tools/Get-DeskOverview.ps1`; never invoked directly.

.DESCRIPTION
    WHY THIS IS ITS OWN FILE, AND IT IS THE DEFECT FAMILY RATHER THAN A TIDY-UP. Two surfaces now
    answer "which conversation was last at this seat, and is that record the verified binding or the
    launcher's advisory one": the terminal picker's roster (`PLAN-seat-launch.md` step 12) and this
    seat's own line on the Desk overview (step 14). The rule is subtle in two places -- the NEWER of
    two records wins rather than the more trusted one, and six ways a title can be missing are six
    different facts about the same blank column -- and this repository has already paid for the same
    rule written twice: the registry-lock rule was restated in prose four times and all four were
    wrong. So the derivation and the WORDING live here once, and each surface renders its own shape
    around them.

    WHAT EACH SURFACE RENDERS FOR ITSELF, deliberately. The picker draws a numbered roster line whose
    columns are measured across every seat; the overview emits one seat in full as a result object.
    Those are different shapes and sharing them would mean one surface pretending to be the other.
    What is NOT re-derived is `Get-SeatConversationRecord`, `Get-SeatConversationTitle` and
    `Format-SeatConversationCell` -- the facts, and the never-blank sentence that reports them.

    AND THE OVERVIEW MUST NOT USE THE PICKER'S ROW BUILDER, which is the load-bearing reason this
    split is not simply "call the picker". `Get-SeatPickerRows` reads a title for EVERY registered
    seat, because a reader at a terminal is choosing between them. The overview's cosmetic tier
    (locked 2026-09-07) says another seat stays counts and liveness only, so calling that builder
    there would put another reader's conversation title on this Desk. Case 20 of `seat.lifecycle`
    plants a titled conversation at a foreign seat and asserts the overview never says its name.

    WHERE A TITLE COMES FROM, WHICH THE PLAN LEFT OPEN AND A MEASUREMENT ANSWERED. A binding carries
    no title, so the transcript is the only source. Measured over the 165 transcripts in this
    checkout's project directory on 2026-09-10: 92 carry one or more `{"type":"ai-title"}` records
    and 73 carry none (every one of those written by Claude Code 2.1.229 to 2.1.260, so an absent
    title is an older client rather than an untitled conversation). In not one of the 92 did the
    title CHANGE within a session, so the first record is as good as the last. The first one sits at
    line 13 and 29 KB into the file at the median, and at worst at line 282 and 682 KB -- so a
    bounded head read finds every title that exists, and the bound is what the line reports when it
    finds none. A title that cannot be had is SAID on the line rather than left blank, because a
    blank column reads as an untitled conversation and this cannot tell one from an old client.

    THIS FILE ANSWERS "WHICH CONVERSATION WAS LAST AT THIS SEAT", WHICH IS NOT THE QUESTION
    `conversations.json` ANSWERS. That record landed on 2026-09-10 (plan step 8) and is a history of
    which seats one CONVERSATION has sat at, read newest-first by the resume lookup. This is the
    other direction, for display, and it stays on the two records that are always current: whichever
    of the binding's own `session_id` and the launcher's advisory one is newer -- and the caller says
    which. Deriving it from the history instead would answer with whatever conversation touched the
    seat last even after another agent bound it, which is the opposite of what a Desk line means.

    EVERY READ HERE IS ADVISORY AND TAKES NO LOCK. `activity.json` is lock-free and never a lease,
    and a transcript belongs to a tool this repository does not own. So nothing derived here gates
    anything: the picker's acquisition refuses atomically and the overview is a read.
#>

Set-StrictMode -Version Latest

# Read-SeatActivity and Read-SeatBinding, which are the two records this file compares. LibrarySeat
# brings BookRootSchema with it, so a caller that dot-sources only this file still has both.
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')

# --- The transcript, which is the only place a conversation title exists ---------------------------

# THE BOUND IS DERIVED FROM A MEASUREMENT AND STATED WHERE IT IS SPENT (see the measurement in this
# file's header): worst observed first title at line 282 and 682 KB, so these are roughly 7x and 6x
# the worst real case. Exhausting either is reported as its own status rather than as "no title",
# because "this client wrote none" and "we stopped looking" are different facts about the same
# blank column.
$script:SeatTranscriptLineBudget = 2000
$script:SeatTranscriptByteBudget = 4194304

# A conversation id is DATA -- it arrives from a binding file and from an advisory record, both of
# which anything with write access to `.claude` can author -- and it is about to be composed into a
# file path and passed to `claude --resume`. So it is validated by shape before either happens.
$script:SeatConversationIdPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

function Test-SeatConversationId {
    param([string]$SessionId)
    if ([string]::IsNullOrWhiteSpace($SessionId)) { return $false }
    [bool]($SessionId -cmatch $script:SeatConversationIdPattern)
}

function New-SeatConversationId {
    <# A minted conversation id for `claude --session-id`, in the dashed lowercase form it takes. #>
    [guid]::NewGuid().ToString()
}

function Get-SeatTranscriptRoot {
    <#
    .SYNOPSIS
        The directory Claude Code keeps conversation transcripts under, honouring
        `CLAUDE_CONFIG_DIR`.

    .DESCRIPTION
        THE REDIRECTED HOME IS THE WHOLE REASON THIS IS A FUNCTION. A reader with
        `CLAUDE_CONFIG_DIR` set keeps transcripts somewhere else entirely, and a picker that read
        `~/.claude` regardless would report "no transcript found" for every conversation they have
        ever had -- one tool's negative standing in for absence.
    #>
    param([string]$ConfigDirectory)
    if ([string]::IsNullOrWhiteSpace($ConfigDirectory)) { $ConfigDirectory = [string]$env:CLAUDE_CONFIG_DIR }
    if ([string]::IsNullOrWhiteSpace($ConfigDirectory)) { $ConfigDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude' }
    Join-Path $ConfigDirectory 'projects'
}

function Get-SeatTranscriptPath {
    <#
    .SYNOPSIS
        The transcript for one conversation id, or `$null`.

    .DESCRIPTION
        FOUND BY NAME ACROSS THE PROJECT DIRECTORIES RATHER THAN BY COMPOSING ONE. Claude Code
        derives a project directory from the workspace path by a mangling rule it does not document
        -- `D:\Library` becomes `D--Library` -- and a picker that reimplemented that rule would be a
        lookalike of the consumer whose files it is reading. A conversation id is a uuid, so the file
        NAME is unique across every project directory: looking for that name is the same answer
        without the guess, and it still finds the transcript of a workspace that has since been
        renamed or reached through a different path.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$TranscriptRoot,
        [Parameter(Mandatory = $true)][string]$SessionId
    )
    if (-not (Test-SeatConversationId -SessionId $SessionId)) { return $null }
    if (-not (Test-Path -LiteralPath $TranscriptRoot -PathType Container)) { return $null }
    $fileName = "$SessionId.jsonl"
    foreach ($directory in @(Get-ChildItem -LiteralPath $TranscriptRoot -Directory -Force -ErrorAction SilentlyContinue)) {
        $candidate = Join-Path $directory.FullName $fileName
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $null
}

function Get-SeatConversationTitle {
    <#
    .SYNOPSIS
        The title of one conversation, with a DISTINCT status for every way it can be absent:
        `titled`, `no-conversation`, `malformed-conversation`, `no-transcript-root`, `no-transcript`,
        `no-title`, `budget-exhausted`, `unreadable`.

    .DESCRIPTION
        EIGHT STATUSES RATHER THAN A TITLE-OR-BLANK, because each sends the reader somewhere else: an
        old client wrote none, this configuration has no transcript for that id, the file is there and
        unreadable, or nothing recorded a conversation at that seat in the first place. A single
        empty string would have collapsed all four into the answer that happens to be commonest.

        THE FILE IS OPENED SHARED FOR WRITING. The transcript of the conversation being displayed may
        be the reader's own live one, held open by the agent that is writing it; an exclusive open
        would report `unreadable` for exactly the newest row.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$TranscriptRoot,
        [string]$SessionId
    )
    $answer = [ordered]@{
        status = 'no-conversation'; title = ''; path = ''
        scanned_lines = 0; scanned_bytes = 0; reason = ''
    }
    if ([string]::IsNullOrWhiteSpace($SessionId)) {
        $answer['reason'] = 'nothing has recorded a conversation at this seat'
        return [pscustomobject]$answer
    }
    if (-not (Test-SeatConversationId -SessionId $SessionId)) {
        $answer['status'] = 'malformed-conversation'
        $answer['reason'] = 'the recorded conversation id is not a uuid, so no transcript was looked for'
        return [pscustomobject]$answer
    }
    if (-not (Test-Path -LiteralPath $TranscriptRoot -PathType Container)) {
        $answer['status'] = 'no-transcript-root'
        $answer['reason'] = "no transcript directory at $TranscriptRoot"
        return [pscustomobject]$answer
    }
    $path = Get-SeatTranscriptPath -TranscriptRoot $TranscriptRoot -SessionId $SessionId
    if ($null -eq $path) {
        $answer['status'] = 'no-transcript'
        # A TRANSCRIPT NOT FOUND IS NOT A DELETED TRANSCRIPT (plan step 8, round 2 #10). A different
        # CLAUDE_CONFIG_DIR, a different machine or a pruned history all land here, so this says what
        # was searched rather than that the conversation is gone.
        $answer['reason'] = 'no transcript for it under this configuration'
        return [pscustomobject]$answer
    }
    $answer['path'] = $path

    $lines = 0
    $bytes = 0
    $title = ''
    # WHETHER THE FILE ENDED, not whether the budget was reached. A transcript of exactly the budget's
    # length with no title has been read WHOLE, and reporting it as "we stopped looking" would be a
    # different fact about the same blank column.
    $reachedEnd = $false
    $stream = $null
    $reader = $null
    try {
        $stream = [IO.FileStream]::new($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false), $true)
        while ($lines -lt $script:SeatTranscriptLineBudget -and $bytes -lt $script:SeatTranscriptByteBudget) {
            $line = $reader.ReadLine()
            if ($null -eq $line) { $reachedEnd = $true; break }
            $lines++
            $bytes += $line.Length
            # THE MARKER TEST BEFORE THE PARSE, and it is not an optimisation for its own sake: a
            # transcript line is a whole assistant turn, tens of kilobytes of it, and parsing every
            # one of them would make a five-seat roster cost seconds.
            if ($line.IndexOf('"ai-title"') -lt 0) { continue }
            $record = $null
            try { $record = $line | ConvertFrom-Json } catch { continue }
            if ($null -eq $record) { continue }
            $fields = @($record.PSObject.Properties | ForEach-Object { $_.Name })
            if ($fields -cnotcontains 'type' -or [string]$record.type -cne 'ai-title') { continue }
            if ($fields -cnotcontains 'aiTitle') { continue }
            $candidate = [string]$record.aiTitle
            if (-not [string]::IsNullOrWhiteSpace($candidate)) { $title = $candidate.Trim() }
        }
    }
    catch {
        $answer['status'] = 'unreadable'
        $answer['reason'] = "its transcript could not be read: $($_.Exception.Message)"
        $answer['scanned_lines'] = $lines
        $answer['scanned_bytes'] = $bytes
        return [pscustomobject]$answer
    }
    finally {
        if ($null -ne $reader) { $reader.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }

    $answer['scanned_lines'] = $lines
    $answer['scanned_bytes'] = $bytes
    if ($title) {
        $answer['status'] = 'titled'
        $answer['title'] = $title
        return [pscustomobject]$answer
    }
    if (-not $reachedEnd) {
        $answer['status'] = 'budget-exhausted'
        $answer['reason'] = "no title in its first $lines lines"
        return [pscustomobject]$answer
    }
    $answer['status'] = 'no-title'
    $answer['reason'] = 'its transcript records no title'
    [pscustomobject]$answer
}

# --- What a seat remembers about its last conversation --------------------------------------------

function Get-SeatConversationRecord {
    <#
    .SYNOPSIS
        The conversation a seat last recorded, as {session_id, source, recorded_utc}. `source` is
        `binding`, `activity`, `malformed` (a record is there and unusable) or `none`; only the first
        two carry a `session_id`.

    .DESCRIPTION
        THE NEWER OF TWO RECORDS, NOT THE MORE TRUSTED ONE. The binding's `session_id` is written by
        the agent that bound the seat and is verified identity; the advisory one is written by the
        LAUNCHER when it mints a conversation, because a launcher-started session can never hold a
        binding -- the launcher holds the claim handle itself, so the agent inside it is refused by
        the `enter`/`held` row of the matrix, deliberately. Preferring the binding unconditionally
        would therefore offer a resume of the conversation BEFORE last at exactly the seat a
        terminal reader uses.

        THE ADVISORY RECORD IS REPLACED WHOLE BY EVERY ENTRY, and that is the honest behaviour rather
        than an oversight: an entry that did not mint a conversation cannot name the one it started,
        so keeping the previous id would claim a conversation that is no longer the seat's last.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat
    )
    $record = [pscustomobject]@{ session_id = ''; source = 'none'; recorded_utc = '' }
    # A RECORD THAT IS PRESENT AND UNUSABLE IS NOT AN ABSENT RECORD. A `session_id` that is not a uuid
    # is never resumed and never composed into a path -- but reporting it as "nothing has recorded a
    # conversation here" would be absence standing in for a fault, and the reader would go looking for
    # the wrong thing. It is carried as its own source instead, with no id behind it.
    $malformed = $false

    $binding = Read-SeatBinding -StateDirectory $StateDirectory -Seat $Seat
    if ($null -ne $binding) {
        $fields = @($binding.PSObject.Properties | ForEach-Object { $_.Name })
        # COMMITTED ONLY, the same rule Write-SeatBinding applies before it records a conversation in
        # the history: a `pending` binding belongs to an attempt that may never have sat anywhere.
        if ($fields -ccontains 'state' -and [string]$binding.state -ceq 'committed' -and $fields -ccontains 'session_id') {
            $bound = ''
            if ($fields -ccontains 'bound_utc') { $bound = [string]$binding.bound_utc }
            if (Test-SeatConversationId -SessionId ([string]$binding.session_id)) {
                $record = [pscustomobject]@{ session_id = [string]$binding.session_id; source = 'binding'; recorded_utc = $bound }
            }
            elseif (-not [string]::IsNullOrWhiteSpace([string]$binding.session_id)) { $malformed = $true }
        }
    }

    $activity = Read-SeatActivity -StateDirectory $StateDirectory -Seat $Seat
    if ($null -ne $activity) {
        $fields = @($activity.PSObject.Properties | ForEach-Object { $_.Name })
        if ($fields -ccontains 'session_id' -and $fields -ccontains 'conversation_recorded_utc') {
            $advisoryId = [string]$activity.session_id
            $advisoryAt = [string]$activity.conversation_recorded_utc
            if (Test-SeatConversationId -SessionId $advisoryId) {
                if (Test-SeatRecordIsNewer -Candidate $advisoryAt -Than $record.recorded_utc) {
                    $record = [pscustomobject]@{ session_id = $advisoryId; source = 'activity'; recorded_utc = $advisoryAt }
                }
            }
            elseif (-not [string]::IsNullOrWhiteSpace($advisoryId)) { $malformed = $true }
        }
    }
    if ([string]$record.source -ceq 'none' -and $malformed) {
        $record = [pscustomobject]@{ session_id = ''; source = 'malformed'; recorded_utc = '' }
    }
    $record
}

function Test-SeatRecordIsNewer {
    <#
    .SYNOPSIS
        Whether one round-trip UTC stamp is newer than another. An unparseable or absent `Than` is
        older than anything; an unparseable `Candidate` is newer than nothing.
    #>
    param([string]$Candidate, [string]$Than)
    $candidateTime = [DateTime]::MinValue
    if (-not [DateTime]::TryParse($Candidate, [ref]$candidateTime)) { return $false }
    $thanTime = [DateTime]::MinValue
    if (-not [DateTime]::TryParse($Than, [ref]$thanTime)) { return $true }
    ($candidateTime -gt $thanTime)
}

# --- Whether that conversation can be resumed, or only started again ------------------------------

function Test-SeatConversationMintedHere {
    <#
    .SYNOPSIS
        Whether THIS checkout's own launcher minted this conversation id at this seat. `$false` for
        anything it cannot prove, an unreadable history included.

    .DESCRIPTION
        THE HISTORY IS ASKED FOR PROVENANCE, WHICH IS NOT THE QUESTION THIS FILE REFUSES TO ASK IT.
        `Get-SeatConversationRecord`'s header says why "which conversation was last here" is never
        derived from `conversations.json`; this is a different question with a different answer --
        "where did this id come from" -- and the history is the only record that holds it. A record
        with `source` `launcher` was written by `tools/Start-LibrarySeat.ps1` in the same registry-
        locked block that minted the id and passed it to `claude --session-id`.

        AND `.claude/seats/` IS GITIGNORED, which is what makes the answer conclusive rather than
        suggestive. A launcher record in this checkout was written by this machine: it cannot have
        arrived from another one, so there is no configuration in which that conversation's transcript
        lives somewhere this checkout cannot see.

        IT FAILS TO `$false`, DELIBERATELY. `Read-SeatConversations` refuses a damaged or
        future-schema history rather than reading past it, and the caller's fallback for "not proven"
        is the behaviour that shipped before this existed -- offer the resume and let `claude` answer.
        A picker that went down over an unreadable history would be the worse answer.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [Parameter(Mandatory = $true)][string]$SessionId
    )
    if (-not (Test-SeatConversationId -SessionId $SessionId)) { return $false }
    $history = $null
    try { $history = Read-SeatConversations -StateDirectory $StateDirectory -Seat $Seat }
    catch { return $false }
    if ($null -eq $history) { return $false }
    foreach ($entry in @($history.conversations)) {
        $fields = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
        if ($fields -cnotcontains 'source' -or [string]$entry.source -cne 'launcher') { continue }
        if ([string]$entry.session_id -ceq $SessionId) { return $true }
    }
    $false
}

function Get-SeatConversationEntryAction {
    <#
    .SYNOPSIS
        What sitting down at this seat must actually DO: `resume` a conversation that exists,
        `restart` the empty one this launcher minted, or `none` when there is nothing to enter.
        Returns {action, reason}.

    .DESCRIPTION
        WHY `restart` EXISTS, AND IT IS A MEASURED CASE RATHER THAN A HYPOTHETICAL. Observed
        2026-09-11: a reader created a seat, the launcher minted a conversation and passed it to
        `claude --session-id`, the session started -- its SessionStart hook ran -- and the reader left
        without typing. Claude Code writes a transcript on the first turn, so there was none, and the
        picker's number composed `--resume <id>` onto a conversation that had never recorded anything:
        `No conversation found with session ID`. The roster had said `no transcript for it under this
        configuration` a line earlier, so the fact was in hand and spent on a resume that could not
        work.

        THE STANDING RULING IS NARROWED, NOT REVERSED. `Get-SeatPickerLaunchArguments` declines to
        refuse a resume for a missing transcript, because a transcript not found is not a deleted
        transcript -- a redirected `CLAUDE_CONFIG_DIR`, another machine, a pruned history -- and
        `claude` is the authority on its own conversations. That holds for every id whose provenance
        is unknown. It does NOT hold for an id this checkout's launcher minted: the launcher created
        that conversation here, so "no transcript here" is the whole truth about it, and the launcher
        is the authority.

        WHY RESTARTING THE SAME ID RATHER THAN MINTING A NEW ONE. Nothing is lost -- the conversation
        holds nothing -- and the seat's two records go on naming the conversation that is actually
        sitting at it, rather than collecting an id nothing will ever reach. MEASURED AGAINST THE
        INSTALLED BINARY (2.1.267, 2026-09-11): `--session-id` accepts an id with no transcript, a
        leftover `session-env/<id>` directory and all, and REFUSES one that has a transcript --
        `Error: Session ID <id> is already in use.` So a wrong answer here fails loudly at the agent
        rather than quietly forking a second conversation onto one id.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [string]$SessionId,
        [Parameter(Mandatory = $true)][string]$TitleStatus
    )
    if ([string]::IsNullOrWhiteSpace($SessionId)) {
        return [pscustomobject]@{ action = 'none'; reason = 'nothing has recorded a conversation at this seat' }
    }
    # THE TITLE LOOKUP'S OWN STATUS IS THE TRANSCRIPT FACT, not a proxy for it: `no-transcript` means
    # the file was searched for by name across every project directory under the transcript root and
    # not found. Every other status -- unreadable, budget-exhausted, no-title -- found the file, so
    # the conversation is there to resume.
    if ($TitleStatus -ceq 'no-transcript' -and
        (Test-SeatConversationMintedHere -StateDirectory $StateDirectory -Seat $Seat -SessionId $SessionId)) {
        return [pscustomobject]@{
            action = 'restart'
            reason = 'it was started at this seat and recorded nothing, so a number starts it rather than resuming it'
        }
    }
    [pscustomobject]@{ action = 'resume'; reason = '' }
}

function Get-SeatConversationView {
    <#
    .SYNOPSIS
        One seat's last conversation, what it is called, AND what entering it would do, in the field
        names both surfaces render: `session_id`, `conversation_source`, `recorded_utc`, `title`,
        `title_status`, `title_note`, `entry_action`, `entry_note`.

    .DESCRIPTION
        THE BRANCHING IS THE POINT, not the two calls it wraps. Deciding whether to look a title up
        at all has three arms -- a record that is present and unusable gets its own status and no
        lookup, a caller that asked for no titles gets a third status rather than a blank, and
        everything else is read -- and until 2026-09-10 that lived only inside the picker's row
        builder. The Desk overview needed the same answer for its own seat, and a second copy of a
        three-arm decision is how "malformed" quietly becomes "no title" on one surface only.

        ONE VOCABULARY, so `Format-SeatConversationCell` has one contract. The picker's roster row
        and the overview's own line both carry these names verbatim, which is what lets the cell
        formatter render either without knowing which surface it is on.

        `entry_action` TRAVELS WITH THE OTHER FIELDS FOR THE SAME REASON THE REST OF THEM DO. It is
        derived from `title_status` and the seat's own history, so a caller that recomputed it beside
        the title would be the second copy of a decision this file exists to hold once. A caller that
        asked for no titles gets `not-derived` rather than a plausible `resume`: the transcript fact
        it rests on was never read, and guessing it is exactly how an unresumable conversation came
        to be offered as a resume in the first place.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$Seat,
        [string]$TranscriptRoot,
        [switch]$SkipTitle
    )
    if ([string]::IsNullOrWhiteSpace($TranscriptRoot)) { $TranscriptRoot = Get-SeatTranscriptRoot }
    $record = Get-SeatConversationRecord -StateDirectory $StateDirectory -Seat $Seat
    $view = [ordered]@{
        session_id = [string]$record.session_id
        conversation_source = [string]$record.source
        recorded_utc = [string]$record.recorded_utc
        title = ''
        title_status = 'no-conversation'
        title_note = ''
        entry_action = 'none'
        entry_note = ''
    }
    if ([string]$record.source -ceq 'malformed') {
        # NO LOOKUP AND NO RESUME, and the answer says which of the two blank-column facts this is:
        # a record that is there and unusable, rather than no record at all.
        $view['title_status'] = 'malformed-conversation'
        $view['title_note'] = 'the conversation it records is not a uuid, so nothing was looked up'
        $view['entry_note'] = 'the conversation it records is not a uuid, so there is nothing to enter'
        return [pscustomobject]$view
    }
    if ($SkipTitle) {
        $view['title_status'] = 'not-looked-up'
        $view['title_note'] = 'titles were not read'
        $view['entry_action'] = 'not-derived'
        $view['entry_note'] = 'titles were not read, so the transcript it turns on was never looked for'
        return [pscustomobject]$view
    }
    $answer = Get-SeatConversationTitle -TranscriptRoot $TranscriptRoot -SessionId ([string]$record.session_id)
    $view['title'] = [string]$answer.title
    $view['title_status'] = [string]$answer.status
    $view['title_note'] = [string]$answer.reason
    $entry = Get-SeatConversationEntryAction -StateDirectory $StateDirectory -Seat $Seat `
        -SessionId ([string]$record.session_id) -TitleStatus ([string]$answer.status)
    $view['entry_action'] = [string]$entry.action
    $view['entry_note'] = [string]$entry.reason
    [pscustomobject]$view
}

# --- Rendering the one cell both surfaces show ------------------------------------------------

function Format-SeatConversationCell {
    <#
    .SYNOPSIS
        The last column: the title in quotes, or the reason there is none. NEVER BLANK.

    .DESCRIPTION
        AN UNRESUMABLE CONVERSATION SAYS SO HERE RATHER THAN SAYING WHY IT HAS NO TITLE, because the
        reader is about to type a number and the two facts send them different places. `no transcript
        for it under this configuration` is true and was what this column said on 2026-09-11 while the
        number beside it composed a resume that could not work; `entry_note` is what happens when they
        type it.

        THE FIELD IS TESTED BEFORE IT IS READ. `Get-SeatConversationView` always carries it, but this
        formatter's contract is a ROW SHAPE rather than that one producer, and StrictMode turns a row
        assembled by anything else into a PropertyNotFound that names nothing.
    #>
    param([Parameter(Mandatory = $true)][object]$Row, [int]$TitleWidth = 52)
    $status = [string]$Row.title_status
    $fields = @($Row.PSObject.Properties | ForEach-Object { $_.Name })
    if ($fields -ccontains 'entry_action' -and [string]$Row.entry_action -ceq 'restart' -and
        $fields -ccontains 'entry_note' -and -not [string]::IsNullOrWhiteSpace([string]$Row.entry_note)) {
        $cell = [string]$Row.entry_note
        if ([string]$Row.conversation_source -ceq 'activity') { $cell += ' (advisory)' }
        return $cell
    }
    if ($status -ceq 'titled') {
        $title = [string]$Row.title
        if ($title.Length -gt $TitleWidth) { $title = $title.Substring(0, $TitleWidth - 1).TrimEnd() +([char]0x2026) }
        $cell = '"' + $title + '"'
    }
    else {
        $note = [string]$Row.title_note
        if ([string]::IsNullOrWhiteSpace($note)) { $note = $status }
        $cell = $note
    }
    # ADVISORY IS LABELLED WHEREVER IT IS SHOWN, the same rule the Desk overview's last-activity
    # field follows: this conversation was recorded by a launcher rather than by a verified binding.
    if ([string]$Row.conversation_source -ceq 'activity' -and $status -cne 'no-conversation') { $cell += ' (advisory)' }
    $cell
}
