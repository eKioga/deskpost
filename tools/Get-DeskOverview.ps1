[CmdletBinding()]
param(
    [string]$WorkspacePath,
    [string]$Seat,
    # Where conversation transcripts live, for THIS seat's last-conversation title. Defaults to
    # CLAUDE_CONFIG_DIR, then to ~/.claude; a fixture points it at its own tree.
    [string]$TranscriptRoot,
    # This process's own agent, so this seat's line can say whether the binding names it. Supplied
    # by fixtures and by any caller that resolved it another way; resolved from process identity
    # otherwise, the same seam Enter-LibrarySeat.ps1 and both hooks already offer.
    [int]$AgentProcessId = -1,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
# The Book-root shape lives in ONE file (plan item 3.2); this used to carry its own copy.
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
# Which conversation this seat last held and what it is called (PLAN-seat-launch.md step 14). The
# terminal picker dot-sources the same file; the derivation and the never-blank wording are shared,
# and each surface renders its own shape. Deliberately NOT SeatPicker.ps1: its roster builder reads
# a title for EVERY seat, which this helper's cosmetic tier forbids.
. (Join-Path $PSScriptRoot 'SeatConversation.ps1')
# WHOSE EACH NOTEBOOK TOPIC IS (2026-09-15). `notebook/` is shared by every seat, so a list of topic
# folders with no owner beside them is a list in which the reader cannot tell their own material from
# someone else's -- and the only surface that answered it was a reset preflight, which is a
# destructive operation's preview.
#
# THE DOT-SOURCE COST WAS MEASURED, NOT ASSUMED, because Guard-ShelfBookRead.ps1:114-116 explicitly
# declines this same load on its own read path. It is ~40 ms (this file already has BookRootSchema
# and LibrarySeat, so the new arrivals are BookWriteGuard.ps1 and NotebookIndex.ps1), plus ~1.4 ms
# for the record read, against a ~576 ms invocation: about 7%. The guard's reasoning does not carry
# over, and the difference is FREQUENCY. That hook runs on every Read, Grep, Glob, Write and Edit --
# hundreds of times a session, usually for a path with no topic in it at all. This helper runs when a
# reader asks what is on their Desk, and no hook calls it; the per-prompt hook is a different script.
. (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')

function Read-StateLines([string]$Path, [string]$Pattern, [string]$Label, [switch]$Optional) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if ($Optional) { return @() }
        throw "Virtual Desk configuration is missing $Label."
    }
    $items = @(Get-DeskFileEntries -Path $Path)
    foreach ($item in $items) {
        if ($item -cnotmatch $Pattern) { throw "Virtual Desk $Label state is malformed." }
    }
    if (@($items | Select-Object -Unique).Count -ne $items.Count) { throw "Virtual Desk $Label state contains duplicates." }
    $items
}


function Get-IndexOverview([string]$IndexPath) {
    if (-not (Test-Path -LiteralPath $IndexPath -PathType Leaf)) { return $null }
    $parts = [Collections.Generic.List[string]]::new()
    $started = $false
    foreach ($rawLine in @(Get-Content -LiteralPath $IndexPath)) {
        $line = $rawLine.Trim()
        if (-not $line) {
            if ($started) { break }
            continue
        }
        if ($line.StartsWith('#') -or $line.StartsWith('>') -or $line -match '^[-*]\s' -or $line -match '^\d+\.\s') { continue }
        $started = $true
        [void]$parts.Add($line)
    }
    if (-not $parts.Count) { return $null }
    $overview = $parts -join ' '
    if ($overview.Length -gt 300) { return $overview.Substring(0, 297).TrimEnd() + '...' }
    $overview
}

