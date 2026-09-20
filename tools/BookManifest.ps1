<#
.SYNOPSIS
    Build one Shelf Book's Discovery metadata manifest. Dot-sourced; never invoked directly.

.DESCRIPTION
    Plan item 2.2, first rung: the manifest artefact and the generator that produces it. Storage --
    versioned generations, the dirty marker, the commit pointer, and the one transaction every Book
    mutation routes through -- is the next rung and is deliberately absent here. This file only turns
    a Book on disk into a manifest object.

    THE MANIFEST IS CATALOG-CLASS, which is the whole reason this file is careful. It is destined for
    a path readable while every Book is closed, exactly as shelf/_catalog.md already is, so
    everything it holds is disclosed to a reader who has opened nothing.

    THE CAPTURE EXCLUSION IS THEREFORE AT GENERATION, NOT AT QUERY. ADR-0002 is explicit: filtering
    what Discovery *returns* would not preserve the boundary, because the manifest itself is
    closed-readable, so a capture Book's note titles held there leak to any other reader of that
    path. A capture Book's manifest carries its summary and its counts and nothing else -- no page
    paths, no titles, no headings, and no reader map, since a capture Book's reader map is a list of
    note titles.

    IT FAILS CLOSED, TWICE. A Book is treated as capture if EITHER the Shelf catalog entry or the
    Book's own _book.md carries `Kind: capture`, so a leak needs both signals to be wrong rather than
    either. And a Book with no catalog entry at all is refused outright rather than generated as
    curated -- an absent entry is the state in which we know least, which is the wrong moment to
    disclose most.

    IT IS DETERMINISTIC. There is no timestamp in the manifest body: regenerating an unchanged Book
    yields identical bytes, so "has this Book changed" is a hash comparison and not a diff. The
    generation's own metadata -- when it ran, which generation it is -- belongs to the storage rung
    above, where it can change without changing what was measured.

    SCHEMA 2 ADDS THE UPSTREAM ROLL-UP, AND ADR-0011 IS WHY IT IS ALLOWED HERE. ADR-0002 authorises
    summaries, reader maps, page titles and headings as catalog-class; a repository URL is none of
    those, so widening the boundary needed its own decision rather than a quiet extension. What the
    roll-up carries is a SANITIZED UPSTREAM IDENTITY -- url, ref, commit oid -- and nothing more: no
    `repo root`, which is producer-local and names a directory on the machine that compiled the
    article, and no capture date. It is provenance ABOUT a Book, not content FROM it.

    THE CAPTURE EXCLUSION COVERS IT AT GENERATION, LIKE EVERYTHING ELSE. A capture Book's manifest
    carries an empty anchor set and a zero unreadable count, because it returns before the page scan
    runs at all -- and the self-test's leak canary asserts that against a capture fixture whose note
    DOES carry a pin, which is the acceptance pattern ADR-0002 records for the counts-only rule.

    `anchor_unreadable` IS NOT DECORATION. A page whose ## Sources block does not parse contributes
    no tuple; if that were all, a Book with one good article and one malformed one would report
    `current` at the collection tier while the per-Book tier reported `cannot verify`. Counting them
    is what keeps the two tiers from contradicting each other, and a count discloses nothing about
    what was counted.

    A STORED SCHEMA-1 MANIFEST STAYS READABLE. Nothing here or in the store validates the manifest
    BODY's schema, so an old generation keeps answering Discovery exactly as it did; it simply
    carries no anchor field, which the Currency check reports as `manifest lacks anchor data` rather
    than as absence of anchors. Note that a plain backfill will not replace it -- the source digest
    is over page bytes and has not changed, so the pass reports `already current`. `-Rebuild` is what
    lands the new field.

    WHAT IT DOES NOT DO. It does not decide whether reading these bodies is allowed. Generation reads
    Book bodies, so the caller owes the Desk gate, or backfill's explicit closed-content approval,
    before calling it. Nothing here is a back door around the Desk.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')
# The pin grammar has exactly one authority and it is not this file. Restating its regex here to
# "just pull the URL out" would be the second implementation of one question that
# docs/raw-batch-ownership.md names as the drift this codebase keeps paying for.
. (Join-Path $PSScriptRoot 'SourcesBlock.ps1')

$script:BookManifestSchema = 2

