<#
.SYNOPSIS
    The Virtual Desk's Book-root state schema, specified once. Dot-sourced; never invoked directly.

.DESCRIPTION
    Plan item 3.2. A Book open on the Desk is recorded in `.claude/.open-books` as one line naming
    its collection root. Before this file the shape `books/<slug>|shelf/<slug>` was written out
    independently in EIGHT places -- the validated reader adapter (three of them), all three hooks,
    `Get-DeskOverview.ps1`, and `Set-VirtualDesk.ps1` -- so adding a third location meant finding
    every one of them and hoping. That is the migration, and it is the reason this file exists at
    all: not to save lines, but so a Desk state shape has exactly one definition.

    THE FOUR ROOTS, AND WHERE THE PAGES ACTUALLY ARE:

        books/<slug>           an ACTIVE shared Book.   Pages at books/<slug>/wiki/<page>           (over MCP)
        archive/<slug>         an ARCHIVED shared Book. Pages at archive/<slug>/wiki/<page>         (over MCP)
        shelf/<slug>           a local Shelf Book.      Pages at shelf/<slug>/wiki/<page>           (on disk)
        shelf/_archive/<slug>  an ARCHIVED Shelf Book.  Pages at shelf/_archive/<slug>/wiki/<page>  (on disk)

    A bare `<slug>` is the pre-symmetry format and still means an active shared Book.

    THE ARCHIVE ROOT IS `archive/<slug>` AND NOT `archive/books/<slug>`, BECAUSE THAT IS WHERE THE
    PAGES ARE. `Archive-SharedBook.ps1` has moved a Book to `archive/<slug>/wiki/` since the pilot,
    and PLAN.md's own sketch of this item guessed `archive/books/<slug>`. A Desk root that did not
    match the storage path would need a translation step, and a translation step is the second
    authority this file exists to remove. Note the asymmetry with Projects, which really are at
    `archive/projects/<slug>`: Books were archived first and Projects later, and the two conventions
    were never reconciled. Recording the asymmetry is cheaper and safer than migrating live shared
    material to tidy it.

    `projects` IS A RESERVED SLUG FOR AN ARCHIVED BOOK. `archive/projects` is the archived Project
    ROOT, so an archived Book of that name would produce a Desk line that reads as two different
    things. The two live in different state files and would not actually collide, but a reader
    cannot be expected to know that, and `Guard-BasicMemoryRead.ps1` already allows `archive/projects`
    unconditionally for discovery. Refused at the point a Desk line is created.

    THE SHELF DOES HAVE AN ARCHIVE, AND THIS FILE ONCE SAID IT DID NOT. When 3.2 shipped, archiving
    really was a shared-collection operation and `-Location Shelf -Shelf Archive` was refused on
    purpose. `tools/Archive-ShelfBook.ps1` landed the day after and built `shelf/_archive/<slug>`,
    which left this schema asserting the opposite of what was on disk for six days -- and the refusal
    was covered by a test, so the suite defended the stale claim rather than catching it. A rule that
    outlives the thing it described is worse than no rule: it is a wrong answer with coverage.

    IT IS `shelf/_archive/<slug>` AND NOT `archive/<slug>`, for the same reason the shared archive is
    not `archive/books/<slug>` -- that is where the pages are. `archive/<slug>` already means an
    archived SHARED Book, so reusing it would put two different Books at one root. `_archive` can
    never collide with a Book slug, which is `[a-z0-9][a-z0-9-]*` and cannot hold an underscore.

    THIS ROOT IS THREE SEGMENTS WHERE THE OTHER THREE ARE TWO. Every pattern here matches it FIRST,
    because `shelf` would otherwise claim the prefix and then fail on `_archive`. Alternation order
    is load-bearing, not cosmetic.

    AN ARCHIVED SHELF BOOK IS READ-ONLY. It opens on the Desk and is read through the validated
    reader, and every Shelf writer refuses it. Archiving retires a Book; a write that silently
    un-retired one would make the archive a place material rots rather than rests.
    `Archive-ShelfBook.ps1 -Action Restore` is the way back, and it is the only way back.
#>

Set-StrictMode -Version Latest

# THE ONLY IMPORT THIS FILE HAS, AND IT IS A LEAF. Read-SeatBinding below reads a record another
# process replaces atomically under the registry lock, so it needs the retrying read that is the
# other half of that contract. AtomicFile.ps1 dot-sources nothing, so this cannot cycle -- which is
# the property BookManifestStore.ps1 and every hook that loads this file depend on.
. (Join-Path $PSScriptRoot 'AtomicFile.ps1')

# THE ONE PATTERN. Every reader of .open-books validates against this and nothing else.
# -cmatch everywhere it is used: these rules are lowercase-only, and the case-insensitive default
# would let 'Shelf/Demo' through as well-formed Desk state for a guard to then fail to match.
$script:BookRootPattern = '^(?:shelf/_archive|books|archive|shelf)/[a-z0-9][a-z0-9-]*$'

# What Read-StateLines accepts on the way IN, before normalisation: the same three roots, plus the
# pre-symmetry bare slug.
$script:BookRootAcceptPattern = '^(?:(?:shelf/_archive|books|archive|shelf)/)?[a-z0-9][a-z0-9-]*$'

$script:BookRootSlugPattern = '^[a-z0-9][a-z0-9-]*$'

# An archived Book may not be called this; see the header.
$script:BookRootReservedArchiveSlugs = @('projects')

# THE MANIFEST COLLECTIONS, AND WHY THEY ARE FLAT.
#
# A Discovery manifest is stored under `internal/book-manifests/<manifest collection>/<slug>`, and
# until the archives entered search there were two of them -- `shelf` and `shared` -- which was
# exactly the Desk's `collection` field. It is not any more: an archived Book is still `shared` or
# still `shelf`, and its manifest must not share a store with its active twin of the same slug.
#
# So the store key is (collection, shelf) flattened into ONE name, and the four names are SIBLINGS
# at the top level rather than `shared/_archive/<slug>`. That is not a style choice. Both prune
# sweeps enumerate `Get-ChildItem <store root>/<collection> -Directory` and treat every directory
# they find as a slug whose Book should still exist; a nested `_archive` directory would be walked
# as an orphaned Book. Flat names keep every existing sweep correct without knowing this exists.
$script:BookManifestCollections = @('shelf', 'shared', 'shelf-archive', 'shared-archive')

# The manifest collection <-> Book-root prefix map, in one place, in both directions. This is the
# fourth thing that used to be re-derived per caller, and the one that decides whether a manifest
# answers for the right Book.
$script:BookManifestCollectionPrefixes = [ordered]@{
    'shelf'          = 'shelf'
    'shared'         = 'books'
    'shelf-archive'  = 'shelf/_archive'
    'shared-archive' = 'archive'
}

function Get-BookRootPattern { $script:BookRootPattern }
function Get-BookRootAcceptPattern { $script:BookRootAcceptPattern }
function Get-BookRootSlugPattern { $script:BookRootSlugPattern }

function Assert-BookSlug {
    <#
    .SYNOPSIS
        Refuse a Book slug and say WHICH of two things is wrong: a malformed slug, or a ROOT passed
        where a slug goes. The one place both sentences are worded.

    .DESCRIPTION
        A REFUSAL FOR THE WRONG REASON SENDS THE READER TO THE WRONG FIX. `books/basic-memory` -- the
        root Discovery and both Catalogs print, and that ADR-0012 made the Book's IDENTITY -- came
        back from every one of these surfaces as "Book slug is malformed", which reads as a typo. It
        is also the sentence a reader sees for a genuinely mistyped slug, and it sat one line above
        the closed-Book refusal in the reader, so it could be read as the Book being closed. That is
        how it was found, on 2026-09-09, from a seat that had the Book open.

        WHAT IS ACCEPTED DOES NOT CHANGE HERE, DELIBERATELY. These surfaces still take the bare slug,
        because Select-BookRootsForSlug is what refuses an AMBIGUOUS one: books/notes, archive/notes,
        shelf/notes and shelf/_archive/notes are four different Books that happen to share a name,
        and a reader who says `notes` while two of them are open is told so rather than served
        whichever came first. Accepting a root would answer from the named Book and never mention the
        others -- a reader-experience change, which owes its reader benefit and its safety boundary
        in writing before it is made. So this corrects the sentence and leaves the contract alone.

        The reader adapter already carries the same lesson one line below its own call, about
        `Odysseus` being reported as a CLOSED Book by a case-insensitive match: fail-closed, but for
        the wrong reason.
    #>
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Slug)
    if ($Slug -cmatch $script:BookRootSlugPattern) { return }
    # A canonical Book root can be named exactly, and its slug extracted by the same splitter every
    # consumer uses rather than by trimming a prefix spelled a second time here.
    if ($Slug -cmatch $script:BookRootPattern) {
        throw ("'$Slug' is a Book ROOT, not a slug -- pass '$((Split-BookRoot $Slug).slug)'. Discovery and the " +
               "Catalogs print the root because that is the Book's identity; this surface takes the bare slug, " +
               'and refuses it as ambiguous when more than one open Book shares it.')
    }
    # Anything else carrying a slash is DESCRIBED rather than diagnosed: a Project root reaches this
    # too, and claiming an arbitrary prefix is a valid root would be a second wrong reason.
    if ($Slug -cmatch '^.+/([a-z0-9][a-z0-9-]*)$') {
        throw ("'$Slug' reads as a root rather than a slug -- pass '$($Matches[1])' if that is the Book or " +
               'Project you mean. A slug carries no slash.')
    }
    throw "Slug '$Slug' is malformed: lowercase letters, digits and hyphens only, starting with a letter or a digit."
}

function ConvertTo-BookRoot([string]$Entry) {
    <#
    .SYNOPSIS
        Normalise one .open-books line to a canonical Book root, or throw.
    #>
    if ($Entry -cmatch $script:BookRootPattern) { return $Entry }
    if ($Entry -cmatch $script:BookRootSlugPattern) { return "books/$Entry" }
    throw 'Virtual Desk open-book state is malformed.'
}

function New-BookRoot {
    <#
    .SYNOPSIS
        Build the Desk root for a Book from the location and shelf a reader named. The single
        producer-side rule, so no caller composes the string itself.
    #>
    param(
        [Parameter(Mandatory = $true)][ValidateSet('Shared', 'Shelf')][string]$Location,
        [ValidateSet('Active', 'Archive')][string]$Shelf = 'Active',
        [Parameter(Mandatory = $true)][string]$Slug
    )
    Assert-BookSlug -Slug $Slug
    if ($Location -eq 'Shelf') {
        if ($Shelf -eq 'Archive') { return "shelf/_archive/$Slug" }
        return "shelf/$Slug"
    }
    if ($Shelf -eq 'Archive') {
        if ($script:BookRootReservedArchiveSlugs -ccontains $Slug) {
            throw "'$Slug' cannot name an archived Book: archive/$Slug is the archived Project root."
        }
        return "archive/$Slug"
    }
    "books/$Slug"
}

function Split-BookRoot([string]$Root) {
    <#
    .SYNOPSIS
        One Book root taken apart: where it lives, which shelf it is on, its slug, and the exact
        directory its pages sit in. The single consumer-side rule.

    .DESCRIPTION
        `collection` is what decides HOW a page is fetched -- `shared` over MCP, `shelf` from disk --
        and `shelf` is which of the shared collection's two halves it is in. Keeping them separate
        matters: an archived Book is still shared, and a reader that branched on a single field would
        have to re-derive one of the two.
    #>
    $normalised = ConvertTo-BookRoot $Root
    $match = [regex]::Match($normalised, '^(shelf/_archive|books|archive|shelf)/([a-z0-9][a-z0-9-]*)$')
    if (-not $match.Success) { throw 'Virtual Desk open-book state is malformed.' }
    $prefix = $match.Groups[1].Value
    $slug = $match.Groups[2].Value
    $collection = if ($prefix -ceq 'shelf' -or $prefix -ceq 'shelf/_archive') { 'shelf' } else { 'shared' }
    $shelf = if ($prefix -ceq 'archive' -or $prefix -ceq 'shelf/_archive') { 'archive' } else { 'active' }
    [pscustomobject]@{
        root       = $normalised
        collection = $collection
        shelf      = $shelf
        slug       = $slug
        # The Book's own wiki directory, relative to the shared collection or to the workspace.
        # This is the value that must never be re-derived by a caller, because it is the one place
        # the archive's `archive/<slug>` shape differs from what a reader would guess.
        wiki_root  = "$prefix/$slug/wiki"
        # Which Discovery manifest store answers for this Book. Emitted here rather than computed by
        # the caller, because a caller that joined `collection` alone would read an ACTIVE Book's
        # manifest for an archived one -- the same class of defect as composing a wiki path.
        manifest_collection = (ConvertTo-BookManifestCollection -Collection $collection -Shelf $shelf)
    }
}

function Get-BookManifestCollections { @($script:BookManifestCollections) }

function ConvertTo-BookManifestCollection {
    <#
    .SYNOPSIS
        (collection, shelf) -> the one manifest store name that answers for that Book.
    #>
    param(
        [Parameter(Mandatory = $true)][ValidateSet('shelf', 'shared')][string]$Collection,
        [ValidateSet('active', 'archive')][string]$Shelf = 'active'
    )
    if ($Shelf -ceq 'archive') { return "$Collection-archive" }
    $Collection
}

