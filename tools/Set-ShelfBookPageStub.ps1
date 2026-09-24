<#
.SYNOPSIS
    Replace one page of an open, curated Shelf Book with a superseded-stub pointing at the canonical
    copy elsewhere.

.DESCRIPTION
    THE GAP THIS CLOSES. `docs/duplicate-topic-resolution.md` has specified the canonical + stub
    pattern since 2026-08-15, and the 2026-08-15 consolidation applied it across seven topics by
    hand. No tool has ever been able to reproduce it. `Add-ShelfBookPage.ps1` is create-new by
    construction -- "a collision fails rather than overwrites" is the property that lets it apply
    with no plan_id -- so stubbing an EXISTING page meant hand-editing outside `BookWriteGuard.ps1`'s
    lock and journal. That is why a confirmed Shelf/shared duplicate sat unresolved: the finding was
    good and there was no safe way to act on it.

    WHY THIS IS NOT AN OVERWRITE MODE ON Add-ShelfBookPage.ps1. The Project Hub recorded the
    revisit trigger as "a page-overwrite mode for Add-ShelfBookPage.ps1, gated the same way." The
    goal is right and the mechanism is not, for two reasons. First, that helper's whole justification
    for applying directly is that it provably cannot lose text; a mode that overwrites makes the
    justification conditional on a flag, and `.claude/rules/library-development.md` says plainly that
    a write whose damage has to be filtered is not additive. Second, a GENERIC overwrite is a bigger
    capability than any recorded need: it can put arbitrary bytes over arbitrary bytes. This helper
    can only ever write a stub, in the one shape the doc specifies, and the reader can see the whole
    replacement text in the preflight before approving it. Less power, same outcome.

    WHAT IT WRITES. The shape observed in the surviving 2026-08-15 stubs, reproduced exactly: the
    original page's own H1, then a blockquote naming the date, the canonical Book, the canonical
    page, an optional one-line reason, why the stub is kept, and a relative link back to
    `docs/duplicate-topic-resolution.md`. The link depth is computed from how deep the page sits,
    because a stub at wiki/<topic>/<page>.md and one at wiki/<page>.md need different depths and a
    hand-written stub gets that wrong silently.

    IDEMPOTENT BY CONTENT, like the topic writer. A page that already holds exactly these bytes is
    reported `already-stubbed` with no write, no journal, and no manifest generation -- so a retry
    after an interruption is safe. A page holding a DIFFERENT stub is an ordinary change and needs
    the approval like any other.

    GATED, because it destroys text. Preflight, exact plan_id, one approval. The plan_id binds the
    page's current content hash, so a page edited between the preflight and the approval invalidates
    it rather than being overwritten against a stale reading. The Book must also be OPEN on the
    Desk: stubbing is a curatorial act on a curated Book, and the reader should be able to read the
    page before agreeing to replace it.

    WHAT IT REFUSES. A capture Book (those are triaged, not curated). `_book` and `_index`, which
    are the Book's identity and its reader map rather than content -- stubbing either would break the
    Book rather than retire a topic. A page that does not exist, because this helper never creates
    one; that is `Add-ShelfBookPage.ps1`'s job and it stays that way.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BookSlug,
    [Parameter(Mandatory = $true)][string]$PagePath,
    [Parameter(Mandatory = $true)][string]$CanonicalBook,
    [Parameter(Mandatory = $true)][string]$CanonicalPage,
    [string]$Reason,
    [string]$SupersededOn,
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
. (Join-Path $PSScriptRoot 'BookManifestTransaction.ps1')

# Full 64 hex, NOT truncated. Every other gated helper -- Rename-ShelfBook, Invoke-LibraryTriage,
# Archive-ShelfBook, TriagePlanCommon -- binds an approval to the whole digest, and an earlier
# version of this one truncated to 16, making it the only plan_id in the family that looked
# different. The 16-character truncations elsewhere in tools/ are for JOURNAL FILE NAMES, which is a
# different job with a different reason. Reported by the first reader to use both helpers together.
function Get-TextDigest([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text))) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

<#
.SYNOPSIS
    The stub body, from the page's own title and where the topic went.
.DESCRIPTION
    Deterministic on purpose: the idempotence test compares an existing page against exactly these
    bytes, so a body that varied with the clock or with line-wrapping luck would make every retry
    look like a divergent change.