# Boundaries per plan item 2.5. Books are converted material from several external wikis, so page
# text is closer to untrusted input than to something this codebase wrote.
$script:ManifestMaxTextLength = 300
$script:ManifestMaxHeadingsPerPage = 200
$script:ManifestMaxPagesPerBook = 5000
# One entry per distinct repository a Book cites. A Book mixing a dozen upstreams is already
# unusual; a manifest holding hundreds would be a page-derived list masquerading as provenance.
$script:ManifestMaxUpstreamsPerBook = 100

# Normalise, flatten, sanitise, cap -- in that order. Unicode normalisation happens at generation so
# a query never has to normalise the stored side, and control characters are stripped rather than
# escaped because a manifest is rendered to a terminal by every consumer it has.
function ConvertTo-ManifestText([string]$Value) {
    if ([string]::IsNullOrEmpty($Value)) { return '' }
    $text = $Value.Normalize([Text.NormalizationForm]::FormC)
    $text = [regex]::Replace($text, '[\p{Cc}\p{Cf}]', ' ')
    $text = [regex]::Replace($text, '\s+', ' ').Trim()
    if ($text.Length -gt $script:ManifestMaxTextLength) {
        $text = $text.Substring(0, $script:ManifestMaxTextLength).TrimEnd() + '...'
    }
    $text
}

# Frontmatter is metadata, not content: a capture note's `review: pending` is not a heading, and the
# closing `---` is not a rule. Strip it before anything looks for structure.
function Remove-PageFrontmatter([string]$Text) {
    if ($Text -cmatch '(?s)^﻿?---\r?\n.*?\r?\n---\r?\n?(.*)$') { return $Matches[1] }
    $Text
}

# Markdown-aware rather than line-prefix guessing, per 2.5. A '#' inside a fenced block is content,
# and this Shelf holds three Books full of shell transcripts, so that is not a hypothetical.
function Get-MarkdownHeadings([string]$Text) {
    $lines = @((Remove-PageFrontmatter $Text).Replace("`r`n", "`n").Split("`n"))
    $fenced = $false
    $found = [Collections.Generic.List[object]]::new()
    foreach ($line in $lines) {
        if ($line -cmatch '^[ \t]{0,3}(?:`{3,}|~{3,})') { $fenced = -not $fenced; continue }
        if ($fenced) { continue }
        if ($line -cmatch '^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$') {
            if ($found.Count -ge $script:ManifestMaxHeadingsPerPage) { break }
            [void]$found.Add([pscustomobject]@{ level = $Matches[1].Length; text = (ConvertTo-ManifestText $Matches[2]) })
        }
    }
    @($found)
}

# The reader map in structured form: its sections, and what it points at. ADR-0002 names the reader
# map as catalog-class material, and it is the most useful thing a manifest can hold -- the one part
# of a Book a human wrote to be read first.
function Get-ReaderMapMetadata([string]$Text) {
    $links = [Collections.Generic.List[object]]::new()
    foreach ($match in @([regex]::Matches($Text, '\[\[([^\]\|]+)(?:\|([^\]]*))?\]\]'))) {
        if ($links.Count -ge $script:ManifestMaxHeadingsPerPage) { break }
        $target = ConvertTo-ManifestText $match.Groups[1].Value
        $label = if ($match.Groups[2].Success) { ConvertTo-ManifestText $match.Groups[2].Value } else { '' }
        [void]$links.Add([pscustomobject]@{ target = $target; label = $label })
    }
    [pscustomobject]@{
        headings = @(Get-MarkdownHeadings $Text)
        links    = @($links)
    }
}

# A reader map's links point at pages, and Discovery only hands the reader a path when the link
# target matches a page path the manifest lists. The two sides must therefore be spelled the same
# way. Anything that does not start with the prefix is left exactly as written -- a link out of the
# Book, or an already-relative one, is not a page path and must not be forced into looking like one.
function ConvertTo-CanonicalReaderMap($ReaderMap, [string]$LinkPrefix) {
    if ($null -eq $ReaderMap) { return $null }
    if ([string]::IsNullOrEmpty($LinkPrefix)) { return $ReaderMap }
    $links = [Collections.Generic.List[object]]::new()
    foreach ($link in @($ReaderMap.links)) {
        $target = [string]$link.target
        if ($target.StartsWith($LinkPrefix, [StringComparison]::Ordinal)) {
            $target = $target.Substring($LinkPrefix.Length) -replace '\.md$', ''
        }
        [void]$links.Add([pscustomobject]@{ target = $target; label = [string]$link.label })
    }
    [pscustomobject]@{ headings = @($ReaderMap.headings); links = @($links) }
}

