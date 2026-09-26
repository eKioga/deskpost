<#
.SYNOPSIS
    Triage material out of the Notebook or a capture Book, as a batch or as one note.

.DESCRIPTION
    Handoff collapsed into Triage on 2026-08-28 (fork A). This helper absorbs
    New-LibraryHandoffPlan.ps1, Invoke-LibraryHandoff.ps1 and Move-ShelfNote.ps1, so one verb covers
    both local buffers and the source decides which destinations are reachable. The action schema,
    the kind-by-source matrix, and the digest live in TriagePlanCommon.ps1.

    TWO SURFACES, ONE CODE PATH.

      -ActionJson    a batch. Validated, digest-bound, journalled, retryable.
      -PlanPath      the same batch, re-run from its stored plan document.
      -Source/-To    one note. Composed into a ONE-ACTION PLAN IN MEMORY -- no plan file, no
                     journal -- so a single note and a batch of twenty compute their write sets,
                     their Desk requirements, and their digest through the same code. Two write
                     paths would be two chances to disagree about where a file lands, and a Holding
                     Shelf filename derives from the date plus collision suffixing, which is as true
                     of one note as of twenty.

    CONFIRMATION IS PER KIND, NOT PER SURFACE. A batch always costs a preflight, an approval, and an
    exact plan_id, because a reader approving twenty destinations at once needs to see them. A single
    note inherits the policy its child already had: review, notebook, holding and shelf-book run on
    one call, because Move-ShelfNote and Add-ShelfBookPage never asked for more and making tidying
    ceremonial is how tidying stops happening; discard, project and book take the full approval,
    because one destroys and two reach the shared collection.

    THE GATE. Writing INTO a capture Book is ungated; any action whose SOURCE is a capture Book needs
    that Book open. TriagePlanCommon computes the required Desk state as a list -- a shelf-book action
    sourced from holding needs two Books open -- and this runner asserts it twice, at preflight and
    again immediately before the write, because a Book can be closed in between.

    The state machine, unchanged from Handoff v2 apart from the kinds it carries:

      1. Preflight every action; any failure refuses the batch before a single write. Plan
         validation has already rejected write-set overlaps, delete-set overlaps, and a discard
         sharing a batch with something that rewrites the same note.
      2. Execute in fixed order -- review, holding, notebook, shelf-book, project, book, discard --
         cheapest and most reversible first, irreversible last.
      3. Revalidate each action's gate at execution: source hashes unchanged, Books still open, and
         the exact approved paths still writable. Execution fails rather than quietly relocating.
      4. On failure, CONTINUE to the remaining actions. The reader's goal is losing nothing before a
         reset, so saving what can be saved beats stopping early.
      5. Report per-action status. The batch is `incomplete` unless every action succeeded; a partial
         triage is never dressed up as a success.
      6. Retry re-runs only actions not marked succeeded. A succeeded action is an idempotent no-op;
         any drift in the source changes the batch digest and demands a fresh preflight.
      7. A durable batch journal owns that state, written atomically after every action.

    RECORDS: READ BOTH, WRITE ONE. New plans and journals go to internal/triage-plans/ and
    internal/triage-journals/. The legacy internal/handoff-plans/ and internal/handoff-journals/ are
    still accepted as -PlanPath and -JournalPath so nothing on disk becomes unreachable, and nothing
    in them is written, moved, or rewritten. A schema-2 handoff plan is READ and then refused
    execution with an exact message: the digest recipe gained source, delete_set and a list-valued
    required_desk_state, so it cannot re-resolve, and supporting both recipes would put two parsers
    of one record in one file.

    Write reporting is honest per destination. One flag for "something was written" would claim a NAS
    write when only a Holding Shelf entry landed.