function Split-BookManifestCollection([string]$ManifestCollection) {
    <#
    .SYNOPSIS
        The reverse: one manifest store name taken back apart, with the Book-root prefix its Books
        live under. Discovery needs all three -- the collection to say how a page would be fetched,
        the shelf to LABEL the hit, and the prefix to name where the Book actually is.
    #>
    if ($ManifestCollection -cnotin $script:BookManifestCollections) {
        throw "Book manifest collection '$ManifestCollection' must be one of: $($script:BookManifestCollections -join ', ')."
    }
    $shelf = if ($ManifestCollection.EndsWith('-archive')) { 'archive' } else { 'active' }
    $collection = if ($shelf -ceq 'archive') { $ManifestCollection.Substring(0, $ManifestCollection.Length - '-archive'.Length) } else { $ManifestCollection }
    [pscustomobject]@{
        manifest_collection = $ManifestCollection
        collection          = $collection
        shelf               = $shelf
        root_prefix         = [string]$script:BookManifestCollectionPrefixes[$ManifestCollection]
    }
}

function New-BookRootFromManifestCollection([string]$ManifestCollection, [string]$Slug) {
    <#
    .SYNOPSIS
        The Book root a stored manifest answers for. The producer side of the map above, so a
        Discovery hit names a root the Desk will actually accept.
    #>
    Assert-BookSlug -Slug $Slug
    "$((Split-BookManifestCollection $ManifestCollection).root_prefix)/$Slug"
}

function Get-BookRootLabel([string]$Root) {
    <#
    .SYNOPSIS
        How one open Book is named to the reader. Used by the Desk context hook and the overview, so
        the two cannot describe the same state differently.
    #>
    $parts = Split-BookRoot $Root
    if ($parts.shelf -ceq 'archive') {
        # The two archives must not describe themselves identically. A reader told only "(archived)"
        # cannot tell a retired local Book from a retired shared one, and the two are restored by
        # different helpers against different storage.
        if ($parts.collection -ceq 'shelf') { return "$($parts.slug) (shelf, archived)" }
        return "$($parts.slug) (archived)"
    }
    if ($parts.collection -ceq 'shelf') { return "$($parts.slug) (shelf)" }
    "$($parts.slug) (shared)"
}

function Select-BookRootsForSlug {
    <#
    .SYNOPSIS
        Every open root naming this slug. More than one is an AMBIGUITY, not a choice to make.

    .DESCRIPTION
        The reason a reader must not pick: `books/notes`, `archive/notes` and `shelf/notes` are three
        different Books that happen to share a name, and serving whichever came first in the file
        would answer from a Book the reader did not mean. 3.2 widens this from two possible
        collisions to three, which is why it is a function rather than a regex at each call site.
    #>
    param([AllowEmptyCollection()][string[]]$OpenBooks, [string]$Slug)
    Assert-BookSlug -Slug $Slug
    @(@($OpenBooks) | Where-Object { (Split-BookRoot $_).slug -ceq $Slug })
}

# ---------------------------------------------------------------------------------------------------
# SEATS: the Desk's LOCATION, owned here because its CONTENT schema already is.
#
# One Library, N seats (ADR-0015). A seat is a named place to work carrying its own Desk:
#
#     .claude/seats/<seat>/.open-books
#     .claude/seats/<seat>/.open-projects
#
# $StateDirectory KEEPS MEANING `.claude`. Nineteen production sites across fifteen files composed
# the Desk path by hand before this, which is the same failure the top of this file records -- one
# shape written out in eight places -- one collection over and six times worse.
#
# THERE IS NO DEFAULT SEAT, AND THAT IS A RULING RATHER THAN AN OMISSION (Eric, 2026-09-07). A
# default is the seat an unset LIBRARY_SEAT falls back to, and under the one-project-per-seat binding
# that same seat holds live work -- so a process that lost its seat would not fail, it would silently
# join whatever was in play there. `unset` and `unknown` are therefore two DIFFERENT refusals with
# two different remedies, and neither of them is a fallback. Resolve-SeatName never guesses and never
# throws; Get-DeskStateDirectory is the single place the refusal wording is produced, so a new caller
# cannot invent a friendlier message that means something else.
#
# A SEAT IS ALSO AN IDENTITY, AND THAT ARRIVED HERE ON 2026-09-09 (ADR-0018, plan steps 3 and 5). A
# seat binds to the running agent process; `binding.json` records which, and Resolve-SeatName reads it
# ahead of LIBRARY_SEAT, which becomes a convenience that must AGREE with the binding or the call is
# refused. The binding READER lives in this file rather than in LibrarySeat.ps1 for one measured
# reason: both guards, the Desk hook and the reader adapter resolve a seat with this file dot-sourced
# and nothing else, so a resolver that could not see a binding would leave four consumers reading the
# environment while every write verified identity -- a session whose guard says open while its writer
# says another seat. The WRITERS stay in LibrarySeat.ps1, because writing one asserts the registry
# lock and the registry lock is that file's.
#
# `_registry.json` CANNOT COLLIDE WITH A SEAT, because a seat slug is [a-z0-9][a-z0-9-]* and cannot
# hold an underscore. That is the same guarantee `shelf/_archive` relies on, reused deliberately.
# ---------------------------------------------------------------------------------------------------

$script:SeatsDirectoryName = 'seats'
$script:SeatRegistryFileName = '_registry.json'

# The seat name pattern IS the Book slug pattern, by decision rather than by accident: the cosmetic
# tier locked "seat-name pattern reuses Get-BookRootSlugPattern", so a name that can be a Book slug
# can be a seat and there is one shape to remember.
function Get-SeatSlugPattern { $script:BookRootSlugPattern }

function Get-SeatsDirectory([string]$StateDirectory) {
    if ([string]::IsNullOrWhiteSpace($StateDirectory)) { throw 'A seats directory needs the state directory (.claude).' }
    Join-Path $StateDirectory $script:SeatsDirectoryName
}

function Get-SeatRegistryPath([string]$StateDirectory) {
    Join-Path (Get-SeatsDirectory $StateDirectory) $script:SeatRegistryFileName
}

function Resolve-SeatName {
    <#
    .SYNOPSIS
        WHICH SEAT THIS CALL IS ABOUT. Returns status `named`, `unset` or `malformed`, the `source`
        that answered, and NEVER throws -- callers that must fail closed use Get-DeskStateDirectory
        below, which turns any status but `named` into the refusal this function worded.

    .DESCRIPTION
        THREE SOURCES IN ONE ORDER, AND THE ORDER IS ADR-0018 (plan step 5):

            explicit      an argument. The caller named the seat, so nothing else is consulted.
            binding       a COMMITTED binding whose recorded agent is this process's own agent,
                          verified by PID and start time. This is the authority.
            environment   LIBRARY_SEAT, and ONLY when this process holds no binding.

        `source` is returned rather than inferred, because "seat library-dev" from a verified binding
        and "seat library-dev" from an inherited environment variable are different facts, and step 9's
        hook and step 14's overview both have to say which one they are reporting.

        A BINDING AND A DISAGREEING LIBRARY_SEAT ARE A REFUSAL NAMING BOTH, never a silent preference.
        The environment identifies and does not authenticate, so a stale inherited value would
        otherwise read one seat's Desk while every write refused at another -- the half-migration
        ADR-0015 rejects, arriving one variable at a time.

        IT TOUCHES DISK NOW, AND IT DID NOT BEFORE. Resolving a binding means reading
        `.claude/seats/*/binding.json`, which is why the binding reader lives in this file rather than
        in LibrarySeat.ps1: the two guards, the Desk hook and the reader adapter all resolve a seat
        with this file dot-sourced and nothing else. An explicit `-Seat` still reads nothing, which is
        every internal call in this file and every cross-seat sweep in the repository.

        THE STATUS SET DID NOT GROW, DELIBERATELY. Every consumer in the repository branches on
        `status -cne 'named'` and throws the message; round 1 of the plan's review measured that a
        fourth status would have broken all of them at once. So a disagreement, an unreadable binding
        and a caller that supplied no state directory are all `malformed` -- the seat STATE is
        malformed rather than the name -- and each carries its own sentence, because a reader told
        the wrong remedy takes the wrong action.

        AND IT STILL NEVER THROWS. The adapter calls this at script top level before any try/catch, so
        a throw here would kill an MCP server at startup instead of serving a refusal. Every fault the
        binding scan can raise is caught and returned as `malformed`: an unreadable binding must never
        read as "no binding", because that falls through to the environment and resolves a seat.
    #>
    param(
        [string]$Seat,
        # `.claude`. Required to consult a binding; an explicit -Seat needs none. A caller that omits
        # it and names no seat is refused rather than quietly served the environment -- see below,
        # and `seat.resolution-contract` proves no call site in the repository does it.
        [string]$StateDirectory,
        # This process's own agent. Supplied by fixtures; resolved from CLAUDE_PID otherwise.
        [int]$AgentProcessId = -1,
        # THE SEAT THE SESSION IS WORKING AT, WHICH NO ARGUMENT CAN NAME. A caller passes this when
        # the question is "who is asking", not "which seat is this call about" -- and the two are
        # different questions the moment the calling helper has a `-Seat` of its own meaning
        # something else. It changes only the REMEDY a refusal offers, never which seat resolves:
        # every route below reads the same binding and the same LIBRARY_SEAT either way.
        [switch]$ActingSeatOnly,
        # What the calling helper's own `-Seat` means, for the one sentence that tells a blocked
        # reader why the switch they already passed is not the answer. Needs -ActingSeatOnly.
        [string]$SeatArgumentMeans
    )

    function New-SeatResolution([string]$Status, [string]$SeatName, [string]$Source, [string]$Message) {
        [pscustomobject]@{ status = $Status; seat = $SeatName; source = $Source; message = $Message }
    }

    # --- 0. THE REMEDY, WORDED ONCE AND VARIED BY CALLER (2026-09-18) -----------------------------
    #
    # A REFUSAL TELLING THE READER TO PASS THE SWITCH THEY ALREADY PASSED sends them in a circle at
    # the point they are already blocked, and the reader hit exactly that on 2026-09-15:
    # `Set-NotebookTopicOwner.ps1 -Seat <assignee>` refused with "or pass -Seat explicitly", where
    # `-Seat` names the topic's ASSIGNEE and the acting seat comes only from a binding or
    # LIBRARY_SEAT. The remedy is a property of the CALL, not of this function, which is why the
    # caller declares it rather than this function guessing from `$PSBoundParameters` -- a caller
    # that conditionally omits `-Seat` would guess wrong, and silently.
    #
    # THE TWO REFUSALS MUST DIFFER, and `seat.resolution-contract` pins that they do. The negative
    # is the load-bearing half: a caller whose `-Seat` really IS the acting seat must keep being
    # told to pass it.
    $seatArgumentClause = ''
    if ($ActingSeatOnly) {
        $seatArgumentClause = ' This is the seat you are WORKING AT, so no -Seat argument to the helper you ran can name it'
        $seatArgumentClause += if ([string]::IsNullOrWhiteSpace($SeatArgumentMeans)) { '.' }
                               else { " -- its -Seat names $($SeatArgumentMeans.Trim())." }
    }
    # -cmatch: the whole schema is lowercase-only, and the case-insensitive default would admit
    # 'Fallout' as a well-formed seat whose directory then does not match the one on disk.
    function Test-SeatSlug([string]$Candidate) { $Candidate -cmatch (Get-SeatSlugPattern) }
    function New-MalformedName([string]$Candidate, [string]$Whose) {
        New-SeatResolution 'malformed' $null $null (
            "Seat name '$Candidate'$Whose is malformed. A seat is lowercase letters, digits and hyphens, " +
            'starting with a letter or a digit. List the seats with tools/Get-DeskOverview.ps1.')
    }

    # A CONTRADICTORY CALL IS REFUSED RATHER THAN RESOLVED, and it is refused BEFORE the explicit
    # branch below, which would otherwise answer from `-Seat` and drop the switch on the floor.
    # `-ActingSeatOnly` asserts that no argument can name this seat, so an argument that names one
    # means the call site is wrong about which question it is asking -- and a resolver that picked
    # either reading would be guessing. This never throws, the same as every other fault here.
    if ($ActingSeatOnly -and -not [string]::IsNullOrWhiteSpace($Seat)) {
        return (New-SeatResolution 'malformed' $null $null (
            "Resolve-SeatName was called with both -Seat ('$Seat') and -ActingSeatOnly, which contradict: " +
            '-ActingSeatOnly says the acting seat comes only from a binding or LIBRARY_SEAT and no argument ' +
            'can name it. This is a defect at the call site rather than anything the reader did.'))
    }
    if (-not $ActingSeatOnly -and -not [string]::IsNullOrWhiteSpace($SeatArgumentMeans)) {
        return (New-SeatResolution 'malformed' $null $null (
            '-SeatArgumentMeans was passed without -ActingSeatOnly, so it would have been dropped and the ' +
            'refusal would have offered -Seat as the remedy anyway. This is a defect at the call site.'))
    }

    # --- 1. EXPLICIT. The caller named it, so no binding and no environment is read at all. --------
    #
    # AND THIS BRANCH READING NOTHING IS WHAT MAKES THE BINDING BRANCH TERMINATE. The scan below
    # reaches Get-SeatBindingPath, which resolves an explicit seat through Get-DeskStateDirectory,
    # which lands back here -- so an explicit resolution that fell through to the scan would recurse.
    # It does not, because this returns first. Falsified by breaking it: the run produces a refusal
    # whose message is nested inside itself.
    if (-not [string]::IsNullOrWhiteSpace($Seat)) {
        $Seat = $Seat.Trim()
        if (-not (Test-SeatSlug $Seat)) { return (New-MalformedName $Seat '') }
        return (New-SeatResolution 'named' $Seat 'explicit' $null)
    }

    $environmentSeat = [string]$env:LIBRARY_SEAT
    if ($null -ne $environmentSeat) { $environmentSeat = $environmentSeat.Trim() }

    if ([string]::IsNullOrWhiteSpace($StateDirectory)) {
        return (New-SeatResolution 'malformed' $null $null (
            'No seat was named and no state directory was supplied, so this process''s seat binding ' +
            'could not be read and no seat may be resolved from the environment alone (ADR-0018). ' +
            'Pass -StateDirectory (the .claude directory) at the call site, or name the seat with -Seat.'))
    }

    # --- 2. THE BINDING, WHICH IS THE AUTHORITY ----------------------------------------------------
    $bound = $null
    try { $bound = Get-SeatBindingForAgent -StateDirectory $StateDirectory -AgentProcessId $AgentProcessId }
    catch {
        # FAIL CLOSED. An unreadable binding, two bindings for one agent, or a seats directory this
        # process may not enumerate all mean "I cannot tell which seat" -- and falling through to
        # LIBRARY_SEAT would answer anyway, which is the one outcome that must not happen.
        return (New-SeatResolution 'malformed' $null $null (
            "This process's seat binding could not be read, so no seat is resolved: $($_.Exception.Message)"))
    }

    if ($null -ne $bound) {
        $boundSeat = [string]$bound.seat
        if (-not (Test-SeatSlug $boundSeat)) { return (New-MalformedName $boundSeat ' recorded in a seat binding') }
        if (-not [string]::IsNullOrWhiteSpace($environmentSeat) -and $environmentSeat -cne $boundSeat) {
            return (New-SeatResolution 'malformed' $null $null (
                "Seat state disagrees. This agent process (PID $([int]$bound.agent_pid)) is bound to seat " +
                "'$boundSeat', and LIBRARY_SEAT names '$environmentSeat'. The binding is the authority and the " +
                'environment must agree with it, never override it, so nothing is resolved rather than one of ' +
                'the two being guessed at (ADR-0018). Unset LIBRARY_SEAT for this conversation' +
                $(if ($ActingSeatOnly) { " so the binding answers alone.$seatArgumentClause" }
                  else { ', or pass -Seat to name the one you mean.' })))
        }
        return (New-SeatResolution 'named' $boundSeat 'binding' $null)
    }

    # --- 3. THE ENVIRONMENT, only with no binding for this process ---------------------------------
    if (-not [string]::IsNullOrWhiteSpace($environmentSeat)) {
        if (-not (Test-SeatSlug $environmentSeat)) { return (New-MalformedName $environmentSeat '') }
        # A NAME, NOT A VERIFIED BINDING, and nothing records it as one: LIBRARY_SEAT identifies a
        # session and authenticates nothing, the same trust class as the claim token in a file any
        # process can read.
        return (New-SeatResolution 'named' $environmentSeat 'environment' $null)
    }

    $resolvedAgent = if ($AgentProcessId -lt 0) { Get-CurrentAgentProcessId } else { $AgentProcessId }
    $agentClause = if ($resolvedAgent -le 0) {
        'This process is not recognised as an agent tool child, so no seat binding could be read, and ' +
        'LIBRARY_SEAT is unset'
    }
    else { 'This agent process holds no seat binding and LIBRARY_SEAT is unset' }
    New-SeatResolution 'unset' $null $null (
        "No seat is named. $agentClause, and the Library has no default seat, because a default would " +
        'silently merge stray work into whichever seat holds it. Sit down at a seat with ' +
        'tools/Enter-LibrarySeat.ps1 -Seat <name>, start one with tools/Start-LibrarySeat.ps1 -Seat <name>' +
        $(if ($ActingSeatOnly) { ", or set LIBRARY_SEAT for this session.$seatArgumentClause" }
          else { ', or pass -Seat explicitly.' }))
}

