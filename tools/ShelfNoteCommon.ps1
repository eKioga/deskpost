# Shared helpers for Shelf Books: catalog lookup, the Desk gate, and reader-map generation, plus
# the frontmatter handling that only capture Books use.
#
# A capture Book is an ordinary Shelf Book whose catalog entry carries `- **Kind:** capture`.
# Its pages live under wiki/notes/ and each one opens with a flat frontmatter block:
#
#     ---
#     captured: 2026-08-16T13:45:00Z
#     review: pending
#     from_seat: library-dev
#     session_id: 9f4f22e5-d6c1-4368-a09a-c6210503394e
#     source_project: library-dev
#     source_paths: raw/foo/bar.md; raw/foo/baz.md
#     tags: godot, rendering
#     ---
#
# `from_seat` and `session_id` are PROVENANCE and are resolved by the writer, never passed in: a
# seat one agent could type would let it file under another's name. Both are ABSENT rather than
# empty when a seatless session captures, because capture must keep working with no seat at all.
# `session_id` names a conversation; it does not license reading that conversation's transcript --
# see docs/cross-seat-reports.md, *Why the transcript is not read*.
#
# Dot-source this file. It defines functions only and performs no action on load.

Set-StrictMode -Version Latest

# Book roots and the archive's shape belong to the schema, not to this file. Needed here because an
# ARCHIVED Shelf Book is described by the same catalog-entry grammar while living somewhere else.
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')

function Write-Utf8([string]$Path, [string]$Content) {
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

# Returns an OrderedDictionary of the flat key: value pairs in the leading frontmatter block,
# or $null when the file does not open with one.
function Get-NoteFrontmatter([string]$Path) {
    $lines = @(Get-Content -LiteralPath $Path)
    if ($lines.Count -lt 2 -or $lines[0].Trim() -cne '---') { return $null }
    $fields = [ordered]@{}
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -ceq '---') { return $fields }
        $match = [regex]::Match($lines[$i], '^([a-z_]+):\s*(.*)$')
        if ($match.Success) { $fields[$match.Groups[1].Value] = $match.Groups[2].Value.Trim() }
    }
    $null
}

function Get-FrontmatterValue($Fields, [string]$Key, [string]$Default = '') {
    if ($null -ne $Fields -and $Fields.Contains($Key) -and -not [string]::IsNullOrWhiteSpace([string]$Fields[$Key])) { return [string]$Fields[$Key] }
    $Default
}

