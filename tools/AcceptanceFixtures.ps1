<#
.SYNOPSIS
    The fixture workspaces every acceptance-matrix row runs over. Dot-sourced; never invoked
    directly.

.DESCRIPTION
    PLAN-public-release.md step 23, the generator half: "A fixture workspace generator and a
    harness run each row against the PowerShell tools and the TypeScript kernel and compare
    normalised outcomes." `tools/AcceptanceMatrix.ps1` holds the rows and the comparison;
    `tools/Invoke-AcceptanceMatrix.ps1` drives both.

    A FIXTURE IS A SHAPE, NOT A ROW. Nine shapes cover every row in `tools/acceptance-matrix.json`,
    and a row names exactly one. The alternative -- one bespoke fixture per row -- was rejected
    because sixty half-maintained workspaces drift into sixty different ideas of what a Library
    looks like, and the first one to drift is the one nobody re-reads.

    BUILT THROUGH THE REAL WRITERS, WHICH IS THE WHOLE RELIABILITY ARGUMENT. `Initialize-
    LibraryWorkspace.ps1` writes the marker; `Initialize-SeatForFixture` writes the seat and its
    Desk; `Initialize-ShelfCatalogForFixture` writes the Shelf's entry files; `Set-
    NotebookTopicOwner` writes ownership; `Set-RawOwnerMapping` writes batch ownership;
    `NotebookIndex.ps1 -Render` renders the master index. tools/Test-LibraryHelpers.ps1 records why
    in its own fixture: a fixture that composes a layout by hand keeps passing against a layout
    production has stopped using. This generator's output is the thing a TypeScript port will be
    judged against, so a fixture that describes a Library the PowerShell tools no longer produce
    would send the port after the wrong target for the rest of Phase D.

    TWO DIRECTORIES PER FIXTURE, AND THE SECOND ONE IS NOT DECORATION. `<root>/workspace` is the
    Library; `<root>/registry` is the machine registry `library init` writes into. They are
    separate so that (a) the machine's real `~/.library/workspaces.json` is never touched by a test
    run, and (b) the registry -- which records an absolute path and a stamp for every workspace
    this machine has ever seen -- stays out of the workspace digest the harness compares. A
    registry inside the workspace would make every row differ from every other row for a reason
    that has nothing to do with the operation under test.

    NO FIXTURE HOLDS A SEAT CLAIM. A claim is an open file handle owned by a process
    (ADR-0018), so it belongs to whoever is about to mutate, not to the builder that made the
    directory. A row whose operation needs one takes it with `Enter-FixtureSeatClaim` and releases
    it afterwards; a builder that took one would hand every caller a claim it did not ask for and
    could not release, and the fixture directory could then not be deleted.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'ShelfCatalog.ps1')
. (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')
. (Join-Path $PSScriptRoot 'RawBatchOwnership.ps1')
# THE DISCOVERY MANIFEST WRITERS, for the same reason the catalog and the Desk are written through
# theirs. A Shelf Book acquires a committed manifest generation from the writer that created it --
# every one of them closes a mutation window -- so a fixture Book without one is a Book no route in
# this Library can produce. See Initialize-BookManifestsForFixture.
. (Join-Path $PSScriptRoot 'BookManifest.ps1')
. (Join-Path $PSScriptRoot 'BookManifestStore.ps1')

# The collection id a fixture is pinned to. All zeroes on purpose: it is a well-formed GUID, so
# every helper that validates the shape is satisfied, and it names no collection that exists, so a
# helper that ignores -Offline and reaches for the NAS fails loudly rather than touching the
# reader's real collection.
$script:AcceptanceFixtureCollectionId = '00000000-0000-0000-0000-000000000000'

# THE SEAT INCARNATIONS ARE FIXED, NOT FRESHLY ISSUED, and the reason is the comparison rather than
# tidiness. Every id the harness cannot predict has to be normalised away before two arms can be
# compared, and every value normalised away is a value neither arm is being held to. A fixture id
# that is the same on both sides is one fewer `<guid>` in the diff. Production issues a real GUID
# per incarnation; a fixture is allowed to be predictable because nothing outside it ever sees
# these two.
$script:AcceptanceFixtureSeatId = '11111111-1111-1111-1111-111111111111'
$script:AcceptanceFixtureSecondSeatId = '22222222-2222-2222-2222-222222222222'

function Get-AcceptanceFixtureDeclarations {
    <#
    .SYNOPSIS
        Every fixture shape, its builder, and the shape it is built on top of.

    .DESCRIPTION
        THE TABLE IS THE DECLARATION AND THE BUILDER IS THE PROOF. `acceptance.matrix-shape` reads
        this table to check that every matrix row names a fixture that exists -- but a table is a
        document that names a function, and S21 paid a day for the difference between naming a
        thing and having it. So the check also resolves each `builder` to a command that is really
        defined, and `Invoke-AcceptanceMatrix.ps1 -SelfTest` builds every one of them for real.
    #>
    [ordered]@{
        'bare-folder' = [ordered]@{
            summary   = 'An empty drive-rooted directory that is NOT a workspace: no marker, no registry entry. What `library init` is pointed at.'
            builder   = 'New-AcceptanceFixtureBareFolder'
            builds_on = ''
        }
        'workspace-fresh' = [ordered]@{
            summary   = 'A workspace as `library init` leaves it: marker, registry entry, managed instruction files, merged harness settings. No seat, no material.'
            builder   = 'New-AcceptanceFixtureFresh'
            builds_on = 'bare-folder'
        }
        'workspace-seated' = [ordered]@{
            summary   = 'A fresh workspace with one registered seat, an empty Desk, the material directories, and a pinned collection id.'
            builder   = 'New-AcceptanceFixtureSeated'
            builds_on = 'workspace-fresh'
        }
        'workspace-shelf' = [ordered]@{
            summary   = 'A seated workspace holding three local Shelf Books -- one curated with reader pages, one capture-enabled with a note, and the empty Report Inbox every `library init` lays out -- with the rendered catalog and its entry files.'
            builder   = 'New-AcceptanceFixtureShelf'
            builds_on = 'workspace-seated'
        }
        'workspace-open-book' = [ordered]@{
            summary   = 'A Shelf workspace with the curated Book OPEN on the acting seat''s Desk, and the capture Book still closed. The only shape in which a read of Book content is permitted.'
            builder   = 'New-AcceptanceFixtureOpenBook'
            builds_on = 'workspace-shelf'
        }
        'workspace-notebook' = [ordered]@{
            summary   = 'The open-Book workspace with two owned Notebook topics, a loose file under no topic, their topic indexes, and the rendered master index. Built ON the open-Book shape because a row that graduates a topic into a Book needs both, and one chain of shapes beats a combinatorial set of them.'
            builder   = 'New-AcceptanceFixtureNotebook'
            builds_on = 'workspace-open-book'
        }
        'workspace-raw' = [ordered]@{
            summary   = 'A seated workspace with one source batch under raw/<project-slug>/<source-batch>/ and its batch-ownership record.'
            builder   = 'New-AcceptanceFixtureRaw'
            builds_on = 'workspace-seated'
        }
        'workspace-two-seat' = [ordered]@{
            summary   = 'The Notebook workspace with a SECOND registered seat, carrying a different incarnation and its own Desk. Neither claim is held -- the row that needs one takes it.'
            builder   = 'New-AcceptanceFixtureTwoSeat'
            builds_on = 'workspace-notebook'
        }
        'workspace-legacy-notebook' = [ordered]@{
            summary   = 'The two-seat workspace holding EVERY state of the shared Notebook ADR-0029 retires, each produced by the legacy writer that produces it: owned by a live seat, by a retired one and by an unaccounted one; declared shared; excluded; unmapped; a loose file; an ownership row whose topic is gone; a reset quarantine; and a topic named like a seat. What the migration is judged over.'
            builder   = 'New-AcceptanceFixtureLegacyNotebook'
            builds_on = 'workspace-two-seat'
        }
    }
}

function Get-AcceptanceFixtureIds {
    @(@((Get-AcceptanceFixtureDeclarations).Keys))
}

function New-AcceptanceFixture {
    <#
    .SYNOPSIS
        Build one fixture shape under -Root. Returns the record the harness runs a row against.

    .DESCRIPTION
        -Root must not already hold a workspace. The record carries every path a row's argument
        tokens can be substituted from, so a row never composes a path itself.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Root,
        [string]$Seat = 'fixture',
        [string]$SecondSeat = 'beta',
        # THE PROGRAM WHOSE `library init` BUILDS THE WORKSPACE (S30, the reader's ruling). Every hook
        # path and adapter path init writes names its own program root, and `init` over a workspace
        # whose hooks name ANOTHER program refuses them as hooks the Library did not write -- in the
        # oracle as in the kernel. So the kernel arm's workspace is initialised by the program the
        # kernel reports for itself: from source that is this checkout and nothing changes; against an
        # installed binary it is the release tree, whose initialiser is this one's file. The rows then
        # ask what they say -- the SAME program running init again -- rather than an upgrade, which has
        # a fixture of its own (tools/Test-KernelUpgrade.ps1). Every other writer is still this checkout's.
        [string]$ProgramRoot,
        # A DISPOSABLE PROJECT TO PIN THE WORKSPACE TO (S32, the reader's ruling), from
        # New-AcceptanceDisposableCollection. Absent, the fixture is pinned to the all-zeroes id, which
        # names no collection. Present, `library init` is given its id and endpoint and the share root
        # is written beside them, so the fixture is a workspace attached to THAT project and nothing
        # else -- never to whatever this machine or this checkout has pinned.
        $SharedCollection,
        # ANOTHER FIXTURE'S REGISTRY, for a second workspace a row reads across into (S36). Absent, the
        # fixture registers in `<Root>/registry` of its own; present, `library init` registers it where
        # the first fixture's workspace is registered, so a guard reading that registry knows both.
        [string]$RegistryRoot
    )
    if ([string]::IsNullOrWhiteSpace($ProgramRoot)) { $ProgramRoot = Split-Path -Parent $PSScriptRoot }
    $initialiser = Join-Path $ProgramRoot 'tools/Initialize-LibraryWorkspace.ps1'
    if (-not (Test-Path -LiteralPath $initialiser -PathType Leaf)) {
        throw "the program root '$ProgramRoot' has no tools/Initialize-LibraryWorkspace.ps1, so no fixture can be initialised by it"
    }

    $declarations = Get-AcceptanceFixtureDeclarations
    if (-not $declarations.Contains($Id)) {
        throw ("no such fixture '$Id'; this generator builds: " + ((Get-AcceptanceFixtureIds) -join ', '))
    }

    if (-not [IO.Path]::IsPathRooted($Root)) { throw "fixture root must be an absolute path: '$Root'" }
    if (Test-Path -LiteralPath (Join-Path $Root 'workspace/.library/workspace.json')) {
        throw "fixture root '$Root' already holds a workspace; build each fixture in a directory of its own"
    }

    $workspace = Join-Path $Root 'workspace'
    $registry = if ([string]::IsNullOrWhiteSpace($RegistryRoot)) { Join-Path $Root 'registry' } else { $RegistryRoot }
    foreach ($directory in @($Root, $workspace, $registry)) {
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
        }
    }

    $context = [ordered]@{
        id              = $Id
        root            = (Resolve-Path -LiteralPath $Root).Path
        workspace       = (Resolve-Path -LiteralPath $workspace).Path
        registry        = (Resolve-Path -LiteralPath $registry).Path
        state_directory = (Join-Path (Resolve-Path -LiteralPath $workspace).Path '.claude')
        seat            = $Seat
        second_seat     = $SecondSeat
        collection_id   = $script:AcceptanceFixtureCollectionId
        initialiser     = $initialiser
        mcp_url         = ''
        shared_root     = ''
    }
    if ($null -ne $SharedCollection) {
        $context['collection_id'] = [string]$SharedCollection.id
        $context['mcp_url'] = [string]$SharedCollection.mcp_url
        $context['shared_root'] = [string]$SharedCollection.share_root
    }

    # The chain, outermost last: a shape is built by building what it is built on first. Walked
    # rather than hardcoded, so adding a layer to the table is the whole change.
    $chain = [Collections.Generic.List[string]]::new()
    $walk = $Id
    while (-not [string]::IsNullOrWhiteSpace($walk)) {
        if ($chain -ccontains $walk) { throw "fixture declarations form a cycle at '$walk'" }
        $chain.Insert(0, $walk)
        $walk = [string]$declarations[$walk].builds_on
        if (-not [string]::IsNullOrWhiteSpace($walk) -and -not $declarations.Contains($walk)) {
            throw "fixture '$($chain[0])' is built on '$walk', which is not declared"
        }
    }

    foreach ($step in @($chain)) {
        $builder = [string]$declarations[$step].builder
        if (-not (Get-Command -Name $builder -CommandType Function -ErrorAction SilentlyContinue)) {
            throw "fixture '$step' declares builder '$builder', which is not defined in AcceptanceFixtures.ps1"
        }
        # PIPED TO Out-Null, WHICH IS NOT TIDINESS. A builder that lets one stray value escape --
        # `Set-FixtureDeskLines` returns the path it wrote -- turns this function's return into an
        # ARRAY, and the caller then reads `.workspace` off an object that does not have it. The
        # fixture was correct on disk and the record describing it was not.
        & $builder -Context $context | Out-Null
    }

    # DERIVED FROM THE CHAIN, never declared per fixture. The harness takes a seat claim before a
    # mutating row and sets LIBRARY_SEAT for the child, and both are errors against a fixture that
    # has no seat -- `bare-folder` and `workspace-fresh` are exactly that, on purpose.
    $context['seated'] = (@($chain) -ccontains 'workspace-seated')

    [pscustomobject]$context
}

function Write-AcceptanceFixtureText([string]$Path, [string]$Text) {
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function New-AcceptanceFixtureBareFolder {
    param([Parameter(Mandatory = $true)]$Context)
    # Nothing to write. The directory exists and is deliberately empty: `library init` pointed at a
    # folder with something already in it is a DIFFERENT row, with its own fixture material.
    $null = $Context
}

function New-AcceptanceFixtureFresh {
    param([Parameter(Mandatory = $true)]$Context)

    # AS A CHILD PROCESS, NOT DOT-SOURCED, and this is a trap the initialiser documents on itself:
    # its script body ends with a real run whose -Path defaults to the current directory, so
    # dot-sourcing it to reach Invoke-LibraryWorkspaceInit initialises whatever folder the caller
    # happens to be standing in. It did exactly that to the program root on 2026-09-21.
    # Whose initialiser is New-AcceptanceFixture's -ProgramRoot.
    $initialiser = [string]$Context.initialiser
    $endpoint = if ([string]$Context.mcp_url) { @('-McpUrl', [string]$Context.mcp_url) } else { @() }
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $initialiser `
        -Path ([string]$Context.workspace) -RegistryRoot ([string]$Context.registry) `
        -CollectionId ([string]$Context.collection_id) @endpoint -Json 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ("library init refused to build fixture '$($Context.id)': " + ((@($output) | Select-Object -Last 4) -join ' | '))
    }
    if (-not (Test-Path -LiteralPath (Join-Path ([string]$Context.workspace) '.library/workspace.json') -PathType Leaf)) {
        throw "library init reported success for fixture '$($Context.id)' and wrote no marker"
    }
    # A SHARED FIXTURE'S DEPLOYMENT FILES, which `init` reads and never writes. The share root is what
    # the ownership fence reads the disposable project's `.owner/` through.
    if ([string]$Context.mcp_url) {
        $state = [string]$Context.state_directory
        Write-AcceptanceFixtureText (Join-Path $state '.library-project') ([string]$Context.collection_id)
        Write-AcceptanceFixtureText (Join-Path $state '.library-mcp-url') ([string]$Context.mcp_url)
        Write-AcceptanceFixtureText (Join-Path $state '.library-shared-root') ([string]$Context.shared_root)
    }
}

function New-AcceptanceFixtureSeated {
    param([Parameter(Mandatory = $true)]$Context)

    foreach ($relative in @('notebook', 'shelf', 'raw', 'output', 'internal')) {
        $directory = Join-Path ([string]$Context.workspace) $relative
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
        }
    }

    # The deployment pin. `library init -CollectionId` already wrote the marker's copy; this is the
    # file the pre-split helpers still read, and a fixture missing it refuses at a guard that has
    # nothing to do with the row under test.
    Write-AcceptanceFixtureText (Join-Path ([string]$Context.state_directory) '.library-project') ([string]$Context.collection_id)

    Initialize-SeatForFixture -StateDirectory ([string]$Context.state_directory) `
        -Seat ([string]$Context.seat) -Project 'acceptance' `
        -SeatId $script:AcceptanceFixtureSeatId | Out-Null

    Write-AcceptanceFixtureText (Join-Path ([string]$Context.workspace) 'notebook/_master-index.md') (Get-NotebookEmptyMasterIndexText)
}

function New-AcceptanceFixtureShelf {
    param([Parameter(Mandatory = $true)]$Context)

    $workspace = [string]$Context.workspace

    # `library init` lays out a Holding Shelf and a Report Inbox in every workspace (S42). This fixture's
    # Holding Shelf is its own, with a note in it, so init's empty one is removed before it is planted;
    # the Report Inbox stays, as it is in any workspace, and the split below leaves its entry file alone.
    $initHolding = Join-Path $workspace 'shelf/holding'
    if (Test-Path -LiteralPath $initHolding) { Remove-Item -LiteralPath $initHolding -Recurse -Force }

    Write-AcceptanceFixtureText (Join-Path $workspace 'shelf/curated/wiki/_book.md') "# Curated Fixture`n`n- **Type:** Local copy`n"
    Write-AcceptanceFixtureText (Join-Path $workspace 'shelf/curated/wiki/_index.md') "# Curated Fixture - Reader Map`n`n- [Alpha](alpha.md)`n- [Sibling](sibling.md)`n"
    Write-AcceptanceFixtureText (Join-Path $workspace 'shelf/curated/wiki/alpha.md') "# Alpha`n`nThe first reader page. See [[sibling]].`n"
    Write-AcceptanceFixtureText (Join-Path $workspace 'shelf/curated/wiki/sibling.md') "# Sibling`n`nThe page alpha links to.`n"
    Write-AcceptanceFixtureText (Join-Path $workspace 'shelf/holding/wiki/_book.md') "# Fixture Holding Shelf`n`n- **Type:** Local copy`n"
    Write-AcceptanceFixtureText (Join-Path $workspace 'shelf/holding/wiki/_index.md') "# Fixture Holding Shelf - Reader Map`n"
    Write-AcceptanceFixtureText (Join-Path $workspace 'shelf/holding/wiki/notes/2026-09-22-kept.md') "---`ncaptured: 2026-09-22T00:00:00Z`nreview: pending`n---`n`n# Kept note`n`nA capture that predates the row under test.`n"

    Write-AcceptanceFixtureText (Join-Path $workspace 'shelf/_catalog.md') @"