#>
[CmdletBinding()]
param(
    # --- Batch surface -----------------------------------------------------------------------
    [string]$ActionJson,
    [string]$PlanPath,

    # --- Single-note surface -----------------------------------------------------------------
    [ValidateSet('Holding', 'Notebook')][string]$Source = 'Holding',
    [string]$BookSlug = 'holding',
    [string]$Page,
    [string]$MatchText,
    [string]$SourcePath,
    [ValidateSet('Notebook', 'Holding', 'ShelfBook', 'Project', 'Book', 'Review', 'Discard')][string]$To,
    [string]$Topic,
    [string]$Slug,
    [string]$PagePath,
    [string]$Title,
    [string]$Purpose,
    [string]$Summary,
    [ValidateSet('Projects', 'Reference', 'Workflows')][string]$Collection,
    [string[]]$NextAction = @(),
    [string[]]$IncludePage = @(),
    [switch]$Reopen,

    # --- Shared ------------------------------------------------------------------------------
    [string]$WorkspacePath,
    # Which seat owns the Notebook topic this writes. Defaults to LIBRARY_SEAT; there is no
    # default seat, so an unset one is refused rather than guessed at.
    [string]$Seat,
    [string]$CaptureDate,
    [string]$ProjectId,
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [string]$ApprovedPlanId,
    [string]$JournalPath,
    [int]$LockTimeoutSeconds = 20,
    [switch]$UserConfirmed,
    [switch]$Preflight,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'TriagePlanCommon.ps1')
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
. (Join-Path $PSScriptRoot 'BookManifestTransaction.ps1')
# The Notebook route creates topics, so it participates in the serialized master-index render.
# PLAN-multi-desk.md Release 1, step 2: naming only the compiler was the round-1 omission.
. (Join-Path $PSScriptRoot 'NotebookIndex.ps1')
. (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')

# STEP 20: THE WORKSPACE IS SELECTED, NOT ASSUMED. `Split-Path -Parent $PSScriptRoot` answered
# "which workspace" with "one level above my own code", which is right only while the program and
# the workspace are the same directory. Order: -WorkspacePath, then LIBRARY_WORKSPACE, then the
# nearest `.library/workspace.json` above the working directory, then this program's own root --
# and that last one only while the program really is a workspace, which is what keeps an un-split
# checkout working and stops an installed package inventing one. tools/WorkspaceRegistry.ps1.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
# STEP 21: the shared-collection write fence. tools/CollectionOwnership.ps1.
. (Join-Path $PSScriptRoot 'CollectionOwnership.ps1')
$WorkspacePath = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
$McpUrl = Resolve-LibraryWriteEndpoint -McpUrl $McpUrl -WorkspacePath $WorkspacePath -Operation 'triaging a Shelf note'
$ProjectId = Resolve-LibraryCollectionId -CollectionId $ProjectId
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

# The kinds that reach the shared collection or destroy something. These are the ones a single note
# still pays a full approval for; the rest run on one call, exactly as their child helpers did.
$script:TriageConfirmingKinds = @('discard', 'project', 'book')
# The kinds this helper performs itself, inside the source capture Book, rather than delegating.
$script:TriageInlineKinds = @('review', 'notebook', 'discard')

$toKind = @{
    'Notebook' = 'notebook'; 'Holding' = 'holding'; 'ShelfBook' = 'shelf-book'
    'Project' = 'project'; 'Book' = 'book'; 'Review' = 'review'; 'Discard' = 'discard'
}

# --- Which surface was asked for ------------------------------------------------------------------

$hasActionJson = -not [string]::IsNullOrWhiteSpace($ActionJson)
$hasPlanPath = -not [string]::IsNullOrWhiteSpace($PlanPath)
$hasTo = -not [string]::IsNullOrWhiteSpace($To)
$surfaces = @($hasActionJson, $hasPlanPath, $hasTo) | Where-Object { $_ }
if (@($surfaces).Count -ne 1) {
    throw 'Name exactly one surface: -ActionJson for a new batch, -PlanPath to re-run a stored plan, or -To with -Source for a single note.'
}

# --- Compose the request --------------------------------------------------------------------------

$planDocument = $null
$planFull = ''
$batchMode = $true

if ($hasPlanPath) {
    # Both plan roots are accepted. internal/handoff-plans/ holds real records of real batches, and a
    # path that no longer resolves would make history unreachable for no gain.
    $planRoots = @('internal/triage-plans', 'internal/handoff-plans') | ForEach-Object {
        [IO.Path]::GetFullPath((Join-Path $workspace $_)).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    }
    $planFull = [IO.Path]::GetFullPath($PlanPath)
    if (-not @($planRoots | Where-Object { $planFull.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })) {
        throw 'PlanPath must be inside internal/triage-plans/ or internal/handoff-plans/.'
    }
    if (-not (Test-Path -LiteralPath $planFull -PathType Leaf)) { throw "Triage plan was not found: $PlanPath" }
    $planDocument = ([IO.File]::ReadAllText($planFull, [Text.UTF8Encoding]::new($false, $true))) | ConvertFrom-Json

    $version = Get-TriageValue $planDocument 'version'
    if ($null -eq $version) { throw "The plan at $PlanPath declares no schema version." }
    if ([int]$version -ne $script:TriagePlanSchema) {
        # READABLE, NOT RE-RUNNABLE, and said exactly rather than left as a mismatch. Schema 2 is the
        # handoff plan format: its digest recipe had no source, no delete_set, and a single-valued
        # required_desk_state, so its stored action digests cannot be reproduced without keeping a
        # second recipe in TriagePlanCommon.ps1 -- the drift this codebase has paid for before. The
        # document itself still parses and stays on disk untouched.
        throw "The plan at $PlanPath is schema $version. This runner reads schema $($script:TriagePlanSchema). A schema 2 plan is a Library Handoff plan from before 2026-08-28: it is kept and readable, but its action digests were computed without source, delete_set, or a list-valued required_desk_state, so it cannot be re-resolved and will not be re-run. Rebuild it with -ActionJson."
    }
    $stored = @(Get-TriageArray $planDocument 'actions')
    if ($stored.Count -eq 0) { throw 'Library Triage plan has no actions.' }
    if ([string]::IsNullOrWhiteSpace($CaptureDate)) { $CaptureDate = [string](Get-TriageValue $planDocument 'capture_date') }
    # Re-resolved from the reader's own request, against the sources as they are now. A source edited
    # since the plan was written produces a different digest, which is caught here rather than after
    # a write. The stored envelope is evidence, never the input.
    $requested = @($stored | ForEach-Object { Get-TriageValue $_ 'request' })
}
elseif ($hasActionJson) {
    try {
        $parsed = $ActionJson | ConvertFrom-Json
        [object[]]$requested = @($parsed)
    }
    catch { throw 'ActionJson must be valid JSON.' }
    if ($requested.Count -eq 0) { throw 'A Library Triage plan needs at least one action.' }
    $stored = @()
}
else {
    $batchMode = $false
    $kind = $toKind[$To]
    $sourceKind = $Source.ToLowerInvariant()
    $single = [ordered]@{ kind = $kind; source = $sourceKind }
    if ($sourceKind -ceq 'holding') {
        $single['source_slug'] = $BookSlug
        if (-not [string]::IsNullOrWhiteSpace($Page)) { $single['source_page'] = $Page }
        if (-not [string]::IsNullOrWhiteSpace($MatchText)) { $single['source_match'] = $MatchText }
    }
    else {
        $single['source_path'] = $SourcePath
        if (@($IncludePage).Count) { $single['include_pages'] = @($IncludePage) }
    }
    if (-not [string]::IsNullOrWhiteSpace($Topic)) { $single['topic'] = $Topic }
    if (-not [string]::IsNullOrWhiteSpace($Slug)) { $single['slug'] = $Slug }
    if (-not [string]::IsNullOrWhiteSpace($PagePath)) { $single['page_path'] = $PagePath }
    if (-not [string]::IsNullOrWhiteSpace($Title)) { $single['title'] = $Title }
    if (-not [string]::IsNullOrWhiteSpace($Purpose)) { $single['purpose'] = $Purpose }
    if (-not [string]::IsNullOrWhiteSpace($Summary)) { $single['summary'] = $Summary }
    if (-not [string]::IsNullOrWhiteSpace($Collection)) { $single['collection'] = $Collection }
    if (@($NextAction).Count) { $single['next_actions'] = @($NextAction) }
    if ($Reopen) { $single['reopen'] = $true }
    $requested = @([pscustomobject]$single)
    $stored = @()
}

# The local calendar date, as a capture names its note (S50).
if ([string]::IsNullOrWhiteSpace($CaptureDate)) { $CaptureDate = [DateTime]::Now.ToString('yyyy-MM-dd') }
$actions = @(Resolve-TriagePlanActions -Actions $requested -Workspace $workspace -CaptureDate $CaptureDate)

# A stored plan is evidence about what was approved. Checking the re-resolved digests against it is
# what turns "the file says so" into "the file and the disk agree".
if ($hasPlanPath) {
    $storedById = @{}
    foreach ($entry in $stored) { $storedById[[string](Get-TriageValue $entry 'action_id')] = $entry }
    foreach ($action in $actions) {
        if (-not $storedById.ContainsKey($action.action_id)) {
            throw "Action '$($action.kind):$($action.slug)' no longer matches the stored plan -- its source or metadata changed since the plan was written. Rebuild the plan before running it."
        }
        $storedDigest = [string](Get-TriageValue $storedById[$action.action_id] 'action_digest')
        if ($storedDigest -cne $action.action_digest) {
            throw "Action '$($action.action_id)' has drifted from the stored plan. Rebuild the plan before running it."
        }
    }
}

# In single-note mode the reader gets the child's own policy, not the batch's. Everything else --
# the digest, the write set, the Desk gate, the revalidation -- is identical.
$requiresApproval = $batchMode -or @(@($actions) | Where-Object { $_.kind -cin $script:TriageConfirmingKinds }).Count -gt 0

$publisher = Join-Path $PSScriptRoot 'Publish-BookCopy.ps1'
$projectCopy = Join-Path $PSScriptRoot 'Copy-LocalPagesToProject.ps1'
$shelfNote = Join-Path $PSScriptRoot 'Add-ShelfNote.ps1'
$shelfPage = Join-Path $PSScriptRoot 'Add-ShelfBookPage.ps1'

# THE ACTING SEAT, RESOLVED ONCE AND NEVER THROWING HERE. Two gates below need the name and only one
# of them is entitled to refuse for its absence: the Notebook route's claim assertion further down,
# because Triage's other destinations write the Shelf or the shared collection and need no seat at
# all. So this classifies and stores, and a `$null` here means "no seat named" rather than an error.
$script:TriageSeatName = $null
$script:TriageSeatState = Resolve-SeatName -Seat $Seat -StateDirectory (Join-Path $workspace '.claude')
if ($script:TriageSeatState.status -ceq 'named') { $script:TriageSeatName = [string]$script:TriageSeatState.seat }

# --- Gates ------------------------------------------------------------------------------------

function Assert-NotebookTopicOwnershipAllows($Action) {
    <#
        A VALID CLAIM AT THIS SEAT IS NOT ENTITLEMENT TO ANOTHER SEAT'S TOPIC (ADR-0019). Checked
        here, in the preflight's own gate loop, because that is where a batch is refused BEFORE the
        reader spends an approval on it -- the same position Assert-DeskState holds. The apply path
        asserts it again under the topic lock, which is where it is enforced rather than reported.

        Skipped when no seat is named: this is not the gate entitled to refuse that, and the claim
        assertion that is refuses with the message a reader can act on.
    #>
    if ([string]$Action.kind -cne 'notebook') { return }
    if ([string]::IsNullOrWhiteSpace($script:TriageSeatName)) { return }
    $topicSlug = [string](Get-TriageValue $Action.metadata 'topic')
    if ([string]::IsNullOrWhiteSpace($topicSlug)) { return }
    $verdict = Test-NotebookTopicWritable -Workspace $workspace -Topic $topicSlug -Seat $script:TriageSeatName
    if (-not $verdict.writable) { throw [string]$verdict.reason }
}

function Get-LocalWritePaths($Action) {
    # Only the workspace-local half can be checked from here. A shared destination's collision is
    # the child's to detect, and it does: the publisher refuses an existing Book without
    # -ReplaceExisting, which triage never passes.
    @(@($Action.write_set) | Where-Object { $_ -cnotmatch '^(books|projects)/' })
}

# A NOTEBOOK ACTION'S WRITE SET NAMES TWO FILES IT DOES NOT CREATE, and until 2026-09-23 this gate refused
# both whenever they existed. The master index is RE-RENDERED under the render lock from the topics on disk,
# and an existing topic's `_index.md` is left exactly as it is -- the existing-topic branch of
# Invoke-NoteAction copies the note and nothing else. They are in the write set so that validation sees two
# actions contending for one Notebook, not because this action brings them into existence. Refusing them made
# triage to the Notebook refuse in every workspace that had a master index -- which, since `library init` lays
# one out (ADR-0041), is every workspace -- and made the existing-topic branch unreachable. Found by porting
# this runner (S43); the fixtures here were built by hand with no master index, which is why no case saw it.
function Test-TriageDerivedWritePath($Action, [string]$Relative) {
    if ([string]$Action.kind -cne 'notebook') { return $false }
    if ($Relative -cmatch '(^|/)_master-index\.md$') { return $true }
    $topicSlug = [string](Get-TriageValue $Action.metadata 'topic')
    if ($Relative -ceq "notebook/$topicSlug/_index.md") {
        return (Test-Path -LiteralPath (Join-Path $workspace (Join-Path 'notebook' $topicSlug)) -PathType Container)
    }
    $false
}

function Assert-WriteSetWritable($Action) {
    foreach ($relative in @(Get-LocalWritePaths $Action)) {
        if (Test-TriageDerivedWritePath $Action $relative) { continue }
        $full = Join-Path $workspace ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
        if (Test-Path -LiteralPath $full) {
            throw "The approved write set is no longer writable: '$relative' already exists. Nothing was written for this action."
        }
    }
}

# There is deliberately no Assert-DeleteSetPresent beside Assert-WriteSetWritable, and the absence is
# a decision rather than a gap. A discard's target is its own source: Resolve-TriageNoteSource lists
# the Book's notes from disk on EVERY invocation -- preflight and confirmed run alike -- so a note
# that has gone cannot be named at all, and the refusal arrives before any gate runs. Assert-
# SourceUnchanged then re-reads and re-hashes it immediately before the write. A third check would be
# one that cannot fire, and a check nobody can make go red is a check nobody maintains.

# The local writers take a path and read it again themselves, so the bytes the approval covered and
# the bytes that land are only the same if nothing edits the file in between. Re-hashing here closes
# that window without changing the children.
function Assert-SourceUnchanged($Action) {
    foreach ($entry in @($Action.source_manifest)) {
        $split = ([string]$entry).LastIndexOf('|')
        $relative = ([string]$entry).Substring(0, $split)
        $expected = ([string]$entry).Substring($split + 1)
        $full = Join-Path $workspace ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "The approved source '$relative' is gone. Nothing was written for this action." }
        $actual = Get-TriageHash ([IO.File]::ReadAllText($full, [Text.UTF8Encoding]::new($false, $true)))
        if ($actual -cne $expected) { throw "The approved source '$relative' changed after the approval. Nothing was written for this action; rebuild the plan." }
    }
}