# Finds the Shelf catalog entry for one slug, whatever kind of Book it is. The catalog is the only
# authority for a Book's title and for whether it accepts captures: no slug is special-cased in code,
# so a reader can retire or add a capture Book by editing shelf/_catalog.md.
function Get-ShelfBook([string]$Workspace, [string]$Slug) {
    # -cnotmatch: -notmatch would accept 'Holding' here and refuse it later as an unlisted Book,
    # which is the wrong reason. The slug rule is the accurate one.
    if ($Slug -cnotmatch '^[a-z0-9][a-z0-9-]*$') { throw 'Book slug must contain only lowercase letters, digits, and hyphens.' }
    $catalogPath = Join-Path $Workspace 'shelf/_catalog.md'
    if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw 'This workspace has no local Shelf catalog.' }
    $catalog = [IO.File]::ReadAllText($catalogPath)
    $sections = @([regex]::Matches($catalog, '(?ms)^##\s+(.+?)\s*\r?\n(.*?)(?=^##\s+|\z)'))
    $pathPattern = '(?m)^\s*-\s+\*\*Path:\*\*\s+shelf/' + [regex]::Escape($Slug) + '\s*$'
    $matched = @($sections | Where-Object { [regex]::IsMatch($_.Groups[2].Value, $pathPattern) })
    if ($matched.Count -eq 0) { throw "No Shelf Book '$Slug' is listed in shelf/_catalog.md." }
    if ($matched.Count -ne 1) { throw "Shelf catalog lists 'shelf/$Slug' more than once; repair the catalog before writing to it." }
    ConvertFrom-ShelfCatalogEntry -Workspace $Workspace -Slug $Slug -Title $matched[0].Groups[1].Value `
        -Body $matched[0].Groups[2].Value -BookRoot "shelf/$Slug"
}

function ConvertFrom-ShelfCatalogEntry {
    <#
    .SYNOPSIS
        One catalog entry's heading and body turned into a Book object. The single definition of what
        the entry's fields MEAN.

    .DESCRIPTION
        Split out when the archives entered search. An archived Shelf Book keeps its catalog entry
        verbatim inside `_archived.json` -- that is the whole point of storing it -- so the archive
        needs exactly this grammar against exactly these fields. A second copy there would be the
        codebase's most-repeated defect: two definitions of one rule, drifting silently, where the
        only symptom is an archived Book whose topics or capture flag disagree with its active self.

        The Book's root is passed in rather than composed, so the wiki path comes from the schema and
        an archived Book resolves to shelf/_archive/<slug>/wiki without this function knowing that
        shape exists.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Slug,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Title,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Body,
        [Parameter(Mandatory = $true)][string]$BookRoot
    )
    $wikiPath = [IO.Path]::GetFullPath((Join-Path $Workspace (Split-BookRoot $BookRoot).wiki_root))
    # Summary and Topics are read as items, not as lines: a catalog summary wraps, and family 3 is
    # the defect this codebase keeps re-learning. Continuation lines are indented, so take everything
    # up to the next bullet or the end of the entry.
    $summaryMatch = [regex]::Match($Body, '(?ms)^\s*-\s+\*\*Summary:\*\*\s+(.*?)(?=^\s*-\s+\*\*|\z)')
    $topicsMatch = [regex]::Match($Body, '(?ms)^\s*-\s+\*\*Topics:\*\*\s+(.*?)(?=^\s*-\s+\*\*|\z)')
    [pscustomobject]@{
        slug       = $Slug
        title      = $Title.Trim()
        book_root  = $BookRoot
        wiki_path  = $wikiPath
        notes_path = Join-Path $wikiPath 'notes'
        is_capture = [regex]::IsMatch($Body, '(?m)^\s*-\s+\*\*Kind:\*\*\s+capture\s*$')
        summary    = if ($summaryMatch.Success) { ($summaryMatch.Groups[1].Value -replace '\s+', ' ').Trim() } else { '' }
        topics     = @(if ($topicsMatch.Success) { ($topicsMatch.Groups[1].Value -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } })
    }
}

function Get-ArchivedShelfBook([string]$Workspace, [string]$Slug) {
    <#
    .SYNOPSIS
        The same Book object for an ARCHIVED Shelf Book, read from the record the archiver stored.

    .DESCRIPTION
        An archived Book is absent from shelf/_catalog.md by design -- removing that entry is what
        archiving IS -- so Get-ShelfBook refuses it, and refuses it with a repair ("check
        shelf/_catalog.md lists this Book") that would be wrong to follow. Its metadata lives in
        `_archived.json`, whose `catalog_entry` field holds the reader's own entry verbatim.
    #>
    if ($Slug -cnotmatch '^[a-z0-9][a-z0-9-]*$') { throw 'Book slug must contain only lowercase letters, digits, and hyphens.' }
    $root = New-BookRoot -Location Shelf -Shelf Archive -Slug $Slug
    $recordPath = Join-Path $Workspace (Join-Path "shelf/_archive/$Slug" '_archived.json')
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) {
        throw "No archived Shelf Book '$Slug' is recorded at shelf/_archive/$Slug/_archived.json."
    }
    $record = $null
    try { $record = [IO.File]::ReadAllText($recordPath) | ConvertFrom-Json }
    catch { throw "The archive record for '$Slug' is not readable JSON: $($_.Exception.Message)" }
    # Enumerated rather than read off .Properties.Name, which throws on an empty member collection
    # under Set-StrictMode -- family 4.
    $fields = @($record.PSObject.Properties | ForEach-Object { $_.Name })
    if ($fields -cnotcontains 'catalog_entry') {
        throw "The archive record for '$Slug' carries no catalog_entry, so its title and topics cannot be recovered."
    }
    $entry = [string]$record.catalog_entry
    # The stored entry is a whole catalog block: a `## Title` heading and the bullets beneath it.
    $match = [regex]::Match($entry, '(?ms)^##\s+(.+?)\s*\r?\n(.*)\z')
    $title = if ($match.Success) { $match.Groups[1].Value } elseif ($fields -ccontains 'title') { [string]$record.title } else { $Slug }
    $body = if ($match.Success) { $match.Groups[2].Value } else { $entry }
    $book = ConvertFrom-ShelfCatalogEntry -Workspace $Workspace -Slug $Slug -Title $title -Body $body -BookRoot $root
    $archivedOn = if ($fields -ccontains 'archived_on') { [string]$record.archived_on } else { '' }
    $book | Add-Member -NotePropertyName archived_on -NotePropertyValue $archivedOn -PassThru
}

