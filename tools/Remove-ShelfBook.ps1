<#
.SYNOPSIS
    Permanently delete one curated Shelf Book after an exact, content-bound approval.

.DESCRIPTION
    This is the local Shelf's destructive exit. It is deliberately separate from the compatibility
    archive helper: no local archive copy is created. The preflight binds every file in the Book,
    the Shelf Catalog, and whether the Book is open on the Desk. A confirmed run closes the Book if
    necessary, moves it to private staging, removes its Catalog entry, verifies both changes, and
    only then permanently deletes the staged directory.

    Until the final Remove-Item succeeds, a failure moves the Book back, restores the Catalog from
    its journal, and restores its prior Desk state. A partial filesystem deletion may be impossible
    to roll back completely; that failure is reported rather than hidden.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BookSlug,
    [string]$Reason,
    [string]$WorkspacePath,
    # Which seat is deleting. Defaults to LIBRARY_SEAT. Every OTHER seat holding the Book is a
    # refusal; this one's Desk entry is removed under the registry lock.
    [string]$Seat,
    # The launcher exports this; a test holding a claim passes its token explicitly. Only consulted
    # on the path that writes a Desk.
    [string]$ClaimToken,
    [int]$LockTimeoutSeconds = 20,
    [switch]$Preflight,
    [string]$ApprovedPlanId,
    [switch]$UserConfirmed,
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