# The canonical page path the validated reader accepts: below wiki/, no extension, forward slashes.
# Discovery's output has to feed read_open_book_page directly or it is a riddle, not a result.
function ConvertTo-CanonicalPagePath([string]$WikiRoot, [string]$FullPath) {
    $relative = $FullPath.Substring($WikiRoot.Length).TrimStart('\', '/')
    ($relative -replace '\\', '/') -replace '\.md$', ''
}

function Get-BookPageFiles([string]$WikiPath) {
    if (-not (Test-Path -LiteralPath $WikiPath -PathType Container)) { return @() }
    @(Get-ChildItem -LiteralPath $WikiPath -Recurse -File -Filter '*.md' | Sort-Object -Property FullName)
}

# A hash over bytes, not over the manifest: this is what a later rung compares to answer "has the
# Book changed since its manifest was written" without reading a body. It is safe to publish for a
# capture Book precisely because a digest discloses nothing about what was digested.
#
# Rung 7 moved the loop off the filesystem and onto a page list, so a shared Book -- whose pages
# arrive over MCP and have no file to stat -- is digested by the same code over the same shape. The
# Shelf still supplies raw file bytes, so every digest committed since rung 2 stays valid.
function Get-BookPageDigest([object[]]$Pages) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $parts = [Collections.Generic.List[string]]::new()
        foreach ($page in @($Pages)) {
            $hash = -join ($sha.ComputeHash($page.bytes) | ForEach-Object { $_.ToString('x2') })
            [void]$parts.Add([string]$page.path + ':' + $hash)
        }
        $joined = [Text.Encoding]::UTF8.GetBytes(($parts -join "`n"))
        -join ($sha.ComputeHash($joined) | ForEach-Object { $_.ToString('x2') })
    }
    finally { $sha.Dispose() }
}

# The union rule. Either signal saying `capture` is enough; only both saying otherwise lets page
# metadata into closed-readable storage.
function Test-BookIsCapture([object]$Book) {
    if ($Book.is_capture) { return $true }
    $bookPage = Join-Path $Book.wiki_path '_book.md'
    if (Test-Path -LiteralPath $bookPage -PathType Leaf) {
        if ([regex]::IsMatch([IO.File]::ReadAllText($bookPage), '(?m)^\s*-\s+\*\*Kind:\*\*\s+capture\s*$')) { return $true }
    }
    $false
}