# --- THIS HELPER REFUSES A SEAT IT CANNOT RESOLVE, AND STILL ANSWERS (2026-09-18) -----------------
#
# THE REMEDY THAT REFUSAL NAMES IS THIS SCRIPT. `Resolve-SeatName`'s malformed-name message ends
# *"List the seats with tools/Get-DeskOverview.ps1"*, and running it produced that same sentence back
# -- the reader was sent to the helper that had just refused them. It is the circle
# `seat.resolution-contract` part 1a closed at a different helper the same day, and the fix belongs
# HERE rather than in the sentence: one message is worded for roughly twenty consumers -- both
# guards, both hooks, the reader adapter, every seat-aware mutator -- so making the named remedy
# answer repairs all of them at once, while editing the sentence would have to invent a route that
# works for each.
#
# IT IS STILL A REFUSAL, and that is not a detail. No Desk is rendered and the exit code stays
# non-zero, because the reader asked for their Desk and did not get one; `docs/seats.md` and the
# recovery playbook both say in as many words that this helper throws without a seat, and both stay
# true. What changed is that the refusal now carries the roster it sent the reader for.
#
# THE ROSTER COMES FROM THE REPORT THAT ANSWERS RATHER THAN FAILING CLOSED.
# `Get-SeatRegistryConsistency` is this page's own source further down and is documented as
# reporting a hand-edited registry instead of refusing it -- which is exactly the workspace where a
# seat stops resolving, so a source that threw here would leave the reader with nothing twice over.
#
# ONLY REGISTERED SEATS ARE OFFERED. A `.claude/seats/<name>` directory no registry entry names
# cannot be entered, retired or reset by any helper, so listing it as a seat would be this same
# circle one layer down; it is named as what it is instead.
function Add-SeatRosterToRefusal {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory
    )
    $report = $null
    try { $report = Get-SeatRegistryConsistency -Workspace $Workspace -StateDirectory $StateDirectory }
    catch { return "$Message The seats could not be listed: $($_.Exception.Message)" }
    $rows = @($report.seats)
    # `unknown` means a source could not be read at all, and every row carries it together. Listing
    # the rows anyway would report "no seats exist" about a workspace whose registry is merely
    # unreadable -- a different fault with a different remedy.
    if (@(@($rows) | Where-Object { [string]$_.state -ceq 'unknown' }).Count) {
        return "$Message The seats could not be listed: $(@($report.faults) -join ' ')"
    }
    $sentence = Get-SeatRosterSentence -Seats @(@($rows) | Where-Object { [bool]$_.in_registry } | ForEach-Object { [string]$_.seat })
    $stray = @(@($rows) | Where-Object { [string]$_.state -ceq 'unregistered' } | ForEach-Object { [string]$_.seat })
    if ($stray.Count) {
        $sentence += ' No helper can enter these, so they are not offered as seats: ' +
                     ((@($stray) | ForEach-Object { ".claude/seats/$_" }) -join ', ') + '.'
    }
    "$Message $sentence"
}

# STEP 20: THE WORKSPACE IS SELECTED, NOT ASSUMED. `Split-Path -Parent $PSScriptRoot` answered
# "which workspace" with "one level above my own code", which is right only while the program and
# the workspace are the same directory. Order: -WorkspacePath, then LIBRARY_WORKSPACE, then the
# nearest `.library/workspace.json` above the working directory, then this program's own root --
# and that last one only while the program really is a workspace, which is what keeps an un-split
# checkout working and stops an installed package inventing one. tools/WorkspaceRegistry.ps1.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
$WorkspacePath = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$stateDirectory = Join-Path $workspace '.claude'
$seatState = Resolve-SeatName -Seat $Seat -StateDirectory $stateDirectory -AgentProcessId $AgentProcessId
if ($seatState.status -cne 'named') {
    throw (Add-SeatRosterToRefusal -Message ([string]$seatState.message) -Workspace $workspace -StateDirectory $stateDirectory)
}
$deskDirectory = Get-DeskStateDirectory -StateDirectory $stateDirectory -Seat $seatState.seat
if (-not (Test-Path -LiteralPath $deskDirectory -PathType Container)) {
    throw ("Seat '$($seatState.seat)' has no Desk in this workspace. Create it with " +
           "tools/Start-LibrarySeat.ps1 -Seat $($seatState.seat) -Project <project-slug>.")
}
$openBooksPath = Get-DeskFileInDirectory -DeskDirectory $deskDirectory -Kind 'books'
$openProjectsPath = Get-DeskFileInDirectory -DeskDirectory $deskDirectory -Kind 'projects'
$notebookRoot = Join-Path $workspace 'notebook'

