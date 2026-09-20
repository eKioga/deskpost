<#
.SYNOPSIS
    Rebuild notebook/<slug>/ from a published shared Book, so a Book with no surviving local source
    can be refreshed and currency-checked. Create-only; writes nothing outside notebook/<slug>.

.DESCRIPTION
    Book currency anchoring (PLAN-book-currency.md, step 7). A Refresh rewrites a Book's articles
    from its Notebook source, and a Currency check reads that same source -- so a Book whose
    notebook/<slug>/ is gone can be neither refreshed nor checked. A Notebook Reset is the ordinary
    way it goes: the Reset deliberately clears working knowledge, and the published Book is then the
    only copy of what was written. This rebuilds the source from the Book, against the publication
    journal that recorded what was published.

    IT IS CREATE-ONLY, AND THAT IS WHAT MAKES IT UNGATED. The gate protects writes that lose text or
    leave this machine; this one can do neither. It refuses ANY existing notebook/<slug> -- empty or
    not, file or directory -- rather than replacing it, because an existing Notebook topic holds
    untriaged working knowledge that a "restore" would silently destroy. Refusing an empty one too
    is not pedantry: a directory that exists is a directory something else may be filling, and
    "empty, therefore mine" is a race with a rmdir. Same pattern and same reasoning as
    Sync-RawUpstream.ps1, which is what keeps both out of the gate.

    THE LOCK IS TAKEN BEFORE THE COLLISION IS INSPECTED AND HELD THROUGH READBACK. Enter-BookLock
    over `notebook/<slug>` is exact existing practice rather than a new mechanism --
    Compile-RawBatchToNotebook.ps1 takes the same lock over the same directory class -- and taking
    it after the collision check would leave exactly the window the check exists to close.

    THE BOOK MUST BE OPEN ON THE DESK. Reading a shared Book's pages goes through
    SharedBookSource.ps1, whose own header calls it the Discovery page-enumeration primitive "and
    nothing else". Declaring a second sanctioned use of it is not this helper's ruling to make;
    requiring the Book open removes the question instead. The reader is refreshing that Book anyway,
    and an open Book is readable by CLAUDE.md's own rule. Nothing here surfaces page text in its
    output -- the result names paths and hashes, never bodies.

    THE JOURNAL IS SELECTED BY THE TIMESTAMP INSIDE IT, NOT BY ITS FILENAME. A publication journal
    is named <slug>-<source digest>.json: the digest is not a date, so "the newest by filename" can
    silently verify against a superseded manifest. There are three journals for obsidian-app today.
    Selection is therefore the greatest `timestamp_utc` among journals whose `state` is `complete`,
    ties broken by digest so two journals written in the same tick still order deterministically.

    THE VALIDATION MAPS THROUGH `source`, NOT `path`, AND THIS IS MEASURED. The publisher serialises
    `@($records | Where-Object {$_.source})`, and it gives the generated `_book.md` and `_index.md`
    records a $null source -- so neither is in `planned_records` and requiring them would reject
    every real journal. And `planned_records[].path` is the SHARED path
    (books/<slug>/wiki/...) while `.source` holds the original Notebook one. The page is READ by
    `path` and WRITTEN to `source`.

    COMPLETENESS IS PROVED AGAINST THE JOURNAL'S OWN EXTERNAL DIGEST. "The record set is complete
    against itself" is circular and cannot detect a journal missing one record. The publisher
    computes `source_digest_sha256` as SHA-256 over `"{source}|{sha256}"` joined by newline across
    the records in order, so recomputing that and requiring exact equality detects a dropped, added,
    or reordered record. Verified against the live obsidian-app journals, where it reproduces the
    stored digest byte for byte.

    THE NORMALISATION IS A LOUD PRECONDITION, NOT A BEST EFFORT. A shared page comes back without
    frontmatter and with whatever line endings the server chose, so the body is normalised -- CRLF
    to LF, leading and trailing newlines trimmed, exactly one re-added -- and hashed against the
    journal's own SHA-256. A single mismatch aborts the whole restore with nothing promoted. That
    byte-exactness was only ever empirically observed; here it either holds for every page or the
    restore does not happen.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Book,
    # Override journal selection. Use it to restore from a specific earlier publication; the same
    # validation runs either way, so a hand-picked journal is not a way around the digest check.
    [string]$JournalPath,
    [string]$WorkspacePath,
    # Which seat's Desk this reads. Defaults to LIBRARY_SEAT; there is no default seat, so an
    # unset one is refused rather than guessed at.
    [string]$Seat,
    [string]$McpUrl,
    [string]$ProjectId,
    [int]$LockTimeoutSeconds = 20,
    [int]$TimeoutSeconds = 60,
    [switch]$Preflight,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
