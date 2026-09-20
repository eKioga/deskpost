<#
.SYNOPSIS
    Graduate a whole Notebook topic into an open Shelf Book, safely repeatable after an interruption.

.DESCRIPTION
    Item 1.3 of the plan, and Codex Round-1 finding #8: a multi-page "additive" call can fail halfway,
    and a naive retry then creates duplicate suffixed pages. No manifest, journal, collision policy,
    or resume rule existed.

    A BOUND MANIFEST. Preflight enumerates the source articles, hashes each one, and derives its
    target page. The digest covers the Book, every source hash, and every target, so a source edited
    between attempts invalidates the earlier journal instead of resuming against material that has
    since changed.

    A PROGRESS JOURNAL, which is a different artifact from BookWriteGuard's rollback journal and must
    not be mistaken for it. The rollback journal undoes one page's write. This one records what
    already landed so a later process can tell. It is rewritten after every entry, atomically, because
    a journal written only at the end cannot survive the interruption it exists for.

    RESUME, NOT UNDO -- the distinctive shape here, and the reason this writer needs its own fault
    coverage. When a multi-page write is interrupted partway the pages that landed are correct and
    complete, and keeping them is the right outcome; rolling them back would discard finished work to
    no purpose. Only unfinished entries are attempted again. That is the opposite of 1.1 and 1.2,
    whose correct response to a failure is to leave no trace.

    IDEMPOTENCE BY CONTENT. A target that already exists and is byte-identical to what this operation
    would write counts as success -- which is what keeps a retry safe even when the journal itself was
    lost. A target that exists and differs is a divergent collision, and the whole operation is
    refused before any write rather than suffixed around, because suffixing is how the duplicates
    were being made.

    Each page is written by Add-ShelfBookPage.ps1, never by a second implementation: that helper
    already takes the Book's lock, journals the page's prior absence, creates with CreateNew, verifies
    by readback, and handles both reader-map shapes. This one orchestrates and records; it does not
    write pages itself. The lock is therefore taken and released per page, which is what makes an
    interrupted run resumable rather than leaving one long hold behind.

    2.2 RUNG 4 IS INHERITED HERE, NOT DUPLICATED. Because every page goes through Add-ShelfBookPage,
    every page also passes through that helper's manifest mutation window: marker down, page written,
    generation committed, all inside the one per-page lock. A second route from this file would be a
    second implementation of the invariant, which is the thing the delegation to Add-ShelfBookPage
    exists to avoid. The cost is one manifest generation per page rather than one per run, and it is
    the right cost: it is what keeps an interrupted graduation resumable, with every page that landed
    already described by a committed manifest.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BookSlug,
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [string]$PagePrefix,
    [switch]$Recurse,
    [string]$WorkspacePath,
    [int]$LockTimeoutSeconds = 20,
    [switch]$Preflight,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')

$script:TopicJournalSchema = 1

function Get-Sha256Text([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text))
        -join @($bytes | ForEach-Object { $_.ToString('x2') })
    }
    finally { $sha.Dispose() }
}

# Rewritten in full after every entry. A temp file plus a replacing move, so an interruption during
# the write leaves the previous journal intact rather than a truncated one -- a half-written progress
# record is worse than a slightly stale one, because resume trusts it.
function Save-TopicJournal([string]$Path, $Data) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $temp = "$Path.tmp"
    [IO.File]::WriteAllText($temp, ($Data | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $Path -Force
}

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

$book = Get-ShelfBook -Workspace $workspace -Slug $BookSlug
if ($book.is_capture) {
    throw "Shelf Book '$BookSlug' is a capture Book. Use tools/Add-ShelfNote.ps1 for it; this helper graduates curated material into a curated Book."
}
if (-not (Test-Path -LiteralPath $book.wiki_path -PathType Container)) { throw "Shelf Book '$BookSlug' has no pages directory at shelf/$BookSlug/wiki." }
Assert-ShelfBookOpen -Workspace $workspace -Slug $BookSlug -Action 'graduating a topic into it'

$sourceCandidate = if ([IO.Path]::IsPathRooted($SourcePath)) { $SourcePath } else { Join-Path $workspace $SourcePath }
$sourceRoot = [IO.Path]::GetFullPath($sourceCandidate)
if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw "SourcePath is not a directory: $SourcePath" }

$prefix = ''
if (-not [string]::IsNullOrWhiteSpace($PagePrefix)) { $prefix = (ConvertTo-BookPagePath -Raw $PagePrefix) + '/' }

$articles = @(Get-ChildItem -LiteralPath $sourceRoot -File -Filter '*.md' -Recurse:$Recurse | Sort-Object FullName)
if (-not $articles.Count) {
    $hint = if ($Recurse) { '' } else { ' (pass -Recurse to include subfolders)' }
    throw "No .md articles found under $SourcePath$hint."
}

$entries = [Collections.Generic.List[object]]::new()
$skipped = [Collections.Generic.List[object]]::new()
$problems = [Collections.Generic.List[string]]::new()