if (-not (Test-Path -LiteralPath $notebookRoot -PathType Container)) { throw "Notebook directory not found: $notebookRoot" }
$openBookRoots = @(Read-StateLines -Path $openBooksPath -Pattern (Get-BookRootAcceptPattern) -Label 'open-book' | ForEach-Object { ConvertTo-BookRoot $_ })
if (@($openBookRoots | Select-Object -Unique).Count -ne $openBookRoots.Count) { throw 'Virtual Desk open-book state contains duplicates.' }
# Split-BookRoot, not a local -split: an archived Book's root is archive/<slug>, so a rule that
# read 'anything not shelf/ is shared and active' would report it as an active shared Book.
$openBooks = @($openBookRoots | ForEach-Object {
    $parts = Split-BookRoot $_
    [pscustomobject]@{
        slug = $parts.slug
        location = $parts.collection
        shelf = $parts.shelf
        root = $parts.root
    }
})
$openProjects = @(Read-StateLines -Path $openProjectsPath -Pattern '^(projects|archive/projects)/[a-z0-9][a-z0-9-]*$' -Label 'open-project' -Optional)

# ONE READ OF THE RECORD FOR EVERY TOPIC, not one per topic: the file is replaced atomically, so a
# single read is already a consistent snapshot, and re-reading it per folder would let two rows in one
# listing come from two different versions of the record.
#
# LOCK-FREE, like every other read on this page, and that is a rule rather than an omission.
# Read-NotebookTopicOwners is deliberately outside both lock sets (ADR-0019, and
# Get-TopicLockedFunctions says so in as many words): reading the record is not acting on a topic. The
# DECISION that rests on this same derivation -- which topics a reset may move -- takes the registry
# lock and re-reads there.
$topicOwners = Read-NotebookTopicOwners -Workspace $workspace
$topics = @(
    Get-ChildItem -LiteralPath $notebookRoot -Directory -Force | Sort-Object Name | ForEach-Object {
        $topicFiles = @(Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Filter '*.md' | Where-Object { $_.Name -ne '_index.md' })
        $relativeIndex = "notebook/$($_.Name)/_index.md"
        # THE THREE SCOPES AND THE ABSENCE ARE FOUR DIFFERENT ANSWERS, kept apart rather than folded
        # into "not yours". `unmapped` is the one that matters most to act on -- it is what stops a
        # reset outright -- so it is never rendered as though some seat owned it. `owner_seat` stays
        # null for everything but an owned topic, so a consumer keying on the seat cannot read
        # 'shared' as a seat name.
        $ownerRow = Get-NotebookTopicOwner -Owners $topicOwners -Topic $_.Name
        $ownerScope = if ($null -eq $ownerRow) { 'unmapped' } else { [string]$ownerRow.scope }
        $ownerSeat = if ($ownerScope -ceq 'owned') { [string]$ownerRow.seat } else { $null }
        [pscustomobject]@{
            folder = $_.Name
            index_path = $relativeIndex
            article_count = $topicFiles.Count
            overview = Get-IndexOverview -IndexPath (Join-Path $_.FullName '_index.md')
            owner_scope = $ownerScope
            owner_seat = $ownerSeat
            # DERIVED FROM THE TWO FIELDS ABOVE so it can never disagree with them, and phrased for a
            # reader rather than as a scope name: 'yours' and another seat's name are the distinction
            # this label exists to draw, and the reader is the one seat whose name they already know.
            owner_label = if ($ownerScope -cne 'owned') { $ownerScope }
                          elseif ($ownerSeat -ceq $seatState.seat) { "yours ($ownerSeat)" }
                          else { "seat $ownerSeat" }
        }
    }
)
$standaloneArticles = @(Get-ChildItem -LiteralPath $notebookRoot -File -Filter '*.md' | Where-Object { $_.Name -ne '_master-index.md' })
$topicArticleCount = 0
foreach ($topic in $topics) { $topicArticleCount += [int]$topic.article_count }

