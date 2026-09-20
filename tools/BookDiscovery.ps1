<#
.SYNOPSIS
    Discovery: query the closed-readable Book manifests and answer WHERE a match lives, never what
    it says. Dot-sourced; never invoked directly.

.DESCRIPTION
    Plan item 2.2, sixth rung, under ADR-0002. The five rungs below it exist so that this one can
    answer a question about a closed Book without reading it: rung 1 generates a manifest, rung 2
    stores it behind a read path that refuses anything half-written, rung 3 puts the whole
    generation under the Book's own lock, rung 4 makes every writer go through that window, and
    rung 5 put a committed manifest on every Book of this Shelf. Discovery reads those manifests,
    joins internal/overlap-records.json, and returns Book slug, page path, matched heading, and
    overlap status.

    IT READS NO CLOSED BOOK'S BODY, EVER. A manifest is catalog-class material, exactly as
    shelf/_catalog.md is, and the manifest is the only thing a closed Book contributes. There is one
    body-reading path in this file and it is gated: an OPEN capture Book, whose page metadata is
    deliberately absent from closed-readable storage, is extracted live from disk at query time.

    NEVER BODY TEXT. A hit carries a Book slug, a canonical page path that feeds
    read_open_book_page directly, the heading that matched, and the overlap status of the Book it
    came from. The permitted field set is declared once, in $script:DiscoveryHitFields, and the
    suite asserts every hit against it -- so a later rung that adds an excerpt field fails a leak
    canary rather than shipping.

    A BOOK THAT CANNOT BE READ IS REPORTED, NOT DROPPED. Get-StoredBookManifest classifies a store
    as ok, missing, dirty, incomplete, or corrupt and throws for none of them, precisely so a bulk
    query can carry on. Discovery lists every Book that is not ok under books_unavailable with its
    status, its reason, and its repair. The failure this prevents is the quiet one: a query run
    while a Book is mid-write would otherwise return less and look complete.

    THE STORE IS THE ONLY AUTHORITY ON FRESHNESS. Discovery does not re-classify a store, does not
    look for a dirty marker of its own, and does not fall back to the newest generation on disk. A
    second classifier would be a second parser of the same state, which is the drift this codebase
    has already paid for elsewhere; instead the refusal lives in one place and Discovery is proved
    to have no path around it.

    BOTH COLLECTIONS, AND THE ANSWER SAYS WHICH. Rung 7 gave the shared collection manifests too, so
    Discovery now spans the Shelf and the shared collection -- offline, from local stores, with no
    path from this file to the NAS. Coverage is computed from what actually happened rather than from
    the fact that a shared loop ran: with no roster the shared collection is honestly out of scope,
    with an unreadable shared Book the answer says PARTIAL and names it, and only when every rostered
    Book was searched does it claim the collection. A partial answer that does not admit it is
    partial is the failure mode worth more than the missing half.

    A HEADING IS NOT A CLAIM. ADR-0002's standing constraint: a Discovery hit licenses "shall I open
    it?" and never an answer about what the page says. Nothing in this file can enforce that; it is
    named here because the output is what tempts it.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'BookManifest.ps1')
. (Join-Path $PSScriptRoot 'BookManifestStore.ps1')
. (Join-Path $PSScriptRoot 'SearchBoundaries.ps1')

$script:BookDiscoverySchema = 1

# Boundaries per plan item 2.5. The stored side was already normalised, flattened, sanitised, and
# capped at generation, so these cover the query side and the size of the answer only.
#
# Rung 6 declared these three here because 2.3 did not exist yet. 2.3 pulled 2.5 forward into
# tools/SearchBoundaries.ps1 so all three tiers share ONE set rather than reconciling three later,
# and these names now point there. The VALUES are unchanged, which is what book-discovery.selftest
# proves: moving a cap must not move an answer.

$script:DiscoverySharedNoteNone = 'No shared-collection manifests are present, so this answer covers the local Shelf only -- run tools/Update-SharedBookManifests.ps1 to bring the shared collection into scope.'
$script:DiscoveryRepairHint = 'run tools/Update-BookManifests.ps1 to repair this Book''s manifest'
$script:DiscoverySharedRepairHint = 'run tools/Update-SharedBookManifests.ps1 to repair this shared Book''s manifest'
# THE ARCHIVES ARE COVERED AND LABELLED (ADR-0012). Archiving used to remove a Book from Discovery
# outright, which made the archive a place material was forgotten rather than rested -- and worse,
# the answer went on claiming it had searched every Book. These repair hints exist because an
# archived Book's manifest is repaired by a DIFFERENT helper from its active twin's.
$script:DiscoveryShelfArchiveRepairHint = 'run tools/Update-BookManifests.ps1 -IncludeArchive to repair this archived Book''s manifest'
$script:DiscoverySharedArchiveRepairHint = 'run tools/Update-SharedBookManifests.ps1 -IncludeArchive to repair this archived shared Book''s manifest'
# A HINT IS ONLY HONEST IF IT CAN BE FOLLOWED. Both of these named the state and no remedy while the
# shared half was unbuilt -- pointing at a flag no helper accepted is the dead-end repair instruction
# this codebase found in the currency roll-up on 2026-09-06. Update-SharedBookManifests.ps1 gained a
# real -IncludeArchive on 2026-09-08, so both now name it, and the roster it writes is what turns
# this note off. An absent roster still means NOT COVERED rather than an empty archive: the shared
# archive is behind MCP, so this file never learns of a Book it has no roster for (ADR-0012).
$script:DiscoverySharedArchiveNoteNone = 'the shared collection''s archive is NOT covered by this answer -- run tools/Update-SharedBookManifests.ps1 -IncludeArchive to generate its Discovery manifests'
# The schema's own suffix, not a second spelling of it: this file builds two roster keys from it, and
# a literal 'shelf-archive' here would be a hand-written copy of what ConvertTo-BookManifestCollection
# already decides. desk.book-root-schema fails on a list of collection names outside the schema.
$script:DiscoveryArchiveSuffix = (ConvertTo-BookManifestCollection -Collection 'shelf' -Shelf 'archive').Substring('shelf'.Length)

# The complete set of fields a hit may carry, declared once so the leak canary has something to
# compare against. Adding a field here is a deliberate act; adding one to a hit is caught.
$script:DiscoveryHitFields = @('book', 'book_root', 'book_title', 'book_kind', 'book_open', 'book_shelf', 'collection', 'page', 'heading', 'match_field', 'overlap')

# Deterministic ordering. Book-level matches come before page-level ones because they orient: a
# Book whose summary matches is a Book to consider opening, whatever its pages say.
$script:DiscoveryFieldRank = @{
    'book-title'   = 0
    'topic'        = 1
    'book-summary' = 2
    'reader-map'   = 3
    'page-title'   = 4
    'heading'      = 5
}

# --- Query normalisation --------------------------------------------------------------------------

# The same normalise-flatten-sanitise order ConvertTo-ManifestText applies at generation, plus a
# case fold. Both sides therefore reach the comparison having had the same thing done to them,
# which is what makes an ordinal comparison correct rather than merely fast.
function ConvertTo-DiscoveryComparable([string]$Value) { ConvertTo-SearchComparable $Value }

# Sanitised for display: normalised and flattened like the stored side, but with the reader's own
# capitalisation intact. Control characters never survive, because this string is echoed back.
function ConvertTo-DiscoveryDisplay([string]$Value) { ConvertTo-SearchDisplay $Value }

# Literal, case-insensitive containment. Regex opt-in belongs to item 2.5 and is deliberately not
# offered here: a query is reader-supplied text, and an unbounded pattern over 743 pages is the
# wall-clock cap 2.5 has to design rather than something this rung should improvise.
function Test-DiscoveryMatch([string]$Haystack, [string]$ComparableNeedle) { Test-SearchContains $Haystack $ComparableNeedle }

# --- The overlap join -----------------------------------------------------------------------------

# ADR-0002: "metadata becomes load-bearing, so Book summaries and the canonical/superseded marks are
# now part of the retrieval surface rather than decoration." A record names two Books, and the same
# record reads differently from each side -- canonical from one is superseded from the other.
function Format-DiscoveryOverlap([string]$Slug, $Record) {
    $topic = [string]$Record.topic
    $relationship = [string]$Record.relationship
    $resolution = [string]$Record.resolution
    if ($Slug -ceq [string]$Record.book) {
        $other = [string]$Record.counterpart
        if ($relationship -ceq 'canonical') { return "canonical for '$topic' over $other (resolution: $resolution)" }
        if ($relationship -ceq 'complementary') { return "complementary with $other on '$topic' (resolution: $resolution)" }
        if ($relationship -ceq 'unverified') { return "unverified overlap with $other on '$topic' (resolution: $resolution)" }
        return "$relationship overlap with $other on '$topic' (resolution: $resolution)"
    }
    $other = [string]$Record.book
    if ($relationship -ceq 'canonical') { return "superseded for '$topic' by $other (resolution: $resolution)" }
    if ($relationship -ceq 'complementary') { return "complementary with $other on '$topic' (resolution: $resolution)" }
    if ($relationship -ceq 'unverified') { return "unverified overlap with $other on '$topic' (resolution: $resolution)" }
    return "$relationship overlap with $other on '$topic' (resolution: $resolution)"
}