function New-BookManifestFromPages {
    <#
    .SYNOPSIS
        Build a manifest from Book metadata and an already-collected page list. Writes nothing.

    .DESCRIPTION
        Rung 7's seam, and the reason a shared Book's manifest cannot drift from a Shelf Book's. The
        schema, the caps from item 2.5, the capture exclusion, and the digest all live here; the two
        collections differ only in where the page list came from -- the filesystem, or MCP. Discovery
        reads both through one code path, so they must come out identical, and the way to guarantee
        that is for there to be only one place they are built.

        A PAGE IS { path; text; bytes }. `path` is canonical -- below wiki/, no extension, forward
        slashes -- because it is what feeds read_open_book_page. `bytes` is what the digest hashes,
        so the Shelf can keep hashing raw file bytes while a shared page hashes the UTF-8 encoding of
        what MCP returned. `text` is what headings are extracted from.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Slug,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Title,
        [AllowEmptyString()][string]$Summary = '',
        [object[]]$Topics = @(),
        [Parameter(Mandatory = $true)][bool]$IsCapture,
        [object[]]$Pages = @(),
        # A capture Book counts its notes, which is not always its page count: a Shelf capture Book's
        # notes live directly under notes/ while the digest covers every page under wiki/. The caller
        # that knows the difference supplies it; a null leaves the page list's own count.
        [object]$CapturePageCount = $null,
        [object]$CapturePendingCount = $null,
        # A prefix reader-map links carry that page paths do not. The Shelf writes its map links
        # relative to wiki/, so it needs none; the shared collection writes them as full note paths
        # (books/<slug>/wiki/<page>), and a link that does not reduce to a canonical page path is a
        # link Discovery cannot hand the reader -- it becomes a Book-level hit instead of the page
        # the map actually points at. Found on rung 7's first real run, not by any fixture.
        [string]$LinkPrefix = ''
    )

    if (@($Pages).Count -gt $script:ManifestMaxPagesPerBook) {
        throw "Book '$Slug' holds $(@($Pages).Count) pages, above the manifest cap of $($script:ManifestMaxPagesPerBook)."
    }

    $manifest = [ordered]@{
        schema          = $script:BookManifestSchema
        slug            = $Slug
        title           = ConvertTo-ManifestText $Title
        summary         = ConvertTo-ManifestText $Summary
        topics          = @($Topics)
        kind            = 'curated'
        page_metadata   = 'full'
        withheld_reason = ''
        page_count      = @($Pages).Count
        pending_count   = $null
        reader_map      = $null
        pages           = @()
        # Schema 2, per ADR-0011. Both stay at these values for a capture Book, because the return
        # below happens before the scan that would fill them.
        anchored_upstreams = @()
        anchor_unreadable  = 0
        source_digest   = (Get-BookPageDigest $Pages)
    }

    if ($IsCapture) {
        $manifest.kind = 'capture'
        $manifest.page_metadata = 'withheld'
        $manifest.withheld_reason = 'capture Book: naming an individual note is reading it'
        if ($null -ne $CapturePageCount) { $manifest.page_count = [int]$CapturePageCount }
        $manifest.pending_count = $CapturePendingCount
        return [pscustomobject]$manifest
    }

    $pageEntries = [Collections.Generic.List[object]]::new()
    $anchors = [Collections.Generic.List[object]]::new()
    $unreadable = 0
    foreach ($page in @($Pages)) {
        if ([string]$page.path -ceq '_index') {
            $manifest.reader_map = ConvertTo-CanonicalReaderMap (Get-ReaderMapMetadata ([string]$page.text)) $LinkPrefix
        }
        $headings = @(Get-MarkdownHeadings ([string]$page.text))
        $firstH1 = @($headings | Where-Object { $_.level -eq 1 })
        [void]$pageEntries.Add([pscustomobject]@{
                path     = [string]$page.path
                title    = if ($firstH1.Count) { $firstH1[0].text } else { '' }
                headings = $headings
            })

        # The roll-up rides the same pass over text the headings already needed, which is what makes
        # it free for a shared Book too: its pages are already in hand at generation.
        $found = Get-ArticleAnchors -Text ([string]$page.text)
        if (-not $found.readable) { $unreadable++ }
        foreach ($anchor in @($found.upstreams)) { [void]$anchors.Add($anchor) }
    }
    $manifest.pages = @($pageEntries)

    $distinct = @(Select-DistinctAnchor $anchors)
    if ($distinct.Count -gt $script:ManifestMaxUpstreamsPerBook) {
        throw "Book '$Slug' cites $($distinct.Count) distinct upstreams, above the manifest cap of $($script:ManifestMaxUpstreamsPerBook)."
    }
    $manifest.anchored_upstreams = $distinct
    $manifest.anchor_unreadable = $unreadable

    [pscustomobject]$manifest
}

function New-BookManifest {
    <#
    .SYNOPSIS
        Build the metadata manifest for one Shelf Book. Reads bodies; writes nothing.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Slug
    )

    # Throws for an unknown or duplicated slug, which is the fail-closed path: a Book the catalog
    # does not describe is not generated as though it were curated.
    New-BookManifestForShelfBook -Book (Get-ShelfBook -Workspace $Workspace -Slug $Slug)
}