# A LIST, not one string. A shelf-book action sourced from the Holding Shelf needs the source Book
# open to name the note and the destination Book open to write the page, and a single-valued field
# could only ever have carried one of them -- silently dropping the other gate.
function Assert-DeskState($Action) {
    foreach ($required in @($Action.required_desk_state)) {
        if ([string]$required -cmatch '^shelf-book-open:(.+)$') {
            $slug = $Matches[1]
            $why = if ($slug -ceq $Action.source_slug -and $Action.source -ceq 'holding') { 'triaging its notes' } else { 'graduating a page into it' }
            Assert-ShelfBookOpen -Workspace $workspace -Slug $slug -Action $why
            continue
        }
        throw "Unknown required Desk state '$required'."
    }
}

# The child's own preflight is the authority on where it writes. Comparing it to the set the plan
# bound is what keeps two definitions of one path rule from drifting apart unnoticed -- the failure
# mode that has already cost this codebase a helper that passed every test and found nothing.
function Assert-ChildWriteSetMatches($Action, $Planned) {
    $expected = @(@($Action.write_set) | Sort-Object)
    $actual = @(@($Planned) | Sort-Object)
    if (($expected -join '|') -cne ($actual -join '|')) {
        throw "Action '$($Action.action_id)' would write paths the approval does not cover. Approved: $($expected -join ', '). Planned: $($actual -join ', ')."
    }
}

# --- Children ---------------------------------------------------------------------------------