# --- WHAT A RESET SET ASIDE, AND THAT IT IS STILL THERE (2026-09-15) ------------------------------
#
# A quarantine was invisible unless the reader already suspected it. The directories sit under
# `internal/`, no index lists them, and the reset that made one said `recoverable` in a result the
# reader read once and closed -- so a reader who reset three weeks ago and now wants one page back
# had no reason to think there was anywhere to look. This is the surface that says there is.
#
# A COUNT, THE OLDEST, AND THE COMMAND -- not the contents. Naming topics here would put another
# seat's material on this Desk (a whole-tree reset quarantines topics this reader does not own), and
# naming articles would make an orientation read a file walk. The route is printed instead, and it is
# the route that answers a reader THIS helper cannot serve: `Get-DeskOverview.ps1` throws without a
# seat, `-List` and `-Show` need none, and the reader whose session lost its seat is exactly the one
# asking what survived.
#
# NO NEW DOT-SOURCE AND THE COST WAS MEASURED, the rule this file's own owner-label block set:
# `NotebookOwnership.ps1` is already loaded above, and `Get-NotebookQuarantineInventory` is one
# directory listing plus a small journal read per quarantine -- ~5.5 ms for three of them against a
# 649 ms child-process invocation, and this workspace holds one. The per-topic article walk is
# deliberately NOT in that function: it costs ~5.8 ms again over the same three and scales with
# ARTICLES rather than quarantines, so it belongs to the two reads that name articles.
$quarantineRows = @(Get-NotebookQuarantineInventory -Workspace $workspace)
# THE OLDEST IS CHOSEN BY THE EFFECTIVE STAMP, NOT BY `quarantined_utc`, which is empty whenever the
# reset journal is missing or unreadable. Sorting on that field alone puts the journal-less
# quarantine -- which may well be the oldest thing in the workspace -- at one end of the order for a
# reason that has nothing to do with its age. `stamp_source` travels with the answer so the reader
# can see which source supplied it, and a quarantine neither source can date is reported rather than
# dropped: `oldest` stays null and `undated_count` says how many could not be placed.
$datedQuarantines = @(@($quarantineRows) | Where-Object { [string]$_.stamp_source -cne 'unknown' } | Sort-Object -Property stamped_utc)
$oldestQuarantine = if ($datedQuarantines.Count) {
    [pscustomobject]@{
        name         = [string]$datedQuarantines[0].name
        quarantined_by = [string]$datedQuarantines[0].seat
        stamped_utc  = [string]$datedQuarantines[0].stamped_utc
        stamp_source = [string]$datedQuarantines[0].stamp_source
        age_days     = $datedQuarantines[0].age_days
    }
} else { $null }
$quarantine = [pscustomobject]@{
    count         = $quarantineRows.Count
    topic_count   = @(@($quarantineRows) | ForEach-Object { @($_.topics).Count } | Measure-Object -Sum).Sum
    oldest        = $oldestQuarantine
    undated_count = @($quarantineRows).Count - $datedQuarantines.Count
    # NAMED EVEN WHEN THE COUNT IS ZERO. A reader who has just been told there is nothing in
    # quarantine is the one most likely to want to check that for themselves.
    list_route    = 'tools/Restore-NotebookQuarantine.ps1 -WorkspacePath . -List'
    note          = 'Set aside by a reset and still recoverable. Both reads need no seat, unlike this overview.'
}

# A capture Book is closed by default, so its notes would otherwise be invisible until the reader
# happened to remember them. Only counts and the oldest pending date are reported: note titles and
# bodies still require opening the Book, exactly as any other Shelf Book's pages do.
$openShelfSlugs = @($openBooks | Where-Object { $_.location -ceq 'shelf' } | ForEach-Object { $_.slug })
$captureBooks = @(Get-CaptureBooks -Workspace $workspace | ForEach-Object {
    $notes = @(Get-ShelfNotes -Book $_)
    $pending = @($notes | Where-Object { $_.review -cne 'done' })
    $oldestPending = @($pending | Where-Object { $_.captured -cne 'unknown' } | Sort-Object captured | Select-Object -First 1)
    [pscustomobject]@{
        slug = $_.slug
        book_root = $_.book_root
        is_open = ($_.slug -cin $openShelfSlugs)
        pending_count = $pending.Count
        reviewed_count = $notes.Count - $pending.Count
        oldest_pending = if ($oldestPending.Count) { $oldestPending[0].captured } else { $null }
    }
})

