[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspacePath,
    # Which seat's Desk this reports on, and clears with -ClearDesk. Defaults to LIBRARY_SEAT.
    [string]$Seat,

    [switch]$UserConfirmed,

    # Clear the Virtual Desk as well, making this the full Library Reset. OFF BY DEFAULT since
    # 2026-09-03, which reversed the original behaviour -- see ADR-0010.
    #
    # The Desk clear was welded to the Notebook rebuild because the two together are what
    # "start fresh" means. That is still true of the phrase, and the routing in
    # docs/librarian-operation-playbooks.md still sends "reset my workspace" and "start fresh" here
    # WITH this switch. What was wrong was making it the only shape the helper had:
    #
    #   - Set-VirtualDesk.ps1 -Action Clear already clears the Desk in one command, so
    #     Notebook-and-Desk was always composable from two narrow verbs. Notebook-alone was not
    #     reachable at all. A primitive you cannot decompose is the wrong primitive.
    #   - The harm is asymmetric. A Desk left open when the reader wanted it clear is visible in
    #     Get-DeskOverview.ps1 and undone by one command. A Desk cleared when the reader wanted it
    #     kept destroys the record of what they had open, which nothing else holds.
    #   - The file is named Reset-LocalNotebook.ps1. Clearing the Desk was never in that promise.
    [switch]$ClearDesk,

    # Cover topics owned by seats that have been explicitly RETIRED as well as this seat's own. It
    # still hard-refuses every other seat, claimed or dormant (ADR-0016): "whole tree" names the
    # material this seat is entitled to, not everything on disk.
    [switch]$WholeTree,

    # Sweep the Notebook topics of every IDLE foreign seat as well as this seat's own, naming and
    # skipping the ones in use and touching no other seat's Desk (ADR-0023, 2026-09-15).
    #
    # ITS OWN FLAG, AND THAT IS THE DECISION RATHER THAN THE SPELLING. ADR-0016 refused "an
    # unclaimed, unretired foreign seat" because including it in -WholeTree bypasses retirement, and
    # ADR-0023 amends that on the third case only: the seat becomes reachable by a DIFFERENTLY NAMED
    # operation that states its own limit -- idle seats, with the busy ones named -- rather than by
    # widening a word that claims completeness. So the two switches are refused together
    # (Get-NotebookResetTargets), and a sweep followed by a whole-tree reset is two approvals.
    #
    # WHAT IT DOES NOT REACH: a RETIRED incarnation (that is -WholeTree's), an UNACCOUNTED one (still
    # refused), a `shared` or `excluded` topic, an `unmapped` one (still stops the run), and any Desk
    # but this seat's own under -ClearDesk.
    [switch]$AllIdleSeats,

    # The exact plan_id from the preflight the reader approved. Required at apply since 2026-09-09:
    # -UserConfirmed alone approved "a reset", and the run then recomputed its own selection, so a
    # topic added or remapped after the preview was included in silence.
    [string]$ApprovedPlanId,

    [switch]$Preflight,

    # THE RESULT AS ONE JSON DOCUMENT, and until 2026-09-22 (S17) there was no way to ask for it. A
    # caller across a process boundary got PowerShell's list formatting -- wrapped at the host width,
    # so a 78-character plan_id arrived as two lines -- and the acceptance matrix compared that prose
    # against a kernel that answers in fields: two namespaces that cannot intersect, so every
    # difference the reset rows reported was about output mode rather than behaviour. Opt-in, like
    # every helper's, because an in-process caller wants the object (tools/LibraryOutput.ps1).
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')

# The reset removes topics, so it is a visibility change like any other and takes the same render
# lock. PLAN-multi-desk.md step 28a allows it to hold that lock longer than a compile does: a reset
# is inherently whole-scope, and there is nothing for it to do outside the lock.
. (Join-Path $PSScriptRoot 'NotebookIndex.ps1')
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')

function Get-DeskEntries([string]$Workspace, [string]$Name) {
    $statePath = Get-DeskFilePath -StateDirectory (Join-Path $Workspace '.claude') -Seat $Seat -Kind $Name
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return @('(Virtual Desk not configured)') }
    $entries = @(Get-DeskFileEntries -Path $statePath)
    if (-not $entries.Count) { return @('(none)') }
    $entries
}
function Clear-VirtualDesk([string]$Workspace) {
    foreach ($name in @('books', 'projects')) {
        $statePath = Get-DeskFilePath -StateDirectory (Join-Path $Workspace '.claude') -Seat $Seat -Kind $name
        # ATOMIC SINCE 2026-09-18, AND THE REGISTRY LOCK AROUND THIS CALL IS NOT WHAT MAKES IT SAFE.
        # That lock closed the racing half -- two writers -- on 2026-09-09. It does nothing for the
        # readers, which take no lock by design, so a truncating write still handed one of them a
        # zero-length Desk. Clearing a Desk is exactly when a hook reading an empty one is most
        # believable and most wrong.
        if (Test-Path -LiteralPath $statePath -PathType Leaf) { Write-AtomicText -Path $statePath -Text '' | Out-Null }
    }
}

$resolvedWorkspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$seatState = Resolve-SeatName -Seat $Seat -StateDirectory (Join-Path $resolvedWorkspace '.claude')
if ($seatState.status -cne 'named') { throw $seatState.message }
$Seat = $seatState.seat
$notebookPath = Join-Path $resolvedWorkspace 'notebook'
if (-not (Test-Path -LiteralPath $notebookPath -PathType Container)) {
    throw "Reset aborted: expected Notebook directory was not found at '$notebookPath'."
}