# What a shelf-book action hands its child. A note is COMPOSED into a page body with its frontmatter
# stripped; a Notebook article is passed by path and copied. The reason lives in TriagePlanCommon's
# Get-TriageNoteBody, and the digest binds the delivered bytes either way.
function Get-ShelfPageArgs($Action) {
    # NOT named $args. That is an automatic variable inside every PowerShell function -- the array of
    # unbound arguments -- and assigning a hashtable to it works right up until something reads it
    # expecting the array.
    $pageArgs = @{
        BookSlug = $Action.slug; PagePath = [string](Get-TriageValue $Action.raw 'page_path')
        Title = $Action.title; WorkspacePath = $workspace
    }
    if ($Action.source -ceq 'holding') { $pageArgs.Content = (Get-TriageNoteBody $Action.resolved.files[0].content).body }
    else { $pageArgs.ContentPath = $Action.source_path }
    # -NoEnumerate, because a hashtable returned bare from a function is fine but a hashtable is not
    # what @() around a call site produces, and the splat below needs the hashtable itself.
    Write-Output $pageArgs -NoEnumerate
}

function Get-ChildPreflight($Action) {
    $request = $Action.raw
    # The three inline kinds are performed by this file, so their "child preflight" would be this
    # file checking its own arithmetic. Deliberately not asserted: a self-comparison is not evidence,
    # and the paths they touch are already covered by Assert-WriteSetWritable and
    # Assert-DeleteSetPresent, which read the disk rather than a second copy of the rule.
    if ($Action.kind -cin $script:TriageInlineKinds) {
        return [pscustomobject]@{ plan_id = $null; child = [pscustomobject]@{
            operation = $Action.operation
            note_page = $Action.source_note
            current_review = [string](Get-TriageValue $Action.metadata 'current_review')
            new_review = [string](Get-TriageValue $Action.metadata 'new_review')
            write_set = @($Action.write_set)
            delete_set = @($Action.delete_set)
        } }
    }
    switch ($Action.kind) {
        'holding' {
            # The plan's capture date names the note, so the child plans the name the approval binds (S44).
            $child = & $shelfNote -Title $Action.title -ContentPath $Action.source_path -BookSlug $Action.slug -SourcePaths $Action.source_path -CaptureDate ([string](Get-TriageValue $Action.metadata 'capture_date')) -WorkspacePath $workspace -Preflight
            # note_page is the page identity, without the extension; write_set names the file.
            Assert-ChildWriteSetMatches $Action @("$($child.note_page).md")
            return [pscustomobject]@{ plan_id = $null; child = $child }
        }
        'shelf-book' {
            $pageArgs = Get-ShelfPageArgs $Action
            $child = & $shelfPage @pageArgs -Preflight
            Assert-ChildWriteSetMatches $Action @($child.page)
            return [pscustomobject]@{ plan_id = $null; child = $child }
        }
        'project' {
            $childArgs = @{
                SourcePath = $Action.source_path; ProjectSlug = $Action.slug; Title = $Action.title
                Purpose = [string](Get-TriageValue $request 'purpose')
                WorkspacePath = $workspace; ProjectId = $ProjectId; McpUrl = $McpUrl; Preflight = $true
            }
            $next = @(Get-TriageArray $request 'next_actions'); if ($next.Count) { $childArgs.NextAction = $next }
            $include = @(Get-TriageArray $request 'include_pages'); if ($include.Count) { $childArgs.IncludePage = $include }
            $child = & $projectCopy @childArgs
            Assert-ChildWriteSetMatches $Action @(@($child.planned_project_records) | ForEach-Object { $_.path })
            return [pscustomobject]@{ plan_id = $child.plan_id; child = $child }
        }
        'book' {
            $childArgs = @{
                Destination = 'Shared'; SourcePath = $Action.source_path; BookSlug = $Action.slug
                BookTitle = $Action.title; Summary = [string](Get-TriageValue $request 'summary')
                WorkspacePath = $workspace; ProjectId = $ProjectId; McpUrl = $McpUrl; Preflight = $true
            }
            $include = @(Get-TriageArray $request 'include_pages'); if ($include.Count) { $childArgs.IncludePage = $include }
            $collection = [string](Get-TriageValue $request 'collection'); if (-not [string]::IsNullOrWhiteSpace($collection)) { $childArgs.Collection = $collection }
            $child = & $publisher @childArgs
            Assert-ChildWriteSetMatches $Action @(@($child.planned_shared_records) | ForEach-Object { $_.path })
            return [pscustomobject]@{ plan_id = $child.plan_id; child = $child }
        }
    }
    throw "Unknown triage action kind '$($Action.kind)'."
}