# An unreadable or malformed record file must not take the query down: an overlap mark is an
# annotation on an answer, and losing the annotation is not losing the answer. A record missing a
# required field is skipped rather than rendered half-formed -- Set-TopicOverlap.ps1 -Action Validate
# is what reports that, and shelf.overlap-records runs it on every commit.
function Get-DiscoveryOverlapIndex([string]$Workspace) {
    $index = @{}
    $path = Join-Path $Workspace 'internal/overlap-records.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $index }
    $data = $null
    try { $data = [IO.File]::ReadAllText($path) | ConvertFrom-Json } catch { return $index }
    if ($null -eq $data) { return $index }
    # Enumerated rather than read as .Properties.Name: an empty member collection throws under
    # Set-StrictMode when read as an aggregate instead of yielding nothing.
    $fields = @($data.PSObject.Properties | ForEach-Object { $_.Name })
    if ($fields -cnotcontains 'records') { return $index }

    foreach ($record in @($data.records)) {
        if ($null -eq $record) { continue }
        $recordFields = @($record.PSObject.Properties | ForEach-Object { $_.Name })
        $complete = $true
        foreach ($required in @('topic', 'book', 'counterpart', 'relationship', 'resolution')) {
            if ($recordFields -cnotcontains $required) { $complete = $false }
        }
        if (-not $complete) { continue }
        foreach ($side in @([string]$record.book, [string]$record.counterpart)) {
            if ([string]::IsNullOrWhiteSpace($side)) { continue }
            if (-not $index.ContainsKey($side)) { $index[$side] = [Collections.Generic.List[string]]::new() }
            [void]$index[$side].Add((Format-DiscoveryOverlap $side $record))
        }
    }
    $index
}

function Get-DiscoveryOverlapStatus($Index, [string]$Slug) {
    if (-not $Index.ContainsKey($Slug)) { return $null }
    $marks = @($Index[$Slug])
    if (-not $marks.Count) { return $null }
    $marks -join '; '
}

# --- Which Books exist, and which are open --------------------------------------------------------

# The same section shape Get-ShelfBook matches, so both always agree about which slugs exist, and
# catalog order is preserved so a result set reads in the order the reader wrote the catalog.
function Get-DiscoveryCatalogSlugs([string]$CatalogText) {
    @([regex]::Matches($CatalogText, '(?m)^\s*-\s+\*\*Path:\*\*\s+shelf/([a-z0-9][a-z0-9-]*)\s*$') | ForEach-Object { $_.Groups[1].Value })
}

# A missing .open-books file reads as every Book closed, which is the fail-safe direction here for
# the same reason it is in Update-BookManifests: a Book we cannot prove is open is treated as one
# whose bodies must not be read.
function Get-DiscoveryOpenRoots([string]$DeskStateDirectory) { @(Get-SearchOpenBookRoots -DeskStateDirectory $DeskStateDirectory) }

# --- The one body-reading path, and its gate ------------------------------------------------------

# A capture Book's closed-readable manifest holds its summary and its counts and nothing else,
# because naming an individual note is reading it. ADR-0002 also says its pages join Discovery
# normally once the Book is OPEN -- and the store deliberately does not hold them, so the open path
# has to come from somewhere. It comes from disk, live, and nothing is written.
#
# Live rather than a second gated store, deliberately. A store would be derived state that no writer
# invalidates -- a capture Book's pages change on every Add-ShelfNote -- so it would need its own
# marker, generation, and commit machinery to answer a question the filesystem answers correctly for
# free. Reading at query time cannot be stale.
function Get-DiscoveryLivePages([string]$WikiRoot) {
    if (-not (Test-Path -LiteralPath $WikiRoot -PathType Container)) { return @() }
    $files = @(Get-BookPageFiles $WikiRoot)
    if ($files.Count -gt $script:ManifestMaxPagesPerBook) {
        $files = @($files | Select-Object -First $script:ManifestMaxPagesPerBook)
    }
    $pages = [Collections.Generic.List[object]]::new()
    foreach ($file in $files) {
        $headings = @(Get-MarkdownHeadings ([IO.File]::ReadAllText($file.FullName)))
        $firstH1 = @($headings | Where-Object { $_.level -eq 1 })
        [void]$pages.Add([pscustomobject]@{
                path     = ConvertTo-CanonicalPagePath $WikiRoot $file.FullName
                title    = if ($firstH1.Count) { $firstH1[0].text } else { '' }
                headings = $headings
            })
    }
    @($pages)
}

# --- The query ------------------------------------------------------------------------------------

# BookRoot rather than a collection and a shelf passed separately: it is ONE value the caller already
# holds, the schema takes it apart, and it is also what the reader needs in order to open the Book --
# `tools/Set-VirtualDesk.ps1 -Shelf Archive` is a different command from the active one, so a hit that
# named only a slug would send a reader to the wrong Book or to no Book at all.
function New-DiscoveryHit([string]$Slug, [string]$BookRoot, [string]$BookTitle, [string]$BookKind, [bool]$BookOpen, $Page, $Heading, [string]$MatchField, $Overlap) {
    $parts = Split-BookRoot $BookRoot
    [pscustomobject]@{
        book        = $Slug
        book_root   = $BookRoot
        book_title  = $BookTitle
        book_kind   = $BookKind
        book_open   = $BookOpen
        book_shelf  = $parts.shelf
        collection  = $parts.collection
        page        = $Page
        heading     = $Heading
        match_field = $MatchField
        overlap     = $Overlap
    }
}

function Get-DiscoveryBookHits {
    <#
    .SYNOPSIS
        Every hit one Book's manifest contributes for one already-normalised query.

    .DESCRIPTION
        Rung 7 pulled this out of the per-Book loop so the shared collection cannot acquire a second
        extraction with its own rules. Both collections reach it with a manifest the store called
        `ok`; what differs is only where that manifest came from.

    .PARAMETER LivePages
        Pages read live at query time, for the one case the closed-readable store deliberately does
        not cover: an OPEN capture Book. Only the local Shelf can supply them -- a shared Book has no
        filesystem to read -- so a shared capture Book contributes Book-level hits and stops there,
        exactly as a closed Shelf capture Book does.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Slug,
        [Parameter(Mandatory = $true)][string]$BookRoot,
        [Parameter(Mandatory = $true)][object]$Manifest,
        [Parameter(Mandatory = $true)][string]$Kind,
        [Parameter(Mandatory = $true)][bool]$IsOpen,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Needle,
        [object]$Overlap = $null,
        [object[]]$LivePages = @()
    )

    $bookHits = [Collections.Generic.List[object]]::new()

    if (Test-DiscoveryMatch $Manifest.title $Needle) {
        [void]$bookHits.Add((New-DiscoveryHit $Slug $BookRoot $Manifest.title $Kind $IsOpen $null $Manifest.title 'book-title' $Overlap))
    }
    foreach ($topic in @($Manifest.topics)) {
        if (Test-DiscoveryMatch $topic $Needle) {
            [void]$bookHits.Add((New-DiscoveryHit $Slug $BookRoot $Manifest.title $Kind $IsOpen $null ([string]$topic) 'topic' $Overlap))
        }
    }
    # The summary matched, and the summary is not returned: the Book Catalog is where the reader
    # reads it, and a hit only has to say which Book to consider.
    if (Test-DiscoveryMatch $Manifest.summary $Needle) {
        [void]$bookHits.Add((New-DiscoveryHit $Slug $BookRoot $Manifest.title $Kind $IsOpen $null $null 'book-summary' $Overlap))
    }

    # A capture Book's manifest holds no reader map and no pages. An open Shelf one is read live; a
    # closed one -- and any shared one -- contributes exactly what is above and stops here.
    $pages = @()
    if ($Kind -ceq 'capture') {
        $pages = @($LivePages)
    }
    else {
        $pages = @($Manifest.pages)
        if ($null -ne $Manifest.reader_map) {
            $pagePaths = @{}
            foreach ($page in $pages) { $pagePaths[[string]$page.path] = $true }
            # Only the map's LINKS are scanned here. Its headings are already covered, because
            # _index.md is a page of the Book like any other and the page scan below reads it --
            # reporting them twice would inflate one match into two results.
            foreach ($link in @($Manifest.reader_map.links)) {
                $target = [string]$link.target
                $label = [string]$link.label
                if (-not ((Test-DiscoveryMatch $target $Needle) -or (Test-DiscoveryMatch $label $Needle))) { continue }
                # Only a target the manifest also lists as a page becomes a page path. A reader map
                # can point at something that no longer exists, and handing the reader a path that
                # fails to open is worse than handing them the Book.
                $linkPage = if ($pagePaths.ContainsKey($target)) { $target } else { $null }
                $linkHeading = if ([string]::IsNullOrWhiteSpace($label)) { $target } else { $label }
                [void]$bookHits.Add((New-DiscoveryHit $Slug $BookRoot $Manifest.title $Kind $IsOpen $linkPage $linkHeading 'reader-map' $Overlap))
            }
        }
    }

    foreach ($page in $pages) {
        $pageTitle = [string]$page.title
        if (Test-DiscoveryMatch $pageTitle $Needle) {
            [void]$bookHits.Add((New-DiscoveryHit $Slug $BookRoot $Manifest.title $Kind $IsOpen ([string]$page.path) $pageTitle 'page-title' $Overlap))
        }
        foreach ($heading in @($page.headings)) {
            # The page title IS the first H1, so reporting both would be one match twice. The title
            # shape is the more useful of the two, and it is already emitted above.
            if (($heading.level -eq 1) -and ($pageTitle.Length -gt 0) -and ([string]$heading.text -ceq $pageTitle)) { continue }
            if (Test-DiscoveryMatch $heading.text $Needle) {
                [void]$bookHits.Add((New-DiscoveryHit $Slug $BookRoot $Manifest.title $Kind $IsOpen ([string]$page.path) ([string]$heading.text) 'heading' $Overlap))
            }
        }
    }

    @($bookHits)
}