. (Join-Path $PSScriptRoot 'NotebookIndex.ps1')
. (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'SearchBoundaries.ps1')
. (Join-Path $PSScriptRoot 'SharedBookSource.ps1')

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

# -cnotmatch, not -notmatch: the rule is lowercase-only and the case-insensitive default would
# accept 'Obsidian-App' and then build a notebook path nothing else will ever match.
if ($Book -cnotmatch '^[a-z0-9][a-z0-9-]*$') { throw 'Book must be a lowercase slug using letters, digits, and hyphens.' }

$utf8 = [Text.UTF8Encoding]::new($false)
function Get-BodyHash([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

# The publisher's own normalisation, reversed onto a page coming back from the server: LF endings,
# no leading or trailing blank lines, exactly one closing newline. This is what a compiled Notebook
# article looks like on disk, and it is what the journal's SHA-256 was taken over.
function ConvertTo-RestoredBody([string]$Text) {
    ([string]$Text).Replace("`r`n", "`n").Trim("`r", "`n") + "`n"
}

# --- The Desk gate ---------------------------------------------------------------------------------

$bookRoot = "books/$Book"
$openRoots = @(Get-SearchOpenBookRoots -DeskStateDirectory (Get-DeskStateDirectory -StateDirectory (Join-Path $workspace '.claude') -Seat $Seat))
if ($bookRoot -cnotin $openRoots) {
    $shelfPath = Join-Path $workspace "shelf/$Book"
    if (Test-Path -LiteralPath $shelfPath -PathType Container) {
        throw "'$Book' is a Shelf Book: its pages are already on local disk, so there is no source to restore. Run tools/Get-BookCurrency.ps1 -Book $Book with the Book open instead."
    }
    # -Kind Book -Slug, which is what Set-VirtualDesk.ps1 actually takes. It has no -Book parameter,
    # so the earlier wording was a repair instruction that could not be followed -- the same defect
    # the currency roll-up's "run -Book <slug>" hint turned out to be on 2026-09-06.
    throw "The shared Book '$Book' is not open on the Desk. Restoring its source reads its pages, so open it first: tools/Set-VirtualDesk.ps1 -Action Open -Kind Book -Slug $Book."
}

# --- Journal selection and validation --------------------------------------------------------------

$journalRoot = Join-Path $workspace 'internal/publication-journals'

function Read-JournalFile([string]$Path) {
    try { return ([IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json) }
    catch { return $null }
}

function Select-PublicationJournal {
    param([string]$Root, [string]$Slug, [string]$Explicit)

    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
        $full = if ([IO.Path]::IsPathRooted($Explicit)) { $Explicit } else { Join-Path $workspace $Explicit }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "No publication journal at '$Explicit'." }
        $candidates = @([pscustomobject]@{ path = $full; body = (Read-JournalFile $full) })
    }
    else {
        if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "This workspace has no internal/publication-journals directory, so no Book source can be restored." }
        $candidates = @(Get-ChildItem -LiteralPath $Root -Filter "$Slug-*.json" -File |
            Sort-Object -Property Name |
            ForEach-Object { [pscustomobject]@{ path = $_.FullName; body = (Read-JournalFile $_.FullName) } })
    }

    # An unparseable journal is skipped rather than fatal -- the same rule the manifest backfill
    # applies -- but a run that finds NOTHING usable says so and names how many it looked at.
    $usable = [Collections.Generic.List[object]]::new()
    foreach ($candidate in $candidates) {
        if ($null -eq $candidate.body) { continue }
        $names = @($candidate.body.PSObject.Properties | ForEach-Object { $_.Name })
        foreach ($required in @('state', 'timestamp_utc', 'book_slug', 'source_digest_sha256', 'planned_records')) {
            if ($names -cnotcontains $required) { $names = @(); break }
        }
        if (-not $names.Count) { continue }
        if ([string]$candidate.body.state -cne 'complete') { continue }
        if ([string]$candidate.body.book_slug -cne $Slug) { continue }
        $when = [DateTime]::MinValue
        if (-not [DateTime]::TryParse([string]$candidate.body.timestamp_utc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$when)) { continue }
        [void]$usable.Add([pscustomobject]@{ path = $candidate.path; body = $candidate.body; when = $when.ToUniversalTime(); digest = [string]$candidate.body.source_digest_sha256 })
    }

    if (-not $usable.Count) {
        throw "No completed publication journal for '$Slug' was found among $(@($candidates).Count) candidate file(s) in internal/publication-journals. A Book published from another machine leaves no journal here, and its source cannot be restored this way."
    }
    # Newest by the timestamp INSIDE the file. The filename embeds a source digest, not a date.
    @($usable | Sort-Object -Property @{ Expression = { $_.when }; Descending = $true }, @{ Expression = { $_.digest } })[0]
}