# review, notebook and discard, performed here rather than delegated -- there is no child helper for
# a note's own state. Every one of them rewrites the Book's reader map, so all three take the Book's
# lock: the lock is the Book's, not any one helper's, and a capture landing between the listing and
# the map rewrite would otherwise be dropped from the map while its file stayed on disk.
#
# The mutation window opens immediately before the FIRST write to the Book, so a refusal that happens
# earlier never leaves a marker with nothing behind it. There is no Undo path, and its absence is a
# decision: this helper journals nothing per note and rolls nothing back, so a failure after the
# window opens really does leave the Book in a state no stored manifest describes. Dirty is then the
# truthful answer, not a gap.
function Invoke-NoteAction($Action) {
    $book = Get-CaptureBook -Workspace $workspace -Slug $Action.source_slug
    $note = $Action.resolved.note
    $result = [ordered]@{
        operation = $Action.operation
        book = $book.book_root
        note_page = $Action.source_note
        note_title = $note.title
        current_review = $note.review
        captured = $note.captured
        shared_library_write = $false
    }
    $lock = Enter-BookLock -Workspace $workspace -BookRoot $book.book_root -TimeoutSeconds $LockTimeoutSeconds
    $mutation = $null
    try {
        switch ($Action.kind) {
            'review' {
                $newState = [string](Get-TriageValue $Action.metadata 'new_review')
                $result.new_review = $newState
                # Nothing is written, so nothing may be marked dirty: a marker with no mutation
                # behind it is a Book that reads unavailable with nothing left to repair.
                if ($note.review -ceq $newState) {
                    $result.status = 'unchanged'
                    return [pscustomobject]$result
                }
                $content = [IO.File]::ReadAllText($note.full_path)
                $updated = [regex]::Replace($content, '(?m)^review:\s*.*$', "review: $newState", 1)
                if ($updated -ceq $content) { throw "This note has no review field to update: $($note.page)" }
                $mutation = Enter-BookMutation -Workspace $workspace -Slug $book.slug -BookRoot $book.book_root -Reason "Review $($note.page) as $newState" -Lock $lock
                Write-Utf8 $note.full_path $updated
                $counts = Update-ShelfNoteIndex -Book $book
                $result.status = 'updated'
                $result.pending_count = $counts.pending_count
            }
            'notebook' {
                $topicSlug = [string](Get-TriageValue $Action.metadata 'topic')
                $destinationDirectory = Join-Path $workspace (Join-Path 'notebook' $topicSlug)
                $destination = Join-Path $destinationDirectory $note.file
                $result.destination = @($Action.write_set)[0]
                # THIS ROUTE USED TO CREATE notebook/<topic>/ AND WRITE NO INDEX AT ALL, which is
                # the degenerate state a concurrent render would meet -- a topic directory with
                # nothing to derive a label from. It now creates a topic the same way the compiler
                # does: index and all, staged whole, promoted under the render lock.
                $topicExists = Test-Path -LiteralPath $destinationDirectory -PathType Container
                if ($topicExists -and -not (Test-Path -LiteralPath (Join-Path $destinationDirectory '_index.md') -PathType Leaf)) {
                    throw "notebook/$topicSlug exists with no _index.md. Repair or remove that directory before triaging into it; a topic with no index cannot be rendered into the Notebook master index."
                }
                $result.topic_is_new = -not $topicExists
                # Book, then topic, then render -- the lock order PLAN-multi-desk.md step 9a fixes.
                # The Book's lock is already held by the caller.
                $topicLock = Enter-BookLock -Workspace $workspace -BookRoot (Get-NotebookTopicLockRoot $topicSlug) -TimeoutSeconds $LockTimeoutSeconds
                try {
                    # ENFORCED HERE, UNDER THE TOPIC LOCK, having been reported by the preflight gate
                    # (ADR-0019). Ownership may now change only under this same lock, so the answer
                    # cannot move between this check and the copy below.
                    Assert-NotebookTopicWritable -Workspace $workspace -Topic $topicSlug -Seat $script:TriageSeatName | Out-Null
                    if ($topicExists) {
                        [IO.File]::Copy($note.full_path, $destination, $false)
                        $written = [IO.File]::ReadAllText($destination)
                        if ($written -cne [IO.File]::ReadAllText($note.full_path)) { throw "The note was copied but did not read back identically: $($result.destination)" }
                        # An existing topic whose heading nobody touched changes nothing the master
                        # index derives from, so the render lock is skipped -- unless the index is
                        # already drifted, in which case this run repairs it.
                        $result.master_index_rendered = [bool]@(Get-NotebookMasterIndexDrift -Workspace $workspace).Count
                        if ($result.master_index_rendered) { Invoke-NotebookRender -Workspace $workspace | Out-Null }
                    }
                    else {
                        $stagingRoot = Join-Path $workspace 'internal/notebook-staging'
                        $staging = Join-Path $stagingRoot ([guid]::NewGuid().ToString('n'))
                        New-Item -ItemType Directory -Path $staging -Force | Out-Null
                        try {
                            [IO.File]::Copy($note.full_path, (Join-Path $staging $note.file), $false)
                            if ([IO.File]::ReadAllText((Join-Path $staging $note.file)) -cne [IO.File]::ReadAllText($note.full_path)) { throw "The note was copied but did not read back identically: $($result.destination)" }
                            # The generated index says only what is true: the slug as its heading,
                            # and where the topic came from. Triage is given no topic title, and
                            # inventing one would put words in front of the reader that nobody wrote.
                            Write-AtomicText -Path (Join-Path $staging '_index.md') -Text "# $topicSlug`n`nNotebook topic opened by triage from a capture Book. Add an overview here when the topic takes shape.`n" | Out-Null
                            Invoke-NotebookRender -Workspace $workspace -CommitArgument @($staging, $destinationDirectory, $topicSlug) -Commit {
                                param($From, $To, $Slug)
                                if (Test-Path -LiteralPath $To) { throw "notebook/$Slug appeared while this note was being staged; nothing was promoted." }
                                [IO.Directory]::Move($From, $To)
                            } | Out-Null
                            # EVERY NOTEBOOK WRITER RECORDS OWNERSHIP (step 21), never just the
                            # first one found. Naming only the compiler was caught as a defect twice
                            # in Release 1's review, and THIS route -- Triage to the Notebook -- was
                            # the worse of the two omissions. Recorded after the promotion, because a
                            # record naming a topic that failed to promote is one reset would act on.
                            Set-NotebookTopicOwner -Workspace $workspace -Topic $topicSlug -Seat $script:TriageSeatName
                            $result.master_index_rendered = $true
                        }
                        finally {
                            if (Test-Path -LiteralPath $staging -PathType Container) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
                            if ((Test-Path -LiteralPath $stagingRoot -PathType Container) -and -not @(Get-ChildItem -LiteralPath $stagingRoot -Force -ErrorAction SilentlyContinue).Count) {
                                Remove-Item -LiteralPath $stagingRoot -Force -ErrorAction SilentlyContinue
                            }
                        }
                    }
                }
                finally { Exit-BookLock -Lock $topicLock }
                # The Notebook copy above is not a Book write, so the window opens here: the Shelf
                # note's own frontmatter is the first thing this kind changes inside the Book.
                $content = [IO.File]::ReadAllText($note.full_path)
                $mutation = Enter-BookMutation -Workspace $workspace -Slug $book.slug -BookRoot $book.book_root -Reason "Copy $($note.page) to notebook/$topicSlug" -Lock $lock
                Write-Utf8 $note.full_path ([regex]::Replace($content, '(?m)^review:\s*.*$', 'review: done', 1))
                $counts = Update-ShelfNoteIndex -Book $book
                $result.status = 'copied'
                $result.new_review = 'done'
                $result.pending_count = $counts.pending_count
                $result.next = 'The Notebook copy is volatile. Triage it onward to a Shelf Book, a Project Hub, or a new shared Book to give it a durable home.'
            }
            'discard' {
                $mutation = Enter-BookMutation -Workspace $workspace -Slug $book.slug -BookRoot $book.book_root -Reason "Discard $($note.page)" -Lock $lock
                Remove-Item -LiteralPath $note.full_path -Force
                $counts = Update-ShelfNoteIndex -Book $book
                $result.status = 'discarded'
                $result.recoverable = $false
                $result.pending_count = $counts.pending_count
            }
        }
        # Closed once the kind's writes are done and still under the same lock. It cannot throw, so a
        # manifest refusal is reported rather than turned into a failure of a triage that happened.
        if ($null -ne $mutation) { $result.manifest = (Complete-BookMutation -Mutation $mutation).summary }
    }
    finally { if ($null -ne $lock) { Exit-BookLock -Lock $lock } }
    $result.reader_map = "$($book.book_root)/wiki/_index.md"
    [pscustomobject]$result
}