# --- The binding: WHICH AGENT PROCESS holds this seat (ADR-0018, PLAN-seat-launch.md step 3) ------
#
# TWO FILES, AND THE SPLIT IS THE DESIGN. `.claim` is the HANDLE and carries liveness: it ends
# exactly when its holder dies, which is the property no written record can have. `binding.json` is
# the IDENTITY and carries WHO: the seat incarnation, the agent process, the conversation. One file
# holding both was the first design and round 1 of review killed it -- the next holder attempt
# truncates the file, which would erase the identity that makes recovery safe.
#
# A COMMITTED BINDING IS NEVER REWRITTEN OR DELETED WHILE ITS RECORDED AGENT IS ALIVE. Recovery from
# a lost holder writes a new holder attempt (step 4) and leaves the binding alone. A `pending`
# binding is provisional: it belongs to the attempt that wrote it, makes the seat no less free, and
# is removed by that attempt's abort.
#
# NOTHING WRITES A BINDING YET. Steps 4 and 7 own the holder and the Enter helper; this file owns the
# record's shape, its liveness rule and the three-state answer every consumer switches on. So the
# only writer today is a fixture -- which is why the fixture drives a REAL process, not a fabricated
# PID: a liveness rule tested against a number nobody is running proves nothing.

$script:SeatBindingFileName = 'binding.json'
$script:SeatBindingStates = @('pending', 'committed')

function Get-SeatBindingPath {
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Seat)
    Join-Path (Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat) $script:SeatBindingFileName
}

function Get-AgentProcessIdentity {
    <#
    .SYNOPSIS
        One agent process's identity as a comparable string: its start time in UTC, round-trip
        format. `$null` when the process is gone.

    .DESCRIPTION
        THE WRITER AND THE COMPARER CALL THIS SAME FUNCTION, deliberately. A binding records what
        this returns and liveness compares against what this returns, so there is no second
        formatting of a DateTime that could differ in precision from the first and read as a
        different process.

        WHY START TIME AT ALL: a PID is reused. Without the start time a recycled PID would inherit
        a claim it never took, or end one that is still live -- and both directions are wrong in a
        way nothing downstream could detect.

        AN EXISTING PROCESS WHOSE START TIME CANNOT BE READ RETURNS THE SENTINEL BELOW rather than
        `$null`. "I cannot tell" must not read as "it is gone": freeing a seat whose agent may still
        be running is the destructive direction, and this is not a security boundary, so a process
        we can see and cannot inspect is treated as present.
    #>
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    if ($ProcessId -le 0) { return $null }
    $process = $null
    try { $process = Get-Process -Id $ProcessId -ErrorAction Stop }
    catch { return $null }
    try { return $process.StartTime.ToUniversalTime().ToString('o') }
    catch { return 'unreadable' }
}

function Test-SeatAgentAlive {
    <#
    .SYNOPSIS
        Is the process a binding names still the same process? PID AND start time, never PID alone.
    #>
    param([Parameter(Mandatory = $true)][int]$ProcessId, [string]$StartUtc)
    $identity = Get-AgentProcessIdentity -ProcessId $ProcessId
    if ($null -eq $identity) { return $false }
    # A process we can see but not inspect, or a binding written before the start time was recorded,
    # counts as alive -- see the sentinel note above.
    if ($identity -ceq 'unreadable' -or [string]::IsNullOrWhiteSpace($StartUtc)) { return $true }
    $identity -ceq $StartUtc
}

# --- WHICH AGENT PROCESS THIS ONE BELONGS TO: TWO ROUTES, AND THE SECOND IS THE ADAPTER'S ---------
#
# MEASURED, NOT ASSUMED (2026-09-09 step 0b). `CLAUDE_PID` is set in the Claude Code tool and hook
# children and NOWHERE ELSE: not on `claude.exe` itself, and not in an MCP server process. So it
# answers for every helper the Librarian invokes and never for the validated reader adapter -- which
# left the adapter resolving `unset` at a seat its guards agreed was open, the half-migration
# ADR-0015 rejects, measured live on 2026-09-10 as guard `named/omega/binding`, adapter `unset`.
#
# THE ADAPTER'S ONLY ROUTE IS ITS OWN ANCESTRY, and the walk below is deliberately not a
# `claude.exe` test. The Codex Librarian's adapter has `codex.exe` for a parent and carries neither
# `CLAUDECODE` nor `LIBRARY_SEAT`, so a name test written for one client refuses the other outright.
# The recognised names are DECLARED here rather than matched inline, so a third client is one line
# and dropping one is visible to `seat.lifecycle`, which pins each name's own route separately.
$script:AgentClientProcessNames = @('claude.exe', 'codex.exe')

# How far up to walk. Measured chains are two steps (adapter -> claude.exe) and three for a delegated
# `codex exec`; the bound exists so a walk over reused or looping parent ids terminates rather than
# running the process table.
$script:AgentAncestryMaxDepth = 12

function Get-AgentClientProcessNames {
    <#
    .SYNOPSIS
        The process names that are an AGENT CLIENT -- the process a seat binds to.
    #>
    @($script:AgentClientProcessNames)
}