$notebookItems = @(Get-ChildItem -LiteralPath $notebookPath -Force -Recurse)
$inventoryHelper = Join-Path $PSScriptRoot 'Get-LibraryTriageInventory.ps1'
$libraryCopyAdvisory = $null
# THE SAME ROWS THE ADVISORY BELOW RENDERS, KEPT SO THE SWEEP PREFLIGHT CAN JOIN AGAINST THEM
# (2026-09-15). That report already walks the whole Notebook, so a second walk beside it would cost
# the same again and be free to disagree with the first. $null means the read did not happen -- NOT
# that a topic has no pages, which is a measured zero and reads completely differently to a reader
# deciding whether to approve a move.
$inventoryTopics = $null
try {
    $inventory = & $inventoryHelper -WorkspacePath $resolvedWorkspace
    $inventoryTopics = @($inventory.topics)
    $libraryCopyAdvisory = [pscustomobject]@{
        page_count = $inventory.page_count
        known_current_copy_count = $inventory.known_current_copy_count
        known_copy_drifted_count = $inventory.known_copy_drifted_count
        legacy_copy_record_count = $inventory.legacy_copy_record_count
        no_known_copy_record_count = $inventory.no_known_copy_record_count
        # THE GRAIN THE READER ACTUALLY DECIDES AT (ADR-0022). The four counters above are the
        # whole Notebook; a reset takes TOPICS, so a figure that is overwhelmingly reassuring says
        # nothing about the one topic that is not covered at all. One row per topic, with Books and
        # Project Hubs kept APART -- both are out of a reset's reach, so the safety verdict is the
        # union, but the reader's next move differs by class and a merged count names no route.
        #
        # THESE ARE PREFLIGHT EVIDENCE AND NOT A POST-RUN FACT. The whole advisory is computed once,
        # above, before the registry lock -- deliberately, because it describes the Notebook the
        # reader is approving a move of. It is not re-derived after the moves, so on a completed run
        # these rows say what WAS there; `remaining_in_notebook` is the field that says what is left.
        topics = @($inventory.topics)
        # The Holding Shelf is the destination this preflight is steering toward, and until now the
        # advisory was silent about it -- so a reader was told what would be lost and nothing about
        # where it survives. Reported under its own label rather than added to the counts above,
        # which answer 'what is about to be deleted'; a Holding note is the opposite of that.
        holding_pending_count = $inventory.holding_pending_count
        holding_note_count = $inventory.holding_note_count
        holding_survives_this_reset = $true
        message = 'This advisory is based on local publication journals only. It does not verify NAS state and does not copy anything. Triage the Notebook first if anything in it should outlive this reset: the Holding Shelf counts above are material that already survives. In topics, only known_current_copy_count is proof -- pages_without_current_copy is the number to act on -- and known_books and known_projects are kept separate because a Book and a Project Hub are opened and read differently, not because one is safer. These rows describe the Notebook as it was read before any move; after a completed run, remaining_in_notebook is what is actually left.'
    }
}
catch {
    $libraryCopyAdvisory = [pscustomobject]@{ status = 'unavailable'; message = "Could not calculate the local Library-copy advisory: $($_.Exception.Message)" }
}
# SELECTION UNDER THE REGISTRY LOCK (step 25), so the set of seats cannot change under the scan. It
# is released before the reader is asked: holding an ordered lock across a human decision would block
# every Notebook writer and every Desk write for as long as the reader takes to read.
#
# THE REGISTRY LOCK IS NEW, and it is what the seats review found missing. Get-NotebookResetTargets
# decides which seats are RETIRED by reading `.claude/seats/`, and -ClearDesk writes this seat's Desk
# files; both are registry-class state that Set-VirtualDesk, Start-LibrarySeat and Retire-Seat
# mutate under this lock. Reading them without it is the same check-then-act the three Shelf
# lifecycle helpers had.
#
# THE OWNERSHIP LOCK USED TO BE TAKEN HERE TOO, and since ADR-0019 it is not. This is a READ of a
# record that is replaced atomically, so a lock adds no consistency to it; ownership is now changed
# only under the affected TOPIC's lock, which is what the apply path holds when it acts. Taking it in
# one of these two paths and not the other would leave two shapes for one read and invite a reader to
# think one of them was load-bearing.
function Get-ResetSelection {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$ActingSeat,
        [bool]$Whole,
        # THE SWEEP RESOLVES ITS SEATS INSIDE THIS LOCK, which is why the flag is passed down rather
        # than the foreign list being filtered afterwards: the claim probes and the registry read
        # that decide them have to be one consistent view, and the apply path re-runs exactly this
        # selection under its own lock before the digest is compared.
        [bool]$Idle
    )
    $registryLock = Enter-SeatRegistryLock -Workspace $Workspace
    try { Get-NotebookResetTargets -Workspace $Workspace -Seat $ActingSeat -WholeTree:$Whole -AllIdleSeats:$Idle }
    finally { Exit-BookLock -Lock $registryLock }
}