function Invoke-ChildAction($Action, [string]$ChildPlanId) {
    $request = $Action.raw
    if ($Action.kind -cin $script:TriageInlineKinds) { return Invoke-NoteAction $Action }
    switch ($Action.kind) {
        'holding' {
            # The approved file name is pinned, not chosen again: an approval naming one path must
            # never write another, and a name taken since is a refusal rather than a relocation.
            $noteFile = [IO.Path]::GetFileName(@($Action.write_set)[0])
            return & $shelfNote -Title $Action.title -ContentPath $Action.source_path -BookSlug $Action.slug -SourcePaths $Action.source_path -RequireNoteFile $noteFile -WorkspacePath $workspace
        }
        'shelf-book' {
            $pageArgs = Get-ShelfPageArgs $Action
            return & $shelfPage @pageArgs
        }
        'project' {
            $childArgs = @{
                SourcePath = $Action.source_path; ProjectSlug = $Action.slug; Title = $Action.title
                Purpose = [string](Get-TriageValue $request 'purpose')
                WorkspacePath = $workspace; ProjectId = $ProjectId; McpUrl = $McpUrl
                UserConfirmed = $true; ApprovedPlanId = $ChildPlanId
            }
            $next = @(Get-TriageArray $request 'next_actions'); if ($next.Count) { $childArgs.NextAction = $next }
            $include = @(Get-TriageArray $request 'include_pages'); if ($include.Count) { $childArgs.IncludePage = $include }
            return & $projectCopy @childArgs
        }
        'book' {
            $childArgs = @{
                Destination = 'Shared'; SourcePath = $Action.source_path; BookSlug = $Action.slug
                BookTitle = $Action.title; Summary = [string](Get-TriageValue $request 'summary')
                WorkspacePath = $workspace; ProjectId = $ProjectId; McpUrl = $McpUrl
                UserConfirmed = $true; ApprovedPlanId = $ChildPlanId
            }
            $include = @(Get-TriageArray $request 'include_pages'); if ($include.Count) { $childArgs.IncludePage = $include }
            $collection = [string](Get-TriageValue $request 'collection'); if (-not [string]::IsNullOrWhiteSpace($collection)) { $childArgs.Collection = $collection }
            return & $publisher @childArgs
        }
    }
    throw "Unknown triage action kind '$($Action.kind)'."
}

# --- Batch identity, plan record, and journal -----------------------------------------------------

# Composed from the per-action content-bound digests, not from child plan_id values. Four of the
# seven kinds issue no plan_id at all, so composing them could never have covered a whole batch. It
# also has to be knowable before any child runs, so the journal can be read first: on a resume, an
# action already recorded as succeeded must not be preflighted again, because its write set is now
# occupied by its own success.
$batchId = 'triage-' + (Get-TriageHash ((@("schema=$($script:TriagePlanSchema)") + @($actions | ForEach-Object { "$($_.action_id)|$($_.action_digest)" })) -join "`n"))

# The envelope the plan record stores and the preflight shows. The reader's own words travel with it
# -- title, purpose, summary, page_path -- because the runner needs them to call the child writers,
# and re-deriving them from the envelope would be a second parser of the same record.
$entries0 = @($actions | ForEach-Object {
    [pscustomobject]@{
        action_id           = $_.action_id
        kind                = $_.kind
        source              = $_.source
        source_slug         = $_.source_slug
        source_note         = $_.source_note
        slug                = $_.slug
        destination         = $_.destination
        operation           = $_.operation
        collision_policy    = $_.collision_policy
        required_desk_state = @($_.required_desk_state)
        source_path         = $_.source_path
        source_file_count   = $_.source_file_count
        source_manifest     = @($_.source_manifest)
        delivered_sha256    = $_.delivered_sha256
        write_set           = @($_.write_set)
        touch_set           = @($_.touch_set)
        delete_set          = @($_.delete_set)
        action_digest       = $_.action_digest
        request             = $_.raw
    }
})

$journalsRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'internal/triage-journals')).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$legacyJournalsRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'internal/handoff-journals')).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$useJournal = $batchMode
if ($useJournal) {
    if ([string]::IsNullOrWhiteSpace($JournalPath)) {
        $JournalPath = Join-Path $workspace "internal/triage-journals/$batchId.json"
    }
    # Confined the same way PlanPath is, and to the same two roots. The journal is written with a
    # forced move, so an unconstrained path would let a confirmed run overwrite any file the caller
    # named. A legacy journal is accepted so an interrupted handoff batch is still resumable by an
    # explicit -JournalPath; nothing writes there unless the caller names it.
    $JournalPath = [IO.Path]::GetFullPath($JournalPath)
    if (-not ($JournalPath.StartsWith($journalsRoot, [StringComparison]::OrdinalIgnoreCase) -or
              $JournalPath.StartsWith($legacyJournalsRoot, [StringComparison]::OrdinalIgnoreCase))) {
        throw 'JournalPath must be inside internal/triage-journals/ or internal/handoff-journals/.'
    }
}

$existingJournal = $null
if ($useJournal -and (Test-Path -LiteralPath $JournalPath -PathType Leaf)) {
    $existingJournal = ([IO.File]::ReadAllText($JournalPath, [Text.UTF8Encoding]::new($false, $true))) | ConvertFrom-Json
    # A journal is only evidence about the batch it belongs to. Accepting a `succeeded` record
    # without checking that would let a stale or hand-edited file silently skip real work -- the
    # one failure a resume must never have.
    $journalSchema = Get-TriageValue $existingJournal 'schema'
    if ($null -eq $journalSchema -or [int]$journalSchema -ne 1) { throw "The batch journal at $JournalPath has an unsupported schema; move it aside and rerun the preflight." }
    $journalBatch = [string](Get-TriageValue $existingJournal 'batch_id')
    if ($journalBatch -cne $batchId) { throw "The batch journal at $JournalPath belongs to batch '$journalBatch', not '$batchId'. Give this run its own journal or rebuild the plan." }
}
$journalState = @{}
$digestById = @{}
foreach ($action in $actions) { $digestById[$action.action_id] = $action.action_digest }
if ($null -ne $existingJournal) {
    $seenIds = @{}
    foreach ($record in @(Get-TriageArray $existingJournal 'actions')) {
        $recordId = [string](Get-TriageValue $record 'action_id')
        if ($seenIds.ContainsKey($recordId)) { throw "The batch journal records '$recordId' more than once; move it aside and rerun the preflight." }
        $seenIds[$recordId] = $true
        if (-not $digestById.ContainsKey($recordId)) { throw "The batch journal records '$recordId', which is not in this plan; move it aside and rerun the preflight." }
        $recordDigest = [string](Get-TriageValue $record 'action_digest')
        if ($recordDigest -cne $digestById[$recordId]) { throw "The batch journal's record for '$recordId' was written against different content; rebuild the plan." }
        $journalState[$recordId] = $record
    }
}

function Get-RecordedState([string]$ActionId) {
    if (-not $journalState.ContainsKey($ActionId)) { return 'pending' }
    [string](Get-TriageValue $journalState[$ActionId] 'state')
}
function Get-RecordedAttempts([string]$ActionId) {
    if (-not $journalState.ContainsKey($ActionId)) { return 0 }
    $attempts = Get-TriageValue $journalState[$ActionId] 'attempts'
    if ($null -eq $attempts) { return 0 }
    [int]$attempts
}

# --- Preflight ------------------------------------------------------------------------------------

