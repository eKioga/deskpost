<#
.SYNOPSIS
    Full text over Books OPEN on the Desk: matching lines with the exact page path that opens them.
    Dot-sourced; never invoked directly.

.DESCRIPTION
    Plan item 2.3, under ADR-0002. Discovery (2.2) answers "which Book covers this" across every
    Book, open or closed, because it reads only catalog-class metadata. This tier answers "where in
    this Book does it actually say that", and it returns the body itself -- so it is confined to
    Books the Desk says are OPEN. The two tiers are two halves of one boundary, not two settings of
    one dial, and ADR-0002 is where that is settled.

    THE LEAK CANARIES INVERT. Discovery's assert that body text NEVER appears. These assert that
    body text appears ONLY for an open Book: not for a closed one, and not for one that was open
    when the query started and closed before it answered. That second case is why the Desk is read
    TWICE -- once to choose Books and once after the scan, before anything is emitted -- and why a
    Book that closed in between has every line, page path, and note attributable to it dropped, with
    only its slug named. Its slug is Desk state the reader already has; its page paths are not.

    AN OPEN CAPTURE BOOK'S UNVETTED NOTES ARE READABLE HERE, AND THAT IS NEW. Discovery keeps a
    capture Book's page metadata out of closed-readable storage entirely, because naming a note is
    reading it. Once the Book is OPEN that protection has done its job and ADR-0002 says its pages
    join normally -- so this tier returns note bodies, which is the correct behaviour and a real
    difference from every canary written before it. The answer therefore SAYS SO: a result set drawn
    partly from unvetted capture material is labelled, because a note the reader has not yet
    triaged reads exactly like a curated page once it is a line on a screen.

    OPEN SHARED BOOKS ARE OUT OF SCOPE, AND EVERY ANSWER NAMES THEM. A Shelf Book is a file scan; a
    shared Book has no filesystem, and its pages arrive one read_note at a time -- 118 of them for
    godot-engine-architecture-reference. That is not a query, it is a backfill, and it cannot finish
    inside any wall-clock cap worth having. So the first form of this tier covers the local Shelf,
    and an open shared Book is listed in the answer as out of scope with the reason and the
    alternative. Rung 6 said "local Shelf only" in every answer for the same reason: a partial answer
    that does not admit it is partial is the failure this phase keeps designing against.

    THE CAPS ARE 2.5'S, NOT THIS TIER'S. tools/SearchBoundaries.ps1 owns query length, result count,
    matched bytes, per-line length, wall clock, files scanned, and per-file size, so all three tiers
    share one set. Every one of them reports when it binds; none of them shortens an answer quietly.

    A MATCHED LINE IS NOT A READING. 2.6's rule, tightened for this tier. A Discovery hit licenses
    "shall I open it?"; a matched line licenses opening the page it names, and may be cited only as
    evidence that the term occurs there. Answering from the line instead of reading the page is
    reasoning from a grep hit, which is the failure 2.6 exists to prevent. Nothing in this file can
    enforce it; it is named here because the output is what tempts it.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'SearchBoundaries.ps1')