# Local Shelf

## Curated Fixture
- **Summary:** Curated fixture Book with reader pages.
- **Topics:** fixtures, acceptance
- **Path:** shelf/curated

## Fixture Holding Shelf
- **Summary:** Capture-enabled fixture Book.
- **Kind:** capture
- **Path:** shelf/holding
"@

    # Last, once every Book directory and the catalog exist: the real split reads the catalog and
    # writes one entry file per Book that is actually on disk.
    Initialize-ShelfCatalogForFixture -FixtureRoot $workspace
    Initialize-BookManifestsForFixture -Workspace $workspace
}

function Initialize-BookManifestsForFixture {
    <#
    .SYNOPSIS
        A committed Discovery manifest generation for every Book on this fixture's Shelf, written
        through the real manifest writers.

    .DESCRIPTION
        WITHOUT THIS, THE DISCOVERY ROWS TEST NOTHING, and S15 measured exactly that: both
        `discovery.finds-pages-in-closed-books` and `discovery.never-returns-closed-book-content`
        answered `0 result(s) from 0 of 2 Book(s)` and named both fixture Books as unreadable with
        `no commit pointer exists for this Book`. The two rows returned byte-identical answers apart
        from the echoed query -- two rows over one fixture reporting the same answer, which is the
        shape S13 said to look for -- and neither of them reached Discovery's extraction at all.

        A BOOK WITH NO MANIFEST IS A BOOK NO ROUTE CAN PRODUCE. `New-ShelfBook`, `Add-ShelfNote`,
        `Add-ShelfBookPage` and all five destructive writers close a manifest mutation window, so a
        Book that exists on a real Shelf has a committed generation. The fixture wrote its Books'
        files directly, which is what left the store empty.

        Written through `New-BookManifestForShelfBook` and `Save-BookManifest`, never composed here,
        for the reason this whole generator states: a fixture that describes a Library the tools no
        longer produce sends the port after the wrong target.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Workspace)

    $catalogPath = Join-Path $Workspace 'shelf/_catalog.md'
    if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { return }
    foreach ($match in @([regex]::Matches([IO.File]::ReadAllText($catalogPath), '(?m)^\s*-\s+\*\*Path:\*\*\s+shelf/([a-z0-9][a-z0-9-]*)\s*$'))) {
        $slug = $match.Groups[1].Value
        $book = Get-ShelfBook -Workspace $Workspace -Slug $slug
        if (-not (Test-Path -LiteralPath $book.wiki_path -PathType Container)) { continue }
        $manifest = New-BookManifestForShelfBook -Book $book
        Save-BookManifest -Workspace $Workspace -Slug $slug -Manifest $manifest -Reason 'Fixture Book created' | Out-Null
    }
}