$entries = [Collections.Generic.List[object]]::new()
foreach ($action in $actions) {
    $recorded = Get-RecordedState $action.action_id
    $childPlanId = $null
    $childPlanDetail = $null
    $gateError = ''
    if ($recorded -cne 'succeeded') {
        # A per-action gate failure means two different things depending on when it is found, and
        # both are in the state machine. Before approval it refuses the whole batch, because there
        # is no reason to spend the reader's one approval on a batch already certain to be partial.
        # After approval it fails that action and the rest continue, because by then the reader's
        # goal is losing nothing and saving what can be saved beats stopping early.
        try {
            Assert-DeskState $action
            Assert-NotebookTopicOwnershipAllows $action
            Assert-WriteSetWritable $action
            # Not $preflight: PowerShell variable names are case-insensitive, so that name is this
            # script's own [switch]$Preflight parameter and assigning an object to it fails the
            # switch's type transform -- reported, unhelpfully, as a binding error on the script.
            $childPlan = Get-ChildPreflight $action
            $childPlanId = $childPlan.plan_id
            $childPlanDetail = $childPlan.child
        }
        catch {
            # A single note has no "rest of the batch" to save, so a gate failure is a refusal
            # whether or not the reader asked for a preflight.
            if ($Preflight -or -not $batchMode) { throw }
            $gateError = $_.Exception.Message
        }
    }
    [void]$entries.Add([pscustomobject]@{
        action_id      = $action.action_id
        kind           = $action.kind
        source         = $action.source
        slug           = $action.slug
        destination    = $action.destination
        operation      = $action.operation
        source_path    = $action.source_path
        write_set      = @($action.write_set)
        touch_set      = @($action.touch_set)
        delete_set     = @($action.delete_set)
        action_digest  = $action.action_digest
        recorded_state = $recorded
        gate_error     = $gateError
        child_plan_id  = $childPlanId
        child_plan     = $childPlanDetail
        action         = $action
    })
}

$resumable = @(@($entries | Where-Object { (Get-RecordedState $_.action_id) -cne 'succeeded' }))
$alreadyDone = @(@($entries | Where-Object { (Get-RecordedState $_.action_id) -ceq 'succeeded' }))

function Get-PreflightReport() {
    [pscustomobject]@{
        operation             = 'Library Triage'
        mode                  = if ($batchMode) { 'batch' } else { 'single-note' }
        plan_path             = if ([string]::IsNullOrWhiteSpace($planFull)) { '(preflight -- the plan record is written when the run is confirmed)' } else { $planFull }
        plan_id               = $batchId
        action_count          = $entries.Count
        execution_order       = @($entries | ForEach-Object { "$($_.kind):$($_.slug)" })
        actions               = @($entries | ForEach-Object {
            [pscustomobject]@{
                action_id     = $_.action_id
                kind          = $_.kind
                source        = $_.source
                slug          = $_.slug
                destination   = $_.destination
                operation     = $_.operation
                source_path   = $_.source_path
                source_manifest = @($_.action.source_manifest)
                source_file_count = $_.action.source_file_count
                delivered_sha256 = $_.action.delivered_sha256
                required_desk_state = @($_.action.required_desk_state)
                write_set     = @($_.write_set)
                touch_set     = @($_.touch_set)
                delete_set    = @($_.delete_set)
                action_digest = $_.action_digest
                child_plan_id = $_.child_plan_id
                recorded_state = $_.recorded_state
                plan          = $_.child_plan
            }
        })
        journal_path          = if ($useJournal) { $JournalPath } else { '(single note -- no batch journal)' }
        resume                = ($null -ne $existingJournal)
        pending_count         = $resumable.Count
        already_succeeded     = $alreadyDone.Count
        confirmation_required = $requiresApproval
        recoverable           = (@(@($entries | Where-Object { @($_.delete_set).Count })).Count -eq 0)
        shared_library_write  = $false
    }
}

if ($Preflight) {
    Write-LibraryResult -Result (Get-PreflightReport) -Json:$Json
    return
}

# STEP 15b: A NOTEBOOK WRITE IS A MUTATION AND NEEDS THIS SEAT'S LIVE CLAIM. The rule's own
# rationale is the reason it belongs here specifically: an agent launched directly, inheriting a
# LIBRARY_SEAT, would carry no claim yet could still change its Notebook -- and reset would then
# classify genuinely active work as dormant and quarantine it. Checked AFTER the preflight, because
# a preflight is a read and reads are unaffected.
#
# ONLY THE NOTEBOOK ROUTE. Triage's other destinations write the Shelf or the shared collection,
# which reset never reads and never quarantines -- gating those on a seat claim would cost the reader
# a launcher for work this rule was not written about.
$notebookActions = @(@($actions) | Where-Object { [string]$_.kind -ceq 'notebook' })
if ($notebookActions.Count) {
    if ($script:TriageSeatState.status -cne 'named') { throw $script:TriageSeatState.message }
    Assert-SeatClaimHeld -StateDirectory (Join-Path $workspace '.claude') -Seat $script:TriageSeatName | Out-Null
}

if ($requiresApproval) {
    if (-not $UserConfirmed) { throw 'Library Triage is not yet performed: review the preflight and rerun with -UserConfirmed.' }
    if ($ApprovedPlanId -cne $batchId) { throw 'Library Triage is not yet performed: rerun the current preflight and pass its exact plan_id as ApprovedPlanId. A different plan_id means the material changed since you approved it.' }
}

# --- Execution ------------------------------------------------------------------------------------

# The plan record is written HERE, at the first confirmed run and only if absent, and it is named by
# the batch id -- so it is the record of exactly what was approved and a retry cannot rewrite it. A
# preflight writes nothing at all.
if ($batchMode) {
    $planRecordPath = Join-Path $workspace "internal/triage-plans/$batchId.json"
    if (-not (Test-Path -LiteralPath $planRecordPath -PathType Leaf)) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $planRecordPath) -Force | Out-Null
        [IO.File]::WriteAllText($planRecordPath, ([pscustomobject]@{
            version      = $script:TriagePlanSchema
            created_utc  = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
            capture_date = $CaptureDate
            batch_id     = $batchId
            actions      = $entries0
        } | ConvertTo-Json -Depth 16), [Text.UTF8Encoding]::new($false))
    }
    if ([string]::IsNullOrWhiteSpace($planFull)) { $planFull = $planRecordPath }
}

$records = [ordered]@{}
foreach ($entry in $entries) {
    $records[$entry.action_id] = [ordered]@{
        action_id     = $entry.action_id
        kind          = $entry.kind
        source        = $entry.source
        slug          = $entry.slug
        destination   = $entry.destination
        action_digest = $entry.action_digest
        write_set     = @($entry.write_set)
        delete_set    = @($entry.delete_set)
        state         = Get-RecordedState $entry.action_id
        attempts      = Get-RecordedAttempts $entry.action_id
        completed_utc = if ($journalState.ContainsKey($entry.action_id)) { [string](Get-TriageValue $journalState[$entry.action_id] 'completed_utc') } else { '' }
        error         = ''
    }
}

