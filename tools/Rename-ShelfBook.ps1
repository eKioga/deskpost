<#
.SYNOPSIS
    Rename a Shelf Book: its slug, its directory, its title, and every live reference, as one
    preflighted and rollback-protected operation.

.DESCRIPTION
    Item 1.1 of the plan. A rename is a destructive Shelf writer -- it moves a directory that holds
    the reader's only copy of unvetted material -- so it takes the same shape as every other
    consequential operation: a read-only preflight, an exact plan_id, and one approval.

    What this helper owns is the durable state that cannot be recovered from version control: the
    Book directory, its catalog entry, the Book's own title pages, and the runtime Desk state. Source
    references (helper defaults, tests, the library-help Skill, docs) are tracked text and are
    migrated with the same commit; the preflight reports them so the set is visible rather than
    remembered, and Invoke-LibraryChecks' shelf.references-resolve check keeps them honest afterwards.

    The lock is the Book's, not this helper's -- both the old and the new Book root are held, because
    a rename is the one operation whose identity changes underneath a concurrent writer. Prior state
    is journaled before the first mutation, and a failure at any stage moves the directory back and
    restores every journaled file, verified by readback.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Slug,
    [Parameter(Mandatory = $true)][string]$NewSlug,
    [string]$NewTitle,
    [string]$WorkspacePath,
    [string]$ApprovedPlanId,
    [switch]$UserConfirmed,
    [switch]$Preflight,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'BookManifestTransaction.ps1')
. (Join-Path $PSScriptRoot 'ShelfCatalog.ps1')

