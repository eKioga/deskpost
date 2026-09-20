<#
.SYNOPSIS
    Retire a Shelf Book from the active Shelf into the local archive, restore one, or list what is
    archived.

.DESCRIPTION
    THE GAP THIS CLOSES. `Archive-SharedBook.ps1` and `Archive-ProjectHub.ps1` have existed since the
    Pilot; both reach the NAS and neither can touch the Shelf. So a Shelf Book that had finished its
    life could only leave the active Shelf by hand-deleting a directory and hand-editing
    `shelf/_catalog.md` -- outside `BookWriteGuard.ps1`'s lock and journal, and outside every check
    that reads the catalog.

    WHERE AN ARCHIVED SHELF BOOK GOES, AND WHY NOT `archive/<slug>`. `BookRootSchema.ps1` already
    owns `archive/<slug>` and it means an archived SHARED Book. Reusing it here would put two
    different Books at one root. This helper uses `shelf/_archive/<slug>` instead, which cannot
    collide with any Book: a Shelf slug is `^[a-z0-9]+(-[a-z0-9]+)*$`, so no Book can ever be called
    `_archive`. Staying under `shelf/` also means the existing Shelf read guard covers the archive
    for free -- an archived Book is closed, exactly as a closed Shelf Book is.

    AN ARCHIVED BOOK RESTS; IT IS NOT FORGOTTEN. Both halves of that are now true, and neither was
    when this helper shipped. The Desk half closed on 2026-08-26: `shelf/_archive/<slug>` is a Book
    root, so an archived Shelf Book opens read-only with `-Shelf Archive`. The SEARCH half closes
    here, under ADR-0012. This helper used to RETIRE the Book's Discovery manifest, which made
    archiving the act that removed a Book from search -- and left every Discovery answer still
    claiming it had covered the whole collection, because the roster it counted against had quietly
    shrunk with it. The manifest now MOVES, from the `shelf` store to `shelf-archive`, and every hit
    it produces is labelled `ARCHIVED`. `-Action Restore` moves it back.

    WHAT ARCHIVING STILL MEANS, THEN. Out of `shelf/_catalog.md`, so no Shelf writer will touch it
    and it is absent from the active Shelf a reader browses; findable, labelled, and read-only.

    RESTORE IS PART OF THE FEATURE, NOT A FOLLOW-UP. An archive with no way back re-creates by hand
    exactly the hand-editing this helper exists to remove. The catalog entry that was removed is
    stored verbatim inside the archived Book, so a restore puts back the entry the reader wrote
    rather than a regenerated approximation of it.

    GATED BOTH WAYS. Archive and Restore each take a preflight, an exact `plan_id`, and one approval.
    The `plan_id` binds the catalog digest, every page hash, and the Desk state, so a Book edited
    between preflight and approval invalidates it. `-Action List` is read-only and ungated.

    WHAT IT REFUSES. A capture Book: the Holding Shelf is the standing capture surface and its notes
    are triaged with `tools/Invoke-LibraryTriage.ps1`, never archived wholesale. A Book that is open on the
    Desk -- close it first, so archiving is never something that happens to material in play.

    SOURCE REFERENCES ARE REPORTED IN TWO LISTS, AND NEVER REWRITTEN. `blocking_references` are
    mentions on the narrow set of surfaces `shelf.references-resolve` actually reads --
    `.claude/skills/**/*.md`, `CLAUDE.md`, `CONTEXT.md` -- and those really do fail the gate.
    `other_references` are mentions anywhere else under `docs/`, `internal/`, or `output/`, which the
    gate never reads: a doc recording a dated event under this Book's name stays true, and editing it
    would be falsifying a record rather than fixing a link. The first live use proved why the
    distinction matters -- eleven mentions, gate green, and an earlier version of this helper had
    flatly predicted failure, sending the reader hunting for edits nobody needed. Deciding what any
    of them should say is still the reader's call, not this helper's.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Archive', 'Restore', 'List')][string]$Action,
    [string]$BookSlug,
    [string]$Reason,
    [string]$WorkspacePath,
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

# The archive's own directory name. Not a Book root and deliberately not expressible as one -- an
# underscore cannot appear in a slug, so BookRootSchema.ps1 stays the only definition of what a Book
# root is and this cannot be mistaken for one.
$script:ArchiveFolder = '_archive'
$script:RecordName = '_archived.json'

function Get-TextDigest([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text))) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

