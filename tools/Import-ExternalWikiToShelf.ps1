[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceWikiPath,
    [Parameter(Mandatory = $true)][string]$BookSlug,
    [Parameter(Mandatory = $true)][string]$BookTitle,
    [Parameter(Mandatory = $true)][string]$Summary,
    [string]$Topics = 'imported-wiki',
    [string]$WorkspacePath,
    [string[]]$IncludePage = @(),
    [string]$ApprovedPlanId,
    [switch]$UserConfirmed,
    [switch]$Preflight
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Hash-Text([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text)))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Hash-File([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
# The Shelf catalog is rendered from per-Book entry files under one lock; this helper used to append
# to it with Add-Content, which two imports could interleave. PLAN-multi-desk.md step 3.
. (Join-Path $PSScriptRoot 'ShelfCatalog.ps1')
# For Get-ReaderMapLabel alone. Sourced BEFORE this file's own helpers so that every name this file
# defines for itself still wins -- adding an import must not quietly re-point Write-Utf8 or Hash-Text
# at another file's version of the same idea.
. (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')

function Write-Utf8([string]$Path, [string]$Content) { [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false)) }
function Test-IsWithin([string]$Child, [string]$Parent) {
    $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    [IO.Path]::GetFullPath($Child).StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)
}
function Resolve-LocalLink([string]$SourceFile, [string]$RawTarget, [string]$WikiRoot) {
    $target = $RawTarget.Trim().Split('|')[0].Split('#')[0].Trim()
    if ([string]::IsNullOrWhiteSpace($target) -or $target -match ':' -or $target.StartsWith('#')) { return $null }
    try {
        $candidates = @(Join-Path (Split-Path -Parent $SourceFile) $target; Join-Path $WikiRoot $target)
        foreach ($candidate in $candidates) {
            $withExtension = if ([IO.Path]::GetExtension($candidate)) { $candidate } else { "$candidate.md" }
            $full = [IO.Path]::GetFullPath($withExtension)
            if ((Test-IsWithin $full $WikiRoot) -and (Test-Path -LiteralPath $full -PathType Leaf)) { return $full }
        }
    } catch { return $null }
    return $null
}
function Assert-SelectedLinks($Files, [hashtable]$Selected, [string]$WikiRoot) {
    foreach ($file in $Files) {
        $text = [IO.File]::ReadAllText($file.FullName, [Text.UTF8Encoding]::new($false, $true))
        $targets = @([regex]::Matches($text, '\[\[([^\]]+)\]\]') | ForEach-Object { $_.Groups[1].Value }) + @([regex]::Matches($text, '(?<!\!)\[[^\]]+\]\(([^)]+)\)') | ForEach-Object { $_.Groups[1].Value })
        foreach ($target in $targets) {
            $resolved = Resolve-LocalLink $file.FullName $target $WikiRoot
            if ($null -ne $resolved -and -not $Selected.ContainsKey($resolved)) { throw "Selected page '$($file.FullName)' links to omitted page '$resolved'. Include it in this Book, or keep the source as one Book." }
        }
    }
}

# STEP 20: THE WORKSPACE IS SELECTED, NOT ASSUMED. `Split-Path -Parent $PSScriptRoot` answered
# "which workspace" with "one level above my own code", which is right only while the program and
# the workspace are the same directory. Order: -WorkspacePath, then LIBRARY_WORKSPACE, then the
# nearest `.library/workspace.json` above the working directory, then this program's own root --
# and that last one only while the program really is a workspace, which is what keeps an un-split
# checkout working and stops an installed package inventing one. tools/WorkspaceRegistry.ps1.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
$WorkspacePath = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
# -cnotmatch, not -notmatch: PowerShell's -notmatch is case-insensitive, so 'My-Book' satisfies this
# lowercase-only rule and travels on as a Book root. See docs/capture-book-model.md.
if ($BookSlug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'BookSlug must use lowercase letters, digits, and single hyphens.' }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$sourceRoot = (Resolve-Path -LiteralPath $SourceWikiPath).Path
if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw "SourceWikiPath is not a folder: $SourceWikiPath" }
$sourceFiles = @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse | Where-Object { $_.Extension -eq '.md' } | Sort-Object FullName)
if ($sourceFiles.Count -eq 0) { throw "No Markdown files were found in $sourceRoot" }