function Write-Utf8([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Get-TextDigest([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
}

function Get-ShelfCatalogEntry([string]$CatalogText, [string]$Slug) {
    $sections = @([regex]::Matches($CatalogText, '(?ms)^##\s+(.+?)\s*\r?\n(.*?)(?=^##\s+|\z)'))
    $pathPattern = '(?m)^\s*-\s+\*\*Path:\*\*\s+shelf/' + [regex]::Escape($Slug) + '\s*$'
    $matched = @($sections | Where-Object { [regex]::IsMatch($_.Groups[2].Value, $pathPattern) })
    if ($matched.Count -eq 0) { return $null }
    if ($matched.Count -ne 1) { throw "shelf/_catalog.md lists 'shelf/$Slug' more than once; repair the Catalog before deleting." }
    $matched[0]
}

function Get-BookFileManifest([string]$BookRoot) {
    $reparsePoints = @(Get-ChildItem -LiteralPath $BookRoot -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
    if ($reparsePoints.Count) { throw "Shelf Book staging refuses reparse points: $($reparsePoints[0].FullName)" }
    @(
        Get-ChildItem -LiteralPath $BookRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
            [pscustomobject]@{
                relative = $_.FullName.Substring($BookRoot.Length).TrimStart('\', '/').Replace('\', '/')
                sha256   = Get-FileSha256 -Path $_.FullName
            }
        }
    )
}

function Get-DeskOpenRoots([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
    @([IO.File]::ReadAllLines($Path) | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
}

function Test-IsWithin([string]$Child, [string]$Parent) {
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    [IO.Path]::GetFullPath($Child).StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)
}

function Get-SourceReferences([string]$Workspace, [string]$Slug) {
    $pattern = 'shelf/' + [regex]::Escape($Slug) + '(?![a-z0-9-])'
    $gateFiles = [Collections.Generic.List[string]]::new()
    $skills = Join-Path $Workspace '.claude/skills'
    if (Test-Path -LiteralPath $skills -PathType Container) {
        foreach ($file in @(Get-ChildItem -LiteralPath $skills -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Extension -ceq '.md' })) {
            [void]$gateFiles.Add($file.FullName)
        }
    }
    foreach ($name in @('CLAUDE.md', 'CONTEXT.md')) {
        $candidate = Join-Path $Workspace $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { [void]$gateFiles.Add($candidate) }
    }

    $blocking = [Collections.Generic.List[string]]::new()
    $other = [Collections.Generic.List[string]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @('docs', 'internal', 'output', '.claude')) {
        $root = Join-Path $Workspace $name
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        foreach ($file in @(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue)) {
            if ($file.Extension -cnotin @('.md', '.json', '.ps1')) { continue }
            if (-not $seen.Add($file.FullName)) { continue }
            try { $text = [IO.File]::ReadAllText($file.FullName) } catch { continue }
            if (-not [regex]::IsMatch($text, $pattern)) { continue }
            $relative = $file.FullName.Substring($Workspace.Length).TrimStart('\', '/').Replace('\', '/')
            if ($gateFiles.Contains($file.FullName)) { [void]$blocking.Add($relative) }
            else { [void]$other.Add($relative) }
        }
    }
    foreach ($path in $gateFiles) {
        if ($seen.Contains($path)) { continue }
        try { $text = [IO.File]::ReadAllText($path) } catch { continue }
        if ([regex]::IsMatch($text, $pattern)) {
            [void]$blocking.Add($path.Substring($Workspace.Length).TrimStart('\', '/').Replace('\', '/'))
        }
    }
    [pscustomobject]@{
        blocking = @(@($blocking) | Sort-Object -Unique)
        other    = @(@($other) | Sort-Object -Unique)
    }
}

function Get-DeletePlan([string]$Workspace, [string]$Slug, [string]$DeleteReason, [string]$ActingSeat) {
    $activeRoot = Join-Path $Workspace (Join-Path 'shelf' $Slug)
    $catalogPath = Join-Path $Workspace 'shelf/_catalog.md'
    # EVERY SEAT: a deletion that proceeds because THIS Desk is clear, while another seat has the
    # Book open, is the one outcome the Desk gate exists to prevent. Detecting every seat was only
    # half of it -- until 2026-09-09 the apply path then closed the CALLER's Desk and deleted anyway,
    # leaving each foreign seat a shelf/<slug> entry that would entitle it to whatever Book landed
    # on that slug next. No concurrency needed. A foreign holder is now a refusal.
    #
    # The caller holds the registry lock, which is what makes this answer safe to act on.
    $deskStateDirectory = Join-Path $Workspace '.claude'
    if (-not (Test-Path -LiteralPath $activeRoot -PathType Container)) { throw "Shelf Book '$Slug' was not found at shelf/$Slug." }
    if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw 'shelf/_catalog.md was not found.' }
    $book = Get-ShelfBook -Workspace $Workspace -Slug $Slug
    if ($book.is_capture) { throw "Shelf Book '$Slug' is a capture Book. Its notes must be triaged individually; the capture surface cannot be deleted wholesale." }
    $catalogText = [IO.File]::ReadAllText($catalogPath)
    $entry = Get-ShelfCatalogEntry -CatalogText $catalogText -Slug $Slug
    if ($null -eq $entry) { throw "shelf/_catalog.md lists no Book at shelf/$Slug." }
    $manifest = @(Get-BookFileManifest -BookRoot $activeRoot)
    if ($manifest.Count -eq 0) { throw "Shelf Book '$Slug' contains no files; repair or remove it by hand." }
    $holders = @(Get-SeatsHoldingEntry -Workspace $Workspace -StateDirectory $deskStateDirectory -Kind 'books' -Entry "shelf/$Slug")
    $foreignHolders = @(@($holders) | Where-Object { $_ -cne $ActingSeat } | Sort-Object -CaseSensitive)
    if (@($foreignHolders).Count) {
        # Refused BEFORE a plan_id is issued, which is this codebase's standing rule: an approval for
        # an operation already certain to fail is worse than no approval. Refused again under the
        # lock in the apply path, because a preview is a snapshot by definition.
        throw ("shelf/$Slug is open at $(@($foreignHolders).Count) other seat(s): $(@($foreignHolders) -join ', '). " +
               'Deletion would leave each of them an entry naming a Book that no longer exists, and entitling ' +
               'them to whatever Book lands on that slug next. Close it at those seats first.')
    }
    $wasOpen = @($holders).Count -gt 0
    $reasonText = if ([string]::IsNullOrWhiteSpace($DeleteReason)) { '' } else { $DeleteReason.Trim() }
    $digestSource = @(
        'action=delete-shelf-book',
        "slug=$Slug",
        "title=$($book.title)",
        "reason=$reasonText",
        # The approved action removes this exact entry. Binding the whole Catalog made two otherwise
        # independent deletions invalidate each other merely because the first removed its own entry.
        # The current run still reselects this one entry before writing, so a changed target refuses.
        "catalog_entry=$(Get-TextDigest $entry.Value)",
        # The acting seat is bound too: `desk_open` means "open at THIS seat", so the same digest
        # under a different seat would describe a different operation.
        "acting_seat=$ActingSeat",
        "desk_open=$($wasOpen.ToString().ToLowerInvariant())"
    ) + @($manifest | ForEach-Object { "file=$($_.relative):$($_.sha256)" })
    $planId = 'delete-shelf-book-' + (Get-TextDigest ($digestSource -join "`n"))
    $references = Get-SourceReferences -Workspace $Workspace -Slug $Slug
    [pscustomobject]@{
        operation             = 'Permanently delete a Shelf Book'
        book                  = "shelf/$Slug"
        book_title            = $book.title
        file_count            = $manifest.Count
        files                 = $manifest
        reason                = if ($reasonText) { $reasonText } else { '(none given)' }
        catalog_action        = "remove the '$($entry.Groups[1].Value.Trim())' entry from shelf/_catalog.md"
        acting_seat           = $ActingSeat
        desk_action           = if ($wasOpen) { "close this Book on seat '$ActingSeat' before deletion (a live claim is required for that write)" } else { 'none (the Book is already closed)' }
        blocking_references   = $references.blocking
        other_references      = $references.other
        plan_id               = $planId
        confirmation_required = $true
        destructive           = $true
        recoverable           = $false
        shared_library_write  = $false
        scope                 = 'Permanently deletes this local Shelf Book after staging and verification. No local archive copy is created. The action cannot be undone after staged deletion succeeds.'
    }
}

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
if ($BookSlug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'BookSlug must use lowercase letters, digits, and single hyphens.' }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$deskStateDirectory = Join-Path $workspace '.claude'
# THE ACTING SEAT, needed because "close the Book first" is now the answer for every seat but this
# one. Resolved the same way every other seat-aware helper resolves it, so a seatless session is
# refused here rather than silently treating every holder as foreign.
$actingSeatState = Resolve-SeatName -Seat $Seat -StateDirectory $deskStateDirectory
if ($actingSeatState.status -cne 'named') { throw $actingSeatState.message }
$actingSeat = $actingSeatState.seat

$previewRegistryLock = Enter-SeatRegistryLock -Workspace $workspace -TimeoutSeconds $LockTimeoutSeconds
try { $preview = Get-DeletePlan -Workspace $workspace -Slug $BookSlug -DeleteReason $Reason -ActingSeat $actingSeat }
finally { Exit-BookLock -Lock $previewRegistryLock }
if ($Preflight) { Write-LibraryResult -Result $preview -Json:$Json; return }
if (-not $UserConfirmed) { throw 'The Shelf Book was not deleted: review the preflight and rerun with -UserConfirmed.' }
if ($ApprovedPlanId -cne $preview.plan_id) { throw 'The Shelf Book was not deleted: rerun the current preflight and pass its exact plan_id as ApprovedPlanId.' }

$activeRoot = Join-Path $workspace (Join-Path 'shelf' $BookSlug)
$catalogPath = Join-Path $workspace 'shelf/_catalog.md'
$stagingParent = Join-Path $workspace 'internal/shelf-delete-staging'
$stagingRoot = Join-Path $stagingParent $preview.plan_id
$lock = $null
$registryLock = $null
$mutation = $null
$journalPath = $null
$moved = $false
$catalogChanged = $false
$deskClosed = $false
$permanentDeleteStarted = $false
$wasOpen = $preview.desk_action -clike 'close*'

# NOT SHELLED OUT TO Set-VirtualDesk.ps1 ANY MORE. That helper takes the same non-reentrant registry
# lock, so a child process launched from inside this operation's lock would wait on its own parent
# forever. The Desk write is the acting seat's alone -- every other holder was refused above -- so it
# goes through the lock-held internal writer instead.
#
# THE CLAIM IS ASSERTED HERE, on this path only, and Remove-ShelfBook.ps1 is declared in
# Get-ClaimGatedHelpers for it. The requirement is not new: closing the Desk went through
# Set-VirtualDesk, which demands a claim, so a claimless session already could not delete an open
# Book. Moving the write in-process would have dropped that silently. Deleting a CLOSED Book still
# needs no claim, exactly as before.
function Set-ActingSeatDeskEntry([string]$Action) {
    Assert-SeatClaimHeld -StateDirectory $deskStateDirectory -Seat $actingSeat -Token $ClaimToken | Out-Null
    Set-DeskEntryForSeat -Workspace $workspace -StateDirectory $deskStateDirectory -Seat $actingSeat `
        -Kind 'books' -Entry "shelf/$BookSlug" -Action $Action
}

try {
    # Registry lock first: the total order is registry -> book, and the cross-seat holder scan inside
    # Get-DeletePlan is only true while no seat can open the Book underneath it.
    $registryLock = Enter-SeatRegistryLock -Workspace $workspace -TimeoutSeconds $LockTimeoutSeconds
    $lock = Enter-BookLock -Workspace $workspace -BookRoot "shelf/$BookSlug" -TimeoutSeconds $LockTimeoutSeconds
    $current = Get-DeletePlan -Workspace $workspace -Slug $BookSlug -DeleteReason $Reason -ActingSeat $actingSeat
    if ($current.plan_id -cne $ApprovedPlanId) { throw 'the Book, Shelf Catalog, reason, or Desk state changed after approval' }
    if (Test-Path -LiteralPath $stagingRoot) { throw "deletion staging already exists at internal/shelf-delete-staging/$($preview.plan_id); inspect it before retrying" }

    $mutation = Enter-BookMutation -Workspace $workspace -Slug $BookSlug -BookRoot "shelf/$BookSlug" -Reason "Delete shelf/$BookSlug" -Lock $lock
    # NO PATHS. Everything this operation owns -- the Book's pages and its _catalog-entry.md -- moves
    # into staging as one tree and is moved back as one tree, which a journal of file bytes cannot
    # express anyway. shelf/_catalog.md used to be listed here and was the wrong file: it is
    # rendered from every Book's entry, so restoring this operation's snapshot would drop a Book
    # another seat published while this delete was running. It is re-derived in the catch.
    $journal = Write-BookJournal -Workspace $workspace -BookRoot "shelf/$BookSlug" -Operation "Delete shelf/$BookSlug" -Paths @() -OperationDigest $ApprovedPlanId
    $journalPath = $journal.journal_path

    if ($wasOpen) { $deskClosed = [bool](Set-ActingSeatDeskEntry -Action 'Remove') }
    if (-not (Test-Path -LiteralPath $stagingParent -PathType Container)) { New-Item -ItemType Directory -Path $stagingParent -Force | Out-Null }
    Move-Item -LiteralPath $activeRoot -Destination $stagingRoot
    $moved = $true

    # The entry file went into staging with the rest of the Book, so the catalog is re-rendered from
    # what is left rather than edited by offset. The approved entry is still checked for existence
    # first: a Book whose catalog entry vanished between approval and deletion is not the Book that
    # was approved.
    if ($null -eq (Get-ShelfCatalogEntry -CatalogText ([IO.File]::ReadAllText($catalogPath)) -Slug $BookSlug)) {
        throw "the approved Shelf Catalog entry for shelf/$BookSlug disappeared before deletion"
    }
    # Set AFTER the render returns, never before it is called. A render that threw did not change
    # the catalog -- it writes atomically and verifies by readback -- so re-deriving on the strength
    # of a failed attempt makes a rollback report FAILED over a file it never touched.
    Invoke-ShelfCatalogRender -Workspace $workspace | Out-Null
    $catalogChanged = $true

    $after = @{}
    foreach ($file in @(Get-BookFileManifest -BookRoot $stagingRoot)) { $after[$file.relative] = $file.sha256 }
    foreach ($file in @($preview.files)) {
        if (-not $after.ContainsKey($file.relative)) { throw "staged file '$($file.relative)' is missing" }
        if ($after[$file.relative] -cne $file.sha256) { throw "staged file '$($file.relative)' is not byte-identical" }
    }
    if ($after.Count -ne @($preview.files).Count) { throw 'the staged Book contains an unapproved file' }
    if (Test-Path -LiteralPath $activeRoot) { throw "shelf/$BookSlug still exists after staging" }
    if ($null -ne (Get-ShelfCatalogEntry -CatalogText ([IO.File]::ReadAllText($catalogPath)) -Slug $BookSlug)) { throw "shelf/_catalog.md still lists shelf/$BookSlug" }

    if (-not (Test-IsWithin -Child $stagingRoot -Parent $stagingParent)) { throw 'the resolved deletion staging path escaped internal/shelf-delete-staging' }
    $permanentDeleteStarted = $true
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    if (Test-Path -LiteralPath $stagingRoot) { throw 'the staged Book still exists after permanent deletion' }
    $moved = $false

    $manifestResult = 'not present'
    try {
        $removed = Remove-BookManifestStore -Workspace $workspace -Slug $BookSlug
        $manifestResult = if ($removed.removed) { 'retired' } else { 'not present' }
        $mutation = $null
    }
    catch {
        # The dirty marker was placed before any mutation. If derived-store cleanup fails after the
        # irreversible delete, leaving it dirty is safer than claiming searchable metadata is valid.
        $manifestResult = "dirty orphan requiring Update-BookManifests: $($_.Exception.Message)"
        $mutation = $null
    }

    $result = $preview | Select-Object *
    $result | Add-Member -NotePropertyName status -NotePropertyValue 'deleted'
    $result | Add-Member -NotePropertyName local_book_deleted -NotePropertyValue $true
    $result | Add-Member -NotePropertyName manifest -NotePropertyValue $manifestResult
    $result | Add-Member -NotePropertyName journal -NotePropertyValue ($journalPath.Substring($workspace.Length).TrimStart('\', '/').Replace('\', '/'))
    Write-LibraryResult -Result $result -Json:$Json
}
catch {
    $failure = $_.Exception.Message
    $rollback = 'not required'
    if ($permanentDeleteStarted) {
        $rollback = 'not possible after permanent deletion began'
    }
    else {
        try {
            if ($moved -and (Test-Path -LiteralPath $stagingRoot) -and -not (Test-Path -LiteralPath $activeRoot)) {
                Move-Item -LiteralPath $stagingRoot -Destination $activeRoot
            }
            if ($journalPath) { Restore-BookJournal -JournalPath $journalPath | Out-Null }
            # Reopened only if this run actually closed it, and through the same lock-held writer --
            # the registry lock is still held here, so the child-process route would deadlock.
            if ($deskClosed -and (Test-Path -LiteralPath $activeRoot)) {
                Set-DeskEntryForSeat -Workspace $workspace -StateDirectory $deskStateDirectory -Seat $actingSeat `
                    -Kind 'books' -Entry "shelf/$BookSlug" -Action 'Add' | Out-Null
            }
            # LAST, AND AFTER THE DESK, WHICH IS THE ORDER AND NOT AN ACCIDENT. Re-deriving the
            # catalog is the one step here that can legitimately refuse -- the Shelf may be
            # unrenderable for reasons this operation did not cause -- and it was briefly placed
            # above the Desk restore, where its throw skipped reopening the reader's Book. Every
            # step that can still be completed is completed before the one that might not be.
            # The Book is back on the Shelf with its entry file inside it, so the catalog is
            # re-derived from the entries rather than restored from a snapshot of itself.
            if ($catalogChanged) { Invoke-ShelfCatalogRenderAfterRollback -Workspace $workspace | Out-Null }
            $rollback = 'complete and verified'
        }
        catch { $rollback = "FAILED: $($_.Exception.Message)" }
        if ($null -ne $mutation -and -not $rollback.StartsWith('FAILED')) { Undo-BookMutation -Mutation $mutation | Out-Null }
    }
    throw "The Shelf Book was not deleted. $failure. Rollback: $rollback."
}
finally {
    if ($null -ne $lock) { Exit-BookLock -Lock $lock }
    if ($null -ne $registryLock) { Exit-BookLock -Lock $registryLock }
}