. (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')
. (Join-Path $PSScriptRoot 'BookManifest.ps1')

$script:BookFullTextSchema = 1

$script:FullTextSharedNote = 'Full text covers the local Shelf only. A shared Book''s pages arrive one read over the network at a time, which no query-time budget can complete, so an open shared Book is named below rather than searched.'
$script:FullTextSharedAlternative = 'read it a page at a time with read_open_book_page, or use discover_book_pages for its headings'
$script:FullTextClosedNote = 'Closed Books are not searched at all and are not listed here. Use discover_book_pages to find which Book covers a subject.'

# The complete set of fields a hit may carry, declared once so a later change that adds surrounding
# context, a neighbouring line, or a whole paragraph fails a leak canary rather than shipping. This
# tier already returns body text, so the thing worth bounding is HOW MUCH of it.
$script:FullTextHitFields = @('book', 'book_root', 'book_title', 'book_kind', 'book_shelf', 'page', 'line', 'text', 'line_truncated')

# --- The scan -------------------------------------------------------------------------------------

function New-FullTextHit([string]$Slug, [string]$BookRoot, [string]$BookTitle, [string]$BookKind, [string]$Page, [int]$Line, [string]$Text, [bool]$LineTruncated) {
    [pscustomobject]@{
        book           = $Slug
        book_root      = $BookRoot
        book_title     = $BookTitle
        book_kind      = $BookKind
        book_shelf     = (Split-BookRoot $BookRoot).shelf
        page           = $Page
        line           = $Line
        text           = $Text
        line_truncated = $LineTruncated
    }
}

# Lines, with the numbering a reader can act on. Split on \n with a trailing \r trimmed rather than
# on the platform separator: a Book page can arrive from an import with either ending, and a line
# number that does not match what an editor shows is worse than no line number.
function Split-FullTextLines([string]$Text) {
    @($Text.Replace("`r`n", "`n").Split("`n"))
}

function Find-OpenBookLines {
    <#
    .SYNOPSIS
        Every matching line in every Shelf Book open on the Desk, with the canonical page path that
        feeds read_open_book_page. Reads no closed Book.

    .PARAMETER AfterScanHook
        A TEST SEAM, and nothing else. It runs once between the scan and the re-read of the Desk,
        which is the only moment at which "a Book closed midway through a query" can be produced
        deterministically. The close-mid-query canary is worthless unless it can be watched red, and
        it cannot be watched red without this. No caller in the Library passes it.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Query,
        [int]$MaxResults = $script:SearchDefaultMaxResults,
        [string]$DeskStateDirectory,
        # Only consulted when no Desk directory is passed. A caller that already knows which
        # seat it is serving passes the resolved directory instead.
        [string]$Seat,
        [scriptblock]$AfterScanHook
    )

    $root = (Resolve-Path -LiteralPath $Workspace).Path
    # The DESK, which belongs to a seat, not the state directory that holds every seat. An
    # unresolvable seat throws here rather than defaulting, because there is no default seat.
    if ([string]::IsNullOrWhiteSpace($DeskStateDirectory)) {
        $DeskStateDirectory = Get-DeskStateDirectory -StateDirectory (Join-Path $root '.claude') -Seat $Seat
    }

    $needle = Assert-SearchQuery $Query
    $cap = Resolve-SearchResultCap $MaxResults
    $budget = New-SearchBudget

    # First read of the Desk: which Books may be read at all.
    $openRoots = @(Get-SearchOpenBookRoots -DeskStateDirectory $DeskStateDirectory)
    # Split-BookRoot rather than two regexes and a Substring(6): an ARCHIVED shared Book is
    # archive/<slug>, where both the old patterns fail and the offset is wrong. It joins $sharedSlugs
    # because this tier's answer for a shared Book is the same either way -- named as out of scope,
    # because its pages arrive one network read at a time.
    $parsedRoots = @($openRoots | ForEach-Object { Split-BookRoot $_ })
    # The PARSED entries are carried, not their slugs. An archived Shelf Book is `shelf` too, and a
    # loop over slugs alone has to re-derive which shelf it came from -- which is how this tier came
    # to resolve an open archived Book through shelf/_catalog.md, a catalog it is absent from BY
    # DESIGN, and report it unreadable with the repair "check shelf/_catalog.md lists this Book".
    $shelfBooksOpen = @($parsedRoots | Where-Object { $_.collection -ceq 'shelf' } | Sort-Object -Property @{ Expression = { $_.root } })
    $shelfSlugs = @($shelfBooksOpen | ForEach-Object { $_.slug })
    $sharedSlugs = @(@($parsedRoots | Where-Object { $_.collection -ceq 'shared' } | ForEach-Object { $_.slug }) | Sort-Object)

    $hits = [Collections.Generic.List[object]]::new()
    $unavailable = [Collections.Generic.List[object]]::new()
    $withheld = [Collections.Generic.List[object]]::new()
    $captureBooks = [Collections.Generic.List[string]]::new()
    $searched = [Collections.Generic.List[string]]::new()
    $pagesScanned = 0
    $order = 0

    foreach ($openBook in $shelfBooksOpen) {
        $slug = $openBook.slug
        $isArchived = ($openBook.shelf -ceq 'archive')
        $order++
        # A Book the catalog does not list, or whose wiki directory is gone, is NAMED. Dropping it
        # would make the answer look like it covered every open Book, which is the quiet failure
        # rung 6 built its whole reporting path around.
        $book = $null
        try {
            $book = if ($isArchived) { Get-ArchivedShelfBook -Workspace $root -Slug $slug }
                    else { Get-ShelfBook -Workspace $root -Slug $slug }
        }
        catch {
            [void]$unavailable.Add([pscustomobject]@{
                    book       = $slug
                    book_root  = $openBook.root
                    book_title = $slug
                    collection = 'shelf'
                    book_shelf = $openBook.shelf
                    reason     = $_.Exception.Message
                    # The repair has to match where the Book actually is. Sending a reader to
                    # shelf/_catalog.md for an ARCHIVED Book is advice that cannot work: the entry is
                    # absent because archiving removed it, and restoring it by hand would leave the
                    # catalog claiming a Book that is not at shelf/<slug>.
                    repair     = if ($isArchived) { "check shelf/_archive/$slug/_archived.json is intact, or close the Book with tools/Set-VirtualDesk.ps1" }
                                 else { 'check shelf/_catalog.md lists this Book, or close it with tools/Set-VirtualDesk.ps1' }
                })
            continue
        }
        if (-not (Test-Path -LiteralPath $book.wiki_path -PathType Container)) {
            [void]$unavailable.Add([pscustomobject]@{
                    book       = $slug
                    book_root  = $openBook.root
                    book_title = $book.title
                    collection = 'shelf'
                    book_shelf = $openBook.shelf
                    reason     = "This Book has no pages directory at $($openBook.wiki_root)."
                    repair     = 'restore the Book directory, or close it with tools/Set-VirtualDesk.ps1'
                })
            continue
        }

        $kind = if ($book.is_capture) { 'capture' } else { 'curated' }
        [void]$searched.Add($openBook.root)
        $wikiRoot = [IO.Path]::GetFullPath($book.wiki_path)
        $contributed = $false

        foreach ($file in @(Get-BookPageFiles $book.wiki_path)) {
            if (Test-SearchBudgetSpent $budget) { break }

            # 2.5's containment rule, applied to every page before it is opened. A directory
            # junction inside a Book's wiki would otherwise let this read raw/ or another Book,
            # because Get-ChildItem walks it and every file below still reports a path under the
            # Book's own root.
            if (-not (Test-SearchPathContained -Root $wikiRoot -FullPath $file.FullName)) {
                [void]$withheld.Add([pscustomobject]@{
                        book      = $slug
                        book_root = $openBook.root
                        page      = (ConvertTo-CanonicalPagePath $wikiRoot $file.FullName)
                        reason    = 'the page resolves outside this Book, or through a reparse point; its content was withheld'
                    })
                continue
            }
            if ($file.Length -gt $script:SearchMaxFileBytes) {
                [void]$withheld.Add([pscustomobject]@{
                        book      = $slug
                        book_root = $openBook.root
                        page      = (ConvertTo-CanonicalPagePath $wikiRoot $file.FullName)
                        reason    = "the page is $($file.Length) bytes, above the $($script:SearchMaxFileBytes)-byte per-page cap; it was not scanned"
                    })
                continue
            }

            Add-SearchBudgetFile $budget
            $pagesScanned++
            $page = ConvertTo-CanonicalPagePath $wikiRoot $file.FullName
            # [IO.File]::ReadAllText, never Get-Content -Raw: a BOM-less UTF-8 page reads as ANSI in
            # Windows PowerShell 5.1, and this tier returns the characters it read.
            $text = [IO.File]::ReadAllText($file.FullName)

            $lineNumber = 0
            foreach ($line in (Split-FullTextLines $text)) {
                $lineNumber++
                if (-not (Test-SearchContains $line $needle)) { continue }
                $rendered = ConvertTo-SearchLine $line
                [void]$hits.Add([pscustomobject]@{
                        order = $order
                        hit   = (New-FullTextHit $slug $openBook.root $book.title $kind $page $lineNumber $rendered.text $rendered.truncated)
                    })
                Add-SearchBudgetMatch $budget
                $contributed = $true
                if (Test-SearchBudgetSpent $budget) { break }
            }
        }

        if ($contributed -and ($kind -ceq 'capture')) { [void]$captureBooks.Add($openBook.root) }
    }

    # The seam, and then the second read of the Desk. See the parameter's own note.
    if ($null -ne $AfterScanHook) { & $AfterScanHook }

    # SECOND READ, and it is unconditional. A Book that was open when this query started and is
    # closed now must contribute nothing, because the answer is emitted after the close: serving its
    # lines would be serving a closed Book's body, whatever the Desk said a moment earlier.
    $closedDuringQuery = [Collections.Generic.List[object]]::new()
    $endRoots = @(Get-SearchOpenBookRoots -DeskStateDirectory $DeskStateDirectory)
    $stillOpen = @{}
    # COMPARED AS ROOTS, NOT AS A COMPOSED "shelf/<slug>". An archived Book's root is
    # shelf/_archive/<slug>, so the composed form never matched it -- every archived Book would have
    # been declared closed-during-query and had its lines dropped, silently, which is the precise
    # failure this second read exists to prevent. It was invisible while nothing archived could be
    # searched at all.
    foreach ($bookRoot in @($searched)) {
        if ($bookRoot -cin $endRoots) { $stillOpen[$bookRoot] = $true; continue }
        [void]$closedDuringQuery.Add([pscustomobject]@{ book = (Split-BookRoot $bookRoot).slug; book_root = $bookRoot })
    }
    if ($closedDuringQuery.Count) {
        # Everything attributable to the Book goes, not only its lines: a withheld page's path is a
        # page path of a Book that is now closed, and this tier is not the catalog.
        # Plain arrays, not List::new(...): PowerShell binds an array argument to a constructor as
        # an argument LIST, so List[string]::new(@('open')) does not mean "a list holding open".
        # That mistake silently left the searched count at its pre-filter value, which is precisely
        # the "returns less without saying so" failure this block exists to prevent.
        $hits = @(@($hits) | Where-Object { $stillOpen.ContainsKey([string]$_.hit.book_root) })
        $withheld = @(@($withheld) | Where-Object { $stillOpen.ContainsKey([string]$_.book_root) })
        $captureBooks = @(@($captureBooks) | Where-Object { $stillOpen.ContainsKey([string]$_) })
        $searched = @(@($searched) | Where-Object { $stillOpen.ContainsKey([string]$_) })
    }

    $sorted = @($hits | Sort-Object -Property `
        @{ Expression = { $_.order } }, `
        @{ Expression = { [string]$_.hit.page } }, `
        @{ Expression = { [int]$_.hit.line } })
    # The reply budget is spent HERE, on lines the reader will actually see, and it can only make
    # the answer shorter than the result cap -- never make the search stop. Both shortenings are
    # reported, and by different sentences.
    $returnedList = [Collections.Generic.List[object]]::new()
    foreach ($entry in @($sorted | Select-Object -First $cap)) {
        if (-not (Test-SearchBudgetAcceptsText $budget ([string]$entry.hit.text) ($returnedList.Count -eq 0))) { break }
        [void]$returnedList.Add($entry.hit)
    }
    $returned = @($returnedList)

    $outOfScope = [Collections.Generic.List[object]]::new()
    foreach ($slug in $sharedSlugs) {
        [void]$outOfScope.Add([pscustomobject]@{
                book        = $slug
                collection  = 'shared'
                reason      = 'a shared Book has no local pages to scan, and reading one over the network is a backfill rather than a query'
                alternative = $script:FullTextSharedAlternative
            })
    }

    [pscustomobject]@{
        schema                    = $script:BookFullTextSchema
        query                     = (ConvertTo-SearchDisplay $Query)
        scope                     = 'Shelf Books open on the Desk'
        books_open_total          = ($shelfSlugs.Count + $sharedSlugs.Count)
        shelf_books_open          = $shelfSlugs.Count
        shared_books_open         = $sharedSlugs.Count
        books_searched            = @($searched).Count
        books_unavailable         = @($unavailable)
        books_out_of_scope        = @($outOfScope)
        books_closed_during_query = @($closedDuringQuery)
        capture_books             = @($captureBooks)
        pages_withheld            = @($withheld)
        pages_scanned             = $pagesScanned
        match_count               = $sorted.Count
        match_count_is_floor      = ($budget.wall_clock_hit -or $budget.files_scanned_hit -or $budget.collected_matches_hit)
        result_count              = $returned.Count
        truncated                 = ($sorted.Count -gt $returned.Count)
        max_results               = $cap
        budget_note               = (Get-SearchBudgetNote $budget)
        results                   = $returned
    }
}

# --- Rendering ------------------------------------------------------------------------------------

# The coverage lines come first and unconditionally, for the reason rung 6 put them there: an answer
# that looks complete when a Book was skipped, out of scope, or closed underneath it is worse than
# no answer.
function Format-FullTextResult($Result) {
    $lines = [Collections.Generic.List[string]]::new()
    [void]$lines.Add("Full text over $($Result.books_searched) of $($Result.shelf_books_open) open Shelf Book(s) for: $($Result.query)")
    # "at least" belongs on the count itself, not only on the truncation line. A search stopped by a
    # scan budget can return every line it collected -- so the truncation line never renders -- and
    # the count would then read as exact while the budget note said the opposite.
    $found = if ($Result.match_count_is_floor) { "at least $($Result.result_count)" } else { "$($Result.result_count)" }
    [void]$lines.Add("$found matching line(s) from $($Result.pages_scanned) page(s). $($script:FullTextClosedNote)")
    if ($Result.truncated) {
        $total = if ($Result.match_count_is_floor) { "at least $($Result.match_count)" } else { "$($Result.match_count)" }
        [void]$lines.Add("Showing the first $($Result.result_count) of $total matching lines; ask for more with a larger result cap.")
    }
    if (-not [string]::IsNullOrWhiteSpace($Result.budget_note)) {
        [void]$lines.Add($Result.budget_note)
    }
    if (@($Result.books_out_of_scope).Count) {
        [void]$lines.Add('')
        [void]$lines.Add($script:FullTextSharedNote)
        foreach ($entry in @($Result.books_out_of_scope)) {
            [void]$lines.Add("- $($entry.book) [$($entry.collection)], open but NOT searched: $($entry.reason) -- $($entry.alternative)")
        }
    }
    if (@($Result.books_unavailable).Count) {
        [void]$lines.Add('')
        [void]$lines.Add('Books that are open but could NOT be read, so this answer is incomplete for them:')
        foreach ($entry in @($Result.books_unavailable)) {
            [void]$lines.Add("- $($entry.book) [$($entry.book_root)]: $($entry.reason) -- $($entry.repair)")
        }
    }
    if (@($Result.books_closed_during_query).Count) {
        [void]$lines.Add('')
        [void]$lines.Add('Books CLOSED while this query ran; their results were discarded unread, because a closed Book''s body is not available:')
        foreach ($entry in @($Result.books_closed_during_query)) {
            [void]$lines.Add("- $($entry.book) -- open it again and repeat the search if you still want it")
        }
    }
    if (@($Result.pages_withheld).Count) {
        [void]$lines.Add('')
        [void]$lines.Add('Pages that were NOT scanned, so this answer is incomplete for them:')
        foreach ($entry in @($Result.pages_withheld)) {
            [void]$lines.Add("- $($entry.book)/$($entry.page): $($entry.reason)")
        }
    }
    if (@($Result.capture_books).Count) {
        [void]$lines.Add('')
        [void]$lines.Add("Some of these lines come from UNVETTED capture notes in: $(@($Result.capture_books) -join ', '). They are readable because the Book is open, but nobody has triaged them.")
    }
    [void]$lines.Add('')
    if (-not @($Result.results).Count) {
        [void]$lines.Add('No page of the open Books carries that term.')
    }
    else {
        # Grouped on the ROOT: shelf/x and shelf/_archive/x are two Books sharing one name, and a
        # slug key would print one heading over both, attributing an archived Book's lines to its
        # active twin.
        $currentBook = ''
        foreach ($hit in @($Result.results)) {
            if ($hit.book_root -cne $currentBook) {
                $currentBook = $hit.book_root
                $shelfText = if ($hit.book_shelf -ceq 'archive') { ', ARCHIVED' } else { '' }
                [void]$lines.Add('')
                [void]$lines.Add("$($hit.book_title) [$($hit.book_root), $($hit.book_kind)$shelfText]")
            }
            $cut = if ($hit.line_truncated) { ' [line truncated]' } else { '' }
            [void]$lines.Add("  $($hit.page):$($hit.line): $($hit.text)$cut")
        }
    }
    [void]$lines.Add('')
    [void]$lines.Add((Get-SearchClosingRule 'book'))
    ($lines -join "`n")
}

# ---------------------------------------------------------------------------------------------------
# Self-test. Fixture-only and offline; run by Invoke-LibraryChecks.ps1 as `book-fulltext.selftest`.
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

    # Indexing an empty match set throws, and an outer catch then swallows every assertion after it,
    # so a suite that HAS the right canary reports only the first one that noticed. Nothing here
    # indexes a filtered set directly.
    function First($Items) {
        $all = @($Items)
        if ($all.Count) { return $all[0] }
        $null
    }
    # A query that throws must be a failed assertion, not a dead suite.
    function Invoke-SafeFind([string]$Root, [string]$Term) {
        try { return Find-OpenBookLines -Workspace $Root -Query $Term }
        catch { return $null }
    }
    function Test-AnyText($Result, [string]$Needle) {
        if ($null -eq $Result) { return $false }
        [bool]@(@($Result.results) | Where-Object { ([string]$_.text).IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count
    }
    function Get-Named($Items, [string]$Slug) {
        First @(@($Items) | Where-Object { [string]$_.book -ceq $Slug })
    }
    function Set-OpenBooks([string]$DeskDir, [string[]]$Roots) {
        Write-AtomicText -Path (Get-DeskFileInDirectory -DeskDirectory $DeskDir -Kind 'books') -Text (($Roots -join "`n") + "`n") | Out-Null
    }

    # Sentinels. Each exists in exactly one place, so its appearance in a result is unambiguous.
    $openSentinel = 'ZZOPENBODYZZ'
    $closedSentinel = 'ZZCLOSEDBODYZZ'
    $captureSentinel = 'ZZCAPTUREBODYZZ'
    $raceSentinel = 'ZZRACEBODYZZ'
    # A non-ASCII fixture, built from code points because this file has no BOM. An ASCII fixture
    # cannot catch an encoding defect, and this tier returns the characters it read.
    $eAcute = [string][char]0x00E9
    $accented = 'caf' + $eAcute + 'ZZACCENTZZ'

    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('book-fulltext-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $fixture -Force | Out-Null
        # The state directory, and then the SEAT's Desk directory beneath it. $deskDir now names the
        # latter, because that is what Set-OpenBooks and Find-OpenBookLines are both handed.
        $stateDir = Join-Path $fixture '.claude'
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
        $deskDir = Get-DeskStateDirectory -StateDirectory $stateDir -Seat 'fixture'
        New-Item -ItemType Directory -Path $deskDir -Force | Out-Null

        Write-Fixture (Join-Path $fixture 'shelf/_catalog.md') @"
# Local Shelf

## Open Book
- **Summary:** A curated fixture Book that is open on the Desk.
- **Topics:** retrieval
- **Path:** shelf/open

## Closed Book
- **Summary:** A curated fixture Book that is closed.
- **Topics:** retrieval
- **Path:** shelf/closed

## Race Book
- **Summary:** Open at the start of a query and closed before it answers.
- **Topics:** retrieval
- **Path:** shelf/race

## Inbox
- **Summary:** A capture fixture holding one unvetted note.
- **Topics:** retrieval
- **Kind:** capture
- **Path:** shelf/inbox

## Gone Book
- **Summary:** Listed in the catalog with no directory on disk.
- **Topics:** retrieval
- **Path:** shelf/gone
"@

        Write-Fixture (Join-Path $fixture 'shelf/open/wiki/_book.md') "# Open Book`n`nOrientation page.`n"
        Write-Fixture (Join-Path $fixture 'shelf/open/wiki/notes/retrieval.md') @"
# Retrieval

A line that mentions $openSentinel plainly.
A second line about retrieval with no sentinel.
An accented line: $accented here.
"@
        Write-Fixture (Join-Path $fixture 'shelf/closed/wiki/_book.md') "# Closed Book`n`nA line holding $closedSentinel and retrieval.`n"
        Write-Fixture (Join-Path $fixture 'shelf/race/wiki/_book.md') "# Race Book`n`nA line holding $raceSentinel and retrieval.`n"
        Write-Fixture (Join-Path $fixture 'shelf/inbox/wiki/_book.md') "# Inbox`n`nCapture Book orientation.`n"
        Write-Fixture (Join-Path $fixture 'shelf/inbox/wiki/notes/unvetted.md') "# Unvetted note`n`nA note line holding $captureSentinel about retrieval.`n"

        # --- The Desk boundary ------------------------------------------------------------------
        Set-OpenBooks $deskDir @('shelf/open')

        $result = Invoke-SafeFind $fixture 'retrieval'
        Assert ($null -ne $result) 'A query over one open Book must not throw.'
        Assert (Test-AnyText $result 'retrieval') 'An open Book must contribute its matching lines.'
        Assert ($result.books_searched -eq 1) "Exactly the open Book is searched; searched=$(if ($null -ne $result) { $result.books_searched })."

        # CANARY: a closed Book's body must never appear.
        $closedProbe = Invoke-SafeFind $fixture $closedSentinel
        Assert ($null -ne $closedProbe) 'A query for a closed Book''s sentinel must answer, not throw.'
        Assert (-not (Test-AnyText $closedProbe $closedSentinel)) 'LEAK: a closed Book''s body text reached a result.'
        Assert (@($closedProbe.results).Count -eq 0) 'LEAK: a closed Book contributed a result.'

        # A closed Book is not even named -- the whole Library is closed, and listing it would be
        # noise. The first line is what carries the boundary.
        $rendered = Format-FullTextResult $closedProbe
        Assert ($rendered.IndexOf('Closed Books are not searched', [StringComparison]::Ordinal) -ge 0) 'Every answer must state that closed Books are not searched.'
        Assert ($rendered.IndexOf($script:SearchHitRuleStem, [StringComparison]::Ordinal) -ge 0) 'Every answer must carry the hit-is-a-location rule.'

        # --- Encoding -----------------------------------------------------------------------------
        $accentProbe = Invoke-SafeFind $fixture 'ZZACCENTZZ'
        Assert (Test-AnyText $accentProbe 'ZZACCENTZZ') 'The accented line must be found.'
        $accentHit = First @($accentProbe.results)
        Assert (($null -ne $accentHit) -and (([string]$accentHit.text).IndexOf($eAcute, [StringComparison]::Ordinal) -ge 0)) 'ENCODING: the accented character did not survive the read.'
        # And the query side too: a search FOR the accented word must match.
        $accentQuery = Invoke-SafeFind $fixture ('caf' + $eAcute)
        Assert (Test-AnyText $accentQuery 'ZZACCENTZZ') 'ENCODING: a non-ASCII query did not match the line holding it.'

        # --- The declared field set ---------------------------------------------------------------
        $anyHit = First @((Invoke-SafeFind $fixture 'retrieval').results)
        Assert ($null -ne $anyHit) 'There must be at least one hit to check the field set against.'
        if ($null -ne $anyHit) {
            $fields = @($anyHit.PSObject.Properties | ForEach-Object { $_.Name })
            $extra = @($fields | Where-Object { $_ -cnotin $script:FullTextHitFields })
            Assert (-not $extra.Count) "LEAK: a hit carries undeclared field(s): $($extra -join ', ')."
            $missing = @($script:FullTextHitFields | Where-Object { $_ -cnotin $fields })
            Assert (-not $missing.Count) "A hit is missing declared field(s): $($missing -join ', ')."
        }

        # --- The capture Book, open ---------------------------------------------------------------
        Set-OpenBooks $deskDir @('shelf/open', 'shelf/inbox')
        $captureProbe = Invoke-SafeFind $fixture $captureSentinel
        Assert (Test-AnyText $captureProbe $captureSentinel) 'An OPEN capture Book''s note body must be readable here -- ADR-0002 says its pages join normally once open.'
        Assert (@($captureProbe.capture_books) -ccontains 'shelf/inbox') 'An answer drawing on a capture Book must name it.'
        $captureRendered = Format-FullTextResult $captureProbe
        Assert ($captureRendered.IndexOf('UNVETTED', [StringComparison]::Ordinal) -ge 0) 'An answer drawing on capture notes must say they are unvetted.'

        # A capture Book that contributes nothing is not labelled: the warning is about the lines
        # actually shown, not about what happened to be open.
        $noCapture = Invoke-SafeFind $fixture $openSentinel
        Assert (-not (@($noCapture.capture_books) -ccontains 'shelf/inbox')) 'A capture Book that contributed no line must not be named.'

        # CANARY: closing the capture Book takes its notes away again.
        Set-OpenBooks $deskDir @('shelf/open')
        $captureClosed = Invoke-SafeFind $fixture $captureSentinel
        Assert (-not (Test-AnyText $captureClosed $captureSentinel)) 'LEAK: a CLOSED capture Book''s note body reached a result.'

        # --- Closed midway through the query ------------------------------------------------------
        Set-OpenBooks $deskDir @('shelf/open', 'shelf/race')
        $raceOpen = Invoke-SafeFind $fixture $raceSentinel
        Assert (Test-AnyText $raceOpen $raceSentinel) 'The race Book must contribute while it is open, or the canary below proves nothing.'

        $race = $null
        $raceError = ''
        try {
            $race = Find-OpenBookLines -Workspace $fixture -Query $raceSentinel -AfterScanHook { Set-OpenBooks $deskDir @('shelf/open') }
        }
        catch { $race = $null; $raceError = $_.Exception.Message }
        Assert ($null -ne $race) "A Book closing mid-query must not make the query throw: $raceError"
        if ($null -eq $race) { $race = [pscustomobject]@{ results = @(); books_closed_during_query = @(); books_searched = -1 } }
        # CANARY: the line was read while the Book was open and must still not be emitted.
        Assert (-not (Test-AnyText $race $raceSentinel)) 'LEAK: a Book closed mid-query still returned its body text.'
        Assert ((Get-Named $race.books_closed_during_query 'race') -ne $null) 'A Book closed mid-query must be NAMED, not silently dropped.'
        Assert ($race.books_searched -eq 1) "The searched count must FALL when a Book's results are discarded; got $($race.books_searched)."
        $raceRendered = Format-FullTextResult $race
        Assert ($raceRendered.IndexOf('CLOSED while this query ran', [StringComparison]::Ordinal) -ge 0) 'The answer must say a Book closed while the query ran.'
        Set-OpenBooks $deskDir @('shelf/open')

        # --- A Book that cannot be read is named, not dropped -------------------------------------
        Set-OpenBooks $deskDir @('shelf/open', 'shelf/gone')
        $goneProbe = Invoke-SafeFind $fixture 'retrieval'
        Assert ($null -ne (Get-Named $goneProbe.books_unavailable 'gone')) 'An open Book with no pages directory must be NAMED as unavailable.'
        Assert ($goneProbe.books_searched -eq 1) 'The searched count must not include a Book that could not be read.'
        $goneRendered = Format-FullTextResult $goneProbe
        Assert ($goneRendered.IndexOf('could NOT be read', [StringComparison]::Ordinal) -ge 0) 'The answer must say which open Books it could not read.'

        # An open Book that is not in the catalog at all.
        Set-OpenBooks $deskDir @('shelf/open', 'shelf/unlisted')
        $unlisted = Invoke-SafeFind $fixture 'retrieval'
        Assert ($null -ne (Get-Named $unlisted.books_unavailable 'unlisted')) 'An open Book absent from the catalog must be NAMED as unavailable.'
        Set-OpenBooks $deskDir @('shelf/open')

        # --- An open SHARED Book is out of scope, and said so -------------------------------------
        Set-OpenBooks $deskDir @('shelf/open', 'books/godot-engine-architecture-reference')
        $sharedProbe = Invoke-SafeFind $fixture 'retrieval'
        Assert ($sharedProbe.shared_books_open -eq 1) 'An open shared Book must be counted.'
        Assert ($null -ne (Get-Named $sharedProbe.books_out_of_scope 'godot-engine-architecture-reference')) 'An open shared Book must be NAMED as out of scope, never silently omitted.'
        $sharedRendered = Format-FullTextResult $sharedProbe
        Assert ($sharedRendered.IndexOf('open but NOT searched', [StringComparison]::Ordinal) -ge 0) 'The answer must say an open shared Book was not searched.'
        Assert ($sharedRendered.IndexOf('read_open_book_page', [StringComparison]::Ordinal) -ge 0) 'The out-of-scope note must name the alternative.'
        Set-OpenBooks $deskDir @('shelf/open')

        # --- Caps, and saying so ------------------------------------------------------------------
        Assert ((Resolve-SearchResultCap 100000) -eq $script:SearchMaxResultsCeiling) 'A result cap above the ceiling must clamp.'
        $threw = $false
        try { [void](Resolve-SearchResultCap 0) } catch { $threw = $true }
        Assert $threw 'A result cap below one must throw.'
        $threw = $false
        try { [void](Assert-SearchQuery ('x' * ($script:SearchMaxQueryLength + 1))) } catch { $threw = $true }
        Assert $threw 'An over-long query must be refused.'
        $threw = $false
        try { [void](Assert-SearchQuery "`t `n") } catch { $threw = $true }
        Assert $threw 'A query of only whitespace must be refused.'

        # Truncation is reported rather than hidden.
        $manyPath = Join-Path $fixture 'shelf/open/wiki/notes/many.md'
        $manyLines = [Collections.Generic.List[string]]::new()
        [void]$manyLines.Add('# Many')
        for ($i = 1; $i -le 40; $i++) { [void]$manyLines.Add("Line $i mentions ZZMANYZZ.") }
        Write-Fixture $manyPath (($manyLines -join "`n") + "`n")
        $capped = Find-OpenBookLines -Workspace $fixture -Query 'ZZMANYZZ' -MaxResults 5
        Assert ($capped.result_count -eq 5) "The result cap must bind; result_count=$($capped.result_count)."
        Assert ($capped.match_count -ge 40) "The total match count must be reported; match_count=$($capped.match_count)."
        Assert $capped.truncated 'A capped answer must be marked truncated.'
        Assert ((Format-FullTextResult $capped).IndexOf('Showing the first', [StringComparison]::Ordinal) -ge 0) 'A capped answer must say it was capped.'

        # --- Sanitisation and per-line truncation -------------------------------------------------
        $nastyPath = Join-Path $fixture 'shelf/open/wiki/notes/nasty.md'
        $bell = [string][char]0x0007
        $esc = [string][char]0x001B
        $longTail = 'x' * ($script:SearchMaxLineCharacters + 200)
        Write-Fixture $nastyPath ("# Nasty`n`nZZNASTYZZ" + $bell + $esc + "[31m still one line`nZZLONGZZ " + $longTail + "`n")

        $nasty = Invoke-SafeFind $fixture 'ZZNASTYZZ'
        $nastyHit = First @($nasty.results)
        Assert ($null -ne $nastyHit) 'The control-character line must be found.'
        if ($null -ne $nastyHit) {
            $emitted = [string]$nastyHit.text
            Assert ($emitted.IndexOf($bell, [StringComparison]::Ordinal) -lt 0) 'SANITISATION: a control character reached the output.'
            Assert ($emitted.IndexOf($esc, [StringComparison]::Ordinal) -lt 0) 'SANITISATION: an escape character reached the output.'
            Assert (-not [regex]::IsMatch($emitted, '[\p{Cc}\p{Cf}]')) 'SANITISATION: some control or format character reached the output.'
        }

        $long = Invoke-SafeFind $fixture 'ZZLONGZZ'
        $longHit = First @($long.results)
        Assert ($null -ne $longHit) 'The over-long line must be found.'
        if ($null -ne $longHit) {
            Assert (([string]$longHit.text).Length -le $script:SearchMaxLineCharacters) 'The per-line cap must bind.'
            Assert ($longHit.line_truncated) 'A truncated line must be MARKED truncated.'
            Assert ((Format-FullTextResult $long).IndexOf('[line truncated]', [StringComparison]::Ordinal) -ge 0) 'A truncated line must say so in the rendering.'
        }

        # A budget that is spent must produce the sentence that says so.
        $spent = New-SearchBudget -WallClockSeconds 0
        [void](Test-SearchBudgetSpent $spent)
        Assert (-not [string]::IsNullOrWhiteSpace((Get-SearchBudgetNote $spent))) 'A spent budget must produce a note saying the answer is incomplete.'
        Assert ((Get-SearchBudgetNote (New-SearchBudget)) -eq '') 'An unspent budget must produce no note.'

        # THE TWO BUDGETS ARE NOT ONE BUDGET. Found by the first real run: charging the reply budget
        # at collection made a query for a common word declare itself INCOMPLETE when every page had
        # in fact been read. A spent reply budget must NOT stop the scan, and must not claim pages
        # were missed.
        $replyOnly = New-SearchBudget
        Assert (-not (Test-SearchBudgetAcceptsText $replyOnly ('z' * 70000) $false)) 'A line larger than the whole reply budget must be refused.'
        Assert (-not (Test-SearchBudgetSpent $replyOnly)) 'A spent REPLY budget must not stop the scan.'
        $replyNote = Get-SearchBudgetNote $replyOnly
        Assert ($replyNote.IndexOf('Every page was still searched', [StringComparison]::Ordinal) -ge 0) 'A trimmed answer must say the search itself was complete.'
        Assert ($replyNote.IndexOf('STOPPED EARLY', [StringComparison]::Ordinal) -lt 0) 'A trimmed answer must NOT claim the search stopped early.'
        # And the first line is always returned, however large.
        $firstFits = New-SearchBudget
        Assert (Test-SearchBudgetAcceptsText $firstFits ('z' * 70000) $true) 'The first returned line must be accepted whatever its size.'

        # A scan budget spent DOES say pages were missed, and the match total becomes a floor.
        $scanOnly = New-SearchBudget -MaxCollectedMatches 1
        Add-SearchBudgetMatch $scanOnly
        [void](Test-SearchBudgetSpent $scanOnly)
        $scanNote = Get-SearchBudgetNote $scanOnly
        Assert ($scanNote.IndexOf('STOPPED EARLY', [StringComparison]::Ordinal) -ge 0) 'A spent scan budget must say the search stopped early.'
        Assert ($scanNote.IndexOf('floor, not a count', [StringComparison]::Ordinal) -ge 0) 'A spent scan budget must say the match total is a floor.'

        # End to end: a broad query whose answer is trimmed must not be reported as incomplete.
        $broad = Find-OpenBookLines -Workspace $fixture -Query 'ZZMANYZZ' -MaxResults 3
        Assert (-not $broad.match_count_is_floor) 'A query that read every page must report a real match total, not a floor.'
        Assert ((Format-FullTextResult $broad).IndexOf('STOPPED EARLY', [StringComparison]::Ordinal) -lt 0) 'A complete search must never claim it stopped early.'

        # And the POSITIVE half of the same rule. Added because a mutation that blanked
        # match_count_is_floor fired NOTHING: every assertion above tested that a complete search is
        # not a floor, and none tested that an incomplete one IS. An assertion that only ever
        # observes one value of a flag does not test the flag.
        $savedCollectionCap = $script:SearchMaxCollectedMatches
        try {
            $script:SearchMaxCollectedMatches = 2
            $floored = Find-OpenBookLines -Workspace $fixture -Query 'ZZMANYZZ' -MaxResults 50
            Assert $floored.match_count_is_floor 'A search stopped by its collection budget must report its match total as a FLOOR.'
            $flooredText = Format-FullTextResult $floored
            Assert ($flooredText.IndexOf('STOPPED EARLY', [StringComparison]::Ordinal) -ge 0) 'A search stopped by its collection budget must say so.'
            Assert ($flooredText.IndexOf('at least', [StringComparison]::Ordinal) -ge 0) 'A floored match total must be rendered as "at least N", never as an exact count.'
        }
        finally { $script:SearchMaxCollectedMatches = $savedCollectionCap }

        # --- Line numbers open the page ------------------------------------------------------------
        $lineProbe = Invoke-SafeFind $fixture $openSentinel
        $lineHit = First @($lineProbe.results)
        Assert (($null -ne $lineHit) -and ([string]$lineHit.page -ceq 'notes/retrieval')) "The page path must be the canonical one read_open_book_page accepts; got '$(if ($null -ne $lineHit) { $lineHit.page })'."
        Assert (($null -ne $lineHit) -and ([int]$lineHit.line -eq 3)) "The line number must be the real one; got $(if ($null -ne $lineHit) { $lineHit.line })."

        # --- Per-page size cap ----------------------------------------------------------------------
        $bigPath = Join-Path $fixture 'shelf/open/wiki/notes/big.md'
        Write-Fixture $bigPath ("# Big`n`nZZBIGZZ`n" + ('y' * ($script:SearchMaxFileBytes + 16)))
        $big = Invoke-SafeFind $fixture 'ZZBIGZZ'
        Assert (-not (Test-AnyText $big 'ZZBIGZZ')) 'A page above the per-page cap must not be scanned.'
        Assert ($null -ne (Get-Named $big.pages_withheld 'open')) 'A page skipped for size must be NAMED, not dropped.'
        Assert ((Format-FullTextResult $big).IndexOf('NOT scanned', [StringComparison]::Ordinal) -ge 0) 'The answer must say which pages it did not scan.'
        Remove-Item -LiteralPath $bigPath -Force

        # --- Containment ------------------------------------------------------------------------
        Assert (-not (Test-SearchPathContained -Root (Join-Path $fixture 'shelf/open/wiki') -FullPath (Join-Path $fixture 'shelf/closed/wiki/_book.md'))) 'A path outside the Book must not be contained.'
        Assert (Test-SearchPathContained -Root (Join-Path $fixture 'shelf/open/wiki') -FullPath (Join-Path $fixture 'shelf/open/wiki/notes/retrieval.md')) 'A path inside the Book must be contained.'
    }
    finally {
        if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
    }

    if ($script:failures.Count) {
        Write-Host "book-fulltext.selftest FAILED ($($script:failures.Count) of $($script:checks) checks)"
        foreach ($failure in $script:failures) { Write-Host "  - $failure" }
        exit 1
    }
    Write-Host "book-fulltext.selftest passed ($($script:checks) checks)"
    exit 0
}