#>
function New-StubBody {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$Date,
        [Parameter(Mandatory = $true)][string]$CanonicalBookTitle,
        [Parameter(Mandatory = $true)][string]$CanonicalPagePath,
        [string]$Because,
        [Parameter(Mandatory = $true)][int]$DocsDepth
    )
    $docsLink = (('../' * $DocsDepth) + 'docs/duplicate-topic-resolution.md')
    $reasonClause = if ([string]::IsNullOrWhiteSpace($Because)) { '' } else { ' -- ' + $Because.Trim().TrimEnd('.') }
    @(
        "# $Title"
        ''
        "> **Superseded $Date.** This topic now lives in the **$CanonicalBookTitle** Book, page"
        "> ``$CanonicalPagePath``$reasonClause. Kept here as a stub so nothing that links to this page"
        "> breaks. See [Duplicate Topic Resolution]($docsLink)."
        ''
    ) -join "`n"
}

# STEP 20: THE WORKSPACE IS SELECTED, NOT ASSUMED. `Split-Path -Parent $PSScriptRoot` answered
# "which workspace" with "one level above my own code", which is right only while the program and
# the workspace are the same directory. Order: -WorkspacePath, then LIBRARY_WORKSPACE, then the
# nearest `.library/workspace.json` above the working directory, then this program's own root --
# and that last one only while the program really is a workspace, which is what keeps an un-split
# checkout working and stops an installed package inventing one. tools/WorkspaceRegistry.ps1.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
$WorkspacePath = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

if ([string]::IsNullOrWhiteSpace($SupersededOn)) { $SupersededOn = (Get-Date).ToString('yyyy-MM-dd') }
if ($SupersededOn -cnotmatch '^\d{4}-\d{2}-\d{2}$') { throw 'SupersededOn must be an ISO date, yyyy-MM-dd.' }

$book = Get-ShelfBook -Workspace $workspace -Slug $BookSlug
if ($book.is_capture) {
    throw "Shelf Book '$BookSlug' is a capture Book. Its notes are triaged with tools/Invoke-LibraryTriage.ps1; the stub pattern is for curated Books."
}
if (-not (Test-Path -LiteralPath $book.wiki_path -PathType Container)) { throw "Shelf Book '$BookSlug' has no pages directory at shelf/$BookSlug/wiki." }
Assert-ShelfBookOpen -Workspace $workspace -Slug $BookSlug -Action 'replacing one of its pages with a stub'

# ConvertTo-BookPagePath is also what refuses _book and _index, at any depth and with an accurate
# message. Stubbing either would break the Book rather than retire a topic, so this helper needs
# that refusal -- and takes it from the one function that owns the rule rather than restating it.
$page = ConvertTo-BookPagePath -Raw $PagePath
$canonicalPageClean = ConvertTo-BookPagePath -Raw $CanonicalPage
if ([string]::IsNullOrWhiteSpace($CanonicalBook)) { throw 'CanonicalBook must name the Book the topic now lives in.' }

$relative = "$page.md"
$fullPath = Join-Path $book.wiki_path ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "shelf/$BookSlug/wiki/$relative does not exist. This helper only ever replaces an existing page; use tools/Add-ShelfBookPage.ps1 to create one."
}

$currentBody = [IO.File]::ReadAllText($fullPath)
# The page keeps its own name. A stub that renamed the topic would break the one thing the stub
# exists to preserve -- a reader arriving from an old link recognising where they landed.
$headingMatch = [regex]::Match($currentBody, '(?m)\A#[ \t]+(.+?)[ \t]*(?:\r?\n|\z)')
$title = if ($headingMatch.Success) { $headingMatch.Groups[1].Value.Trim() } else { (Split-Path -Leaf $page) }
$titleSource = if ($headingMatch.Success) { 'the page''s own H1' } else { 'the page file name (it has no H1)' }

# Depth from the page's directory to the workspace root: shelf/<slug>/wiki is three, plus one for
# every directory the page sits inside. Computed rather than assumed -- the surviving hand-written
# stubs are all at one level of nesting, so a constant would be right by coincidence and wrong for a
# top-level page.
$docsDepth = 3 + @($page -split '/').Count - 1

$stubBody = New-StubBody -Title $title -Date $SupersededOn -CanonicalBookTitle $CanonicalBook `
    -CanonicalPagePath $canonicalPageClean -Because $Reason -DocsDepth $docsDepth

# Idempotence by content, decided BEFORE a plan_id is issued: a retry that needs no write should not
# ask for an approval it does not need.
if ($currentBody -ceq $stubBody) {
    $settled = [ordered]@{
        operation             = 'Stub a Shelf Book page'
        status                = 'already-stubbed'
        book                  = $book.book_root
        page                  = "$($book.book_root)/wiki/$relative"
        canonical_book        = $CanonicalBook
        canonical_page        = $canonicalPageClean
        confirmation_required = $false
        shared_library_write  = $false
        scope                 = 'This page already holds exactly this stub. Nothing was written, journaled, or regenerated.'
    }
    Write-LibraryResult -Result ([pscustomobject]$settled) -Json:$Json
    return
}

$alreadyStub = [regex]::IsMatch($currentBody, '(?m)^>\s+\*\*Superseded\s')
$digestSource = @(
    "book=$($book.book_root)", "page=$relative", "current=$(Get-TextDigest $currentBody)",
    "stub=$(Get-TextDigest $stubBody)"
) -join "`n"
$planId = 'stub-shelf-book-page-' + (Get-TextDigest $digestSource)