function Test-AgentClientProcessName {
    <#
    .SYNOPSIS
        Is this image name an agent client? CASE-INSENSITIVELY, and that is the one deliberate
        exception in this file.

    .DESCRIPTION
        Every other comparison here is `-c`, because every other identifier -- Book roots, slugs,
        seat names -- is ours and is lowercase BY RULE. A Windows image name is not ours: it carries
        whatever casing the vendor shipped, and `Win32_Process.Name` reports it verbatim. A
        case-sensitive test would refuse a client shipped as `Claude.exe` while the file system
        launched it happily, which is a refusal no reader could act on or even see.
    #>
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
    foreach ($client in @(Get-AgentClientProcessNames)) {
        if ([string]::Equals($Name, $client, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    $false
}

function New-ProcessAncestryRecord {
    <#
    .SYNOPSIS
        One process in the only shape the ancestry walk reads: id, parent id, image name, creation
        time. `created_utc` is `$null` when it could not be read.

    .DESCRIPTION
        THE LIVE PROVIDER AND ANY FIXTURE BUILD THE SAME SHAPE THROUGH THIS FUNCTION, for the reason
        Initialize-SeatForFixture exists one layer down: a fixture that composes the record itself
        keeps passing while the real shape moves underneath it.
    #>
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [int]$ParentProcessId = 0,
        [string]$Name = '',
        $CreatedUtc = $null
    )
    $created = $null
    if ($CreatedUtc -is [DateTime]) { $created = ([DateTime]$CreatedUtc).ToUniversalTime() }
    [pscustomobject]@{ pid = $ProcessId; parent_pid = $ParentProcessId; name = $Name; created_utc = $created }
}

function Get-ProcessAncestryRecord {
    <#
    .SYNOPSIS
        One LIVE process's ancestry record, or `$null` when it is gone. The walk's default source.

    .DESCRIPTION
        `Win32_Process` rather than `Get-Process`, because .NET exposes no parent process id at all
        and the parent is the whole point. It never throws: a CIM fault reads as "gone", which stops
        the walk and resolves no seat -- the fail-closed direction.
    #>
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    if ($ProcessId -le 0) { return $null }
    $row = $null
    try { $row = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop) }
    catch { return $null }
    if ($null -eq $row -or @($row).Count -lt 1 -or $null -eq @($row)[0]) { return $null }
    $row = @($row)[0]
    $created = $null
    try { if ($null -ne $row.CreationDate) { $created = ([DateTime]$row.CreationDate).ToUniversalTime() } } catch { $created = $null }
    New-ProcessAncestryRecord -ProcessId ([int]$row.ProcessId) -ParentProcessId ([int]$row.ParentProcessId) `
        -Name ([string]$row.Name) -CreatedUtc $created
}

function Resolve-AgentClientProcess {
    <#
    .SYNOPSIS
        THE NEAREST AGENT CLIENT ABOVE A PROCESS, found by walking parents. `agent_pid` is 0 when
        there is none, and `stopped` says which rule ended the walk.

    .DESCRIPTION
        NEAREST WINS, AND THAT IS THE CODEX-UNDER-CLAUDE CASE. A `codex exec` delegated from a Claude
        session puts `codex.exe` below `claude.exe` in one chain, and the adapter Codex launched
        belongs to Codex. Taking the first client found going up answers that with no special case.

        A PARENT THAT STARTED AFTER ITS CHILD IS A REUSED PID, AND THE WALK STOPS THERE. A parent id
        is only a number and is not cleared when the parent exits, so an adapter outliving its client
        would otherwise walk into whatever now holds that number -- and if that happened to be
        another `claude.exe`, attach to a DIFFERENT agent's binding and serve a different seat's Desk.
        Stopping resolves no client, which is the seatless refusal that already exists.

        IT NEVER THROWS, because the adapter runs it on every request: a fault is a stopped walk and
        a seatless answer, never a dead MCP server.

        `-RecordProvider` IS HOW THE STOP RULES ARE TESTED. The default is the live CIM read, and the
        live routes are proven by real processes. The reuse, depth and self-parent rules have no live
        case that can be staged on demand, so `seat.lifecycle` drives them over a table CAPTURED from
        this machine's own process list with one row moved -- captured input rather than invented.
    #>
    param(
        [int]$ProcessId = $PID,
        [int]$MaxDepth = -1,
        [scriptblock]$RecordProvider
    )
    if ($MaxDepth -lt 0) { $MaxDepth = $script:AgentAncestryMaxDepth }
    if ($null -eq $RecordProvider) { $RecordProvider = { param([int]$Id) Get-ProcessAncestryRecord -ProcessId $Id } }
    $chain = [Collections.Generic.List[string]]::new()
    function New-AgentClientAnswer([int]$AgentPid, [string]$AgentName, [int]$Depth, [string]$Stopped, $Chain) {
        [pscustomobject]@{ agent_pid = $AgentPid; agent_name = $AgentName; depth = $Depth; stopped = $Stopped; chain = @($Chain) }
    }

    $current = $null
    try { $current = & $RecordProvider $ProcessId } catch { $current = $null }
    if ($null -eq $current) { return (New-AgentClientAnswer 0 '' -1 'start-gone' $chain) }
    [void]$chain.Add([string]$current.name)
    # The degenerate nearest: the client itself. No live caller is the client, and answering the
    # general question rather than "my parent" is what makes a wrapper shell between them harmless.
    if (Test-AgentClientProcessName ([string]$current.name)) {
        return (New-AgentClientAnswer ([int]$current.pid) ([string]$current.name) 0 'found' $chain)
    }

    for ($depth = 1; $depth -le $MaxDepth; $depth++) {
        $parentId = [int]$current.parent_pid
        if ($parentId -le 0) { return (New-AgentClientAnswer 0 '' $depth 'no-parent' $chain) }
        if ($parentId -eq [int]$current.pid) { return (New-AgentClientAnswer 0 '' $depth 'self-parent' $chain) }
        $parent = $null
        try { $parent = & $RecordProvider $parentId } catch { $parent = $null }
        if ($null -eq $parent) { return (New-AgentClientAnswer 0 '' $depth 'parent-gone' $chain) }
        if ($null -ne $parent.created_utc -and $null -ne $current.created_utc -and
            ([DateTime]$parent.created_utc) -gt ([DateTime]$current.created_utc)) {
            return (New-AgentClientAnswer 0 '' $depth 'parent-reused' $chain)
        }
        [void]$chain.Add([string]$parent.name)
        if (Test-AgentClientProcessName ([string]$parent.name)) {
            return (New-AgentClientAnswer ([int]$parent.pid) ([string]$parent.name) $depth 'found' $chain)
        }
        $current = $parent
    }
    New-AgentClientAnswer 0 '' $MaxDepth 'depth' $chain
}

# The walk's answer for THIS process, held for its lifetime. Initialised at load so a first read
# under StrictMode has a value.
$script:CurrentAgentProcessCache = $null

function Resolve-CurrentAgentProcess {
    <#
    .SYNOPSIS
        THIS process's agent, and WHICH ROUTE answered: `environment-pid`, `parent-chain` or `none`.

    .DESCRIPTION
        `CLAUDE_PID` FIRST, because it is the route every helper, guard and hook already has, it
        costs one environment read, and it NAMES the agent instead of inferring it. The ancestry walk
        is the fallback, and it is the route the validated reader adapter runs on.

        THE WALK IS CACHED; THE BINDING IS NOT, AND THAT DISTINCTION IS THE WHOLE OF STEP 11. What
        the adapter used to cache was the resolved SEAT, so a binding written after it started was
        invisible for its lifetime. Ancestry is different in kind: a process's parent is fixed at
        creation and cannot change, so re-walking per request would buy nothing. What CAN change is
        that the client dies and its pid is reused, so the cache stores the client's own identity and
        every call checks it still matches; a mismatch re-walks, which finds nothing and resolves no
        seat. The seat itself is read from disk by Resolve-SeatName on every single call.

        `-AncestryOnly` IS FOR A CALLER THAT KNOWS IT IS NOT A TOOL CHILD, AND THE READER ADAPTER IS
        ONE. `CLAUDE_PID` is set by an agent for its OWN children and is then INHERITED by everything
        those children spawn, which is not the same claim. A Library-delegated `codex exec` runs from
        a Bash tool, so `codex.exe` inherits the Claude session's `CLAUDE_PID` and hands it to the
        validated reader it launches -- and that adapter would resolve the CLAUDE session's binding
        and serve a different seat's Desk to Codex, while Codex's own guards resolved Codex's seat.
        That is the guard-versus-reader disagreement this whole step exists to end, arriving by the
        route meant to fix it. An MCP server gets no `CLAUDE_PID` of its own (measured, step 0b), so
        any value it can see belongs to something else and its ancestry is the only honest answer.

        IT IDENTIFIES AND DOES NOT AUTHENTICATE, on BOTH routes. Any process can set `CLAUDE_PID`,
        and any process can be named `claude.exe`, exactly as any process can read the claim token
        out of the claim file. ADR-0018 states the boundary: the Desk is a control over attention,
        and verified identity is here so that a MISTAKE -- a stale value, an inherited value, a
        reused pid, a resumed conversation -- cannot silently read or write the wrong seat.
    #>
    param([switch]$AncestryOnly, [switch]$NoCache)
    if (-not $AncestryOnly) {
        $raw = [string]$env:CLAUDE_PID
        if (-not [string]::IsNullOrWhiteSpace($raw)) {
            $parsed = 0
            if ([int]::TryParse($raw.Trim(), [ref]$parsed) -and $parsed -gt 0) {
                return [pscustomobject]@{ agent_pid = $parsed; route = 'environment-pid' }
            }
        }
    }
    if (-not $NoCache) {
        $cached = $script:CurrentAgentProcessCache
        if ($null -ne $cached) {
            $identity = [string](Get-AgentProcessIdentity -ProcessId ([int]$cached.agent_pid))
            if (-not [string]::IsNullOrWhiteSpace($identity) -and $identity -ceq [string]$cached.identity) {
                return [pscustomobject]@{ agent_pid = [int]$cached.agent_pid; route = 'parent-chain' }
            }
            $script:CurrentAgentProcessCache = $null
        }
    }
    $walked = Resolve-AgentClientProcess -ProcessId $PID
    $agentPid = [int]$walked.agent_pid
    if ($agentPid -le 0) { return [pscustomobject]@{ agent_pid = 0; route = 'none' } }
    $identity = [string](Get-AgentProcessIdentity -ProcessId $agentPid)
    # Cached only with an identity to revalidate against. A client that died between the walk and
    # this read leaves nothing to compare, and caching a pid we could not verify is the one thing
    # this cache must not do.
    if (-not [string]::IsNullOrWhiteSpace($identity)) {
        $script:CurrentAgentProcessCache = [pscustomobject]@{ agent_pid = $agentPid; identity = $identity }
    }
    [pscustomobject]@{ agent_pid = $agentPid; route = 'parent-chain' }
}

function Get-CurrentAgentProcessId {
    <#
    .SYNOPSIS
        The agent process THIS process belongs to, or 0 when it cannot be told. The int every
        consumer wants; Resolve-CurrentAgentProcess above also says which route answered.
    #>
    [int](Resolve-CurrentAgentProcess).agent_pid
}
function Read-SeatBinding {
    <#
    .SYNOPSIS
        A seat's binding, or `$null`. FAILS CLOSED on anything it cannot parse.

    .DESCRIPTION
        An unreadable binding is refused rather than treated as absent, for the reason
        Read-SeatRegistry already records: absent is the DANGEROUS reading. It would make an
        occupied seat look free, and the next Enter would hand a live agent's seat to another one.
    #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Seat)
    $path = Get-SeatBindingPath -StateDirectory $StateDirectory -Seat $Seat
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $raw = $null
    try { $raw = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $path)) }
    catch { throw "The seat binding at $path could not be read: $($_.Exception.Message)" }
    $parsed = $null
    try { $parsed = $raw | ConvertFrom-Json }
    catch { throw "The seat binding at $path is not valid JSON: $($_.Exception.Message). Remove it only if no agent process holds this seat." }
    $fields = @($parsed.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($required in @('agent_pid', 'state')) {
        if ($fields -cnotcontains $required) { throw "The seat binding at $path has no '$required' field." }
    }
    if ([string]$parsed.state -cnotin $script:SeatBindingStates) {
        throw "The seat binding at $path has state '$([string]$parsed.state)'; expected one of $($script:SeatBindingStates -join ', ')."
    }
    # NOT $pid: that is an automatic variable, and assigning it inside a function shadows the one
    # every other line in this file means by it.
    $agentPid = 0
    if (-not [int]::TryParse([string]$parsed.agent_pid, [ref]$agentPid) -or $agentPid -le 0) {
        throw "The seat binding at $path names a malformed agent_pid '$([string]$parsed.agent_pid)'."
    }
    $parsed
}

function Get-SeatBindingForAgent {
    <#
    .SYNOPSIS
        WHICH SEAT THIS AGENT PROCESS IS BOUND TO, or `$null`. The lookup Resolve-SeatName's binding
        source is made of. Reads only; takes no lock and changes nothing.

    .DESCRIPTION
        Returns `seat`, `binding` and `agent_pid`, with `seat` taken from the DIRECTORY NAME rather
        than from the record's own `seat` field: the directory name is validated by
        Get-SeatDirectoryNames and always well-formed, while the field is one a hand-edited record
        could disagree with, and the two disagreeing must not become a Desk path.

        A COMMITTED BINDING ONLY, AND ITS AGENT VERIFIED BY PID AND START TIME. A `pending` binding
        belongs to an attempt that has not committed and binds nothing. A committed binding whose PID
        has been reused by a different process is a DIFFERENT process, so it resolves to no seat at
        all -- which is the whole reason the start time is recorded, and the direction that matters:
        inheriting a seat by PID reuse would hand a stranger a live agent's Desk.

        TWO SEATS FOR ONE AGENT IS A REFUSAL, NOT A CHOICE. One agent process holds one seat for the
        life of that process (ADR-0018, D11), so two committed bindings naming it is corrupt state,
        and picking either one would resolve a Desk that half the system disagrees with. It throws;
        Resolve-SeatName catches and refuses, which is how a read that never throws still fails closed.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        # This process's own agent. Supplied by fixtures; resolved from CLAUDE_PID otherwise.
        [int]$AgentProcessId = -1
    )
    if ($AgentProcessId -lt 0) { $AgentProcessId = Get-CurrentAgentProcessId }
    if ($AgentProcessId -le 0) { return $null }

    $found = [Collections.Generic.List[object]]::new()
    foreach ($seatName in @(Get-SeatDirectoryNames -StateDirectory $StateDirectory)) {
        $binding = Read-SeatBinding -StateDirectory $StateDirectory -Seat $seatName
        if ($null -eq $binding) { continue }
        if ([string]$binding.state -cne 'committed') { continue }
        if ([int]$binding.agent_pid -ne $AgentProcessId) { continue }
        $fields = @($binding.PSObject.Properties | ForEach-Object { $_.Name })
        $startUtc = if ($fields -ccontains 'agent_start_utc') { [string]$binding.agent_start_utc } else { '' }
        if (-not (Test-SeatAgentAlive -ProcessId $AgentProcessId -StartUtc $startUtc)) { continue }
        [void]$found.Add([pscustomobject]@{ seat = $seatName; binding = $binding; agent_pid = $AgentProcessId })
    }
    if ($found.Count -gt 1) {
        throw ("Agent process $AgentProcessId is bound to $($found.Count) seats -- $(@($found | ForEach-Object { $_.seat }) -join ', ') " +
               '-- and one agent process holds exactly one seat. Remove the binding that does not belong, ' +
               'with tools/Retire-Seat.ps1 or by ending this conversation and starting a new one.')
    }
    if ($found.Count -eq 0) { return $null }
    $found[0]
}

function Get-DeskStateDirectory {
    <#
    .SYNOPSIS
        Where one seat's Desk files live. THE one place a seat refusal is worded.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [string]$Seat,
        # The agent whose binding decides an IMPLICIT resolution. Supplied by fixtures, and by step
        # 11's adapter, which identifies its agent by parent process rather than by CLAUDE_PID.
        [int]$AgentProcessId = -1,
        # FORWARDED, NOT REINTERPRETED. This function is where the refusal is thrown, so a caller
        # resolving its ACTING seat through it must be able to reach the same remedy wording it
        # would get from Resolve-SeatName directly -- otherwise the guard in
        # `seat.resolution-contract` would name a fix that could not be applied here. No caller
        # needs it today; it exists so the first one that does is not told to invent something.
        [switch]$ActingSeatOnly,
        [string]$SeatArgumentMeans
    )
    # THE STATE DIRECTORY GOES THROUGH, and it is what makes every consumer that resolves a seat
    # IMPLICITLY -- both guards, the Desk hook, the reader adapter -- binding-aware rather than
    # environment-only. Without it a bound session's guard would read one seat's Desk while its
    # writes refused at another.
    $resolved = Resolve-SeatName -Seat $Seat -StateDirectory $StateDirectory -AgentProcessId $AgentProcessId `
        -ActingSeatOnly:$ActingSeatOnly -SeatArgumentMeans $SeatArgumentMeans
    if ($resolved.status -cne 'named') { throw $resolved.message }
    Join-Path (Get-SeatsDirectory $StateDirectory) $resolved.seat
}

function Get-DeskFileInDirectory {
    <#
    .SYNOPSIS
        THE ONLY PLACE `.open-books` AND `.open-projects` ARE SPELLED, given a directory that
        already holds them.

    .DESCRIPTION
        Two entry shapes reach the Desk. Most consumers are handed the directory the Desk files live
        in -- `Get-OpenShelfRoots -Directory`, the reader adapter's `Get-DeskState`, the two guards --
        and were written before that directory could be anything but `.claude`. They keep taking a
        directory, and it is now a seat's; this is what they compose with. The other shape resolves a
        seat by name, and Get-DeskFilePath below does that and then calls this.

        `desk.seat-paths-resolve` asserts no file outside BookRootSchema.ps1 composes either literal.
        That check is necessary and not sufficient: it proves the literals disappeared, not that every
        consumer resolves the same SEAT, which is what the two-seat acceptance tests are for.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$DeskDirectory,
        [Parameter(Mandatory = $true)][ValidateSet('books', 'projects')][string]$Kind
    )
    Join-Path $DeskDirectory (Get-DeskFileName $Kind)
}

