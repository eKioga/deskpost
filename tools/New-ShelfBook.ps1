[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Slug,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Summary,
    [string]$Topics = '',
    [switch]$Capture,
    [string]$Origin = '',
    [string]$WorkspacePath,
    [int]$LockTimeoutSeconds = 20,
    [switch]$Preflight,
    [switch]$Json
)

<#
.SYNOPSIS
    Create a new, EMPTY Shelf Book -- curated, or capture-enabled with -Capture.

.DESCRIPTION
    THE GAP THIS FILLS. Every existing route to a Shelf Book creates it from material that already
    exists: `Publish-BookCopy.ps1` copies source files and refuses an existing destination,
    `Import-ExternalWikiToShelf.ps1` needs an external wiki, and `Add-CatalogEntry.ps1` targets the
    SHARED Catalog over MCP rather than the Shelf. Nothing creates an empty one -- so adding a
    capture Book, which `ShelfNoteCommon.ps1` says a reader may do by editing the catalog, had no
    route that did not involve hand-editing a DERIVED file.

    AND THAT IS WHY IT IS A HELPER RATHER THAN A HAND EDIT. `shelf/_catalog.md` is rendered from
    `docs/templates/shelf-catalog-header.md` plus each `shelf/<slug>/_catalog-entry.md`, under the
    shelf render lock. A hand edit to the catalog is overwritten by the next render, and a hand-made
    entry file that names the wrong slug would list one Book twice. `New-ShelfCatalogEntryText`
    appends the Path line itself, so an entry composed here cannot name another Book.

    NO BOOK LOCK, DELIBERATELY, AND THE REASON IS NOT "IT IS SAFE". `Publish-BookCopy.ps1` carries
    the same comment for the same create: `shelf.writers-route-manifests` requires that any helper
    locking a Shelf Book also open a manifest mutation window, and a helper that creates an EMPTY
    Book has no page content to describe and no manifest handling to open one from. Taking the lock
    would trade a directory race for an invariant it would be breaking. There is nothing to race
    with regardless -- the Book does not exist yet, and the catalog it joins is committed inside the
    render lock below.

    A NEW BOOK HAS NO DISCOVERY MANIFEST, and that is the same state every Book created by
    `Publish-BookCopy.ps1` starts in. It is repaired by the manifest backfill rather than by this
    helper, which is the route `shelf.manifest-backfill` exists to prove.

    IT APPLIES DIRECTLY. The write provably cannot lose text: it refuses when the Book root exists,
    refuses when the catalog already lists the slug, and only ever creates. `-Preflight` reports what
    it would create for a reader who wants to see it first, exactly as the Shelf destination of
    `Publish-BookCopy.ps1` does, and neither needs a confirmation.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')
. (Join-Path $PSScriptRoot 'ShelfCatalog.ps1')
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')

# -cmatch, not -match: the slug schema is lowercase-only and the case-insensitive default would
# admit 'Reports', whose directory then does not match the one every reader resolves.
if ($Slug -cnotmatch '^[a-z0-9][a-z0-9-]*$') {
    throw "Book slug '$Slug' is malformed. A slug is lowercase letters, digits and hyphens, starting with a letter or a digit."
}
if ([string]::IsNullOrWhiteSpace($Title)) { throw 'Title is required.' }
if ([string]::IsNullOrWhiteSpace($Summary)) { throw 'Summary is required: it is what the catalog shows a reader deciding whether to open this Book.' }

# STEP 20: THE WORKSPACE IS SELECTED, NOT ASSUMED. `Split-Path -Parent $PSScriptRoot` answered
# "which workspace" with "one level above my own code", which is right only while the program and
# the workspace are the same directory. Order: -WorkspacePath, then LIBRARY_WORKSPACE, then the
# nearest `.library/workspace.json` above the working directory, then this program's own root --
# and that last one only while the program really is a workspace, which is what keeps an un-split
# checkout working and stops an installed package inventing one. tools/WorkspaceRegistry.ps1.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
$WorkspacePath = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

$shelfRoot = Join-Path $workspace 'shelf'
$bookRoot = Join-Path $shelfRoot $Slug
$bookWiki = Join-Path $bookRoot 'wiki'
$notesPath = Join-Path $bookWiki 'notes'
$entryPath = Get-ShelfCatalogEntryPath -Workspace $workspace -Slug $Slug

# ONE COLLISION CHECK, TWO MESSAGES. The first draft had a second guard for "a catalog entry with no
# Book under it", and it was unreachable: an entry file lives at shelf/<slug>/_catalog-entry.md, so
# its directory exists whenever it does and the root check below always fires first. A guard no
# input can reach is not a safeguard, it is a claim the suite cannot falsify -- so the husk case is
# a MESSAGE on the reachable guard instead, because the repair a reader needs really is different.
if (Test-Path -LiteralPath $bookRoot) {
    $hasWiki = Test-Path -LiteralPath $bookWiki -PathType Container
    if ($hasWiki) {
        throw "Shelf Book 'shelf/$Slug' already exists. Choose another slug, or add to that Book directly."
    }
    throw ("shelf/$Slug exists but has no wiki/, so it is a husk rather than a Book -- creating one here would adopt whatever " +
           "catalog entry it carries. Remove shelf/$Slug if nothing needs it, then re-render with " +
           'tools/ShelfCatalog.ps1 -Render -WorkspacePath . (see docs/derived-indexes.md).')
}