$selected = @{}
if ($IncludePage.Count) {
    foreach ($page in $IncludePage) {
        $relative = $page.Trim().TrimStart('\', '/').Replace('/', '\')
        if ($relative -notmatch '\.md$') { throw "IncludePage '$page' must name a Markdown file relative to SourceWikiPath." }
        $candidate = [IO.Path]::GetFullPath((Join-Path $sourceRoot $relative))
        if (-not (Test-IsWithin $candidate $sourceRoot) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "IncludePage '$page' is not an exact Markdown file below SourceWikiPath." }
        if ($selected.ContainsKey($candidate)) { throw "IncludePage '$page' was listed more than once." }
        $selected[$candidate] = $true
    }
    $sourceFiles = @($sourceFiles | Where-Object { $selected.ContainsKey($_.FullName) })
    if ($sourceFiles.Count -ne $selected.Count) { throw 'IncludePage did not resolve to the selected source files.' }
    Assert-SelectedLinks $sourceFiles $selected $sourceRoot
} else {
    foreach ($file in $sourceFiles) { $selected[$file.FullName] = $true }
}

$relativePaths = @($sourceFiles | ForEach-Object { $_.FullName.Substring($sourceRoot.Length).TrimStart('\', '/').Replace('\', '/') })
if (@($relativePaths | Where-Object { $_ -in @('_book.md', '_index.md') }).Count) { throw 'The source wiki has a root _book.md or _index.md, which would collide with Library metadata. Rename that source file before migration.' }
$sourceManifest = @($sourceFiles | ForEach-Object { [pscustomobject]@{ path = $_.FullName.Substring($sourceRoot.Length).TrimStart('\', '/').Replace('\', '/'); sha256 = Hash-File $_.FullName } })
# $relativePaths and $sourceFiles are one list in one order, so the index carries each label back to
# the file it was read from. The label is the page's first H1 rather than its path: see
# Get-ReaderMapLabel. This runs before the manifest digest below, so changing it changes plan_id --
# which is correct, since an approval made against filename labels was an approval of other bytes.
$mapLinks = @('- [[_book|Book metadata and limits]]') + @(for ($i = 0; $i -lt $relativePaths.Count; $i++) {
    $relative = $relativePaths[$i]
    $pageTitle = Get-ReaderMapLabel ([IO.File]::ReadAllText($sourceFiles[$i].FullName)) $relative
    "- [[$($relative.Substring(0, $relative.Length - 3))|$pageTitle]]"
})
$bookRoot = "shelf/$BookSlug/wiki"
$rootBody = "# $BookTitle`n`n- **Type:** Imported local copy`n- **Source:** External wiki ``$([IO.Path]::GetFileName($sourceRoot))``.`n- **Limits:** This Book preserves the imported wiki. Refresh from current source material when details may have changed.`n`n## Purpose`n`n$Summary`n`n## Reader map`n`n- [[_index|Open the reader map]]`n"
$indexBody = "# $BookTitle - Reader Map`n`n$($mapLinks -join "`n")`n"
$records = @([pscustomobject]@{ path = '_book.md'; sha256 = Hash-Text $rootBody }, [pscustomobject]@{ path = '_index.md'; sha256 = Hash-Text $indexBody }) + $sourceManifest
$manifestDigest = Hash-Text (($records | ForEach-Object { "$($_.path)|$($_.sha256)" }) -join "`n")
$planId = "external-wiki-$manifestDigest"
$plan = [pscustomobject]@{
    operation = 'Import external wiki to Shelf'; source_wiki = $sourceRoot; source_file_count = $sourceFiles.Count
    book_slug = $BookSlug; book_title = $BookTitle; topics = $Topics; planned_book_path = $bookRoot
    selected_pages = $relativePaths; page_manifest_sha256 = $manifestDigest; plan_id = $planId
    confirmation_required = $true; local_original_preserved = $true; shared_library_write = $false
}
$shelfRoot = Join-Path $workspace 'shelf'
$destinationRoot = Join-Path $shelfRoot $BookSlug
# Checked before the preflight returns, not only at execution. A conflict knowable at validation time
# must not be issued a plan_id: approving an import that is certain to fail wastes the reader's one
# approval and produces a partial-looking outcome for a reason nobody was shown.
if (Test-Path -LiteralPath $destinationRoot) { throw "Shelf Book already exists: shelf/$BookSlug. The importer will not overwrite it." }

if ($Preflight) { $plan; return }
if (-not $UserConfirmed) { throw 'The Shelf import is not yet performed: review the preflight and rerun with -UserConfirmed.' }
if ($ApprovedPlanId -cne $planId) { throw 'The Shelf import is not yet performed: rerun the current preflight and pass its exact plan_id as ApprovedPlanId.' }

$stagingRoot = Join-Path $shelfRoot ".migration-$BookSlug-$manifestDigest"
if (Test-Path -LiteralPath $stagingRoot) { throw "A prior staging folder exists: $stagingRoot. Inspect it before retrying." }
$stagingWiki = Join-Path $stagingRoot 'wiki'
New-Item -ItemType Directory -Path $stagingWiki -Force | Out-Null
try {
    Write-Utf8 (Join-Path $stagingWiki '_book.md') $rootBody
    Write-Utf8 (Join-Path $stagingWiki '_index.md') $indexBody
    for ($i = 0; $i -lt $sourceFiles.Count; $i++) {
        $target = Join-Path $stagingWiki $relativePaths[$i]
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        [IO.File]::Copy($sourceFiles[$i].FullName, $target, $false)
        if ((Hash-File $target) -ne $sourceManifest[$i].sha256) { throw "Copy verification failed for $($relativePaths[$i])." }
    }
    if ((Hash-File (Join-Path $stagingWiki '_book.md')) -ne $records[0].sha256 -or (Hash-File (Join-Path $stagingWiki '_index.md')) -ne $records[1].sha256) { throw 'Generated Book metadata did not verify.' }
    Move-Item -LiteralPath $stagingRoot -Destination $destinationRoot -ErrorAction Stop
    # Composed outside the render lock; committed inside it, together with the catalog it produces.
    $entryText = New-ShelfCatalogEntryText -Slug $BookSlug -Title $BookTitle -Line @(
        "- **Summary:** $Summary",
        "- **Topics:** $Topics",
        "- **Origin:** imported from external wiki ($([IO.Path]::GetFileName($sourceRoot)))"
    )
    Invoke-ShelfCatalogRender -Workspace $workspace -WriteEntry @(
        @{ path = (Get-ShelfCatalogEntryPath -Workspace $workspace -Slug $BookSlug); text = $entryText }
    ) | Out-Null
} catch {
    throw "Shelf import stopped. The source wiki was not changed. Inspect the exact staging folder before retrying: $stagingRoot. $($_.Exception.Message)"
}

[pscustomobject]@{ operation = 'Import external wiki to Shelf'; book_path = $bookRoot; reader_map = "$bookRoot/_index.md"; copied_pages = $relativePaths; page_manifest_sha256 = $manifestDigest; local_original_preserved = $true; shared_library_write = $false }
