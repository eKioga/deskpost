<#
.SYNOPSIS
    Backfill or rebuild the Discovery manifest of every Book in the shared collection, journalled and
    resumable, and prune shared manifest stores whose Books no longer exist.

.DESCRIPTION
    Plan item 2.2, seventh rung -- the last one, and the reason every Discovery answer until now has
    said it covers the local Shelf only. Rung 5 did this for the Shelf; this is its shared twin, and
    the two differ in exactly one thing: where the pages come from. A Shelf Book is read off disk. A
    shared Book's catalog is books/README and its pages arrive over Basic Memory MCP, which is why
    PLAN.md 2.2 keeps this half with the Librarian -- a delegate process has no MCP, so the mechanism
    is absent rather than merely inconvenient.

    IT IS THE SAME MANIFEST. Generation goes through New-SharedBookManifest, which builds the object
    with New-BookManifestFromPages -- the same schema, the same caps from item 2.5, the same capture
    exclusion at write time. Discovery reads both collections through one code path, so a second
    manifest builder would be a second thing to keep identical, and it would drift.

    THE STORE IS NAMESPACED BY COLLECTION. internal/book-manifests/shared/<slug>, beside shelf/.
    Before this rung the store was keyed on the slug alone while the per-Book lock already
    distinguished the two collections, so the two collections were relying on the coincidence that no
    slug appears in both. A collision would have had one Book's manifest answering for another's.

    THE READS ARE AUTHORIZED THE WAY RUNG 5'S ARE. confirmation_required is computed from the SCOPE
    -- true whenever at least one closed Book is in it -- and never from predicted work, because
    deciding authorization from predicted work makes the approval depend on state that can change
    between the preflight and the run. A run without both the preflight's exact plan_id and
    -UserConfirmed is refused before any page body is read.

    THE PREFLIGHT IS ITSELF A DISCLOSURE SURFACE. It names slug, title, kind, open, store_status,
    action, and page_count, and NO page path, page title, or note title, in any mode. Counting pages
    needs a directory listing, so the preflight makes one and shows none of it; a count is not a
    disclosure, and the Desk overview already reports counts.

    A SCHEMA BUMP NEEDS -Rebuild, NOT A DEFAULT PASS. Manifest body schema 2 added the upstream
    roll-up (ADR-0011). A stored schema-1 generation still reads `ok`, so the default mode reports
    it `already current` and never replaces it: the source digest is over PAGE BYTES, and adding a
    field to the manifest does not change them. That is the correct behaviour -- Discovery is
    unaffected by the missing field -- but it means the Currency check's collection tier will keep
    reporting `manifest lacks anchor data` until -Rebuild has run.

    -IncludeArchive BRINGS THE SHARED ARCHIVE IN, AND IT IS THE SAME MANIFEST AGAIN. ADR-0012 made
    archiving a MOVE of a Book's Discovery manifest rather than its retirement, and closed the Shelf
    half; the thirteen archived shared Books were left outside Discovery because generating their
    manifests means reading them over MCP, which is this helper's job and nobody else's. Off by
    default: an archived Book's manifest changes only when it is archived or restored, so the
    ordinary repair is about the active collection.

    THE ARCHIVE'S BOOKS ARE A DIFFERENT COLLECTION, NOT DIFFERENT SLUGS. `books/x` and `archive/x`
    are two Books that share a name, so every identity in this run is a Book ROOT: the store key,
    the lock, the journal entry, and the digest that binds the approval. A slug key would let an
    archived Book's journal entry answer for its active twin, and let a resume skip the wrong one.
    Where the pages are is Split-BookRoot's answer, never a composed path -- composing
    `books/<slug>/wiki` for an archived Book reads the ACTIVE twin and commits a manifest that is
    plausible, complete, and about the wrong Book.

    AN UNREADABLE ARCHIVE INDEX IS FATAL TO -IncludeArchive. Get-SharedArchiveCatalog carries why:
    the roster it writes is what lets Discovery say "the shared archive holds no Books", and writing
    that from a failed read is a confident answer about material nobody asked about.

    A BOOK THAT FAILS DOES NOT TAKE THE PASS DOWN. The mutation window's marker is down before
    generation, so a Book whose read fails halfway is left reading `dirty` -- the truthful answer,
    repaired by a re-run -- while the other twelve carry on. An unreachable NAS at the start is fatal
    because nothing can be read at all; an unreachable Book mid-pass is one dirty Book.