# The shared collection's roster, written by tools/Update-SharedBookManifests.ps1 from books/README.
# Discovery runs offline and has no shared catalog of its own, so without this a shared Book whose
# store is missing would be INVISIBLE rather than unavailable -- the silent-partial answer this whole
# ladder exists to prevent. An unreadable or malformed roster reads as no roster at all, which puts
# the shared collection honestly out of scope rather than half in it.
function Get-DiscoverySharedRoster([string]$Workspace, [string]$ManifestCollection = 'shared') {
    $path = Join-Path $Workspace "internal/book-manifests/$ManifestCollection/_roster.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $roster = [IO.File]::ReadAllText($path) | ConvertFrom-Json
        $fields = @($roster.PSObject.Properties | ForEach-Object { $_.Name })
        if ($fields -cnotcontains 'books') { return $null }
        $slugs = @(@($roster.books) | ForEach-Object { [string]$_.slug } | Where-Object { $_ -cmatch '^[a-z0-9][a-z0-9-]*$' })
        if (-not $slugs.Count) { return $null }
        $asOf = ''
        if ($fields -ccontains 'generated_utc') { $asOf = ([string]$roster.generated_utc) }
        return [pscustomobject]@{ slugs = $slugs; as_of = $asOf }
    }
    catch { return $null }
}