function Get-ArchivedShelfBookSlugs([string]$Workspace) {
    <#
    .SYNOPSIS
        Every archived Shelf Book on disk. This is the ARCHIVE'S ROSTER, and it needs no roster file.

    .DESCRIPTION
        The active Shelf has shelf/_catalog.md and the shared collection has a generated roster,
        because neither can be enumerated where the answer is needed -- one is the reader's own
        curated list, the other is behind MCP. The Shelf archive is neither: it is a local directory,
        always readable offline, and each Book's own `_archived.json` is what makes it an archived
        Book rather than a stray folder. Deriving the roster is therefore strictly better than
        storing one, which could go stale against the directory it describes.
    #>
    $archiveRoot = Join-Path $Workspace 'shelf/_archive'
    if (-not (Test-Path -LiteralPath $archiveRoot -PathType Container)) { return @() }
    @(Get-ChildItem -LiteralPath $archiveRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -cmatch '^[a-z0-9][a-z0-9-]*$' -and (Test-Path -LiteralPath (Join-Path $_.FullName '_archived.json') -PathType Leaf) } |
        ForEach-Object { $_.Name } | Sort-Object)
}

function Get-CaptureBook([string]$Workspace, [string]$Slug) {
    $book = Get-ShelfBook -Workspace $Workspace -Slug $Slug
    if (-not $book.is_capture) {
        throw "Shelf Book '$Slug' is not capture-enabled. Only a Book whose catalog entry carries '- **Kind:** capture' accepts notes."
    }
    if (-not (Test-Path -LiteralPath $book.wiki_path -PathType Container)) { throw "Capture Book '$Slug' has no pages directory at shelf/$Slug/wiki." }
    $book
}

# The Desk gate. Capture is deliberately ungated because it writes unvetted material into a
# disposable Book; everything that names or curates an individual page requires the reader to have
# opened the Book, which is what ADR-0001 substitutes for the Kind: capture protection.
function Assert-ShelfBookOpen([string]$Workspace, [string]$Slug, [string]$Action = 'writing to it', [string]$Seat) {
    $openBooksPath = Get-DeskFilePath -StateDirectory (Join-Path $Workspace '.claude') -Seat $Seat -Kind 'books'
    if (-not (Test-Path -LiteralPath $openBooksPath -PathType Leaf)) { throw 'Virtual Desk configuration is missing .open-books.' }
    $openBooks = @(Get-DeskFileEntries -Path $openBooksPath)
    if ("shelf/$Slug" -cnotin $openBooks) {
        # AN ARCHIVED SHELF BOOK IS READ-ONLY, said here rather than left to be inferred. The
        # refusal itself already held the day the archive shipped, because shelf/_archive/<slug>
        # never equals shelf/<slug> -- but it held by accident of string comparison, and it told a
        # reader the Book was "closed" when the Book was open and merely retired, sending them to
        # re-open something already open. Archiving retires a Book; a write that silently un-retired
        # one would make the archive a place material rots rather than rests, so the remedy named
        # here is Restore rather than Open.
        if ("shelf/_archive/$Slug" -cin $openBooks) {
            throw "Shelf Book '$Slug' is archived and read-only. Restore it with tools/Archive-ShelfBook.ps1 -Action Restore -BookSlug $Slug before $Action."
        }
        throw "Shelf Book '$Slug' is closed. Open it with tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug $Slug before $Action."
    }
}

