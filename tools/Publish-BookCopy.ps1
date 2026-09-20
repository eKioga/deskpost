[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Shelf', 'Shared')][string]$Destination,
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$BookSlug,
    [Parameter(Mandatory = $true)][string]$BookTitle,
    [Parameter(Mandatory = $true)][string]$Summary,
    [string]$Topics = 'local-notes',
    [string]$WorkspacePath,
    [string[]]$IncludePage = @(),
    [switch]$FromShelf,
    [ValidateSet('Projects', 'Reference', 'Workflows')][string]$Collection,
    [string]$ProjectId,
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [Alias('CandidateVersion')][string]$BookVersion = '0.1.0',
    [switch]$ReplaceExisting,
    [string]$JournalPath,
    [string]$ApprovedPlanId,
    [switch]$UserConfirmed,
    [switch]$Preflight
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Resolve-LocalSourceRoot, and the Desk gate it asserts for a capture-Book note.
. (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')
# The Shelf catalog is rendered from per-Book entry files under one lock; this helper used to append
# to it with Add-Content, which two publishes could interleave. PLAN-multi-desk.md step 3.
. (Join-Path $PSScriptRoot 'ShelfCatalog.ps1')

if ($Destination -eq 'Shared') {
    & (Join-Path $PSScriptRoot 'Publish-SharedBookCandidate.ps1') @PSBoundParameters
    return
}

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
# -cnotmatch, not -notmatch: PowerShell's -notmatch is case-insensitive, so 'My-Book' satisfies this
# lowercase-only rule and travels on as a Book root. See docs/capture-book-model.md.
if ($BookSlug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'BookSlug must use lowercase letters, digits, and single hyphens.' }
if ([string]::IsNullOrWhiteSpace($BookTitle) -or [string]::IsNullOrWhiteSpace($Summary)) { throw 'BookTitle and Summary are required.' }

function Write-Utf8([string]$Path, [string]$Content) {
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}
function Test-IsWithin([string]$Child, [string]$Parent) {
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    [IO.Path]::GetFullPath($Child).StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)
}

$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
# Two permitted roots since 2026-08-28: notebook/, and one note under a capture Book's wiki/notes/
# so a Holding Shelf finding can become a local Book without detouring through the Notebook. The
# resolver owns the rule and asserts the Desk gate for the capture-Book case; see ShelfNoteCommon.
$sourceRootInfo = Resolve-LocalSourceRoot -Workspace $workspace -SourcePath $SourcePath
$wikiRoot = $sourceRootInfo.root
if (-not (Test-Path -LiteralPath $wikiRoot -PathType Container)) { throw "Source root not found: $wikiRoot" }
$sourceFull = [IO.Path]::GetFullPath((Join-Path $workspace $SourcePath))
if (-not (Test-IsWithin -Child $sourceFull -Parent $wikiRoot)) { throw "SourcePath must name one local file or folder inside $($sourceRootInfo.label_root)/." }
if (-not (Test-Path -LiteralPath $sourceFull)) { throw "SourcePath was not found: $SourcePath" }

$sourceItem = Get-Item -LiteralPath $sourceFull -Force
$sourceFiles = @(
    if ($sourceItem.PSIsContainer) {
        Get-ChildItem -LiteralPath $sourceFull -File -Recurse | Where-Object { $_.Extension -eq '.md' } | Sort-Object FullName
    } else {
        if ($sourceItem.Extension -ne '.md') { throw 'A single Book source must be a Markdown article.' }
        $sourceItem
    }
)
if ($sourceFiles.Count -eq 0) { throw 'The selected local source contains no Markdown articles.' }

$sourceRelative = $sourceFull.Substring($wikiRoot.Length).TrimStart('\', '/').Replace('\', '/')
# The provenance label follows the root that matched, so a Book copied from a Holding Shelf note
# records where it actually came from rather than a notebook/ path nothing was ever read from.
$sourceLabel = "$($sourceRootInfo.label_root)/$sourceRelative"
$sourceName = if ($sourceItem.PSIsContainer) { $sourceItem.Name } else { [IO.Path]::GetFileNameWithoutExtension($sourceItem.Name) }
$bookPagePaths = @($sourceFiles | ForEach-Object {
    if ($sourceItem.PSIsContainer) {
        "$sourceName/$($_.FullName.Substring($sourceFull.Length).TrimStart('\', '/').Replace('\', '/'))"
    } else { $_.Name }
})
$plannedPages = @('_book.md', '_index.md') + $bookPagePaths
$plan = [pscustomobject]@{
    operation = 'Publish a Copy'; destination = 'shelf'; source = $sourceLabel
    source_file_count = $sourceFiles.Count; local_original_preserved = $true
    book_slug = $BookSlug; book_title = $BookTitle; planned_book_pages = $plannedPages
    local_shelf_path = "shelf/$BookSlug/wiki"; confirmation_required = $false; shared_library_write = $false
}
if ($Preflight) { $plan; return }

$bookRoot = Join-Path (Join-Path $workspace 'shelf') $BookSlug
$bookWiki = Join-Path $bookRoot 'wiki'
# $bookPagePaths and $sourceFiles are one list in one order -- the former is a projection of the
# latter, built above -- so the index carries each label back to the file it was read from. The label
# is the page's own first H1, which is what the Discovery manifest already calls it; before this it
# was the page PATH, so every map read as a file listing while Discovery knew the titles.
$mapLinks = @('- [[_book|Book metadata and limits]]') + @(for ($i = 0; $i -lt $bookPagePaths.Count; $i++) {
    $pagePath = $bookPagePaths[$i]
    $pageTitle = Get-ReaderMapLabel ([IO.File]::ReadAllText($sourceFiles[$i].FullName)) $pagePath
    "- [[$($pagePath.Substring(0, $pagePath.Length - 3))|$pageTitle]]"
})
$root = "# $BookTitle`n`n- **Type:** Local copy`n- **Version:** $BookVersion`n- **Source:** Copy of local ``$sourceLabel```n- **Limits:** This Book preserves local working knowledge. Refresh its source when current information matters.`n`n## Purpose`n`n$Summary`n`n## Reader map`n`n- [[_index|Open the reader map]]`n"
$index = "# $BookTitle - Reader Map`n`n$($mapLinks -join "`n")`n"

# NO BOOK LOCK HERE, DELIBERATELY. The obvious reading of "hold Book then shelf render" would put
# one around this create, and it cannot: shelf.writers-route-manifests requires that any helper
# locking a Shelf Book also opens a manifest mutation window, and this helper has no manifest
# handling to open one from. Taking the lock would trade a directory race it has always had for an
# invariant it would be breaking. The catalog race PLAN-multi-desk.md step 3 names is closed by the
# render lock below regardless -- there is no shared file for two publishes to interleave in any
# more, because each writes only its own Book's entry.
if (Test-Path -LiteralPath $bookRoot) { throw "Local Shelf Book already exists: shelf/$BookSlug. Choose a new name or update it directly." }
New-Item -ItemType Directory -Path $bookWiki -Force | Out-Null
try {
    Write-Utf8 (Join-Path $bookWiki '_book.md') $root
    Write-Utf8 (Join-Path $bookWiki '_index.md') $index
    for ($i = 0; $i -lt $sourceFiles.Count; $i++) {
        $target = Join-Path $bookWiki $bookPagePaths[$i]
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        [IO.File]::Copy($sourceFiles[$i].FullName, $target, $false)
    }
    # Composed outside the render lock; committed inside it, together with the catalog it produces.
    # The composer appends the Path line itself, so this entry cannot name another Book.
    $entryText = New-ShelfCatalogEntryText -Slug $BookSlug -Title $BookTitle -Line @(
        "- **Summary:** $Summary",
        "- **Topics:** $Topics",
        "- **Origin:** copied from local ``$sourceLabel``"
    )
    Invoke-ShelfCatalogRender -Workspace $workspace -WriteEntry @(
        @{ path = (Get-ShelfCatalogEntryPath -Workspace $workspace -Slug $BookSlug); text = $entryText }
    ) | Out-Null
} catch {
    throw "Local Shelf Book could not be completed. The $($sourceRootInfo.label_root) source was preserved. $($_.Exception.Message)"
}

[pscustomobject]@{ operation = 'Publish a Copy'; destination = 'shelf'; book_path = "shelf/$BookSlug/wiki"; reader_map = "shelf/$BookSlug/wiki/_index.md"; copied_pages = $plannedPages; local_original_preserved = $true; shared_library_write = $false }