# The same section shape Get-CaptureBook and Rename-ShelfBook match, so every helper agrees which
# catalog entry belongs to a slug.
function Get-ShelfCatalogEntry([string]$CatalogText, [string]$BookSlug) {
    $sections = @([regex]::Matches($CatalogText, '(?ms)^##\s+(.+?)\s*\r?\n(.*?)(?=^##\s+|\z)'))
    $pathPattern = '(?m)^\s*-\s+\*\*Path:\*\*\s+shelf/' + [regex]::Escape($BookSlug) + '\s*$'
    $matched = @($sections | Where-Object { [regex]::IsMatch($_.Groups[2].Value, $pathPattern) })
    if ($matched.Count -eq 0) { return $null }
    if ($matched.Count -ne 1) { throw "shelf/_catalog.md lists 'shelf/$BookSlug' more than once; repair the catalog before archiving." }
    $matched[0]
}

function Get-BookPageManifest([string]$WikiPath) {
    $files = @(Get-ChildItem -LiteralPath $WikiPath -File -Recurse | Sort-Object FullName)
    @($files | ForEach-Object {
        [pscustomobject]@{
            relative = $_.FullName.Substring($WikiPath.Length).TrimStart('\', '/').Replace('\', '/')
            sha256   = Get-FileSha256 -Path $_.FullName
        }
    })
}

# Tracked text naming this Book by path. Reported, never rewritten -- the same rule
# Rename-ShelfBook.ps1 applies, and for the same reason: a doc recording a dated event under a name
# is a true record, and this helper is not the judge of which is which.
#
# SPLIT INTO TWO LISTS, because they are not the same thing and the first version of this helper
# said they were. `shelf.references-resolve` scans a NARROW set -- .claude/skills/**/*.md,
# CLAUDE.md, and CONTEXT.md -- so only a mention there can fail the gate. This scan is deliberately
# wider, because a reader archiving a Book does want to know that docs/ and internal/ name it. What
# it must not do is tell them those will break the build. The first live use archived a Book with
# eleven such mentions, the gate passed clean, and the preflight had said it would fail: a
# confident, false claim that sends a reader hunting for edits nobody needed.
function Get-SourceReferences([string]$Workspace, [string]$BookSlug) {
    # Mirror the gate's own pattern rather than a substring test, so shelf/<slug>-v2 is not counted
    # as a mention of shelf/<slug>.
    $pattern = 'shelf/' + [regex]::Escape($BookSlug) + '(?![a-z0-9-])'
    # Exactly the surfaces shelf.references-resolve reads. Keep this list in step with that check.
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
    $roots = @('docs', 'internal', 'output', '.claude') | ForEach-Object { Join-Path $Workspace $_ }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($root in @($roots | Where-Object { Test-Path -LiteralPath $_ -PathType Container })) {
        foreach ($file in @(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue)) {
            if ($file.Extension -cnotin @('.md', '.json', '.ps1')) { continue }
            if (-not $seen.Add($file.FullName)) { continue }
            $text = ''
            try { $text = [IO.File]::ReadAllText($file.FullName) } catch { continue }
            if (-not [regex]::IsMatch($text, $pattern)) { continue }
            $relative = $file.FullName.Substring($Workspace.Length).TrimStart('\', '/').Replace('\', '/')
            if ($gateFiles.Contains($file.FullName)) { [void]$blocking.Add($relative) } else { [void]$other.Add($relative) }
        }
    }
    foreach ($path in $gateFiles) {
        if ($seen.Contains($path)) { continue }
        $text = ''
        try { $text = [IO.File]::ReadAllText($path) } catch { continue }
        if (-not [regex]::IsMatch($text, $pattern)) { continue }
        [void]$blocking.Add($path.Substring($Workspace.Length).TrimStart('\', '/').Replace('\', '/'))
    }
    [pscustomobject]@{
        blocking = @(@($blocking) | Sort-Object -Unique)
        other    = @(@($other) | Sort-Object -Unique)
    }
}

function Get-DeskOpenRoots([string]$OpenBooksPath) {
    @(Get-DeskFileEntries -Path $OpenBooksPath)
}

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$catalogPath = Join-Path $workspace 'shelf/_catalog.md'
# EVERY SEAT, not this one. Archiving hard-refuses material in play, and "in play" is a property
# of the Library rather than of whoever happens to be running the helper.
$deskStateDirectory = Join-Path $workspace '.claude'
$archiveRoot = Join-Path $workspace (Join-Path 'shelf' $script:ArchiveFolder)

# --- List -------------------------------------------------------------------------------------
# Read-only, and the only way to see the local archive at all: an archived Book is not in the
# catalog, not on the Desk, and not in Discovery, so without this it is invisible.
if ($Action -ceq 'List') {
    $entries = @()
    if (Test-Path -LiteralPath $archiveRoot -PathType Container) {
        foreach ($directory in @(Get-ChildItem -LiteralPath $archiveRoot -Directory | Sort-Object Name)) {
            $recordPath = Join-Path $directory.FullName $script:RecordName
            $record = $null
            if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
                try { $record = [IO.File]::ReadAllText($recordPath) | ConvertFrom-Json } catch { $record = $null }
            }
            $wiki = Join-Path $directory.FullName 'wiki'
            $entries += [pscustomobject]@{
                slug         = $directory.Name
                title        = if ($null -ne $record -and $null -ne $record.PSObject.Properties['title']) { [string]$record.title } else { '(no archive record)' }
                archived_on  = if ($null -ne $record -and $null -ne $record.PSObject.Properties['archived_on']) { [string]$record.archived_on } else { '' }
                reason       = if ($null -ne $record -and $null -ne $record.PSObject.Properties['reason']) { [string]$record.reason } else { '' }
                page_count   = if (Test-Path -LiteralPath $wiki -PathType Container) { @(Get-ChildItem -LiteralPath $wiki -File -Recurse).Count } else { 0 }
                path         = "shelf/$($script:ArchiveFolder)/$($directory.Name)"
                restorable   = ($null -ne $record -and $null -ne $record.PSObject.Properties['catalog_entry'])
            }
        }
    }
    $listing = [ordered]@{
        operation            = 'List archived Shelf Books'
        archive_path         = "shelf/$($script:ArchiveFolder)"
        archived_count       = $entries.Count
        books                = $entries
        shared_library_write = $false
        scope                = 'Read-only. Archived Shelf Books are not on the Desk, not in the Book Catalog, and not covered by Discovery or full text; this listing is the only way to see them.'
    }
    Write-LibraryResult -Result ([pscustomobject]$listing) -Json:$Json
    return
}

if ([string]::IsNullOrWhiteSpace($BookSlug)) { throw "BookSlug is required for -Action $Action." }
# -cnotmatch, not -notmatch: -notmatch is case-insensitive, so 'My-Book' would satisfy this
# lowercase-only rule and travel on as part of a path.
if ($BookSlug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'BookSlug must use lowercase letters, digits, and single hyphens.' }

$activeRoot = Join-Path $workspace (Join-Path 'shelf' $BookSlug)
$archivedRoot = Join-Path $archiveRoot $BookSlug
$recordPath = Join-Path $archivedRoot $script:RecordName
# The Desk/manifest identity the archived Book takes on, from the schema rather than composed here.
$archivedBookRoot = New-BookRoot -Location Shelf -Shelf Archive -Slug $BookSlug
if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw 'shelf/_catalog.md was not found.' }
$catalogText = [IO.File]::ReadAllText($catalogPath)

# EVERY SEAT'S OPEN BOOKS, read under the registry lock -- and read HERE rather than at script level,
# where it used to sit for both actions. Restore never consulted it, and a cross-seat scan is only
# true while the set of seats cannot change, so it belongs inside the branch that acts on it.
function Get-OpenBookRootsEverywhere([string]$Workspace, [string]$StateDirectory) {
    @(@(Get-DeskEntriesAcrossSeats -Workspace $Workspace -StateDirectory $StateDirectory -Kind 'books') |
        ForEach-Object { $_.entries } | Select-Object -Unique)
}

# --- Archive ----------------------------------------------------------------------------------
if ($Action -ceq 'Archive') {
    $book = Get-ShelfBook -Workspace $workspace -Slug $BookSlug
    if ($book.is_capture) {
        throw "Shelf Book '$BookSlug' is a capture Book. Its notes are triaged with tools/Invoke-LibraryTriage.ps1; a capture surface is not archived wholesale."
    }
    $previewLock = Enter-SeatRegistryLock -Workspace $workspace -TimeoutSeconds $LockTimeoutSeconds
    try { $deskRoots = @(Get-OpenBookRootsEverywhere -Workspace $workspace -StateDirectory $deskStateDirectory) }
    finally { Exit-BookLock -Lock $previewLock }
    if ("shelf/$BookSlug" -cin $deskRoots) {
        throw "shelf/$BookSlug is open on the Desk. Close it first with tools/Set-VirtualDesk.ps1 -Action Close -Kind Book -Location Shelf -Slug $BookSlug, so archiving never happens to material in play."
    }
    # Checked before a plan_id is issued, not after: an approval for an operation already certain to
    # fail is the defect Phase 0 fixed in Import-ExternalWikiToShelf.
    if (Test-Path -LiteralPath $archivedRoot) {
        throw "shelf/$($script:ArchiveFolder)/$BookSlug already exists. Restore or move that archived Book out of the way first."
    }
    $entry = Get-ShelfCatalogEntry -CatalogText $catalogText -BookSlug $BookSlug
    if ($null -eq $entry) { throw "shelf/_catalog.md lists no Book at shelf/$BookSlug." }

    $wikiPath = Join-Path $activeRoot 'wiki'
    if (-not (Test-Path -LiteralPath $wikiPath -PathType Container)) { throw "Shelf Book '$BookSlug' has no pages directory at shelf/$BookSlug/wiki." }
    $manifest = @(Get-BookPageManifest -WikiPath $wikiPath)
    $references = Get-SourceReferences -Workspace $workspace -BookSlug $BookSlug

    $digestSource = @(
        "action=archive", "slug=$BookSlug", "title=$($book.title)", "catalog=$(Get-TextDigest $catalogText)"
    ) + @($manifest | ForEach-Object { "page=$($_.relative):$($_.sha256)" })
    $planId = 'archive-shelf-book-' + (Get-TextDigest ($digestSource -join "`n"))

    $plan = [ordered]@{
        operation             = 'Archive a Shelf Book'
        book                  = "shelf/$BookSlug"
        book_title            = $book.title
        destination           = "shelf/$($script:ArchiveFolder)/$BookSlug"
        page_count            = $manifest.Count
        reason                = if ([string]::IsNullOrWhiteSpace($Reason)) { '(none given)' } else { $Reason }
        catalog_action        = "remove the '$($entry.Groups[1].Value.Trim())' entry from shelf/_catalog.md"
        manifest_action       = 'move this Book''s Discovery manifest into the archive store, so search keeps covering it and labels it archived'
        desk_action           = 'none (the Book must already be closed)'
        blocking_references   = $references.blocking
        other_references      = $references.other
        plan_id               = $planId
        confirmation_required = $true
        recoverable           = $true
        shared_library_write  = $false
        scope                 = 'Moves this Book''s whole directory into the local archive, removes its Book Catalog entry, and moves its Discovery manifest into the archive store. Every page is verified byte-identical at the archive path afterwards. The Book stays findable and is LABELLED archived: Discovery covers it, and it opens read-only on the Desk with -Shelf Archive, which is what full text needs. It is out of the active Shelf catalog, so no Shelf writer will touch it. Nothing is deleted, and -Action Restore puts it back.'
        next                  = if ($references.blocking.Count) {
            "blocking_references lists $($references.blocking.Count) file(s) on a surface shelf.references-resolve reads, so the gate WILL fail until they are updated in the same commit. other_references are mentions the gate does not read; a dated record naming this Book stays true and needs no edit."
        } else {
            "No blocking references: nothing on a surface shelf.references-resolve reads names this Book, so the gate will pass. other_references lists $($references.other.Count) mention(s) elsewhere -- history rather than live claims, and no edit is needed for the gate."
        }
    }
    if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json; return }

    if (-not $UserConfirmed) { throw 'The Book was not archived: review the preflight and rerun with -UserConfirmed.' }
    if ($ApprovedPlanId -cne $planId) { throw 'The Book was not archived: rerun the current preflight and pass its exact plan_id as ApprovedPlanId. A different plan_id means the Book or the catalog changed since you approved it.' }

    $lock = $null
    $registryLock = $null
    $journalPath = $null
    $mutation = $null
    $moved = $false
    # SET AFTER THE RENDER RETURNS, NEVER BEFORE IT IS CALLED. It means "this operation changed the
    # catalog", and a render that threw did not -- the write is atomic and verified by readback, so
    # a failure leaves the previous catalog where it was. Setting it beforehand made a rollback
    # report FAILED over a catalog it had never touched, which Test-LibraryHelpers' read-only
    # injection caught immediately.
    $catalogRendered = $false
    try {
        # THE REGISTRY LOCK BEFORE THE BOOK LOCK, the first class in the total order. The Desk check
        # above was made against a snapshot nothing held still: Set-VirtualDesk takes only this lock,
        # so the Book lock excluded nothing a seat opening the Book would do, and a Book opened
        # between the preview and here would have been archived out from under a live reader.
        $registryLock = Enter-SeatRegistryLock -Workspace $workspace -TimeoutSeconds $LockTimeoutSeconds
        $lock = Enter-BookLock -Workspace $workspace -BookRoot "shelf/$BookSlug" -TimeoutSeconds $LockTimeoutSeconds

        # Re-asserted under the lock, not trusted from the preview. This is the check-then-act the
        # lock exists to close, so the act has to sit on this side of it.
        if ("shelf/$BookSlug" -cin @(Get-OpenBookRootsEverywhere -Workspace $workspace -StateDirectory $deskStateDirectory)) {
            throw "shelf/$BookSlug was opened on a Desk after the preflight. Close it at every seat, then rerun the preflight"
        }

        # The window opens on the identity that is about to stop being true, before the move -- the
        # same ordering Rename-ShelfBook uses, and for the same reason.
        $mutation = Enter-BookMutation -Workspace $workspace -Slug $BookSlug -BookRoot "shelf/$BookSlug" -Reason "Archive shelf/$BookSlug" -Lock $lock

        # NO PATHS, AND THAT IS THE HONEST ANSWER. This operation rewrites no file in place: the
        # Book's own authority -- its pages and its _catalog-entry.md -- travels inside the
        # directory that moves, and the directory move is unwound separately in the catch because a
        # journal records file bytes and not a moved tree. The catalog used to be listed here, and
        # it was the wrong file: it is rendered from every Book's entry, so restoring this
        # operation's snapshot of it would drop a Book another seat published in the meantime. It is
        # re-derived in the catch instead. The journal stays for its dated operation record.
        $journal = Write-BookJournal -Workspace $workspace -BookRoot "shelf/$BookSlug" -Operation "Archive shelf/$BookSlug" -Paths @() -OperationDigest $planId
        $journalPath = $journal.journal_path

        if (-not (Test-Path -LiteralPath $archiveRoot -PathType Container)) { New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null }
        Move-Item -LiteralPath $activeRoot -Destination $archivedRoot
        $moved = $true

        # The catalog entry, verbatim. A restore puts back what the reader wrote rather than a
        # regenerated approximation of it -- summary lines, Kind markers and annotations included.
        $record = [ordered]@{
            schema        = 1
            slug          = $BookSlug
            title         = $book.title
            archived_on   = (Get-Date).ToString('yyyy-MM-dd')
            reason        = if ([string]::IsNullOrWhiteSpace($Reason)) { '' } else { $Reason }
            page_count    = $manifest.Count
            catalog_entry = $catalogText.Substring($entry.Index, $entry.Length)
        }
        Write-Utf8 $recordPath (($record | ConvertTo-Json -Depth 8) + "`n")

        # THE ENTRY FILE ARCHIVED ITSELF. It lives inside shelf/<slug>/, so the directory move
        # above already took it out of the active Shelf -- there is no offset arithmetic left to get
        # wrong, and no window in which the catalog and the entry disagree about which Books exist.
        # Under shelf/_archive/<slug>/ it is inert: the renderer skips the Shelf's own underscore
        # namespace, which is what keeps an archived Book out of the active catalog (ADR-0012 keeps
        # it in Discovery instead).
        Invoke-ShelfCatalogRender -Workspace $workspace | Out-Null
        $catalogRendered = $true

        $problems = [Collections.Generic.List[string]]::new()
        if (Test-Path -LiteralPath $activeRoot) { [void]$problems.Add("shelf/$BookSlug still exists after the move") }
        $archivedWiki = Join-Path $archivedRoot 'wiki'
        if (-not (Test-Path -LiteralPath $archivedWiki -PathType Container)) { [void]$problems.Add('the archived Book has no wiki directory') }
        else {
            $after = @{}
            foreach ($page in @(Get-BookPageManifest -WikiPath $archivedWiki)) { $after[$page.relative] = $page.sha256 }
            foreach ($page in $manifest) {
                if (-not $after.ContainsKey($page.relative)) { [void]$problems.Add("$($page.relative) is missing after the move") }
                elseif ($after[$page.relative] -cne $page.sha256) { [void]$problems.Add("$($page.relative) is not byte-identical after the move") }
            }
        }
        if ($null -ne (Get-ShelfCatalogEntry -CatalogText ([IO.File]::ReadAllText($catalogPath)) -BookSlug $BookSlug)) {
            [void]$problems.Add("shelf/_catalog.md still lists shelf/$BookSlug")
        }
        if ($problems.Count) { throw ($problems -join '; ') }

        # Only now, with the move verified. THE MANIFEST FOLLOWS THE BOOK; IT IS NO LONGER RETIRED.
        # Retiring it was what made archiving the act that removed a Book from Discovery -- the
        # archive became a place material was forgotten rather than rested, and worse, the answer went
        # on claiming it had searched every Book. ADR-0012 settles that archived material is covered
        # and labelled, so the store moves from `shelf` to `shelf-archive` under the same relocation
        # primitive a rename uses, and with the same crash ordering: new identity dirty first, old
        # store removed second, new generation committed last.
        #
        # The manifest is generated HERE, from the pages at their ARCHIVE path, because the
        # transaction refuses to self-generate for any collection but the active Shelf -- and
        # rightly, since New-BookManifest resolves a slug through a catalog this Book has just left.
        $archivedLock = $null
        try {
            $archivedLock = Enter-BookLock -Workspace $workspace -BookRoot $archivedBookRoot -TimeoutSeconds $LockTimeoutSeconds
            $archivedManifest = New-BookManifestForShelfBook -Book (Get-ArchivedShelfBook -Workspace $workspace -Slug $BookSlug)
            $relocated = Complete-BookRenameMutation -Mutation $mutation -NewSlug $BookSlug `
                -NewBookRoot $archivedBookRoot -NewLock $archivedLock -NewCollection 'shelf-archive' -Manifest $archivedManifest
            $plan.manifest = $relocated.summary
        }
        finally {
            if ($null -ne $archivedLock) { Exit-BookLock -Lock $archivedLock }
        }
        $mutation = $null

        $plan.status = 'archived'
        $plan.archive_record = "shelf/$($script:ArchiveFolder)/$BookSlug/$($script:RecordName)"
        $plan.pages_verified_identical = $manifest.Count
        $plan.journal = $journalPath.Substring($workspace.Length).TrimStart('\', '/').Replace('\', '/')
        $plan.next = if ($references.blocking.Count) {
            'Run tools/Invoke-LibraryChecks.ps1. shelf.references-resolve will fail until blocking_references are updated.'
        } else {
            'Run tools/Invoke-LibraryChecks.ps1; nothing here should need editing for it to pass.'
        }
    }
    catch {
        $failure = $_.Exception.Message
        $rollback = 'not required'
        try {
            if ($moved -and (Test-Path -LiteralPath $archivedRoot) -and -not (Test-Path -LiteralPath $activeRoot)) {
                if (Test-Path -LiteralPath $recordPath -PathType Leaf) { Remove-Item -LiteralPath $recordPath -Force }
                Move-Item -LiteralPath $archivedRoot -Destination $activeRoot
            }
            if ($journalPath) { Restore-BookJournal -JournalPath $journalPath | Out-Null }
            # LAST: the Book is back on the active Shelf with its entry file inside it, so the
            # catalog is re-derived from the entries rather than restored from a snapshot of itself.
            if ($catalogRendered) { Invoke-ShelfCatalogRenderAfterRollback -Workspace $workspace | Out-Null }
            $rollback = 'complete and verified'
        }
        catch { $rollback = "FAILED: $($_.Exception.Message)" }
        if ($null -ne $mutation -and -not $rollback.StartsWith('FAILED')) { Undo-BookMutation -Mutation $mutation | Out-Null }
        throw "The Book was not archived. $failure. Rollback: $rollback."
    }
    finally {
        if ($null -ne $lock) { Exit-BookLock -Lock $lock }
        if ($null -ne $registryLock) { Exit-BookLock -Lock $registryLock }
    }

    Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
    return
}

# --- Restore ----------------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $archivedRoot -PathType Container)) {
    throw "shelf/$($script:ArchiveFolder)/$BookSlug was not found. Run -Action List to see what is archived."
}
if (Test-Path -LiteralPath $activeRoot) {
    throw "shelf/$BookSlug already exists on the active Shelf. Rename or archive that Book first."
}
if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) {
    throw "shelf/$($script:ArchiveFolder)/$BookSlug has no $($script:RecordName), so the catalog entry it was archived with is not recoverable. Restore it by hand, or re-add it with tools/Import-ExternalWikiToShelf.ps1."
}
# Read before anything moves: the rollback needs these exact bytes to put the record back, and by
# then the file it came from is inside a directory that has been moved.
$recordText = [IO.File]::ReadAllText($recordPath)
$record = $recordText | ConvertFrom-Json
if ($null -eq $record.PSObject.Properties['catalog_entry']) { throw "The archive record for $BookSlug carries no catalog entry." }
if ($null -ne (Get-ShelfCatalogEntry -CatalogText $catalogText -BookSlug $BookSlug)) {
    throw "shelf/_catalog.md already lists a Book at shelf/$BookSlug. Repair the catalog before restoring."
}

$archivedWiki = Join-Path $archivedRoot 'wiki'
if (-not (Test-Path -LiteralPath $archivedWiki -PathType Container)) { throw "The archived Book at shelf/$($script:ArchiveFolder)/$BookSlug has no wiki directory." }
$restoreManifest = @(Get-BookPageManifest -WikiPath $archivedWiki)
$entryText = [string]$record.catalog_entry

$restoreDigest = @(
    "action=restore", "slug=$BookSlug", "catalog=$(Get-TextDigest $catalogText)", "entry=$(Get-TextDigest $entryText)"
) + @($restoreManifest | ForEach-Object { "page=$($_.relative):$($_.sha256)" })
$restorePlanId = 'restore-shelf-book-' + (Get-TextDigest ($restoreDigest -join "`n"))

$restorePlan = [ordered]@{
    operation             = 'Restore an archived Shelf Book'
    book                  = "shelf/$($script:ArchiveFolder)/$BookSlug"
    destination           = "shelf/$BookSlug"
    book_title            = if ($null -ne $record.PSObject.Properties['title']) { [string]$record.title } else { $BookSlug }
    archived_on           = if ($null -ne $record.PSObject.Properties['archived_on']) { [string]$record.archived_on } else { '' }
    page_count            = $restoreManifest.Count
    catalog_action        = 'append the archived entry back to shelf/_catalog.md, exactly as it was removed'
    manifest_action       = 'retire the archive store''s manifest and regenerate this Book''s active one from the pages as they now stand'
    plan_id               = $restorePlanId
    confirmation_required = $true
    recoverable           = $true
    shared_library_write  = $false
    scope                 = 'Moves the archived Book back to shelf/<slug>, restores its Book Catalog entry verbatim, and commits a fresh Discovery manifest. Every page is verified byte-identical afterwards. The Book is restored CLOSED; open it with tools/Set-VirtualDesk.ps1.'
}
if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$restorePlan) -Json:$Json; return }

if (-not $UserConfirmed) { throw 'The Book was not restored: review the preflight and rerun with -UserConfirmed.' }
if ($ApprovedPlanId -cne $restorePlanId) { throw 'The Book was not restored: rerun the current preflight and pass its exact plan_id as ApprovedPlanId. A different plan_id means the archived Book or the catalog changed since you approved it.' }

$restoreLock = $null
$restoreJournalPath = $null
$restoreMutation = $null
$restoreMoved = $false
$restoreCatalogRendered = $false
try {
    $restoreLock = Enter-BookLock -Workspace $workspace -BookRoot "shelf/$BookSlug" -TimeoutSeconds $LockTimeoutSeconds

    # NO PATHS, for the same reason the archive direction records none: the Book's own authority
    # rides inside the directory that moves, and shelf/_catalog.md is derived from every Book's
    # entry rather than owned by this one. It is re-derived in the catch.
    $restoreJournal = Write-BookJournal -Workspace $workspace -BookRoot "shelf/$BookSlug" -Operation "Restore shelf/$BookSlug" -Paths @() -OperationDigest $restorePlanId
    $restoreJournalPath = $restoreJournal.journal_path

    Move-Item -LiteralPath $archivedRoot -Destination $activeRoot
    $restoreMoved = $true
    # The archive record travels with the directory and does not belong on the active Shelf. Its
    # bytes were read before the move, so the rollback below can put it back -- deleting it without
    # having captured it would make the rollback lossy in exactly the way the journal exists to
    # prevent, and the journal cannot cover it because it moved rather than changed.
    $restoredRecord = Join-Path $activeRoot $script:RecordName
    if (Test-Path -LiteralPath $restoredRecord -PathType Leaf) { Remove-Item -LiteralPath $restoredRecord -Force }

    # RESTORED FROM THE RECORD, INTO THE BOOK'S OWN ENTRY FILE, inside the render lock. The record
    # is still the authority on what the entry said -- summary lines, Kind markers and the reader's
    # own annotations -- and writing it to shelf/<slug>/_catalog-entry.md rather than into the
    # catalog means no offset from the archive has to still be valid. Where the Book was archived
    # after this change its entry file travelled back with the directory; rewriting it from the
    # record is then a byte-identical no-op rather than a second source of truth.
    Invoke-ShelfCatalogRender -Workspace $workspace -WriteEntry @(
        @{ path = (Get-ShelfCatalogEntryPath -Workspace $workspace -Slug $BookSlug); text = $entryText }
    ) | Out-Null
    $restoreCatalogRendered = $true

    # The window opens AFTER the move here, because the identity this manifest describes is the one
    # the Book is arriving at rather than the one it is leaving.
    $restoreMutation = Enter-BookMutation -Workspace $workspace -Slug $BookSlug -BookRoot "shelf/$BookSlug" -Reason "Restore shelf/$BookSlug" -Lock $restoreLock
    # The ARCHIVED store is retired in the same breath, and it has to be: leaving it behind would
    # leave Discovery answering for an archived Book whose pages have moved back to the active Shelf,
    # offering a reader `-Shelf Archive` on a Book that is no longer there. Removed rather than
    # relocated, because the active identity's generation is committed fresh below from the Book as
    # it now stands -- the same argument Complete-BookRenameMutation makes for not carrying a
    # manifest across a change of identity.
    Remove-BookManifestStore -Workspace $workspace -Slug $BookSlug -Collection 'shelf-archive' | Out-Null

    $problems = [Collections.Generic.List[string]]::new()
    if (Test-Path -LiteralPath $archivedRoot) { [void]$problems.Add("shelf/$($script:ArchiveFolder)/$BookSlug still exists after the move") }
    $liveWiki = Join-Path $activeRoot 'wiki'
    if (-not (Test-Path -LiteralPath $liveWiki -PathType Container)) { [void]$problems.Add('the restored Book has no wiki directory') }
    else {
        $after = @{}
        foreach ($page in @(Get-BookPageManifest -WikiPath $liveWiki)) { $after[$page.relative] = $page.sha256 }
        foreach ($page in $restoreManifest) {
            if (-not $after.ContainsKey($page.relative)) { [void]$problems.Add("$($page.relative) is missing after the move") }
            elseif ($after[$page.relative] -cne $page.sha256) { [void]$problems.Add("$($page.relative) is not byte-identical after the move") }
        }
    }
    if ($null -eq (Get-ShelfCatalogEntry -CatalogText ([IO.File]::ReadAllText($catalogPath)) -BookSlug $BookSlug)) {
        [void]$problems.Add("shelf/_catalog.md does not list shelf/$BookSlug after the restore")
    }
    if ($problems.Count) { throw ($problems -join '; ') }

    $restorePlan.manifest = (Complete-BookMutation -Mutation $restoreMutation).summary
    $restoreMutation = $null

    $restorePlan.status = 'restored'
    $restorePlan.book_path = "shelf/$BookSlug/wiki"
    $restorePlan.pages_verified_identical = $restoreManifest.Count
    $restorePlan.journal = $restoreJournalPath.Substring($workspace.Length).TrimStart('\', '/').Replace('\', '/')
    $restorePlan.next = "The Book is on the Shelf and closed. Open it with tools/Set-VirtualDesk.ps1 -Action Open -Kind Book -Location Shelf -Slug $BookSlug, then run tools/Invoke-LibraryChecks.ps1."
}
catch {
    $failure = $_.Exception.Message
    $rollback = 'not required'
    try {
        if ($restoreMoved -and (Test-Path -LiteralPath $activeRoot) -and -not (Test-Path -LiteralPath $archivedRoot)) {
            Move-Item -LiteralPath $activeRoot -Destination $archivedRoot
            Write-Utf8 (Join-Path $archivedRoot $script:RecordName) $recordText
        }
        if ($restoreJournalPath) { Restore-BookJournal -JournalPath $restoreJournalPath | Out-Null }
        # LAST: the Book is back under shelf/_archive/ with its entry file inside it, so the catalog
        # is re-derived from the entries that remain rather than restored from a snapshot of itself.
        if ($restoreCatalogRendered) { Invoke-ShelfCatalogRenderAfterRollback -Workspace $workspace | Out-Null }
        $rollback = 'complete and verified'
    }
    catch { $rollback = "FAILED: $($_.Exception.Message)" }
    if ($null -ne $restoreMutation -and -not $rollback.StartsWith('FAILED')) { Undo-BookMutation -Mutation $restoreMutation | Out-Null }
    throw "The Book was not restored. $failure. Rollback: $rollback."
}
finally {
    if ($null -ne $restoreLock) { Exit-BookLock -Lock $restoreLock }
}

Write-LibraryResult -Result ([pscustomobject]$restorePlan) -Json:$Json