function Find-BookPages {
    <#
    .SYNOPSIS
        Find where a term appears across both collections, from manifests only. Returns pointers,
        never page bodies.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Query,
        [int]$MaxResults = $script:SearchDefaultMaxResults,
        [string]$DeskStateDirectory,
        # Only consulted when no Desk directory is passed. A caller that already knows which
        # seat it is serving passes the resolved directory instead.
        [string]$Seat
    )

    $root = (Resolve-Path -LiteralPath $Workspace).Path
    # The DESK, which belongs to a seat, not the state directory that holds every seat. An
    # unresolvable seat throws here rather than defaulting, because there is no default seat.
    if ([string]::IsNullOrWhiteSpace($DeskStateDirectory)) {
        $DeskStateDirectory = Get-DeskStateDirectory -StateDirectory (Join-Path $root '.claude') -Seat $Seat
    }

    # 2.5's query and result-cap rules, taken from SearchBoundaries.ps1 rather than restated here.
    # Discovery predates that file and carried its own copy of both -- same constants, second
    # implementation, which is precisely the drift the shared file exists to prevent. The 2.5 audit
    # found it; the messages are the shared ones now.
    $needle = Assert-SearchQuery $Query
    $MaxResults = Resolve-SearchResultCap $MaxResults

    $catalogPath = Join-Path $root 'shelf/_catalog.md'
    if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw 'This workspace has no local Shelf catalog.' }
    $slugs = @(Get-DiscoveryCatalogSlugs ([IO.File]::ReadAllText($catalogPath)))

    $overlapIndex = Get-DiscoveryOverlapIndex -Workspace $root
    $openRoots = @(Get-DiscoveryOpenRoots -DeskStateDirectory $DeskStateDirectory)
    # @() around a $null yields a ONE-element array holding $null, not an empty one -- the defect
    # family this codebase already lints for, in its other direction. An absent roster must mean no
    # shared Books, never one Book with an empty slug.
    $sharedSlugs = @()
    $sharedRosterAsOf = ''
    $roster = Get-DiscoverySharedRoster $root
    if ($null -ne $roster) { $sharedSlugs = @($roster.slugs); $sharedRosterAsOf = [string]$roster.as_of }

    # The Shelf archive needs no roster file: it is a local directory, readable offline, and each
    # Book's own _archived.json is what makes it archived rather than a stray folder. The SHARED
    # archive does need one, for exactly the reason the active shared collection does -- it is behind
    # MCP and this file never reaches the network.
    $shelfArchiveSlugs = @(Get-ArchivedShelfBookSlugs -Workspace $root)
    $sharedArchiveSlugs = @()
    $sharedArchiveRosterAsOf = ''
    $archiveRoster = Get-DiscoverySharedRoster $root 'shared-archive'
    if ($null -ne $archiveRoster) { $sharedArchiveSlugs = @($archiveRoster.slugs); $sharedArchiveRosterAsOf = [string]$archiveRoster.as_of }

    $hits = [Collections.Generic.List[object]]::new()
    $unavailable = [Collections.Generic.List[object]]::new()
    $order = 0

    # ONE LOOP OVER EVERY COLLECTION, NOT ONE LOOP EACH. The Shelf and shared halves were already two
    # near-copies of the same body, and rung 7's note on Get-DiscoveryBookHits -- "so the shared
    # collection cannot acquire a second extraction with its own rules" -- is the same argument one
    # level up. Adding the archives as two more copies is how the labelled-archive answer would
    # quietly stop matching the active one.
    #
    # DRIVEN BY THE SCHEMA'S LIST, NOT BY ONE WRITTEN HERE. Get-BookManifestCollections decides which
    # collections exist and in what order -- both actives, then both archives, so active material
    # sorts ahead of retired material for the same reason Book-level hits sort ahead of page hits.
    # This is what makes a fifth collection reach Discovery by being added to the schema, instead of
    # being known to the store and invisible here. A collection with no entry below is a REFUSAL
    # rather than a silent omission, because a silently skipped collection is precisely the
    # complete-looking-but-partial answer this whole tier is built against.
    $rosters = @{}
    $rosters['shelf'] = [pscustomobject]@{ slugs = $slugs; repair = $script:DiscoveryRepairHint }
    $rosters['shared'] = [pscustomobject]@{ slugs = $sharedSlugs; repair = $script:DiscoverySharedRepairHint }
    $rosters["shelf$($script:DiscoveryArchiveSuffix)"] = [pscustomobject]@{ slugs = $shelfArchiveSlugs; repair = $script:DiscoveryShelfArchiveRepairHint }
    $rosters["shared$($script:DiscoveryArchiveSuffix)"] = [pscustomobject]@{ slugs = $sharedArchiveSlugs; repair = $script:DiscoverySharedArchiveRepairHint }

    $plans = @(Get-BookManifestCollections | ForEach-Object {
        if (-not $rosters.ContainsKey($_)) { throw "Discovery has no roster for the '$_' Book collection, so it cannot say whether that collection was searched." }
        [pscustomobject]@{ collection = $_; slugs = $rosters[$_].slugs; repair = $rosters[$_].repair }
    })

    $searchedByCollection = @{}
    foreach ($name in Get-BookManifestCollections) { $searchedByCollection[$name] = 0 }

    foreach ($plan in $plans) {
        $parts = Split-BookManifestCollection $plan.collection
        $isLocal = ($parts.collection -ceq 'shelf')
        foreach ($slug in @($plan.slugs)) {
            $order++
            $bookRoot = New-BookRootFromManifestCollection $plan.collection $slug
            $isOpen = ($bookRoot -cin $openRoots)
            $overlap = Get-DiscoveryOverlapStatus $overlapIndex $slug

            # A local Book's catalog metadata is reachable; a shared Book's is not, and nothing here
            # reads a shared Book's body -- there is no path from this file to the NAS at all. What a
            # shared Book contributes was decided when its manifest was generated, by the helper that
            # had the reader's approval to read it.
            #
            # RESOLVED INSIDE A TRY, WHICH IT WAS NOT BEFORE. Get-ShelfBook threw straight out of the
            # query for a slug the catalog could not resolve, taking the whole answer down. Naming the
            # Book and carrying on is what this file does for every other unreadable state, and a
            # malformed archive record is a state that can now exist.
            $book = $null
            $resolveFailure = ''
            if ($isLocal) {
                try {
                    $book = if ($parts.shelf -ceq 'archive') { Get-ArchivedShelfBook -Workspace $root -Slug $slug }
                            else { Get-ShelfBook -Workspace $root -Slug $slug }
                }
                catch { $resolveFailure = $_.Exception.Message }
            }

            # The store is the authority. Anything it does not call `ok` is named in the answer with
            # the reason it gave, and contributes nothing -- including a Book this query could
            # otherwise have read live, because "unavailable" is a statement about the Book and not
            # about one path to it.
            $stored = if ($resolveFailure) { $null } else { Get-StoredBookManifest -Workspace $root -Slug $slug -Collection $plan.collection }
            if ($resolveFailure -or ($stored.status -cne 'ok')) {
                [void]$unavailable.Add([pscustomobject]@{
                        book       = $slug
                        book_root  = $bookRoot
                        book_title = if ($null -ne $book) { $book.title } else { $slug }
                        collection = $parts.collection
                        book_shelf = $parts.shelf
                        book_open  = $isOpen
                        status     = if ($resolveFailure) { 'unresolvable' } else { $stored.status }
                        reason     = if ($resolveFailure) { $resolveFailure } else { $stored.reason }
                        repair     = $plan.repair
                    })
                continue
            }
            $searchedByCollection[$plan.collection]++
            $manifest = $stored.manifest

            # The union rule of rung 1, carried through to the query for reporting: either signal
            # saying capture is enough. It cannot widen disclosure here -- the live path below is
            # gated on the Book being open, not on its kind -- but a Book reported as curated while
            # its catalog calls it capture would be a lie in the answer. For a shared Book there is
            # only the stored signal; the union ran at generation, where both were reachable, and
            # re-deciding it here from less information could only ever widen disclosure.
            $kind = if (($manifest.kind -ceq 'capture') -or ($null -ne $book -and $book.is_capture)) { 'capture' } else { 'curated' }

            $livePages = @()
            if (($kind -ceq 'capture') -and $isOpen -and ($null -ne $book)) { $livePages = @(Get-DiscoveryLivePages $book.wiki_path) }

            foreach ($hit in @(Get-DiscoveryBookHits -Slug $slug -BookRoot $bookRoot -Manifest $manifest -Kind $kind -IsOpen $isOpen -Needle $needle -Overlap $overlap -LivePages $livePages)) {
                [void]$hits.Add([pscustomobject]@{ order = $order; rank = $script:DiscoveryFieldRank[$hit.match_field]; hit = $hit })
            }
        }
    }

    $shelfSearched = $searchedByCollection['shelf']
    $sharedSearched = $searchedByCollection['shared']
    $shelfArchiveSearched = $searchedByCollection['shelf-archive']
    $sharedArchiveSearched = $searchedByCollection['shared-archive']

    $sorted = @($hits | Sort-Object -Property `
        @{ Expression = { $_.order } }, `
        @{ Expression = { $_.rank } }, `
        @{ Expression = { [string]$_.hit.page } }, `
        @{ Expression = { [string]$_.hit.heading } })

    $returned = @($sorted | Select-Object -First $MaxResults | ForEach-Object { $_.hit })

    # The coverage sentence is computed from what actually happened, never from the fact that a
    # shared loop ran. Claiming the shared collection while one of its Books was unreadable is the
    # same silent-partial failure as dropping a Shelf Book -- so "partial" is a state of its own,
    # and it names how many Books it is missing.
    $sharedUnavailable = @($unavailable | Where-Object { $_.collection -ceq 'shared' -and $_.book_shelf -ceq 'active' }).Count
    $sharedCovered = ($sharedSlugs.Count -gt 0)
    # The roster's date is part of the answer, not a detail. Discovery cannot see the shared catalog
    # -- it runs offline -- so a Book added to books/README since the last backfill is not merely
    # unread, it is unknown, and no count can reveal it. Saying how old the roster is turns a silent
    # blind spot into something the reader can judge.
    $asOfText = if ([string]::IsNullOrWhiteSpace($sharedRosterAsOf)) { '' } else { " Shared Book list as of $($sharedRosterAsOf.Substring(0, [Math]::Min(10, $sharedRosterAsOf.Length))); a Book added since then is not in this answer." }
    $sharedNote = if (-not $sharedCovered) { $script:DiscoverySharedNoteNone }
                  elseif ($sharedUnavailable -gt 0) { "Shared collection: $sharedSearched of $($sharedSlugs.Count) Books searched -- $sharedUnavailable could not be read, named below, so this answer is PARTIAL for the shared collection.$asOfText" }
                  else { "Shared collection: all $sharedSearched Book(s) searched.$asOfText" }

    # THE ARCHIVE SENTENCE IS SEPARATE AND UNCONDITIONAL, and it is the half this whole item exists
    # for. Archiving used to delete a Book's manifest, so the answer went on saying "all N Books
    # searched" about an N that had quietly shrunk -- complete-sounding and wrong, which is the exact
    # failure every other coverage sentence here was written to prevent. An archive with nothing in
    # it still says so, because "no archived Books" and "archived Books not searched" are different
    # facts and a reader cannot tell them apart from silence.
    $shelfArchiveUnavailable = @($unavailable | Where-Object { $_.collection -ceq 'shelf' -and $_.book_shelf -ceq 'archive' }).Count
    $sharedArchiveUnavailable = @($unavailable | Where-Object { $_.collection -ceq 'shared' -and $_.book_shelf -ceq 'archive' }).Count
    $archiveParts = [Collections.Generic.List[string]]::new()
    [void]$archiveParts.Add($(
        if (-not $shelfArchiveSlugs.Count) { 'the Shelf archive holds no Books' }
        elseif ($shelfArchiveUnavailable -gt 0) { "Shelf archive: $shelfArchiveSearched of $($shelfArchiveSlugs.Count) searched -- $shelfArchiveUnavailable could not be read, named below" }
        else { "Shelf archive: all $shelfArchiveSearched Book(s) searched" }))
    [void]$archiveParts.Add($(
        if ($null -eq $archiveRoster) { $script:DiscoverySharedArchiveNoteNone }
        elseif ($sharedArchiveUnavailable -gt 0) { "shared archive: $sharedArchiveSearched of $($sharedArchiveSlugs.Count) searched -- $sharedArchiveUnavailable could not be read, named below" }
        else { "shared archive: all $sharedArchiveSearched Book(s) searched" }))
    $archiveNote = "Archived Books are covered and labelled -- $($archiveParts -join '; ')."

    [pscustomobject]@{
        schema               = $script:BookDiscoverySchema
        query                = (ConvertTo-DiscoveryDisplay $Query)
        scope                = if ($sharedCovered) { 'local Shelf and shared collection, including what is archived' } else { 'local Shelf, including what is archived' }
        shared_books_covered = $sharedCovered
        shared_roster_as_of  = $sharedRosterAsOf
        shared_books_note    = $sharedNote
        archive_note         = $archiveNote
        shared_archive_covered = ($null -ne $archiveRoster)
        shared_archive_roster_as_of = $sharedArchiveRosterAsOf
        shelf_books_total    = $slugs.Count
        shelf_books_searched = $shelfSearched
        shared_books_total   = $sharedSlugs.Count
        shared_books_searched = $sharedSearched
        shelf_archive_books_total = $shelfArchiveSlugs.Count
        shelf_archive_books_searched = $shelfArchiveSearched
        shared_archive_books_total = $sharedArchiveSlugs.Count
        shared_archive_books_searched = $sharedArchiveSearched
        books_total          = ($slugs.Count + $sharedSlugs.Count + $shelfArchiveSlugs.Count + $sharedArchiveSlugs.Count)
        books_searched       = ($shelfSearched + $sharedSearched + $shelfArchiveSearched + $sharedArchiveSearched)
        books_unavailable    = @($unavailable)
        match_count          = $sorted.Count
        result_count         = $returned.Count
        truncated            = ($sorted.Count -gt $returned.Count)
        max_results          = $MaxResults
        results              = $returned
    }
}

# A one-paragraph rendering for a caller that has to hand this to a reader rather than to code. The
# coverage line comes first and unconditionally, because the thing a Discovery answer must never do
# is look complete when a Book was skipped or the shared collection was never in scope.
function Format-DiscoveryResult($Result) {
    $lines = [Collections.Generic.List[string]]::new()
    [void]$lines.Add("Discovery over the $($Result.scope) for: $($Result.query)")
    [void]$lines.Add("$($Result.result_count) result(s) from $($Result.books_searched) of $($Result.books_total) Book(s) -- Shelf $($Result.shelf_books_searched)/$($Result.shelf_books_total), shared $($Result.shared_books_searched)/$($Result.shared_books_total), Shelf archive $($Result.shelf_archive_books_searched)/$($Result.shelf_archive_books_total), shared archive $($Result.shared_archive_books_searched)/$($Result.shared_archive_books_total). $($Result.shared_books_note)")
    [void]$lines.Add($Result.archive_note)
    if ($Result.truncated) {
        [void]$lines.Add("Showing the first $($Result.result_count) of $($Result.match_count) matches; ask for more with a larger result cap.")
    }
    if (@($Result.books_unavailable).Count) {
        [void]$lines.Add('')
        [void]$lines.Add('Books this query could NOT read, so this answer is incomplete for them:')
        foreach ($entry in @($Result.books_unavailable)) {
            [void]$lines.Add("- $($entry.book) [$($entry.book_root)] ($($entry.status)): $($entry.reason) -- $($entry.repair)")
        }
    }
    [void]$lines.Add('')
    if (-not @($Result.results).Count) {
        [void]$lines.Add('No manifest in the Books this query could read carries that term.')
    }
    else {
        # Grouped on the ROOT, not the slug. `shelf/notes` and `shelf/_archive/notes` are two
        # different Books that share a name, and grouping by slug would print one heading over both
        # sets of hits -- attributing an archived Book's pages to its active twin, which is the
        # ambiguity Select-BookRootsForSlug refuses to resolve for exactly this reason.
        $currentBook = ''
        foreach ($hit in @($Result.results)) {
            if ($hit.book_root -cne $currentBook) {
                $currentBook = $hit.book_root
                $openText = if ($hit.book_open) { 'open' } else { 'closed' }
                $overlapText = if ($null -ne $hit.overlap) { " -- overlap: $($hit.overlap)" } else { '' }
                # ARCHIVED IS SAID, NOT IMPLIED. A retired Book that reads like a current one is the
                # cost of covering the archive at all, so the label rides every hit group.
                $shelfText = if ($hit.book_shelf -ceq 'archive') { ', ARCHIVED' } else { '' }
                [void]$lines.Add('')
                [void]$lines.Add("$($hit.book_title) [$($hit.book_root), $($hit.book_kind), $openText$shelfText]$overlapText")
            }
            $where = if ($null -ne $hit.page) { $hit.page } else { '(Book level)' }
            $what = if ($null -ne $hit.heading) { " -- $($hit.heading)" } else { '' }
            [void]$lines.Add("  $($hit.match_field): $where$what")
        }
    }
    [void]$lines.Add('')
    [void]$lines.Add((Get-SearchClosingRule 'discovery'))
    ($lines -join "`n")
}

