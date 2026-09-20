<#
.SYNOPSIS
    Add one new page to a Shelf Book that is open on the Desk.

.DESCRIPTION
    Item 1.2 of the plan, and the writer [ADR-0001](../docs/adr/0001-shelf-books-accept-pages-when-open.md)
    calls for. Until now every Shelf Book was create-once, so "graduate this to the Godot Book" was
    impossible and the only moves were a thirteenth Book or the Holding Shelf -- which is how the
    Shelf reached twelve Books with four unresolved overlaps.

    The write is additive and therefore applies directly, with no plan_id: it can only create a page
    that does not exist, using create-new semantics so a collision fails rather than overwrites. What
    replaces the confirmation is the Desk: the Book must be open, because adding a page to a curated
    Book is a curatorial act, exactly as triaging a note already is.

    Capture Books are deliberately refused here. The two paths stay distinct: capture is ungated into
    disposable Books via Add-ShelfNote.ps1, graduation is deliberate into open curated ones.

    Everything runs under the Book's lock from BookWriteGuard.ps1, with prior state journaled before
    the first write -- the new page's prior ABSENCE, so a rollback deletes it rather than leaving it
    behind, and the reader map's prior body.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BookSlug,
    [Parameter(Mandatory = $true)][string]$PagePath,
    [string]$Title,
    [string]$ContentPath,
    [string]$Content,
    [string]$WorkspacePath,
    [int]$LockTimeoutSeconds = 20,
    [switch]$Preflight,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
. (Join-Path $PSScriptRoot 'BookManifestTransaction.ps1')

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

$book = Get-ShelfBook -Workspace $workspace -Slug $BookSlug
if ($book.is_capture) {
    throw "Shelf Book '$BookSlug' is a capture Book. Use tools/Add-ShelfNote.ps1 for it; this helper is for graduating material into a curated Book."
}
if (-not (Test-Path -LiteralPath $book.wiki_path -PathType Container)) { throw "Shelf Book '$BookSlug' has no pages directory at shelf/$BookSlug/wiki." }
Assert-ShelfBookOpen -Workspace $workspace -Slug $BookSlug -Action 'adding a page to it'

$hasPath = -not [string]::IsNullOrWhiteSpace($ContentPath)
$hasInline = -not [string]::IsNullOrWhiteSpace($Content)
if ($hasPath -and $hasInline) { throw 'Give either -ContentPath or -Content, not both.' }
if (-not $hasPath -and -not $hasInline) { throw 'A page needs a body: pass -ContentPath (preferred for prose) or -Content.' }

# A body is usually a Notebook article, so a rooted path is taken as given and only a relative one is
# resolved against the workspace. Same rule as Add-ShelfNote, for the same reason.
$body = if ($hasPath) {
    $candidate = if ([IO.Path]::IsPathRooted($ContentPath)) { $ContentPath } else { Join-Path $workspace $ContentPath }
    $sourceFull = [IO.Path]::GetFullPath($candidate)
    if (-not (Test-Path -LiteralPath $sourceFull -PathType Leaf)) { throw "ContentPath was not found: $ContentPath" }
    [IO.File]::ReadAllText($sourceFull)
} else { $Content }
if ([string]::IsNullOrWhiteSpace($body)) { throw 'The page body is empty; nothing was added.' }

$page = ConvertTo-BookPagePath -Raw $PagePath
$relative = "$page.md"
$fullPath = Join-Path $book.wiki_path ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
if (Test-Path -LiteralPath $fullPath) {
    throw "shelf/$BookSlug/wiki/$relative already exists. This helper only ever adds a page; choose another PagePath."
}

# A body that already leads with its own H1 keeps it, so the page, the reader, and any later search
# all call it the same thing. Shared with the topic writer, which must compare an existing page
# against exactly these bytes to decide an entry is already there and that entry is done.
$rendered = ConvertTo-ShelfPageBody -Body $body -Title $Title
$pageTitle = $rendered.title
$pageBody = $rendered.body

$mapPath = Join-Path $book.wiki_path '_index.md'
$mapIsGenerated = Test-GeneratedReaderMap -Path $mapPath
$unlisted = @(Get-UnlistedBookPages -Book $book)

$plan = [ordered]@{
    operation             = 'Add a page to a Shelf Book'
    book                  = $book.book_root
    book_title            = $book.title
    page                  = "$($book.book_root)/wiki/$relative"
    page_title            = $pageTitle
    title_source          = $rendered.title_source
    body_characters       = $body.Length
    source                = if ($hasPath) { $ContentPath } else { '(inline)' }
    reader_map_action     = if ($mapIsGenerated) { 'regenerate from the pages on disk' } else { 'append the link; this map is curated, so it is not regenerated' }
    reader_map_unlisted   = $unlisted.Count
    confirmation_required = $false
    shared_library_write  = $false
    scope                 = 'Creates one new page in this open Shelf Book, regenerates its reader map, and commits a new Discovery manifest generation in the same locked window. No existing page is read, changed, or removed.'
}
if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json; return }