# THE LOOSE FILES, LISTED RATHER THAN DISCOVERED AT COMMIT. The commit moves every file directly
# under notebook/ except the derived index, and until 2026-09-09 the preview named none of them: the
# reader approved a list of topics and the run also moved files. The same enumeration feeds the
# preview and the plan digest, so a loose file that appears between the two invalidates the approval.
#
# AND A FILE NAMED LIKE A QUARANTINE JOURNAL IS NOT MOVED AT ALL (2026-09-10). The commit moves each
# loose file into the quarantine directory and THEN writes `reset-journal.json` beside it, so a
# `notebook/reset-journal.json` would be carried in and immediately overwritten -- the one path in
# this helper that destroys a reader's file rather than quarantining it, found while building the
# restore that reads those journals. Such a file is left in `notebook/` and reported instead: leaving
# a stray file is recoverable and overwriting one is not.
function Get-ResetLooseFiles {
    param([Parameter(Mandatory = $true)][string]$NotebookRoot)
    $reserved = @(Get-NotebookQuarantineJournalNames)
    $names = @(@(Get-ChildItem -LiteralPath $NotebookRoot -File -Force -ErrorAction SilentlyContinue) |
        Where-Object { $_.Name -cne '_master-index.md' } | ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
    [pscustomobject]@{
        movable  = @(@($names) | Where-Object { $reserved -cnotcontains $_ })
        reserved = @(@($names) | Where-Object { $reserved -ccontains $_ })
    }
}

# THE PLAN DIGEST. Everything the reader is approving and nothing that merely varies: the seat, both
# scope switches, the ordered target set WITH its owning seat, and the loose files. Not the topics'
# contents -- a reset moves whole directories, and binding bytes would invalidate the approval on
# every keystroke in the Notebook while telling the reader nothing about what moves.
function Get-ResetPlanId {
    param(
        [Parameter(Mandatory = $true)][string]$ActingSeat,
        [Parameter(Mandatory = $true)][bool]$Whole,
        [Parameter(Mandatory = $true)][bool]$Desk,
        # BOUND LIKE THE OTHER TWO, so an approval for an ordinary reset can never be replayed as a
        # sweep. The target list below already differs when the flag does -- but only when some idle
        # foreign seat owns a topic, so on a workspace where the sweep happens to add nothing the two
        # plans would otherwise hash identically and the approval would carry across.
        [Parameter(Mandatory = $true)][bool]$Idle,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Targets,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$LooseFiles
    )
    $lines = @(
        'action=reset-local-notebook',
        "seat=$ActingSeat",
        "whole_tree=$($Whole.ToString().ToLowerInvariant())",
        "all_idle_seats=$($Idle.ToString().ToLowerInvariant())",
        "clear_desk=$($Desk.ToString().ToLowerInvariant())"
    ) +
        # THE OWNER *AND ITS INCARNATION* (2026-09-10). Binding the slug alone would let an approval
        # execute against a topic that changed hands to a new incarnation of the same name between
        # the preview and the run -- which reuse, newly allowed, is exactly what makes possible. A
        # pre-identity incarnation contributes an empty third field rather than a missing one, so
        # the two states cannot collide in the digest.
        @(@($Targets | ForEach-Object { "topic=$($_.topic):$($_.seat):$([string]$_.seat_id)" }) | Sort-Object -CaseSensitive) +
        @(@($LooseFiles) | ForEach-Object { "loose=$_" })
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hex = -join ($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes(($lines -join "`n"))) | ForEach-Object { $_.ToString('x2') })
    }
    finally { $sha.Dispose() }
    "reset-local-notebook-$hex"
}

# THE SWEEP'S OWN PREFLIGHT EVIDENCE, PER TOPIC (PLAN-notebook-drain.md, completion criterion 2).
#
# WHAT WILL GO, WHOSE IT IS, AND HOW MUCH OF IT ALREADY EXISTS DURABLY -- in the preflight the reader
# approves, not in a separate report they would have to know to run. A sweep reaches material this
# seat does not own, so the one thing the reader cannot supply from memory is how exposed each of
# those topics is if it goes.
#
# THE NUMBERS COME FROM THE ADVISORY ABOVE, NOT FROM A SECOND WALK. $inventoryTopics is the same
# per-topic roll-up `library_copy_advisory.topics` renders, joined here by topic name.
# `pages_without_current_copy` is the number to act on (ADR-0022): only `known-current-copy` is
# proof, a legacy record binds no content and a drifted one binds another version. `known_books` and
# `known_projects` stay apart because the reader opens a Book and a Project Hub with different
# switches and reads them with different tools.
#
# A TOPIC WITH NO ROW HAS NO PAGES, WHICH IS NOT THE SAME AS NOBODY HAVING COUNTED. The roll-up
# groups markdown pages, so a topic directory holding none produces no row at all -- a measured
# zero, reported as 0. When the advisory itself failed, $inventoryTopics is $null and every count
# here is $null too, because a 0 that a reader reads as "nothing to lose" must never stand in for
# "this was not measured". THE SUITE DOES NOT REACH THAT SECOND BRANCH: it needs the inventory
# helper itself to throw, and saying so is better than implying it is covered.
function Get-SweepCopyEvidence {
    param(
        [Parameter(Mandatory = $true)][AllowNull()][object]$TopicRows,
        [Parameter(Mandatory = $true)][string]$Topic
    )
    if ($null -eq $TopicRows) {
        return [pscustomobject]@{
            copy_evidence = 'unavailable'
            page_count = $null
            pages_without_current_copy = $null
            known_books = @()
            known_projects = @()
        }
    }
    $row = @(@($TopicRows) | Where-Object { [string]$_.topic -ceq $Topic }) | Select-Object -First 1
    if ($null -eq $row) {
        return [pscustomobject]@{
            copy_evidence = 'read'
            page_count = 0
            pages_without_current_copy = 0
            known_books = @()
            known_projects = @()
        }
    }
    [pscustomobject]@{
        copy_evidence = 'read'
        page_count = [int]$row.page_count
        pages_without_current_copy = [int]$row.pages_without_current_copy
        known_books = @($row.known_books)
        known_projects = @($row.known_projects)
    }
}

