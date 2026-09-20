[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Open', 'Close', 'Clear', 'List')]
    [string]$Action,
    [ValidateSet('Book', 'Project')]
    [string]$Kind = 'Book',
    [ValidateSet('Shared', 'Shelf')]
    [string]$Location = 'Shared',
    [ValidateSet('Active', 'Archive')]
    [string]$Shelf = 'Active',
    [string]$Slug,
    [string]$WorkspacePath,
    [string]$Seat,
    # The launcher exports this; a test that holds a claim passes its token explicitly. Reads never
    # need it -- -Action List is exempt below.
    [string]$ClaimToken,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
# The Book-root shape lives in ONE file (plan item 3.2). This script used to carry its own copy of
# ConvertTo-BookRoot, and so did the reader adapter, all three hooks, and Get-DeskOverview.ps1.
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')

function Read-StateLines([string]$Path, [string]$Pattern, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Write-AtomicText -Path $Path -Text '' | Out-Null
        return @()
    }
    $items = @(Get-DeskFileEntries -Path $Path)
    foreach ($item in $items) { if ($item -cnotmatch $Pattern) { throw "Virtual Desk $Label state is malformed." } }
    if (@($items | Select-Object -Unique).Count -ne $items.Count) { throw "Virtual Desk $Label state contains duplicates." }
    $items
}

function Write-StateLines([string]$Path, [string[]]$Items) {
    $body = if ($Items.Count) { ($Items -join [Environment]::NewLine) + [Environment]::NewLine } else { '' }
    # PUBLISHED BY RENAME, NOT TRUNCATED IN PLACE (2026-09-18). The registry lock this helper takes is
    # not a substitute and never was: it serialises WRITERS, and every Desk READER holds no lock at
    # all -- three of them are hooks, which is where an empty-looking Desk turns into a denied tool
    # call with no explanation. A truncating WriteAllText leaves the file zero-length for the width of
    # a write, and the reader in that window believes it.
    Write-AtomicText -Path $Path -Text $body | Out-Null
}

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$stateDirectory = Join-Path $workspace '.claude'
$projectPath = Join-Path $stateDirectory '.library-project'

# THE DESK BELONGS TO A SEAT, and there is no default one. This helper is the canonical Desk writer,
# so it is also the place a missing seat is felt first and has to say the most useful thing.
$seatState = Resolve-SeatName -Seat $Seat -StateDirectory $stateDirectory
if ($seatState.status -cne 'named') { throw $seatState.message }
$seatName = $seatState.seat
$deskDirectory = Get-DeskStateDirectory -StateDirectory $stateDirectory -Seat $seatName
$openBooksPath = Get-DeskFileInDirectory -DeskDirectory $deskDirectory -Kind 'books'
$openProjectsPath = Get-DeskFileInDirectory -DeskDirectory $deskDirectory -Kind 'projects'
if (-not (Test-Path -LiteralPath $projectPath -PathType Leaf) -or -not (Test-Path -LiteralPath $openBooksPath -PathType Leaf)) { throw 'Virtual Desk is not configured in this workspace.' }
if ((Get-Content -LiteralPath $projectPath -Raw).Trim() -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'Virtual Desk project pin is malformed.' }