$lock = $null
$journalPath = $null
$mutation = $null
$createdDirectories = @()
try {
    $lock = Enter-BookLock -Workspace $workspace -BookRoot $book.book_root -TimeoutSeconds $LockTimeoutSeconds

    # Re-checked under the lock: the collision test above happened before anyone was excluded, so on
    # its own it is exactly the check-then-write race this item exists to close.
    if (Test-Path -LiteralPath $fullPath) {
        throw "shelf/$BookSlug/wiki/$relative was created while this page was being prepared. Nothing was written."
    }

    # 2.2 rung 4. The mutation window opens before the first write, never after the last one: a
    # manifest committed only afterwards would leave this Book reading `ok` for the whole span in
    # which the new page existed and no stored manifest mentioned it. It is opened on the lock this
    # helper already holds -- Enter-BookLock is not re-entrant, so a second acquisition would deadlock
    # against this one.
    $mutation = Enter-BookMutation -Workspace $workspace -Slug $book.slug -BookRoot $book.book_root -Reason "Add page $relative" -Lock $lock

    $journal = Write-BookJournal -Workspace $workspace -BookRoot $book.book_root -Operation "Add page $relative" -Paths @($fullPath, $mapPath)
    $journalPath = $journal.journal_path

    $parent = Split-Path -Parent $fullPath
    while (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        $createdDirectories += $parent
        $parent = Split-Path -Parent $parent
    }
    if ($createdDirectories.Count) { New-Item -ItemType Directory -Path (Split-Path -Parent $fullPath) -Force | Out-Null }

    # CreateNew is atomic and is what makes a collision fail rather than overwrite, even if the lock
    # were ever bypassed. The journal's prior-absence entry is what lets a rollback delete this file.
    $stream = [IO.File]::Open($fullPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($pageBody)
        $stream.Write($bytes, 0, $bytes.Length)
    }
    finally { $stream.Dispose() }

    $readback = [IO.File]::ReadAllText($fullPath)
    if ($readback -cne $pageBody) { throw "The page was written but did not read back identically: $($book.book_root)/wiki/$relative" }

    # A generated map is regenerated, so it can never drift. A curated one is appended to, because
    # regenerating it would destroy sections and annotations a reader wrote -- and an additive write
    # that can destroy text is not additive. What regeneration would have guaranteed is reported
    # instead, as the count of pages on disk that no link names.
    if ($mapIsGenerated) {
        $map = Update-ShelfBookIndex -Book $book
        $plan.reader_map_pages = $map.page_count
    }
    else {
        Add-ShelfBookIndexLink -Book $book -Page $page -Label $pageTitle | Out-Null
    }
    # Asserts the TARGET, because the label is now the page's title rather than its filename and this
    # readback would otherwise pin the defect it just stopped producing.
    if (-not ([IO.File]::ReadAllText($mapPath)).Contains("[[$page|")) {
        throw "The reader map was updated but does not list $relative."
    }

    # Closed last, once every write has been made and verified -- and it cannot throw, because the
    # page has landed by now and a manifest problem must never unwind into the rollback below and
    # discard it. A refusal is reported here and the Book reads dirty until something rebuilds it.
    $plan.manifest = (Complete-BookMutation -Mutation $mutation).summary
    $mutation = $null

    $plan.status = 'added'
    $plan.reader_map = "$($book.book_root)/wiki/_index.md"
    $plan.reader_map_unlisted = @(Get-UnlistedBookPages -Book $book).Count
    $plan.journal = $journalPath.Substring($workspace.Length).TrimStart('\', '/').Replace('\', '/')
    $plan.next = if ($mapIsGenerated) {
        'The Book is open; read the new page with mcp__validated-book-reader__read_open_book_page.'
    } else {
        'This Book''s reader map is curated, so the new link was appended at the end. Move it into the right section if it belongs elsewhere.'
    }
}
catch {
    $failure = $_.Exception.Message
    $rollback = 'not required'
    if ($journalPath) {
        try {
            Restore-BookJournal -JournalPath $journalPath | Out-Null
            # A directory this operation created has no prior state to journal, so it is unwound
            # here -- deepest first, and only while empty, so a concurrent writer's page survives.
            foreach ($directory in @($createdDirectories)) {
                if ((Test-Path -LiteralPath $directory -PathType Container) -and -not @(Get-ChildItem -LiteralPath $directory -Force).Count) {
                    Remove-Item -LiteralPath $directory -Force
                }
            }
            $rollback = 'complete and verified'
        }
        catch { $rollback = "FAILED: $($_.Exception.Message)" }
    }
    # The Book is back to the state the committed manifest already describes, so the marker is stale
    # and clearing it restores a true answer. After a rollback that FAILED the Book's state is
    # unknown, and the marker stays down: dirty is then the only honest thing the store can say.
    if ($null -ne $mutation -and -not $rollback.StartsWith('FAILED')) { Undo-BookMutation -Mutation $mutation | Out-Null }
    throw "The page was not added. $failure. Rollback: $rollback."
}
finally {
    # Guarded: when Enter-BookLock itself fails, $lock is still null, and an unguarded release here
    # would replace the real "another operation holds the lock" message with a binding error.
    if ($null -ne $lock) { Exit-BookLock -Lock $lock }
}

Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