$selection = Get-ResetSelection -Workspace $resolvedWorkspace -ActingSeat $Seat -Whole ([bool]$WholeTree) -Idle ([bool]$AllIdleSeats)
$looseScan = Get-ResetLooseFiles -NotebookRoot $notebookPath
$looseFiles = @($looseScan.movable)
$planId = Get-ResetPlanId -ActingSeat $Seat -Whole ([bool]$WholeTree) -Desk ([bool]$ClearDesk) -Idle ([bool]$AllIdleSeats) `
    -Targets @($selection.targets) -LooseFiles @($looseFiles)

# ONE ROW PER TOPIC THE SWEEP ADDS, AND ONE PER FOREIGN TOPIC IT DELIBERATELY LEAVES. The skipped
# rows carry the predicate's OWN `note` rather than a remedy composed here: a second copy of that
# sentence is how this repository's two authorities always come to disagree, and the note is worded
# from the state the decision was actually made on.
$sweepPreview = [pscustomobject]@{
    requested = [bool]$AllIdleSeats
    # Reported from the selection's real counters rather than from the row counts, so the memo that
    # resolves each distinct (seat, seat_id) ONCE per pass can be held to account: a pass that probed
    # per topic would report as many probes as there are rows.
    seats_resolved = [int]$selection.sweep_seats
    claim_probes = [int]$selection.sweep_probes
    to_sweep = @(@($selection.swept) | ForEach-Object {
        $evidence = Get-SweepCopyEvidence -TopicRows $inventoryTopics -Topic ([string]$_.topic)
        [pscustomobject]@{
            topic = [string]$_.topic
            seat = [string]$_.seat
            seat_id = [string]$_.seat_id
            reason = [string]$_.reason
            copy_evidence = [string]$evidence.copy_evidence
            page_count = $evidence.page_count
            pages_without_current_copy = $evidence.pages_without_current_copy
            known_books = @($evidence.known_books)
            known_projects = @($evidence.known_projects)
        }
    })
    skipped = @(@($selection.skipped) | ForEach-Object {
        [pscustomobject]@{
            topic = [string]$_.topic
            seat = [string]$_.seat
            seat_id = [string]$_.seat_id
            incarnation_status = [string]$_.incarnation_status
            claim_state = [string]$_.claim_state
            reason = [string]$_.reason
            note = [string]$_.note
        }
    })
    message = if ($AllIdleSeats) {
        'Topics in to_sweep belong to OTHER seats that are idle right now; this run sets them aside and the quarantine journal records whose each one was, so they can be handed back. pages_without_current_copy is the number to act on: only known-current-copy is proof, and known_books and known_projects are where to look rather than what is proven. Each skipped row carries the rule that left it alone. A retired seat''s topics are -WholeTree''s and are not here; an unaccounted one''s are refused outright.'
    }
    else {
        'Not requested. This reset takes only this seat''s own topics. Pass -AllIdleSeats to sweep every idle foreign seat as well, naming and skipping the ones in use.'
    }
}

# WHAT WILL BE LEFT, SAID BEFORE THE READER APPROVES RATHER THAN AFTER (2026-09-15). Every topics_*
# field below predicts what this run will TAKE, and none of them answers the question a reader who
# asked for an empty Notebook is actually asking. `remaining_in_notebook` answers it exactly and is
# POST-RUN, so a reader learned that two topics had survived only after approving the operation that
# was supposed to remove them. Reported from the Report Inbox by seat 2nd-b-vault-dev, whose reader
# had asked for an empty Notebook and could not get one at any scope.
#
# IT SUBTRACTS THE TARGET SET RATHER THAN ADDING UP THE OTHER LISTS, and that is the whole
# correctness argument for computing it here instead of leaving the reader to. The classification
# lists OVERLAP with `targets` by design: a swept foreign topic is in `foreign` AND `targets`, and
# under -WholeTree a retired one is in `retired` AND `targets`. So the hand-assembled recipe is
# wrong at two of the three scopes, and wrong in the direction that over-reports what survives.
#
# ITS FIELD NAMES MIRROR `remaining_in_notebook` EXACTLY, which is what lets the prediction and the
# outcome be read against each other -- the same pairing as open_books_advisory/open_books_after.
# After a completed run a disagreement between the two is a move that did not go as approved.
$targetTopicSet = @{}
foreach ($targetRow in @($selection.targets)) { $targetTopicSet[[string]$targetRow.topic] = $true }
$stayingForeign     = @(@($selection.foreign)     | Where-Object { -not $targetTopicSet.ContainsKey([string]$_.topic) })
$stayingRetired     = @(@($selection.retired)     | Where-Object { -not $targetTopicSet.ContainsKey([string]$_.topic) })
$stayingUnaccounted = @(@($selection.unaccounted) | Where-Object { -not $targetTopicSet.ContainsKey([string]$_.topic) })
$stayingProtected   = @(@($selection.protected)   | Where-Object { -not $targetTopicSet.ContainsKey([string]$_.topic) })
$stayingUnmapped    = @(@($selection.unmapped)    | Where-Object { -not $targetTopicSet.ContainsKey([string]$_.topic) })

# WHY A PROTECTED TOPIC GETS EVIDENCE AND THE OTHERS DO NOT. Every other reason a topic stays is
# answered by an action the reader can take -- close that session, retire that seat, map that topic.
# `protected` is the only one whose remedy is to undo a declaration somebody made on purpose, so it
# is the only one where the reader needs to know what that declaration is actually protecting. A
# topic with a completed publication journal is reproducible and the declaration is costing them an
# empty Notebook for nothing; a topic without one is the only copy and the declaration is load-bearing.
$stayingProtectedEvidence = @(@($stayingProtected) | ForEach-Object {
    Get-NotebookTopicJournalEvidence -Workspace $resolvedWorkspace -Topic ([string]$_.topic)
})

# THE READER'S ACTUAL QUESTION, AS ONE BOOLEAN, and defined rather than left to be guessed at. A
# reset ALWAYS rebuilds notebook/_master-index.md, so "empty" can never mean an empty directory --
# it means no topic and no loose file survives, and the index is all that is left. Loose files count
# because the reader sees them; the ones a move would destroy rather than quarantine stay behind and
# are named in loose_files_left_reserved_name.
$predictedLeftovers = @($stayingForeign).Count + @($stayingRetired).Count + @($stayingUnaccounted).Count +
                      @($stayingProtected).Count + @($stayingUnmapped).Count + @($looseScan.reserved).Count
$predictedRemaining = [pscustomobject]@{
    # Empty by construction: every target is predicted to move. It is stated rather than omitted so
    # the prediction and remaining_in_notebook have the same shape, and so a post-run value here is
    # visibly a move that did not happen.
    owned_by_this_seat = @()
    owned_by_other_seats = @($stayingForeign | ForEach-Object { "$($_.topic) (seat $($_.seat))" })
    protected = @($stayingProtected | ForEach-Object { "$($_.topic) ($($_.scope))" })
    owned_by_retired_seats = @($stayingRetired | ForEach-Object { "$($_.topic) (seat $($_.seat), retired)" })
    owned_by_unaccounted_seats = @($stayingUnaccounted | ForEach-Object { "$($_.topic) (seat $($_.seat))" })
    unmapped = @($stayingUnmapped | ForEach-Object { $_.topic })
    loose_files_left = @($looseScan.reserved)
    protected_recoverability = @($stayingProtectedEvidence)
    notebook_will_be_empty = ($predictedLeftovers -eq 0)
    # A PREDICTION ASSUMES THE RUN HAPPENS, and an unmapped topic means it will not. Saying so here
    # keeps this block from reading as a forecast of an operation that is already refused.
    note = if (@($selection.refusals).Count) {
        'This run is REFUSED as planned and will move nothing -- see refusals. The rows below describe the Notebook as it stands, not the outcome of a run.'
    }
    elseif ($predictedLeftovers -eq 0) {
        'Nothing is predicted to survive this run: notebook/ will hold its rebuilt _master-index.md and nothing else.'
    }
    else {
        "$predictedLeftovers item(s) are predicted to survive this run, so notebook/ will NOT be empty. Each row says which rule leaves it; protected_recoverability says whether a protected topic can be rebuilt if the reader decides to lift its declaration. Tell the reader this BEFORE taking their approval."
    }
}

$result = [ordered]@{
    operation = 'Reset local notebook'
    workspace = $resolvedWorkspace
    seat = $Seat
    target = $notebookPath
    item_count = $notebookItems.Count
    confirmation_required = $true
    # THE READER IS APPROVING ONE SPECIFIC SET OF MOVES (step 26a), so each of these is stated rather
    # than left to be inferred from the difference between the others. A reset that silently skips a
    # topic and one that silently includes one are both wrong.
    topics_to_quarantine = @($selection.targets | ForEach-Object { $_.topic })
    topics_protected = @($selection.protected | ForEach-Object { "$($_.topic) ($($_.scope))" })
    topics_owned_by_other_seats = @($selection.foreign | ForEach-Object { "$($_.topic) (seat $($_.seat))" })
    # TWO MORE SINCE 2026-09-10, and they are the difference this change is about. A topic owned by
    # a RETIRED incarnation is in the whole-tree set and out of the ordinary one, which is a
    # decision the reader should see stated rather than infer from a name appearing; and one whose
    # owning incarnation is UNACCOUNTED FOR -- no registry entry, no retirement record -- used to be
    # read as retired and quarantined silently.
    topics_owned_by_retired_seats = @($selection.retired | ForEach-Object { "$($_.topic) (seat $($_.seat), retired)" })
    topics_owned_by_unaccounted_seats = @($selection.unaccounted | ForEach-Object { "$($_.topic) (seat $($_.seat))" })
    topics_unmapped = @($selection.unmapped | ForEach-Object { $_.topic })
    predicted_remaining = $predictedRemaining
    # THE SWEEP, WITH ITS OWN EVIDENCE. The five fields above classify by ownership; this one says
    # which of those foreign topics this run is about to take, whose they are, and what already
    # exists durably elsewhere -- the three things a reader approving a cross-seat move needs in one
    # place. Present on every run, empty when the flag was not passed, because a field that appears
    # only sometimes cannot be asserted and cannot be missed.
    sweep = $sweepPreview
    # A loose file under notebook/ belongs to no topic, and the commit moves it. Listed here because
    # the reader is approving a set of moves and this is part of that set.
    loose_files_to_quarantine = @($looseFiles)
    # And the ones a move would destroy rather than quarantine, named rather than silently skipped.
    loose_files_left_reserved_name = @($looseScan.reserved)
    refusals = @($selection.refusals)
    plan_id = $planId
    recoverable = ('Topics are MOVED into internal/notebook-reset-quarantine/, never deleted. Bring them back with ' +
                   'tools/Restore-NotebookQuarantine.ps1, or destroy them for good with tools/Remove-NotebookQuarantine.ps1 -- ' +
                   'each is its own preflighted, approved operation.')
    # BEHIND @() SINCE S17, and the four Desk fields were one field with two shapes until then:
    # Get-DeskEntries returns its list through the pipeline, which UNROLLS one entry, so a seat with
    # one open Book reported a bare string and a seat with two an array. Invisible to every in-process
    # caller, which wraps in @() on read; visible to anything reading the -Json document, which this
    # helper did not have. The ConvertTo-RawSkipList shape S15 repaired, in a second helper.
    open_books_advisory = @(Get-DeskEntries -Workspace $resolvedWorkspace -Name 'books')
    open_projects_advisory = @(Get-DeskEntries -Workspace $resolvedWorkspace -Name 'projects')
    library_copy_advisory = $libraryCopyAdvisory
    shared_library_write = $false
    # Named in the plan, because which of the two operations this is must be visible BEFORE the
    # reader approves. The advisories above list what is currently open; this line says whether it
    # survives.
    desk_action = if ($ClearDesk) { 'cleared: this is the full Library Reset' } else { 'preserved: open Books and Project Hubs stay open. Pass -ClearDesk for the full Library Reset.' }
    # WHOSE MATERIAL THIS RUN REACHES, SAID IN ONE LINE BESIDE desk_action, for the same reason that
    # line exists: which of the shapes this is must be visible BEFORE the reader approves, and a
    # sweep is the one shape that moves somebody else's topics.
    seat_scope = if ($AllIdleSeats) {
        'this seat''s own topics AND the topics of every foreign seat that is idle right now (-AllIdleSeats, ADR-0023). Busy seats are named in sweep.skipped and left alone; a retired seat''s topics need -WholeTree and an unaccounted one''s are refused. No Desk but this seat''s own is touched.'
    }
    elseif ($WholeTree) {
        'this seat''s own topics and those of explicitly RETIRED incarnations (-WholeTree, ADR-0016). Every other seat''s material is hard-refused, whatever its liveness.'
    }
    else {
        'this seat''s own topics only. Every other seat''s material is left where it is.'
    }
    scope = if ($ClearDesk) {
        'Only the named Notebook directory will be deleted and rebuilt, and the local Virtual Desk will be cleared. raw, output, docs, internal state, workspace configuration, and Basic Memory are excluded. No repository file is touched and no Git command is run, so a clean working tree is not evidence that this reset happened.'
    }
    else {
        'Only the named Notebook directory will be deleted and rebuilt. The Virtual Desk is left exactly as it is, so every open Book and Project Hub stays open. raw, output, docs, internal state, workspace configuration, and Basic Memory are excluded. No repository file is touched and no Git command is run, so a clean working tree is not evidence that this reset happened.'
    }
}

# THE CLAIM IS PROBED BEFORE THE PLAN IS ISSUED, not after the reader has approved it. Step 15b's
# assertion sat below the preflight's `return`, so on 2026-09-09 a session with LIBRARY_SEAT_CLAIM
# blanked was handed a full quarantine plan naming two topics and no refusal at all -- an approval
# for an operation certain to fail, which is the same defect Phase 0 fixed in
# Import-ExternalWikiToShelf and which Retire-Seat.ps1 already states as the rule.
Assert-SeatClaimHeld -StateDirectory (Join-Path $resolvedWorkspace '.claude') -Seat $Seat | Out-Null
if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$result) -Json:$Json; return }
if (-not $UserConfirmed) { throw 'Reset aborted: ask the user once for confirmation, then rerun with -UserConfirmed.' }
# THE PLAN IS CHECKED IN ONE PLACE, AND IT IS UNDER THE LOCK -- see the apply block below. A second
# comparison here against the selection read before the lock would look like defence in depth and is
# not: it can only agree with the one that matters, so removing the one that matters leaves every
# test still green. Falsified by doing exactly that.

# Removal, scaffold and render inside one critical section. A reset that dropped the topics and
# then took the lock would leave a window in which the master index still advertises topics that
# are gone, and a concurrent compile would render from a directory the reset is halfway through.
#
# THE SCAFFOLD NO LONGER CARRIES ITS OWN COPY OF THE INDEX TEXT. It had one, written with
# Set-Content -Encoding UTF8, which is why notebook/_master-index.md carried a UTF-8 BOM while
# every other Library writer wrote none -- and a rendered file with two possible byte sequences can
# never be verified by readback. Making the directory is all that is left here; the renderer owns
# the text and the encoding, and writes the index as the last act of this same critical section.
# QUARANTINE, NOT DELETE (ADR-0016). Each target is atomically RENAMED into a stamped quarantine
# directory. A metadata journal was the first design and round 1 killed it: JSON cannot restore
# files after Remove-Item -Recurse, so recoverability has to be a property of the MOVE.
#
# ONE ARGUMENT, AND IT IS AN OBJECT. This commit block takes its values as arguments rather than from
# a closure, which is the contract Invoke-NotebookRender states and the trap this codebase already
# paid for. It is a single pscustomobject because PowerShell FLATTENS a nested array inside `@(...)`:
# passing @($path, $workspace, @($targets)) would splat the targets out as separate parameters and
# bind only the first.
# THE REGISTRY LOCK WRAPS THE WHOLE APPLY, then topic locks in sorted order, then the render lock --
# the total order, outermost first. Held this long on purpose: a reset is inherently whole-scope, and
# -ClearDesk at the end writes this seat's Desk files, which is registry-class state. Nothing here
# runs a child process, so there is no helper waiting on this lock from the inside.
$topicLocks = [Collections.Generic.List[object]]::new()
$moves = @()
$applyRegistryLock = Enter-SeatRegistryLock -Workspace $resolvedWorkspace
try {
    # REVALIDATED UNDER THE LOCK, and the plan_id is what makes that mean something. The selection
    # above was computed before the reader read it; recomputing here and comparing the digest is how
    # a topic added, remapped or newly owned in between becomes a refusal rather than a silent
    # inclusion.
    #
    # AND IT TAKES NO OWNERSHIP LOCK, WHICH IS THE 2026-09-09 CHANGE (ADR-0019). It used to take one
    # here and release it before the topic locks below -- with a comment saying the release was
    # forced, because Move-NotebookTopicToQuarantine reaches ownership from inside a topic lock and
    # holding it through the moves would have deadlocked. That is now settled the other way: the
    # ownership record is replaced atomically, so this READ is already a consistent snapshot without
    # any lock, and what makes each individual move safe is the TOPIC lock taken below -- which is
    # also the only lock under which ownership may now change at all. So the lock that had to be
    # dropped for the wrong reason is simply not needed for the right one.
    $selection = Get-NotebookResetTargets -Workspace $resolvedWorkspace -Seat $Seat -WholeTree:$WholeTree -AllIdleSeats:$AllIdleSeats
    $looseScan = Get-ResetLooseFiles -NotebookRoot $notebookPath
    $looseFiles = @($looseScan.movable)
    $currentPlanId = Get-ResetPlanId -ActingSeat $Seat -Whole ([bool]$WholeTree) -Desk ([bool]$ClearDesk) -Idle ([bool]$AllIdleSeats) `
        -Targets @($selection.targets) -LooseFiles @($looseFiles)
    if ($currentPlanId -cne $ApprovedPlanId) {
        $because = if ([string]::IsNullOrWhiteSpace($ApprovedPlanId)) {
            'no plan_id was passed'
        }
        else {
            'the seat, the scope switches, the topics selected, their owners, or the loose files under notebook/ are not what that plan described'
        }
        throw ("Reset aborted and nothing was moved: $because. Rerun the current preflight and pass " +
               'its exact plan_id as -ApprovedPlanId.')
    }
    if (@($selection.refusals).Count) { throw ('Reset aborted: ' + (@($selection.refusals) -join ' ')) }

    # Created only now, with the plan revalidated: a refused reset should leave no empty stamped
    # directory behind for a reader to wonder about.
    $quarantineDirectory = Join-Path (Get-NotebookQuarantineRoot -Workspace $resolvedWorkspace) `
        ("$Seat-" + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $quarantineDirectory -Force | Out-Null
    $commitContext = [pscustomobject]@{
        notebook_path = $notebookPath
        workspace = $resolvedWorkspace
        quarantine = $quarantineDirectory
        targets = @($selection.targets)
        loose_files = @($looseFiles)
    }

    foreach ($topic in @(@($selection.targets | ForEach-Object { $_.topic }) | Sort-Object -CaseSensitive)) {
        [void]$topicLocks.Add((Enter-BookLock -Workspace $resolvedWorkspace -BookRoot "notebook/$topic"))
    }
    $render = Invoke-NotebookRender -Workspace $resolvedWorkspace -CommitArgument @($commitContext) -Commit {
        param($Context)
        $moved = @()
        foreach ($row in @($Context.targets)) {
            $moved += Move-NotebookTopicToQuarantine -Workspace $Context.workspace -Topic $row.topic `
                -ExpectedSeat $row.seat -ExpectedSeatId ([string]$row.seat_id) -QuarantineDirectory $Context.quarantine
        }
        # A loose file under notebook/ belongs to no topic. The master index is derived and is
        # rebuilt; anything else is moved rather than dropped, because nothing else is meant to be
        # there and guessing which stray file is disposable is not this helper's call.
        #
        # EXACTLY THE APPROVED NAMES, not a fresh enumeration. This block used to re-scan the
        # directory and move whatever it found, so a file the preview never listed was moved on the
        # reader's approval of a list of topics. A file that appeared since the digest was
        # revalidated -- a direct Write takes no lock -- is LEFT and reported, because it is not what
        # was approved.
        $looseMoved = @()
        foreach ($name in @($Context.loose_files)) {
            $loosePath = Join-Path $Context.notebook_path $name
            if (-not (Test-Path -LiteralPath $loosePath -PathType Leaf)) { continue }
            Move-Item -LiteralPath $loosePath -Destination (Join-Path $Context.quarantine $name) -Force
            $looseMoved += $name
        }
        # THE SUITE CANNOT REACH THIS BRANCH, and saying so is better than implying it can. Filling
        # it needs a loose file to appear between the digest revalidation a few lines above and this
        # enumeration -- both inside the registry lock, in this process -- so only a concurrent
        # direct write can do it, and no Library writer creates loose files here. What the suite does
        # prove is the positive control: on an ordinary run this list is empty, which is how a
        # reader knows the enumeration ran at all.
        $unapproved = @((Get-ResetLooseFiles -NotebookRoot $Context.notebook_path).movable)
        if (-not (Test-Path -LiteralPath $Context.notebook_path -PathType Container)) {
            New-Item -ItemType Directory -Path $Context.notebook_path -Force | Out-Null
        }
        # Returned behind a comma as ONE object: the commit's result travels the pipeline, which
        # unrolls a collection and would deliver an empty move list as $null.
        , ([pscustomobject]@{ topics = @($moved); loose_moved = @($looseMoved); loose_unapproved = @($unapproved) })
    }
    $commit = $render.commit_result
    $moves = @($commit.topics)
    $looseMoved = @($commit.loose_moved)
    $looseLeft = @($commit.loose_unapproved)

    # The record of what moved, written BESIDE the material, so a restore needs nothing but this
    # directory. It describes the moves; the material itself is what makes them reversible.
    $journalBody = ([pscustomobject]@{
        operation = 'Reset local notebook'
        seat = $Seat
        whole_tree = [bool]$WholeTree
        # RECORDED BESIDE whole_tree BECAUSE IT IS THE OTHER HALF OF THE SAME QUESTION. A quarantine
        # holding several seats' topics came either from a whole-tree reset over retired seats or
        # from a sweep over idle ones, and `recorded_owners` below cannot tell those apart -- both
        # name more than one seat. The restore routes read this journal and nothing else knows.
        all_idle_seats = [bool]$AllIdleSeats
        clear_desk = [bool]$ClearDesk
        plan_id = $ApprovedPlanId
        quarantined_utc = [DateTime]::UtcNow.ToString('o')
        moves = @($moves)
        # WHO OWNED EACH TOPIC, added 2026-09-10 for the restore. `moves` records what happened to
        # each directory and says nothing about whose it was, and `seat` above is the seat that RAN
        # the reset -- which under -WholeTree is not the owner of most of what moved. Without this a
        # restore would have to read the ownership row and trust that nobody had touched it, so the
        # one thing it most needs to compare against would be the one thing not recorded.
        targets = @(@($selection.targets) | ForEach-Object {
            [pscustomobject]@{ topic = [string]$_.topic; seat = [string]$_.seat; seat_id = [string]$_.seat_id }
        })
        loose_files = @($looseMoved)
    } | ConvertTo-Json -Depth 6)
    Write-AtomicText -Path (Join-Path $quarantineDirectory 'reset-journal.json') -Text ($journalBody + "`n") | Out-Null

    # WHAT IS ACTUALLY LEFT, RE-DERIVED AFTER THE MOVES AND STILL INSIDE THE REGISTRY LOCK
    # (2026-09-15). The five `topics_*` fields on the result were computed from the PRE-LOCK selection
    # and never read again, so a completed run reported what was PREDICTED rather than what remained
    # -- and this helper's own rule, already written twice below, is that a field that cannot disagree
    # with the run is not evidence. Under -WholeTree the old fields were plainly false rather than
    # merely stale: `topics_owned_by_retired_seats` named a topic this same run had just quarantined.
    #
    # IT MUST BE HERE, NOT AFTER THE `finally`. Get-NotebookResetTargets asserts the registry lock is
    # held, because deciding which incarnations are retired is a cross-seat read; outside the lock it
    # would refuse, and a re-read taken after the release would describe a workspace other seats had
    # been free to change in between.
    #
    # THE REFUSALS ARE READ AND DELIBERATELY NOT RAISED. That function refuses an unmapped topic,
    # which is the right answer BEFORE a move and the wrong one after: the material is already in the
    # quarantine, and throwing here would fail a reset that had succeeded and leave the reader with no
    # journal reference for the moves it had just made. Only the classification lists are taken.
    #
    # AND IT CANNOT WIDEN THE RUN. Nothing below acts on this selection -- no target is added, no
    # refusal is retried, nothing moves. It is a read, and the only reason it sits inside the lock is
    # so that it is a read of the same world the moves ran in.
    #
    # AND IT DELIBERATELY DOES NOT CARRY -AllIdleSeats. This read answers "what is still in
    # notebook/ and whose is it", so an idle foreign topic that survived the run -- one whose move
    # was refused at the last moment -- must appear under `owned_by_other_seats`, which is whose it
    # is. Passing the flag would re-classify it as a target and report it under `owned_by_this_seat`,
    # the one field the playbook tells the reader should be empty.
    #
    # NO SUITE PROVES THIS, AND SAYING SO IS BETTER THAN IMPLYING ONE DOES. Falsification injected the
    # flag here and every suite stayed green: after a sweep the only foreign topics left are the ones
    # it SKIPPED, which are skipped again by this read and land in `owned_by_other_seats` either way.
    # Reaching the difference needs an idle foreign topic still on disk after the run, and the two
    # ways a move is declined -- an ownership change, or a directory already gone -- produce a topic
    # that is not there to classify. It is written this way because it is the right read, not because
    # a check caught it, and a future reader tightening this line gets no red from the suite.
    $afterSelection = Get-NotebookResetTargets -Workspace $resolvedWorkspace -Seat $Seat -WholeTree:$WholeTree

    # Inside the registry lock since 2026-09-09. It writes the same two files a cross-seat rename
    # sweep rewrites, and it used to race that sweep with no lock on either side of the collision.
    if ($ClearDesk) { Clear-VirtualDesk -Workspace $resolvedWorkspace }
}
finally {
    foreach ($lock in $topicLocks) { Exit-BookLock -Lock $lock }
    Exit-BookLock -Lock $applyRegistryLock
}

