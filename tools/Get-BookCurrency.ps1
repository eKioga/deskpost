<#
.SYNOPSIS
    Currency check: ask a Book's recorded upstreams what version they are now, and compare that to
    the version its articles record. Read-only, writes nothing, and never says a Book is verified.

.DESCRIPTION
    Book currency anchoring (PLAN-book-currency.md, steps 5 and 6). A Currency check is NOT a Source
    check, and CONTEXT.md keeps the two apart deliberately: a Source check compares a Book's CLAIMS
    against a raw batch that happens to still be present, and asks *is this true?*. This asks *is
    this current?* -- comparing the commit an article recorded against the commit the remote holds
    now -- and it needs nothing local at all beyond the article text.

    A MATCHING PIN PROVES THE SOURCE HAS NOT MOVED. IT NEVER PROVES AN ARTICLE REFLECTS IT. This is
    a staleness detector, not a correctness checker, and no output here may be worded as verifying a
    Book. A Book whose upstream is unreachable is UNVERIFIED, NOT DEFECTIVE -- CONTEXT.md already
    says a Book with no surviving source is finished, not orphaned, and this must not contradict it.

    THE CHEAP PATH IS THE COMMON PATH. `git ls-remote <url> <ref>` costs about a third of a second
    and answers the whole question whenever the remote tip still equals the recorded pin: that is
    `current`, with no clone, no fetch and no temporary store. Only a moved tip pays for the blobless
    fetch and the tree-level diff, and even then no file content is downloaded -- `--name-status`
    compares tree OIDs and `--no-renames` stops rename detection pulling blobs.

    PER-PIN ISOLATION. One unreachable upstream yields exactly one `cannot verify` and never
    suppresses the others, because a Book routinely mixes upstreams. Every value that originates in
    article text is grammar-checked before it is used and length-capped before it is rendered, since
    the output is itself somewhere untrusted text can land.

    TWO TIERS, TWO STATE MACHINES, BECAUSE THEIR INPUTS DIFFER.

    `-Book <slug>` is the precise tier. It reads notebook/<slug>/ when that exists -- the refresh
    source, and the ordinary case while a Book is being worked on -- and otherwise an OPEN Shelf
    Book's local pages. It does NOT read a shared Book's pages over MCP. That is not an oversight:
    Restore-BookSource.ps1 exists to rebuild notebook/<slug>/ from a published Book, so the
    composition is restore-then-check. Because it holds the cited paths, it alone can say
    `refresh due` and name the files that changed.

    `-All` is the collection tier. It reads the closed-readable Discovery manifests -- through
    BookManifestStore's committed-generation API only, never by reading files directly, so a dirty
    or half-written generation is never mistaken for current -- and joins them against the LIVE
    catalogs. The join is against shelf/_catalog.md and the shared collection's own Catalog, not
    against internal/book-manifests/shared/_roster.json: that roster is generated during backfill
    and is a known-stale snapshot, so joining against it would make a Book added since the last
    backfill INVISIBLE rather than unreported. Reading a catalog is browsing, which CONTEXT.md
    keeps available while every Book is closed; no Book page is read here in either collection.

    `-All` NEVER SAYS `refresh due`, AND NEVER CLAIMS ITS PINS WERE FETCHED. A manifest holds no
    cited paths, so a moved tip cannot be narrowed to "these files changed" -- it is reported as
    `upstream advanced -- article inspection required`, naming the `-Book` command that can answer
    it. And `-All` performs only `ls-remote`, which proves what the remote advertises now and
    nothing about whether the pinned commit is still fetchable, so it cannot and does not report
    `pinned commit unavailable`. Capture-time verification is what closes the fabricated-pin case.

    ABSENCE IS NEVER `current`. Four states are kept apart and none of them passes: a catalogued
    Book with no manifest at all; a manifest the store will not serve; a manifest written before the
    anchor roll-up existed (schema 1), which lacks the field rather than lacking anchors; and a
    manifest whose anchor data does not survive the grammar. A Book that simply cites no git
    upstream is `not anchored`, which is also not `current`.