# THIS SEAT IN FULL, ONE LINE PER OTHER SEAT (the cosmetic tier, locked 2026-09-07). Enough to know
# a seat exists and roughly what it is doing; not enough to read its Desk as if it were yours.
#
# COUNTS AND A TIMESTAMP, NOT THE ROOTS. Another seat's open Books are its business, and listing them
# here would put material on this reader's Desk that they did not open. `last_activity` is read from
# the ADVISORY activity record and is labelled as advisory wherever it is shown -- it is not liveness,
# which is `claimed`, and that comes from the claim probe.
$otherSeats = @(Get-SeatDirectoryNames -StateDirectory $stateDirectory |
    Where-Object { $_ -cne $seatState.seat } |
    ForEach-Object {
        $otherDesk = Get-DeskStateDirectory -StateDirectory $stateDirectory -Seat $_
        $otherBooks = @(Read-StateLines -Path (Get-DeskFileInDirectory -DeskDirectory $otherDesk -Kind 'books') -Pattern (Get-BookRootAcceptPattern) -Label 'open-book' -Optional)
        $otherProjects = @(Read-StateLines -Path (Get-DeskFileInDirectory -DeskDirectory $otherDesk -Kind 'projects') -Pattern '^(projects|archive/projects)/[a-z0-9][a-z0-9-]*$' -Label 'open-project' -Optional)
        $activity = Read-SeatActivity -StateDirectory $stateDirectory -Seat $_
        # ONE READ, USED TWICE. Two calls could disagree, which is exactly what the derived field
        # below exists to make impossible.
        $otherClaim = Get-SeatClaimState -StateDirectory $stateDirectory -Seat $_
        [pscustomobject]@{
            seat = $_
            open_book_count = $otherBooks.Count
            open_project_count = $otherProjects.Count
            # THREE STATES, NOT A BOOLEAN (ADR-0018). `orphaned` -- the bound agent still running
            # with its claim holder gone -- used to report as unclaimed, which reads as "that seat is
            # finished" and is the opposite of true. `claimed` is kept beside it and DERIVED from the
            # same answer, so the two can never disagree.
            claim_state = [string]$otherClaim.state
            claimed = ([string]$otherClaim.state -cne 'free')
            last_activity_advisory = if ($null -ne $activity) { [string]$activity.last_seen_utc } else { $null }
        }
    })

# THIS SEAT'S OWN LINE, IN FULL (PLAN-seat-launch.md step 14) --------------------------------------
#
# WHAT WAS MISSING, AND IT WAS THE ONE ANSWER THIS DESK COULD NOT GET ANY OTHER WAY. Until
# 2026-09-10 this helper reported another seat's liveness and said nothing whatever about THIS one:
# no claim state, no agent, no bind time, no conversation. So "am I actually sat down here, since
# when, and as which conversation" -- the question the reader asks of their own Desk -- was the one
# question the Desk overview did not address, while it answered the same question about everyone
# else's seat.
#
# THE COSMETIC TIER IS NOT WIDENED BY THIS, and that is a ruling rather than a preference (locked
# 2026-09-07): another seat stays counts and liveness. Everything below is read for THIS seat alone,
# which is exactly why the picker's `Get-SeatPickerRows` is not called here even though it builds
# this same shape -- it reads a title for EVERY registered seat, because a reader choosing between
# seats needs that, and calling it would put another reader's conversation title on this Desk. Case
# 20 of `seat.lifecycle` plants a titled conversation at a foreign seat and asserts that this
# output never says its name.
#
# ONE READ OF THE CLAIM, USED FOR EVERY FIELD, the same rule the other-seat loop already follows:
# `bound_utc` beside an `agent_pid` taken from a different read is two answers pretending to be one.
$thisClaim = Get-SeatClaimState -StateDirectory $stateDirectory -Seat $seatState.seat -AgentProcessId $AgentProcessId
$thisActivity = Read-SeatActivity -StateDirectory $stateDirectory -Seat $seatState.seat
$thisConversation = Get-SeatConversationView -StateDirectory $stateDirectory -Seat $seatState.seat -TranscriptRoot $TranscriptRoot
$thisSeat = [ordered]@{
    seat = [string]$seatState.seat
    # WHICH OF THE THREE SOURCES ANSWERED (ADR-0018). A seat named by `LIBRARY_SEAT` is a name and
    # not a verified binding, and the reader is told that on every prompt of such a session -- so the
    # overview says it too rather than presenting both the same way.
    seat_source = [string]$seatState.source
    claim_state = [string]$thisClaim.state
    claimed = ([string]$thisClaim.state -cne 'free')
    state_note = ''
    agent_pid = [int]$thisClaim.agent_pid
    agent_start_utc = [string]$thisClaim.agent_start_utc
    bound_utc = [string]$thisClaim.bound_utc
    seat_id = [string]$thisClaim.seat_id
    binding_state = [string]$thisClaim.binding_state
    binding_stale = [bool]$thisClaim.binding_stale
    this_agent = [bool]$thisClaim.this_agent
    last_activity_advisory = if ($null -ne $thisActivity) { [string]$thisActivity.last_seen_utc } else { $null }
}
if ([string]$thisClaim.state -ceq 'orphaned') {
    $thisSeat['state_note'] = "agent $([int]$thisClaim.agent_pid) alive, claim holder gone; re-enter this seat to repair it"
}
foreach ($field in @('session_id', 'conversation_source', 'recorded_utc', 'title', 'title_status', 'title_note',
                     'entry_action', 'entry_note')) {
    $thisSeat[$field] = [string]$thisConversation.$field
}
# NEVER BLANK, in the words the picker's own column uses. A blank here reads as an untitled
# conversation and cannot be told from an old client, a pruned history or a redirected config dir.
$thisSeat['conversation_line'] = Format-SeatConversationCell -Row ([pscustomobject]$thisSeat)
# AND WHETHER THAT CONVERSATION IS THIS ONE, which is the difference between "your seat last held X"
# and "you are X". Derived from the two facts above rather than from a session id this helper is
# never given: the binding names this process's agent, and the binding is the record that won.
$thisSeat['is_this_conversation'] = ([bool]$thisClaim.this_agent -and [string]$thisConversation.conversation_source -ceq 'binding')