function Test-CanonicalNotebookSource {
    param([string]$Value, [string]$Slug)

    if ([string]::IsNullOrWhiteSpace($Value)) { return 'a planned record has no source path' }
    if ($Value.IndexOf('\', [StringComparison]::Ordinal) -ge 0) { return "'$Value' is not written with forward slashes" }
    if ($Value.StartsWith('/') -or $Value -cmatch '^[A-Za-z]:') { return "'$Value' is not workspace-relative" }
    $segments = @($Value.Split('/'))
    if ($segments -contains '..' -or $segments -contains '.' -or @($segments | Where-Object { $_ -ceq '' }).Count) { return "'$Value' carries a relative or empty path segment" }
    # A Book PUBLISHED FROM A SHELF BOOK carries journal sources under shelf/<slug>/wiki/, never
    # notebook/<slug>/. That is a whole CLASS this helper cannot serve, not a damaged journal, and
    # it needs saying: the generic refusal below is true as far as it goes, but it reads like
    # corruption and sends the reader hunting for a broken file that is in fact perfectly intact.
    # library-development-design-history is the standing example, recorded in
    # docs/book-currency-anchoring.md and on the library-dev Hub.
    if ($Value.StartsWith('shelf/', [StringComparison]::Ordinal)) {
        return "'$Value' is a Shelf page, so this Book was published from a Shelf Book rather than from notebook/$Slug/. A Book published from the Shelf has no Notebook source to rebuild and no restore route here at all -- its pages are already on local disk under the Shelf Book that published them, and the journal is not at fault"
    }
    if (-not $Value.StartsWith("notebook/$Slug/", [StringComparison]::Ordinal)) { return "'$Value' does not resolve below notebook/$Slug/" }
    if (-not $Value.EndsWith('.md', [StringComparison]::Ordinal)) { return "'$Value' is not a Markdown page" }
    ''
}

function Test-JournalRecords {
    param([object]$Journal, [string]$Slug, [string]$Project)

    $names = @($Journal.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -ccontains 'project_id' -and -not [string]::IsNullOrWhiteSpace($Project)) {
        if ([string]$Journal.project_id -cne $Project) { throw "The journal was written against project '$([string]$Journal.project_id)', not '$Project'." }
    }

    $records = @($Journal.planned_records)
    if (-not $records.Count) { throw 'The journal plans no records; there is nothing to restore.' }

    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $checked = [Collections.Generic.List[object]]::new()
    foreach ($record in $records) {
        $fields = @($record.PSObject.Properties | ForEach-Object { $_.Name })
        foreach ($required in @('path', 'source', 'sha256')) {
            if ($fields -cnotcontains $required) { throw "A planned record is missing its '$required' field." }
        }
        $source = [string]$record.source
        $refusal = Test-CanonicalNotebookSource -Value $source -Slug $Slug
        if ($refusal) { throw "The journal cannot be restored: $refusal." }
        if (-not $seen.Add($source)) { throw "The journal names '$source' more than once." }
        if ([string]$record.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw "The journal record for '$source' carries no usable SHA-256." }
        $shared = [string]$record.path
        if (-not $shared.StartsWith("books/$Slug/wiki/", [StringComparison]::Ordinal) -or -not $shared.EndsWith('.md', [StringComparison]::Ordinal)) {
            throw "The journal record for '$source' names shared page '$shared', which is not a page of books/$Slug."
        }
        [void]$checked.Add([pscustomobject]@{ shared = $shared; source = $source; sha256 = [string]$record.sha256 })
    }

    # The external completeness proof. Recomputed from the records in order, and required to equal
    # the digest the publisher stored -- which detects a dropped, added, or reordered record in a
    # journal that is otherwise perfectly valid JSON.
    $recomputed = Get-BodyHash ((@($checked) | ForEach-Object { "$($_.source)|$($_.sha256)" }) -join "`n")
    $stored = [string]$Journal.source_digest_sha256
    if ($recomputed -cne $stored) {
        throw "The journal's record set does not reproduce its own source digest (recomputed $recomputed, stored $stored). A record has been added, dropped, or reordered, so the restore would be incomplete and nothing was written."
    }
    @($checked)
}

$selected = Select-PublicationJournal -Root $journalRoot -Slug $Book -Explicit $JournalPath
$records = @(Test-JournalRecords -Journal $selected.body -Slug $Book -Project $ProjectId)

$destination = Join-Path $workspace (Join-Path 'notebook' $Book)
$journalRelative = $selected.path.Substring($workspace.Length).TrimStart([IO.Path]::DirectorySeparatorChar).Replace('\', '/')

$plan = [ordered]@{
    operation            = 'Restore Book source'
    book                 = $Book
    book_root            = $bookRoot
    destination          = "notebook/$Book"
    journal              = $journalRelative
    journal_published    = [string]$selected.body.timestamp_utc
    journal_state        = [string]$selected.body.state
    source_digest_sha256 = [string]$selected.body.source_digest_sha256
    page_count           = @($records).Count
    pages                = @(@($records) | ForEach-Object { $_.source })
    destination_exists   = (Test-Path -LiteralPath $destination)
    create_only          = $true
    shared_library_write = $false
}

if ($plan['destination_exists']) {
    $plan['status'] = 'refused'
    $plan['reason'] = "notebook/$Book already exists. This helper is create-only, because replacing a Notebook topic would destroy untriaged working knowledge. Move or archive it first if you really want it rebuilt from the Book."
    if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json; exit 0 }
    throw $plan['reason']
}

if ($Preflight) {
    $plan['status'] = 'ready'
    $plan['next'] = 'Re-run without -Preflight to restore. No page was read and no MCP call was made.'
    Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
    exit 0
}

# --- The write ---------------------------------------------------------------------------------------

# STEP 15b: A NOTEBOOK WRITE IS A MUTATION AND NEEDS THIS SEAT'S LIVE CLAIM. The rule's own
# rationale is the reason it belongs here specifically: an agent launched directly, inheriting a
# LIBRARY_SEAT, would carry no claim yet could still change its Notebook -- and reset would then
# classify genuinely active work as dormant and quarantine it. Checked AFTER the preflight, because
# a preflight is a read and reads are unaffected.
$restoreSeat = Resolve-SeatName -Seat $Seat -StateDirectory (Join-Path $workspace '.claude')
if ($restoreSeat.status -cne 'named') { throw $restoreSeat.message }
Assert-SeatClaimHeld -StateDirectory (Join-Path $workspace '.claude') -Seat $restoreSeat.seat | Out-Null

# The lock comes first, ahead of the collision inspection it protects. Compile-RawBatchToNotebook.ps1
# takes this same lock over this same directory class, so a compile and a restore of one topic
# cannot interleave.
$lock = Enter-BookLock -Workspace $workspace -BookRoot "notebook/$Book" -TimeoutSeconds $LockTimeoutSeconds
$staging = $null
$promoted = $false
try {
    if (Test-Path -LiteralPath $destination) {
        throw "notebook/$Book appeared while this run was starting; nothing was written."
    }
    # A VALID CLAIM AT THIS SEAT IS NOT ENTITLEMENT TO ANOTHER SEAT'S TOPIC (ADR-0019). The topic
    # DIRECTORY is absent here -- that is the line above -- but its ownership row may not be: a reset
    # quarantines the directory and leaves the record, so restoring can still land on material
    # another seat owns. Asserted under the topic lock, which is the only lock under which ownership
    # may now change.
    Assert-NotebookTopicWritable -Workspace $workspace -Topic $Book -Seat $restoreSeat.seat | Out-Null

    Add-Type -AssemblyName System.Net.Http
    $session = New-SharedBookSession -McpUrl $McpUrl -ProjectId $ProjectId -TimeoutSeconds $TimeoutSeconds

    # Staging sits outside notebook/ so a killed run cannot leave a half-restored topic the Notebook
    # index would list as real. Same volume, so promotion is a rename.
    $stagingRoot = Join-Path $workspace 'internal/notebook-staging'
    $staging = Join-Path $stagingRoot ([Guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    $mismatches = [Collections.Generic.List[string]]::new()
    $written = [Collections.Generic.List[object]]::new()
    foreach ($record in $records) {
        $page = Read-SharedNoteExact $session $record.shared
        $body = ConvertTo-RestoredBody ([string]$page.content)
        $hash = Get-BodyHash $body
        if ($hash -cne $record.sha256) {
            # The path is named; the body never is. A mismatch is a provenance failure, not an
            # invitation to print the page into a terminal.
            [void]$mismatches.Add("$($record.source) (published $($record.sha256), rebuilt $hash)")
            continue
        }
        $relative = $record.source.Substring("notebook/$Book/".Length).Replace('/', [IO.Path]::DirectorySeparatorChar)
        $target = Join-Path $staging $relative
        $parent = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        [IO.File]::WriteAllText($target, $body, $utf8)
        [void]$written.Add([pscustomobject]@{ source = $record.source; staged = $target; sha256 = $record.sha256 })
    }

    if ($mismatches.Count) {
        throw ("$($mismatches.Count) of $(@($records).Count) page(s) did not rebuild to the SHA-256 the publication journal recorded, so nothing was written. " +
               "The published Book has been edited in place since it was published, or its line endings no longer match. Mismatched: " +
               ((@($mismatches) | Select-Object -First 5) -join '; '))
    }
    if ($written.Count -ne @($records).Count) { throw 'Not every planned record was staged; nothing was written.' }

    # Readback in staging, before anything is promoted: every file re-read from disk and re-hashed.
    foreach ($entry in $written) {
        $back = Get-BodyHash ([IO.File]::ReadAllText($entry.staged, [Text.UTF8Encoding]::new($false, $true)))
        if ($back -cne $entry.sha256) { throw "Staged page '$($entry.source)' did not read back as written; nothing was promoted." }
    }

    if (Test-Path -LiteralPath $destination) {
        throw "notebook/$Book appeared while its pages were being read; nothing was promoted."
    }
    $notebookRoot = Join-Path $workspace 'notebook'
    if (-not (Test-Path -LiteralPath $notebookRoot -PathType Container)) { throw 'This workspace has no notebook/ directory.' }

    # A TOPIC IS PROMOTED COMPLETE WITH ITS INDEX, OR NOT AT ALL. Whether the journal carries one is
    # not this helper's choice: Publish-BookCopy gives the Book's own generated _book.md and
    # _index.md a $null source, so those are absent from planned_records, while the SOURCE topic's
    # own _index.md is an ordinary page and is restored like any other. When the publication did not
    # include it -- a Book published from a single article, say -- promoting the directory would
    # create exactly the topic-with-no-index the renderer must refuse, and refuse for the whole
    # Notebook. So one is generated here, saying only what is true about where it came from.
    $indexGenerated = $false
    $stagedIndex = Join-Path $staging '_index.md'
    if (-not (Test-Path -LiteralPath $stagedIndex -PathType Leaf)) {
        Write-AtomicText -Path $stagedIndex -Text "# $Book`n`nNotebook source rebuilt from the published Book by tools/Restore-BookSource.ps1. The publication carried no topic index, so this one is generated: its heading is the Book slug, and it lists nothing.`n" | Out-Null
        $indexGenerated = $true
    }
    # Validated BEFORE promotion, so a restored index that cannot be rendered is a refusal with
    # nothing on disk rather than a promoted topic that breaks every other topic's visibility.
    Get-NotebookTopicHeading -IndexPath $stagedIndex | Out-Null

    # THE CRITICAL SECTION. The move, the scan, the atomic master write, the readback. Everything
    # above -- the MCP reads, the hashing, the staged readback -- is already done.
    Invoke-NotebookRender -Workspace $workspace -CommitArgument @($staging, $destination, $Book) -Commit {
        param($From, $To, $Slug)
        if (Test-Path -LiteralPath $To) { throw "notebook/$Slug appeared while the render lock was being taken; nothing was promoted." }
        [IO.Directory]::Move($From, $To)
    } | Out-Null
    # Restore creates a topic too, so it records ownership like the other two writers.
    Set-NotebookTopicOwner -Workspace $workspace -Topic $Book -Seat $restoreSeat.seat
    $promoted = $true

    # And again at the destination. A rename that reported success and moved nothing would otherwise
    # be reported as a restore.
    foreach ($record in $records) {
        $final = Join-Path $workspace ($record.source.Replace('/', [IO.Path]::DirectorySeparatorChar))
        if (-not (Test-Path -LiteralPath $final -PathType Leaf)) { throw "Promoted page '$($record.source)' is not on disk." }
        $back = Get-BodyHash ([IO.File]::ReadAllText($final, [Text.UTF8Encoding]::new($false, $true)))
        if ($back -cne $record.sha256) { throw "Promoted page '$($record.source)' does not match the journal; the restore is incomplete." }
    }

    # THE MASTER INDEX IS NOW WRITTEN, and the reader is no longer asked to add a line by hand. Not
    # a widening of a create-only helper: the master index is derived state, so re-rendering it
    # restates what is on disk rather than editing anything anyone wrote. The old behaviour left a
    # restored topic invisible in the Notebook index until someone remembered to list it.
    $masterPath = Join-Path $workspace 'notebook/_master-index.md'
    $masterLinked = (Test-Path -LiteralPath $masterPath -PathType Leaf) -and
        ([IO.File]::ReadAllText($masterPath)).IndexOf("$Book/_index", [StringComparison]::Ordinal) -ge 0

    $plan['status'] = 'complete'
    $plan['restored_pages'] = @(@($records) | ForEach-Object { $_.source })
    $plan['topic_index_generated'] = $indexGenerated
    $plan['master_index_links_topic'] = $masterLinked
    $plan['next'] = "Check it against its upstreams: tools/Get-BookCurrency.ps1 -Book $Book"
    Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
}
catch {
    # A destination promoted and then found wrong was created by this run and by nothing else -- the
    # lock is still held and the collision check refused any pre-existing directory -- so removing it
    # restores the workspace to what it was rather than losing anything.
    #
    # TWO THINGS THAT SENTENCE DOES NOT COVER, BOTH OF WHICH IT USED TO ASSUME AWAY. The lock keeps
    # other Library writers out; it does not keep every process out, so a `-Recurse -Force` sweep
    # could take a file this run never wrote. Only the promoted records are removed, and the
    # directory only if it is then empty. And the removal was error-suppressed and unverified, so a
    # file held open by another process left a partial Notebook source behind while the message said
    # the restore had been undone. A rollback that did not complete is now named in the failure.
    if ($promoted -and (Test-Path -LiteralPath $destination -PathType Container)) {
        foreach ($record in @($records)) {
            $orphan = Join-Path $workspace ($record.source.Replace('/', [IO.Path]::DirectorySeparatorChar))
            if (Test-Path -LiteralPath $orphan -PathType Leaf) {
                Remove-Item -LiteralPath $orphan -Force -ErrorAction SilentlyContinue
            }
        }
        # Deepest first, so a nested topic directory empties before its parent is considered.
        $carcasses = @(Get-ChildItem -LiteralPath $destination -Directory -Recurse -Force -ErrorAction SilentlyContinue |
                Sort-Object { $_.FullName.Length } -Descending)
        foreach ($carcass in $carcasses) {
            if (-not @(Get-ChildItem -LiteralPath $carcass.FullName -Force -ErrorAction SilentlyContinue).Count) {
                Remove-Item -LiteralPath $carcass.FullName -Force -ErrorAction SilentlyContinue
            }
        }
        if (-not @(Get-ChildItem -LiteralPath $destination -Force -ErrorAction SilentlyContinue).Count) {
            Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $destination) {
            throw ("$($_.Exception.Message) The rollback did not complete: notebook/$Book is still on disk and " +
                   'holds files this run did not remove. Inspect it and remove it yourself before re-running.')
        }
    }
    throw
}
finally {
    if ($null -ne $staging -and -not $promoted -and (Test-Path -LiteralPath $staging)) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
    $stagingRoot = Join-Path $workspace 'internal/notebook-staging'
    if ((Test-Path -LiteralPath $stagingRoot -PathType Container) -and -not @(Get-ChildItem -LiteralPath $stagingRoot -Force -ErrorAction SilentlyContinue).Count) {
        Remove-Item -LiteralPath $stagingRoot -Force -ErrorAction SilentlyContinue
    }
    Exit-BookLock -Lock $lock
}