$plan = [ordered]@{
    operation             = 'Stub a Shelf Book page'
    book                  = $book.book_root
    book_title            = $book.title
    page                  = "$($book.book_root)/wiki/$relative"
    page_title            = $title
    title_source          = $titleSource
    canonical_book        = $CanonicalBook
    canonical_page        = $canonicalPageClean
    superseded_on         = $SupersededOn
    replacing_characters  = $currentBody.Length
    with_characters       = $stubBody.Length
    page_is_already_a_stub = $alreadyStub
    replacement_text      = $stubBody
    reader_map_action     = 'no change (the page keeps its path, so every existing link still resolves)'
    plan_id               = $planId
    confirmation_required = $true
    recoverable           = $true
    shared_library_write  = $false
    scope                 = 'Replaces the ENTIRE body of this one page with the stub shown above, under the Book''s lock, with the prior body journaled first and a rollback verified by readback. A new Discovery manifest generation is committed in the same window. No other page, the reader map, and the Book Catalog are not changed.'
    next                  = 'Read the page first if you have not. Then rerun with -UserConfirmed and this exact -ApprovedPlanId. The prior body is recoverable from the journal until the next write to this Book.'
}
if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json; return }

if (-not $UserConfirmed) { throw 'The page was not stubbed: review the preflight and rerun with -UserConfirmed.' }
if ($ApprovedPlanId -cne $planId) { throw 'The page was not stubbed: rerun the current preflight and pass its exact plan_id as ApprovedPlanId. A different plan_id means the page, or the stub that would replace it, changed since you approved it.' }

$lock = $null
$journalPath = $null
$mutation = $null
try {
    $lock = Enter-BookLock -Workspace $workspace -BookRoot $book.book_root -TimeoutSeconds $LockTimeoutSeconds

    # Re-read under the lock. The approval was bound to a hash taken before anyone was excluded, so
    # without this the window between preflight and write is exactly the check-then-write race the
    # plan_id is supposed to close.
    $underLock = [IO.File]::ReadAllText($fullPath)
    if ($underLock -cne $currentBody) {
        throw "shelf/$BookSlug/wiki/$relative changed while the approval was being given. Nothing was written; rerun the preflight."
    }

    $mutation = Enter-BookMutation -Workspace $workspace -Slug $book.slug -BookRoot $book.book_root -Reason "Stub page $relative" -Lock $lock

    $journal = Write-BookJournal -Workspace $workspace -BookRoot $book.book_root -Operation "Stub page $relative" -Paths @($fullPath)
    $journalPath = $journal.journal_path

    Write-Utf8 -Path $fullPath -Content $stubBody
    $readback = [IO.File]::ReadAllText($fullPath)
    if ($readback -cne $stubBody) { throw "The stub was written but did not read back identically: $($book.book_root)/wiki/$relative" }

    # Closed last and cannot throw: the stub has landed, and a manifest problem must never unwind
    # into the rollback below and resurrect the body the reader approved replacing.
    $plan.manifest = (Complete-BookMutation -Mutation $mutation).summary
    $mutation = $null

    $plan.status = 'stubbed'
    $plan.journal = $journalPath.Substring($workspace.Length).TrimStart('\', '/').Replace('\', '/')
    $plan.Remove('replacement_text')
    $plan.next = 'The Book is open; read the stub back with mcp__validated-book-reader__read_open_book_page. Record the resolution with tools/Set-TopicOverlap.ps1 if this page was part of a topic overlap.'
}
catch {
    $failure = $_.Exception.Message
    $rollback = 'not required'
    if ($journalPath) {
        try { Restore-BookJournal -JournalPath $journalPath | Out-Null; $rollback = 'complete and verified' }
        catch { $rollback = "FAILED: $($_.Exception.Message)" }
    }
    if ($null -ne $mutation -and -not $rollback.StartsWith('FAILED')) { Undo-BookMutation -Mutation $mutation | Out-Null }
    throw "The page was not stubbed. $failure. Rollback: $rollback."
}
finally {
    if ($null -ne $lock) { Exit-BookLock -Lock $lock }
}

Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