# THE TWO FILENAMES, SPELLED ONCE IN THE WHOLE REPOSITORY.
function Get-DeskFileName([Parameter(Mandatory = $true)][ValidateSet('books', 'projects')][string]$Kind) {
    if ($Kind -ceq 'books') { '.open-books' } else { '.open-projects' }
}

function Read-DeskFileLines {
    <#
    .SYNOPSIS
        One Desk file's lines, read through Read-AtomicBytes. The paired reader for every Desk write.

    .DESCRIPTION
        THE OTHER HALF OF THE CONTRACT, AND IT SHIPPED THE SAME DAY AS THE FIRST (2026-09-18).
        `AtomicFile.ps1:6-9` states the rule: Write-AtomicText guarantees no reader ever sees a
        PARTIAL file, and Read-AtomicBytes is what makes that guarantee usable, because the
        rename-over holds the destination for an instant and a plain reader arriving in that instant
        is REFUSED rather than served. Using one without the other is the bug. Routing the two Desk
        writers through Write-AtomicText and leaving the readers on Get-Content would have traded a
        torn read for an occasional sharing violation -- and THREE OF THE READERS ARE HOOKS, which is
        the worst place for it to land: a PreToolUse guard that throws denies the reader's tool call
        and says nothing about why, in the middle of work that has nothing to do with the Desk.

        SO THIS IS WHERE EVERY DESK READ GOES. Before today there were twenty-one read sites across
        seventeen files, each with its own hand-copied Trim/blank/`#` pipeline; the Hub's note said
        four. The
        duplication is why the contract could be half-applied without anyone seeing it.

        AN ABSENT FILE READS AS EMPTY, and the caller decides whether that is legal. Each existing
        reader already tests the path and words its own consequence -- a hook says the Desk is not
        configured, a manifest run reads it as every Book closed, which is the fail-safe direction --
        and throwing here would take that wording away from the only place that knows what it means.

        NOT RETURNED BEHIND A COMMA, AND THAT IS A DELIBERATE DEPARTURE FROM Read-AtomicBytes BELOW
        IT. The comma is right for a byte[]: nothing writes `@(Read-AtomicBytes ...)`, so the only
        reachable mistake is the one the comma prevents. For a LINE COLLECTION the reflex inverts --
        `@( ... )` is how every one of the twenty existing call sites is written -- and `@(f)` around
        a comma-returning function NESTS: the pipeline unrolls the outer array, `@()` collects the one
        inner array as a single element, and `-ccontains 'shelf/demo'` then answers about an array.
        That is the wrong answer in the FAIL-OPEN direction for Get-SeatsHoldingEntry, which decides
        whether an archive may proceed.

        Both failure modes were measured on 2026-09-18 rather than reasoned about. Unrolled and
        assigned bare, an empty result is $null: `.Count` on it THROWS under Set-StrictMode Latest,
        while `-ccontains` returns $false and `foreach` iterates nothing -- which is the correct
        answer for an empty Desk. So the unrolled shape fails loudly or not at all, and the comma
        fails silently and wrongly. Wrap this in `@( )`, the way the callers already do.

        THE BOM IS STRIPPED BECAUSE Get-Content STRIPPED IT. Nothing in the Library writes one -- both
        writers use UTF8Encoding($false) -- but a Desk file is plain text a reader may repair in an
        editor that does, and a surviving U+FEFF would make line one `<U+FEFF>books/demo`, which matches
        no Book-root pattern. That is a malformed-state refusal for a file whose content is right.

        PLAIN STRINGS, which is the second thing it replaces. Every line Get-Content emits carries
        PSPath, PSProvider and the rest, and PSProvider reaches the whole provider graph -- including
        the NAS on this machine. Retire-Seat.ps1 paid a session for handing those to ConvertTo-Json.
        A split of a decoded string cannot carry them, so the trap is now closed structurally rather
        than by each caller remembering to cast.
    #>
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
    $bytes = Read-AtomicBytes -Path $Path
    $text = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        [Text.UTF8Encoding]::new($false).GetString($bytes, 3, $bytes.Length - 3)
    }
    else { [Text.UTF8Encoding]::new($false).GetString($bytes) }
    $lines = @($text -split "`r?`n")
    # A TRAILING NEWLINE IS A TERMINATOR, NOT AN EMPTY LINE -- which is what Get-Content did, and
    # every caller was written against. Both writers end the body with a newline, so without this
    # every Desk file in the Library would gain one phantom line. Guarded at one element because
    # `0..-1` is the DESCENDING range 0,-1 in PowerShell and would hand back two bogus entries.
    if ($lines.Count -and $lines[-1] -ceq '') {
        $lines = if ($lines.Count -eq 1) { @() } else { @($lines[0..($lines.Count - 2)]) }
    }
    @($lines)
}

function Get-DeskFileEntries {
    <#
    .SYNOPSIS
        One Desk file's entries: trimmed, blanks and `#` comments dropped. What almost every caller wants.

    .DESCRIPTION
        The filtering half, separated from the reading half because two callers legitimately want the
        raw lines -- Retire-Seat.ps1 fingerprints what is literally in the file, and it must not start
        disagreeing with itself over a comment. Everything else wants entries, and got them by
        copying the same three-stage pipeline into seventeen files.
    #>
    param([Parameter(Mandatory = $true)][string]$Path)
    @(Read-DeskFileLines -Path $Path | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
}

function Get-DeskFileRelativePath {
    <#
    .SYNOPSIS
        A seat's Desk file as a workspace-RELATIVE path, for fixtures that write by relative path.
    #>
    param([string]$Seat = 'fixture', [Parameter(Mandatory = $true)][ValidateSet('books', 'projects')][string]$Kind)
    $resolved = Resolve-SeatName -Seat $Seat
    if ($resolved.status -cne 'named') { throw $resolved.message }
    ".claude/$($script:SeatsDirectoryName)/$($resolved.seat)/$(Get-DeskFileName $Kind)"
}

function Initialize-FixtureDesk {
    <#
    .SYNOPSIS
        Give a fixture workspace a seat's Desk, through the real resolver. Returns the Desk directory.

    .DESCRIPTION
        THE SAME REASON Initialize-ShelfCatalogForFixture EXISTS, and it is not hypothetical here: on
        the day the guards became seat-aware, three suites failed at once because every one of them
        composed `.claude/.open-books` by hand. A fixture that spells the layout itself keeps passing
        against a layout production has stopped using -- it defends the stale shape rather than
        catching the drift.

        BOTH FILES, ALWAYS. Every reader of the pair throws on a missing file rather than treating it
        as empty, so a fixture that writes only `.open-books` fails for a reason that has nothing to
        do with what it was testing.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [string]$Seat = 'fixture',
        [string]$Books = '',
        [string]$Projects = ''
    )
    $deskDirectory = Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat
    if (-not (Test-Path -LiteralPath $deskDirectory -PathType Container)) { New-Item -ItemType Directory -Path $deskDirectory -Force | Out-Null }
    $utf8 = [Text.UTF8Encoding]::new($false)
    Write-AtomicText -Path (Get-DeskFileInDirectory -DeskDirectory $deskDirectory -Kind 'books') -Text $Books | Out-Null
    Write-AtomicText -Path (Get-DeskFileInDirectory -DeskDirectory $deskDirectory -Kind 'projects') -Text $Projects | Out-Null
    $deskDirectory
}

function Get-DeskFilePath {
    <#
    .SYNOPSIS
        One seat's `.open-books` or `.open-projects`, resolved from the state directory and a seat.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [string]$Seat,
        [Parameter(Mandatory = $true)][ValidateSet('books', 'projects')][string]$Kind,
        [int]$AgentProcessId = -1
    )
    Get-DeskFileInDirectory -DeskDirectory (Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat -AgentProcessId $AgentProcessId) -Kind $Kind
}

function Get-SeatDirectoryNames {
    <#
    .SYNOPSIS
        Every seat directory on disk, defensively. Enumeration is a security-relevant read: reset,
        archive and rename all decide what to touch from it.

    .DESCRIPTION
        -Force, because a hidden seat directory silently omitted from this list is a seat that reset
        would then classify as absent rather than as foreign. Reparse points are REFUSED rather than
        followed, reusing the rule NotebookIndex.ps1 applies to topic directories: a junction under
        seats/ would put another volume's Desk inside this Library's boundary. A leaf that is not a
        valid seat slug is refused rather than skipped -- skipping it is how "whole-tree" becomes a
        false name.
    #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory)
    $seatsRoot = Get-SeatsDirectory $StateDirectory
    if (-not (Test-Path -LiteralPath $seatsRoot -PathType Container)) { return @() }
    $names = [Collections.Generic.List[string]]::new()
    foreach ($directory in @(Get-ChildItem -LiteralPath $seatsRoot -Directory -Force -ErrorAction Stop)) {
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq [IO.FileAttributes]::ReparsePoint) {
            throw ("Seat directory '$($directory.Name)' is a reparse point. A seat's Desk must live inside this " +
                   'Library; remove the junction, or retire the seat with tools/Retire-Seat.ps1.')
        }
        if ($directory.Name -cnotmatch (Get-SeatSlugPattern)) {
            throw ("'$($directory.Name)' is under .claude/seats/ and is not a valid seat name. Every seat must be " +
                   'nameable, because reset and archive decide what to touch from this list.')
        }
        [void]$names.Add($directory.Name)
    }
    # Sorted: the lock order is "registry/Desk, then Book (sorted)", and every cross-seat sweep in
    # this repository walks seats in one deterministic order so two sweeps cannot deadlock.
    @($names | Sort-Object -CaseSensitive)
}