# Rewritten in full after every action and moved into place, so a process killed mid-write leaves
# the previous complete journal rather than a truncated one. A journal that cannot be trusted is
# worse than none: resume would skip work that never happened.
function Save-BatchJournal([string]$State) {
    if (-not $useJournal) { return }
    $directory = Split-Path -Parent $JournalPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $payload = [pscustomobject]@{
        schema      = 1
        batch_id    = $batchId
        plan_path   = $planFull
        state       = $State
        created_utc = if ($null -ne $existingJournal) { [string](Get-TriageValue $existingJournal 'created_utc') } else { [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ') }
        updated_utc = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        actions     = @(@($records.Keys | ForEach-Object { [pscustomobject]$records[$_] }))
    }
    # A unique temporary name per write: a fixed "$JournalPath.tmp" is shared state, and two
    # processes writing it at once produce a journal that is neither one's.
    $temporary = "$JournalPath." + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.tmp'
    [IO.File]::WriteAllText($temporary, ($payload | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $JournalPath -Force
}

# One writer per batch, held from here through the final save. The child writers each take their own
# Book lock, but nothing stopped two processes running the same pending action and then overwriting
# each other's journal -- and a journal two processes disagree about is worse than none. A single
# note takes no batch lock: its one child takes the Book's own lock, which is the real contention.
$batchLock = if ($batchMode) { Enter-BookLock -Workspace $workspace -BookRoot "triage/$batchId" -TimeoutSeconds 30 } else { $null }
try {

Save-BatchJournal 'in-progress'

$outcomes = [Collections.Generic.List[object]]::new()

# Every outcome carries the same properties whatever happened to it. A result whose shape depends
# on its own success is one a caller cannot read without knowing the answer first, and under
# Set-StrictMode -- which every helper here runs -- reading an absent property throws.
function New-Outcome($Entry, [string]$State, [bool]$Skipped, $Result, [string]$ErrorText, [string]$Note) {
    [pscustomobject]@{
        action_id   = $Entry.action_id
        kind        = $Entry.kind
        source      = $Entry.source
        slug        = $Entry.slug
        destination = $Entry.destination
        state       = $State
        skipped     = $Skipped
        error       = $ErrorText
        note        = $Note
        result      = $Result
    }
}

foreach ($entry in $entries) {
    $record = $records[$entry.action_id]
    if ($record.state -ceq 'succeeded') {
        [void]$outcomes.Add((New-Outcome $entry 'succeeded' $true $null '' 'Already recorded as succeeded in the batch journal; re-running it would be a no-op.'))
        continue
    }
    # A previous process died between starting this action and recording its outcome, so whether
    # the destination exists is unknown from here. Retrying blindly could duplicate work, and
    # marking it succeeded would be a claim nothing checked. Report it and stop touching it: the
    # reader looks at the write set, and rebuilding the plan gives a fresh batch and journal.
    if ($record.state -ceq 'attempting') {
        $record.state = 'interrupted'
        $record.error = 'A previous run was interrupted after this action began and before its outcome was recorded.'
        [void]$outcomes.Add((New-Outcome $entry 'interrupted' $false $null $record.error "Check whether these paths exist before rerunning: $(@(@($entry.write_set) + @($entry.delete_set)) -join ', '). Rebuild the plan once you have."))
        Save-BatchJournal 'in-progress'
        continue
    }
    $record.attempts = [int]$record.attempts + 1
    # Written BEFORE the child runs. The reverse order leaves a window in which durable output
    # exists and the journal still says pending, and a later resume then refuses that action
    # forever because its own approved path is occupied.
    $record.state = 'attempting'
    Save-BatchJournal 'in-progress'
    try {
        if (-not [string]::IsNullOrWhiteSpace($entry.gate_error)) { throw $entry.gate_error }
        # Revalidated here, not only at preflight: a Book can be closed and a path taken between
        # the approval and this line.
        Assert-DeskState $entry.action
        Assert-WriteSetWritable $entry.action
        Assert-SourceUnchanged $entry.action
        $result = Invoke-ChildAction $entry.action $entry.child_plan_id
        $record.state = 'succeeded'
        $record.completed_utc = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        $record.error = ''
        [void]$outcomes.Add((New-Outcome $entry 'succeeded' $false $result '' ''))
    }
    catch {
        # Continue rather than stop. The reader's goal is losing nothing before a reset, so the
        # remaining independent actions are still worth attempting. A single note has no remainder,
        # so its failure is rethrown rather than dressed as an incomplete batch of one.
        if (-not $batchMode) { throw }
        $record.state = 'failed'
        $record.error = $_.Exception.Message
        [void]$outcomes.Add((New-Outcome $entry 'failed' $false $null $_.Exception.Message ''))
    }
    Save-BatchJournal 'in-progress'
}

$succeeded = @(@($outcomes | Where-Object { $_.state -ceq 'succeeded' }))
$failed = @(@($outcomes | Where-Object { $_.state -cne 'succeeded' }))
$interrupted = @(@($outcomes | Where-Object { $_.state -ceq 'interrupted' }))
$status = if ($failed.Count -eq 0) { 'complete' } else { 'incomplete' }
Save-BatchJournal $status

$succeededKinds = @(@($succeeded | ForEach-Object { $_.kind }) | Sort-Object -Unique)

# Derived from the destinations that actually succeeded. One flag for "something was written" would
# claim a NAS write when only a Holding Shelf entry landed. `notebook` is the kind that is true in
# TWO of these at once: it copies a note into notebook/ AND marks the Shelf original reviewed.
$shelfKinds = @('holding', 'shelf-book', 'review', 'discard', 'notebook')
$sharedKinds = @('project', 'book')

Write-LibraryResult -Result ([pscustomobject]@{
    operation               = 'Library Triage'
    mode                    = if ($batchMode) { 'batch' } else { 'single-note' }
    plan_id                 = $batchId
    plan_path               = $planFull
    status                  = $status
    all_succeeded           = ($failed.Count -eq 0)
    action_count            = $outcomes.Count
    succeeded_count         = $succeeded.Count
    failed_count            = $failed.Count
    interrupted_count       = $interrupted.Count
    outcomes                = @($outcomes)
    journal_path            = if ($useJournal) { $JournalPath } else { '(single note -- no batch journal)' }
    shelf_write             = @(@($succeededKinds | Where-Object { $_ -cin $shelfKinds })).Count -gt 0
    shared_collection_write = @(@($succeededKinds | Where-Object { $_ -cin $sharedKinds })).Count -gt 0
    notebook_write          = @(@($succeededKinds | Where-Object { $_ -ceq 'notebook' })).Count -gt 0
    shared_library_write    = @(@($succeededKinds | Where-Object { $_ -cin $sharedKinds })).Count -gt 0
    next                    = if ($failed.Count -eq 0) { 'Every action succeeded. Nothing was removed that the plan did not name.' }
                              elseif ($interrupted.Count) { "This triage is incomplete: $($failed.Count) of $($outcomes.Count) actions did not succeed, and $($interrupted.Count) was interrupted by an earlier run. Check the write set of each interrupted action by hand, then rebuild the plan." }
                              else { "This triage is incomplete: $($failed.Count) of $($outcomes.Count) actions failed. Fix the cause and rerun the same plan -- succeeded actions are skipped." }
}) -Json:$Json

}
finally { if ($null -ne $batchLock) { Exit-BookLock -Lock $batchLock } }
