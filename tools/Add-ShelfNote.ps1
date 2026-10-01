[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$ContentPath,
    [string]$Content,
    [string]$BookSlug = 'holding',
    [string]$Tags = '',
    [string]$SourcePaths = '',
    [string]$SourceProject = '',
    [string]$RequireNoteFile = '',
    [string]$CaptureDate = '',
    # PARITY (S73 row 3, capture.note-lands-in-a-capture-enabled-book): the kernel's --why, one
    # closed category, recorded and never required.
    [string]$Why = '',
    # PARITY (S73 row 4): the kernel's --supersedes, which closes the named older note in this Book.
    [string]$Supersedes = '',
    [string]$WorkspacePath,
    [int]$LockTimeoutSeconds = 20,
    [switch]$Preflight,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
. (Join-Path $PSScriptRoot 'BookManifestTransaction.ps1')
# Provenance only. Resolve-SeatName arrives with BookRootSchema.ps1 through ShelfNoteCommon.ps1;
# this adds the conversation record beside it. Neither gates anything here -- see below.
. (Join-Path $PSScriptRoot 'SeatConversation.ps1')

# Capture is deliberately ungated. A note that costs a confirmation stops being written down, and
# nothing here can lose existing material: this helper only ever creates a new page.
if ([string]::IsNullOrWhiteSpace($Title)) { throw 'Title is required.' }
$hasPath = -not [string]::IsNullOrWhiteSpace($ContentPath)
$hasInline = -not [string]::IsNullOrWhiteSpace($Content)
if ($hasPath -and $hasInline) { throw 'Give either -ContentPath or -Content, not both.' }
if (-not $hasPath -and -not $hasInline) { throw 'A note needs a body: pass -ContentPath (preferred for prose) or -Content.' }
# THE DATE THAT NAMES THE NOTE, when a caller planned it (S44). A triage batch binds the note's file name --
# its capture date and slug -- into the approval, and this helper's own preflight is asserted against that
# name; naming it by today instead made every holding action in a batch planned for another date refuse.
# It names the file and nothing else: `captured:` is always the moment of writing.
if (-not [string]::IsNullOrWhiteSpace($CaptureDate)) {
    $parsedDate = [DateTime]::MinValue
    if ($CaptureDate -cnotmatch '^\d{4}-\d{2}-\d{2}$' -or -not [DateTime]::TryParseExact($CaptureDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$parsedDate)) {
        throw "CaptureDate must be a calendar date written yyyy-MM-dd; '$CaptureDate' is not one."
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
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$book = Get-CaptureBook -Workspace $workspace -Slug $BookSlug

# A note body is often a scratch file outside the workspace, so an absolute path is taken as given
# and only a relative one is resolved against the workspace.
$body = if ($hasPath) {
    $candidate = if ([IO.Path]::IsPathRooted($ContentPath)) { $ContentPath } else { Join-Path $workspace $ContentPath }
    $sourceFull = [IO.Path]::GetFullPath($candidate)
    if (-not (Test-Path -LiteralPath $sourceFull -PathType Leaf)) { throw "ContentPath was not found: $ContentPath" }
    [IO.File]::ReadAllText($sourceFull)
} else { $Content }
if ([string]::IsNullOrWhiteSpace($body)) { throw 'The note body is empty; nothing was captured.' }

$whyCategories = @('no-seat', 'no-home', 'needs-yes', 'reset-imminent', 'for-seat')
$Why = $Why.Trim()
if ($PSBoundParameters.ContainsKey('Why') -and $Why -cnotin $whyCategories) { throw "--why must be one of: $($whyCategories -join ', '); '$Why' is not one." }

$capturedAt = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')

# WHICH SEAT WROTE THIS, AND OUT OF WHICH CONVERSATION. Both are RESOLVED, never accepted: there is
# deliberately no -FromSeat parameter, because a field a caller could set would let one agent file a
# report under another seat's name, and the entire value of this field is that the seat reading it
# can trust it.
#
# IT NEVER BLOCKS A CAPTURE, WHICH IS THE WHOLE CONSTRAINT. Capture is ungated and works with no
# seat at all; a note that started requiring one would be a note that stops being written, which is
# the defect this helper exists to prevent. Resolve-SeatName never throws and answers `unset` for a
# seatless session, and the conversation read is wrapped because it touches disk that a fixture or a
# damaged seat may not have.
#
# AN ABSENT SEAT IS AN ABSENT FIELD, not the string 'unknown'. Empty is the real pre-identity value
# here, and a placeholder would be a claim nobody made -- every reader of this frontmatter already
# treats a missing key as missing.
$seatState = Resolve-SeatName -StateDirectory (Join-Path $workspace '.claude')
$fromSeat = if ($seatState.status -ceq 'named') { [string]$seatState.seat } else { '' }
$sessionId = ''
if (-not [string]::IsNullOrWhiteSpace($fromSeat)) {
    try {
        $conversation = Get-SeatConversationRecord -StateDirectory (Join-Path $workspace '.claude') -Seat $fromSeat
        # Only `binding` and `activity` carry an id; `malformed` and `none` do not, and a malformed
        # record is carried as no id rather than as a wrong one.
        $sessionId = [string]$conversation.session_id
    }
    catch { $sessionId = '' }
}

# A NEWER NOTE CLOSES AN OLDER ONE (S73 row 4), as the kernel's capture --supersedes does: it names a
# note, so it needs the Book open and a seat; the note must exist and the seat rule must let this seat
# close it. Both are checked again under the lock.
$Supersedes = ($Supersedes.Trim() -replace '\\', '/') -replace '(?i)\.md$', ''
function Get-SupersededNote {
    $older = @(Get-ShelfNotes -Book $book | Where-Object { $_.page -ceq $Supersedes })[0]
    if ($null -eq $older) { throw "--supersedes names $Supersedes, and Book '$($book.slug)' has no such note. Nothing was captured." }
    Assert-SeatMayCloseNote -Note $older -Book $book -Seat $fromSeat -OtherSeat ''
    $older
}
if ($PSBoundParameters.ContainsKey('Supersedes')) {
    if ($Supersedes -cnotmatch '^notes/[^/]+$') { throw '--supersedes must name a note of this Book as notes/<page>, for example notes/2026-09-29-a-draft.' }
    if (-not $fromSeat) { throw "--supersedes names a note, so it needs a seat. $([string]$seatState.message)".Trim() }
    Assert-ShelfBookOpen -Workspace $workspace -Slug $BookSlug -Action 'closing one of its notes with --supersedes' -Seat $fromSeat
    [void](Get-SupersededNote)
}
else { $Supersedes = '' }

# A body that already leads with its own H1 keeps it, so that heading -- not -Title -- is what the
# page, the reader map, the validated reader, and triage's -MatchText all call this note.
# The filename and the reported title are therefore taken from the same heading: a note filed under
# a title that appears nowhere on its page cannot be found again by the reader who wrote it. The
# detection pattern matches Get-ShelfNotes', so both always read the same title. A heading with no
# letter or digit cannot become a slug, so -Title still stands in for it.
$normalizedBody = $body.TrimEnd()
$bodyHeading = [regex]::Match($normalizedBody, '(?m)\A#\s+(.+?)\s*$')
$keepsOwnHeading = $bodyHeading.Success -and [regex]::IsMatch($bodyHeading.Groups[1].Value, '[a-zA-Z0-9]')
$pageTitle = if ($keepsOwnHeading) { $bodyHeading.Groups[1].Value.Trim() } else { $Title }
$noteSlug = ConvertTo-NoteSlug -Title $pageTitle
$notesPath = $book.notes_path

# Picking a free name is a check-then-write sequence, so on its own it is a race: two sessions
# capturing at once settle on the same name and the second overwrites the first. It is called again
# under the Book's lock below, and the file is created with CreateNew, so a collision fails rather
# than overwrites even if the lock were ever bypassed. This first call only fills in the preflight.
#
# -RequireNoteFile pins the name instead of choosing one. A batch triage binds the exact target
# path into its approval digest, so re-selecting here would let execution write a path the reader
# never approved. Pinned, an occupied name is a refusal rather than a quiet relocation -- which is
# what "fail if the approved write set is no longer writable" has to mean at the point of writing.
function Select-NoteFile([string]$Directory, [string]$Slug) {
    if (-not [string]::IsNullOrWhiteSpace($RequireNoteFile)) {
        if ($RequireNoteFile -cnotmatch '^[a-z0-9][a-z0-9.-]*\.md$') { throw 'RequireNoteFile must be a lowercase Markdown file name.' }
        $pinned = Join-Path $Directory $RequireNoteFile
        if (Test-Path -LiteralPath $pinned) { throw "The approved note path is no longer writable: notes/$RequireNoteFile already exists. Nothing was written." }
        return [pscustomobject]@{ name = $RequireNoteFile; path = $pinned; page = "notes/$([IO.Path]::GetFileNameWithoutExtension($RequireNoteFile))" }
    }
    # THE NAME TAKES THE LOCAL CALENDAR DATE, as a reader would say the day; `captured:` stays the UTC instant
    # (S50, the reader's ruling: an evening capture in UTC-7 was named for the next day).
    $stamp = if ([string]::IsNullOrWhiteSpace($CaptureDate)) { [DateTime]::Now.ToString('yyyy-MM-dd') } else { $CaptureDate }
    $name = "$stamp-$Slug.md"
    $path = Join-Path $Directory $name
    $suffix = 2
    while (Test-Path -LiteralPath $path) {
        $name = "$stamp-$Slug-$suffix.md"
        $path = Join-Path $Directory $name
        $suffix++
    }
    [pscustomobject]@{ name = $name; path = $path; page = "notes/$([IO.Path]::GetFileNameWithoutExtension($name))" }
}

$selected = Select-NoteFile -Directory $notesPath -Slug $noteSlug
$candidate = $selected.path
$notePage = $selected.page

$plan = [ordered]@{
    operation            = 'Capture a Shelf note'
    book                 = $book.book_root
    book_title           = $book.title
    note_page            = "$($book.book_root)/wiki/$notePage"
    note_title           = $pageTitle
    title_source         = if ($keepsOwnHeading) { 'body H1' } else { '-Title' }
    body_characters      = $body.Length
    source               = if ($hasPath) { $ContentPath } else { '(inline)' }
    # Reported so a caller can see what provenance the note will carry BEFORE it is written, and so
    # a seatless capture says so rather than looking like a seat that failed to record.
    from_seat            = $fromSeat
    seat_source          = if ($fromSeat) { [string]$seatState.source } else { [string]$seatState.status }
    session_id           = $sessionId
    confirmation_required = $false
    survives_reset       = $true
    shared_library_write = $false
    scope                = 'Creates one new page under this capture Book, regenerates its reader map, and commits a new Discovery manifest generation in the same locked window. No existing page is read, changed, or removed.'
}
# After session_id, where the kernel's plan says it.
# PARITY (S77 row 4, kickoffs/s77 ruling 3): why_missing only where it helps, as the kernel's capture says it -- never
# for an 'any' Book such as the Report Inbox, and still for a Book with no Closed by: line.
$whyMissingSaid = ([string]$book.closed_by_declared) -cne 'any'
if ($Why) { $plan.Insert(11, 'why', $Why) } elseif ($whyMissingSaid) { $plan.Insert(11, 'why_missing', $true) }
if ($Supersedes) {
    $plan.Insert(12, 'supersedes', $Supersedes)
    $plan.scope = "Creates one new page under this capture Book, regenerates its reader map, and commits a new Discovery manifest generation in the same locked window. It also closes $Supersedes (review: done, reviewed:, superseded_by:), journalled with the new note. Nothing is removed."
}
if ($Preflight) { [pscustomobject]$plan; return }

$frontmatter = @('---', "captured: $capturedAt", 'review: pending')
if (-not [string]::IsNullOrWhiteSpace($fromSeat)) { $frontmatter += "from_seat: $fromSeat" }
if (-not [string]::IsNullOrWhiteSpace($sessionId)) { $frontmatter += "session_id: $sessionId" }
if (-not [string]::IsNullOrWhiteSpace($SourceProject)) { $frontmatter += "source_project: $($SourceProject.Trim())" }
if (-not [string]::IsNullOrWhiteSpace($SourcePaths)) { $frontmatter += "source_paths: $($SourcePaths.Trim())" }
if (-not [string]::IsNullOrWhiteSpace($Tags)) { $frontmatter += "tags: $($Tags.Trim())" }
if ($Why) { $frontmatter += "why: $Why" }
# Always written when given, so the relation is recorded even when the older note was already closed.
if ($Supersedes) { $frontmatter += "supersedes: $Supersedes" }
$frontmatter += '---'

$page = if ($keepsOwnHeading) {
    ($frontmatter -join "`n") + "`n`n" + $normalizedBody + "`n"
} else {
    ($frontmatter -join "`n") + "`n`n# $pageTitle`n`n" + $normalizedBody + "`n"
}

$mapPath = Join-Path $book.wiki_path '_index.md'
$lock = Enter-BookLock -Workspace $workspace -BookRoot $book.book_root -TimeoutSeconds $LockTimeoutSeconds
$journalPath = $null
$mutation = $null
try {
    New-Item -ItemType Directory -Path $notesPath -Force | Out-Null
    # Re-selected while holding the lock. The name chosen for the preflight was chosen with nobody
    # excluded, so another session may have taken it since.
    $selected = Select-NoteFile -Directory $notesPath -Slug $noteSlug
    $candidate = $selected.path
    $notePage = $selected.page
    $plan.note_page = "$($book.book_root)/wiki/$notePage"
    # The older note, again under the lock; its prior bytes are journalled with the new note's.
    $older = if ($Supersedes) { Get-SupersededNote } else { $null }

    # 2.2 rung 4. Opened before the first write, on the lock this helper already holds. A capture
    # Book's manifest carries counts and no note metadata, but the counts are what a closed capture
    # Book discloses, so they go stale exactly as a curated Book's page list would.
    $mutation = Enter-BookMutation -Workspace $workspace -Slug $book.slug -BookRoot $book.book_root -Reason "Capture note $($selected.name)" -Lock $lock

    $journalPaths = if ($null -ne $older) { @($candidate, $mapPath, $older.full_path) } else { @($candidate, $mapPath) }
    $journal = Write-BookJournal -Workspace $workspace -BookRoot $book.book_root -Operation "Capture note $($selected.name)" -Paths $journalPaths
    $journalPath = $journal.journal_path

    $stream = [IO.File]::Open($candidate, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($page)
        $stream.Write($bytes, 0, $bytes.Length)
    }
    finally { $stream.Dispose() }

    $readback = [IO.File]::ReadAllText($candidate)
    if ($readback -cne $page) { throw "The note was written but did not read back identically: $($book.book_root)/wiki/$notePage" }
    # Closed by the newer note; an older note already done is left as it is and said unchanged.
    if ($null -ne $older) {
        if ($older.review -ceq 'done') { $plan.superseded = [pscustomobject][ordered]@{ page = $older.page; status = 'unchanged' } }
        else {
            $olderText = [IO.File]::ReadAllText($older.full_path)
            $closed = [regex]::Replace($olderText, '(?m)^review:\s*.*$', 'review: done', 1)
            $closed = Set-NoteFrontmatterField (Set-NoteFrontmatterField $closed 'reviewed' ([DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))) 'superseded_by' $notePage
            if ($closed -cnotmatch '(?m)^review: done') { throw "$($older.page) has no review field to close." }
            Write-Utf8 $older.full_path $closed
            $plan.superseded = [pscustomobject][ordered]@{ page = $older.page; status = 'closed' }
        }
    }
    # Regenerated inside the same lock. An unlocked rewrite works from a listing that may already be
    # stale, dropping another session's note from the map while leaving its file on disk.
    $counts = Update-ShelfNoteIndex -Book $book

    # Closed last, and it cannot throw: capture is deliberately ungated and must not become fragile.
    # A note that landed stays landed even when its manifest cannot be committed -- the Book reads
    # dirty and Discovery refuses to describe it, which is a rebuild rather than a lost note.
    $manifestSummary = (Complete-BookMutation -Mutation $mutation).summary
    $mutation = $null
}
catch {
    $failure = $_.Exception.Message
    $rollback = 'not required'
    if ($journalPath) {
        try { Restore-BookJournal -JournalPath $journalPath | Out-Null; $rollback = 'complete and verified' }
        catch { $rollback = "FAILED: $($_.Exception.Message)" }
    }
    # Cleared only when the Book is provably back to the state the committed manifest describes.
    if ($null -ne $mutation -and -not $rollback.StartsWith('FAILED')) { Undo-BookMutation -Mutation $mutation | Out-Null }
    throw "The note was not captured. $failure. Rollback: $rollback."
}
finally { Exit-BookLock -Lock $lock }

$plan.status = 'captured'
$plan.captured = $capturedAt
$plan.review = 'pending'
$plan.pending_count = $counts.pending_count
$plan.reader_map = "$($book.book_root)/wiki/_index.md"
$plan.manifest = $manifestSummary
$plan.next = "This Book is closed by default. Open it with tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug $BookSlug when you are ready to review."
if (-not $Why -and $whyMissingSaid) { $plan.next +=" This note records no why. Before the Holding Shelf, try the seat's own Hub (hub edit --mode new-page), a Book, or the Notebook, and record a why category when none of them fits." }
Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