# ---------------------------------------------------------------------------------------------------
# Self-test. Fixture-only and offline; run by Invoke-LibraryChecks.ps1 as `desk.book-root-selftest`.
#
# TWO HALVES, AND THE SECOND IS THE POINT. The first exercises the schema functions directly. The
# second drives the REAL migrated consumers -- Set-VirtualDesk.ps1, Get-DeskOverview.ps1,
# Guard-BasicMemoryRead.ps1 and the reader adapter's Desk state -- against a fixture workspace, as
# separate processes, because 3.2 is a migration and a migration is only correct if every consumer
# moved. A unit test of the schema would pass with half the codebase still carrying its own copy.
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
    function Invoke-Refused([scriptblock]$Body) {
        try { & $Body | Out-Null; return '' }
        catch { return [string]$_.Exception.Message }
    }
    function Invoke-Safe([scriptblock]$Body) {
        try { return & $Body }
        catch { return $null }
    }

    # --- The schema itself ------------------------------------------------------------------------
    foreach ($root in @('books/demo', 'archive/demo', 'shelf/demo')) {
        Assert ((Invoke-Safe { ConvertTo-BookRoot $root }) -ceq $root) "the schema rejected the canonical root '$root'"
    }
    Assert ((Invoke-Safe { ConvertTo-BookRoot 'demo' }) -ceq 'books/demo') 'the pre-symmetry bare slug no longer normalises to an active shared Book'
    Assert ((Invoke-Refused { ConvertTo-BookRoot 'Books/Demo' }) -ne '') 'a capitalised root was accepted as well-formed Desk state'
    Assert ((Invoke-Refused { ConvertTo-BookRoot 'archive/projects/demo' }) -ne '') 'an archived PROJECT root was accepted as a Book root'
    Assert ((Invoke-Refused { ConvertTo-BookRoot 'notes/demo' }) -ne '') 'an unknown collection prefix was accepted'
    Assert ((Invoke-Refused { ConvertTo-BookRoot '' }) -ne '') 'an empty Desk line was accepted'

    # THE ACCEPT PATTERN, ASSERTED DIRECTLY. It is what Read-StateLines validates against in every
    # consumer, and Guard-ShelfBookRead never calls ConvertTo-BookRoot behind it -- so a loosened
    # accept pattern widens that guard with nothing to catch it. Both directions, because a pattern
    # only ever tested for what it REJECTS is half tested.
    $accept = Get-BookRootAcceptPattern
    foreach ($good in @('books/demo', 'archive/demo', 'shelf/demo', 'demo', 'demo-two')) {
        Assert ($good -cmatch $accept) "the accept pattern rejected the well-formed line '$good'"
    }
    foreach ($bad in @('archive/projects/demo', 'books/demo/wiki', 'Books/demo', 'books/Demo', 'notes/demo', '../demo', 'books/')) {
        Assert ($bad -cnotmatch $accept) "the accept pattern admitted the malformed line '$bad'"
    }
    $canonical = Get-BookRootPattern
    Assert ('demo' -cnotmatch $canonical) 'the canonical pattern accepted a bare slug, which is only valid on the way IN'
    foreach ($bad in @('archive/projects/demo', 'books/demo/wiki')) {
        Assert ($bad -cnotmatch $canonical) "the canonical pattern admitted '$bad'"
    }

    Assert ((Invoke-Safe { New-BookRoot -Location Shared -Shelf Active -Slug demo }) -ceq 'books/demo') 'an active shared Book did not build books/demo'
    Assert ((Invoke-Safe { New-BookRoot -Location Shared -Shelf Archive -Slug demo }) -ceq 'archive/demo') 'an archived shared Book did not build archive/demo'
    Assert ((Invoke-Safe { New-BookRoot -Location Shelf -Shelf Active -Slug demo }) -ceq 'shelf/demo') 'a Shelf Book did not build shelf/demo'
    Assert ((Invoke-Refused { New-BookRoot -Location Shared -Shelf Archive -Slug projects }) -ne '') "'projects' was accepted as an archived Book slug, colliding with the archived Project root"
    Assert ((Invoke-Safe { New-BookRoot -Location Shared -Shelf Active -Slug projects }) -ceq 'books/projects') 'the reserved slug was refused for an ACTIVE Book, where it does not collide'
    Assert ((Invoke-Refused { New-BookRoot -Location Shared -Shelf Active -Slug 'Demo' }) -ne '') 'a capitalised slug was accepted by the producer'

    # THE PAGE LOCATION IS THE THING A CALLER MUST NEVER RE-DERIVE. An archived shared Book's pages
    # are at archive/<slug>/wiki -- Archive-SharedBook.ps1 has put them there since the pilot -- and
    # PLAN.md's own sketch of this item guessed archive/books/<slug>.
    $archived = Invoke-Safe { Split-BookRoot 'archive/demo' }
    Assert ($null -ne $archived) 'splitting an archived root threw'
    if ($null -ne $archived) {
        Assert ([string]$archived.collection -ceq 'shared') 'an archived Book was not reported as shared; it is still in the shared collection'
        Assert ([string]$archived.shelf -ceq 'archive') 'an archived Book was not reported as archived'
        Assert ([string]$archived.slug -ceq 'demo') 'an archived root lost its slug'
        Assert ([string]$archived.wiki_root -ceq 'archive/demo/wiki') "an archived Book's pages were located at '$($archived.wiki_root)' rather than archive/demo/wiki"
    }
    $active = Invoke-Safe { Split-BookRoot 'books/demo' }
    Assert (($null -ne $active) -and ([string]$active.wiki_root -ceq 'books/demo/wiki')) 'an active shared Book lost its page location'
    Assert (($null -ne $active) -and ([string]$active.shelf -ceq 'active')) 'an active shared Book was not reported as active'
    $shelved = Invoke-Safe { Split-BookRoot 'shelf/demo' }
    Assert (($null -ne $shelved) -and ([string]$shelved.collection -ceq 'shelf')) 'a Shelf Book was not reported as local'
    Assert (($null -ne $shelved) -and ([string]$shelved.wiki_root -ceq 'shelf/demo/wiki')) 'a Shelf Book lost its page location'
    Assert ((Invoke-Safe { Split-BookRoot 'demo' }).root -ceq 'books/demo') 'a bare slug did not split as an active shared Book'

    Assert ((Invoke-Safe { Get-BookRootLabel 'archive/demo' }) -ceq 'demo (archived)') 'an archived Book was not labelled as archived to the reader'
    Assert ((Invoke-Safe { Get-BookRootLabel 'books/demo' }) -ceq 'demo (shared)') 'an active shared Book lost its label'
    Assert ((Invoke-Safe { Get-BookRootLabel 'shelf/demo' }) -ceq 'demo (shelf)') 'a Shelf Book lost its label'


    # --- THE FOURTH ROOT: an archived SHELF Book ---------------------------------------------------
    # This one is three segments where the others are two, so every pattern that touches it is a
    # chance to get alternation order wrong. `shelf` claiming the prefix and failing on `_archive` is
    # the specific failure, and it is silent: the root simply reads as malformed Desk state.
    Assert ((Invoke-Safe { ConvertTo-BookRoot 'shelf/_archive/demo' }) -ceq 'shelf/_archive/demo') 'the schema rejected the archived Shelf root'
    Assert ('shelf/_archive/demo' -cmatch (Get-BookRootPattern)) 'the canonical pattern rejected the archived Shelf root'
    Assert ('shelf/_archive/demo' -cmatch (Get-BookRootAcceptPattern)) 'the accept pattern rejected the archived Shelf root'
    foreach ($bad in @('shelf/_archive', 'shelf/_archive/Demo', 'shelf/_archive/demo/wiki', 'shelf/_other/demo', 'shelf/_archive/')) {
        Assert ($bad -cnotmatch (Get-BookRootAcceptPattern)) "the accept pattern admitted the malformed archived Shelf line '$bad'"
    }
    # An underscore cannot appear in a slug, which is the whole reason _archive can never collide
    # with a Book of that name.
    Assert ('_archive' -cnotmatch (Get-BookRootSlugPattern)) 'a slug was allowed to contain an underscore, so _archive could name a Book'

    Assert ((Invoke-Safe { New-BookRoot -Location Shelf -Shelf Archive -Slug demo }) -ceq 'shelf/_archive/demo') 'an archived Shelf Book did not build shelf/_archive/demo'
    $shelfArchived = Invoke-Safe { Split-BookRoot 'shelf/_archive/demo' }
    Assert ($null -ne $shelfArchived) 'splitting the archived Shelf root threw'
    if ($null -ne $shelfArchived) {
        Assert ([string]$shelfArchived.collection -ceq 'shelf') 'an archived Shelf Book was reported as shared; it never leaves the local Shelf'
        Assert ([string]$shelfArchived.shelf -ceq 'archive') 'an archived Shelf Book was not reported as archived'
        Assert ([string]$shelfArchived.slug -ceq 'demo') 'the archived Shelf root lost its slug to the _archive segment'
        Assert ([string]$shelfArchived.wiki_root -ceq 'shelf/_archive/demo/wiki') "an archived Shelf Book's pages were located at '$($shelfArchived.wiki_root)' rather than shelf/_archive/demo/wiki"
    }
    # THE TWO ARCHIVES MUST NOT DESCRIBE THEMSELVES IDENTICALLY. Both are 'archived' on the shelf
    # field, so a label built from that field alone says "demo (archived)" for both -- and they are
    # restored by different helpers against different storage.
    Assert ((Invoke-Safe { Get-BookRootLabel 'shelf/_archive/demo' }) -ceq 'demo (shelf, archived)') 'an archived Shelf Book was not labelled as local'
    Assert ((Invoke-Safe { Get-BookRootLabel 'shelf/_archive/demo' }) -cne (Invoke-Safe { Get-BookRootLabel 'archive/demo' })) 'the local and shared archives label themselves identically'
    # Four locations, one slug: the ambiguity refusal has to widen with the root set.
    $four = @('books/demo', 'archive/demo', 'shelf/demo', 'shelf/_archive/demo')
    Assert (@(Select-BookRootsForSlug -OpenBooks $four -Slug 'demo').Count -eq 4) 'a four-way slug collision was not reported as four roots'

    # THREE LOCATIONS, ONE SLUG. Ambiguity is refused rather than resolved, because they are three
    # different Books that happen to share a name.
    $all = @('books/demo', 'archive/demo', 'shelf/demo', 'books/other')
    Assert (@(Select-BookRootsForSlug -OpenBooks $all -Slug 'demo').Count -eq 3) 'a three-way slug collision was not reported as three roots'
    Assert (@(Select-BookRootsForSlug -OpenBooks $all -Slug 'other').Count -eq 1) 'an unambiguous slug did not resolve to one root'
    Assert (@(Select-BookRootsForSlug -OpenBooks $all -Slug 'absent').Count -eq 0) 'a closed Book was reported as open'
    Assert (@(Select-BookRootsForSlug -OpenBooks @() -Slug 'demo').Count -eq 0) 'an empty Desk reported an open Book'
    # A slug is not a prefix: 'dem' must not match 'demo'.
    Assert (@(Select-BookRootsForSlug -OpenBooks $all -Slug 'dem').Count -eq 0) 'a partial slug matched a longer Book name'

    # --- A ROOT PASSED WHERE A SLUG GOES IS REFUSED FOR THE RIGHT REASON (2026-09-09) -------------
    # The root is what Discovery and both Catalogs print, so it is the string a reader has to hand.
    # Every one of these surfaces used to call it "malformed", which reads as a typo and is the same
    # sentence a mistyped slug gets -- and in the reader it sits beside the closed-Book refusal, so
    # it could be read as the Book being closed. What is ACCEPTED is unchanged: the root is still
    # refused, and these assertions pin the reason rather than the acceptance.
    foreach ($root in @('books/demo', 'archive/demo', 'shelf/demo', 'shelf/_archive/demo')) {
        $said = Invoke-Refused { Select-BookRootsForSlug -OpenBooks $all -Slug $root }
        Assert ($said -ne '') "the root '$root' was ACCEPTED where a slug belongs"
        Assert ($said.Contains('is a Book ROOT, not a slug')) "the root '$root' was refused as malformed rather than as a root: $said"
        Assert ($said.Contains("pass 'demo'")) "the refusal for '$root' did not name the slug to pass instead: $said"
    }
    # A genuinely malformed slug must NOT be told it is a root -- the wrong reason, pointed the other
    # way, and the reason this is two sentences rather than one.
    $typo = Invoke-Refused { Select-BookRootsForSlug -OpenBooks $all -Slug 'Demo' }
    Assert ($typo.Contains('is malformed')) "a capitalised slug was not reported as malformed: $typo"
    Assert (-not $typo.Contains('is a Book ROOT')) "a capitalised slug was reported as a root: $typo"
    # A Project root is described rather than diagnosed: it is not a Book root, and saying it were
    # would be a second wrong reason. Set-VirtualDesk reaches this branch with -Kind Project.
    $projectRoot = Invoke-Refused { Select-BookRootsForSlug -OpenBooks $all -Slug 'projects/library-dev' }
    Assert ($projectRoot.Contains('reads as a root rather than a slug')) "a Project root was not described as a root: $projectRoot"
    Assert ($projectRoot.Contains("pass 'library-dev'")) "the Project-root refusal did not name the slug to pass: $projectRoot"
    # The producer side says it too, so a caller composing books/books/demo is stopped at the root.
    $producer = Invoke-Refused { New-BookRoot -Location Shared -Shelf Active -Slug 'books/demo' }
    Assert ($producer.Contains('is a Book ROOT, not a slug')) "New-BookRoot refused a root as malformed: $producer"

    # --- The migrated consumers, as real processes against a fixture workspace ----------------------
    # Get-SearchOpenBookRoots lives one layer up, in the file that dot-sources this one. Loading it
    # here is safe rather than circular: it re-enters this file as a DOT-SOURCE, and the guard on
    # this whole block is exactly that this file was not dot-sourced.
    . (Join-Path $PSScriptRoot 'SearchBoundaries.ps1')

    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('book-root-selftest-' + [guid]::NewGuid().ToString('n'))
    $utf8 = [Text.UTF8Encoding]::new($false)
    try {
        $stateDir = Join-Path $fixture '.claude'
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
        New-Item -ItemType Directory -Path (Get-DeskStateDirectory -StateDirectory $stateDir -Seat 'fixture') -Force | Out-Null
        # This half of the suite drives the REAL Set-VirtualDesk, which is a mutator and requires a
        # live claim. Loaded here rather than at the top: LibrarySeat dot-sources this file, and the
        # self-test guard is false for a dot-sourced load, so the cycle terminates.
        . (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
        Enter-FixtureSeatClaim -StateDirectory $stateDir -Seat 'fixture' | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/demo/wiki') -Force | Out-Null
        # The archived twin gets its OWN pages on disk. Without this the open-an-archived-Book
        # assertion passed against shelf/demo/wiki -- the ACTIVE Book's directory -- and proved
        # nothing about the archive at all.
        New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/_archive/demo/wiki') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $fixture 'notebook/_master-index.md'), "# Notebook`n", $utf8)
        [IO.File]::WriteAllText((Join-Path $fixture 'shelf/_catalog.md'), "# Local Shelf`n`n## Demo`n`n- **Path:** shelf/demo`n", $utf8)
        [IO.File]::WriteAllText((Join-Path $fixture 'shelf/demo/wiki/_book.md'), "# Demo`n", $utf8)
        [IO.File]::WriteAllText((Join-Path $fixture 'shelf/_archive/demo/wiki/_book.md'), "# Demo, archived`n", $utf8)
        $projectId = '00000000-0000-0000-0000-000000000000'
        [IO.File]::WriteAllText((Join-Path $stateDir '.library-project'), "$projectId`n", $utf8)
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books') -Text '' | Out-Null
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'projects') -Text '' | Out-Null

        $desk = Join-Path $PSScriptRoot 'Set-VirtualDesk.ps1'
        $overview = Join-Path $PSScriptRoot 'Get-DeskOverview.ps1'
        $guard = Join-Path (Split-Path -Parent $PSScriptRoot) (Join-Path '.claude' (Join-Path 'hooks' 'Guard-BasicMemoryRead.ps1'))
        $adapter = Join-Path (Split-Path -Parent $PSScriptRoot) (Join-Path '.claude' (Join-Path 'adapters' 'Validated-BookReader.ps1'))

        function Invoke-Desk([string[]]$DeskArgs) {
            $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $desk @DeskArgs -WorkspacePath $fixture -Json 2>&1
            if ($LASTEXITCODE -ne 0) { return $null }
            try { return (($out | Out-String).Trim() | ConvertFrom-Json) } catch { return $null }
        }
        function Get-OpenBookLines {
            @(Get-DeskFileEntries -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books'))
        }
        function Invoke-Guard([string]$Directory) {
            $payload = (@{ tool_name = 'mcp__basic-memory__list_directory'; tool_input = @{ project_id = $projectId; dir_name = $Directory } } | ConvertTo-Json -Compress -Depth 6)
            $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
            $out = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $guard -StateDirectory $stateDir -InputJsonBase64 $encoded 2>&1 | Out-String)
            # An allowed call writes nothing at all; a denial writes one JSON object.
            -not $out.Contains('"deny"')
        }
        function Invoke-WriteGuard([string]$ToolName, [hashtable]$ToolInput) {
            $payload = (@{ tool_name = $ToolName; tool_input = $ToolInput } | ConvertTo-Json -Compress -Depth 6)
            $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
            $out = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $guard -StateDirectory $stateDir -InputJsonBase64 $encoded 2>&1 | Out-String)
            -not $out.Contains('"deny"')
        }

        # THE FEATURE: an archived Book opens, and it is recorded as the path its pages are at.
        $opened = Invoke-Desk @('-Action', 'Open', '-Kind', 'Book', '-Shelf', 'Archive', '-Slug', 'demo')
        Assert ($null -ne $opened) 'opening an archived Book failed'
        Assert ((Get-OpenBookLines) -ccontains 'archive/demo') 'opening an archived Book did not record archive/demo'
        if ($null -ne $opened) {
            Assert ([string]$opened.shelf -ceq 'archive') 'the Desk did not report the shelf it opened a Book on'
        }

        # Every consumer agrees about the line that is now in the file.
        $listed = Invoke-Desk @('-Action', 'List')
        Assert (($null -ne $listed) -and (@($listed.open_books) -ccontains 'archive/demo')) 'the Desk could not read back the state it had just written'

        $deskOverview = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $overview -WorkspacePath $fixture -Json 2>&1
        $parsedOverview = try { (($deskOverview | Out-String).Trim() | ConvertFrom-Json) } catch { $null }
        Assert ($null -ne $parsedOverview) 'the Desk overview failed on state holding an archived Book'
        if ($null -ne $parsedOverview) {
            $entry = @(@($parsedOverview.open_books) | Where-Object { [string]$_.root -ceq 'archive/demo' })
            Assert ($entry.Count -eq 1) 'the Desk overview did not report the archived Book'
            if ($entry.Count -eq 1) {
                Assert ([string]$entry[0].location -ceq 'shared') 'the overview reported an archived Book as local'
                Assert ([string]$entry[0].shelf -ceq 'archive') 'the overview reported an archived Book as active'
            }
        }

        # THE DESK CONTEXT HOOK, which until now was the one Desk consumer nothing drove. The gate
        # checked that it was REGISTERED, in settings.json and in .codex/hooks.json, and never once
        # checked what it said. Two different things ride on that string: the label a reader sees,
        # which must agree with the overview above because both come from Get-BookRootLabel, and the
        # validated reader's exact callable name, which a Codex session rooted here went looking for
        # and could not find.
        $contextHook = Join-Path (Split-Path -Parent $PSScriptRoot) (Join-Path '.claude' (Join-Path 'hooks' 'Get-VirtualDeskContext.ps1'))
        function Get-DeskContext {
            $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $contextHook -StateDirectory $stateDir 2>&1
            try { return [string](((($out | Out-String).Trim()) | ConvertFrom-Json).hookSpecificOutput.additionalContext) }
            catch { return '' }
        }
        # Read-AtomicBytes rather than the line readers above: this saves the Desk VERBATIM so the
        # case below can put it back byte for byte, and splitting it into lines would rewrite its
        # terminators on the way home. It is still the paired reader -- that is what the contract
        # asks for, not a particular convenience wrapper over it.
        $savedBooks = [Text.UTF8Encoding]::new($false).GetString((Read-AtomicBytes -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books')))
        $savedProjects = [Text.UTF8Encoding]::new($false).GetString((Read-AtomicBytes -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'projects')))

        $withBook = Get-DeskContext
        Assert ($withBook.Contains('demo (archived)')) "the context hook did not label the open archived Book as the overview does: $withBook"
        Assert ($withBook.Contains('mcp__validated-book-reader__read_open_book_page')) 'the context hook named no callable reader for an open Book'
        # THE PREFIX, ASSERTED LITERALLY. The server is validated-book-reader with HYPHENS in both
        # .mcp.json and .codex/config.toml. The Hub entry that asked for this advertisement spelled
        # it with underscores, so the wrong name is the documented one and drift back to it would
        # read as correct. An unresolvable tool name is worse than naming none: it invites a session
        # to conclude the reader is broken and go around it.
        Assert (-not ($withBook.Contains('validated_book_reader'))) 'the context hook advertised the reader with underscores; the server name has hyphens'

        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'projects') -Text "projects/library-dev`n" | Out-Null
        $withProject = Get-DeskContext
        Assert ($withProject.Contains('mcp__validated-book-reader__read_open_project_page')) 'the context hook named no callable reader for an open Project Hub'

        # NOTHING OPEN. The page readers must NOT be named -- a tool named for nothing open is noise
        # on every prompt -- and the catalogs must be, because browsing is what is actually available.
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books') -Text '' | Out-Null
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'projects') -Text '' | Out-Null
        $empty = Get-DeskContext
        Assert ($empty.Contains('mcp__validated-book-reader__read_book_catalog')) 'an empty Desk did not point at the Book Catalog'
        Assert (-not ($empty.Contains('read_open_book_page'))) 'an empty Desk advertised a reader for a Book that is not open'
        Assert (-not ($empty.Contains('read_open_project_page'))) 'an empty Desk advertised a reader for a Project that is not open'

        # MALFORMED STATE MUST ADVERTISE NOTHING. This is the fail-closed half: a session that
        # cannot trust the Desk state must not also be handed a reader to use against it. The
        # advertisement was added inside the try block for exactly this reason.
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books') -Text "Books/Demo`n" | Out-Null
        $broken = Get-DeskContext
        Assert ($broken.Contains('Virtual Desk state is invalid')) "malformed Desk state did not produce the invalid-state context: $broken"
        Assert (-not ($broken.Contains('mcp__validated-book-reader__'))) 'malformed Desk state still advertised the validated reader'

        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books') -Text $savedBooks | Out-Null
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'projects') -Text $savedProjects | Out-Null

        # THE GUARD IS THE SHARP ONE. Opening the archived Book must open the archived Book and NOT
        # its active twin: before 3.2 the guard reduced every shared root to a bare slug, and a bare
        # slug cannot say which half of the collection it came from.
        Assert (Invoke-Guard 'archive/demo') 'the guard denied the archived Book that is open on the Desk'
        Assert (Invoke-Guard 'archive/demo/wiki') "the guard denied a directory inside the open archived Book"
        Assert (-not (Invoke-Guard 'books/demo')) 'opening the ARCHIVED Book also opened its active twin'
        Assert (-not (Invoke-Guard 'archive/other')) 'the guard allowed an archived Book nobody opened'
        Assert (-not (Invoke-Guard 'archive')) 'the guard allowed the whole archive to be listed'
        Assert (Invoke-Guard 'books') 'the guard stopped allowing the active Book collection to be listed'

        # Direct Project Hub edits are the one Basic Memory write surface the Desk guard exposes.
        # The path being syntactically active is not enough: the Project must actually be open.
        $writeBase = @{ project_id = $projectId; directory = 'projects/library-dev'; title = '_project'; content = '# Fixture'; note_type = 'note' }
        $notesWrite = @{ project_id = $projectId; directory = 'projects/library-dev/notes'; title = '2026-09-07-history'; content = '# Fixture'; note_type = 'note' }
        Assert (-not (Invoke-WriteGuard 'mcp__basic-memory__write_note' $writeBase)) 'the guard allowed a write to a closed active Project Hub'
        Assert (-not (Invoke-WriteGuard 'mcp__basic-memory__write_note' $notesWrite)) 'the guard allowed a notes-page write to a closed active Project Hub'
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'projects') -Text "projects/library-dev`n" | Out-Null

        # THE HUB ROOT IS PROHIBITED ON THE DIRECT PATH, AND ONLY THE ROOT. That asymmetry is the
        # ruling (PLAN-multi-desk.md D7): the root is the page every session touches at close and the
        # most structured page in the collection, so a whole-page overwrite of it belongs to
        # Edit-ProjectHub, which journals the previous body, holds the projects/<slug> lock across
        # the write, and verifies the readback. notes/ and limits/ keep the escape hatch, because
        # they are append-only narrative and the helper has no remove-item mode.
        Assert (-not (Invoke-WriteGuard 'mcp__basic-memory__write_note' $writeBase)) 'the guard allowed a direct whole-page write to an open Hub ROOT'
        $suffixedRoot = @{} + $writeBase
        $suffixedRoot.title = '_project.md'
        Assert (-not (Invoke-WriteGuard 'mcp__basic-memory__write_note' $suffixedRoot)) 'spelling the root title with its .md suffix walked around the prohibition'
        Assert (Invoke-WriteGuard 'mcp__basic-memory__write_note' $notesWrite) 'the guard denied a notes-page write to the open active Project Hub, which keeps the direct path'
        # A page DEEPER than the root that merely happens to be titled _project. It is not the Hub
        # root, so it keeps the direct path -- and it is the only case that makes the root pattern's
        # end-anchor load-bearing. Found by falsification: widening `^projects/<slug>$` to
        # `^projects/<slug>` changed no outcome until this case existed.
        $notesNamedProject = @{} + $notesWrite
        $notesNamedProject.title = '_project'
        Assert (Invoke-WriteGuard 'mcp__basic-memory__write_note' $notesNamedProject) 'a notes page titled _project was refused as if it were the Hub root'

        # edit_note TAKES THE DIRECT PATH ONLY FOR THE TWO OPERATIONS THAT ARE SAFE TO REPEAT. This
        # suite used to assert the opposite -- that an `append` to an open Hub was allowed -- which
        # is the defect rather than the boundary: a retried append duplicates content silently, and
        # nothing on this path journals a previous body or reads back what it wrote.
        foreach ($operation in @('append', 'prepend', 'insert_before_section', 'insert_after_section')) {
            $refusedEdit = @{ project_id = $projectId; identifier = 'projects/library-dev/_project'; operation = $operation; content = 'Fixture' }
            Assert (-not (Invoke-WriteGuard 'mcp__basic-memory__edit_note' $refusedEdit)) "the guard allowed a silently duplicating edit_note '$operation'"
            # CAPITALISATION IS THE CASE THAT PICKED THE ALLOWLIST. A denylist compared with -cin
            # let 'Append' through, because 'Append' is not -cin a lowercase list.
            $capitalised = @{} + $refusedEdit
            $capitalised.operation = $operation.Substring(0, 1).ToUpperInvariant() + $operation.Substring(1)
            Assert (-not (Invoke-WriteGuard 'mcp__basic-memory__edit_note' $capitalised)) "capitalising '$operation' walked around the exclusion"
        }
        $idempotentEdit = @{ project_id = $projectId; identifier = 'projects/library-dev/_project'; operation = 'replace_section'; section = '## Now'; content = 'Fixture' }
        Assert (Invoke-WriteGuard 'mcp__basic-memory__edit_note' $idempotentEdit) 'the guard denied an idempotent replace_section, which keeps the direct path'
        $guardedEdit = @{ project_id = $projectId; identifier = 'projects/library-dev/_project'; operation = 'find_replace'; find_text = 'a'; content = 'b'; expected_replacements = 1 }
        Assert (Invoke-WriteGuard 'mcp__basic-memory__edit_note' $guardedEdit) 'the guard denied a self-guarding find_replace, which keeps the direct path'
        # An operation nobody has taught this guard, and no operation at all, both fail CLOSED. That
        # is the whole difference between an allowlist and a denylist here: a future edit_note
        # operation is refused until someone decides it is safe, rather than admitted by default.
        $unknownEdit = @{ project_id = $projectId; identifier = 'projects/library-dev/_project'; operation = 'move_section'; content = 'Fixture' }
        Assert (-not (Invoke-WriteGuard 'mcp__basic-memory__edit_note' $unknownEdit)) 'an edit_note operation this guard has never been taught was admitted by default'
        $operationlessEdit = @{ project_id = $projectId; identifier = 'projects/library-dev/_project'; content = 'Fixture' }
        Assert (-not (Invoke-WriteGuard 'mcp__basic-memory__edit_note' $operationlessEdit)) 'an edit_note with no operation was admitted'

        $closedWrite = @{} + $notesWrite
        $closedWrite.directory = 'projects/other/notes'
        Assert (-not (Invoke-WriteGuard 'mcp__basic-memory__write_note' $closedWrite)) 'opening one Project Hub allowed writes to another'
        $bookWrite = @{} + $writeBase
        $bookWrite.directory = 'books/demo/wiki'
        Assert (-not (Invoke-WriteGuard 'mcp__basic-memory__write_note' $bookWrite)) 'the guard allowed a direct shared Book write'

        # A `..` SEGMENT IS NOT A PAGE NAME (S32, measured). The write patterns admitted `.` and `..`
        # as segments, so `projects/library-dev/../other/x` passed as a page of the OPEN Hub while
        # naming a closed one -- and a directory could climb out of `projects/` entirely. The
        # list_directory half always had a canonical-path rule; the write half had none.
        $climbingEdit = @{} + $guardedEdit
        $climbingEdit.identifier = 'projects/library-dev/../other/_project'
        Assert (-not (Invoke-WriteGuard 'mcp__basic-memory__edit_note' $climbingEdit)) 'an identifier climbing out of the open Hub with .. was admitted'
        $climbingWrite = @{} + $notesWrite
        $climbingWrite.directory = 'projects/library-dev/../../books/demo'
        Assert (-not (Invoke-WriteGuard 'mcp__basic-memory__write_note' $climbingWrite)) 'a directory climbing out of projects/ with .. was admitted'
        $dotWrite = @{} + $notesWrite
        $dotWrite.directory = 'projects/library-dev/./notes'
        Assert (-not (Invoke-WriteGuard 'mcp__basic-memory__write_note' $dotWrite)) 'a directory with a . segment was admitted as canonical'

        # THE TOOL NAME IS MATCHED EXACTLY (S32, measured). It was tested with -in, which is
        # case-insensitive, while the edit rule below it asked -ceq 'edit_note' -- so
        # `MCP__basic-memory__EDIT_NOTE` reached the write path and skipped the operation allowlist,
        # and a duplicating append was admitted.
        $shoutedEdit = @{} + $idempotentEdit
        $shoutedEdit.operation = 'append'
        Assert (-not (Invoke-WriteGuard 'MCP__basic-memory__EDIT_NOTE' $shoutedEdit)) 'a differently cased edit_note name walked past the operation allowlist'

        # A LOCAL SHELF BOOK IS NOT REACHABLE THROUGH BASIC MEMORY, open or not, and the guard's
        # shared filter is the only thing saying so. The mutation that removed that filter fired
        # nothing, because no Shelf Book was ever open in this fixture.
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books') -Text "archive/demo`nshelf/demo`n" | Out-Null
        Assert (-not (Invoke-Guard 'shelf/demo')) 'an open local Shelf Book was allowed as a shared-collection directory'
        Assert (-not (Invoke-Guard 'shelf')) 'the guard allowed the local Shelf as a shared-collection directory'
        Assert (Invoke-Guard 'archive/demo') 'the archived Book stopped being allowed once a Shelf Book was open beside it'
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books') -Text "archive/demo`n" | Out-Null

        # THE READER ADAPTER, driven over JSON-RPC on redirected stdin. It has no non-serving mode --
        # dot-sourcing it falls straight into `while (ReadLine)` and hangs, which is how the first
        # version of this suite discovered that -- so a request file is redirected in and the process
        # exits at EOF.
        #
        # Both probes are OFFLINE by construction: an ambiguous slug and a closed slug are both
        # refused before any network read, so this covers the migrated Select-BookRootsForSlug path
        # without a NAS. What it cannot cover is READING an archived page, because no archived Book
        # exists to read; see docs/book-root-state-schema.md.
        function Invoke-Adapter([string]$Slug) {
            $requestFile = Join-Path $fixture 'rpc.jsonl'
            $lines = @(
                (@{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{ protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'selftest'; version = '1.0' } } } | ConvertTo-Json -Compress -Depth 8),
                (@{ jsonrpc = '2.0'; method = 'notifications/initialized' } | ConvertTo-Json -Compress -Depth 8),
                (@{ jsonrpc = '2.0'; id = 2; method = 'tools/call'; params = @{ name = 'read_open_book_page'; arguments = @{ slug = $Slug; page = '_book' } } } | ConvertTo-Json -Compress -Depth 8)
            )
            [IO.File]::WriteAllText($requestFile, (($lines -join "`n") + "`n"), $utf8)
            $out = & cmd.exe /c "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$adapter`" -StateDirectory `"$stateDir`" < `"$requestFile`"" 2>&1
            ($out | Out-String)
        }

        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books') -Text "books/demo`narchive/demo`n" | Out-Null
        $ambiguous = Invoke-Adapter 'demo'
        Assert ($ambiguous.Contains('ambiguous')) "the adapter did not refuse a slug open in two locations: $ambiguous"
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books') -Text '' | Out-Null
        $closed = Invoke-Adapter 'demo'
        Assert ($closed.Contains('is closed')) "the adapter did not report a Book with no open root as closed: $closed"
        # The adapter must not have choked on archive/demo as malformed Desk state on the way there.
        Assert (-not $ambiguous.Contains('malformed')) 'the reader adapter rejected archive/demo as malformed Desk state'

        # --- THE ARCHIVED SHELF BOOK, END TO END -------------------------------------------------
        # Three separate consumers each re-derived `shelf/<slug>/wiki` instead of asking the schema
        # for wiki_root, and all three were invisible to a fixture that held an ACTIVE Book of the
        # same name: the composed path pointed at a directory that really existed, so the check
        # passed for the wrong reason. The archived twin now has its own pages on disk above, which
        # is what makes these assertions mean anything.
        $shelfGuard = Join-Path (Split-Path -Parent $PSScriptRoot) (Join-Path '.claude' (Join-Path 'hooks' 'Guard-ShelfBookRead.ps1'))
        function Invoke-ShelfReadGuard([string]$RelativePath) {
            $payload = (@{ tool_name = 'Read'; tool_input = @{ file_path = (Join-Path $fixture $RelativePath) } } | ConvertTo-Json -Compress -Depth 6)
            $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
            $out = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $shelfGuard -StateDirectory $stateDir -WorkspacePath $fixture -InputJsonBase64 $encoded 2>&1 | Out-String)
            -not $out.Contains('"deny"')
        }

        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books') -Text "shelf/_archive/demo`n" | Out-Null
        Assert (Invoke-ShelfReadGuard 'shelf/_archive/demo/wiki/_book.md') 'the guard denied a page in the archived Shelf Book that is open on the Desk'
        # THE SHARP ONE, and the reason the guard keys on roots instead of slugs: opening the
        # ARCHIVED Book must not unlock its ACTIVE twin. Reducing both to the slug 'demo' would.
        Assert (-not (Invoke-ShelfReadGuard 'shelf/demo/wiki/_book.md')) 'opening the archived Shelf Book also unlocked its active twin'
        Assert (-not (Invoke-ShelfReadGuard 'shelf/_archive/other/wiki/_book.md')) 'the guard allowed an archived Shelf Book nobody opened'
        Assert (-not (Invoke-ShelfReadGuard 'shelf/_archive')) 'the guard allowed the whole local archive to be listed'
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books') -Text "shelf/demo`n" | Out-Null
        Assert (-not (Invoke-ShelfReadGuard 'shelf/_archive/demo/wiki/_book.md')) 'opening the ACTIVE Shelf Book also unlocked its archived twin'
        Assert (Invoke-ShelfReadGuard 'shelf/demo/wiki/_book.md') 'the guard denied the active Shelf Book that is open'

        # The reader adapter serves the archived Book's OWN page, not the active twin's.
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books') -Text "shelf/_archive/demo`n" | Out-Null
        $archivedRead = Invoke-Adapter 'demo'
        Assert ($archivedRead.Contains('Demo, archived')) "the adapter did not serve the archived Shelf Book's own page: $archivedRead"
        Assert (-not $archivedRead.Contains('not in this Book')) 'the adapter looked for the archived page under the active Book''s wiki root'

        # AN ARCHIVED SHELF BOOK IS READ-ONLY, and says so rather than claiming to be closed.
        . (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')
        $archivedWrite = Invoke-Refused { Assert-ShelfBookOpen -Workspace $fixture -Slug 'demo' }
        Assert ($archivedWrite -ne '') 'a Shelf writer accepted a Book that is open only in the archive'
        Assert ($archivedWrite -match 'archived and read-only') "the writer called an archived Book closed rather than read-only: $archivedWrite"
        Assert ($archivedWrite -match 'Restore') 'the archived-write refusal did not name Restore as the way back'

        # Closing removes exactly the archived root, not the active one.
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books') -Text "books/demo`narchive/demo`n" | Out-Null
        [void](Invoke-Desk @('-Action', 'Close', '-Kind', 'Book', '-Shelf', 'Archive', '-Slug', 'demo'))
        $after = @(Get-OpenBookLines)
        Assert ($after -ccontains 'books/demo') 'closing the archived Book also closed the active one'
        Assert (-not ($after -ccontains 'archive/demo')) 'closing the archived Book left it open'

        # Refusals, through the real helper rather than through New-BookRoot directly.
        # An archived SHELF Book opens, through the real helper. This assertion is the inverse of
        # the one that stood here until 2026-08-26, when the schema still claimed the Shelf had no
        # archive and Archive-ShelfBook.ps1 had already built one.
        $openedShelfArchive = Invoke-Desk @('-Action', 'Open', '-Kind', 'Book', '-Location', 'Shelf', '-Shelf', 'Archive', '-Slug', 'demo')
        Assert ($null -ne $openedShelfArchive) 'the helper refused to open an archived Shelf Book'
        Assert ((Get-OpenBookLines) -ccontains 'shelf/_archive/demo') 'opening an archived Shelf Book did not record shelf/_archive/demo'
        [void](Invoke-Desk @('-Action', 'Close', '-Kind', 'Book', '-Location', 'Shelf', '-Shelf', 'Archive', '-Slug', 'demo'))
        Assert (-not ((Get-OpenBookLines) -ccontains 'shelf/_archive/demo')) 'closing the archived Shelf Book left it open'
        Assert ($null -eq (Invoke-Desk @('-Action', 'Open', '-Kind', 'Book', '-Shelf', 'Archive', '-Slug', 'projects'))) `
            'the helper accepted an archived Book named projects'
        # -Action List names no Book, so it must not try to build a root from an empty slug.
        Assert ($null -ne (Invoke-Desk @('-Action', 'List'))) 'listing the Desk needed a slug'

        # The one parser every search tier uses: normalises, and drops what is not a Book root.
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books') -Text "demo`narchive/kept`nnot a root`n" | Out-Null
        $searchRoots = @(Get-SearchOpenBookRoots -DeskStateDirectory (Get-DeskStateDirectory -StateDirectory $stateDir -Seat 'fixture'))
        Assert ($searchRoots -ccontains 'books/demo') 'the search tiers did not normalise a pre-symmetry bare slug'
        Assert ($searchRoots -ccontains 'archive/kept') 'the search tiers dropped an archived Book'
        Assert ($searchRoots.Count -eq 2) "the search tiers returned $($searchRoots.Count) root(s) from a file with one malformed line, expected 2"
    }
    catch {
        # An escaping exception is a FAILURE, not a quiet end to the run. Without this the suite
        # skipped every remaining assertion and still printed "passed".
        Assert $false "the suite stopped early: $($_.Exception.Message)"
    }
    finally {
        if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
    }

    if ($script:failures.Count) {
        [Console]::Error.WriteLine("book-root-schema selftest: $($script:failures.Count) of $($script:checks) check(s) FAILED")
        foreach ($failure in $script:failures) { [Console]::Error.WriteLine("  - $failure") }
        exit 1
    }
    Write-Output "book-root-schema selftest: $($script:checks) checks passed"
    exit 0
}