foreach ($article in $articles) {
    $sourceRelative = $article.FullName.Substring($sourceRoot.Length).TrimStart('\', '/').Replace('\', '/')
    $stem = $sourceRelative.Substring(0, $sourceRelative.Length - 3)

    # A topic index is the Notebook's own map of its articles. Carrying it across would collide with
    # the Book's reader map, which Add-ShelfBookPage refuses by name anyway -- reported, not silent.
    if (@($stem -split '/')[-1] -cin @('_index', '_book')) {
        [void]$skipped.Add([pscustomobject]@{ source = $sourceRelative; reason = "a topic index is the Notebook's own map, not a Book page" })
        continue
    }

    $pagePath = $null
    try { $pagePath = ConvertTo-BookPagePath -Raw ($prefix + $stem) }
    catch { [void]$problems.Add("$sourceRelative -> $($_.Exception.Message)"); continue }

    $raw = [IO.File]::ReadAllText($article.FullName)
    if ([string]::IsNullOrWhiteSpace($raw)) { [void]$problems.Add("$sourceRelative is empty."); continue }

    # No -Title is passed, so an article without a leading H1 is refused by name here rather than
    # given a filename-derived heading. A Book page's title is curatorial; guessing it is not this
    # helper's call to make.
    $rendered = $null
    try { $rendered = ConvertTo-ShelfPageBody -Body $raw -Title '' }
    catch { [void]$problems.Add("$sourceRelative -> $($_.Exception.Message)"); continue }

    $relative = "$pagePath.md"
    $fullPath = Join-Path $book.wiki_path ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
    $state = 'pending'
    if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
        $state = if (([IO.File]::ReadAllText($fullPath)) -ceq $rendered.body) { 'identical' } else { 'divergent' }
    }

    [void]$entries.Add([pscustomobject]@{
        source        = $article.FullName.Substring($workspace.Length).TrimStart('\', '/').Replace('\', '/')
        source_full   = $article.FullName
        source_sha256 = Get-Sha256Text $raw
        page_path     = $pagePath
        page          = "$($book.book_root)/wiki/$relative"
        page_title    = $rendered.title
        state         = $state
    })
}

if ($problems.Count) {
    throw "These articles cannot be graduated as they stand; nothing was written:`n  " + (@($problems) -join "`n  ")
}
if (-not $entries.Count) { throw "Every file under $SourcePath was skipped; there is nothing to graduate." }

$divergent = @($entries | Where-Object { $_.state -ceq 'divergent' })
$identical = @($entries | Where-Object { $_.state -ceq 'identical' })
$pending = @($entries | Where-Object { $_.state -ceq 'pending' })

# The digest binds the whole operation. Any change to a source, a target, or the set itself produces
# a different digest, so a journal from an earlier attempt no longer applies and the run starts clean
# rather than resuming against material that has moved underneath it.
$canonical = @($book.book_root) + @($entries | Sort-Object page | ForEach-Object { "$($_.page)|$($_.source)|$($_.source_sha256)" })
$digest = Get-Sha256Text (($canonical -join "`n") + "`n")
$journalPath = Join-Path $workspace (Join-Path 'internal/graduate-journals' "$($book.slug)-$($digest.Substring(0, 16)).json")

$journal = $null
if (Test-Path -LiteralPath $journalPath -PathType Leaf) {
    # An unreadable or half-written journal is treated as absent rather than fatal. The pages on disk
    # are the real authority, and idempotence by content reaches the same answer without it -- which
    # is the whole reason that second mechanism exists.
    try {
        $loaded = [IO.File]::ReadAllText($journalPath) | ConvertFrom-Json
        # Enumerated rather than read as .Properties.Name: under Set-StrictMode that property throws
        # on an empty member collection instead of yielding nothing, which is how an empty journal
        # would take the whole run down.
        $fields = @($loaded.PSObject.Properties | ForEach-Object { $_.Name })
        if (($fields -ccontains 'digest') -and ($fields -ccontains 'entries') -and ([string]$loaded.digest -ceq $digest)) {
            $journal = $loaded
        }
    }
    catch { $journal = $null }
}
$resumedFrom = @()
if ($null -ne $journal) {
    $resumedFrom = @($journal.entries.PSObject.Properties | Where-Object { [string]$_.Value.status -ceq 'succeeded' } | ForEach-Object { $_.Name })
}

$plan = [ordered]@{
    operation             = 'Graduate a topic into a Shelf Book'
    book                  = $book.book_root
    book_title            = $book.title
    source                = $SourcePath
    pages_total           = $entries.Count
    pages_pending         = $pending.Count
    pages_identical       = $identical.Count
    pages_divergent       = $divergent.Count
    skipped_sources       = $skipped.Count
    manifest_digest       = $digest
    resuming              = ($null -ne $journal)
    already_succeeded     = $resumedFrom.Count
    reader_map_action     = if (Test-GeneratedReaderMap -Path (Join-Path $book.wiki_path '_index.md')) { 'regenerate from the pages on disk, once per page added' } else { 'append each link; this map is curated, so it is not regenerated' }
    reader_map_unlisted   = @(Get-UnlistedBookPages -Book $book).Count
    confirmation_required = $false
    shared_library_write  = $false
    scope                 = 'Creates new pages in this open Shelf Book, each through Add-ShelfBookPage.ps1 and so each with its own Discovery manifest generation. No existing page is changed or removed: an identical page is left alone and a divergent one refuses the whole operation.'
}
if ($skipped.Count) { $plan.skipped = @($skipped) }
if ($divergent.Count) {
    $plan.blocked = $true
    $plan.divergent_pages = @($divergent | ForEach-Object { $_.page })
    $plan.next = 'Each page listed in divergent_pages already exists with different content. Compare them and either update the source to match or choose another -PagePrefix; this helper will not overwrite or suffix.'
}
if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json; return }