function New-BookManifestForShelfBook {
    <#
    .SYNOPSIS
        The metadata manifest for one already-resolved local Book. Reads bodies; writes nothing.

    .DESCRIPTION
        Split out from New-BookManifest when the archives entered search, and the split is the whole
        mechanism: an ARCHIVED Shelf Book is not in shelf/_catalog.md, so it cannot be resolved by
        slug -- but once Get-ArchivedShelfBook has resolved it, everything from here down is
        identical, and MUST be, or an archived Book's manifest would differ in shape from its active
        self and Discovery would read them differently. The Book object supplies its own wiki path,
        which is the only thing that actually varies.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$Book)

    $Slug = $Book.slug
    $wikiRoot = $Book.wiki_path
    if (-not (Test-Path -LiteralPath $wikiRoot -PathType Container)) {
        throw "Book '$Slug' has no pages directory at $($Book.book_root)/wiki."
    }

    $files = @(Get-BookPageFiles $wikiRoot)
    if ($files.Count -gt $script:ManifestMaxPagesPerBook) {
        throw "Book '$Slug' holds $($files.Count) pages, above the manifest cap of $($script:ManifestMaxPagesPerBook)."
    }

    # Raw bytes for the digest, decoded text for the headings. ReadAllText, never Get-Content -Raw:
    # in Windows PowerShell 5.1 that reads a BOM-less UTF-8 file as ANSI, which mangled every
    # manifest text field the store returned for a day before rung 6's first real run caught it.
    $pages = [Collections.Generic.List[object]]::new()
    foreach ($file in $files) {
        [void]$pages.Add([pscustomobject]@{
                path  = ConvertTo-CanonicalPagePath $wikiRoot $file.FullName
                text  = [IO.File]::ReadAllText($file.FullName)
                bytes = [IO.File]::ReadAllBytes($file.FullName)
            })
    }

    $isCapture = Test-BookIsCapture $Book
    $captureCount = $null
    $pendingCount = $null
    if ($isCapture) {
        # A Shelf capture Book counts the notes directly under notes/, which is not the same set as
        # every page under wiki/ that the digest covers.
        $notes = @(Get-ShelfNotes $Book)
        $captureCount = $notes.Count
        $pendingCount = @($notes | Where-Object { $_.review -cne 'done' }).Count
    }

    New-BookManifestFromPages -Slug $Book.slug -Title $Book.title -Summary $Book.summary `
        -Topics @($Book.topics) -IsCapture $isCapture -Pages @($pages) `
        -CapturePageCount $captureCount -CapturePendingCount $pendingCount
}