# ---------------------------------------------------------------------------------------------------
# Self-test. Fixture-only and offline; run by Invoke-LibraryChecks.ps1 as `book-discovery.selftest`.
# ---------------------------------------------------------------------------------------------------
if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') {
    # Fixtures work at a seat named 'fixture'. Set in this process so CHILD helper processes
    # inherit it: they default -Seat to LIBRARY_SEAT, and there is no default seat to fall back on.
    $env:LIBRARY_SEAT = 'fixture'
    $script:failures = [Collections.Generic.List[string]]::new()
    $script:checks = 0
    function Assert([bool]$Condition, [string]$Message) {
        $script:checks++
        if (-not $Condition) { [void]$script:failures.Add($Message) }
    }

    $utf8 = [Text.UTF8Encoding]::new($false)
    function Write-Fixture([string]$Path, [string]$Text) {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [IO.File]::WriteAllText($Path, $Text, $utf8)
    }

    # Indexing an empty match set throws, and the outer catch then swallows every assertion after it,
    # so a suite that HAS the right canary reports only the first one that noticed. Found while
    # watching these mutations fail: two of them reported one failure and hid three. Nothing here
    # indexes a filtered set directly.
    function First($Items) {
        $all = @($Items)
        if ($all.Count) { return $all[0] }
        $null
    }
    # A query that throws must be a failed assertion, not a dead suite: "one unreadable store must
    # not take the whole query down" is exactly the property being tested here.
    function Invoke-SafeFind([string]$Root, [string]$Term) {
        try { return Find-BookPages -Workspace $Root -Query $Term }
        catch { return $null }
    }
    function Get-Unavailable($Result, [string]$Slug) {
        if ($null -eq $Result) { return $null }
        First @($Result.books_unavailable | Where-Object { $_.book -ceq $Slug })
    }

    # Sentinels that exist ONLY in page bodies and note bodies. If one of them ever reaches a result,
    # Discovery has started returning content.
    $bodySentinel = 'ZZBODYONLYZZ'
    $noteBodySentinel = 'ZZNOTEBODYZZ'
    $noteTitleSentinel = 'ZZNOTETITLEZZ'

    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('book-discovery-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $fixture -Force | Out-Null

        Write-Fixture (Join-Path $fixture 'shelf/_catalog.md') @"
# Local Shelf

## Demo Book
- **Summary:** A curated fixture Book about retrieval and orientation.
- **Topics:** discovery, fixtures
- **Path:** shelf/demo

## Paired Book
- **Summary:** The counterpart in the overlap record.
- **Topics:** discovery
- **Path:** shelf/paired

## Broken Book
- **Summary:** Its store is deliberately damaged.
- **Topics:** discovery
- **Path:** shelf/broken

## Inbox
- **Summary:** A capture fixture holding one note about retrieval.
- **Topics:** capture
- **Kind:** capture
- **Path:** shelf/inbox
"@

        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/_book.md') "# Demo Book`n`n- **Kind:** curated`n`nOverview body containing $bodySentinel and nothing structural.`n"
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/_index.md') "# Reader Map`n`n## Where retrieval starts`n`n- [[topic/alpha|Alpha, on retrieval]]`n- [[topic/gone|A retrieval page that was deleted]]`n"
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/alpha.md') "# Alpha Page`n`n## Retrieval and search`n`nBody text with $bodySentinel in it.`n`n``````text`n# Retrieval inside a fence`n``````n"
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/beta.md') "# Retrieval Overview`n`n## Something else entirely`n"
        # Non-ASCII built from code points, never as a literal: this file has no BOM, so a literal
        # em-dash in this source would be read as ANSI by Windows PowerShell 5.1 -- the same hazard
        # this case exists to catch one layer down, in the store's read path.
        $emDash = [string][char]0x2014
        $curlyOpen = [string][char]0x201C
        $curlyClose = [string][char]0x201D
        $eAcute = [string][char]0x00E9
        $unicodeHeading = "Caf$eAcute $emDash $curlyOpen" + "quoted$curlyClose orientation"
        $decomposedQuery = 'Caf' + [string][char]0x0065 + [string][char]0x0301
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/unicode.md') "# Unicode Page`n`n## $unicodeHeading`n"

        Write-Fixture (Join-Path $fixture 'shelf/paired/wiki/_book.md') "# Paired Book`n`nNo retrieval heading here.`n"
        Write-Fixture (Join-Path $fixture 'shelf/broken/wiki/_book.md') "# Broken Book`n`n## Retrieval in a Book whose store breaks`n"
        Write-Fixture (Join-Path $fixture 'shelf/inbox/wiki/_book.md') "# Inbox`n`n- **Kind:** capture`n"
        Write-Fixture (Join-Path $fixture 'shelf/inbox/wiki/notes/2026-08-19-secret.md') "---`nreview: pending`n---`n`n# $noteTitleSentinel on retrieval`n`nNote body carrying $noteBodySentinel.`n"

        Write-Fixture (Join-Path $fixture 'internal/overlap-records.json') @"
{
  "schema": 1,
  "records": [
    { "topic": "discovery", "book": "demo", "counterpart": "paired", "relationship": "canonical", "resolution": "open", "date": "2026-08-19" }
  ]
}
"@

        New-Item -ItemType Directory -Path (Join-Path $fixture '.claude') -Force | Out-Null
        New-Item -ItemType Directory -Path (Get-DeskStateDirectory -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture') -Force | Out-Null
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books') -Text '' | Out-Null

        foreach ($slug in @('demo', 'paired', 'broken', 'inbox')) {
            Save-BookManifest -Workspace $fixture -Slug $slug -Manifest (New-BookManifest -Workspace $fixture -Slug $slug) -Reason 'fixture' | Out-Null
        }

        # --- the ordinary answer ------------------------------------------------------------------
        $result = Find-BookPages -Workspace $fixture -Query 'retrieval'
        Assert ($result.schema -eq 1) 'the result carries no schema'
        Assert (@($result.results).Count -gt 0) 'a term present in three fixture Books returned nothing'

        $headingHits = @($result.results | Where-Object { $_.match_field -ceq 'heading' -and $_.book -ceq 'demo' -and $_.page -ceq 'topic/alpha' })
        Assert ($headingHits.Count -eq 1) "a matching page heading produced $($headingHits.Count) hits"
        $headingHit = First $headingHits
        Assert (($null -ne $headingHit) -and ($headingHit.page -ceq 'topic/alpha')) 'the page path is not canonical'
        Assert (($null -ne $headingHit) -and ($headingHit.heading -ceq 'Retrieval and search')) 'the matched heading was not returned'
        Assert (@($result.results | Where-Object { $_.book -ceq 'demo' }).Count -eq 6) "the demo Book's hit set changed: $(@($result.results | Where-Object { $_.book -ceq 'demo' }).Count)"

        # --- LEAK CANARY: never body text ----------------------------------------------------------
        $serialized = $result | ConvertTo-Json -Depth 10
        Assert ($serialized.IndexOf($bodySentinel, [StringComparison]::Ordinal) -lt 0) 'page body text reached a Discovery result'
        Assert ($serialized.IndexOf($noteBodySentinel, [StringComparison]::Ordinal) -lt 0) 'capture note body text reached a Discovery result'

        # --- LEAK CANARY: the hit shape is exactly the declared one ---------------------------------
        $strayField = ''
        foreach ($hit in @($result.results)) {
            foreach ($name in @($hit.PSObject.Properties | ForEach-Object { $_.Name })) {
                if ($script:DiscoveryHitFields -cnotcontains $name) { $strayField = $name }
            }
        }
        Assert ($strayField -ceq '') "a Discovery hit carried an undeclared field: $strayField"

        # --- LEAK CANARY: a CLOSED capture Book names no note ---------------------------------------
        Assert ($serialized.IndexOf($noteTitleSentinel, [StringComparison]::Ordinal) -lt 0) 'a closed capture Book''s note title reached a Discovery result'
        $inboxHits = @($result.results | Where-Object { $_.book -ceq 'inbox' })
        Assert ($inboxHits.Count -gt 0) 'a closed capture Book contributed nothing at all, not even its summary'
        Assert (-not @($inboxHits | Where-Object { $null -ne $_.page }).Count) 'a closed capture Book returned a page path'
        Assert (@($inboxHits | Where-Object { $_.match_field -ceq 'book-summary' }).Count -eq 1) 'a closed capture Book''s summary match was lost'
        $inboxHit = First $inboxHits
        Assert (($null -ne $inboxHit) -and ($inboxHit.book_kind -ceq 'capture')) 'a capture Book was reported as curated'

        # --- the open capture Book DOES join, from disk ---------------------------------------------
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books') -Text "shelf/inbox`n" | Out-Null
        $openResult = Find-BookPages -Workspace $fixture -Query 'retrieval'
        $openInbox = @($openResult.results | Where-Object { $_.book -ceq 'inbox' -and $null -ne $_.page })
        Assert ($openInbox.Count -eq 1) "an open capture Book's note did not join Discovery: $($openInbox.Count) page hit(s)"
        $openInboxHit = First $openInbox
        Assert (($null -ne $openInboxHit) -and ($openInboxHit.page -ceq 'notes/2026-08-19-secret')) 'the open note''s page path is not canonical'
        Assert (($null -ne $openInboxHit) -and $openInboxHit.book_open) 'an open Book was reported closed'
        $openSerialized = $openResult | ConvertTo-Json -Depth 10
        Assert ($openSerialized.IndexOf($noteBodySentinel, [StringComparison]::Ordinal) -lt 0) 'an open capture Book leaked note body text'
        Assert ($openSerialized.IndexOf($noteTitleSentinel, [StringComparison]::Ordinal) -ge 0) 'an open capture Book withheld the note title it is allowed to name'
        # The store is unchanged by the open path: the live read is a query, not a generation.
        $inboxStored = Get-StoredBookManifest -Workspace $fixture -Slug 'inbox'
        Assert ($inboxStored.manifest.page_metadata -ceq 'withheld') 'the open path wrote page metadata into closed-readable storage'
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books') -Text '' | Out-Null

        # --- a fenced heading is not a heading ------------------------------------------------------
        $fenced = Find-BookPages -Workspace $fixture -Query 'Retrieval inside a fence'
        Assert (@($fenced.results).Count -eq 0) 'a heading inside a fenced block was matched'

        # --- page title, reader map, book title, topic ----------------------------------------------
        $titleHits = @($result.results | Where-Object { $_.match_field -ceq 'page-title' })
        Assert ($titleHits.Count -eq 1) "expected one page-title hit, got $($titleHits.Count)"
        $titleHit = First $titleHits
        Assert (($null -ne $titleHit) -and ($titleHit.page -ceq 'topic/beta')) 'the page-title hit named the wrong page'
        $dupes = @($result.results | Where-Object { $_.page -ceq 'topic/beta' -and $_.heading -ceq 'Retrieval Overview' })
        Assert ($dupes.Count -eq 1) 'a page title was reported twice, once as a title and once as its own H1'

        $mapHits = @($result.results | Where-Object { $_.match_field -ceq 'reader-map' })
        Assert ($mapHits.Count -eq 2) "expected two reader-map link hits, got $($mapHits.Count)"
        Assert (@($result.results | Where-Object { $_.page -ceq '_index' -and $_.match_field -ceq 'heading' }).Count -eq 1) 'the reader map''s own heading was reported twice, or not at all'
        Assert (@($mapHits | Where-Object { $_.page -ceq 'topic/alpha' }).Count -eq 1) 'a reader-map link to a real page carried no page path'
        Assert (@($mapHits | Where-Object { $_.heading -clike '*deleted*' -and $null -eq $_.page }).Count -eq 1) 'a reader-map link to a missing page was given a page path anyway'

        $topicResult = Find-BookPages -Workspace $fixture -Query 'fixtures'
        Assert (@($topicResult.results | Where-Object { $_.match_field -ceq 'topic' }).Count -eq 1) 'a catalog topic match produced no hit'
        $bookTitleResult = Find-BookPages -Workspace $fixture -Query 'Paired Book'
        Assert (@($bookTitleResult.results | Where-Object { $_.match_field -ceq 'book-title' }).Count -eq 1) 'a Book title match produced no hit'
        Assert (-not @($bookTitleResult.results | Where-Object { $_.match_field -ceq 'book-summary' -and $_.heading }).Count) 'a summary match returned the summary text'

        # --- the overlap join -----------------------------------------------------------------------
        $demoHit = First @($result.results | Where-Object { $_.book -ceq 'demo' })
        Assert (($null -ne $demoHit) -and ($null -ne $demoHit.overlap)) 'a Book with an overlap record reported no overlap status'
        Assert (($null -ne $demoHit) -and ($demoHit.overlap -clike "canonical for 'discovery' over paired*")) 'the overlap status does not read as canonical over its counterpart'
        $pairedHit = First (Find-BookPages -Workspace $fixture -Query 'Paired Book').results
        Assert (($null -ne $pairedHit) -and ($pairedHit.overlap -clike "superseded for 'discovery' by demo*")) 'the other side of the overlap record does not read as superseded'
        $unpairedHit = First @($result.results | Where-Object { $_.book -ceq 'inbox' })
        Assert (($null -ne $unpairedHit) -and ($null -eq $unpairedHit.overlap)) 'a Book with no overlap record was given one'

        # --- a Book that cannot be read is REPORTED, never dropped -----------------------------------
        $dirtyPath = Join-Path $fixture 'internal/book-manifests/shelf/broken/dirty.json'
        Write-Fixture $dirtyPath '{ "reason": "planted", "pid": 0 }'
        $dirtyResult = Invoke-SafeFind $fixture 'retrieval'
        Assert ($null -ne $dirtyResult) 'one dirty Book took down the whole query'
        $dirtyEntry = Get-Unavailable $dirtyResult 'broken'
        Assert ($null -ne $dirtyEntry) 'a dirty Book was not reported as unavailable'
        Assert (($null -ne $dirtyEntry) -and ($dirtyEntry.status -ceq 'dirty')) 'a dirty Book did not report status dirty'
        Assert (($null -ne $dirtyEntry) -and ($dirtyEntry.repair -clike '*Update-BookManifests*')) 'an unavailable Book was reported with no repair'
        Assert (($null -ne $dirtyResult) -and (-not @($dirtyResult.results | Where-Object { $_.book -ceq 'broken' }).Count)) 'a dirty Book contributed results'
        Assert (($null -ne $dirtyResult) -and (@($dirtyResult.results).Count -gt 0)) 'one dirty Book cost the other Books their results'
        Assert (($null -ne $dirtyResult) -and ($dirtyResult.books_searched -eq ($dirtyResult.books_total - 1))) 'the searched count did not fall when a Book became unavailable'
        Remove-Item -LiteralPath $dirtyPath -Force

        $currentPath = Join-Path $fixture 'internal/book-manifests/shelf/broken/current.json'
        Write-Fixture $currentPath 'not json at all'
        $corruptResult = Invoke-SafeFind $fixture 'retrieval'
        Assert ($null -ne $corruptResult) 'one corrupt store took down the whole query'
        $corruptEntry = Get-Unavailable $corruptResult 'broken'
        Assert ($null -ne $corruptEntry) 'a corrupt Book was not reported as unavailable'
        Assert (($null -ne $corruptEntry) -and ($corruptEntry.status -ceq 'corrupt')) 'a corrupt Book did not report status corrupt'
        Assert (($null -ne $corruptResult) -and (@($corruptResult.results).Count -gt 0)) 'one corrupt store cost the other Books their results'
        Remove-Item -LiteralPath (Join-Path $fixture 'internal/book-manifests/shelf/broken') -Recurse -Force

        $missingResult = Invoke-SafeFind $fixture 'retrieval'
        Assert ($null -ne $missingResult) 'a missing store took down the whole query'
        $missingEntry = Get-Unavailable $missingResult 'broken'
        Assert ($null -ne $missingEntry) 'a Book with no manifest at all was not reported'
        Assert (($null -ne $missingEntry) -and ($missingEntry.status -ceq 'missing')) 'a Book with no store did not report status missing'
        Assert (($null -ne $missingResult) -and (@($missingResult.results).Count -gt 0)) 'a missing store cost the other Books their results'
        Assert (($null -ne $missingResult) -and ((Format-DiscoveryResult $missingResult) -clike '*could NOT read*')) 'the rendered answer hid the unavailable Book'
        Save-BookManifest -Workspace $fixture -Slug 'broken' -Manifest (New-BookManifest -Workspace $fixture -Slug 'broken') -Reason 'fixture' | Out-Null

        # --- with no roster the shared collection is out of scope, and the answer says so ------------
        Assert ($result.shared_books_covered -eq $false) 'Discovery claimed to cover shared Books with no roster present'
        Assert ($result.shared_books_note -clike '*local Shelf only*') 'the shared-collection gap is not named in the answer'
        Assert ($result.scope -ceq 'local Shelf, including what is archived') 'the scope field does not name the local Shelf'
        Assert ((Format-DiscoveryResult $result) -clike '*local Shelf only*') 'the rendered answer does not disclose its scope'
        Assert ($result.shared_books_total -eq 0) 'shared Books were counted with no roster present'

        # --- matching boundaries ---------------------------------------------------------------------
        $upper = Find-BookPages -Workspace $fixture -Query 'RETRIEVAL AND SEARCH'
        Assert (@($upper.results | Where-Object { $_.heading -ceq 'Retrieval and search' }).Count -eq 1) 'matching is not case-insensitive'
        $regexish = Find-BookPages -Workspace $fixture -Query 'Retrieval.*search'
        Assert (@($regexish.results).Count -eq 0) 'a regex metacharacter was not treated literally'
        # Non-ASCII survives the whole path -- generation, storage, read-back, query, answer. The
        # store read used Get-Content -Raw until 2026-08-19, which reads a BOM-less UTF-8 file as
        # ANSI, so every accented character in every manifest came back mangled and no ASCII fixture
        # could see it. This is the consumer's end of that regression.
        $unicodeResult = Find-BookPages -Workspace $fixture -Query "Caf$eAcute"
        $unicodeHit = First @($unicodeResult.results | Where-Object { $_.page -ceq 'topic/unicode' })
        Assert ($null -ne $unicodeHit) 'a non-ASCII heading was not found at all'
        Assert (($null -ne $unicodeHit) -and ($unicodeHit.heading -ceq $unicodeHeading)) 'a non-ASCII heading came back altered'
        # The decomposed form of the same query must reach the composed stored text. This assertion
        # was ASCII-only when first written and could not fail; with a real accented character it can.
        $decomposed = Find-BookPages -Workspace $fixture -Query $decomposedQuery
        Assert (@($decomposed.results | Where-Object { $_.page -ceq 'topic/unicode' }).Count -eq 1) 'a decomposed query did not match composed stored text'

        $emptyRejected = $false
        try { Find-BookPages -Workspace $fixture -Query "   `t " | Out-Null } catch { $emptyRejected = $_.Exception.Message -clike '*non-blank*' }
        Assert $emptyRejected 'a blank query was accepted'
        $longRejected = $false
        try { Find-BookPages -Workspace $fixture -Query ('x' * 201) | Out-Null } catch { $longRejected = $_.Exception.Message -clike '*capped at*' }
        Assert $longRejected 'an over-long query was accepted'

        # --- caps and determinism ----------------------------------------------------------------------
        $capped = Find-BookPages -Workspace $fixture -Query 'retrieval' -MaxResults 2
        Assert ($capped.result_count -eq 2) "the result cap was not applied: $($capped.result_count)"
        Assert ($capped.truncated) 'a truncated answer did not say so'
        Assert ($capped.match_count -gt $capped.result_count) 'the total match count was not reported above the cap'
        Assert (-not $result.truncated) 'an untruncated answer claimed truncation'

        $again = Find-BookPages -Workspace $fixture -Query 'retrieval'
        Assert ((($again | ConvertTo-Json -Depth 10)) -ceq (($result | ConvertTo-Json -Depth 10))) 'two identical queries returned different answers'

        # --- RUNG 7: the shared collection joins, and coverage is computed, never assumed ------------
        # The shared stores are built here from manifest objects rather than from MCP: this suite is
        # offline by construction, and what Discovery consumes is a committed manifest whatever wrote
        # it. The MCP side is Test-SharedManifestBackfill.ps1's, against a stub.
        function New-SharedFixtureManifest([string]$Slug, [string]$Title, [string]$Summary, [object[]]$Pages, [bool]$IsCapture) {
            New-BookManifestFromPages -Slug $Slug -Title $Title -Summary $Summary -Topics @('shared-fixture') `
                -IsCapture $IsCapture -Pages @($Pages) -CapturePageCount (@($Pages).Count) -CapturePendingCount 0
        }
        function New-SharedFixturePage([string]$Path, [string]$Text) {
            [pscustomobject]@{ path = $Path; text = $Text; bytes = $utf8.GetBytes($Text) }
        }
        function Set-SharedRoster([object[]]$Slugs) {
            $body = [pscustomobject]@{ schema = 1; generated_utc = '2026-08-19T00:00:00Z'; books = @($Slugs | ForEach-Object { [pscustomobject]@{ slug = $_ } }) }
            Write-Fixture (Join-Path $fixture 'internal/book-manifests/shared/_roster.json') ($body | ConvertTo-Json -Depth 6)
        }

        $sharedPages = @(
            (New-SharedFixturePage '_book' "# Shared Reference`n`n## Retrieval over MCP`n"),
            (New-SharedFixturePage 'guide/setup' "# Setup Guide`n`n## Retrieval settings`n`nBody carrying $bodySentinel.`n")
        )
        $sharedManifest = New-SharedFixtureManifest 'sharedref' 'Shared Reference' 'A shared Book about retrieval.' $sharedPages $false
        Save-BookManifest -Workspace $fixture -Slug 'sharedref' -Manifest $sharedManifest -Reason 'fixture' -Collection 'shared' | Out-Null

        $sharedCapturePages = @((New-SharedFixturePage 'notes/held' "# $noteTitleSentinel over there`n`nBody with $noteBodySentinel.`n"))
        $sharedCaptureManifest = New-SharedFixtureManifest 'sharedhold' 'Shared Holding' 'A shared capture Book about retrieval.' $sharedCapturePages $true
        Save-BookManifest -Workspace $fixture -Slug 'sharedhold' -Manifest $sharedCaptureManifest -Reason 'fixture' -Collection 'shared' | Out-Null

        # The namespace canary at query level: a shared Book sharing a slug with a Shelf Book must
        # answer for itself. Before rung 7 both collections keyed the same directory, so one of these
        # two manifests would simply have overwritten the other.
        $sharedDemoPages = @((New-SharedFixturePage '_book' "# Shared Demo`n`n## Retrieval from the other collection`n"))
        Save-BookManifest -Workspace $fixture -Slug 'demo' -Manifest (New-SharedFixtureManifest 'demo' 'Shared Demo' 'The shared Book that shares a slug.' $sharedDemoPages $false) -Reason 'fixture' -Collection 'shared' | Out-Null

        Set-SharedRoster @('sharedref', 'sharedhold', 'demo')
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books') -Text '' | Out-Null

        $bothResult = Find-BookPages -Workspace $fixture -Query 'retrieval'
        Assert ($bothResult.shared_books_covered -eq $true) 'a rostered shared collection was not reported as covered'
        # The roster's age is in the answer, because Discovery cannot see the shared catalog and a
        # Book added since the last backfill is unknown rather than merely unread.
        Assert ($bothResult.shared_roster_as_of -clike '2026-08-19*') 'the roster date was not carried into the result'
        Assert ($bothResult.shared_books_note -clike '*as of 2026-08-19*') 'the answer does not say how old its shared Book list is'
        Assert ($bothResult.scope -ceq 'local Shelf and shared collection, including what is archived') 'the scope field does not name both collections'
        Assert ($bothResult.shared_books_total -eq 3) "the shared roster was not counted: $($bothResult.shared_books_total)"
        Assert ($bothResult.shared_books_searched -eq 3) 'a rostered shared Book was not searched'
        Assert ($bothResult.books_total -eq ($bothResult.shelf_books_total + $bothResult.shared_books_total)) 'the total does not span both collections'
        Assert (@($bothResult.results | Where-Object { $_.book -ceq 'sharedref' -and $_.page -ceq 'guide/setup' }).Count -eq 1) 'a shared Book''s page heading produced no hit'
        Assert ((Format-DiscoveryResult $bothResult) -clike '*local Shelf and shared collection*') 'the rendered answer does not disclose that it spans both collections'

        # The Shelf Book and the shared Book of the same slug each answer for themselves.
        $shelfDemoTitles = @($bothResult.results | Where-Object { $_.book -ceq 'demo' } | ForEach-Object { $_.book_title } | Sort-Object -Unique)
        Assert ($shelfDemoTitles -ccontains 'Demo Book') 'the Shelf Book lost its own manifest to the shared Book of the same slug'
        Assert ($shelfDemoTitles -ccontains 'Shared Demo') 'the shared Book of a colliding slug did not answer for itself'

        # --- LEAK CANARY: a shared capture Book discloses no page metadata ---------------------------
        $sharedSerialized = $bothResult | ConvertTo-Json -Depth 10
        Assert ($sharedSerialized.IndexOf($noteTitleSentinel, [StringComparison]::Ordinal) -lt 0) 'a shared capture Book''s note title reached a Discovery result'
        Assert ($sharedSerialized.IndexOf($noteBodySentinel, [StringComparison]::Ordinal) -lt 0) 'a shared capture Book leaked note body text'
        $sharedHoldHits = @($bothResult.results | Where-Object { $_.book -ceq 'sharedhold' })
        Assert ($sharedHoldHits.Count -gt 0) 'a shared capture Book contributed nothing, not even its summary'
        Assert (-not @($sharedHoldHits | Where-Object { $null -ne $_.page }).Count) 'a shared capture Book returned a page path'
        # Opening a shared capture Book must NOT reach a live path: there is no filesystem to read,
        # and reaching for one would be a body read of a NAS Book from inside an offline query.
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books') -Text "books/sharedhold`n" | Out-Null
        $openSharedResult = Invoke-SafeFind $fixture 'retrieval'
        Assert ($null -ne $openSharedResult) 'an open shared capture Book took down the query'
        Assert (($null -ne $openSharedResult) -and (-not @($openSharedResult.results | Where-Object { $_.book -ceq 'sharedhold' -and $null -ne $_.page }).Count)) 'an open shared capture Book returned a page path'
        Assert (($null -ne $openSharedResult) -and (($openSharedResult | ConvertTo-Json -Depth 10).IndexOf($noteTitleSentinel, [StringComparison]::Ordinal) -lt 0)) 'an open shared capture Book leaked a note title'
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books') -Text '' | Out-Null

        # --- an unreadable shared Book makes the answer PARTIAL, and says so --------------------------
        # The two-sided failure: claiming the shared collection while one of its Books could not be
        # read is the same silent-partial answer as dropping a Shelf Book, so the note must change and
        # the Book must be named with its own repair.
        $sharedDirty = Join-Path $fixture 'internal/book-manifests/shared/sharedref/dirty.json'
        Write-Fixture $sharedDirty '{ "reason": "planted", "pid": 0 }'
        $partial = Invoke-SafeFind $fixture 'retrieval'
        Assert ($null -ne $partial) 'one dirty shared Book took down the whole query'
        $sharedEntry = Get-Unavailable $partial 'sharedref'
        Assert ($null -ne $sharedEntry) 'a dirty shared Book was not reported as unavailable'
        Assert (($null -ne $sharedEntry) -and ($sharedEntry.collection -ceq 'shared')) 'an unavailable shared Book was not marked as shared'
        Assert (($null -ne $sharedEntry) -and ($sharedEntry.repair -clike '*Update-SharedBookManifests*')) 'an unavailable shared Book was offered the Shelf''s repair'
        Assert (($null -ne $partial) -and ($partial.shared_books_searched -eq 2)) 'the shared searched count did not fall'
        Assert (($null -ne $partial) -and ($partial.shared_books_note -clike '*PARTIAL*')) 'the answer claimed shared coverage while a shared Book was unreadable'
        Assert (($null -ne $partial) -and (-not @($partial.results | Where-Object { $_.book -ceq 'sharedref' }).Count)) 'a dirty shared Book contributed results'
        Assert (($null -ne $partial) -and (@($partial.results).Count -gt 0)) 'one dirty shared Book cost every other Book its results'
        Assert (($null -ne $partial) -and ((Format-DiscoveryResult $partial) -clike '*could NOT read*')) 'the rendered answer hid the unavailable shared Book'
        Remove-Item -LiteralPath $sharedDirty -Force

        # --- a rostered shared Book with no store at all is named, never invisible --------------------
        # This is what the roster is for. Without it a shared Book whose store was never written would
        # simply not appear, and the answer would look complete.
        Set-SharedRoster @('sharedref', 'sharedhold', 'demo', 'neverbackfilled')
        $rosterGap = Invoke-SafeFind $fixture 'retrieval'
        $gapEntry = Get-Unavailable $rosterGap 'neverbackfilled'
        Assert ($null -ne $gapEntry) 'a rostered shared Book with no store was invisible rather than unavailable'
        Assert (($null -ne $gapEntry) -and ($gapEntry.status -ceq 'missing')) 'a shared Book with no store did not report status missing'
        Assert (($null -ne $rosterGap) -and ($rosterGap.shared_books_total -eq 4)) 'a rostered Book with no store was left out of the total'

        # --- a malformed roster puts the shared collection honestly OUT of scope ----------------------
        Write-Fixture (Join-Path $fixture 'internal/book-manifests/shared/_roster.json') 'not json at all'
        $noRoster = Invoke-SafeFind $fixture 'retrieval'
        Assert ($null -ne $noRoster) 'a malformed roster took down the query'
        Assert (($null -ne $noRoster) -and ($noRoster.shared_books_covered -eq $false)) 'a malformed roster still claimed shared coverage'
        Assert (($null -ne $noRoster) -and ($noRoster.shared_books_note -clike '*local Shelf only*')) 'a malformed roster did not put the shared collection out of scope in the answer'
        Assert (($null -ne $noRoster) -and (-not @($noRoster.results | Where-Object { $_.book -ceq 'sharedref' }).Count)) 'shared results were served with no valid roster'
        Set-SharedRoster @('sharedref', 'sharedhold', 'demo')

        # --- SCHEMA COMPATIBILITY: a manifest written before the anchor roll-up still answers --------
        # The upgrade to body schema 2 (ADR-0011) must never require a regeneration sweep to stay
        # FUNCTIONAL. A stored schema-1 generation carries no anchored_upstreams and no
        # anchor_unreadable, and Discovery must neither notice nor care -- it reads kind, pages,
        # headings and the reader map, none of which moved. The Currency check is the only consumer
        # of the new field, and it reports the absence as `manifest lacks anchor data` rather than
        # treating the Book as unanchored.
        $legacyPages = @((New-SharedFixturePage '_book' "# Legacy Schema`n`n## Retrieval before the roll-up`n"))
        $legacyManifest = New-SharedFixtureManifest 'legacyschema' 'Legacy Schema' 'A shared Book stored under manifest schema 1.' $legacyPages $false
        $legacyBody = [ordered]@{}
        foreach ($property in $legacyManifest.PSObject.Properties) {
            if ($property.Name -cin @('anchored_upstreams', 'anchor_unreadable')) { continue }
            $legacyBody[$property.Name] = $property.Value
        }
        $legacyBody['schema'] = 1
        Save-BookManifest -Workspace $fixture -Slug 'legacyschema' -Manifest ([pscustomobject]$legacyBody) -Reason 'schema-1 fixture' -Collection 'shared' | Out-Null
        Set-SharedRoster @('sharedref', 'sharedhold', 'demo', 'legacyschema')

        $legacyStored = Get-StoredBookManifest -Workspace $fixture -Slug 'legacyschema' -Collection 'shared'
        Assert ($legacyStored.status -ceq 'ok') "a stored schema-1 manifest was not readable: $($legacyStored.reason)"
        Assert ($legacyStored.manifest.schema -eq 1) 'the schema-1 fixture did not store schema 1'
        Assert (-not (Read-ManifestAnchors $legacyStored.manifest).present) 'a schema-1 manifest reported carrying anchor data'
        $legacyResult = Invoke-SafeFind $fixture 'retrieval'
        Assert ($null -ne $legacyResult) 'a stored schema-1 manifest took down the query'
        Assert (($null -ne $legacyResult) -and (-not (Get-Unavailable $legacyResult 'legacyschema'))) 'a stored schema-1 manifest was reported unavailable'
        Assert (($null -ne $legacyResult) -and (@($legacyResult.results | Where-Object { $_.book -ceq 'legacyschema' }).Count -gt 0)) 'a stored schema-1 manifest produced no Discovery hits'

        # And the other direction: a freshly generated schema-2 manifest reads through the same path.
        $currentStored = Get-StoredBookManifest -Workspace $fixture -Slug 'sharedref' -Collection 'shared'
        Assert ($currentStored.manifest.schema -eq 2) 'a freshly generated manifest is not schema 2'
        Assert ((Read-ManifestAnchors $currentStored.manifest).present) 'a schema-2 manifest did not report carrying anchor data'
        Assert (-not [string]::IsNullOrWhiteSpace($currentStored.committed_utc)) 'the store did not report when the generation was committed'

        Remove-BookManifestStore -Workspace $fixture -Slug 'legacyschema' -Collection 'shared' | Out-Null
        Set-SharedRoster @('sharedref', 'sharedhold', 'demo')

        # --- Discovery writes nothing --------------------------------------------------------------
        function Get-FixtureFingerprint([string]$Root) {
            @(Get-ChildItem -LiteralPath $Root -Recurse -File | Sort-Object FullName |
                ForEach-Object { "$($_.FullName.Substring($Root.Length))|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" }) -join "`n"
        }
        $before = Get-FixtureFingerprint $fixture
        Find-BookPages -Workspace $fixture -Query 'retrieval' | Out-Null
        Find-BookPages -Workspace $fixture -Query 'discovery' | Out-Null
        Assert ((Get-FixtureFingerprint $fixture) -ceq $before) 'a Discovery query changed something on disk'
    }
    catch {
        # Without this, a strict-mode error inside the body unwinds past every remaining assertion and
        # the suite exits GREEN having run a fraction of itself.
        [void]$script:failures.Add("the suite did not run to completion: $($_.Exception.Message)")
    }
    finally {
        Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($script:failures.Count) {
        [Console]::Error.WriteLine("BookDiscovery self-test FAILED: $($script:failures -join '; ')")
        exit 1
    }
    Write-Host "BookDiscovery self-test passed ($($script:checks) checks)."
    exit 0
}