if ($divergent.Count) {
    throw "Refused before writing anything: $($divergent.Count) target page(s) already exist with different content -- " + (@($divergent | ForEach-Object { $_.page }) -join ', ') + '. Compare them and either update the source or choose another -PagePrefix.'
}

if ($null -eq $journal) {
    $journal = [pscustomobject]@{
        schema  = $script:TopicJournalSchema
        book    = $book.book_root
        source  = $SourcePath
        digest  = $digest
        started = (Get-Date).ToUniversalTime().ToString('o')
        updated = ''
        entries = [pscustomobject]@{}
    }
}

$addPage = Join-Path $PSScriptRoot 'Add-ShelfBookPage.ps1'
$results = [Collections.Generic.List[object]]::new()

foreach ($entry in $entries) {
    $prior = $null
    $recorded = @($journal.entries.PSObject.Properties | ForEach-Object { $_.Name })
    if ($recorded -ccontains $entry.page) { $prior = $journal.entries.$($entry.page) }

    # Two ways an entry is already done, and both must be honoured. The journal is the fast path; the
    # identical page on disk is the one that still works when the journal was lost with the process.
    if (($null -ne $prior -and [string]$prior.status -ceq 'succeeded') -or $entry.state -ceq 'identical') {
        $outcome = if ($entry.state -ceq 'identical') { 'already present, identical' } else { 'already recorded as added' }
        [void]$results.Add([pscustomobject]@{ page = $entry.page; status = 'succeeded'; detail = $outcome })
        $journal.entries | Add-Member -NotePropertyName $entry.page -NotePropertyValue ([pscustomobject]@{
            status = 'succeeded'; detail = $outcome; at = (Get-Date).ToUniversalTime().ToString('o')
        }) -Force
        $journal.updated = (Get-Date).ToUniversalTime().ToString('o')
        Save-TopicJournal -Path $journalPath -Data $journal
        continue
    }

    $attempts = 1
    if ($null -ne $prior -and @($prior.PSObject.Properties | ForEach-Object { $_.Name }) -ccontains 'attempts') { $attempts = [int]$prior.attempts + 1 }

    try {
        $added = & $addPage -BookSlug $BookSlug -PagePath $entry.page_path -ContentPath $entry.source_full -WorkspacePath $workspace -LockTimeoutSeconds $LockTimeoutSeconds
        [void]$results.Add([pscustomobject]@{ page = $entry.page; status = 'succeeded'; detail = "added ($($added.page_title))" })
        $journal.entries | Add-Member -NotePropertyName $entry.page -NotePropertyValue ([pscustomobject]@{
            status = 'succeeded'; detail = 'added'; attempts = $attempts; at = (Get-Date).ToUniversalTime().ToString('o')
        }) -Force
    }
    catch {
        # Continue rather than stop. Add-ShelfBookPage has already rolled its own page back, so the
        # Book is consistent, and the reader's goal is to graduate what can be graduated -- a later
        # run picks up exactly this entry. The operation is still reported as incomplete below.
        $message = $_.Exception.Message
        [void]$results.Add([pscustomobject]@{ page = $entry.page; status = 'failed'; detail = $message })
        $journal.entries | Add-Member -NotePropertyName $entry.page -NotePropertyValue ([pscustomobject]@{
            status = 'failed'; detail = $message; attempts = $attempts; at = (Get-Date).ToUniversalTime().ToString('o')
        }) -Force
    }

    $journal.updated = (Get-Date).ToUniversalTime().ToString('o')
    Save-TopicJournal -Path $journalPath -Data $journal
}

$succeeded = @($results | Where-Object { $_.status -ceq 'succeeded' })
$failed = @($results | Where-Object { $_.status -ceq 'failed' })

$plan.status = if ($failed.Count) { 'incomplete' } else { 'complete' }
$plan.pages_succeeded = $succeeded.Count
$plan.pages_failed = $failed.Count
$plan.results = @($results)
$plan.journal = $journalPath.Substring($workspace.Length).TrimStart('\', '/').Replace('\', '/')
$plan.reader_map_unlisted = @(Get-UnlistedBookPages -Book $book).Count
$plan.next = if ($failed.Count) {
    "Incomplete: $($failed.Count) of $($entries.Count) page(s) did not land. Fix the cause and run the same command again -- only the unfinished entries are attempted, and the pages already added are left alone."
} else {
    'The Book is open; read the new pages with mcp__validated-book-reader__read_open_book_page.'
}

Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