# ---------------------------------------------------------------------------------------------------
# Self-test. Fixture-only and offline; run by Invoke-LibraryChecks.ps1 as `book-manifest.selftest`.
# ---------------------------------------------------------------------------------------------------
if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') {
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

    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('book-manifest-selftest-' + [Guid]::NewGuid().ToString('n'))
    try {
        # A catalog with three Books: one curated, one declared capture in the catalog, and one whose
        # capture nature is declared ONLY in its own _book.md -- the case the union rule exists for.
        Write-Fixture (Join-Path $fixture 'shelf/_catalog.md') @'
# Local Shelf

## Demo Book — Curated
- **Summary:** A curated demo Book whose summary wraps across
  two lines, because catalog summaries do.
- **Topics:** demo, curated
- **Path:** shelf/demo

## Inbox
- **Summary:** Captures awaiting review.
- **Topics:** capture
- **Kind:** capture
- **Path:** shelf/inbox

## Quiet Inbox
- **Summary:** A capture Book the catalog forgot to mark.
- **Topics:** capture
- **Path:** shelf/quiet
'@

        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/_index.md') @'
# Demo — Reader Map

- [[_book|Book metadata]]

## Topics

- [[topic/_index|Topic index]]
- [[topic/plain]]
'@
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/_book.md') "# Demo Book`n`n- **Type:** fixture`n"
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/_index.md') "# Topic Index`n`n## Articles`n"
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/plain.md') @'
---
captured: 2026-08-18T00:00:00Z
review: pending
---

# Real Title

Body text.

## A Real Section

```
# Not a heading, this is inside a fence
```

~~~
## Also not a heading
~~~

### Back Outside
'@

        # Two compiled articles carrying pins, one of them citing the SAME upstream, so the roll-up
        # has a duplicate to collapse; and one whose block does not parse, so anchor_unreadable has
        # something to count.
        $selftestOid = '0123456789abcdef0123456789abcdef01234567'
        $selftestOid2 = 'fedcba9876543210fedcba9876543210fedcba98'
        $selftestHash = 'a' * 64
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/anchored.md') (
            "# Anchored`n`nBody.`n`n## Sources`n`n" +
            "- Upstream ``https://github.com/obsidianmd/obsidian-help`` ref ``refs/heads/master`` at ``$selftestOid``; repo root ``raw/obsidian-help``; captured ``2026-09-04```n" +
            "- Upstream ``https://github.com/other/thing`` ref ``refs/heads/main`` at ``$selftestOid2``; repo root ``raw/thing``; captured ``2026-09-04```n" +
            "- ``raw/obsidian-help/en/a.md`` - SHA-256 ``$selftestHash``; provenance: ``external```n" +
            "- ``raw/thing/b.md`` - SHA-256 ``$selftestHash``; provenance: ``external```n")
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/anchored-again.md') (
            "# Anchored Again`n`nBody.`n`n## Sources`n`n" +
            "- Upstream ``https://github.com/obsidianmd/obsidian-help`` ref ``refs/heads/master`` at ``$selftestOid``; repo root ``raw/obsidian-help``; captured ``2026-09-04```n" +
            "- ``raw/obsidian-help/en/c.md`` - SHA-256 ``$selftestHash``; provenance: ``external```n")
        # An unreadable block has to be modelled by a CORRUPTED CLAIM, not by prose. This fixture
        # read `- not a source line at all` until 2026-09-05, when the parser began skipping prose
        # on a canonical bullet -- and the fixture then asserted an unreadable count of 1 over a
        # block that is now, correctly, readable-and-anchorless. A lookalike of the failure rather
        # than a model of it, the same shape as the paginated-listing double.
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/broken.md') (
            "# Broken`n`n## Sources`n`n- ``raw/obsidian-help/en/d.md`` - SHA-256 ``not-a-real-hash``; provenance: ``external```n")

        Write-Fixture (Join-Path $fixture 'shelf/inbox/wiki/_book.md') "# Inbox`n`n- **Kind:** capture`n"
        Write-Fixture (Join-Path $fixture 'shelf/inbox/wiki/_index.md') "# Inbox — Reader Map`n`n- [[notes/secret-note|Sekrit Capture Title]]`n"
        # The capture leak canary needs something to leak: this note carries a real pin, so the
        # exclusion is proved against a Book that HAS anchor data rather than one that has none.
        Write-Fixture (Join-Path $fixture 'shelf/inbox/wiki/notes/secret-note.md') (
            "---`ncaptured: 2026-08-18T00:00:00Z`nreview: pending`n---`n`n# Sekrit Capture Title`n`nUnvetted body.`n`n## Sources`n`n" +
            "- Upstream ``https://github.com/private-org/secret-repo`` ref ``refs/heads/main`` at ``$selftestOid``; repo root ``raw/secret``; captured ``2026-09-04```n" +
            "- ``raw/secret/x.md`` - SHA-256 ``$selftestHash``; provenance: ``external```n")
        Write-Fixture (Join-Path $fixture 'shelf/inbox/wiki/notes/done-note.md') "---`ncaptured: 2026-08-18T00:00:00Z`nreview: done`n---`n`n# Reviewed Note`n"

        # Declared capture ONLY in _book.md; the catalog entry above carries no Kind line.
        Write-Fixture (Join-Path $fixture 'shelf/quiet/wiki/_book.md') "# Quiet Inbox`n`n- **Kind:** capture`n"
        Write-Fixture (Join-Path $fixture 'shelf/quiet/wiki/notes/quiet-note.md') "---`nreview: pending`n---`n`n# Undeclared Capture Title`n"

        $demo = New-BookManifest -Workspace $fixture -Slug 'demo'

        Assert ($demo.schema -eq 2) 'manifest schema is not 2'
        Assert ($demo.kind -ceq 'curated') 'a curated Book was not reported as curated'
        Assert ($demo.page_metadata -ceq 'full') 'a curated Book withheld its page metadata'
        Assert ($demo.page_count -eq 7) "expected 7 pages, got $($demo.page_count)"
        Assert (($demo.topics -join '|') -ceq 'demo|curated') 'catalog topics were not parsed'
        Assert ($demo.summary -ceq 'A curated demo Book whose summary wraps across two lines, because catalog summaries do.') 'a wrapped catalog summary was parsed one line at a time'

        $plain = @($demo.pages | Where-Object { $_.path -ceq 'topic/plain' })
        Assert ($plain.Count -eq 1) 'the canonical page path is not relative-to-wiki without its extension'
        Assert ($plain[0].title -ceq 'Real Title') 'page title did not come from the first H1'
        $headingText = @($plain[0].headings | ForEach-Object { $_.text })
        Assert ($headingText -ccontains 'A Real Section') 'a real H2 was missed'
        Assert ($headingText -ccontains 'Back Outside') 'a heading after a closed fence was missed'
        Assert (-not ($headingText -ccontains 'Not a heading, this is inside a fence')) 'a backtick-fenced comment was extracted as a heading'
        Assert (-not ($headingText -ccontains 'Also not a heading')) 'a tilde-fenced heading was extracted'
        Assert (@($headingText | Where-Object { $_ -cmatch 'captured:' }).Count -eq 0) 'frontmatter leaked into headings'

        Assert ($null -ne $demo.reader_map) 'a curated Book lost its reader map'
        Assert ($demo.reader_map.links.Count -eq 3) "expected 3 reader-map links, got $($demo.reader_map.links.Count)"
        $labelled = @($demo.reader_map.links | Where-Object { $_.target -ceq '_book' })
        Assert ($labelled[0].label -ceq 'Book metadata') 'a labelled wiki link lost its label'
        $unlabelled = @($demo.reader_map.links | Where-Object { $_.target -ceq 'topic/plain' })
        Assert ($unlabelled[0].label -ceq '') 'an unlabelled wiki link invented a label'

        # --- Schema 2: the upstream roll-up, per ADR-0011 --------------------------------------------
        Assert (@($demo.anchored_upstreams).Count -eq 2) "expected 2 distinct upstreams, got $(@($demo.anchored_upstreams).Count)"
        $rolled = @($demo.anchored_upstreams | ForEach-Object { $_.url })
        Assert ($rolled -ccontains 'https://github.com/obsidianmd/obsidian-help') 'a recorded upstream was not rolled up'
        Assert ($rolled -ccontains 'https://github.com/other/thing') 'a second upstream in one article was not rolled up'
        Assert (@($demo.anchored_upstreams | Where-Object { $_.url -ceq 'https://github.com/obsidianmd/obsidian-help' }).Count -eq 1) `
            'the same upstream cited by two articles was not collapsed to one entry'
        $rolledKeys = @($demo.anchored_upstreams[0].PSObject.Properties | ForEach-Object { $_.Name })
        Assert (($rolledKeys -join ',') -ceq 'url,ref,commit_oid') "the roll-up carried unexpected fields: $($rolledKeys -join ',')"
        $demoJson = $demo | ConvertTo-Json -Depth 8
        Assert ($demoJson -cnotmatch 'raw/obsidian-help') 'the producer-local repo root reached the stored manifest'
        Assert ($demo.anchor_unreadable -eq 1) "expected 1 unreadable anchor page, got $($demo.anchor_unreadable)"

        # A round trip through the store's own serialisation must still validate strictly, because
        # the collection tier reads the manifest back off disk and never from this object.
        $reread = Read-ManifestAnchors ($demoJson | ConvertFrom-Json)
        Assert ($reread.present -and $reread.ok) "a generated manifest's own anchor field did not validate on read: $($reread.reason)"
        Assert (@($reread.upstreams).Count -eq 2) 'a generated manifest lost an upstream through JSON'

        # --- The capture exclusion, which is the reason this file is careful ------------------------
        $inbox = New-BookManifest -Workspace $fixture -Slug 'inbox'
        Assert ($inbox.kind -ceq 'capture') 'a catalog-declared capture Book was not detected'
        Assert ($inbox.page_metadata -ceq 'withheld') 'a capture Book did not withhold page metadata'
        Assert ($inbox.pages.Count -eq 0) 'a capture Book carried page entries'
        Assert ($null -eq $inbox.reader_map) 'a capture Book carried its reader map, which is a list of note titles'
        Assert ($inbox.page_count -eq 2) "expected 2 capture notes, got $($inbox.page_count)"
        Assert ($inbox.pending_count -eq 1) "expected 1 pending note, got $($inbox.pending_count)"

        # The canary asserts the STORED manifest is clean, not merely that a query filtered it.
        $inboxJson = $inbox | ConvertTo-Json -Depth 8
        Assert ($inboxJson -cnotmatch 'Sekrit Capture Title') 'a capture note title reached the stored manifest'
        Assert ($inboxJson -cnotmatch 'secret-note') 'a capture note path reached the stored manifest'
        Assert ($inboxJson -cnotmatch 'Unvetted body') 'capture note body text reached the stored manifest'
        Assert ($inboxJson -cnotmatch 'Reviewed Note') 'a reviewed capture note title reached the stored manifest'
        # The schema-2 canary. The note above carries a real pin, so this proves the exclusion holds
        # over anchor data rather than merely that there was none to leak.
        Assert (@($inbox.anchored_upstreams).Count -eq 0) 'a capture Book carried anchor data'
        Assert ($inbox.anchor_unreadable -eq 0) 'a capture Book scanned its notes for anchors'
        Assert ($inboxJson -cnotmatch 'private-org') 'a capture note''s upstream URL reached the stored manifest'
        Assert ($inboxJson -cnotmatch 'secret-repo') 'a capture note''s repository name reached the stored manifest'
        Assert ($inboxJson -cnotmatch 'Upstream') 'a capture note''s Upstream line reached the stored manifest'

        # The union rule: the catalog says nothing, _book.md says capture, and capture wins.
        $quiet = New-BookManifest -Workspace $fixture -Slug 'quiet'
        Assert ($quiet.kind -ceq 'capture') 'a Book declaring Kind: capture only in _book.md was treated as curated'
        Assert ((($quiet | ConvertTo-Json -Depth 8)) -cnotmatch 'Undeclared Capture Title') 'the union rule failed and a note title leaked'

        # Fail closed on a Book the catalog does not describe at all.
        $refused = $false
        try { New-BookManifest -Workspace $fixture -Slug 'nosuchbook' | Out-Null } catch { $refused = $true }
        Assert $refused 'an uncatalogued Book was generated instead of refused'

        # --- Determinism and freshness --------------------------------------------------------------
        $again = New-BookManifest -Workspace $fixture -Slug 'demo'
        Assert (($demo | ConvertTo-Json -Depth 8) -ceq ($again | ConvertTo-Json -Depth 8)) 'two generations of an unchanged Book differed'
        Assert ($again.source_digest -ceq $demo.source_digest) 'the source digest is not stable across generations'

        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/plain.md') "# Real Title`n`nChanged body.`n"
        $changed = New-BookManifest -Workspace $fixture -Slug 'demo'
        Assert ($changed.source_digest -cne $demo.source_digest) 'a changed page body did not change the source digest'

        Rename-Item -LiteralPath (Join-Path $fixture 'shelf/demo/wiki/topic/plain.md') -NewName 'renamed.md'
        $renamed = New-BookManifest -Workspace $fixture -Slug 'demo'
        Assert ($renamed.source_digest -cne $changed.source_digest) 'a renamed page with identical bytes did not change the source digest'

        # --- Boundaries per 2.5 -----------------------------------------------------------------------
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/caps.md') ("# " + ('x' * 400) + "`n")
        $capped = New-BookManifest -Workspace $fixture -Slug 'demo'
        $capsPage = @($capped.pages | Where-Object { $_.path -ceq 'topic/caps' })[0]
        Assert ($capsPage.title.Length -le 303) "heading text was not capped: $($capsPage.title.Length) characters"
        Assert ($capsPage.title.EndsWith('...')) 'capped text was not marked as truncated'

        $manyHeadings = ((1..250 | ForEach-Object { "# Heading $_" }) -join "`n")
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/many.md') $manyHeadings
        $manyManifest = New-BookManifest -Workspace $fixture -Slug 'demo'
        $manyPage = @($manyManifest.pages | Where-Object { $_.path -ceq 'topic/many' })[0]
        Assert ($manyPage.headings.Count -eq 200) "the per-page heading cap did not hold: $($manyPage.headings.Count)"

        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/control.md') ("# Bad" + [char]7 + "Title`tHere`n")
        $sanitised = New-BookManifest -Workspace $fixture -Slug 'demo'
        $controlPage = @($sanitised.pages | Where-Object { $_.path -ceq 'topic/control' })[0]
        Assert ($controlPage.title -ceq 'Bad Title Here') "control characters were not sanitised: '$($controlPage.title)'"

        # A page with no H1 reports an empty title rather than inventing one from its filename.
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/no-h1.md') "## Only An H2`n"
        $noH1 = New-BookManifest -Workspace $fixture -Slug 'demo'
        $noH1Page = @($noH1.pages | Where-Object { $_.path -ceq 'topic/no-h1' })[0]
        Assert ($noH1Page.title -ceq '') 'a page with no H1 was given an invented title'
        Assert ($noH1Page.headings.Count -eq 1) 'a page with no H1 lost its other headings'
    }
    finally {
        Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($script:failures.Count) {
        [Console]::Error.WriteLine("BookManifest self-test FAILED: $($script:failures -join '; ')")
        exit 1
    }
    Write-Host "BookManifest self-test passed ($($script:checks) checks)."
    exit 0
}
