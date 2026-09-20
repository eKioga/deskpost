<#
.SYNOPSIS
    Backfill or rebuild the Discovery manifest of every Book on the local Shelf, journalled and
    resumable, and prune manifest stores whose Books no longer exist.

.DESCRIPTION
    Plan item 2.2, fifth rung. Rung 4 gave a Shelf Book a manifest the first time something
    mutated it; the Books nothing has touched still read `missing`, and rung 4's own writers
    report "dirty until rebuilt" for a repair that did not exist. This is the pass that fixes both:
    the default mode covers every store state that is not `ok`, and -Rebuild regenerates regardless
    of state, which is the only thing that detects a body edited out of band.

    GENERATION READS BOOK BODIES, AND THIS HELPER IS WHERE READING CLOSED ONES IS AUTHORIZED.
    Every Book in scope is generated -- capture Books included, because their source_digest is
    hashed before the capture branch is reached. A run whose scope holds at least one closed Book
    is therefore refused unless it carries both the preflight's exact plan_id and -UserConfirmed.
    A scope of open Books only proceeds without approval, exactly as a writer needs nothing
    further for an open Book.

    EACH BOOK GOES THROUGH THE MUTATION WINDOW, NOT AROUND IT. Enter-BookMutation's marker goes
    down before generation, so a crash mid-run leaves the Book refusing rather than serving a
    manifest this pass had already decided was suspect. One Book's failure never aborts the run:
    it leaves the marker down and reads `dirty`, which is the truthful answer, and a re-run
    repairs it. A Book locked by another writer is skipped, not failed, and writes nothing -- the
    marker is set inside the lock, so a failure to acquire leaves no trace.

    THE JOURNAL IS A FAST PATH; THE STORE IS THE AUTHORITY. Progress is rewritten in full after
    every Book, atomically, because a journal written only at the end cannot survive the
    interruption it exists for. On a re-run with the same digest, only a journal entry the store
    confirms -- ok, same source_digest -- is trusted. An unreadable, half-written, or absent
    journal is treated as absent and is never fatal.

    A SCHEMA BUMP NEEDS -Rebuild, NOT A DEFAULT PASS. Manifest body schema 2 added the upstream
    roll-up (ADR-0011). A stored schema-1 generation still reads `ok`, so the default mode reports
    it `already current` and never replaces it: the source digest is over PAGE BYTES, and adding a
    field to the manifest does not change them. That is the correct behaviour -- Discovery is
    unaffected by the missing field -- but it means the Currency check's collection tier will keep
    reporting `manifest lacks anchor data` until -Rebuild has run.

    PRUNE IS A WHOLE-STORE SWEEP AND RUNS IN BOTH MODES, EVEN UNDER -Book. A store whose Book is
    in neither the catalog nor shelf/ is an orphan and is removed; a Book on disk but absent from
    the catalog is a catalog problem, and deleting derived state is the wrong response to a state
    we do not understand, so that store is kept and reported unresolved. Both signals must agree
    before anything is removed. Pruning reads no Book body, so it does not itself require the
    closed-content approval; it is listed in the preflight and covered by the one confirmation.