# --- DOES THE REGISTRY STILL AGREE WITH `.claude/seats/`? (2026-09-10) ----------------------------
#
# WHY A DESK OVERVIEW CARRIES THIS. The registry and the seat directories are written in one
# registry-locked transaction, so a disagreement can only come from outside the system -- a hand
# deletion, a hand-edited registry, a partial `git clean`. Both trees are gitignored and no commit
# restores either. Until today a disagreement was not merely unreported: a seat missing from
# `.claude/seats/` WAS how "retired" was decided, so deleting one folder handed every topic it owned
# to the next whole-tree reset. That is now inert, and inert-and-invisible is how a workspace stays
# broken -- so the state that used to be silently destructive is the one the Desk now says out loud.
#
# IT DOES NOT WIDEN THE COSMETIC TIER, and the distinction is exact. The ruling of 2026-09-07 keeps
# another seat's MATERIAL off this Desk -- its open Books, its conversation, anything the reader did
# not open. This says whether a seat's records are coherent, which is workspace integrity rather
# than material, and it is the same class of fact as the `claimed` flag that row has always carried.
#
# LOCK-FREE, like every other read on this page. The DECISION that rests on the same derivation --
# which topics a reset may move -- takes the registry lock and re-reads there.
$consistency = Get-SeatRegistryConsistency -Workspace $workspace -StateDirectory $stateDirectory

Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
    operation = 'Desk Overview'
    workspace = $workspace
    seat = $seatState.seat
    this_seat = [pscustomobject]$thisSeat
    other_seats = $otherSeats
    seat_consistency = $consistency
    open_books = $openBooks
    open_projects = $openProjects
    capture_books = $captureBooks
    notebook = [pscustomobject]@{
        path = $notebookRoot
        topic_count = $topics.Count
        article_count = $topicArticleCount + $standaloneArticles.Count
        topics = $topics
        standalone_article_count = $standaloneArticles.Count
        # NOT PART OF `topic_count` OR `article_count` ABOVE, and kept a level down so it cannot be
        # read as one. Those two describe what is IN `notebook/`; this describes what a reset took
        # OUT of it, which lives under internal/ and is a different question with a different route.
        quarantine = $quarantine
    }
    # THE SCOPE LINE SAYS WHAT WAS READ, AND IT GREW ON 2026-09-10 BECAUSE THE READ DID. This seat's
    # last conversation comes out of a Claude Code transcript, which is a file outside the workspace
    # -- so a scope that still claimed only Desk lists and Notebook indexes would be the defect this
    # repository keeps paying for, one direction over: a reported field describing less than the
    # operation performed reads exactly as honestly as one describing more.
    scope = ('Read-only local state: Virtual Desk lists, Notebook indexes, the Notebook topic-ownership record, ' +
             'the names and reset journals of the quarantine directories under internal/, ' +
             'capture-Book note counts, the seat registry ' +
             'against the seat directories and the retirement records in internal/seat-archive/, and -- for ' +
             'THIS seat only -- its claim, its binding, and the head of its last conversation''s transcript. ' +
             'No Book or Project page content was read, and no other seat''s conversation was looked up.')
    shared_library_write = $false
})