#>
[CmdletBinding(DefaultParameterSetName = 'Book')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Book')][string]$Book,
    # The collection tier. Reads manifests and catalogs; reads no Book page and no article.
    [Parameter(Mandatory = $true, ParameterSetName = 'All')][switch]$All,
    # Skip the shared Catalog entirely and say so, rather than paying an MCP timeout offline. The
    # shared collection is then reported out of scope, never silently omitted.
    [Parameter(ParameterSetName = 'All')][switch]$ShelfOnly,
    [Parameter(ParameterSetName = 'All')][string]$McpUrl,
    [Parameter(ParameterSetName = 'All')][string]$ProjectId,
    [string[]]$AllowHost,
    [int]$TimeoutSeconds = 60,
    [string]$WorkspacePath,
    # Which seat's Desk this reads. Defaults to LIBRARY_SEAT; there is no default seat, so an
    # unset one is refused rather than guessed at.
    [string]$Seat,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
# BookDiscovery brings the catalog reader, the Desk-state reader, the manifest store and -- through
# BookManifest -- SourcesBlock and the git boundary. Dot-sourcing the one file the Discovery answer
# is built from is what keeps this tier's READERS from being a second implementation of Discovery's.
#
# IT DOES NOT MAKE THE TWO BOOK LISTS THE SAME, AND THIS COMMENT USED TO CLAIM IT DID. Discovery
# covers all four collections in the schema; `-All` covers the two ACTIVE ones, because currency asks
# whether a Book's cited upstream has moved and a retired Book's answer is not actionable. That is a
# decision, not an oversight -- but it went UNSTATED, so the answer read complete while omitting the
# archives: one Book from 2026-09-06, fourteen from 2026-09-08. `archive_note` says it now.
. (Join-Path $PSScriptRoot 'BookDiscovery.ps1')
. (Join-Path $PSScriptRoot 'SharedBookSource.ps1')

# STEP 20: THE WORKSPACE IS SELECTED, NOT ASSUMED. `Split-Path -Parent $PSScriptRoot` answered
# "which workspace" with "one level above my own code", which is right only while the program and
# the workspace are the same directory. Order: -WorkspacePath, then LIBRARY_WORKSPACE, then the
# nearest `.library/workspace.json` above the working directory, then this program's own root --
# and that last one only while the program really is a workspace, which is what keeps an un-split
# checkout working and stops an installed package inventing one. tools/WorkspaceRegistry.ps1.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
$WorkspacePath = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
# The DESK, which belongs to a seat; `.claude` is the state directory that holds every seat's.
$script:DeskStateDirectory = Get-DeskStateDirectory -StateDirectory (Join-Path $workspace '.claude') -Seat $Seat

if ($PSCmdlet.ParameterSetName -ceq 'Book' -and $Book -cnotmatch '^[a-z0-9][a-z0-9-]*$') {
    throw 'Book must be a lowercase slug using letters, digits, and hyphens.'
}

$script:CurrencyLimits = 'A matching pin proves the source has not moved. It never proves an article reflects it: this is a staleness detector, not a correctness check, and it does not verify the Book.'

# --- Asking the remote --------------------------------------------------------------------------

function Get-RemoteTip {
    param([string]$Url, [string]$Ref, [int]$Timeout)

    $result = Invoke-GitSafe -GitArgument @('ls-remote', '--exit-code', '--', $Url, $Ref) -TimeoutSeconds $Timeout
    if ($result.timed_out) { return [pscustomobject]@{ state = 'source unreachable'; tip = ''; detail = 'the remote did not answer within the timeout' } }
    if ($result.stderr -match 'redirect') { return [pscustomobject]@{ state = 'source moved'; tip = ''; detail = 'the remote redirected to a different location' } }
    if ($result.exit_code -eq 2) { return [pscustomobject]@{ state = 'ref unavailable'; tip = ''; detail = "the remote no longer advertises $Ref" } }
    if (-not $result.ok) {
        $first = (($result.stderr -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1)
        return [pscustomobject]@{ state = 'source unreachable'; tip = ''; detail = [string]$first }
    }
    $line = (($result.stdout -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1)
    $oid = (($line -split "\s+")[0]).Trim()
    if ($oid -cnotmatch '^([0-9a-f]{40}|[0-9a-f]{64})$') { return [pscustomobject]@{ state = 'source unreachable'; tip = ''; detail = 'the remote returned no usable commit id' } }
    [pscustomobject]@{ state = 'ok'; tip = $oid; detail = '' }
}

# One lookup per distinct (url, ref) across the whole run. Both tiers share it, so a Book citing one
# upstream from twelve articles -- and, at the collection tier, twelve Books citing one upstream --
# costs exactly one round trip.
$script:TipCache = @{}
function Resolve-UpstreamTip {
    param([string]$Url, [string]$Ref, [string[]]$Allowed, [int]$Timeout)

    $key = "$Url|$Ref"
    if ($script:TipCache.ContainsKey($key)) { return $script:TipCache[$key] }

    $normalised = ConvertTo-NormalisedUpstreamUrl $Url
    if (-not $normalised.ok) {
        $script:TipCache[$key] = [pscustomobject]@{ state = 'refused source'; detail = $normalised.reason; tip = ''; url = '' }
    }
    elseif (-not (Test-UpstreamHostAllowed $normalised.host_name $Allowed)) {
        $script:TipCache[$key] = [pscustomobject]@{ state = 'refused source'; detail = "host '$($normalised.host_name)' is not on the allowlist; pass -AllowHost to permit it"; tip = ''; url = '' }
    }
    else {
        $remote = Get-RemoteTip -Url $normalised.url -Ref $Ref -Timeout $Timeout
        $script:TipCache[$key] = if ($remote.state -cne 'ok') { [pscustomobject]@{ state = $remote.state; detail = $remote.detail; tip = ''; url = $normalised.url } }
                                 else { [pscustomobject]@{ state = 'ok'; detail = ''; tip = $remote.tip; url = $normalised.url } }
    }
    $script:TipCache[$key]
}

# Only reached by the per-Book tier, and only when the tip has moved. Fetches the pinned commit and
# the current tip blobless, then compares their TREES over the cited paths -- no file content
# crosses the wire.
function Get-ChangedCitedPaths {
    param([string]$Url, [string]$PinnedOid, [string]$Ref, [string[]]$Paths, [int]$Timeout)

    $scratch = Join-Path ([IO.Path]::GetTempPath()) ('library-currency-' + [Guid]::NewGuid().ToString('n'))
    try {
        New-Item -ItemType Directory -Path $scratch -Force | Out-Null
        $init = Invoke-GitSafe -GitArgument @('init', '--bare', '--quiet', $scratch) -TimeoutSeconds $Timeout
        if (-not $init.ok) { return [pscustomobject]@{ state = 'source unreachable'; changed = @(); detail = 'a scratch object store could not be created' } }

        $pin = Invoke-BoundedFetch -MeasuredPath $scratch -TimeoutSeconds $Timeout -RequireFilterAcknowledged `
            -GitArgument @('-C', $scratch, 'fetch', '--quiet', '--filter=blob:none', '--depth', '1', '--no-tags', $Url, $PinnedOid)
        if ($pin.refusal) {
            $state = if ($pin.refusal -eq 'source-unreachable') { 'source unreachable' } else { 'pinned commit unavailable' }
            return [pscustomobject]@{ state = $state; changed = @(); detail = "the pinned commit could not be fetched ($($pin.refusal))" }
        }

        $tip = Invoke-BoundedFetch -MeasuredPath $scratch -TimeoutSeconds $Timeout -RequireFilterAcknowledged `
            -GitArgument @('-C', $scratch, 'fetch', '--quiet', '--filter=blob:none', '--depth', '1', '--no-tags', $Url, "+$($Ref):refs/currency/tip")
        if ($tip.refusal) { return [pscustomobject]@{ state = 'source unreachable'; changed = @(); detail = "the current tip could not be fetched ($($tip.refusal))" } }

        $diff = Invoke-GitSafe -TimeoutSeconds $Timeout -GitArgument (@(
            '-C', $scratch, 'diff', '--name-status', '--no-renames', '-z',
            $PinnedOid, 'refs/currency/tip', '--') + @($Paths))
        if (-not $diff.ok) { return [pscustomobject]@{ state = 'source unreachable'; changed = @(); detail = 'the two commits could not be compared' } }

        # -z output is NUL-separated: status, then path, alternating.
        $fields = @(($diff.stdout -split "`0") | Where-Object { $_.Length -gt 0 })
        $changed = [Collections.Generic.List[object]]::new()
        for ($i = 0; ($i + 1) -lt $fields.Count; $i += 2) {
            [void]$changed.Add([pscustomobject]@{ status = $fields[$i]; path = $fields[$i + 1] })
        }
        [pscustomobject]@{ state = 'ok'; changed = @($changed); detail = '' }
    }
    finally { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
}

# ===================================================================================================
# The per-Book tier
# ===================================================================================================

function Get-ArticleSource {
    param([string]$Workspace, [string]$Slug)

    $notebook = Join-Path $Workspace "notebook/$Slug"
    if (Test-Path -LiteralPath $notebook -PathType Container) {
        $files = @(Get-ChildItem -LiteralPath $notebook -Filter '*.md' -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -cne '_index.md' })
        if ($files.Count) { return [pscustomobject]@{ ok = $true; origin = "notebook/$Slug"; files = $files; reason = '' } }
    }

    $shelfWiki = Join-Path $Workspace "shelf/$Slug/wiki"
    if (Test-Path -LiteralPath $shelfWiki -PathType Container) {
        # The Desk lives in .claude/.open-books and is read through the one authority every other
        # reader of it uses. An earlier version of this helper looked for internal/virtual-desk.json,
        # a file this workspace does not have -- so an OPEN Shelf Book was refused as closed and the
        # whole Shelf path was unreachable.
        $openRoots = @(Get-SearchOpenBookRoots -DeskStateDirectory $script:DeskStateDirectory)
        if ((New-BookRoot -Location Shelf -Slug $Slug) -cnotin $openRoots) {
            return [pscustomobject]@{ ok = $false; origin = "shelf/$Slug"; files = @(); reason = "the Shelf Book '$Slug' is closed; open it on the Desk, or restore its Notebook source" }
        }
        $files = @(Get-ChildItem -LiteralPath $shelfWiki -Filter '*.md' -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -cne '_index.md' -and $_.Name -cne '_book.md' })
        if ($files.Count) { return [pscustomobject]@{ ok = $true; origin = "shelf/$Slug/wiki"; files = $files; reason = '' } }
    }

    [pscustomobject]@{
        ok = $false; origin = ''; files = @()
        reason = "no local source for '$Slug'. A shared Book's pages are not read here: rebuild its Notebook source with tools/Restore-BookSource.ps1 -Book $Slug, then run this again."
    }
}

# --- The roll-up rule, shared by both tiers -------------------------------------------------------
# THE OVERALL STATUS IS THE WORST ROW, AND THE ORDER IS WHAT MAKES THAT TRUE. Each tier calls this
# with its own vocabulary, because the verdicts genuinely differ -- `refresh due` names measured file
# changes at the Book tier, `upstream advanced` names a moved tip at the collection tier -- but
# neither tier gets to choose a different RULE. `cannot verify` leads at both: an absence must never
# be reported as currency, at any scope.
#
# The collection tier learned that on 2026-09-05, when a cross-inspection found it ordered
# `upstream advanced` → `current` → `cannot verify`, so one checkable Book outranked any number of
# unmeasurable ones and a collection holding nineteen `cannot verify` Books and one `current`
# reported `current`. The per-Book tier kept the old shape for another day -- `refresh due` →
# `current` → `cannot verify` -- so one measurable article outranked thirteen unreadable ones: the
# same defect, one tier down. Ruled worst-row at BOTH tiers on 2026-09-05 rather than left to differ,
# and factored into one function so a later edit cannot fix one tier and miss the other. Every row is
# still reported individually, so ordering the summary conservatively hides nothing.
function Get-RollUpVerdict {
    param(
        # The per-verdict counts, worst-first order to walk, and what to say when nothing matched.
        [Parameter(Mandatory = $true)][object]$Counts,
        [Parameter(Mandatory = $true)][string[]]$Order,
        [Parameter(Mandatory = $true)][string]$Fallback
    )

    foreach ($verdictName in $Order) {
        # A name in the order that the counts do not carry is always an editing mistake, and a silent
        # one: the bucket would simply never win and the tier would quietly under-report. Refuse it.
        if (-not $Counts.Contains($verdictName)) {
            throw "Get-RollUpVerdict was given the order name '$verdictName', which the counts do not carry. The two are edited together or not at all."
        }
        if ($Counts[$verdictName]) { return $verdictName }
    }
    $Fallback
}

function Invoke-BookTier {
    param([string]$Workspace, [string]$Slug, [string[]]$Allowed, [int]$Timeout)

    $source = Get-ArticleSource -Workspace $Workspace -Slug $Slug
    if (-not $source.ok) {
        return [pscustomobject][ordered]@{
            operation = 'Currency check'; scope = "Book $Slug"; book = $Slug; status = 'cannot verify'
            reason = $source.reason; articles = @(); limits = $script:CurrencyLimits; shared_library_write = $false
        }
    }

    $articles = [Collections.Generic.List[object]]::new()
    foreach ($file in @($source.files | Sort-Object -Property FullName)) {
        $relative = $file.FullName.Substring($Workspace.Length).TrimStart([IO.Path]::DirectorySeparatorChar).Replace('\', '/')
        $text = ''
        try { $text = [Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($file.FullName)) }
        catch {
            [void]$articles.Add([pscustomobject][ordered]@{ article = $relative; verdict = 'cannot verify'; detail = 'the article is not valid UTF-8'; cited = 0; changed = @() })
            continue
        }

        $parsed = Read-SourcesBlock -Text $text
        if (-not $parsed.has_block) {
            [void]$articles.Add([pscustomobject][ordered]@{ article = $relative; verdict = 'skipped'; detail = 'no ## Sources block; not a compiled article'; cited = 0; changed = @() })
            continue
        }
        if (-not $parsed.ok) {
            [void]$articles.Add([pscustomobject][ordered]@{ article = $relative; verdict = 'cannot verify'; detail = "malformed anchor: $($parsed.reason)"; cited = 0; changed = @() })
            continue
        }
        if (-not @($parsed.upstreams).Count) {
            [void]$articles.Add([pscustomobject][ordered]@{ article = $relative; verdict = 'not anchored'; detail = 'the Sources block records no upstream; it gains one on the next Refresh'; cited = @($parsed.files).Count; changed = @() })
            continue
        }

        $mapping = Resolve-SourcePinMapping -Upstream $parsed.upstreams -File $parsed.files
        if (-not $mapping.fully_mapped) {
            [void]$articles.Add([pscustomobject][ordered]@{
                article = $relative; verdict = 'partially anchored'
                detail = "$(@($mapping.unmapped).Count) cited file(s) belong to no recorded upstream: $((@($mapping.unmapped) | Select-Object -First 3) -join ', ')"
                cited = @($parsed.files).Count; changed = @()
            })
            continue
        }

        $verdict = 'current'
        $detail = ''
        $changed = [Collections.Generic.List[object]]::new()
        foreach ($group in (@($mapping.mapped) | Group-Object -Property { $_.pin.repo_root })) {
            $pin = $group.Group[0].pin
            $paths = @($group.Group | ForEach-Object { $_.repo_relative })

            $cached = Resolve-UpstreamTip -Url $pin.url -Ref $pin.ref -Allowed $Allowed -Timeout $Timeout
            if ($cached.state -cne 'ok') { $verdict = 'cannot verify'; $detail = "$($cached.state): $($cached.detail)"; continue }
            if ($cached.tip -ceq $pin.commit_oid) { continue }

            $comparison = Get-ChangedCitedPaths -Url $cached.url -PinnedOid $pin.commit_oid -Ref $pin.ref -Paths $paths -Timeout $Timeout
            if ($comparison.state -cne 'ok') { $verdict = 'cannot verify'; $detail = "$($comparison.state): $($comparison.detail)"; continue }
            foreach ($entry in @($comparison.changed)) {
                [void]$changed.Add([pscustomobject]@{ status = $entry.status; path = "$($pin.repo_root)/$($entry.path)" })
            }
        }

        if ($verdict -ceq 'current' -and @($changed).Count) {
            $verdict = 'refresh due'
            $detail = "$(@($changed).Count) cited source file(s) changed upstream"
        }
        [void]$articles.Add([pscustomobject][ordered]@{
            article = $relative; verdict = $verdict; detail = $detail
            cited = @($parsed.files).Count; changed = @($changed)
        })
    }

    $counts = [ordered]@{}
    foreach ($name in @('current', 'refresh due', 'not anchored', 'partially anchored', 'cannot verify', 'skipped')) {
        $counts[$name] = @($articles | Where-Object { $_.verdict -ceq $name }).Count
    }
    # `not anchored` is a claim about compiled articles, so a Book that HAS none must not make it.
    # A capture Book is the ordinary case: every page is `skipped`, nothing was ever checkable, and
    # saying "no upstream is recorded" implies a Refresh would record one -- hence the fallback.
    # `skipped` is deliberately absent from the order: a skipped page is not a worse answer than a
    # measured one, it is no answer, and only an ALL-skipped Book reaches the fallback.
    $status = Get-RollUpVerdict -Counts $counts -Fallback 'nothing to check' `
        -Order @('cannot verify', 'refresh due', 'not anchored', 'partially anchored', 'current')
    # Reported as `not anchored` at Book scope: to a reader deciding whether to Refresh, a partial
    # anchor is the same absence, and the per-article rows already say which pages are which.
    if ($status -ceq 'partially anchored') { $status = 'not anchored' }

    [pscustomobject][ordered]@{
        operation            = 'Currency check'
        scope                = "Book $Slug"
        book                 = $Slug
        read_from            = $source.origin
        status               = $status
        counts               = [pscustomobject]$counts
        articles             = @($articles)
        limits               = $script:CurrencyLimits
        shared_library_write = $false
    }
}

# ===================================================================================================
# The collection tier
# ===================================================================================================

$script:AllAdvancedVerdict = 'upstream advanced -- article inspection required'

function Get-CatalogueBooks {
    param([string]$Workspace, [bool]$IncludeShared, [string]$Url, [string]$Project, [int]$Timeout)

    $books = [Collections.Generic.List[object]]::new()
    $catalogPath = Join-Path $Workspace 'shelf/_catalog.md'
    if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw 'This workspace has no local Shelf catalog.' }
    foreach ($slug in @(Get-DiscoveryCatalogSlugs ([IO.File]::ReadAllText($catalogPath)))) {
        $title = $slug
        try { $title = [string](Get-ShelfBook -Workspace $Workspace -Slug $slug).title } catch { }
        [void]$books.Add([pscustomobject]@{ collection = 'shelf'; slug = $slug; title = $title })
    }

    $covered = $false
    $note = ''
    if (-not $IncludeShared) {
        $note = 'Shared collection: not contacted (-ShelfOnly), so no shared Book is in this answer.'
    }
    else {
        try {
            # Lazy, so the per-Book tier and a -ShelfOnly run never pay for it.
            Add-Type -AssemblyName System.Net.Http
            $session = New-SharedBookSession -McpUrl $Url -ProjectId $Project -TimeoutSeconds $Timeout
            $entries = @(Get-SharedBookCatalog $session)
            foreach ($entry in $entries) {
                [void]$books.Add([pscustomobject]@{ collection = 'shared'; slug = [string]$entry.slug; title = [string]$entry.title })
            }
            $covered = $true
            $note = "Shared collection: all $($entries.Count) catalogued Book(s) are in scope, read from the live Catalog."
        }
        catch {
            # Out of scope and said so, never half in it -- the same rule Discovery applies to a
            # missing roster. The difference here is that this join is against the LIVE Catalog, so
            # a failure is a reachability problem rather than a staleness one.
            $note = "Shared collection: OUT OF SCOPE -- the shared Catalog could not be read ($($_.Exception.Message)). No shared Book is in this answer."
        }
    }
    [pscustomobject]@{ books = @($books); shared_covered = $covered; shared_note = $note }
}

function Get-ManifestAge {
    param([string]$CommittedUtc)
    if ([string]::IsNullOrWhiteSpace($CommittedUtc)) { return $null }
    $parsed = [DateTime]::MinValue
    if (-not [DateTime]::TryParse($CommittedUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)) { return $null }
    [int][Math]::Floor(([DateTime]::UtcNow - $parsed.ToUniversalTime()).TotalDays)
}

function Invoke-AllTier {
    param([string]$Workspace, [bool]$IncludeShared, [string]$Url, [string]$Project, [string[]]$Allowed, [int]$Timeout)

    $catalogued = Get-CatalogueBooks -Workspace $Workspace -IncludeShared $IncludeShared -Url $Url -Project $Project -Timeout $Timeout
    $rows = [Collections.Generic.List[object]]::new()

    foreach ($entry in @($catalogued.books)) {
        $row = [ordered]@{
            collection = $entry.collection
            book       = $entry.slug
            title      = $entry.title
            verdict    = ''
            detail     = ''
            generation = $null
            measured   = $null
            age_days   = $null
            upstreams  = @()
        }

        # The committed-generation API, never a file read: a dirty or half-written generation must be
        # a reported state, not something this tier can mistake for current.
        $stored = Get-StoredBookManifest -Workspace $Workspace -Slug $entry.slug -Collection $entry.collection
        $repair = if ($entry.collection -ceq 'shared') { 'tools/Update-SharedBookManifests.ps1 -Rebuild' } else { 'tools/Update-BookManifests.ps1 -Rebuild' }

        if ($stored.status -ceq 'missing') {
            $row.verdict = 'cannot verify'
            $row.detail = "no manifest: this Book is catalogued but has no Discovery manifest. Run $repair."
            [void]$rows.Add([pscustomobject]$row); continue
        }
        if ($stored.status -cne 'ok') {
            $row.verdict = 'cannot verify'
            $row.detail = "manifest unavailable ($($stored.status)): $($stored.reason)"
            [void]$rows.Add([pscustomobject]$row); continue
        }
        $row.generation = $stored.generation
        $row.measured = $stored.committed_utc
        $row.age_days = Get-ManifestAge $stored.committed_utc

        $anchors = Read-ManifestAnchors $stored.manifest
        if (-not $anchors.present) {
            $row.verdict = 'cannot verify'
            $row.detail = "manifest lacks anchor data: it was written before the upstream roll-up existed. A plain backfill will report it already current, so run $repair."
            [void]$rows.Add([pscustomobject]$row); continue
        }
        if (-not $anchors.ok) {
            $row.verdict = 'cannot verify'
            $row.detail = "malformed anchor: $($anchors.reason)"
            [void]$rows.Add([pscustomobject]$row); continue
        }

        # An article whose ## Sources block did not parse contributed no tuple at generation. Without
        # this branch a Book with one broken article and one good one would report `current` here
        # while `-Book` reported `cannot verify` -- the tiers contradicting each other, in the
        # direction that reassures.
        # Read-ManifestAnchors is the boundary that validates this, and an absent, negative or
        # unparseable count fails `ok` above rather than defaulting to zero here. Defaulting was the
        # defect: it turned "the manifest does not say whether every page was readable" into "every
        # page was readable", which is the one conversion this tier must never make.
        $unreadable = [int]$anchors.unreadable
        if ($unreadable -gt 0) {
            $row.verdict = 'cannot verify'
            $row.detail = "malformed anchor: $unreadable page(s) carry a ## Sources block that does not parse. Run tools/Get-BookCurrency.ps1 -Book $($entry.slug) to see which."
            [void]$rows.Add([pscustomobject]$row); continue
        }

        if (-not @($anchors.upstreams).Count) {
            $row.verdict = 'not anchored'
            $row.detail = 'the manifest records no git upstream; this Book gains one on its next Refresh from a git source'
            [void]$rows.Add([pscustomobject]$row); continue
        }

        $verdict = 'current'
        $detail = ''
        $pinRows = [Collections.Generic.List[object]]::new()
        foreach ($pin in @($anchors.upstreams)) {
            $cached = Resolve-UpstreamTip -Url $pin.url -Ref $pin.ref -Allowed $Allowed -Timeout $Timeout
            $pinVerdict = if ($cached.state -cne 'ok') { $cached.state }
                          elseif ($cached.tip -ceq $pin.commit_oid) { 'current' }
                          else { $script:AllAdvancedVerdict }
            [void]$pinRows.Add([pscustomobject][ordered]@{
                url = $pin.url; ref = $pin.ref; pinned = $pin.commit_oid
                verdict = $pinVerdict; detail = $cached.detail
            })

            # cannot verify outranks an advanced tip: a Book with one unreachable upstream has not
            # been measured, whatever the others said.
            if ($cached.state -cne 'ok') { $verdict = 'cannot verify'; $detail = "$($cached.state): $($cached.detail)" }
            elseif ($pinVerdict -ceq $script:AllAdvancedVerdict -and $verdict -ceq 'current') {
                $verdict = $script:AllAdvancedVerdict
                $detail = "the recorded ref has moved since this Book was compiled. Run tools/Get-BookCurrency.ps1 -Book $($entry.slug) to see whether any cited file changed."
            }
        }
        $row.verdict = $verdict
        $row.detail = $detail
        $row.upstreams = @($pinRows)
        [void]$rows.Add([pscustomobject]$row)
    }

    $counts = [ordered]@{}
    foreach ($name in @('current', $script:AllAdvancedVerdict, 'not anchored', 'cannot verify')) {
        $counts[$name] = @($rows | Where-Object { $_.verdict -ceq $name }).Count
    }
    # The worst row wins, by the shared rule above Invoke-BookTier. `cannot verify` outranks
    # everything, exactly as it already did among the pins WITHIN one article, and `not anchored`
    # outranks `current` because it too is an absence rather than a measurement.
    $status = Get-RollUpVerdict -Counts $counts -Fallback 'nothing to check' `
        -Order @('cannot verify', $script:AllAdvancedVerdict, 'not anchored', 'current')

    # From the schema's own list, never a pair of names written here: a fifth collection reaches this
    # sentence by being added to BookRootSchema.ps1, which is the same rule Discovery's loop follows.
    $archiveCollections = @(Get-BookManifestCollections | Where-Object { (Split-BookManifestCollection $_).shelf -ceq 'archive' })

    [pscustomobject][ordered]@{
        operation             = 'Currency check'
        scope                 = if ($catalogued.shared_covered) { 'the ACTIVE local Shelf and shared collection' } else { 'the ACTIVE local Shelf' }
        status                = $status
        books_total           = @($rows).Count
        shared_books_covered  = $catalogued.shared_covered
        shared_books_note     = $catalogued.shared_note
        # Stated rather than left to the count. A reader comparing this answer with a Discovery
        # answer sees two different Book totals, and silence about why is the whole defect.
        archive_note          = "Archived Books are OUT OF SCOPE for this tier ($($archiveCollections -join ', ')), so this Book total is smaller than a Discovery answer's and is not a claim about the archives. Currency asks whether a Book's cited upstream has moved; for a retired Book that answer is not actionable. Discovery does cover both archives and labels every archived hit ARCHIVED."
        distinct_upstreams    = $script:TipCache.Count
        counts                = [pscustomobject]$counts
        books                 = @($rows)
        limits                = "$($script:CurrencyLimits) This tier compares the tip each remote advertises now against the pin the Book's manifest records: the pinned commit is NOT fetched, so a pin that was never on the remote is not detected here, and a moved tip cannot be narrowed to which files changed. Use -Book for that."
        shared_library_write  = $false
    }
}

# ===================================================================================================

$result = if ($PSCmdlet.ParameterSetName -ceq 'All') {
    Invoke-AllTier -Workspace $workspace -IncludeShared (-not $ShelfOnly) -Url $McpUrl -Project $ProjectId -Allowed $AllowHost -Timeout $TimeoutSeconds
}
else {
    Invoke-BookTier -Workspace $workspace -Slug $Book -Allowed $AllowHost -Timeout $TimeoutSeconds
}

Write-LibraryResult -Result $result -Json:$Json