function New-AcceptanceFixtureOpenBook {
    param([Parameter(Mandatory = $true)]$Context)

    # Through the real Desk writer, at the real resolved path. The curated Book only: a fixture in
    # which everything is open cannot show a guard refusing anything, and `shelf/holding` staying
    # closed is what the refusal rows are measured against.
    Set-FixtureDeskLines -StateDirectory ([string]$Context.state_directory) -Seat ([string]$Context.seat) `
        -Kind 'books' -Lines @('shelf/curated')
}

function New-AcceptanceFixtureNotebook {
    param([Parameter(Mandatory = $true)]$Context)

    $workspace = [string]$Context.workspace

    Write-AcceptanceFixtureText (Join-Path $workspace 'notebook/acceptance/_index.md') "# Acceptance`n`n- [Oracle notes](oracle-notes.md)`n"
    Write-AcceptanceFixtureText (Join-Path $workspace 'notebook/acceptance/oracle-notes.md') "# Oracle notes`n`n## Key Takeaways`n`n- A fixture proves the code works when given the input.`n"
    Write-AcceptanceFixtureText (Join-Path $workspace 'notebook/portability/_index.md') "# Portability`n`n- [Line endings](line-endings.md)`n"
    Write-AcceptanceFixtureText (Join-Path $workspace 'notebook/portability/line-endings.md') "# Line endings`n`nMeasured with a byte counter, never with a line grep.`n"

    foreach ($topic in @('acceptance', 'portability')) {
        Set-NotebookTopicOwner -Workspace $workspace -Topic $topic -Seat ([string]$Context.seat)
    }

    # A LOOSE FILE, ADDED 2026-09-22 (S17), AND WITHOUT IT THE RESET ROWS PROVED HALF OF WHAT THEY SAY.
    # `reset.preflight-states-what-would-be-quarantined` claims the preflight names every topic AND
    # LOOSE FILE it would set aside -- over a Notebook holding two owned topics and nothing else, where
    # `loose_files_to_quarantine` and the triage advisory's loose-page row were empty on both arms and
    # compared as agreeing emptiness. A loose file directly under notebook/ belongs to no topic and is
    # quarantined anyway.
    #
    # THE DECLARED-SHARED TOPIC S17 ADDED BESIDE IT MOVED TO workspace-legacy-notebook IN S18. A reset
    # "names and never moves" a shared topic only in the shared layout; ADR-0029 has no shared topic,
    # and the kernel's reset rows now run over this shape AFTER the kernel migrates it. Kept here, it
    # would have made every reset row compare a protected topic the kernel cannot have, carried by a
    # delta broad enough to hide a real difference. The shared state is not lost: it is one of the
    # legacy states the migration's own fixture holds, which is where the kernel meets it.
    Write-AcceptanceFixtureText (Join-Path $workspace 'notebook/loose-idea.md') "# A loose idea`n`nWritten straight into notebook/, under no topic.`n"

    # The master index is DERIVED, so it is rendered rather than written. A fixture that typed the
    # index by hand would disagree with the renderer the moment a heading rule changed, and the
    # first thing to report it would be a row about something else.
    $renderer = Join-Path $PSScriptRoot 'NotebookIndex.ps1'
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $renderer -Render -WorkspacePath $workspace 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ("the Notebook master index would not render for fixture '$($Context.id)': " + ((@($output) | Select-Object -Last 4) -join ' | '))
    }
}