function Get-TextDigest([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

# The same section shape Get-CaptureBook matches, so both helpers always agree about which entry
# belongs to a slug. Returns the Match, or $null when no entry names this Book.
function Get-ShelfCatalogEntry([string]$CatalogText, [string]$BookSlug) {
    $sections = @([regex]::Matches($CatalogText, '(?ms)^##\s+(.+?)\s*\r?\n(.*?)(?=^##\s+|\z)'))
    $pathPattern = '(?m)^\s*-\s+\*\*Path:\*\*\s+shelf/' + [regex]::Escape($BookSlug) + '\s*$'
    $matched = @($sections | Where-Object { [regex]::IsMatch($_.Groups[2].Value, $pathPattern) })
    if ($matched.Count -eq 0) { return $null }
    if ($matched.Count -ne 1) { throw "shelf/_catalog.md lists 'shelf/$BookSlug' more than once; repair the catalog before renaming." }
    $matched[0]
}

function Test-IsCaptureBook([string]$SectionBody) {
    [regex]::IsMatch($SectionBody, '(?m)^\s*-\s+\*\*Kind:\*\*\s+capture\s*$')
}

# Every page under wiki/, with its hash. This is what proves the reader's material crossed the
# rename unaltered: the two title pages are rewritten on purpose, everything else must be identical.
function Get-BookPageManifest([string]$WikiPath) {
    $files = @(Get-ChildItem -LiteralPath $WikiPath -File -Recurse | Sort-Object FullName)
    @($files | ForEach-Object {
        [pscustomobject]@{
            relative = $_.FullName.Substring($WikiPath.Length).TrimStart('\', '/').Replace('\', '/')
            sha256   = Get-FileSha256 -Path $_.FullName
        }
    })
}

# Replacement text is data, not a pattern: a title containing $1 must not become a backreference.
function ConvertTo-LiteralReplacement([string]$Text) { $Text.Replace('$', '$$') }

# Tracked text that names a Shelf Book by path. Reported, never rewritten -- a doc recording a dated
# event under the old name is a true record, and this helper is not the judge of which is which.
function Get-SourceReferences([string]$Workspace, [string]$BookSlug, [string]$Title) {
    $roots = @(
        (Join-Path $Workspace 'tools'),
        (Join-Path $Workspace 'docs'),
        (Join-Path $Workspace '.claude/skills'),
        (Join-Path $Workspace '.claude/hooks'),
        (Join-Path $Workspace '.claude/adapters')
    )
    $files = @($roots |
        Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -File -Recurse -Include '*.ps1', '*.md' })
    $files += @(@('CLAUDE.md', 'CONTEXT.md', 'PLAN.md') |
        ForEach-Object { Join-Path $Workspace $_ } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        ForEach-Object { Get-Item -LiteralPath $_ })

    $needles = @("shelf/$BookSlug")
    if (-not [string]::IsNullOrWhiteSpace($Title)) { $needles += $Title }
    $hits = @()
    foreach ($file in $files) {
        $text = [IO.File]::ReadAllText($file.FullName)
        foreach ($needle in $needles) {
            # Ordinal, so 'shelf/inbox-archive' never counts as a hit on 'shelf/inbox'.
            if (-not $text.Contains($needle)) { continue }
            $count = ([regex]::Matches($text, [regex]::Escape($needle))).Count
            $hits += [pscustomobject]@{
                path  = $file.FullName.Substring($Workspace.Length).TrimStart('\', '/').Replace('\', '/')
                names = $needle
                count = $count
            }
        }
    }
    @($hits | Sort-Object path, names)
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

# -cnotmatch, not -notmatch: PowerShell's -notmatch is case-insensitive, so 'Holding' would satisfy
# this lowercase-only rule and be written into Desk state and the catalog with casing no other part
# of the Library matches. Same family recorded in docs/capture-book-model.md.
foreach ($candidate in @(@{ value = $Slug; label = 'Slug' }, @{ value = $NewSlug; label = 'NewSlug' })) {
    if ($candidate.value -cnotmatch '^[a-z0-9][a-z0-9-]*$') { throw "$($candidate.label) must contain only lowercase letters, digits, and hyphens." }
}

$catalogPath = Join-Path $workspace 'shelf/_catalog.md'
if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw 'This workspace has no local Shelf catalog.' }
$catalogText = [IO.File]::ReadAllText($catalogPath)

$entry = Get-ShelfCatalogEntry -CatalogText $catalogText -BookSlug $Slug
if ($null -eq $entry) { throw "No Shelf Book '$Slug' is listed in shelf/_catalog.md." }
$currentTitle = $entry.Groups[1].Value.Trim()
$isCapture = Test-IsCaptureBook -SectionBody $entry.Groups[2].Value
if ([string]::IsNullOrWhiteSpace($NewTitle)) { $NewTitle = $currentTitle }
$NewTitle = $NewTitle.Trim()
if ($NewTitle.Contains("`n") -or $NewTitle.Contains("`r")) { throw 'NewTitle must be a single line.' }
if ($NewSlug -ceq $Slug -and $NewTitle -ceq $currentTitle) { throw 'NewSlug and NewTitle both match the current Book; there is nothing to rename.' }

$oldRoot = Join-Path (Join-Path $workspace 'shelf') $Slug
$newRoot = Join-Path (Join-Path $workspace 'shelf') $NewSlug
$oldWiki = Join-Path $oldRoot 'wiki'
if (-not (Test-Path -LiteralPath $oldWiki -PathType Container)) { throw "Shelf Book '$Slug' has no pages directory at shelf/$Slug/wiki." }

# Collision is checked before a plan_id is issued, not after. Issuing an approval for an operation
# already certain to fail is the defect Phase 0 fixed in Import-ExternalWikiToShelf.
if ($NewSlug -cne $Slug) {
    if (Test-Path -LiteralPath $newRoot) { throw "shelf/$NewSlug already exists. Choose a slug that is free, or move that Book out of the way first." }
    if ($null -ne (Get-ShelfCatalogEntry -CatalogText $catalogText -BookSlug $NewSlug)) { throw "shelf/_catalog.md already lists a Book at shelf/$NewSlug." }
}

# EVERY SEAT THAT HOLDS THIS BOOK, not just this one (step 27). A seat missed here keeps a
# `shelf/<old-slug>` entry pointing at a Book that no longer exists -- and worse, at a slug a future
# Book could occupy, which would hand that seat read access to a Book nobody opened there. That is
# why this is a list of seats rather than a boolean about the current one.
#
# UNDER THE REGISTRY LOCK, even here in the preview. The scan is only true while the set of seats
# and their Desks cannot change, and Get-SeatsHoldingEntry now refuses to answer without it. The
# preview's lock is taken and released immediately; the apply path below takes it again and rescans,
# because a preview the reader read is a snapshot by definition.
$deskStateDirectory = Join-Path $workspace '.claude'
$previewRegistryLock = Enter-SeatRegistryLock -Workspace $workspace
try {
    $previewSeatsHoldingBook = @(Get-SeatsHoldingEntry -Workspace $workspace -StateDirectory $deskStateDirectory -Kind 'books' -Entry "shelf/$Slug")
}
finally { Exit-BookLock -Lock $previewRegistryLock }
$seatsHoldingBook = @($previewSeatsHoldingBook)
$deskHasBook = $seatsHoldingBook.Count -gt 0

$manifest = @(Get-BookPageManifest -WikiPath $oldWiki)
$titlePages = @('_book.md', '_index.md')
$contentPages = @($manifest | Where-Object { $_.relative -cnotin $titlePages })

$bookPagePath = Join-Path $oldWiki '_book.md'
$bookPageAction = 'absent'
$bookPageHeading = ''
if (Test-Path -LiteralPath $bookPagePath -PathType Leaf) {
    $bookPageText = [IO.File]::ReadAllText($bookPagePath)
    $headingMatch = [regex]::Match($bookPageText, '(?m)\A#[ \t]+(.+?)[ \t]*(?:\r?\n|\z)')
    if ($headingMatch.Success) {
        $bookPageHeading = $headingMatch.Groups[1].Value.Trim()
        $bookPageAction = if ($bookPageHeading -ceq $currentTitle) { 'rewrite the H1 to the new title' } else { 'leave unchanged (its H1 does not match the catalog title)' }
    }
    else { $bookPageAction = 'leave unchanged (no H1)' }
}

# The Path line is rewritten in place, so its exact shape has to be checkable before an approval is
# issued rather than discovered after the directory has already moved. [ \t\r] and not [ \t]: under
# (?m) the anchor sits before the \n, so a CRLF file leaves the \r inside the line and a [ \t]-only
# tail silently matches nothing. The looser \s in the lookup pattern hid that difference.
$section = $catalogText.Substring($entry.Index, $entry.Length)
$catalogPathPattern = '(?m)^([ \t]*-[ \t]+\*\*Path:\*\*[ \t]+)shelf/' + [regex]::Escape($Slug) + '([ \t\r]*)$'
if ($NewSlug -cne $Slug -and -not [regex]::IsMatch($section, $catalogPathPattern)) {
    throw "The catalog entry for shelf/$Slug has no Path line this helper can rewrite. Repair shelf/_catalog.md before renaming."
}

$references = @(Get-SourceReferences -Workspace $workspace -BookSlug $Slug -Title $currentTitle)

$digestSource = @(
    "slug=$Slug", "new_slug=$NewSlug", "old_title=$currentTitle", "new_title=$NewTitle",
    "catalog=$(Get-TextDigest $catalogText)", "desk_open=$deskHasBook"
) + @($manifest | ForEach-Object { "page=$($_.relative):$($_.sha256)" })
$planId = 'rename-shelf-book-' + (Get-TextDigest ($digestSource -join "`n"))

$plan = [ordered]@{
    operation             = 'Rename a Shelf Book'
    book                  = "shelf/$Slug"
    new_book              = "shelf/$NewSlug"
    current_title         = $currentTitle
    new_title             = $NewTitle
    kind                  = if ($isCapture) { 'capture' } else { 'curated' }
    page_count            = $manifest.Count
    verified_pages        = $contentPages.Count
    book_page_h1          = $bookPageHeading
    book_page_action      = $bookPageAction
    reader_map_action     = if ($isCapture) { 'regenerate from the notes on disk' } else { 'rewrite the H1 to the new title' }
    desk_state_action     = if ($deskHasBook) { "rewrite shelf/$Slug to shelf/$NewSlug on $($seatsHoldingBook.Count) seat(s): $($seatsHoldingBook -join ', ')" } else { 'no change (the Book is not open at any seat)' }
    source_references     = $references
    plan_id               = $planId
    confirmation_required = $true
    recoverable           = $true
    shared_library_write  = $false
    scope                 = 'Moves this Book''s directory, rewrites its catalog entry, its title pages, and the Desk state if it is open. Every other page is verified byte-identical afterwards. Its Discovery manifest is regenerated under the new slug and the old slug''s manifest store is retired. Source references listed above are tracked text and are migrated with the same commit; this helper does not edit them.'
}
if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json; return }

if (-not $UserConfirmed) { throw 'The Book was not renamed: review the preflight and rerun with -UserConfirmed.' }
if ($ApprovedPlanId -cne $planId) { throw 'The Book was not renamed: rerun the current preflight and pass its exact plan_id as ApprovedPlanId. A different plan_id means the Book, its catalog entry, or the Desk changed since you approved it.' }

# Both roots, in a fixed order, so two renames crossing each other cannot deadlock. The new root is
# held as well because a rename is the one operation whose Book identity changes: a writer creating
# shelf/<NewSlug> mid-move would otherwise be silently absorbed.
$lockRoots = @(@("shelf/$Slug", "shelf/$NewSlug") | Select-Object -Unique | Sort-Object)
$locks = @()
$registryLock = $null
$journalPath = $null
$mutation = $null
$moved = $false
# SET AFTER THE RENDER RETURNS, NEVER BEFORE IT IS CALLED. The flag means "this operation changed
# the catalog", and a render that THREW did not: it writes atomically and verifies by readback, so a
# failure leaves the previous catalog exactly where it was. Setting it beforehand looked more
# cautious and was wrong -- Test-LibraryHelpers injects a read-only shelf/_catalog.md, so the render
# fails and there is nothing to re-derive, and the rollback reported FAILED over a catalog it had
# never touched. A rollback that says it failed when it did not is the same defect as one that says
# it succeeded when it did not.
$catalogRendered = $false
try {
    # THE REGISTRY LOCK FIRST, and it is the whole point of this pass. Set-VirtualDesk holds only
    # this lock, so the Book locks below exclude nothing a seat opening the Book would do. Without it
    # a seat that opened shelf/<slug> after the preview's scan was neither rewritten nor detected --
    # and the straggler check below could not save us, because it sat inside `if ($deskHasBook)` and
    # a snapshot taken when nothing held the Book skipped it entirely.
    $registryLock = Enter-SeatRegistryLock -Workspace $workspace
    foreach ($root in $lockRoots) { $locks += Enter-BookLock -Workspace $workspace -BookRoot $root }

    # Rescanned under the lock, and compared to what the reader approved. `desk_open` in the plan
    # digest binds only whether ANY seat held it; the set is what this operation acts on, so the set
    # is what is revalidated.
    $seatsHoldingBook = @(Get-SeatsHoldingEntry -Workspace $workspace -StateDirectory $deskStateDirectory -Kind 'books' -Entry "shelf/$Slug")
    if ((@($seatsHoldingBook) -join ',') -cne (@($previewSeatsHoldingBook) -join ',')) {
        throw ("the seats holding shelf/$Slug changed after approval (was: " +
               "$(if (@($previewSeatsHoldingBook).Count) { @($previewSeatsHoldingBook) -join ', ' } else { 'none' }); " +
               "now: $(if (@($seatsHoldingBook).Count) { @($seatsHoldingBook) -join ', ' } else { 'none' })). Rerun the preflight")
    }
    $deskHasBook = @($seatsHoldingBook).Count -gt 0

    # 2.2 rung 4. The window opens on the Book's CURRENT identity, before the directory moves --
    # that identity is the one the stored manifest describes, and it is the one that stops being
    # true the moment the move happens.
    $oldLock = @($locks | Where-Object { $_.book_root -ceq "shelf/$Slug" })[0]
    $mutation = Enter-BookMutation -Workspace $workspace -Slug $Slug -BookRoot "shelf/$Slug" -Reason "Rename shelf/$Slug to shelf/$NewSlug" -Lock $oldLock

    # Prior state, at the paths it currently occupies. Rollback moves the directory back first, so
    # these paths are the ones a restore must write to.
    # The entry file is journaled at the path it currently occupies. On a slug change the rollback
    # moves the directory back first, which carries the rewritten entry to this same path, and the
    # journal then restores its prior bytes. On a title-only rename it is the only record of what
    # the entry said before.
    # Every Desk this will rewrite is journaled, so a rollback restores all of them rather than the
    # one that happened to belong to the running session.
    # shelf/_catalog.md IS NOT AMONG THEM, and used to be. It is rendered from the entry files, so a
    # journaled snapshot of it is a snapshot of every OTHER Book too -- restoring one would drop a
    # Book another seat published while this rename was running. The entry file below is the half
    # this operation actually owns; the catalog is re-derived in the rollback.
    $seatDeskPaths = @($seatsHoldingBook | ForEach-Object { Get-DeskFilePath -StateDirectory $deskStateDirectory -Seat $_ -Kind 'books' })
    $journalTargets = $seatDeskPaths + @((Join-Path $oldWiki '_book.md'), (Join-Path $oldWiki '_index.md'),
        (Get-ShelfCatalogEntryPath -Workspace $workspace -Slug $Slug))
    $journal = Write-BookJournal -Workspace $workspace -BookRoot "shelf/$Slug" -Operation "Rename shelf/$Slug to shelf/$NewSlug" -Paths $journalTargets -OperationDigest $planId
    $journalPath = $journal.journal_path

    if ($NewSlug -cne $Slug) {
        Move-Item -LiteralPath $oldRoot -Destination $newRoot
        $moved = $true
    }
    $liveRoot = if ($NewSlug -cne $Slug) { $newRoot } else { $oldRoot }
    $liveWiki = Join-Path $liveRoot 'wiki'

    # --- catalog: this Book's own entry file, then the render --------------------------------------
    # The rewrite is still confined to this Book's section, and it is now confined to this Book's
    # FILE: no offset into a shared document, so a catalog that moved on since the plan was made
    # cannot be mangled by an index computed against the old one. The entry travelled with the
    # directory on a slug change, so the path below is the one under the new slug either way.
    $updatedSection = [regex]::Replace($section, '(?m)\A##[ \t]+.+?[ \t]*(\r?\n|\z)', '## ' + (ConvertTo-LiteralReplacement $NewTitle) + '$1')
    if ($NewSlug -cne $Slug) {
        $updatedSection = [regex]::Replace($updatedSection, $catalogPathPattern, '${1}shelf/' + (ConvertTo-LiteralReplacement $NewSlug) + '$2')
    }
    Invoke-ShelfCatalogRender -Workspace $workspace -WriteEntry @(
        @{ path = (Get-ShelfCatalogEntryPath -Workspace $workspace -Slug $NewSlug); text = $updatedSection }
    ) | Out-Null
    $catalogRendered = $true

    # --- the Book's own title pages ----------------------------------------------------------------
    $liveBookPage = Join-Path $liveWiki '_book.md'
    if ((Test-Path -LiteralPath $liveBookPage -PathType Leaf) -and $bookPageAction -ceq 'rewrite the H1 to the new title') {
        $text = [IO.File]::ReadAllText($liveBookPage)
        Write-Utf8 $liveBookPage ([regex]::Replace($text, '(?m)\A#[ \t]+.+?[ \t]*(\r?\n|\z)', '# ' + (ConvertTo-LiteralReplacement $NewTitle) + '$1'))
    }

    if ($isCapture) {
        # The catalog is the authority for a capture Book's title, so regenerating the map from disk
        # picks up the new one and re-proves the map against the notes in the same step.
        $renamedBook = Get-CaptureBook -Workspace $workspace -Slug $NewSlug
        Update-ShelfNoteIndex -Book $renamedBook | Out-Null
    }
    else {
        $liveMap = Join-Path $liveWiki '_index.md'
        if (Test-Path -LiteralPath $liveMap -PathType Leaf) {
            $text = [IO.File]::ReadAllText($liveMap)
            $mapHeading = [regex]::Match($text, '(?m)\A#[ \t]+(.+?)[ \t]*(?:\r?\n|\z)')
            if ($mapHeading.Success -and $mapHeading.Groups[1].Value.Trim().StartsWith($currentTitle, [StringComparison]::Ordinal)) {
                $rewritten = $NewTitle + $mapHeading.Groups[1].Value.Trim().Substring($currentTitle.Length)
                Write-Utf8 $liveMap ([regex]::Replace($text, '(?m)\A#[ \t]+.+?[ \t]*(\r?\n|\z)', '# ' + (ConvertTo-LiteralReplacement $rewritten) + '$1'))
            }
        }
    }

    # --- runtime Desk state -------------------------------------------------------------------------
    if ($deskHasBook -and $NewSlug -cne $Slug) {
        $rewrittenSeats = @(Update-DeskEntryAcrossSeats -Workspace $workspace -StateDirectory $deskStateDirectory -Kind 'books' -From "shelf/$Slug" -To "shelf/$NewSlug")
    }

    # --- verify, rather than assume -----------------------------------------------------------------
    $problems = [Collections.Generic.List[string]]::new()
    if ($NewSlug -cne $Slug -and (Test-Path -LiteralPath $oldRoot)) { [void]$problems.Add("shelf/$Slug still exists after the move") }
    if (-not (Test-Path -LiteralPath $liveWiki -PathType Container)) { [void]$problems.Add("shelf/$NewSlug/wiki is missing after the move") }

    $afterManifest = @(Get-BookPageManifest -WikiPath $liveWiki)
    $afterByPath = @{}
    foreach ($page in $afterManifest) { $afterByPath[$page.relative] = $page.sha256 }
    foreach ($page in $contentPages) {
        if (-not $afterByPath.ContainsKey($page.relative)) { [void]$problems.Add("$($page.relative) is missing after the move") }
        elseif ($afterByPath[$page.relative] -cne $page.sha256) { [void]$problems.Add("$($page.relative) is not byte-identical after the move") }
    }

    $afterCatalog = [IO.File]::ReadAllText($catalogPath)
    $afterEntry = Get-ShelfCatalogEntry -CatalogText $afterCatalog -BookSlug $NewSlug
    if ($null -eq $afterEntry) { [void]$problems.Add("shelf/_catalog.md no longer lists a Book at shelf/$NewSlug") }
    elseif ($afterEntry.Groups[1].Value.Trim() -cne $NewTitle) { [void]$problems.Add('the catalog heading was not rewritten to the new title') }
    if ($NewSlug -cne $Slug -and $null -ne (Get-ShelfCatalogEntry -CatalogText $afterCatalog -BookSlug $Slug)) { [void]$problems.Add("shelf/_catalog.md still lists shelf/$Slug") }

    if ($NewSlug -cne $Slug) {
        # Verified at EVERY seat that held it, and verified again across the whole registry: the
        # failure this guards is a seat left behind, so a check that only looked at the seats it
        # already rewrote could not see it.
        foreach ($seat in $seatsHoldingBook) {
            $afterDesk = @(Get-DeskFileEntries -Path (Get-DeskFilePath -StateDirectory $deskStateDirectory -Seat $seat -Kind 'books'))
            if ("shelf/$NewSlug" -cnotin $afterDesk) { [void]$problems.Add("seat '$seat' no longer has this Book open under its new root") }
            if ("shelf/$Slug" -cin $afterDesk) { [void]$problems.Add("seat '$seat' still names the old Book root") }
        }
        # OUTSIDE the $deskHasBook branch since 2026-09-09, and that is the fix. It used to sit
        # inside it, so a rename whose snapshot found no holder skipped the straggler check
        # altogether -- exactly the case where a seat opening the Book after the snapshot would be
        # left behind. The registry lock now makes that race impossible; running the sweep anyway is
        # what would notice if the lock ever stopped being taken.
        $stragglers = @(Get-SeatsHoldingEntry -Workspace $workspace -StateDirectory $deskStateDirectory -Kind 'books' -Entry "shelf/$Slug")
        if ($stragglers.Count) { [void]$problems.Add("these seats still name the old Book root: $($stragglers -join ', ')") }
    }

    if ($problems.Count) { throw ($problems -join '; ') }

    # Only now, with the move verified. A slug change moves the Book's identity, so the old slug's
    # store is retired rather than carried across -- that orphan is the limit rung 2 recorded and
    # this is where it is closed. A title-only rename keeps the identity and simply commits the next
    # generation. Neither can throw: the rename has landed and must not be undone over metadata.
    $plan.manifest = if ($NewSlug -cne $Slug) {
        $newLock = @($locks | Where-Object { $_.book_root -ceq "shelf/$NewSlug" })[0]
        (Complete-BookRenameMutation -Mutation $mutation -NewSlug $NewSlug -NewBookRoot "shelf/$NewSlug" -NewLock $newLock).summary
    }
    else {
        (Complete-BookMutation -Mutation $mutation).summary
    }
    $mutation = $null

    $plan.status = 'renamed'
    $plan.book_path = "shelf/$NewSlug/wiki"
    $plan.reader_map = "shelf/$NewSlug/wiki/_index.md"
    $plan.pages_verified_identical = $contentPages.Count
    $plan.journal = $journalPath.Substring($workspace.Length).TrimStart('\', '/').Replace('\', '/')
    $plan.next = 'Migrate the source references listed above in the same commit, then run tools/Invoke-LibraryChecks.ps1.'
}
catch {
    $failure = $_.Exception.Message
    $rollback = 'not required'
    try {
        if ($moved -and (Test-Path -LiteralPath $newRoot) -and -not (Test-Path -LiteralPath $oldRoot)) {
            Move-Item -LiteralPath $newRoot -Destination $oldRoot
        }
        if ($journalPath) { Restore-BookJournal -JournalPath $journalPath | Out-Null }
        # LAST: the Book is back under its old slug and its entry file holds its prior bytes, so the
        # catalog is re-derived from the entries rather than restored from a snapshot of itself.
        if ($catalogRendered) { Invoke-ShelfCatalogRenderAfterRollback -Workspace $workspace | Out-Null }
        $rollback = 'complete and verified'
    }
    catch {
        $rollback = "FAILED: $($_.Exception.Message)"
    }
    # The Book is back under its original slug, which is the identity the committed manifest already
    # describes. A rollback that FAILED leaves the marker down instead: the Book's state is unknown
    # and refusing to describe it is the only honest answer.
    if ($null -ne $mutation -and -not $rollback.StartsWith('FAILED')) { Undo-BookMutation -Mutation $mutation | Out-Null }
    throw "The Book was not renamed. $failure. Rollback: $rollback. Journal: $journalPath"
}
finally {
    foreach ($lock in $locks) { Exit-BookLock -Lock $lock }
    # Released last, in reverse acquisition order.
    if ($null -ne $registryLock) { Exit-BookLock -Lock $registryLock }
}

Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