#>
[CmdletBinding()]
param(
    [string]$Book,                       # one slug, to scope the run to a single Book
    [switch]$Rebuild,
    # Bring shelf/_archive/<slug> into the run as well. Off by default because the ordinary repair is
    # about the active Shelf, and an archived Book's manifest changes only when it is archived or
    # restored -- but Discovery covers the archive now, so a missing archived manifest is a real gap
    # with a real repair, and this is it.
    [switch]$IncludeArchive,
    [string]$WorkspacePath,
    # Which seat's Desk gates this run. Defaults to LIBRARY_SEAT; there is no default seat.
    [string]$Seat,
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
. (Join-Path $PSScriptRoot 'ManifestJournal.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'BookManifestTransaction.ps1')

# The same section shape Get-ShelfBook matches, so both always agree about which slugs exist.
# Catalog order is preserved: the per-Book pass runs in the order the reader wrote the catalog.
function Get-CatalogBookSlugs([string]$CatalogText) {
    @([regex]::Matches($CatalogText, '(?m)^\s*-\s+\*\*Path:\*\*\s+shelf/([a-z0-9][a-z0-9-]*)\s*$') | ForEach-Object { $_.Groups[1].Value })
}

# The same counts New-BookManifest reports: every *.md under wiki/ for a curated Book, every note
# directly under notes/ for a capture Book. Directory listings only -- no body is read, so the
# preflight stays a closed-content-safe artefact while still showing the reader a count.
function Get-BookPageCount($ShelfBook) {
    if ($ShelfBook.is_capture) {
        if (-not (Test-Path -LiteralPath $ShelfBook.notes_path -PathType Container)) { return 0 }
        return @(Get-ChildItem -LiteralPath $ShelfBook.notes_path -File -Filter '*.md').Count
    }
    if (-not (Test-Path -LiteralPath $ShelfBook.wiki_path -PathType Container)) { return 0 }
    @(Get-ChildItem -LiteralPath $ShelfBook.wiki_path -File -Recurse -Filter '*.md').Count
}

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

$catalogPath = Join-Path $workspace 'shelf/_catalog.md'
if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw 'This workspace has no local Shelf catalog.' }
$catalogText = [IO.File]::ReadAllText($catalogPath)
$catalogSlugs = @(Get-CatalogBookSlugs $catalogText)
if (-not $catalogSlugs.Count) { throw 'shelf/_catalog.md lists no Shelf Books.' }

# The whole catalog, kept before -Book narrows the per-Book pass. Prune is a whole-store sweep and
# must be measured against every catalogued Book, never against the scoped one: with the scoped list
# the other eleven Books read "absent from the catalog", and only the second fail-closed signal --
# shelf/<slug> present on disk -- stands between `-Book x` and deleting every other Book's store.
# Found 2026-08-19 on the first real run, where a `-Book library-dev` preflight reported eleven
# healthy Books as unresolved.
$allCatalogSlugs = $catalogSlugs

# -cnotin, not -cin: a plan approved for one Book list must not silently cover a differently
# spelled scope, and PowerShell's default membership tests are case-insensitive.
if (-not [string]::IsNullOrWhiteSpace($Book)) {
    $narrow = $Book.Trim()
    # Under -IncludeArchive a slug that names only an ARCHIVED Book is a legitimate scope: it is
    # absent from the catalog precisely because it is archived, and refusing it would leave the one
    # repair Discovery names for an archived Book unreachable through -Book.
    $inArchive = $IncludeArchive -and ((Get-ArchivedShelfBookSlugs -Workspace $workspace) -ccontains $narrow)
    if (($narrow -cnotin $catalogSlugs) -and -not $inArchive) {
        $where = if ($IncludeArchive) { 'shelf/_catalog.md, and no archived Book of that slug exists' } else { 'shelf/_catalog.md' }
        throw "No Shelf Book '$narrow' is listed in $where."
    }
    $catalogSlugs = @($catalogSlugs | Where-Object { $_ -ceq $narrow })
}

# A missing .open-books file reads as every Book closed, which is the fail-safe direction: a Book
# we cannot prove is open must be treated as needing the closed-content approval.
$openRoots = @()
# THIS SEAT'S DESK. The open set decides whether THIS run may read closed content, so taking the
# union would let another seat's open Book supply this run's entitlement.
$openBooksPath = Get-DeskFilePath -StateDirectory (Join-Path $workspace '.claude') -Seat $Seat -Kind 'books'
if (Test-Path -LiteralPath $openBooksPath -PathType Leaf) {
    $openRoots = @(Get-DeskFileEntries -Path $openBooksPath)
}

$mode = if ($Rebuild) { 'rebuild' } else { 'backfill' }
if ($IncludeArchive) { $mode = "$mode+archive" }

# The archive's roster is the directory, not a file: see Get-ArchivedShelfBookSlugs. -Book narrows it
# the same way it narrows the catalog, and a slug that names neither is refused by the check above.
$archiveSlugs = @()
if ($IncludeArchive) {
    $archiveSlugs = @(Get-ArchivedShelfBookSlugs -Workspace $workspace)
    if (-not [string]::IsNullOrWhiteSpace($Book)) { $archiveSlugs = @($archiveSlugs | Where-Object { $_ -ceq $Book.Trim() }) }
}

$shelfBooks = @()
foreach ($entry in @(@($catalogSlugs | ForEach-Object { [pscustomobject]@{ slug = $_; collection = 'shelf' } }) +
                     @($archiveSlugs | ForEach-Object { [pscustomobject]@{ slug = $_; collection = 'shelf-archive' } }))) {
    $slug = $entry.slug
    $isArchived = ($entry.collection -ceq 'shelf-archive')
    # An archived Book is absent from shelf/_catalog.md by design, so it is resolved from the record
    # the archiver stored rather than from the catalog. Same object either way, so everything below
    # this line is collection-blind.
    $shelfBook = if ($isArchived) { Get-ArchivedShelfBook -Workspace $workspace -Slug $slug }
                 else { Get-ShelfBook -Workspace $workspace -Slug $slug }
    $status = Get-StoredBookManifest -Workspace $workspace -Slug $slug -Collection $entry.collection
    # The default mode covers every state that is not `ok`, not only `missing`: rung 4's writers
    # report "dirty until rebuilt" on a manifest failure, and the plain run is that repair.
    $action = if ($Rebuild) { 'rebuild' }
              elseif ($status.status -ceq 'missing') { 'backfill' }
              elseif ($status.status -ceq 'ok') { 'already current' }
              else { 'repair' }
    $shelfBooks += [pscustomobject]@{
        slug              = $shelfBook.slug
        title             = $shelfBook.title
        book_root         = $shelfBook.book_root
        collection        = $entry.collection
        archived          = $isArchived
        # Carried because an archived Book's manifest is generated from THIS row rather than resolved
        # again by slug -- and a row missing them fails inside the mutation window, where the message
        # surfaces as "the mutation window would not open" and points nowhere near the cause.
        summary           = $shelfBook.summary
        topics            = @($shelfBook.topics)
        kind              = if ($shelfBook.is_capture) { 'capture' } else { 'curated' }
        open              = ($shelfBook.book_root -cin $openRoots)
        wiki_path         = $shelfBook.wiki_path
        notes_path        = $shelfBook.notes_path
        is_capture        = $shelfBook.is_capture
        store_status      = $status.status
        store_generation  = $status.generation
        store_digest      = $status.source_digest
        action            = $action
        page_count        = (Get-BookPageCount $shelfBook)
        decision          = if ($action -ceq 'already current') { 'already current' } else { 'work' }
        outcome           = $null
    }
}

# The digest binds the run: a different mode or a different Book list is a different run and must
# not resume an earlier journal. plan_id is the same digest under the operation's name, so an
# approval for one scope cannot be replayed against another.
$digestLines = @("mode=$mode") + @($shelfBooks | ForEach-Object { "$($_.slug)|$($_.book_root)" })
$manifestDigest = Get-ManifestSha256Text (($digestLines -join "`n") + "`n")
$planId = 'update-book-manifests-' + $manifestDigest
$journalPath = Join-Path $workspace (Join-Path 'internal/manifest-journals' "$mode-$($manifestDigest.Substring(0, 16)).json")

# An unreadable or half-written journal is treated as absent rather than fatal. The store on disk is
# the real authority and reaches the same answer without it -- the same two-mechanism shape as
# Add-ShelfBookTopic, for the same reason.
$journal = Read-ManifestJournal -Path $journalPath -Digest $manifestDigest

# Resume is journal-as-fast-path, store-as-authority: a `committed` entry is skipped only when
# the store -- which reads no body -- still reads ok with the same source_digest. Otherwise the
# Book is attempted again. Under -Rebuild the fast path does NOT apply: a rebuild run is the
# diagnostic that exists to re-read every Book, and the store confirms only the LAST commit,
# which is exactly what an out-of-band edit leaves stale -- resuming would skip the very Books
# the run exists to re-check.
$alreadyCommitted = 0
if ($null -ne $journal -and -not $Rebuild) {
    foreach ($shelfBook in $shelfBooks) {
        if ($shelfBook.decision -cne 'work') { continue }
        # KEYED ON THE ROOT, NOT THE SLUG. shelf/x and shelf/_archive/x are two different Books that
        # share a name, so a slug key would let one overwrite the other's entry and let a resume skip
        # the wrong one. The store is still the authority, so the cost of a key that no longer matches
        # an older journal is a re-generation, never a wrong answer.
        $recorded = @($journal.entries.PSObject.Properties | ForEach-Object { $_.Name })
        if ($recorded -cnotcontains $shelfBook.book_root) { continue }
        $entry = $journal.entries.$($shelfBook.book_root)
        if ([string]$entry.status -ceq 'committed' -and $shelfBook.store_status -ceq 'ok' -and `
            $null -ne $shelfBook.store_digest -and $shelfBook.store_digest -ceq [string]$entry.source_digest) {
            $shelfBook.decision = 'already committed'
            $alreadyCommitted++
        }
    }
}

# The prune plan is a whole-store sweep even when -Book scoped the per-Book pass: scoping it to
# one Book would mean the orphan is only ever found by a full run. It reads no Book body, so the
# listing is safe to show in the preflight.
$storesToPrune = @()
$storesKept = [Collections.Generic.List[object]]::new()
# Rung 7 namespaced the store by collection, so the sweep walks internal/book-manifests/shelf/ and
# nothing else. A Shelf run that walked the whole root would measure the shared collection's stores
# against the Shelf catalog, find every one of them absent, and be held back only by the second
# fail-closed signal -- the same shape as the -Book scoping defect the first real run found.
$storeRoot = Join-Path $workspace 'internal/book-manifests/shelf'
if (Test-Path -LiteralPath $storeRoot -PathType Container) {
    foreach ($dir in @(Get-ChildItem -LiteralPath $storeRoot -Directory)) {
        if ($allCatalogSlugs -ccontains $dir.Name) { continue }
        if (Test-Path -LiteralPath (Join-Path $workspace "shelf/$($dir.Name)") -PathType Container) {
            [void]$storesKept.Add([pscustomobject]@{
                slug   = $dir.Name
                reason = 'the Book exists under shelf/ but is not in shelf/_catalog.md; a catalog problem is not a reason to delete derived state'
            })
        }
        else {
            $storesToPrune += $dir.Name
        }
    }
}

# THE ARCHIVE STORE IS SWEPT ONLY WHEN THE ARCHIVE IS IN SCOPE. A run that never looked at
# shelf/_archive/ has no evidence about it, and pruning on no evidence is how derived state gets
# deleted for a Book that is simply out of scope. Measured against the FULL archive roster, never the
# -Book-narrowed one -- the same trap the comment above records from the catalog's first real run.
$archiveStoresToPrune = @()
if ($IncludeArchive) {
    $allArchiveSlugs = @(Get-ArchivedShelfBookSlugs -Workspace $workspace)
    $archiveStoreRoot = Join-Path $workspace 'internal/book-manifests/shelf-archive'
    if (Test-Path -LiteralPath $archiveStoreRoot -PathType Container) {
        foreach ($dir in @(Get-ChildItem -LiteralPath $archiveStoreRoot -Directory)) {
            if ($allArchiveSlugs -ccontains $dir.Name) { continue }
            # One signal is enough here, and it is the same signal: Get-ArchivedShelfBookSlugs already
            # requires BOTH the directory and its _archived.json, so a Book absent from that list has
            # no archive record at all and nothing this store could still be describing.
            $archiveStoresToPrune += $dir.Name
        }
    }
}

$booksTotal = $shelfBooks.Count
$booksToWrite = @($shelfBooks | Where-Object { $_.decision -ceq 'work' }).Count
$booksAlreadyCurrent = @($shelfBooks | Where-Object { $_.decision -ceq 'already current' }).Count
$booksClosed = @($shelfBooks | Where-Object { -not $_.open }).Count
$confirmationRequired = ($booksClosed -gt 0)

$plan = [ordered]@{
    operation              = 'Backfill Shelf Book Discovery manifests'
    mode                   = $mode
    books_total            = $booksTotal
    books_to_write         = $booksToWrite
    books_already_current  = $booksAlreadyCurrent
    books_closed           = $booksClosed
    stores_to_prune        = @(@($storesToPrune) + @($archiveStoresToPrune | ForEach-Object { "shelf/_archive/$_" }))
    archive_in_scope       = [bool]$IncludeArchive
    archive_books_total    = $archiveSlugs.Count
    stores_kept_unresolved = @($storesKept)
    journal_path           = $journalPath.Substring($workspace.Length).TrimStart('\', '/').Replace('\', '/')
    resuming               = ($null -ne $journal)
    already_committed      = $alreadyCommitted
    manifest_digest        = $manifestDigest
    plan_id                = $planId
    confirmation_required  = $confirmationRequired
    shared_library_write   = $false
    scope                  = 'Reads the bodies of every Book listed above -- including the closed ones, whose content is otherwise Desk-gated -- to generate its Discovery manifest, and writes only catalog-class metadata under internal/book-manifests/, plus this run''s progress journal under internal/manifest-journals/. Manifest stores whose Books appear in neither the catalog nor shelf/ are pruned.'
    books                  = @($shelfBooks | ForEach-Object {
        # No page path, no page title, no note title, in any mode: a capture Book's note titles
        # are the thing ADR-0002 keeps out of closed-readable places, and a preflight the reader
        # reads is one of those places. A count is fine -- the Desk overview already reports counts.
        [pscustomobject]@{
            slug         = $_.slug
            book_root    = $_.book_root
            title        = $_.title
            kind         = $_.kind
            archived     = $_.archived
            open         = $_.open
            store_status = $_.store_status
            action       = $_.action
            page_count   = $_.page_count
        }
    })
}

if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json; return }

# The refusal lands before anything is locked or written, and before any Book body is read: the
# plan above read only the catalog, the store, and directory listings. A plan_id that no longer
# matches means the Book set or the mode changed after the reader approved it.
if ($confirmationRequired) {
    if (-not $UserConfirmed) { throw 'The manifests were not backfilled: review the preflight and rerun with -UserConfirmed.' }
    if ($ApprovedPlanId -cne $planId) { throw 'The manifests were not backfilled: rerun the current preflight and pass its exact plan_id as ApprovedPlanId. A different plan_id means the Book set or the mode changed since you approved it.' }
}

if ($null -eq $journal) {
    $journal = New-ManifestJournal -Mode $mode -Digest $manifestDigest -PlanId $planId -ClosedBooksApproved $confirmationRequired
}

foreach ($shelfBook in $shelfBooks) {
    $stamp = (Get-Date).ToUniversalTime().ToString('o')

    if ($shelfBook.decision -cne 'work') {
        # No work either way, but the journal records both so a later run can see what happened.
        $shelfBook.outcome = if ($shelfBook.decision -ceq 'already current') {
            [pscustomobject]@{ status = 'already current'; generation = $shelfBook.store_generation; source_digest = $shelfBook.store_digest; detail = 'no work: the stored manifest is current'; changed = $null }
        }
        else {
            [pscustomobject]@{ status = 'already committed'; generation = $shelfBook.store_generation; source_digest = $shelfBook.store_digest; detail = 'resumed from the journal; the store confirms the committed generation'; changed = $null }
        }
        Set-ManifestJournalEntry $journal $shelfBook.book_root $shelfBook.outcome $stamp
        Save-ManifestJournal -Path $journalPath -Data $journal
        continue
    }

    # Under -Rebuild the product is the digest comparison: which Books were edited out of band is
    # a question nothing else in the Library can answer. Read the committed digest before the
    # window opens, because the window's commit overwrites it.
    $priorDigest = $null
    if ($Rebuild) {
        $prior = Get-StoredBookManifest -Workspace $workspace -Slug $shelfBook.slug -Collection $shelfBook.collection
        $priorDigest = $prior.source_digest
    }

    $lock = $null
    $result = $null
    # Acquired OUTSIDE the window's try, so that ONLY a failure to acquire can be reported as one.
    # New-BookMutationFailure's own comment carries why this is not one try with one catch.
    $acquireError = $null
    try { $lock = Enter-BookLock -Workspace $workspace -BookRoot $shelfBook.book_root -TimeoutSeconds $LockTimeoutSeconds }
    catch { $acquireError = [string]$_.Exception.Message }
    if ($null -ne $acquireError) {
        $failure = New-BookMutationFailure -Slug $shelfBook.slug -Stage 'acquire' -Message $acquireError
        $shelfBook.outcome = [pscustomobject]@{ status = $failure.status; generation = 0; source_digest = $null; detail = $failure.summary; changed = $null }
        Set-ManifestJournalEntry $journal $shelfBook.book_root $shelfBook.outcome $stamp
        Save-ManifestJournal -Path $journalPath -Data $journal
        continue
    }

    try {
        # The marker goes down before generation, through the sanctioned window -- never
        # through Save-BookManifest directly. A crash mid-generation leaves the Book refusing
        # rather than serving a manifest this pass had already decided was suspect.
        $mutation = Enter-BookMutation -Workspace $workspace -Slug $shelfBook.slug -BookRoot $shelfBook.book_root -Reason $shelfBook.action -Lock $lock -Collection $shelfBook.collection
        # Complete-BookMutation never throws by contract, so the catch below is Enter-BookMutation's.
        # An ARCHIVED Book's manifest is generated HERE and passed in: the transaction refuses to
        # self-generate for any collection but the active Shelf, because New-BookManifest resolves a
        # slug through shelf/_catalog.md and an archived Book is deliberately absent from it.
        $generated = if ($shelfBook.archived) { New-BookManifestForShelfBook -Book $shelfBook } else { $null }
        $result = Complete-BookMutation -Mutation $mutation -Manifest $generated
    }
    catch {
        $result = New-BookMutationFailure -Slug $shelfBook.slug -Stage 'open' -Message ([string]$_.Exception.Message)
    }
    finally {
        if ($null -ne $lock) { Exit-BookLock -Lock $lock }
    }

    if ($result.status -ceq 'committed') {
        $after = Get-StoredBookManifest -Workspace $workspace -Slug $shelfBook.slug -Collection $shelfBook.collection
        $shelfBook.outcome = [pscustomobject]@{
            status        = 'committed'
            generation    = $after.generation
            source_digest = $after.source_digest
            detail        = "generation $($after.generation) committed"
            changed       = if ($Rebuild) { ($after.source_digest -cne $priorDigest) } else { $null }
        }
    }
    else {
        # Deliberately no Undo-BookMutation and no marker clearing: the run cannot vouch for this
        # Book's stored manifest, `dirty` is the truthful answer, and a re-run repairs it.
        $shelfBook.outcome = [pscustomobject]@{ status = 'dirty'; generation = 0; source_digest = $null; detail = $result.summary; changed = $null }
    }
    Set-ManifestJournalEntry $journal $shelfBook.book_root $shelfBook.outcome $stamp
    Save-ManifestJournal -Path $journalPath -Data $journal
}

# Prune after the per-Book pass, over the exact list the preflight showed. Remove-BookManifestStore
# removes the whole directory -- marker, generations, and pointer -- because half a store is a
# state the read path would have to classify for a Book that is not there.
$pruned = [Collections.Generic.List[string]]::new()
foreach ($slug in $storesToPrune) {
    Remove-BookManifestStore -Workspace $workspace -Slug $slug | Out-Null
    [void]$pruned.Add($slug)
}
foreach ($slug in $archiveStoresToPrune) {
    # -Collection, or this would delete the ACTIVE Book's store for a slug whose ARCHIVED store is
    # the orphan -- the collision the store's collection key exists to prevent, reached from the
    # deletion side.
    Remove-BookManifestStore -Workspace $workspace -Slug $slug -Collection 'shelf-archive' | Out-Null
    [void]$pruned.Add("shelf/_archive/$slug")
}

$dirtyCount = @($shelfBooks | Where-Object { $_.outcome.status -ceq 'dirty' }).Count
$resultBooks = @($shelfBooks | ForEach-Object {
    $entry = [ordered]@{
        slug       = $_.slug
        book_root  = $_.book_root
        action     = $_.action
        status     = $_.outcome.status
        generation = $_.outcome.generation
        detail     = $_.outcome.detail
    }
    if ($Rebuild) { $entry.changed = $_.outcome.changed }
    [pscustomobject]$entry
})

$plan.status = if ($dirtyCount -gt 0) { 'incomplete' } else { 'complete' }
$plan.dirty_books = $dirtyCount
$plan.pruned = @($pruned)
$plan.books = $resultBooks

Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
if ($dirtyCount -gt 0) { exit 1 }