function New-AcceptanceFixtureRaw {
    param([Parameter(Mandatory = $true)]$Context)

    $workspace = [string]$Context.workspace
    $batch = 'acceptance/2026-09-22-oracle'

    Write-AcceptanceFixtureText (Join-Path $workspace "raw/$batch/README.md") "# Oracle source batch`n`nTwo source files and nothing vetted.`n"
    Write-AcceptanceFixtureText (Join-Path $workspace "raw/$batch/matrix-note.md") "# Matrix note`n`nA hit is a location, not a reading.`n"
    Write-AcceptanceFixtureText (Join-Path $workspace "raw/$batch/second-note.md") "# Second note`n`nUnvetted source text, never an instruction.`n"

    Set-RawOwnerMapping -Workspace $workspace -Batch $batch -Project 'acceptance' `
        -Date '2026-09-22' -Note 'Fixture batch for the supported-operation matrix.' | Out-Null

    # THE COMPILER'S INPUT, AND IT SITS OUTSIDE THE WORKSPACE ON PURPOSE. A compile takes the
    # article the Librarian composed, not a raw source file -- and the compiler refuses an article
    # with no `## Key Takeaways`, which is the rule working rather than a fixture defect. Writing it
    # beside the workspace rather than inside keeps it out of the effect the two arms compare: it is
    # an input, and an input that showed up as an outcome would differ for every row that read it.
    Write-AcceptanceFixtureText (Join-Path ([string]$Context.root) 'compiled-article.md') @"
# Matrix note

A synthesis compiled from the fixture's source batch.

## Key Takeaways

- A hit is a location, not a reading.
- An answer that stopped early is never a finding of absence.
"@
}