#>
[CmdletBinding()]
param(
    [string]$Book,                       # one slug, to scope the run to a single Book
    [switch]$Rebuild,
    # Bring the shared collection's archive -- archive/<slug> -- into the run as well. Off by
    # default because the ordinary repair is about the active collection, but Discovery covers the
    # archive and REFUSES to claim coverage without a roster, so a missing archived manifest is a
    # real gap in every answer and this is its only repair.
    [switch]$IncludeArchive,
    [string]$WorkspacePath,
    # Which seat's Desk gates this run. Defaults to LIBRARY_SEAT; there is no default seat.
    [string]$Seat,
    [string]$McpUrl,
    [string]$ProjectId,
    [int]$LockTimeoutSeconds = 20,
    [switch]$Preflight,
    [string]$ApprovedPlanId,
    [switch]$UserConfirmed,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'ManifestJournal.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'BookManifestTransaction.ps1')
. (Join-Path $PSScriptRoot 'SharedBookSource.ps1')

$script:SharedRosterSchema = 1

# STEP 20: THE WORKSPACE IS SELECTED, NOT ASSUMED. `Split-Path -Parent $PSScriptRoot` answered
# "which workspace" with "one level above my own code", which is right only while the program and
# the workspace are the same directory. Order: -WorkspacePath, then LIBRARY_WORKSPACE, then the
# nearest `.library/workspace.json` above the working directory, then this program's own root --
# and that last one only while the program really is a workspace, which is what keeps an un-split
# checkout working and stops an installed package inventing one. tools/WorkspaceRegistry.ps1.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
$WorkspacePath = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

$session = New-SharedBookSession -McpUrl $McpUrl -ProjectId $ProjectId
$catalogEntries = @(Get-SharedBookCatalog $session)

# The archive index is read only when the archive is in scope: a run that was not asked about the
# archive must not make a network call about it, and must not touch its store either.
$archiveEntries = @()
if ($IncludeArchive) { $archiveEntries = @(Get-SharedArchiveCatalog $session) }

# Both whole catalogs, kept before -Book narrows the per-Book pass. Prune is a whole-store sweep and
# must be measured against every catalogued Book -- rung 5's first real run found the version of this
# that was not, where a scoped run reported every other Book's store as an orphan candidate.
$allCatalogSlugs = @($catalogEntries | ForEach-Object { $_.slug })
$allArchiveSlugs = @($archiveEntries | ForEach-Object { $_.slug })

if (-not [string]::IsNullOrWhiteSpace($Book)) {
    $narrow = $Book.Trim()
    # -cnotin, not -notin: an approval for one Book list must not silently cover a differently
    # spelled scope, and PowerShell's default membership tests are case-insensitive.
    #
    # Under -IncludeArchive a slug naming only an ARCHIVED Book is a legitimate scope: it is absent
    # from books/README precisely because it is archived, and refusing it would leave the one repair
    # Discovery names for an archived shared Book unreachable through -Book.
    $inArchive = ($narrow -cin $allArchiveSlugs)
    if (($narrow -cnotin $allCatalogSlugs) -and -not $inArchive) {
        $where = if ($IncludeArchive) { 'books/README, and no archived Book of that slug is listed in the archive index' } else { 'books/README' }
        throw "No shared Book '$narrow' is listed in $where."
    }
    $catalogEntries = @($catalogEntries | Where-Object { $_.slug -ceq $narrow })
    $archiveEntries = @($archiveEntries | Where-Object { $_.slug -ceq $narrow })
}

# A missing .open-books file reads as every Book closed, which is the fail-safe direction.
$openRoots = @()
# THIS SEAT'S DESK. The open set decides whether THIS run may read closed content, so taking the
# union would let another seat's open Book supply this run's entitlement.
$openBooksPath = Get-DeskFilePath -StateDirectory (Join-Path $workspace '.claude') -Seat $Seat -Kind 'books'
if (Test-Path -LiteralPath $openBooksPath -PathType Leaf) {
    $openRoots = @(Get-DeskFileEntries -Path $openBooksPath)
}

$mode = if ($Rebuild) { 'rebuild' } else { 'backfill' }
if ($IncludeArchive) { $mode = "$mode+archive" }

# ONE PASS OVER BOTH HALVES, each row carrying the manifest collection it belongs to. The active
# half first, so active material is generated before retired material for the same reason Discovery
# sorts it first. Everything below this loop is collection-blind and reads $_.collection.
$plannedEntries = @(@($catalogEntries | ForEach-Object { [pscustomobject]@{ entry = $_; collection = 'shared' } }) +
                    @($archiveEntries | ForEach-Object { [pscustomobject]@{ entry = $_; collection = 'shared-archive' } }))

$sharedBooks = @()
foreach ($planned in $plannedEntries) {
    $entry = $planned.entry
    # THE SCHEMA SAYS WHERE THE BOOK IS. `archive/<slug>`, not `archive/books/<slug>` and not
    # `shared/_archive/<slug>` -- BookRootSchema owns that map in both directions, and this helper
    # asking it is what keeps an archived Book's manifest from being generated off its active twin.
    $bookRoot = New-BookRootFromManifestCollection $planned.collection $entry.slug
    $status = Get-StoredBookManifest -Workspace $workspace -Slug $entry.slug -Collection $planned.collection
    $action = if ($Rebuild) { 'rebuild' }
              elseif ($status.status -ceq 'missing') { 'backfill' }
              elseif ($status.status -ceq 'ok') { 'already current' }
              else { 'repair' }

    # A directory listing, never a body: this is the preflight's page count and the preflight is
    # read by the reader. The paths themselves are counted and discarded.
    $pageCount = $null
    $listingError = ''
    $pagePaths = $null
    try { $pagePaths = @(Get-SharedBookPagePaths $session $bookRoot); $pageCount = $pagePaths.Count }
    catch { $listingError = $_.Exception.Message }

    $sharedBooks += [pscustomobject]@{
        slug             = $entry.slug
        title            = $entry.title
        # An archived Book carries no summary: the archive index writes an archived DATE where the
        # active catalog writes a description, and archiving removed the entry that held one. The
        # trailer is carried instead, so the preflight can say when the Book was archived.
        summary          = $entry.summary
        trailer          = $entry.trailer
        collection       = $planned.collection
        archived         = ($planned.collection -ceq 'shared-archive')
        book_root        = $bookRoot
        open             = ($bookRoot -cin $openRoots)
        store_status     = $status.status
        store_generation = $status.generation
        store_digest     = $status.source_digest
        action           = $action
        page_count       = $pageCount
        listing_error    = $listingError
        page_paths       = $pagePaths
        decision         = if ($action -ceq 'already current') { 'already current' } else { 'work' }
        outcome          = $null
    }
}

# The digest binds the run: a different mode or a different Book list is a different run and must
# not resume an earlier journal. plan_id is the same digest under the operation's name, so an
# approval for one scope cannot be replayed against another -- nor against the Shelf's operation,
# which carries its own name.
$digestLines = @("mode=$mode") + @($sharedBooks | ForEach-Object { "$($_.slug)|$($_.book_root)" })
$manifestDigest = Get-ManifestSha256Text (($digestLines -join "`n") + "`n")
$planId = 'update-shared-book-manifests-' + $manifestDigest
$journalPath = Join-Path $workspace (Join-Path 'internal/manifest-journals' "shared-$mode-$($manifestDigest.Substring(0, 16)).json")

$journal = Read-ManifestJournal -Path $journalPath -Digest $manifestDigest

# Resume is journal-as-fast-path, store-as-authority, and is disabled under -Rebuild for rung 5's
# reason: the store confirms only the LAST commit, which is exactly what an out-of-band edit leaves
# stale, so resuming a rebuild would skip the very Books the run exists to re-read.
$alreadyCommitted = 0
if ($null -ne $journal -and -not $Rebuild) {
    $recorded = @($journal.entries.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($sharedBook in $sharedBooks) {
        if ($sharedBook.decision -cne 'work') { continue }
        # KEYED ON THE ROOT, NOT THE SLUG. books/x and archive/x are two different Books that share
        # a name, so a slug key would let one overwrite the other's entry and let a resume skip the
        # wrong one. The store is still the authority, so the cost of a key that no longer matches
        # an older journal is a re-generation, never a wrong answer.
        if ($recorded -cnotcontains $sharedBook.book_root) { continue }
        $entry = $journal.entries.$($sharedBook.book_root)
        if ([string]$entry.status -ceq 'committed' -and $sharedBook.store_status -ceq 'ok' -and `
            $null -ne $sharedBook.store_digest -and $sharedBook.store_digest -ceq [string]$entry.source_digest) {
            $sharedBook.decision = 'already committed'
            $alreadyCommitted++
        }
    }
}

# Prune candidates: a store whose slug is absent from its own collection's index. The SECOND signal
# -- the Book's _book page missing from the collection too -- is checked during the run rather than
# here, because confirming it reads a page. Both signals must agree before anything is removed, and
# a store kept for want of the second signal is reported rather than silently skipped.
#
# THE ARCHIVE'S STORE IS SWEPT ONLY WHEN THE ARCHIVE IS IN SCOPE. A run that never read the archive
# index has no evidence about it, and pruning on no evidence is how derived state gets deleted for a
# Book that is merely out of scope. Measured against the FULL index either way, never the
# -Book-narrowed one: rung 5's first real run reported eleven healthy Books as orphan candidates
# because a scoped run measured the sweep against its own narrowed list.
$pruneCandidates = @()
$sweeps = @([pscustomobject]@{ collection = 'shared'; slugs = $allCatalogSlugs })
if ($IncludeArchive) { $sweeps += [pscustomobject]@{ collection = 'shared-archive'; slugs = $allArchiveSlugs } }
foreach ($sweep in $sweeps) {
    $storeRoot = Join-Path $workspace (Join-Path 'internal/book-manifests' $sweep.collection)
    if (-not (Test-Path -LiteralPath $storeRoot -PathType Container)) { continue }
    foreach ($dir in @(Get-ChildItem -LiteralPath $storeRoot -Directory)) {
        if ($sweep.slugs -ccontains $dir.Name) { continue }
        $pruneCandidates += [pscustomobject]@{
            slug       = $dir.Name
            collection = $sweep.collection
            book_root  = (New-BookRootFromManifestCollection $sweep.collection $dir.Name)
        }
    }
}

$booksTotal = $sharedBooks.Count
$booksToWrite = @($sharedBooks | Where-Object { $_.decision -ceq 'work' }).Count
$booksAlreadyCurrent = @($sharedBooks | Where-Object { $_.decision -ceq 'already current' }).Count
$booksClosed = @($sharedBooks | Where-Object { -not $_.open }).Count
$confirmationRequired = ($booksClosed -gt 0)

$plan = [ordered]@{
    operation              = 'Backfill shared collection Book Discovery manifests'
    mode                   = $mode
    collection             = if ($IncludeArchive) { 'shared and shared-archive' } else { 'shared' }
    books_total            = $booksTotal
    books_to_write         = $booksToWrite
    books_already_current  = $booksAlreadyCurrent
    books_closed           = $booksClosed
    archive_in_scope       = [bool]$IncludeArchive
    archive_books_total    = @($sharedBooks | Where-Object { $_.archived }).Count
    prune_candidates       = @($pruneCandidates | ForEach-Object { $_.book_root })
    journal_path           = $journalPath.Substring($workspace.Length).TrimStart('\', '/').Replace('\', '/')
    resuming               = ($null -ne $journal)
    already_committed      = $alreadyCommitted
    manifest_digest        = $manifestDigest
    plan_id                = $planId
    confirmation_required  = $confirmationRequired
    shared_library_write   = $false
    scope                  = 'Reads every page body of every shared Book listed above -- including the closed ones, whose content is otherwise Desk-gated, and the ARCHIVED ones when -IncludeArchive is passed -- over Basic Memory MCP, to generate its Discovery manifest. It writes NOTHING to the shared collection: the only writes are local, under internal/book-manifests/shared/ and internal/book-manifests/shared-archive/, plus this run''s progress journal under internal/manifest-journals/. A manifest store whose Book is in neither its collection''s index nor the shared collection is pruned; the archive''s stores are swept only when -IncludeArchive brought the archive into scope.'
    books                  = @($sharedBooks | ForEach-Object {
        # No page path and no page title, in any mode. A preflight the reader reads is one of the
        # places ADR-0002 exists to keep those out of; a count is not one of them.
        [pscustomobject]@{
            slug         = $_.slug
            # The root, because a slug no longer identifies a Book: books/x and archive/x are two
            # Books, and a reader approving a run must be able to see which one is in it.
            book_root    = $_.book_root
            collection   = $_.collection
            title        = $_.title
            # The shared catalog carries no Kind field, so a Book's kind is not knowable until its
            # own _book page is read -- which is a body read, and therefore after this approval.
            # Stated rather than guessed: guessing 'curated' here is how a capture Book's pages end
            # up in a closed-readable store.
            kind         = 'unknown until generation (the Book''s _book page is the only signal, and reading it needs this approval)'
            open         = $_.open
            store_status = $_.store_status
            action       = $_.action
            page_count   = $_.page_count
            listing      = if ($_.listing_error) { "unreadable: $($_.listing_error)" } else { 'ok' }
        }
    })
}

if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json; return }

# The refusal lands before anything is locked, written, or read as a body: everything above read the
# catalog, the local store, and directory listings only.
if ($confirmationRequired) {
    if (-not $UserConfirmed) { throw 'The shared manifests were not backfilled: review the preflight and rerun with -UserConfirmed.' }
    if ($ApprovedPlanId -cne $planId) { throw 'The shared manifests were not backfilled: rerun the current preflight and pass its exact plan_id as ApprovedPlanId. A different plan_id means the Book set or the mode changed since you approved it.' }
}

if ($null -eq $journal) {
    $journal = New-ManifestJournal -Mode $mode -Digest $manifestDigest -PlanId $planId -ClosedBooksApproved $confirmationRequired
}

foreach ($sharedBook in $sharedBooks) {
    $stamp = (Get-Date).ToUniversalTime().ToString('o')

    if ($sharedBook.decision -cne 'work') {
        $sharedBook.outcome = if ($sharedBook.decision -ceq 'already current') {
            [pscustomobject]@{ status = 'already current'; generation = $sharedBook.store_generation; source_digest = $sharedBook.store_digest; detail = 'no work: the stored manifest is current'; changed = $null }
        }
        else {
            [pscustomobject]@{ status = 'already committed'; generation = $sharedBook.store_generation; source_digest = $sharedBook.store_digest; detail = 'resumed from the journal; the store confirms the committed generation'; changed = $null }
        }
        Set-ManifestJournalEntry $journal $sharedBook.book_root $sharedBook.outcome $stamp
        Save-ManifestJournal -Path $journalPath -Data $journal
        continue
    }

    # Under -Rebuild the product is the digest comparison. Read the committed digest before the
    # window opens, because the window's commit overwrites it.
    $priorDigest = $null
    if ($Rebuild) {
        $prior = Get-StoredBookManifest -Workspace $workspace -Slug $sharedBook.slug -Collection $sharedBook.collection
        $priorDigest = $prior.source_digest
    }

    $lock = $null
    $result = $null
    # Acquired OUTSIDE the window's try, so that ONLY a failure to acquire can be reported as one.
    # New-BookMutationFailure's own comment carries why this is not one try with one catch.
    $acquireError = $null
    try { $lock = Enter-BookLock -Workspace $workspace -BookRoot $sharedBook.book_root -TimeoutSeconds $LockTimeoutSeconds }
    catch { $acquireError = [string]$_.Exception.Message }
    if ($null -ne $acquireError) {
        $failure = New-BookMutationFailure -Slug $sharedBook.slug -Stage 'acquire' -Message $acquireError
        $sharedBook.outcome = [pscustomobject]@{ status = $failure.status; generation = 0; source_digest = $null; detail = $failure.summary; changed = $null }
        Set-ManifestJournalEntry $journal $sharedBook.book_root $sharedBook.outcome $stamp
        Save-ManifestJournal -Path $journalPath -Data $journal
        continue
    }

    try {
        # The marker goes down BEFORE the pages are read, through the sanctioned window: a run
        # interrupted mid-read leaves the Book refusing rather than serving a manifest this pass
        # had already decided was suspect.
        $mutation = Enter-BookMutation -Workspace $workspace -Slug $sharedBook.slug -BookRoot $sharedBook.book_root `
            -Reason $sharedBook.action -Lock $lock -Collection $sharedBook.collection
        try {
            # Generation is the caller's here, unlike the Shelf: this is the one step that needs
            # MCP, and the transaction has no client. A failure inside it is caught right here
            # and reported the way Complete-BookMutation reports one -- marker left down, Book
            # reads dirty, the pass carries on.
            $manifest = New-SharedBookManifest -Session $session -Entry $sharedBook -BookRoot $sharedBook.book_root -PagePaths $sharedBook.page_paths
            $result = Complete-BookMutation -Mutation $mutation -Manifest $manifest
        }
        catch {
            $result = New-BookMutationFailure -Slug $sharedBook.slug -Stage 'commit' -Message ([string]$_.Exception.Message)
        }
    }
    catch {
        $result = New-BookMutationFailure -Slug $sharedBook.slug -Stage 'open' -Message ([string]$_.Exception.Message)
    }
    finally {
        if ($null -ne $lock) { Exit-BookLock -Lock $lock }
    }

    if ($result.status -ceq 'committed') {
        $after = Get-StoredBookManifest -Workspace $workspace -Slug $sharedBook.slug -Collection $sharedBook.collection
        $sharedBook.outcome = [pscustomobject]@{
            status        = 'committed'
            generation    = $after.generation
            source_digest = $after.source_digest
            detail        = "generation $($after.generation) committed"
            changed       = if ($Rebuild) { ($after.source_digest -cne $priorDigest) } else { $null }
        }
    }
    else {
        # Deliberately no Undo-BookMutation: this run cannot vouch for the Book's stored manifest,
        # `dirty` is the truthful answer, and a re-run repairs it.
        $sharedBook.outcome = [pscustomobject]@{ status = 'dirty'; generation = 0; source_digest = $null; detail = $result.summary; changed = $null }
    }
    Set-ManifestJournalEntry $journal $sharedBook.book_root $sharedBook.outcome $stamp
    Save-ManifestJournal -Path $journalPath -Data $journal
}

# Prune on two signals that must agree: absent from books/README, AND absent from the shared
# collection itself. Present in the collection but missing from the catalog is a catalog problem, and
# deleting derived state is the wrong response to a state we do not understand.
$pruned = [Collections.Generic.List[string]]::new()
$keptUnresolved = [Collections.Generic.List[object]]::new()
foreach ($candidate in $pruneCandidates) {
    # The second signal is read at the Book's OWN wiki root, which the schema supplies. Asking
    # books/<slug>/wiki/_book.md about an archived Book would find its active twin's page -- if one
    # exists -- and keep an orphaned archive store forever on the strength of a different Book; if
    # one does not, it would delete on a signal that was never about this Book at all.
    $wikiRoot = (Split-BookRoot $candidate.book_root).wiki_root
    $bookPageExists = $false
    try { Read-SharedNoteExact $session "$wikiRoot/_book.md" | Out-Null; $bookPageExists = $true }
    catch { $bookPageExists = $false }
    if ($bookPageExists) {
        [void]$keptUnresolved.Add([pscustomobject]@{
            slug      = $candidate.slug
            book_root = $candidate.book_root
            reason    = 'the Book exists in the shared collection but is not listed in its index; a catalog problem is not a reason to delete derived state'
        })
        continue
    }
    # -Collection, or this would delete the ACTIVE Book's store for a slug whose ARCHIVED store is
    # the orphan -- the collision the store's collection key exists to prevent, reached from the
    # deletion side.
    Remove-BookManifestStore -Workspace $workspace -Slug $candidate.slug -Collection $candidate.collection | Out-Null
    # A bare slug for the active half, the root for the archived one: the same reporting shape the
    # Shelf half uses, so the two halves of one ladder read alike.
    [void]$pruned.Add($(if ($candidate.collection -ceq 'shared') { $candidate.slug } else { $candidate.book_root }))
}

# The roster: the list of shared Books Discovery is entitled to expect a manifest for. Discovery runs
# offline and has no catalog of its own for either half, so without a roster a shared Book whose
# store is missing would be INVISIBLE rather than unavailable -- the silent-partial answer this whole
# ladder exists to prevent. Written from the FULL index, so a -Book run keeps it complete.
#
# THE ARCHIVE ROSTER IS WRITTEN ONLY WHEN THE ARCHIVE WAS IN SCOPE, and its absence is what makes
# Discovery say the archive is NOT COVERED rather than that it holds no Books. Writing an empty one
# from a run that never read the archive index would turn "we did not look" into "there is nothing
# there" -- the one thing every coverage sentence in Discovery exists to prevent.
function Write-DiscoveryRoster([string]$ManifestCollection, [string[]]$Slugs) {
    $path = Join-Path $workspace (Join-Path (Join-Path 'internal/book-manifests' $ManifestCollection) '_roster.json')
    $roster = [ordered]@{
        schema       = $script:SharedRosterSchema
        generated_utc = (Get-Date).ToUniversalTime().ToString('o')
        books        = @($Slugs | ForEach-Object { [pscustomobject]@{ slug = $_ } })
    }
    Save-ManifestJournal -Path $path -Data ([pscustomobject]$roster)
    $path.Substring($workspace.Length).TrimStart('\', '/').Replace('\', '/')
}

$rosterPaths = @(Write-DiscoveryRoster 'shared' $allCatalogSlugs)
if ($IncludeArchive) { $rosterPaths += (Write-DiscoveryRoster 'shared-archive' $allArchiveSlugs) }

$dirtyCount = @($sharedBooks | Where-Object { $_.outcome.status -ceq 'dirty' }).Count
$resultBooks = @($sharedBooks | ForEach-Object {
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
$plan.stores_kept_unresolved = @($keptUnresolved)
$plan.roster_paths = @($rosterPaths)
$plan.books = $resultBooks

Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
if ($dirtyCount -gt 0) { exit 1 }