# Publish-BookCopy and Import-ExternalWikiToShelf generate the identical reader map: one H1, then one
# link per page. A map still in that shape regenerates from disk without losing anything.
#
# A map a reader has curated does not, and this is not hypothetical: shelf/library-dev's map carries
# sections and a paragraph of annotation per link, so regenerating it would have destroyed real
# work. Regeneration is what keeps a map from drifting, but "cannot lose text" is the stronger
# promise, so a curated map is appended to instead and the drift is reported rather than enforced.
function Test-GeneratedReaderMap([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $true }
    foreach ($line in @(Get-Content -LiteralPath $Path)) {
        $trimmed = $line.Trim()
        if (-not $trimmed) { continue }
        if ($trimmed -cmatch '^#\s') { continue }
        if ($trimmed -cmatch '^-\s+\[\[[^\]]+\]\]\s*$') { continue }
        return $false
    }
    $true
}

# Regenerated from the pages on disk rather than appended to, so the map can never drift from what
# the Book actually holds. The link shape matches both publishers exactly.
function Update-ShelfBookIndex($Book) {
    $wiki = $Book.wiki_path
    # The FileInfo is kept rather than projected straight to a path, because the label now comes from
    # each page's own first H1 and that needs the file, not its name.
    $pageFiles = @(Get-ChildItem -LiteralPath $wiki -File -Recurse -Filter '*.md' |
        Sort-Object FullName |
        Where-Object { $_.FullName.Substring($wiki.Length).TrimStart('\', '/').Replace('\', '/') -cnotin @('_book.md', '_index.md') })
    $pages = @($pageFiles | ForEach-Object { $_.FullName.Substring($wiki.Length).TrimStart('\', '/').Replace('\', '/') })
    $links = @('- [[_book|Book metadata and limits]]') + @($pageFiles | ForEach-Object {
        $relative = $_.FullName.Substring($wiki.Length).TrimStart('\', '/').Replace('\', '/')
        $pageTitle = Get-ReaderMapLabel ([IO.File]::ReadAllText($_.FullName)) $relative
        "- [[$($relative.Substring(0, $relative.Length - 3))|$pageTitle]]"
    })
    Write-Utf8 (Join-Path $wiki '_index.md') ("# $($Book.title) - Reader Map`n`n" + ($links -join "`n") + "`n")
    [pscustomobject]@{ page_count = $pages.Count }
}

# Every page on disk that no reader-map link reaches. A regenerated map always returns none; a
# curated one can drift, and reporting that is what replaces the guarantee regeneration would give.
#
# One hop through any topic index the root map links, because a Book may reach its pages
# hierarchically: shelf/library-dev's root map names two topic indexes and nothing else, so a flat
# check reported 27 of its 31 pages as unlisted and would have called a deliberate structure drift.
function Get-UnlistedBookPages($Book) {
    $wiki = $Book.wiki_path
    $mapPath = Join-Path $wiki '_index.md'
    if (-not (Test-Path -LiteralPath $mapPath -PathType Leaf)) { return @() }

    $text = [IO.File]::ReadAllText($mapPath)
    $reachable = [Collections.Generic.List[string]]::new()
    [void]$reachable.Add($text)
    $seen = @{}
    foreach ($hit in @([regex]::Matches($text, '\[\[([^\]|]+)'))) {
        $target = $hit.Groups[1].Value.Trim()
        # -cnotmatch: these page paths are lowercase by rule, and the case-insensitive default would
        # also match a hand-written [[Working-Practices/_Index]] that names no file on disk.
        if ($target -cnotmatch '(?:^|/)_index$' -or $seen.ContainsKey($target)) { continue }
        $seen[$target] = $true
        $indexPath = Join-Path $wiki "$target.md"
        if (Test-Path -LiteralPath $indexPath -PathType Leaf) { [void]$reachable.Add([IO.File]::ReadAllText($indexPath)) }
    }
    $all = ($reachable -join "`n")

    @(Get-ChildItem -LiteralPath $wiki -File -Recurse -Filter '*.md' |
        Sort-Object FullName |
        ForEach-Object { $_.FullName.Substring($wiki.Length).TrimStart('\', '/').Replace('\', '/') } |
        Where-Object { $_ -cnotin @('_book.md', '_index.md') } |
        Where-Object { -not $all.Contains("[[$($_.Substring(0, $_.Length - 3))") })
}

# Adds one link to a curated reader map without touching a character of what is already there. It
# lands at the end, which may not be where the link belongs -- the preflight says so, and a link in
# the wrong section is recoverable in a way a flattened map is not.
function Add-ShelfBookIndexLink($Book, [string]$Page, [string]$Label) {
    $mapPath = Join-Path $Book.wiki_path '_index.md'
    $pageTitle = if ([string]::IsNullOrWhiteSpace($Label)) { $Page } else { $Label.Trim() }
    $link = "- [[$Page|$pageTitle]]"
    if (-not (Test-Path -LiteralPath $mapPath -PathType Leaf)) {
        Write-Utf8 $mapPath ("# $($Book.title) - Reader Map`n`n" + $link + "`n")
        return [pscustomobject]@{ appended = $true }
    }
    $text = [IO.File]::ReadAllText($mapPath)
    # THE TARGET IS THE IDENTITY, NOT THE RENDERED LINE. Every curated map written before labels
    # became titles carries `- [[<page>|<page>.md]]`, so comparing the whole link would fail to
    # recognise a page that IS already listed and would append a second link to it. That is this
    # change's own day-one data: the maps on disk predate it. The delimiter is required so `intro`
    # does not match a line naming `introduction`.
    if ($text.Contains("[[$Page|") -or $text.Contains("[[$Page]]")) { return [pscustomobject]@{ appended = $false } }
    $lineEnding = if ($text.EndsWith("`r`n", [StringComparison]::Ordinal)) { "`r`n" } else { "`n" }
    $content = [regex]::Replace($text, '(?:\r?\n[ \t]*)+\z', '')
    $lastLine = [regex]::Match($content, '(?m)^[^\r\n]*\z').Value
    $separator = if ([string]::IsNullOrEmpty($content)) { $lineEnding }
        elseif ($lastLine -cmatch '^[ \t]*-') { $lineEnding }
        else { $lineEnding + $lineEnding }
    Write-Utf8 $mapPath ($content + $separator + $link + $lineEnding)
    [pscustomobject]@{ appended = $true }
}

# A page path is a Book-relative location, never a filesystem path: no drive, no traversal, no
# absolute form. Each segment follows the same lowercase rule as every other Library slug, so a page
# added today is reachable by the same name on a case-sensitive filesystem tomorrow.
function ConvertTo-BookPagePath([string]$Raw) {
    $candidate = $Raw.Trim().Replace('\', '/').Trim('/')
    if ([string]::IsNullOrWhiteSpace($candidate)) { throw 'PagePath is required, for example rendering/shaders.' }
    if ($candidate.EndsWith('.md')) { $candidate = $candidate.Substring(0, $candidate.Length - 3) }
    $segments = @($candidate.Split('/'))
    # Reserved names are checked first so they are refused for the accurate reason. They also fail
    # the slug rule below, and being told '_index is not lowercase' would be true and useless.
    if ($segments[-1] -cin @('_book', '_index')) { throw 'PagePath must not name the Book metadata page or the reader map.' }
    foreach ($segment in $segments) {
        # -cnotmatch: -notmatch is case-insensitive, so this lowercase-only rule would accept
        # 'Rendering' and create a second folder Windows silently merges and Linux does not.
        if ($segment -cnotmatch '^[a-z0-9][a-z0-9-]*$') {
            throw "PagePath segment '$segment' must contain only lowercase letters, digits, and hyphens."
        }
    }
    ($segments -join '/')
}

# The exact bytes a Shelf Book page write will store, and the title it will carry. Shared rather than
# reimplemented because the topic writer's idempotency test -- "this page is already here and
# identical, so that entry is done" -- is only true if it compares against what a single-page write
# would actually produce. Comparing against the raw source instead would call every page divergent.
function ConvertTo-ShelfPageBody([string]$Body, [string]$Title) {
    $normalized = $Body.TrimEnd()
    $heading = [regex]::Match($normalized, '(?m)\A#\s+(.+?)\s*$')
    $keepsOwn = $heading.Success -and [regex]::IsMatch($heading.Groups[1].Value, '[a-zA-Z0-9]')
    if (-not $keepsOwn -and [string]::IsNullOrWhiteSpace($Title)) {
        throw 'The body has no leading H1, so -Title is required to give the page a heading.'
    }
    $pageTitle = if ($keepsOwn) { $heading.Groups[1].Value.Trim() } else { $Title.Trim() }
    [pscustomobject]@{
        title        = $pageTitle
        title_source = if ($keepsOwn) { 'body H1' } else { '-Title' }
        body         = if ($keepsOwn) { $normalized + "`n" } else { "# $pageTitle`n`n" + $normalized + "`n" }
    }
}

# Must equal BookManifest.ps1's $script:ManifestMaxTextLength. Not imported from there: see the
# load-order note below. books.reader-map-label-matches-manifest-title asserts the two agree.
$script:ReaderMapLabelMaxLength = 300

# What a reader map calls a page: its first H1, which is exactly what the Discovery manifest stores
# as that page's title. The two surfaces answered the same question differently for every Book ever
# published -- Discovery said `page-title: jellyfin -- Jellyfin` while the reader map said
# `jellyfin.md` -- because five separate writers each labelled the link with the page PATH. The map
# is the route every reader takes into a Book, so it was the one surface reading as a file listing.
#
# THE RULE IS DUPLICATED DELIBERATELY, AND THE DUPLICATION IS PINNED BY A CHECK. The manifest derives
# its title through Get-MarkdownHeadings in BookManifest.ps1, which dot-sources THIS file -- so
# calling it from here would resolve at call time against whatever the entry point happened to load,
# and Add-ShelfBookPage reaches the map writers below with only ShelfNoteCommon loaded. A function
# that exists on some paths and not others is worse than a second copy of a small rule. So the rule
# lives here in full, and `books.reader-map-label-matches-manifest-title` runs both implementations
# over one fixture corpus and fails if they ever disagree.
#
# ONE DIVERGENCE IS ACCEPTED AND BOUNDED: the manifest stops after $ManifestMaxHeadingsPerPage (200)
# headings, so a page carrying 200 headings before its first H1 would have an empty manifest title
# and a real label here. That page does not exist and the check pins the boundary rather than the
# behaviour.
#
# A page with no H1 falls back to its path with the extension removed. The manifest stores '' for
# that case, which is right for a search index and wrong for a link -- an empty label renders as
# nothing for a reader to click.
function Get-ReaderMapLabel([string]$Text, [string]$Path) {
    $body = [regex]::Replace([string]$Text, '(?s)\A﻿?---\r?\n.*?\r?\n---[ \t]*(?:\r?\n|\z)', '')
    $fenced = $false
    foreach ($line in @($body.Replace("`r`n", "`n").Split("`n"))) {
        # A '# heading' inside a fenced block is code, not a title. Same fence rule as the manifest.
        if ($line -cmatch '^[ \t]{0,3}(?:`{3,}|~{3,})') { $fenced = -not $fenced; continue }
        if ($fenced) { continue }
        # Exactly one '#': '## Foo' is not an H1, and the manifest's first-level-1 pick skips it too.
        if ($line -cmatch '^[ \t]{0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$') {
            $title = [regex]::Replace($Matches[1].Normalize([Text.NormalizationForm]::FormC), '[\p{Cc}\p{Cf}]', ' ')
            $title = [regex]::Replace($title, '\s+', ' ').Trim()
            if ($title.Length -gt $script:ReaderMapLabelMaxLength) {
                $title = $title.Substring(0, $script:ReaderMapLabelMaxLength).TrimEnd() + '...'
            }
            if ($title.Length) { return $title }
        }
    }
    $fallback = [regex]::Replace([string]$Path, '\.md$', '')
    if ([string]::IsNullOrWhiteSpace($fallback)) { return [string]$Path }
    $fallback
}
# Lists every capture-enabled Book in the catalog without throwing when there are none. Used by the
# Desk overview, which must stay a read-only orientation helper.
function Get-CaptureBooks([string]$Workspace) {
    $catalogPath = Join-Path $Workspace 'shelf/_catalog.md'
    if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { return @() }
    $catalog = [IO.File]::ReadAllText($catalogPath)
    $sections = @([regex]::Matches($catalog, '(?ms)^##\s+(.+?)\s*\r?\n(.*?)(?=^##\s+|\z)'))
    $books = @()
    foreach ($section in $sections) {
        $body = $section.Groups[2].Value
        if (-not [regex]::IsMatch($body, '(?m)^\s*-\s+\*\*Kind:\*\*\s+capture\s*$')) { continue }
        $pathMatch = [regex]::Match($body, '(?m)^\s*-\s+\*\*Path:\*\*\s+shelf/([a-z0-9][a-z0-9-]*)\s*$')
        if (-not $pathMatch.Success) { continue }
        $slug = $pathMatch.Groups[1].Value
        $wikiPath = Join-Path $Workspace (Join-Path 'shelf' (Join-Path $slug 'wiki'))
        if (-not (Test-Path -LiteralPath $wikiPath -PathType Container)) { continue }
        $books += [pscustomobject]@{
            slug       = $slug
            title      = $section.Groups[1].Value.Trim()
            book_root  = "shelf/$slug"
            wiki_path  = $wikiPath
            notes_path = Join-Path $wikiPath 'notes'
        }
    }
    @($books | Sort-Object slug)
}

# Reads every note's frontmatter and title. Bodies are never returned, so a caller that only wants
# counts never handles page content.
function Get-ShelfNotes($Book) {
    if (-not (Test-Path -LiteralPath $Book.notes_path -PathType Container)) { return @() }
    @(Get-ChildItem -LiteralPath $Book.notes_path -File -Filter '*.md' | Sort-Object Name | ForEach-Object {
        $fields = Get-NoteFrontmatter -Path $_.FullName
        $content = [IO.File]::ReadAllText($_.FullName)
        $titleMatch = [regex]::Match($content, '(?m)^#\s+(.+?)\s*$')
        [pscustomobject]@{
            file           = $_.Name
            page           = "notes/$([IO.Path]::GetFileNameWithoutExtension($_.Name))"
            full_path      = $_.FullName
            title          = if ($titleMatch.Success) { $titleMatch.Groups[1].Value.Trim() } else { [IO.Path]::GetFileNameWithoutExtension($_.Name) }
            captured       = Get-FrontmatterValue -Fields $fields -Key 'captured' -Default 'unknown'
            review         = Get-FrontmatterValue -Fields $fields -Key 'review' -Default 'pending'
            tags           = Get-FrontmatterValue -Fields $fields -Key 'tags'
            source_project = Get-FrontmatterValue -Fields $fields -Key 'source_project'
            source_paths   = Get-FrontmatterValue -Fields $fields -Key 'source_paths'
            # Empty for every note captured before these existed, and for every seatless capture.
            # Both are the same fact -- nothing recorded one -- and neither is backfilled.
            from_seat      = Get-FrontmatterValue -Fields $fields -Key 'from_seat'
            session_id     = Get-FrontmatterValue -Fields $fields -Key 'session_id'
        }
    })
}

# The reader map is regenerated from the notes on disk rather than appended to, so it can never
# drift from what the Book actually holds.
function Update-ShelfNoteIndex($Book) {
    $notes = @(Get-ShelfNotes -Book $Book)
    $pending = @($notes | Where-Object { $_.review -cne 'done' } | Sort-Object captured -Descending)
    $reviewed = @($notes | Where-Object { $_.review -ceq 'done' } | Sort-Object captured -Descending)
    $lines = @("# $($Book.title) - Reader Map", '', '- [[_book|Book metadata and limits]]', '', '## Pending review', '')
    if ($pending.Count) { foreach ($note in $pending) { $lines += "- [[$($note.page)|$($note.title)]] - captured $($note.captured)" } }
    else { $lines += '- Nothing is waiting for review.' }
    $lines += @('', '## Reviewed', '')
    if ($reviewed.Count) { foreach ($note in $reviewed) { $lines += "- [[$($note.page)|$($note.title)]] - captured $($note.captured)" } }
    else { $lines += '- No note has been reviewed yet.' }
    Write-Utf8 (Join-Path $Book.wiki_path '_index.md') (($lines -join "`n") + "`n")
    [pscustomobject]@{ pending_count = $pending.Count; reviewed_count = $reviewed.Count; total_count = $notes.Count }
}

function Test-PathWithin([string]$Child, [string]$Parent) {
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    [IO.Path]::GetFullPath($Child).StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)
}

# A note's leading frontmatter block, separated from its body.
#
# Publish-SharedBookCandidate has always done this for every page it publishes, because a capture
# note's frontmatter is provenance metadata rather than prose and a shared Book page carrying a raw
# `---` block reads as a horizontal rule. Shared here so the Project copy and the triage layer split
# at exactly the same byte: three independent splitters of one format is how a page ends up with its
# heading below its metadata on one route and above it on another.
function Split-NoteFrontmatter([string]$Content) {
    $normalized = $Content.Replace("`r`n", "`n")
    if (-not $normalized.StartsWith("---`n", [StringComparison]::Ordinal)) {
        return [pscustomobject]@{ has_frontmatter = $false; frontmatter = ''; body = $Content }
    }
    $closing = $normalized.IndexOf("`n---`n", 4, [StringComparison]::Ordinal)
    if ($closing -lt 0) { return [pscustomobject]@{ has_frontmatter = $false; frontmatter = ''; body = $Content } }
    $bodyStart = $closing + 5
    [pscustomobject]@{
        has_frontmatter = $true
        frontmatter     = $normalized.Substring(0, $bodyStart)
        body            = $normalized.Substring($bodyStart).Trim("`r", "`n")
    }
}

# Which local root a publisher's or Project copy's SourcePath belongs to, and the label its
# provenance records should carry.
#
# TWO ROOTS, AND ONLY TWO. `notebook/` is the ordinary one. A capture Book's `wiki/notes/` was added
# on 2026-08-28 so triage can send a Holding Shelf note straight to a Project Hub or a new shared
# Book, instead of detouring through the volatile Notebook -- the cycle fork A set out to close.
# Nothing else under `shelf/` qualifies: a curated Book's pages are finished work with their own
# publication route (-FromShelf), and whether a Book accepts captures is read from the catalog
# through Get-CaptureBook rather than special-cased by slug here.
#
# THE DESK GATE IS ASSERTED HERE, where the read happens, rather than left to each caller. Naming an
# individual note is a read of that Book, and a resolver that returned the path without the gate
# would hand every caller a way around it -- which is precisely how an asymmetry spread across two
# helpers gets flattened.
function Resolve-LocalSourceRoot([string]$Workspace, [string]$SourcePath) {
    if ([string]::IsNullOrWhiteSpace($SourcePath)) { throw 'SourcePath is required.' }
    $full = [IO.Path]::GetFullPath((Join-Path $Workspace $SourcePath))
    $notebookRoot = [IO.Path]::GetFullPath((Join-Path $Workspace 'notebook')).TrimEnd('\', '/')
    if (Test-PathWithin $full $notebookRoot) {
        return [pscustomobject]@{ kind = 'notebook'; root = $notebookRoot; label_root = 'notebook'; book_slug = '' }
    }
    $shelfRoot = [IO.Path]::GetFullPath((Join-Path $Workspace 'shelf')).TrimEnd('\', '/')
    if (Test-PathWithin $full $shelfRoot) {
        $relative = $full.Substring($shelfRoot.Length).TrimStart('\', '/').Replace('\', '/')
        # -cmatch: the path segments are lowercase by rule, and the case-insensitive default would
        # accept 'shelf/Holding/wiki/notes/x.md' and then fail to find the catalog entry.
        if ($relative -cmatch '^([a-z0-9][a-z0-9-]*)/wiki/notes/[^/]+\.md$') {
            $slug = $Matches[1]
            $book = Get-CaptureBook -Workspace $Workspace -Slug $slug
            Assert-ShelfBookOpen -Workspace $Workspace -Slug $slug -Action 'publishing one of its notes'
            return [pscustomobject]@{
                kind = 'capture-note'
                root = [IO.Path]::GetFullPath($book.notes_path).TrimEnd('\', '/')
                label_root = "shelf/$slug/wiki/notes"
                book_slug = $slug
            }
        }
        throw "SourcePath '$SourcePath' is under shelf/ but is not one note in a capture Book. Only 'shelf/<capture-book>/wiki/notes/<file>.md' can be published directly; a curated Shelf Book is published whole with -FromShelf."
    }
    throw "SourcePath '$SourcePath' must name a file or folder inside notebook/, or one note under a capture Book's wiki/notes/."
}

function ConvertTo-NoteSlug([string]$Title) {
    $slug = [regex]::Replace($Title.ToLowerInvariant(), '[^a-z0-9]+', '-').Trim('-')
    if ($slug.Length -gt 60) { $slug = $slug.Substring(0, 60).Trim('-') }
    if ([string]::IsNullOrWhiteSpace($slug)) { throw 'Title must contain at least one letter or digit.' }
    $slug
}