$result.status = 'completed'
$result.rebuilt_files = @('_master-index.md')
$result.quarantine_directory = $quarantineDirectory
$result.quarantined = @($moves | Where-Object { $_.moved } | ForEach-Object { $_.topic })
# A topic whose ownership changed between the preflight and the move is REPORTED, never silently
# skipped: the reader approved a set, and this is how they learn the set was not what ran.
$result.left_in_place = @($moves | Where-Object { -not $_.moved } | ForEach-Object { "$($_.topic): $($_.reason)" })
# Reported from what the commit actually moved, not from the plan. The two agree unless a loose file
# vanished under the lock, and a field that cannot disagree with the run is not evidence.
$result.loose_files_quarantined = @($looseMoved)
# A loose file that appeared after the digest was revalidated is left alone and named here. It is
# not in the approved set, and moving it because it happened to be there is exactly what binding the
# plan_id was for.
$result.loose_files_left_unapproved = @($looseLeft)
# Re-read from the enumeration the apply made, not from the preflight's: this field says which files
# the run declined to move, so it must come from the run.
$result.loose_files_left_reserved_name = @($looseScan.reserved)
# Read from the render rather than asserted: a reset that rebuilt an index still listing topics
# would be a reset that did not remove them.
$result.master_index_topic_count = $render.topic_count
# WHAT REMAINS, FROM THE RE-DERIVATION ABOVE RATHER THAN FROM THE PLAN. The `topics_*` fields near the
# top of this result are what the reader APPROVED and are left exactly as they were shown; these are
# what the run left behind. Both are kept for the reason `open_books_advisory` and `open_books_after`
# already sit side by side: the approved set and the outcome are two different facts, and a reader
# checking one against the other needs both. `owned_by_this_seat` is the one that should be empty on
# an ordinary run -- a topic this seat owns that is STILL in notebook/ is a move that did not happen,
# and `left_in_place` above says why.
#
# AND IT CARRIES NO COUNT OF ITS OWN. `master_index_topic_count` above already reports how many
# topics remain, read from the render; a second count summed from these lists would be a different
# derivation of the same number, free to disagree with it -- and under -WholeTree it would also
# double-count, because a retired seat's topic is in `targets` AND in `retired` by design.
$result.remaining_in_notebook = [pscustomobject]@{
    owned_by_this_seat = @($afterSelection.targets | ForEach-Object { $_.topic })
    owned_by_other_seats = @($afterSelection.foreign | ForEach-Object { "$($_.topic) (seat $($_.seat))" })
    protected = @($afterSelection.protected | ForEach-Object { "$($_.topic) ($($_.scope))" })
    owned_by_retired_seats = @($afterSelection.retired | ForEach-Object { "$($_.topic) (seat $($_.seat), retired)" })
    owned_by_unaccounted_seats = @($afterSelection.unaccounted | ForEach-Object { "$($_.topic) (seat $($_.seat))" })
    unmapped = @($afterSelection.unmapped | ForEach-Object { $_.topic })
}
# Reported from the switch rather than hardcoded. It was hardcoded $true, which stayed true only
# because there was one code path; a field that cannot disagree with the run is not evidence.
$result.virtual_desk_cleared = [bool]$ClearDesk
# Read back rather than predicted: the point of preserving the Desk is that it is still there, and
# saying so from the state file is what makes the claim checkable.
$result.open_books_after = @(Get-DeskEntries -Workspace $resolvedWorkspace -Name 'books')
$result.open_projects_after = @(Get-DeskEntries -Workspace $resolvedWorkspace -Name 'projects')
$result.basic_memory_write = $false
Write-LibraryResult -Result ([pscustomobject]$result) -Json:$Json