$kindLine = if ($Capture) { '- **Kind:** capture' } else { '' }
$originLine = if ([string]::IsNullOrWhiteSpace($Origin)) { "created $([DateTimeOffset]::UtcNow.ToString('yyyy-MM-dd'))" } else { $Origin.Trim() }

$plan = [ordered]@{
    operation      = 'Create a Shelf Book'
    slug           = $Slug
    title          = $Title.Trim()
    book_root      = "shelf/$Slug"
    kind           = if ($Capture) { 'capture' } else { 'curated' }
    catalog_entry  = "shelf/$Slug/_catalog-entry.md"
    planned_paths  = @("shelf/$Slug/wiki/_book.md", "shelf/$Slug/wiki/_index.md") + @(if ($Capture) { "shelf/$Slug/wiki/notes/" })
    confirmation_required = $false
    shared_library_write  = $false
    scope          = 'Creates one local Shelf Book and re-renders shelf/_catalog.md. No shared-collection write, and no existing file is read or replaced.'
}
if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json; return }

# A capture Book's limits say what a capture page IS, because that is the one thing a reader opening
# one needs to know before reading a page in it: nothing here has been checked since it was written.
$limits = if ($Capture) {
    'Pages in this Book are captures, appended by Add-ShelfNote.ps1 and unchecked since they were written. Read one as a claim to verify, never as a finding.'
} else {
    'This Book preserves local working knowledge. Refresh its source when current information matters.'
}
$bookPage = @(
    "# $($Title.Trim())"
    ''
    "- **Type:** Local Book"
    "- **Kind:** $(if ($Capture) { 'capture' } else { 'curated' })"
    "- **Origin:** $originLine"
    "- **Limits:** $limits"
    ''
    '## Purpose'
    ''
    $Summary.Trim()
    ''
    '## Reader map'
    ''
    '- [[_index|Open the reader map]]'
) -join "`n"

New-Item -ItemType Directory -Path $bookWiki -Force | Out-Null
try {
    Write-Utf8 (Join-Path $bookWiki '_book.md') ($bookPage + "`n")

    if ($Capture) {
        # The notes directory is created here rather than left to the first capture, so that
        # Get-CaptureBooks -- which skips a slug whose wiki/ is absent -- and the Desk overview both
        # see the Book from the moment it exists rather than from its first note.
        New-Item -ItemType Directory -Path $notesPath -Force | Out-Null
        # GENERATED, NOT HAND-WRITTEN. The same function every capture regenerates it with, so an
        # empty Book's map is byte-identical to what the first Add-ShelfNote would have produced.
        Update-ShelfNoteIndex -Book ([pscustomobject]@{
            title = $Title.Trim(); wiki_path = $bookWiki; notes_path = $notesPath
        }) | Out-Null
    }
    else {
        Write-Utf8 (Join-Path $bookWiki '_index.md') "# $($Title.Trim()) - Reader Map`n`n- [[_book|Book metadata and limits]]`n"
    }

    # Composed outside the render lock, committed inside it together with the catalog it produces.
    $entryText = New-ShelfCatalogEntryText -Slug $Slug -Title $Title.Trim() -Line @(
        "- **Summary:** $($Summary.Trim())"
        $(if (-not [string]::IsNullOrWhiteSpace($Topics)) { "- **Topics:** $($Topics.Trim())" })
        $kindLine
        "- **Origin:** $originLine"
    )
    $render = Invoke-ShelfCatalogRender -Workspace $workspace -WriteEntry @(
        @{ path = $entryPath; text = $entryText }
    ) -TimeoutSeconds $LockTimeoutSeconds
}
catch {
    # The Book is removed rather than left half-made: a directory with no catalog entry is exactly
    # the drift shelf.catalog-renders-from-entries refuses to render past, and this helper created
    # every byte of it, so there is nothing of the reader's to preserve.
    if (Test-Path -LiteralPath $bookRoot) { Remove-Item -LiteralPath $bookRoot -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $entryPath -PathType Leaf) { Remove-Item -LiteralPath $entryPath -Force -ErrorAction SilentlyContinue }
    throw "The Shelf Book was not created, and nothing was left behind. $($_.Exception.Message)"
}

# READ BACK THROUGH THE CONSUMER, not through what was just written. Get-ShelfBook is the function
# every capture, every guard and the Desk overview resolves a Book with, so proving IT agrees is the
# only readback that means the Book is usable.
$verify = Get-ShelfBook -Workspace $workspace -Slug $Slug
if ($verify.title -cne $Title.Trim()) { throw "The Book was created but the catalog resolves its title as '$($verify.title)'." }
if ([bool]$verify.is_capture -ne [bool]$Capture) { throw "The Book was created but the catalog resolves is_capture as $($verify.is_capture)." }

$plan.status = 'created'
$plan.is_capture = [bool]$verify.is_capture
$plan.catalog_entry_count = $render.entry_count
$plan.reader_map = "shelf/$Slug/wiki/_index.md"
$plan.manifest = 'none yet: a new Book has no Discovery manifest until the backfill builds one.'
$plan.next = if ($Capture) {
    "Capture into it with tools/Add-ShelfNote.ps1 -BookSlug $Slug. It is closed by default; open it with tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug $Slug to read a page."
} else {
    "Add pages with tools/Add-ShelfBookPage.ps1, which needs the Book open: tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug $Slug."
}
Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