# EVERY DESK MUTATION IS SERIALIZED, AND IT WAS NOT BEFORE. This helper took no lock at all, so a
# cross-seat sweep (rename, archive, remove) could scan the Desks while this one was rewriting its
# own -- check-then-act across two processes. The registry/Desk lock is the FIRST class in the total
# order, so taking it here is always safe.
#
# -Action List is a READ and takes neither the lock nor a claim; it is how a session with no claim
# still sees what is open.
$deskLock = $null
if ($Action -ne 'List') {
    # Step 15b: a mutator requires a matching live claim. Checked BEFORE the lock, so a session that
    # is not entitled to write does not queue behind one that is.
    Assert-SeatClaimHeld -StateDirectory $stateDirectory -Seat $seatName -Token $ClaimToken | Out-Null
    $deskLock = Enter-SeatRegistryLock -Workspace $workspace
}
try {
$openBooks = @(Read-StateLines -Path $openBooksPath -Pattern (Get-BookRootAcceptPattern) -Label 'open-book' | ForEach-Object { ConvertTo-BookRoot $_ })
if (@($openBooks | Select-Object -Unique).Count -ne $openBooks.Count) { throw 'Virtual Desk open-book state contains duplicates.' }
$openProjects = @(Read-StateLines -Path $openProjectsPath -Pattern '^(projects|archive/projects)/[a-z0-9][a-z0-9-]*$' -Label 'open-project')

if ($Action -in @('Open', 'Close')) {
    # -cnotmatch, not -notmatch: PowerShell's -notmatch is case-insensitive, so 'Demo' would satisfy
    # a lowercase-only rule and land in Desk state as shelf/Demo. Windows would then resolve the path
    # anyway while recording the wrong casing, and a case-sensitive filesystem would not resolve it at
    # all. Same defect already fixed in the note triage and Get-CaptureBook; see capture-book-model.md.
    # Assert-BookSlug, not a second copy of the rule: it is where the two refusals are worded, and
    # it separates "that is a root, pass its slug" from "that is not a slug at all". Passing the root
    # Discovery prints used to be called malformed here as well as in the reader.
    Assert-BookSlug -Slug ([string]$Slug)
}

if ($Action -eq 'Clear') {
    $openBooks = @()
    $openProjects = @()
}
elseif ($Kind -eq 'Book') {
    # -Shelf used to be read for Projects and silently IGNORED for Books, so
    # `-Kind Book -Shelf Archive` opened the active Book and said nothing. It is honoured here now,
    # and New-BookRoot owns every rule about what that produces -- including refusing an archived
    # Shelf Book, which does not exist, and the reserved `projects` slug.
    # Computed only for Open and Close. List names no Book, and building a root from an empty slug
    # used to yield a harmless 'books/' -- New-BookRoot refuses it, which is right, so List must not
    # ask. Found the first time the migrated helper was run.
    $bookRoot = if ($Action -in @('Open', 'Close')) { New-BookRoot -Location $Location -Shelf $Shelf -Slug $Slug } else { '' }
    switch ($Action) {
        'Open' {
            # A Shelf Book is local, so its existence is checkable here; a shared Book -- active or
            # archived -- is validated by the reader against the NAS at read time.
            if ($Location -eq 'Shelf') {
                # wiki_root FROM THE SCHEMA, never 'shelf/<slug>/wiki' composed here. An archived
                # Shelf Book's pages are at shelf/_archive/<slug>/wiki, so the composed path tested
                # the wrong directory. It survived its own self-test because that fixture also held
                # an ACTIVE Book of the same name: the check found a real directory and passed for
                # the wrong reason. The first live open of the one archived Book on disk failed.
                $wikiRelative = (Split-BookRoot $bookRoot).wiki_root
                $wikiPath = Join-Path $workspace $wikiRelative
                if (-not (Test-Path -LiteralPath $wikiPath -PathType Container)) { throw "No Shelf Book '$Slug' exists at $wikiRelative." }
            }
            if ($bookRoot -notin $openBooks) { $openBooks += $bookRoot }
        }
        'Close' { $openBooks = @($openBooks | Where-Object { $_ -cne $bookRoot }) }
        'List' { }
    }
}
else {
    $projectRoot = if ($Shelf -eq 'Archive') { "archive/projects/$Slug" } else { "projects/$Slug" }
    switch ($Action) {
        'Open' { if ($projectRoot -notin $openProjects) { $openProjects += $projectRoot } }
        'Close' { $openProjects = @($openProjects | Where-Object { $_ -cne $projectRoot }) }
        'List' { }
    }
}

if ($Action -ne 'List') {
    Write-StateLines -Path $openBooksPath -Items $openBooks
    Write-StateLines -Path $openProjectsPath -Items $openProjects
}
}
finally { if ($null -ne $deskLock) { Exit-BookLock -Lock $deskLock } }

# `-KeepConversation` BECAUSE A DESK WRITE IS NOT AN ENTRY (2026-09-11). Write-SeatActivity replaces
# the record whole and clears the conversation by default, which is right for an entry that started
# no conversation and therefore cannot name one. Opening a Book is not an entry: it starts nothing
# and displaces nothing, so clearing here ERASED the only record of which conversation was sitting at
# a launcher-started seat -- which has no binding to fall back on. Observed on a real seat: the
# launcher recorded its conversation at 20:05, one Book was opened at 20:54, and the picker then said
# "nothing has recorded a conversation at this seat" and refused to resume a live session.
if ($Action -ne 'List') {
    Write-SeatActivity -StateDirectory $stateDirectory -Seat $seatName -Note "desk $($Action.ToLowerInvariant())" `
        -KeepConversation | Out-Null
}

Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
    action = $Action.ToLowerInvariant()
    seat = $seatName
    kind = $Kind.ToLowerInvariant()
    location = if ($Kind -eq 'Book') { $Location.ToLowerInvariant() } else { $null }
    # Reported for a Book too, now that it means something there.
    shelf = $Shelf.ToLowerInvariant()
    slug = $Slug
    open_books = $openBooks
    open_projects = $openProjects
    shared_library_write = $false
    same_session_note = 'This changes future Library reads only, at this seat. Start a new Claude session for a clean conversation context.'
})