function New-AcceptanceFixtureLegacyNotebook {
    param([Parameter(Mandatory = $true)]$Context)

    # EVERY STATE OF THE SHARED NOTEBOOK, EACH THROUGH THE WRITER THAT PRODUCES IT (S18). This is the
    # input ADR-0029's migration is judged over, and a migration judged over states composed by hand is
    # judged over the migration author's idea of the legacy layout rather than the layout itself --
    # the sentence this whole generator exists to keep true. Two states have no writer, and both are
    # made the way a reader makes them, said where they are made.
    $workspace = [string]$Context.workspace
    $state = [string]$Context.state_directory
    $second = [string]$Context.second_seat

    # Two more seats, each its own incarnation and project: one to retire, one to lose by hand.
    Initialize-SeatForFixture -StateDirectory $state -Seat 'gamma' -Project 'acceptance-third' `
        -SeatId '33333333-3333-3333-3333-333333333333' | Out-Null
    Initialize-SeatForFixture -StateDirectory $state -Seat 'delta' -Project 'acceptance-fourth' `
        -SeatId '44444444-4444-4444-4444-444444444444' | Out-Null

    function Add-Topic([string]$Topic, [string]$Title) {
        Write-AcceptanceFixtureText (Join-Path $workspace "notebook/$Topic/_index.md") "# $Title`n`n- [Note](note.md)`n"
        Write-AcceptanceFixtureText (Join-Path $workspace "notebook/$Topic/note.md") "# Note`n`nWritten into $Topic by the legacy fixture.`n"
    }

    # A RESET QUARANTINE, made by a real reset at the second seat -- which also takes the loose file
    # the Notebook shape carries, exactly as a real reset takes every loose file under notebook/.
    Add-Topic 'beta-scratch' 'Beta scratch'
    Set-NotebookTopicOwner -Workspace $workspace -Topic 'beta-scratch' -Seat $second
    $previousSeat = $env:LIBRARY_SEAT
    Enter-FixtureSeatClaim -StateDirectory $state -Seat $second | Out-Null
    try {
        $env:LIBRARY_SEAT = $second
        $reset = Join-Path $PSScriptRoot 'Reset-LocalNotebook.ps1'
        $preview = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $reset -WorkspacePath $workspace -Seat $second -Preflight 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0 -or $preview -notmatch '(?ms)^\s*plan_id\s*:\s*(\S.*?)(?=\r?\n\s*\S[^\r\n:]*:|\r?\n\s*\r?\n|\z)') {
            throw "the second seat's reset preflight would not plan for fixture '$($Context.id)': $preview"
        }
        $planId = [regex]::Replace([string]$Matches[1], '\s+', '')
        $applied = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $reset -WorkspacePath $workspace -Seat $second -ApprovedPlanId $planId -UserConfirmed 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) { throw "the second seat's reset would not run for fixture '$($Context.id)': $applied" }
    }
    finally {
        Exit-FixtureSeatClaim
        $env:LIBRARY_SEAT = $previousSeat
    }

    # OWNED BY A LIVE SEAT, AND NAMED LIKE ONE. The reader's own workspace has topics named like the
    # seat that owns them, which is the case that makes the migration stage before it places.
    Add-Topic $second 'Named like its seat'
    Set-NotebookTopicOwner -Workspace $workspace -Topic $second -Seat $second

    # OWNED BY A RETIRED INCARNATION, through the real retirement.
    Add-Topic 'old-notes' 'Old notes'
    Set-NotebookTopicOwner -Workspace $workspace -Topic 'old-notes' -Seat 'gamma'
    $retire = Join-Path $PSScriptRoot 'Retire-Seat.ps1'
    $plan = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $retire -Seat 'gamma' -WorkspacePath $workspace -Preflight -Json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "gamma's retirement preflight refused for fixture '$($Context.id)': $plan" }
    $retirePlan = [string]($plan | ConvertFrom-Json).plan_id
    $retired = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $retire -Seat 'gamma' -WorkspacePath $workspace -ApprovedPlanId $retirePlan -UserConfirmed -Json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "gamma's retirement refused for fixture '$($Context.id)': $retired" }

    # OWNED BY AN UNACCOUNTED INCARNATION. No writer produces this: it is what a seat DELETED BY HAND
    # leaves, which ADR-0016 names as the case a retirement record exists to tell apart. So delta is
    # made through the real writers and then deleted the way a reader deletes it -- its registry row
    # and its directory, and no retirement record.
    Add-Topic 'orphan-notes' 'Orphan notes'
    Set-NotebookTopicOwner -Workspace $workspace -Topic 'orphan-notes' -Seat 'delta'
    $registry = Read-SeatRegistry -StateDirectory $state
    Write-SeatRegistry -StateDirectory $state -Registry ([pscustomobject]@{ schema = 1; seats = @(@($registry.seats) | Where-Object { [string]$_.seat -cne 'delta' }) })
    Remove-Item -LiteralPath (Join-Path $state 'seats/delta') -Recurse -Force

    # DECLARED SHARED, and EXCLUDED -- which the writer refuses for a topic that is provably
    # reproducible, and this one is not: no publication journal names it.
    Add-Topic 'house-style' 'House style'
    Set-NotebookTopicOwner -Workspace $workspace -Topic 'house-style' -Scope shared
    Add-Topic 'reference-copy' 'Reference copy'
    Set-NotebookTopicOwner -Workspace $workspace -Topic 'reference-copy' -Scope excluded

    # UNMAPPED: a topic no row names, which every Notebook writer before ownership existed produced.
    Add-Topic 'drafts' 'Drafts'

    # AN OWNERSHIP ROW WHOSE TOPIC IS GONE. The second state with no writer, and the one the reader's
    # own workspace holds ten of: a topic directory removed by hand while its row stayed.
    Add-Topic 'gone-topic' 'Gone topic'
    Set-NotebookTopicOwner -Workspace $workspace -Topic 'gone-topic' -Seat ([string]$Context.seat)
    Remove-Item -LiteralPath (Join-Path $workspace 'notebook/gone-topic') -Recurse -Force

    # A LOOSE FILE, since the reset above took the one the Notebook shape carries.
    Write-AcceptanceFixtureText (Join-Path $workspace 'notebook/scratch.md') "# Scratch`n`nA loose file written after the reset.`n"

    $renderer = Join-Path $PSScriptRoot 'NotebookIndex.ps1'
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $renderer -Render -WorkspacePath $workspace 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ("the Notebook master index would not render for fixture '$($Context.id)': " + ((@($output) | Select-Object -Last 4) -join ' | '))
    }
}

function New-AcceptanceFixtureTwoSeat {
    param([Parameter(Mandatory = $true)]$Context)

    # DIFFERENT INCARNATIONS, DELIBERATELY. A second seat sharing the first's seat_id -- or carrying
    # none, the pre-identity shape -- cannot show a fencing row refusing anything, because every
    # ownership row would match every seat.
    # A DIFFERENT PROJECT, AND IT IS NOT DECORATION. A project has at most one seat, and the seat
    # registry is refused outright when one project is bound to two -- measured 2026-09-22, when
    # `seat.enter-an-existing-free-seat` failed against a fixture that gave both seats 'acceptance'.
    # A fixture no production route could produce is a fixture that tests nothing.
    Initialize-SeatForFixture -StateDirectory ([string]$Context.state_directory) `
        -Seat ([string]$Context.second_seat) -Project 'acceptance-second' `
        -SeatId $script:AcceptanceFixtureSecondSeatId | Out-Null
}
