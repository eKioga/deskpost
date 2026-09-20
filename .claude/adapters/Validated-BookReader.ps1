[CmdletBinding()]
param(
    [string]$StateDirectory,
    [string]$Seat,
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [string]$ProjectSlug,
    [switch]$ProjectBriefing,
    [switch]$SelfTest,
    [switch]$ShelfSelfTest,
    [switch]$LaunchSelfTest,
    [switch]$DispatchSelfTest,
    [switch]$ProjectSelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

if ([string]::IsNullOrWhiteSpace($StateDirectory)) { $StateDirectory = Split-Path -Parent $PSScriptRoot }
# THE WORKSPACE COMES FROM THE STATE DIRECTORY, WHICH STILL MEANS `.claude`. It must NOT come from
# the Desk directory: with seats that is `.claude/seats/<seat>`, so `Split-Path -Parent` on it yields
# `.claude/seats` and every Shelf path built from it points at nothing. Two functions below did
# exactly that and were correct only while the two happened to be the same directory -- the same
# conflation that produced the `.claude\.claude` bug recorded further down this file.
$script:Workspace = Split-Path -Parent $StateDirectory
$script:RemoteSessionId = $null
$script:RemoteRequestId = 100

# The Book-root state schema (plan item 3.2) lives in tools/BookRootSchema.ps1. This import is HARD,
# unlike the two guarded ones below: Discovery and full text are tools, and losing one costs one
# tool, but the Book-root shape decides whether any Book may be read at all. An adapter that cannot
# load it must not fall back to a private copy of the rule -- a private copy is exactly what this
# item removed from eight files.
. (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) (Join-Path 'tools' 'BookRootSchema.ps1'))
# The deployment resolver, for the Basic Memory endpoint the NAS address used to supply from line 26.
. (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) (Join-Path 'tools' 'LibraryDeployment.ps1'))
# -Optional, for the same reason the seat resolution below is recorded rather than thrown: this is a
# long-running process the client launched, and a throw at load takes the whole validated reader down
# so the client reports a broken MCP server instead of an unconfigured endpoint. The refusal is
# raised at the transport instead, where it answers one tool call and leaves the reader running.
$McpUrl = Resolve-LibraryMcpUrl -McpUrl $McpUrl -WorkspacePath $script:Workspace -Optional

# A FAILURE TO RESOLVE DOES NOT KILL THE ADAPTER. This is a long-running process launched by the
# client: throwing at load would take the whole validated reader down and the client would report a
# broken MCP server rather than the actual problem, which is that this session has no seat. So the
# resolution is RECORDED and every Desk read raises its message instead -- one tool error the reader
# can act on, naming the helpers that sit down at a seat.
#
# AND IT RESOLVES PER REQUEST, WHICH IS PLAN-seat-launch.md STEP 11. It used to resolve once here and
# cache for the process's lifetime, and steps 9 and 10 turned that from a documented cutover note
# into a live blocker: a session the SessionStart hook binds holds no `LIBRARY_SEAT` -- the agent
# button never set one -- and step 0b measured that `CLAUDE_PID` never reaches an MCP server. So this
# process had NEITHER route, resolved `unset`, and refused every Book and Project page at a seat its
# guards agreed was open. Measured live on 2026-09-10: guard `named/omega/binding`, adapter `unset`.
# That is the half-migration ADR-0015 rejects, so ATTACHMENT of an already-running adapter is the
# requirement, not a restart note -- a binding written while this process is alive must be the seat
# its very next request serves. The identity route it runs on is its own process ANCESTRY
# (Resolve-CurrentAgentProcess), which answers for a `codex.exe` parent as well as a `claude.exe` one.
#
# WHAT IS CACHED AND WHAT IS NOT. The ancestry walk is cached in the schema, because a parent is
# fixed at creation; the SEAT is read from disk on every request, because that is the thing that
# changes. Proven end to end by `desk.two-seat-acceptance`, which binds a seat while a real adapter
# process is already serving and asserts the next request answers from it.
function Update-AdapterSeatResolution {
    # ANCESTRY ONLY, NAMED RATHER THAN LEFT TO THE DEFAULT. An MCP server is given no `CLAUDE_PID` of
    # its own, so any value in this environment was INHERITED from whatever launched the client -- and
    # a Library-delegated `codex exec` really does hand this process the Claude session's value. That
    # would resolve the wrong agent's binding and serve a different seat's Desk, which is the exact
    # disagreement this step closes.
    $agent = Resolve-CurrentAgentProcess -AncestryOnly
    $script:SeatResolution = Resolve-SeatName -Seat $Seat -StateDirectory $StateDirectory -AgentProcessId ([int]$agent.agent_pid)
    $script:DeskDirectory = if ($script:SeatResolution.status -ceq 'named') {
        Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $script:SeatResolution.seat
    }
    else { $null }
    $script:SeatResolution
}
# At load as well, because the self-test entry points below run before the request loop and each
# reads `$script:DeskDirectory` as its default.
Update-AdapterSeatResolution | Out-Null

# Discovery (plan item 2.2, rung 6) lives in tools/BookDiscovery.ps1 and is loaded here rather than
# reimplemented, so the query, the leak canaries, and the refusing store read have exactly one
# implementation and one suite. It is guarded: a missing module must cost the Discovery tool only,
# never the reads that every other tool on this adapter serves.
$script:DiscoveryModule = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) (Join-Path 'tools' 'BookDiscovery.ps1')
$script:DiscoveryLoadError = ''
if (Test-Path -LiteralPath $script:DiscoveryModule -PathType Leaf) {
    try { . $script:DiscoveryModule }
    catch { $script:DiscoveryLoadError = $_.Exception.Message }
}
else { $script:DiscoveryLoadError = 'tools/BookDiscovery.ps1 is not present in this workspace.' }

# Full text (plan item 2.3) lives in tools/BookFullText.ps1, loaded on the same terms and guarded the
# same way. It is a SEPARATE module from Discovery because the two answer different questions under
# different boundaries -- Discovery spans closed Books because it reads metadata, this reads bodies
# and so is confined to Books open on the Desk (ADR-0002) -- and one file holding both would make
# that boundary a branch rather than a structure.
$script:FullTextModule = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) (Join-Path 'tools' 'BookFullText.ps1')
$script:FullTextLoadError = ''
if (Test-Path -LiteralPath $script:FullTextModule -PathType Leaf) {
    try { . $script:FullTextModule }
    catch { $script:FullTextLoadError = $_.Exception.Message }
}
else { $script:FullTextLoadError = 'tools/BookFullText.ps1 is not present in this workspace.' }

function Get-LibraryProjectId([string]$Directory) {
    $projectPath = Join-Path $Directory '.library-project'
    if (-not (Test-Path -LiteralPath $projectPath -PathType Leaf)) { throw 'Virtual Desk configuration is missing .library-project.' }
    $projectId = (Get-Content -Raw -LiteralPath $projectPath).Trim()
    if ($projectId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'Virtual Desk project pin is malformed.' }
    $projectId
}


# TWO DIRECTORIES, BECAUSE THEY ARE TWO DIFFERENT THINGS NOW. `.library-project` pins the WORKSPACE
# and is shared by every seat; the Desk files belong to ONE seat. Reading both from one directory was
# correct only while there was one Desk.
function Get-DeskState([string]$Directory, [string]$StateDirectory) {
    if ([string]::IsNullOrWhiteSpace($StateDirectory)) { $StateDirectory = $script:StateDirectory }
    # The seat's refusal, raised at the point of a read rather than at load. There is no default
    # seat, so this is a real state and not a misconfiguration.
    if ([string]::IsNullOrWhiteSpace($Directory)) { throw $script:SeatResolution.message }
    $openBooksPath = Get-DeskFileInDirectory -DeskDirectory $Directory -Kind 'books'
    $openProjectsPath = Get-DeskFileInDirectory -DeskDirectory $Directory -Kind 'projects'
    if (-not (Test-Path -LiteralPath $openBooksPath -PathType Leaf)) { throw 'Virtual Desk configuration is missing .open-books.' }
    $projectId = Get-LibraryProjectId -Directory $StateDirectory
    $openBooks = @(Get-DeskFileEntries -Path $openBooksPath | ForEach-Object { ConvertTo-BookRoot $_ })
    if (@($openBooks | Select-Object -Unique).Count -ne $openBooks.Count) { throw 'Virtual Desk open-book state contains duplicates.' }
    if (-not (Test-Path -LiteralPath $openProjectsPath -PathType Leaf)) { Write-AtomicText -Path $openProjectsPath -Text '' | Out-Null }
    $openProjects = @(Get-DeskFileEntries -Path $openProjectsPath)
    foreach ($root in $openProjects) { if ($root -cnotmatch '^(projects|archive/projects)/[a-z0-9][a-z0-9-]*$') { throw 'Virtual Desk open-project state is malformed.' } }
    if (@($openProjects | Select-Object -Unique).Count -ne $openProjects.Count) { throw 'Virtual Desk open-project state contains duplicates.' }
    [pscustomobject]@{ project_id = $projectId; open_books = $openBooks; open_projects = $openProjects }
}

# THE PIN IS THE WORKSPACE'S; THE REFUSAL IS THE SEAT'S. Get-DeskState above takes two directories
# because they became two things (ADR-0015). The two reads below it that need only the project id --
# Read-ValidatedProjectCatalog and Read-ValidatedActiveProjectRoot -- need no Desk FILE at all, so
# each resolved the pin itself and handed Get-LibraryProjectId the SEAT directory, which holds no
# `.library-project`. Measured 2026-09-08: read_project_catalog and suggest_active_projects were
# refused at EVERY seat with 'Virtual Desk configuration is missing .library-project' while
# read_open_project_page and read_open_project_briefing, which route through Get-DeskState, answered
# in the same session. That is the same workspace/seat conflation the derivation at the top of this
# file guards, one directory further in -- and the reason this is a function rather than two
# corrected arguments is that the next reader needing the pin without a Desk file now has somewhere
# correct to get it.
#
# THE SEAT GATE IS PART OF THE CONTRACT, not a side effect of where the pin lives. Reading the shared
# Project Catalog is a Desk read and there is no default seat, so a blank Desk directory refuses here
# exactly as it does in Get-DeskState. Before this it refused by accident: the seatless path reached
# Get-LibraryProjectId with $null and Join-Path answered 'Cannot bind argument to parameter Path
# because it is null' -- the boundary held, in wording no reader could act on. Fixing the directory
# without keeping this gate would have opened the hole instead of closing the bug.
function Get-DeskProjectId([string]$Directory, [string]$StateDirectory) {
    if ([string]::IsNullOrWhiteSpace($StateDirectory)) { $StateDirectory = $script:StateDirectory }
    if ([string]::IsNullOrWhiteSpace($Directory)) { throw $script:SeatResolution.message }
    Get-LibraryProjectId -Directory $StateDirectory
}

function Test-Page([string]$Page) {
    if ([string]::IsNullOrWhiteSpace($Page) -or $Page -match '[\\\x00-\x1F]' -or $Page.StartsWith('/') -or $Page.EndsWith('/') -or $Page -match '(^|/)\.{1,2}($|/)' -or $Page.EndsWith('.md')) {
        throw 'Page must be a canonical Book page path without the .md extension.'
    }
}

# A note that does not exist comes back as a successful but empty record. That is "not found",
# not the substituted-record case each reader rejects, and must not raise the same alarm.
function Test-AbsentRecord($Record) {
    $null -ne $Record -and [string]::IsNullOrWhiteSpace([string]$Record.file_path) -and [string]::IsNullOrWhiteSpace([string]$Record.content)
}

function ConvertFrom-SseJson([string]$Body, [int]$RequestId) {
    $messages = @($Body -split "`r?`n" | Where-Object { $_ -like 'data:*' } | ForEach-Object { $_.Substring(5).Trim() } | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
    # An id-less notifications/message log frame has no .id to read, and reading it throws under
    # StrictMode. Enumerate the property names before comparing -- and enumerate rather than reading
    # the aggregate .Name, which throws in turn on a property-less {} frame (defect family 4).
    # Held by mcp.transports-guard-idless-events.
    $match = @($messages | Where-Object { @($_.PSObject.Properties | ForEach-Object { $_.Name }) -contains 'id' -and $_.id -eq $RequestId } | Select-Object -Last 1)
    if ($match.Count -ne 1) { throw 'The Library returned no complete response for this exact request.' }
    $match[0]
}

function ConvertTo-AsciiJson($Value) {
    $json = $Value | ConvertTo-Json -Compress -Depth 12
    [regex]::Replace($json, '[^\u0000-\u007f]', { param($match) '\u{0:x4}' -f [int][char]$match.Value })
}

function Invoke-RemoteMcpOnce([string]$Method, [hashtable]$Params, [switch]$Notification) {
    $requestId = if ($Notification) { $null } else { $script:RemoteRequestId; $script:RemoteRequestId++ }
    $payload = [ordered]@{ jsonrpc = '2.0'; method = $Method }
    if ($null -ne $requestId) { $payload.id = $requestId }
    if ($null -ne $Params) { $payload.params = $Params }
    # The refusal lands here rather than at load. Re-resolving costs nothing and lets a reader who
    # configured the endpoint mid-session be answered; when there is still nothing, the resolver
    # raises its own sentence naming all three routes, which is what this call site wants reported.
    if ([string]::IsNullOrWhiteSpace($McpUrl)) {
        $McpUrl = Resolve-LibraryMcpUrl -WorkspacePath $script:Workspace
    }
    $client = [Net.Http.HttpClient]::new()
    try {
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $McpUrl)
        [void]$request.Headers.TryAddWithoutValidation('Accept', 'application/json, text/event-stream')
        [void]$request.Headers.TryAddWithoutValidation('MCP-Protocol-Version', '2025-03-26')
        if ($script:RemoteSessionId) { [void]$request.Headers.TryAddWithoutValidation('Mcp-Session-Id', $script:RemoteSessionId) }
        $request.Content = [Net.Http.ByteArrayContent]::new([Text.Encoding]::ASCII.GetBytes((ConvertTo-AsciiJson $payload)))
        $request.Content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/json; charset=utf-8')
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw "HTTP $([int]$response.StatusCode): $body" }
    }
    catch { throw "The shared Library request failed before an exact response could be validated: $($_.Exception.Message)" }
    finally { $client.Dispose() }
    if ($Method -eq 'initialize') {
        $values = [Collections.Generic.IEnumerable[string]]$null
        if (-not $response.Headers.TryGetValues('Mcp-Session-Id', [ref]$values)) { throw 'The shared Library did not establish a session.' }
        $script:RemoteSessionId = @($values)[0]
        if ([string]::IsNullOrWhiteSpace($script:RemoteSessionId)) { throw 'The shared Library did not establish a session.' }
    }
    if ($Notification) { return }
    if ($body.Trim().StartsWith('{')) { return ($body | ConvertFrom-Json) }
    ConvertFrom-SseJson -Body $body -RequestId $requestId
}

# The upstream Basic Memory server forgets its session when it restarts or the session expires, and
# it answers every later request with "Session not found". The cached id is then permanently wrong,
# and Initialize-RemoteMcp cannot notice because its whole job is to skip when an id is already held
# -- so the reader stayed wedged for the LIFE OF THE ADAPTER PROCESS, cleared only by a client
# reconnect. That is a transport fault presenting as a Library fault: every Book read failed while
# the NAS was healthy and answering a fresh initialize on the first try.
#
# Re-initialising and retrying ONCE is the whole fix, and it weakens nothing: the retried response
# is returned to the same caller and goes through the same exact-record validation the first one
# would have. It retries only on this one message, only when an id was actually cached, and never
# for `initialize` itself -- so a genuinely unreachable NAS still fails on the first attempt rather
# than being retried into a slower identical failure, and the retry cannot recurse.
function Invoke-RemoteMcp([string]$Method, [hashtable]$Params, [switch]$Notification) {
    try { return (Invoke-RemoteMcpOnce -Method $Method -Params $Params -Notification:$Notification) }
    catch {
        if ($Method -eq 'initialize' -or -not $script:RemoteSessionId) { throw }
        if ($_.Exception.Message -notmatch 'Session not found') { throw }
        $script:RemoteSessionId = $null
        Initialize-RemoteMcp
        return (Invoke-RemoteMcpOnce -Method $Method -Params $Params -Notification:$Notification)
    }
}

function Initialize-RemoteMcp {
    if ($script:RemoteSessionId) { return }
    # Both calls go to the non-retrying primitive on purpose: this function IS what the retry calls,
    # so routing its own two requests back through the wrapper would let a handshake that keeps
    # failing re-enter here without bound. Establishing a session must fail on the first attempt.
    $init = Invoke-RemoteMcpOnce -Method 'initialize' -Params @{ protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'ai-library-validated-book-reader'; version = '0.1.0' } }
    if (($init.PSObject.Properties.Name -contains 'error') -or $init.result.protocolVersion -ne '2025-03-26') { throw 'The shared Library did not accept the required protocol version.' }
    Invoke-RemoteMcpOnce -Method 'notifications/initialized' -Params @{} -Notification
}

# Windows compares paths case-insensitively, so an exact local read must confirm the on-disk
# spelling segment by segment. This is the local stand-in for the NAS reader's -cne path check.
function Resolve-ExactRelativePath([string]$Root, [string]$RelativePath) {
    $current = $Root
    foreach ($segment in @($RelativePath -split '/')) {
        if (-not (Test-Path -LiteralPath $current -PathType Container)) { return $null }
        $child = @([IO.Directory]::GetFileSystemEntries($current) | Where-Object { [IO.Path]::GetFileName($_) -ceq $segment })
        if ($child.Count -ne 1) { return $null }
        $current = $child[0]
    }
    $current
}

# $WikiRoot comes from Split-BookRoot and is never composed here. THIS BRANCH USED TO SAY "the Shelf
# has no archive so this branch could not currently be wrong", and took the root only for the sake
# of the invariant. The premise expired the day `tools/Archive-ShelfBook.ps1` built
# `shelf/_archive/<slug>`, and the shortcut underneath it then resolved every archived page against
# `shelf/<slug>/wiki` -- a directory that does not exist -- and reported the page missing. The
# invariant was right and the exemption was the bug: NO page path in this adapter is assembled from
# a slug. desk.book-root-schema fails this file on any such composition.
function Read-ShelfBookPage([string]$Slug, [string]$Page, [string]$WikiRoot, [string]$DeskStateDirectory) {
    $workspace = $script:Workspace
    $shelfRoot = Join-Path $workspace 'shelf'
    if (-not (Test-Path -LiteralPath $shelfRoot -PathType Container)) { throw 'This workspace has no local Shelf.' }
    $requestedPath = "$WikiRoot/$Page"
    # Resolved from the WORKSPACE against wiki_root, rather than from shelf/ against the slug.
    $exactPath = Resolve-ExactRelativePath -Root $workspace -RelativePath "$WikiRoot/$Page.md"
    if (-not $exactPath) { throw 'That page is not in this Book.' }
    if (-not (Test-Path -LiteralPath $exactPath -PathType Leaf)) { throw 'That page is not in this Book.' }
    # Confirm the resolved file really sits under this Book's wiki root before reading it.
    $bookWikiRoot = [IO.Path]::GetFullPath((Join-Path $workspace $WikiRoot))
    $fullPath = [IO.Path]::GetFullPath($exactPath)
    if (-not $fullPath.StartsWith($bookWikiRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal)) { throw 'The resolved page lies outside this Book; its content was withheld.' }
    $content = [IO.File]::ReadAllText($fullPath)
    if ([string]::IsNullOrWhiteSpace($content)) { throw 'The exact Shelf Book page has no readable content.' }
    $titleMatch = [regex]::Match($content, '(?m)^#\s+(.+?)\s*$')
    $title = if ($titleMatch.Success) { $titleMatch.Groups[1].Value.Trim() } else { $Page }
    [pscustomobject]@{ path = $requestedPath; file_path = "$requestedPath.md"; title = $title; content = $content }
}

function Read-ValidatedBookPage([string]$Slug, [string]$Page, [string]$DeskStateDirectory = $script:DeskDirectory) {
    # -cnotmatch: -notmatch is case-insensitive, so 'Odysseus' passes this lowercase-only rule and is
    # then reported as a *closed* Book by the -cmatch below. Fail-closed, but the wrong reason.
    # Assert-BookSlug words both refusals in one place. A ROOT -- books/<slug>, which Discovery and
    # the Catalogs print -- is now told it is a root and given the slug to pass, instead of sharing
    # the 'malformed' sentence with a typo three lines above the closed-Book refusal below.
    Assert-BookSlug -Slug $Slug
    Test-Page -Page $Page
    $state = Get-DeskState -Directory $DeskStateDirectory
    # Three locations can now hold the same slug -- books/<slug>, archive/<slug>, shelf/<slug> -- so
    # the ambiguity this refuses is wider than it was, and refusing is still the only right answer:
    # they are three different Books that happen to share a name.
    $roots = @(Select-BookRootsForSlug -OpenBooks $state.open_books -Slug $Slug)
    if ($roots.Count -eq 0) { throw "Book '$Slug' is closed." }
    if ($roots.Count -ne 1) { throw "Book '$Slug' is ambiguous; close one location before reading." }
    $bookRoot = Split-BookRoot $roots[0]
    if ($bookRoot.collection -ceq 'shelf') { return Read-ShelfBookPage -Slug $Slug -Page $Page -WikiRoot $bookRoot.wiki_root -DeskStateDirectory $DeskStateDirectory }
    # wiki_root, never a composed 'books/<slug>/wiki': an ARCHIVED shared Book's pages are at
    # archive/<slug>/wiki, and composing the active path here would read the wrong Book -- or, if the
    # active one is gone, report the archived Book's own pages as missing.
    $requestedPath = "$($bookRoot.wiki_root)/$Page"
    $expectedFilePath = "$requestedPath.md"
    Initialize-RemoteMcp
    $response = Invoke-RemoteMcp -Method 'tools/call' -Params @{ name = 'read_note'; arguments = @{ project_id = $state.project_id; identifier = $requestedPath; output_format = 'json'; include_frontmatter = $true } }
    if (($response.PSObject.Properties.Name -contains 'error') -or $response.result.isError) { throw 'The shared Library rejected this exact page request.' }
    $record = $response.result.structuredContent.result
    if ($null -eq $record) {
        $textBlock = @($response.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1)
        if ($textBlock.Count -ne 1) { throw 'The shared Library returned an unreadable page response.' }
        try { $record = $textBlock[0].text | ConvertFrom-Json } catch { throw 'The shared Library returned an unreadable page response.' }
    }
    if (Test-AbsentRecord $record) { throw 'That page is not in this Book.' }
    if ([string]$record.file_path -cne $expectedFilePath) { throw 'The shared Library returned a different record; its content was withheld.' }
    if ([string]::IsNullOrWhiteSpace([string]$record.content)) { throw 'The exact shared Book page has no readable content.' }
    [pscustomobject]@{ path = $requestedPath; file_path = $record.file_path; title = $record.title; content = $record.content }
}

function Read-ShelfCatalog([string]$DeskStateDirectory = $script:DeskDirectory) {
    $workspace = $script:Workspace
    $requestedPath = 'shelf/_catalog'
    $catalogPath = Join-Path $workspace (Join-Path 'shelf' '_catalog.md')
    if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw 'The local Shelf catalog has not been created yet.' }
    $content = [IO.File]::ReadAllText($catalogPath)
    if ([string]::IsNullOrWhiteSpace($content)) { throw 'The local Shelf catalog has no readable content.' }
    [pscustomobject]@{ path = $requestedPath; file_path = "$requestedPath.md"; title = 'Local Shelf'; content = $content }
}

function Read-ValidatedBookCatalog([ValidateSet('Shared', 'Shelf', 'All', 'Archive')][string]$Location = 'All', [string]$DeskStateDirectory = $script:DeskDirectory) {
    if ($Location -eq 'Shelf') { return Read-ShelfCatalog -DeskStateDirectory $DeskStateDirectory }
    if ($Location -eq 'Archive') { return Read-ArchiveCatalog -DeskStateDirectory $DeskStateDirectory }
    if ($Location -eq 'All') {
        $shared = Read-SharedBookCatalog -DeskStateDirectory $DeskStateDirectory
        # The Shelf is local and must not make the whole catalog unreadable if it is absent.
        try { $shelfContent = (Read-ShelfCatalog -DeskStateDirectory $DeskStateDirectory).content } catch { $shelfContent = "# Local Shelf`n`n$($_.Exception.Message)" }
        $combined = $shared.content + "`n`n---`n`n" + $shelfContent +
            "`n`nShared Books open with -Location Shared; Shelf Books open with -Location Shelf. Both are read through read_open_book_page."
        return [pscustomobject]@{ path = 'books/README+shelf/_catalog'; file_path = 'books/README.md+shelf/_catalog.md'; title = 'Book Catalog and Local Shelf'; content = $combined }
    }
    Read-SharedBookCatalog -DeskStateDirectory $DeskStateDirectory
}

# The shared ARCHIVE's own catalog. Until this existed, archive/README.md was exposed by no reader
# tool at all: Phase 3.2 gave the Desk an archive/<slug> Book root, so an archived Book could be
# OPENED, but only by a reader who already knew its slug. Discovery did not cover archived Books
# either -- manifests were generated for shelf/ and books/ only -- so there was no way to find one.
# This closed the listing half; the manifest half followed under ADR-0012, the Shelf archive on
# 2026-09-06 and the shared one on 2026-09-08. So this listing is no longer the only route to an
# archived Book, and the note below must not claim it is.
#
# It reuses the shared catalog reader rather than repeating it, so the archive listing gets exactly
# the same return validation: the record's own file_path must be the one that was asked for, or the
# content is withheld.
function Read-ArchiveCatalog([string]$DeskStateDirectory = $script:DeskDirectory) {
    $catalog = Read-SharedBookCatalog -DeskStateDirectory $DeskStateDirectory -RequestedPath 'archive/README'
    # The local Shelf has its own archive, which is a filesystem read rather than a NAS one and is
    # therefore not this tool's to answer. Named rather than silently omitted: a reader asking what
    # is archived should not have to already know the two archives are separate.
    [pscustomobject]@{
        path      = $catalog.path
        file_path = $catalog.file_path
        title     = $catalog.title
        # WHAT COVERS THE ARCHIVE IS DERIVED STATE, SO THIS SENTENCE POINTS AT IT RATHER THAN
        # ASSERTING IT. discover_book_pages covers both archives and labels an archived hit ARCHIVED,
        # but the shared half needs manifests that a checkout may not have generated yet -- so the
        # authority is that answer's own coverage sentence, which says which archives it searched.
        content   = $catalog.content + "`n`nThis is the SHARED collection's archive. Archived Books here can be opened with Set-VirtualDesk -Location Archive. The local Shelf keeps its own separate archive; list it with tools/Archive-ShelfBook.ps1 -Action List. discover_book_pages covers archived Books in both archives and labels every archived hit ARCHIVED; each answer states which archives it actually searched, and names tools/Update-SharedBookManifests.ps1 -IncludeArchive when this one has no manifests yet. search_open_books reaches an archived Book only while it is open on the Desk."
    }
}

function Read-SharedBookCatalog([string]$DeskStateDirectory = $script:DeskDirectory, [string]$RequestedPath = 'books/README') {
    $state = Get-DeskState -Directory $DeskStateDirectory
    $requestedPath = $RequestedPath
    $expectedFilePath = "$RequestedPath.md"
    Initialize-RemoteMcp
    $response = Invoke-RemoteMcp -Method 'tools/call' -Params @{ name = 'read_note'; arguments = @{ project_id = $state.project_id; identifier = $requestedPath; output_format = 'json'; include_frontmatter = $true } }
    # Named by the record that was asked for, so an archive listing does not report a missing
    # archive as a missing Book Catalog.
    $what = if ($RequestedPath -ceq 'books/README') { 'Book Catalog' } else { "record $expectedFilePath" }
    if (($response.PSObject.Properties.Name -contains 'error') -or $response.result.isError) { throw "The shared Library rejected the exact $what request." }
    $record = $response.result.structuredContent.result
    if ($null -eq $record) {
        $textBlock = @($response.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1)
        if ($textBlock.Count -ne 1) { throw "The shared Library returned an unreadable $what response." }
        try { $record = $textBlock[0].text | ConvertFrom-Json } catch { throw "The shared Library returned an unreadable $what response." }
    }
    if (Test-AbsentRecord $record) { throw "The $what has not been created yet." }
    if ([string]$record.file_path -cne $expectedFilePath) { throw 'The shared Library returned a different record; its content was withheld.' }
    if ([string]::IsNullOrWhiteSpace([string]$record.content)) { throw "The exact shared $what has no readable content." }
    [pscustomobject]@{ path = $requestedPath; file_path = $record.file_path; title = $record.title; content = $record.content }
}

function Read-ValidatedProjectPage([string]$Slug, [string]$Page, [string]$DeskStateDirectory = $script:DeskDirectory) {
    if ($Slug -cnotmatch '^[a-z0-9][a-z0-9-]*$') { throw 'Project slug is malformed.' }
    Test-Page -Page $Page
    $state = Get-DeskState -Directory $DeskStateDirectory
    $roots = @($state.open_projects | Where-Object { $_ -match ('/(?:' + [regex]::Escape($Slug) + ')$') })
    if ($roots.Count -eq 0) { throw "Project '$Slug' is closed." }
    if ($roots.Count -ne 1) { throw "Project '$Slug' is ambiguous; close one location before reading." }
    $requestedPath = "$($roots[0])/$Page"
    $expectedFilePath = "$requestedPath.md"
    Initialize-RemoteMcp
    $response = Invoke-RemoteMcp -Method 'tools/call' -Params @{ name = 'read_note'; arguments = @{ project_id = $state.project_id; identifier = $requestedPath; output_format = 'json'; include_frontmatter = $true } }
    if (($response.PSObject.Properties.Name -contains 'error') -or $response.result.isError) { throw 'The shared Library rejected this exact Project page request.' }
    $record = $response.result.structuredContent.result
    if ($null -eq $record) {
        $textBlock = @($response.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1)
        if ($textBlock.Count -ne 1) { throw 'The shared Library returned an unreadable Project page response.' }
        try { $record = $textBlock[0].text | ConvertFrom-Json } catch { throw 'The shared Library returned an unreadable Project page response.' }
    }
    if (Test-AbsentRecord $record) { throw 'That page is not in this Project.' }
    if ([string]$record.file_path -cne $expectedFilePath) { throw 'The shared Library returned a different Project record; its content was withheld.' }
    if ([string]::IsNullOrWhiteSpace([string]$record.content)) { throw 'The exact shared Project page has no readable content.' }
    [pscustomobject]@{ path = $requestedPath; file_path = $record.file_path; title = $record.title; content = $record.content }
}

function Read-ValidatedProjectCatalog([ValidateSet('Active', 'Archive')][string]$Shelf = 'Active', [string]$DeskStateDirectory = $script:DeskDirectory) {
    $projectId = Get-DeskProjectId -Directory $DeskStateDirectory
    $requestedPath = if ($Shelf -eq 'Archive') { 'archive/projects/README' } else { 'projects/README' }
    $expectedFilePath = "$requestedPath.md"
    Initialize-RemoteMcp
    $response = Invoke-RemoteMcp -Method 'tools/call' -Params @{ name = 'read_note'; arguments = @{ project_id = $projectId; identifier = $requestedPath; output_format = 'json'; include_frontmatter = $true } }
    if (($response.PSObject.Properties.Name -contains 'error') -or $response.result.isError) { throw 'The shared Library rejected this exact Project Catalog request.' }
    $record = $response.result.structuredContent.result
    if ($null -eq $record) {
        $textBlock = @($response.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1)
        if ($textBlock.Count -ne 1) { throw 'The shared Library returned an unreadable Project Catalog response.' }
        try { $record = $textBlock[0].text | ConvertFrom-Json } catch { throw 'The shared Library returned an unreadable Project Catalog response.' }
    }
    if (Test-AbsentRecord $record) {
        if ($Shelf -eq 'Archive') {
            return [pscustomobject]@{ path = $requestedPath; file_path = ''; title = 'Archived Projects'; content = "# Archived Projects`n`nNo Projects have been archived yet.`n`nThis list is created the first time you archive a Project." }
        }
        throw 'The active Project Catalog has not been created yet.'
    }
    if ([string]$record.file_path -cne $expectedFilePath) { throw 'The shared Library returned a different Project Catalog record; its content was withheld.' }
    if ([string]::IsNullOrWhiteSpace([string]$record.content)) { throw 'The exact shared Project Catalog has no readable content.' }
    [pscustomobject]@{ path = $requestedPath; file_path = $record.file_path; title = $record.title; content = $record.content }
}

function Read-ValidatedActiveProjectRoot([string]$Slug, [string]$DeskStateDirectory = $script:DeskDirectory) {
    if ($Slug -cnotmatch '^[a-z0-9][a-z0-9-]*$') { throw 'Project slug is malformed.' }
    $projectId = Get-DeskProjectId -Directory $DeskStateDirectory
    $requestedPath = "projects/$Slug/_project"
    $expectedFilePath = "$requestedPath.md"
    Initialize-RemoteMcp
    $response = Invoke-RemoteMcp -Method 'tools/call' -Params @{ name = 'read_note'; arguments = @{ project_id = $projectId; identifier = $requestedPath; output_format = 'json'; include_frontmatter = $true } }
    if (($response.PSObject.Properties.Name -contains 'error') -or $response.result.isError) { throw 'The shared Library rejected this exact active Project root request.' }
    $record = $response.result.structuredContent.result
    if ($null -eq $record) {
        $textBlock = @($response.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1)
        if ($textBlock.Count -ne 1) { throw 'The shared Library returned an unreadable active Project root response.' }
        try { $record = $textBlock[0].text | ConvertFrom-Json } catch { throw 'The shared Library returned an unreadable active Project root response.' }
    }
    if (Test-AbsentRecord $record) { throw "Active Project '$Slug' is missing its root note." }
    if ([string]$record.file_path -cne $expectedFilePath) { throw 'The shared Library returned a different active Project record; its content was withheld.' }
    if ([string]::IsNullOrWhiteSpace([string]$record.content)) { throw 'The exact active Project root has no readable content.' }
    [pscustomobject]@{ path = $requestedPath; file_path = $record.file_path; title = $record.title; content = $record.content }
}

function Get-ProjectSearchTerms([string]$Query) {
    if ([string]::IsNullOrWhiteSpace($Query) -or $Query.Length -gt 160 -or $Query -match '[\x00-\x1F]') { throw 'Project search words must be between 1 and 160 printable characters.' }
    @([regex]::Matches($Query.ToLowerInvariant(), '[a-z0-9]{2,}') | ForEach-Object { $_.Value } | Select-Object -Unique)
}

function Get-ProjectPurposeExcerpt([string]$Content) {
    $match = [regex]::Match($Content, '(?ms)^##\s+Purpose\s*\r?\n(.*?)(?=^##\s+|\z)')
    if (-not $match.Success) { return '' }
    $text = (@($match.Groups[1].Value -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch '^[-*]\s' }) -join ' ').Trim()
    if ($text.Length -gt 240) { return $text.Substring(0, 237).TrimEnd() + '...' }
    $text
}

function Get-ProjectSuggestions([string]$Query, [string]$DeskStateDirectory = $script:DeskDirectory) {
    $terms = @(Get-ProjectSearchTerms -Query $Query)
    $catalog = Read-ValidatedProjectCatalog -Shelf Active -DeskStateDirectory $DeskStateDirectory
    $catalogEntries = @([regex]::Matches($catalog.content, '(?m)^\s*-\s+\[\[projects/([a-z0-9][a-z0-9-]*)/_project\|([^\]\r\n]+)\]\]\s*$'))
    $entries = @($catalogEntries | ForEach-Object { [pscustomobject]@{ slug = $_.Groups[1].Value; title = $_.Groups[2].Value.Trim() } } | Sort-Object slug -Unique)
    if ($entries.Count -eq 0) {
        return [pscustomobject]@{ content = "# Active Project suggestions`n`nThere are no active Projects to search. No Project was opened."; suggestions = @() }
    }
    if ($entries.Count -gt 25) { throw 'The active Project Catalog has more than 25 entries; narrow discovery before requesting suggestions.' }

    $suggestions = @()
    foreach ($entry in $entries) {
        $root = Read-ValidatedActiveProjectRoot -Slug $entry.slug -DeskStateDirectory $DeskStateDirectory
        $titleMatch = [regex]::Match($root.content, '(?m)^#\s+(.+?)\s*$')
        $title = if ($titleMatch.Success) { $titleMatch.Groups[1].Value.Trim() } else { $entry.title }
        $identity = ("$($entry.slug) $title").ToLowerInvariant()
        $body = $root.content.ToLowerInvariant()
        $score = 0
        $matchedTerms = @()
        foreach ($term in $terms) {
            $pattern = '\b' + [regex]::Escape($term) + '\b'
            $identityMatches = [regex]::Matches($identity, $pattern).Count
            $bodyMatches = [regex]::Matches($body, $pattern).Count
            if (($identityMatches + $bodyMatches) -gt 0) {
                $matchedTerms += $term
                $score += (10 * $identityMatches) + [Math]::Min($bodyMatches, 3)
            }
        }
        if ($score -gt 0) {
            $suggestions += [pscustomobject]@{ slug = $entry.slug; title = $title; score = $score; matched_terms = @($matchedTerms | Select-Object -Unique); purpose = Get-ProjectPurposeExcerpt -Content $root.content }
        }
    }
    $ranked = @($suggestions | Sort-Object @{ Expression = 'score'; Descending = $true }, @{ Expression = 'title'; Descending = $false } | Select-Object -First 5)
    if ($ranked.Count -eq 0) {
        return [pscustomobject]@{ content = "# Active Project suggestions`n`nNo active Project matched '$Query'. No Project was opened."; suggestions = @() }
    }
    $lines = @('# Active Project suggestions', "", "Matches for '$Query':")
    foreach ($suggestion in $ranked) {
        $lines += "- $($suggestion.title) [$($suggestion.slug)]: matched $($suggestion.matched_terms -join ', ')."
        if (-not [string]::IsNullOrWhiteSpace($suggestion.purpose)) { $lines += "  Purpose: $($suggestion.purpose)" }
    }
    $lines += ''
    $lines += 'No Project was opened. Ask the reader which Project to open.'
    [pscustomobject]@{ content = ($lines -join "`n"); suggestions = $ranked }
}

# A briefing item is a whole bullet, wrapped continuation lines included. Keeping only the line that
# begins with '-' cut every wrapped bullet off mid-sentence, and Hub prose wraps everywhere -- so the
# briefing, which exists to orient someone returning cold, was the surface least able to afford it.
# Same wrapped-continuation family already fixed once in Edit-ProjectHub's list handling; see
# docs/project-hub-design.md.
function Get-MarkdownSectionItems([string]$Content, [string]$Heading) {
    $pattern = '(?ms)^##\s+' + [regex]::Escape($Heading) + '\s*\r?\n(.*?)(?=^##\s+|\z)'
    $match = [regex]::Match($Content, $pattern)
    if (-not $match.Success) { return @() }
    $items = [Collections.Generic.List[string]]::new()
    $current = $null
    foreach ($line in ($match.Groups[1].Value -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^-\s+.+') {
            if ($null -ne $current) { [void]$items.Add($current) }
            $current = $trimmed
        }
        elseif ($null -ne $current) {
            # A blank line or a subheading ends the bullet; any other text is its wrapped remainder.
            if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed -match '^#{1,6}\s') {
                [void]$items.Add($current)
                $current = $null
            }
            else { $current = "$current $trimmed" }
        }
    }
    if ($null -ne $current) { [void]$items.Add($current) }
    $items
}

function Format-ReturnBriefingSection([string]$Label, [string[]]$Items) {
    if ($Items.Count -eq 0) { return "- ${Label}: none recorded." }
    $shown = @($Items | Select-Object -First 5)
    $lines = @("- ${Label}:") + @($shown | ForEach-Object { "  $_" })
    if ($Items.Count -gt $shown.Count) { $lines += "  - and $($Items.Count - $shown.Count) more." }
    $lines -join "`n"
}

function Select-ReturnBriefingSections(
    [string]$ProjectContent,
    [string]$ProjectPath,
    [AllowNull()][string]$ConnectionsContent,
    [string]$ConnectionsPath
) {
    # Presence of either root heading keeps both sections on the root. Falling through section by
    # section would hide a partial migration by silently combining two pages.
    $hasKnowledge = [regex]::IsMatch($ProjectContent, '(?m)^##\s+Connected knowledge\s*\r?$')
    $hasTools = [regex]::IsMatch($ProjectContent, '(?m)^##\s+Connected tools\s*\r?$')
    $knowledge = @(Get-MarkdownSectionItems -Content $ProjectContent -Heading 'Connected knowledge')
    $tools = @(Get-MarkdownSectionItems -Content $ProjectContent -Heading 'Connected tools')
    $source = $ProjectPath
    if (-not $hasKnowledge -and -not $hasTools) {
        $knowledge = @(Get-MarkdownSectionItems -Content $ConnectionsContent -Heading 'Connected knowledge')
        $tools = @(Get-MarkdownSectionItems -Content $ConnectionsContent -Heading 'Connected tools')
        $source = $ConnectionsPath
    }
    [pscustomobject]@{
        knowledge       = $knowledge
        tools           = $tools
        sections_source = $source
    }
}

function Format-ProjectReturnBriefing([string]$Title, [string[]]$Knowledge, [string[]]$Tools) {
    "Project return briefing - $Title`n`n" +
        (Format-ReturnBriefingSection -Label 'Related Books to consider opening' -Items $Knowledge) + "`n" +
        (Format-ReturnBriefingSection -Label 'Connected tools' -Items $Tools) + "`n`n" +
        'These are recorded project connections only; no additional Books were opened automatically.'
}

function Get-ProjectReturnBriefing([string]$Slug, [string]$DeskStateDirectory = $script:DeskDirectory) {
    $root = Read-ValidatedProjectPage -Slug $Slug -Page '_project' -DeskStateDirectory $DeskStateDirectory
    $titleMatch = [regex]::Match($root.content, '(?m)^#\s+(.+?)\s*$')
    $title = if ($titleMatch.Success) { $titleMatch.Groups[1].Value.Trim() } else { $Slug }
    $sections = Select-ReturnBriefingSections -ProjectContent $root.content -ProjectPath $root.path -ConnectionsContent $null -ConnectionsPath ''
    if ($sections.sections_source -cne $root.path) {
        $connections = Read-ValidatedProjectPage -Slug $Slug -Page 'connections' -DeskStateDirectory $DeskStateDirectory
        $sections = Select-ReturnBriefingSections -ProjectContent $root.content -ProjectPath $root.path -ConnectionsContent $connections.content -ConnectionsPath $connections.path
    }
    $content = Format-ProjectReturnBriefing -Title $title -Knowledge $sections.knowledge -Tools $sections.tools
    [pscustomobject]@{ path = $root.path; file_path = $root.file_path; title = $title; content = $content; sections_source = $sections.sections_source }
}

# Discovery is ungated on purpose, and it belongs on this adapter for the same reason
# suggest_active_projects does: it reads catalog-class metadata, returns pointers, and opens nothing.
# ADR-0002 settles the boundary -- discovery spans closed Books, reading does not -- and the
# distinction that makes it safe is that a manifest IS catalog-class material, stored under
# internal/ rather than behind the Shelf read guard, with a capture Book's page metadata excluded at
# write time rather than filtered here.
function Get-BookDiscovery([string]$Query, $MaxResults, [string]$DeskStateDirectory = $script:DeskDirectory) {
    if ($script:DiscoveryLoadError) { throw "Discovery is unavailable: $($script:DiscoveryLoadError)" }
    # NOT Split-Path -Parent $DeskStateDirectory. That was the fourth copy of the derivation
    # step 17 removes, and with seats it yields `.claude/seats` -- so Discovery looked for the
    # Shelf catalog one directory below the workspace and reported the workspace had none.
    # Found by the adapter self-test, which is the only reason it was not shipped.
    $workspace = $script:Workspace
    $cap = 50
    if ($null -ne $MaxResults) {
        $parsed = 0
        if (-not [int]::TryParse([string]$MaxResults, [ref]$parsed)) { throw 'max_results must be a whole number.' }
        $cap = $parsed
    }
    $result = Find-BookPages -Workspace $workspace -Query $Query -MaxResults $cap -DeskStateDirectory $DeskStateDirectory
    [pscustomobject]@{
        path      = 'discovery/local-shelf'
        file_path = 'internal/book-manifests'
        title     = 'Discovery over the local Shelf'
        content   = (Format-DiscoveryResult $result)
    }
}

# Full text is GATED where Discovery is not, and the gate is the Desk itself rather than a check
# here: Find-OpenBookLines reads .open-books to choose Books and reads it AGAIN after the scan, so a
# Book closed while the query ran contributes nothing. This adapter adds no boundary of its own,
# because a second one would be a second thing to keep correct.
function Get-OpenBookSearch([string]$Query, $MaxResults, [string]$DeskStateDirectory = $script:DeskDirectory) {
    if ($script:FullTextLoadError) { throw "Full-text search is unavailable: $($script:FullTextLoadError)" }
    # NOT Split-Path -Parent $DeskStateDirectory. That was the fourth copy of the derivation
    # step 17 removes, and with seats it yields `.claude/seats` -- so Discovery looked for the
    # Shelf catalog one directory below the workspace and reported the workspace had none.
    # Found by the adapter self-test, which is the only reason it was not shipped.
    $workspace = $script:Workspace
    $cap = 50
    if ($null -ne $MaxResults) {
        $parsed = 0
        if (-not [int]::TryParse([string]$MaxResults, [ref]$parsed)) { throw 'max_results must be a whole number.' }
        $cap = $parsed
    }
    $result = Find-OpenBookLines -Workspace $workspace -Query $Query -MaxResults $cap -DeskStateDirectory $DeskStateDirectory
    [pscustomobject]@{
        path      = 'search/open-books'
        file_path = 'shelf'
        title     = 'Full text over Books open on the Desk'
        content   = (Format-FullTextResult $result)
    }
}

# --- Request arguments ------------------------------------------------------------------------
# Every tool reads its arguments through these three rather than reaching into
# $request.params.arguments directly. The gap they close: the tools/list schemas declare
# `required` and `additionalProperties = $false`, and NOTHING ENFORCED EITHER. Under
# Set-StrictMode a direct read of an argument the caller did not send throws
# "The property 'slug' cannot be found on this object" -- a raw engine error surfaced to the
# reader in place of the schema's own word. Two tools had grown a hand-rolled guard; the other
# six had not, which is the drift that comes of a rule written out once per caller. This is the
# one place the rule now lives.
function Get-CallArguments($Params) {
    if ($null -eq $Params -or $null -eq $Params.PSObject.Properties['arguments']) { return $null }
    $Params.arguments
}
# Every required argument this adapter declares is a string, so "required" means present AND
# non-blank: an empty slug is not a slug, and passing one on would fail later with a message
# about the Desk rather than about the call.
function Get-RequiredArgument($Arguments, [string]$Name) {
    if ($null -eq $Arguments -or $null -eq $Arguments.PSObject.Properties[$Name]) { throw "missing required parameter '$Name'." }
    $value = $Arguments.$Name
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) { throw "parameter '$Name' must be a non-empty string." }
    [string]$value
}
function Get-OptionalArgument($Arguments, [string]$Name) {
    if ($null -eq $Arguments -or $null -eq $Arguments.PSObject.Properties[$Name]) { return $null }
    $Arguments.$Name
}

function New-McpResult($Id, [object]$Result) { ConvertTo-AsciiJson (@{ jsonrpc = '2.0'; id = $Id; result = $Result }) }
function New-McpError($Id, [string]$Message) { New-McpResult -Id $Id -Result @{ content = @(@{ type = 'text'; text = "Book read rejected: $Message" }); isError = $true } }

function New-SelfTestSandbox {
    $sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ('validated-book-reader-' + [guid]::NewGuid().ToString('N'))
    $fixture = Join-Path $sandbox '.claude'
    $shelfWiki = Join-Path $sandbox (Join-Path 'shelf' (Join-Path 'selftest-book' 'wiki'))
    New-Item -ItemType Directory -Path $fixture -Force | Out-Null
    New-Item -ItemType Directory -Path $shelfWiki -Force | Out-Null
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText((Join-Path $fixture '.library-project'), "00000000-0000-0000-0000-000000000000`n", $utf8NoBom)
    $deskDirectory = Get-DeskStateDirectory -StateDirectory $fixture -Seat 'selftest'
    New-Item -ItemType Directory -Path $deskDirectory -Force | Out-Null
    Write-AtomicText -Path (Get-DeskFileInDirectory -DeskDirectory $deskDirectory -Kind 'books') -Text "books/godot-engine-architecture-reference`nshelf/selftest-book`n" | Out-Null
    Write-AtomicText -Path (Get-DeskFileInDirectory -DeskDirectory $deskDirectory -Kind 'projects') -Text '' | Out-Null
    [IO.File]::WriteAllText((Join-Path $sandbox (Join-Path 'shelf' '_catalog.md')), "# Local Shelf`n`n## Self Test`n- **Path:** shelf/selftest-book`n", $utf8NoBom)
    [IO.File]::WriteAllText((Join-Path $shelfWiki '_book.md'), "# Self Test Book`n`nFixture metadata page.`n", $utf8NoBom)
    [IO.File]::WriteAllText((Join-Path $shelfWiki 'Master Index.md'), "# Master Index`n`nFixture page with a space in its name.`n", $utf8NoBom)
    [IO.File]::WriteAllText((Join-Path $shelfWiki 'empty.md'), '', $utf8NoBom)
    # `fixture` is the state directory (it holds the workspace pin); `desk` is the seat's Desk. They
    # were one directory before seats, and every caller that treated them as one is why this returns
    # both by name rather than leaving the second to be derived from the first.
    [pscustomobject]@{ sandbox = $sandbox; fixture = $fixture; desk = $deskDirectory }
}

# The Shelf half is local, so it verifies without the NAS being reachable.
function Invoke-ShelfSelfTest {
    $paths = New-SelfTestSandbox
    try {
        # Three bindings, because they are three different things: the sandbox is the workspace a
        # Shelf page resolves against, the fixture is the state directory holding the workspace pin,
        # and the seat's Desk is what says which Books are open.
        $script:Workspace = $paths.sandbox
        $script:StateDirectory = $paths.fixture
        $fixture = $paths.desk
        $catalog = Read-ValidatedBookCatalog -Location Shelf -DeskStateDirectory $fixture
        $valid = Read-ValidatedBookPage -Slug 'selftest-book' -Page '_book' -DeskStateDirectory $fixture
        $spaceNamedPage = Read-ValidatedBookPage -Slug 'selftest-book' -Page 'Master Index' -DeskStateDirectory $fixture
        $missingRejected = $false
        try { Read-ValidatedBookPage -Slug 'selftest-book' -Page 'not-a-real-page' -DeskStateDirectory $fixture | Out-Null } catch { $missingRejected = $_.Exception.Message -match 'not in this Book' }
        $closedRejected = $false
        try { Read-ValidatedBookPage -Slug 'library-dev' -Page '_book' -DeskStateDirectory $fixture | Out-Null } catch { $closedRejected = $_.Exception.Message -match 'closed' }
        $traversalRejected = $false
        try { Read-ValidatedBookPage -Slug 'selftest-book' -Page '../_book' -DeskStateDirectory $fixture | Out-Null } catch { $traversalRejected = $_.Exception.Message -match 'canonical' }
        # Windows would happily open '_BOOK.md'; the exact-spelling walk must not.
        $wrongCaseRejected = $false
        try { Read-ValidatedBookPage -Slug 'selftest-book' -Page '_BOOK' -DeskStateDirectory $fixture | Out-Null } catch { $wrongCaseRejected = $_.Exception.Message -match 'not in this Book' }
        $emptyRejected = $false
        try { Read-ValidatedBookPage -Slug 'selftest-book' -Page 'empty' -DeskStateDirectory $fixture | Out-Null } catch { $emptyRejected = $_.Exception.Message -match 'no readable content' }
        # The return briefing's section parsing, offline: a Hub bullet that wraps must arrive whole.
        $briefingFixture = @"
## Connected knowledge

- **A wrapped bullet** -- its first line ends here
  and its remainder continues on this line.
- A single-line bullet.

### A subheading that must not be swallowed

## Connected tools

- Only this one.
"@
        $knowledgeItems = @(Get-MarkdownSectionItems -Content $briefingFixture -Heading 'Connected knowledge')
        $toolItems = @(Get-MarkdownSectionItems -Content $briefingFixture -Heading 'Connected tools')
        $wrappedJoined = $knowledgeItems.Count -eq 2 -and $knowledgeItems[0] -clike '*and its remainder continues on this line.' -and $knowledgeItems[1] -ceq '- A single-line bullet.'
        $subheadingExcluded = -not @($knowledgeItems | Where-Object { $_ -clike '*subheading*' }).Count
        $sectionsSeparate = $toolItems.Count -eq 1 -and $toolItems[0] -ceq '- Only this one.'

        $rootPath = 'projects/selftest/_project'
        $connectionsPath = 'projects/selftest/connections'
        $sharedSections = "## Connected knowledge`n`n- Shared Book item.`n`n## Connected tools`n`n- Shared tool item.`n"
        $fallbackFixture = "# Self Test Project`n`n$sharedSections"
        $fallbackSections = Select-ReturnBriefingSections -ProjectContent $fallbackFixture -ProjectPath $rootPath -ConnectionsContent $null -ConnectionsPath $connectionsPath
        $briefingProjectFallbackSelected = $fallbackSections.sections_source -ceq $rootPath -and $fallbackSections.knowledge[0] -ceq '- Shared Book item.' -and $fallbackSections.tools[0] -ceq '- Shared tool item.'

        $rootWithoutSections = "# Self Test Project`n`n## Purpose`n`nOffline fixture.`n"
        $preferredSections = Select-ReturnBriefingSections -ProjectContent $rootWithoutSections -ProjectPath $rootPath -ConnectionsContent $sharedSections -ConnectionsPath $connectionsPath
        $briefingConnectionsPreferredSelected = $preferredSections.sections_source -ceq $connectionsPath -and $preferredSections.knowledge[0] -ceq '- Shared Book item.' -and $preferredSections.tools[0] -ceq '- Shared tool item.'

        $partialFixture = "# Self Test Project`n`n## Connected tools`n`n- Root-only tool.`n"
        $partialSections = Select-ReturnBriefingSections -ProjectContent $partialFixture -ProjectPath $rootPath -ConnectionsContent $sharedSections -ConnectionsPath $connectionsPath
        $partialContent = Format-ProjectReturnBriefing -Title 'Self Test Project' -Knowledge $partialSections.knowledge -Tools $partialSections.tools
        $briefingPartialProjectKeptLocal = $partialSections.sections_source -ceq $rootPath -and $partialSections.knowledge.Count -eq 0 -and $partialSections.tools[0] -ceq '- Root-only tool.' -and $partialContent -clike '*Related Books to consider opening: none recorded.*' -and $partialContent -cnotlike '*Shared Book item*' -and $partialContent -cnotlike '*Shared tool item*'

        $fallbackContent = Format-ProjectReturnBriefing -Title 'Self Test Project' -Knowledge $fallbackSections.knowledge -Tools $fallbackSections.tools
        $preferredContent = Format-ProjectReturnBriefing -Title 'Self Test Project' -Knowledge $preferredSections.knowledge -Tools $preferredSections.tools
        $fallbackBytes = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($fallbackContent))
        $preferredBytes = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($preferredContent))
        $briefingRenderingIdentical = $fallbackBytes -ceq $preferredBytes

        # Discovery, through this adapter rather than through its own suite: the module is reachable,
        # the answer discloses its scope, and a Book with no manifest is NAMED rather than dropped --
        # the sandbox deliberately has no manifest store, which is exactly that case. It also has no
        # shared roster, so "local Shelf only" is the correct scope sentence HERE and is asserted as
        # a disclosure of scope rather than as a claim that Discovery is Shelf-only.
        $discovery = (Get-BookDiscovery -Query 'self test' -DeskStateDirectory $fixture).content
        $discoveryScoped = $discovery -clike '*local Shelf only*'
        $discoveryDisclosesUnreadable = ($discovery -clike '*could NOT read*') -and ($discovery -clike '*selftest-book*')
        $discoveryBlankRejected = $false
        try { Get-BookDiscovery -Query '   ' -DeskStateDirectory $fixture | Out-Null } catch { $discoveryBlankRejected = $_.Exception.Message -match 'non-blank' }

        if (-not $discoveryScoped -or -not $discoveryDisclosesUnreadable -or -not $discoveryBlankRejected) { throw 'Shelf reader self-test failed: Discovery.' }

        if ($catalog.file_path -cne 'shelf/_catalog.md' -or $valid.file_path -cne 'shelf/selftest-book/wiki/_book.md' -or $spaceNamedPage.file_path -cne 'shelf/selftest-book/wiki/Master Index.md' -or -not $missingRejected -or -not $closedRejected -or -not $traversalRejected -or -not $wrongCaseRejected -or -not $emptyRejected -or -not $wrappedJoined -or -not $subheadingExcluded -or -not $sectionsSeparate -or -not $briefingProjectFallbackSelected -or -not $briefingConnectionsPreferredSelected -or -not $briefingPartialProjectKeptLocal -or -not $briefingRenderingIdentical) { throw 'Shelf reader self-test failed.' }
        [pscustomobject]@{ status = 'passed'; scope = 'shelf'; exact_catalog = $catalog.file_path; exact_page = $valid.file_path; exact_space_named_page = $spaceNamedPage.file_path; missing_path_rejected = $missingRejected; closed_book_rejected = $closedRejected; traversal_rejected = $traversalRejected; wrong_case_rejected = $wrongCaseRejected; empty_page_rejected = $emptyRejected; briefing_wrapped_bullet_joined = $wrappedJoined; briefing_subheading_excluded = $subheadingExcluded; briefing_sections_separate = $sectionsSeparate; briefing_project_fallback_selected = $briefingProjectFallbackSelected; briefing_connections_preferred_selected = $briefingConnectionsPreferredSelected; briefing_partial_project_kept_local = $briefingPartialProjectKeptLocal; briefing_rendering_identical = $briefingRenderingIdentical; discovery_scope_disclosed = $discoveryScoped; discovery_unreadable_book_named = $discoveryDisclosesUnreadable; discovery_blank_query_rejected = $discoveryBlankRejected; shared_library_write = $false }
    }
    finally {
        if (Test-Path -LiteralPath $paths.sandbox) { Remove-Item -LiteralPath $paths.sandbox -Recurse -Force }
    }
}

function Invoke-SelfTest {
    $paths = New-SelfTestSandbox
    $script:Workspace = $paths.sandbox
    $script:StateDirectory = $paths.fixture
    $fixture = $paths.desk
    try {
        $script:RemoteSessionId = $null
        $catalog = Read-ValidatedBookCatalog -Location Shared -DeskStateDirectory $fixture
        $valid = Read-ValidatedBookPage -Slug 'godot-engine-architecture-reference' -Page '_book' -DeskStateDirectory $fixture
        $spaceNamedPage = Read-ValidatedBookPage -Slug 'godot-engine-architecture-reference' -Page 'Master Index' -DeskStateDirectory $fixture
        $missingRejected = $false; $missingMessage = ''
        try { Read-ValidatedBookPage -Slug 'godot-engine-architecture-reference' -Page 'not-a-real-page' -DeskStateDirectory $fixture | Out-Null } catch { $missingRejected = $_.Exception.Message -match 'different record|rejected|no complete|not in this Book' ; $missingMessage = $_.Exception.Message }
        $closedRejected = $false
        try { Read-ValidatedBookPage -Slug 'lm-studio-bionic-operations' -Page '_book' -DeskStateDirectory $fixture | Out-Null } catch { $closedRejected = $_.Exception.Message -match 'closed' }
        $traversalRejected = $false
        try { Read-ValidatedBookPage -Slug 'godot-engine-architecture-reference' -Page '../_book' -DeskStateDirectory $fixture | Out-Null } catch { $traversalRejected = $_.Exception.Message -match 'canonical' }
        # The shared ARCHIVE listing. It runs here rather than in the Shelf half because it is a NAS
        # read, and it asserts the exact record path for the same reason the Book Catalog does: the
        # archive listing goes through the same return validation, so asking for archive/README and
        # being handed books/README must withhold the content rather than answer with it.
        $archiveCatalog = Read-ValidatedBookCatalog -Location Archive -DeskStateDirectory $fixture
        $archiveNamesBothArchives = $archiveCatalog.content -clike '*Archive-ShelfBook.ps1 -Action List*'
        if ($archiveCatalog.file_path -cne 'archive/README.md' -or -not $archiveNamesBothArchives) { throw 'Return-validating adapter self-test failed: the shared archive listing.' }
        if ($catalog.file_path -cne 'books/README.md' -or $valid.file_path -cne 'books/godot-engine-architecture-reference/wiki/_book.md' -or $spaceNamedPage.file_path -cne 'books/godot-engine-architecture-reference/wiki/Master Index.md' -or -not $missingRejected -or -not $closedRejected -or -not $traversalRejected) { throw 'Return-validating adapter self-test failed.' }
        [pscustomobject]@{ status = 'passed'; scope = 'shared'; exact_catalog = $catalog.file_path; exact_archive_catalog = $archiveCatalog.file_path; archive_listing_names_both_archives = $archiveNamesBothArchives; exact_page = $valid.file_path; exact_space_named_page = $spaceNamedPage.file_path; missing_path_rejected = $missingRejected; closed_book_rejected = $closedRejected; traversal_rejected = $traversalRejected; shared_library_write = $false }
    }
    finally {
        if (Test-Path -LiteralPath $paths.sandbox) { Remove-Item -LiteralPath $paths.sandbox -Recurse -Force }
    }
}

# The argument guards live in the JSON-RPC dispatch loop, which the two self-tests above cannot
# reach: they call the reader functions directly, with arguments PowerShell has already bound. A
# malformed CALL is a wire-level event, so this drives the adapter as a real process over stdio --
# the same channel the client uses, and the same shape McpToolInventory.ps1 already uses to ask it
# for tools/list. Every case here must fail at the guard BEFORE any Desk or network read, which is
# what keeps this an offline check.
#
# WHAT THIS DOES NOT COVER, deliberately. The schemas also declare additionalProperties = $false,
# and nothing enforces that either. Rejecting an unknown argument would be a behaviour change for
# every existing caller rather than a fix, and the recorded gap was about `required`. An unknown
# argument is still ignored; only the absence of a required one is now the schema's own word.
function Invoke-DispatchSelfTest {
    $cases = @(
        @{ name = 'missing_slug_named';          request = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_open_book_page","arguments":{"page":"_book"}}}';                    expect = "missing required parameter 'slug'." }
        @{ name = 'missing_page_named';          request = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_open_project_page","arguments":{"slug":"library-dev"}}}';           expect = "missing required parameter 'page'." }
        @{ name = 'briefing_empty_arguments';    request = '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_open_project_briefing","arguments":{}}}';                            expect = "missing required parameter 'slug'." }
        @{ name = 'wrong_argument_name';         request = '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"suggest_active_projects","arguments":{"q":"godot"}}}';                    expect = "missing required parameter 'query'." }
        @{ name = 'blank_slug_rejected';         request = '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read_open_book_page","arguments":{"slug":"","page":"_book"}}}';           expect = "parameter 'slug' must be a non-empty string." }
        @{ name = 'no_arguments_object';         request = '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"read_open_book_page"}}';                                                  expect = "missing required parameter 'slug'." }
        @{ name = 'no_params_object';            request = '{"jsonrpc":"2.0","id":7,"method":"tools/call"}';                                                                                         expect = 'This adapter exposes only validated' }
        @{ name = 'search_guard_preserved';      request = '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"search_open_books","arguments":{}}}';                                     expect = "missing required parameter 'query'." }
        @{ name = 'discovery_blank_query';       request = '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"discover_book_pages","arguments":{"query":"   "}}}';                      expect = "parameter 'query' must be a non-empty string." }
    )
    # The regression half: an OPTIONAL argument must still be read, and its absence must still mean
    # the default rather than a refusal. Shelf-scoped so it stays local.
    $optionalCase = @{ name = 'optional_argument_still_read'; request = '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"read_book_catalog","arguments":{"location":"shelf"}}}' }

    # The notification regression. A JSON-RPC notification carries no id, and an UNKNOWN one reaches
    # the dispatch's default arm -- whose own `if ($null -ne $request.id)` guard was the read that
    # threw under Set-StrictMode. That did not skip one message: it took the whole loop down, so the
    # adapter answered everything before it and nothing after. Probed 2026-09-03 with
    # notifications/cancelled, which is what a client sends on interrupt. Injected BEFORE the last
    # case so a recurrence shows up as that case going unanswered rather than as a silent pass.
    $notificationLine = '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}'

    $stem = Join-Path ([IO.Path]::GetTempPath()) ('validated-book-reader-dispatch-' + [guid]::NewGuid().ToString('N'))
    $requestPath = "$stem.jsonl"; $outPath = "$stem.out"; $errPath = "$stem.err"
    $lines = @(@($cases | ForEach-Object { $_.request }) + @($notificationLine) + @($optionalCase.request)) -join "`n"
    [IO.File]::WriteAllText($requestPath, $lines + "`n", [Text.UTF8Encoding]::new($false))

    try {
        # Spawned WITHOUT -DispatchSelfTest: the child is an ordinary server run reading stdin, which
        # is the point, and is also what stops this recursing.
        $process = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath) `
            -WorkingDirectory (Split-Path -Parent $PSScriptRoot) `
            -RedirectStandardInput $requestPath -RedirectStandardOutput $outPath -RedirectStandardError $errPath `
            -NoNewWindow -PassThru
        if (-not $process.WaitForExit(60000)) {
            try { $process.Kill() } catch { }
            throw 'Dispatch self-test failed: the adapter did not answer within 60s.'
        }

        $responses = @{}
        foreach ($line in @([IO.File]::ReadAllText($outPath) -split "`r?`n")) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $message = $null
            try { $message = $line | ConvertFrom-Json } catch { continue }
            if ($null -eq $message.PSObject.Properties['id'] -or $null -eq $message.PSObject.Properties['result']) { continue }
            $responses[[string]$message.id] = $message.result
        }

        $results = [ordered]@{}
        $failures = [Collections.Generic.List[string]]::new()
        for ($i = 0; $i -lt $cases.Count; $i++) {
            $case = $cases[$i]
            $id = [string]($i + 1)
            if (-not $responses.ContainsKey($id)) { $failures.Add("$($case.name): no response"); $results[$case.name] = $false; continue }
            $result = $responses[$id]
            $text = if ($null -ne $result.PSObject.Properties['content']) { [string](@($result.content)[0].text) } else { '' }
            # isError AND the schema's own word: a raw Set-StrictMode message is also an error, and
            # accepting it would have passed this suite while the gap stayed open.
            $isError = $null -ne $result.PSObject.Properties['isError'] -and [bool]$result.isError
            $ok = $isError -and $text.Contains($case.expect) -and -not $text.Contains('cannot be found on this object')
            $results[$case.name] = $ok
            if (-not $ok) { $failures.Add("$($case.name): expected '$($case.expect)', got '$text'") }
        }

        $optionalOk = $false
        if ($responses.ContainsKey('10')) {
            $optionalResult = $responses['10']
            $optionalError = $null -ne $optionalResult.PSObject.Properties['isError'] -and [bool]$optionalResult.isError
            $optionalOk = -not $optionalError
            if (-not $optionalOk) { $failures.Add("$($optionalCase.name): the Shelf catalog read was refused: $([string](@($optionalResult.content)[0].text))") }
        }
        else { $failures.Add("$($optionalCase.name): no response") }
        $results[$optionalCase.name] = $optionalOk

        # Two independent tells, because either alone can lie. stdout stopping is what a dead loop
        # looks like from the client's side; stderr is where the crash itself lands. A run that
        # answered id 10 but wrote to stderr is still a regression -- this file was never read
        # before, so a child that complained on the way through went unnoticed.
        $childErr = if (Test-Path -LiteralPath $errPath -PathType Leaf) { [IO.File]::ReadAllText($errPath) } else { '' }
        $notificationOk = $responses.ContainsKey('10') -and [string]::IsNullOrWhiteSpace($childErr)
        if (-not $notificationOk) {
            $detail = if ([string]::IsNullOrWhiteSpace($childErr)) { 'the request after it went unanswered' } else { ($childErr.Trim() -replace '\s+', ' ') }
            $failures.Add("unknown_notification_survived: an id-less notification broke the dispatch loop: $detail")
        }
        $results['unknown_notification_survived'] = $notificationOk

        if ($failures.Count) { throw "Dispatch self-test failed: $(($failures -join '; '))" }
        [pscustomobject]([ordered]@{ status = 'passed'; scope = 'dispatch'; checks = $cases.Count + 2 } + $results + [ordered]@{ additional_properties_enforced = $false; shared_library_write = $false })
    }
    finally {
        foreach ($path in @($requestPath, $outPath, $errPath)) {
            if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
        }
    }
}

# THE TWO PROJECT READS THAT RESOLVE THE PIN THEMSELVES, EXERCISED OFFLINE AGAINST A SHADOWED
# TRANSPORT.
#
# WHY A MOCK AND NOT A FIXTURE. Both functions are network-dependent, and that is exactly how the
# seat migration's call-site defect shipped green: New-SelfTestSandbox already models the
# workspace/seat split correctly, so the fixture was never the gap -- nothing EXECUTED the two call
# sites. The dispatch suite's one suggest_active_projects case fails at the argument guard before any
# pin is resolved, so it passed throughout. PowerShell resolves a command through the CALLER's scope
# chain, so the three definitions below are what Read-ValidatedProjectCatalog reaches when this
# function calls it, and they are discarded when this function returns rather than needing a restore.
# Invoke-RemoteMcpOnce is shadowed with a throw as a leak canary: the primitive is what would reach
# the NAS if a reader function ever bypassed the retrying wrapper.
#
# THE SEAT'S DESK CARRIES A DECOY PIN, which no real seat does. Absence alone would make a wrong call
# site throw 'missing .library-project' -- true today, but that names a missing file rather than the
# fault, and it stops being a signal the day anything writes a pin beside a Desk. With a decoy, a
# call site that reads the wrong directory RESOLVES and sends the wrong id, so every assertion here
# is on the id that actually reached the transport.
function Invoke-ProjectResolutionSelfTest {
    $paths = New-SelfTestSandbox
    try {
        $script:Workspace = $paths.sandbox
        $script:StateDirectory = $paths.fixture
        $desk = $paths.desk
        # Read the pin out of the fixture rather than restating it here: a second copy is how this
        # suite would come to pass by agreeing with itself after New-SelfTestSandbox changed.
        $workspacePin = [IO.File]::ReadAllText((Join-Path $paths.fixture '.library-project')).Trim()
        $decoyPin = 'deadbeef-dead-4bad-8bad-deadbeefdead'
        [IO.File]::WriteAllText((Join-Path $desk '.library-project'), "$decoyPin`n", [Text.UTF8Encoding]::new($false))

        $sent = [Collections.Generic.List[object]]::new()
        $catalogBody = "# Active Projects`n`n- [[projects/selftest/_project|Self Test Project]]`n"
        $rootBody = "# Self Test Project`n`n## Purpose`n`nAn offline fixture Hub for this self test.`n"
        function Initialize-RemoteMcp { }
        function Invoke-RemoteMcpOnce([string]$Method, [hashtable]$Params, [switch]$Notification) { throw 'The Project pin self-test reached the network primitive.' }
        function Invoke-RemoteMcp([string]$Method, [hashtable]$Params, [switch]$Notification) {
            $identifier = [string]$Params.arguments.identifier
            [void]$sent.Add([pscustomobject]@{ identifier = $identifier; project_id = [string]$Params.arguments.project_id })
            $body = if ($identifier -ceq 'projects/README') { $catalogBody } else { $rootBody }
            [pscustomobject]@{ result = [pscustomobject]@{ isError = $false; content = @(); structuredContent = [pscustomobject]@{ result = [pscustomobject]@{ file_path = "$identifier.md"; title = 'Self Test Project'; content = $body } } } }
        }

        # All three paths. The two direct readers each hold their own resolution, and
        # suggest_active_projects is the reader-facing flow CLAUDE.md names, which goes through both.
        $catalog = $null; $catalogError = ''
        try { $catalog = Read-ValidatedProjectCatalog -Shelf Active -DeskStateDirectory $desk } catch { $catalogError = $_.Exception.Message }
        $root = $null; $rootError = ''
        try { $root = Read-ValidatedActiveProjectRoot -Slug 'selftest' -DeskStateDirectory $desk } catch { $rootError = $_.Exception.Message }
        $suggestions = $null; $suggestionsError = ''
        try { $suggestions = Get-ProjectSuggestions -Query 'self test' -DeskStateDirectory $desk } catch { $suggestionsError = $_.Exception.Message }

        $catalogRead = $null -ne $catalog -and $catalog.file_path -ceq 'projects/README.md' -and $catalog.content -ceq $catalogBody
        $rootRead = $null -ne $root -and $root.file_path -ceq 'projects/selftest/_project.md'
        $suggested = $null -ne $suggestions -and @($suggestions.suggestions | Where-Object { $_.slug -ceq 'selftest' }).Count -eq 1

        # THE ASSERTION THIS SUITE EXISTS FOR: every id that reached the transport is the WORKSPACE
        # pin, and the decoy sitting in the seat's Desk was never sent.
        $identifiers = @($sent | ForEach-Object { $_.identifier } | Sort-Object -Unique)
        $pins = @($sent | ForEach-Object { $_.project_id } | Sort-Object -Unique)
        $foreign = @($sent | Where-Object { $_.project_id -cne $workspacePin } | ForEach-Object { "$($_.identifier) sent $($_.project_id)" } | Sort-Object -Unique)
        $bothReadsReached = (@($identifiers) -ccontains 'projects/README') -and (@($identifiers) -ccontains 'projects/selftest/_project')
        $allFromWorkspace = $foreign.Count -eq 0 -and $pins.Count -eq 1 -and $pins[0] -ceq $workspacePin

        # AND THE SEAT GATE STILL STANDS, which is the half a fix to the directory could have broken
        # silently: the workspace pin always exists, so the Desk is the only thing between a seatless
        # session and a shared Project read. Cleared rather than assumed -- this process inherits
        # LIBRARY_SEAT from whoever ran the gate, so the `unset` resolution has to be produced here,
        # and the expected wording comes from Resolve-SeatName rather than a copy of its sentence.
        $savedSeatEnvironment = $env:LIBRARY_SEAT
        $savedSeatResolution = $script:SeatResolution
        $callsBeforeSeatless = $sent.Count
        $seatlessRefused = $false
        $seatlessMessage = ''
        try {
            $env:LIBRARY_SEAT = ''
            $script:SeatResolution = Resolve-SeatName -Seat '' -StateDirectory $script:StateDirectory
            $expectedRefusal = [string]$script:SeatResolution.message
            $catalogRefusal = ''
            try { Read-ValidatedProjectCatalog -Shelf Active -DeskStateDirectory '' | Out-Null } catch { $catalogRefusal = $_.Exception.Message }
            $rootRefusal = ''
            try { Read-ValidatedActiveProjectRoot -Slug 'selftest' -DeskStateDirectory '' | Out-Null } catch { $rootRefusal = $_.Exception.Message }
            $seatlessMessage = $catalogRefusal
            $seatlessRefused = $expectedRefusal.Length -gt 0 -and $catalogRefusal -ceq $expectedRefusal -and $rootRefusal -ceq $expectedRefusal
        }
        finally {
            $env:LIBRARY_SEAT = $savedSeatEnvironment
            $script:SeatResolution = $savedSeatResolution
        }
        $seatlessTransportUntouched = $sent.Count -eq $callsBeforeSeatless

        if (-not $catalogRead -or -not $rootRead -or -not $suggested -or -not $bothReadsReached -or -not $allFromWorkspace -or -not $seatlessRefused -or -not $seatlessTransportUntouched) {
            $detail = @()
            if ($foreign.Count) { $detail += "resolved the pin from the wrong directory -- $($foreign -join '; ')" }
            if ($catalogError) { $detail += "read_project_catalog refused: $catalogError" }
            if ($rootError) { $detail += "the active Project root refused: $rootError" }
            if ($suggestionsError) { $detail += "suggest_active_projects refused: $suggestionsError" }
            if (-not $bothReadsReached) { $detail += "reads that reached the transport: $(if ($identifiers.Count) { $identifiers -join ', ' } else { 'none' })" }
            if (-not $catalogRead -and -not $catalogError) { $detail += 'the Project Catalog body did not come back exact' }
            if (-not $suggested -and -not $suggestionsError) { $detail += 'suggest_active_projects returned no suggestion for the fixture Hub' }
            if (-not $seatlessRefused) { $detail += "a seatless Desk was not refused with the seat message (got '$seatlessMessage')" }
            if (-not $seatlessTransportUntouched) { $detail += 'a seatless Desk reached the transport' }
            throw ("Project pin self-test failed (workspace pin $workspacePin; decoy pin in the seat's Desk $decoyPin): " + ($detail -join ' | '))
        }
        [pscustomobject]@{ status = 'passed'; scope = 'project-pin'; workspace_pin = $workspacePin; decoy_pin_in_seat_desk = $decoyPin; ids_sent = $pins; reads_reaching_transport = $identifiers; exact_catalog = $catalog.file_path; exact_project_root = $root.file_path; suggestion_returned = $suggested; decoy_never_sent = ($foreign.Count -eq 0); seatless_desk_refused = $seatlessRefused; seatless_reached_no_transport = $seatlessTransportUntouched; shared_library_write = $false }
    }
    finally {
        if (Test-Path -LiteralPath $paths.sandbox) { Remove-Item -LiteralPath $paths.sandbox -Recurse -Force }
    }
}

if ($DispatchSelfTest) { Invoke-DispatchSelfTest; exit 0 }
if ($ShelfSelfTest) { Invoke-ShelfSelfTest; exit 0 }
if ($ProjectSelfTest) { Invoke-ProjectResolutionSelfTest; exit 0 }
if ($SelfTest) { Invoke-ShelfSelfTest; Invoke-SelfTest; exit 0 }
if ($ProjectBriefing) {
    if ([string]::IsNullOrWhiteSpace($ProjectSlug)) { throw 'ProjectSlug is required for a Project return briefing.' }
    Get-ProjectReturnBriefing -Slug $ProjectSlug
    exit 0
}

# --- Launch-time settings validation ---------------------------------------------------------------
# This adapter is started by .mcp.json, not by settings.json, so it still loads when the settings
# file is broken. That makes it the one process positioned to notice. A malformed settings file has
# already disabled the permission allowlist and both guard hooks once, silently.
#
# This was once detection without prevention: .mcp.json registered Basic Memory directly alongside
# this adapter, so a settings file that failed to load took the permission allowlist and both guard
# hooks with it while unguarded Basic Memory tools kept serving. That hole is closed. .mcp.json now
# registers this adapter ALONE, so a Claude session has no direct Basic Memory tools to reach even
# when settings are broken -- fail-closed rather than merely loud. Nothing was given up for it: Hub
# edits are prescribed through tools/Edit-ProjectHub.ps1, which journals the prior body and verifies
# its readback, browsing goes through read_book_catalog / read_project_catalog, and every shared-write
# helper carries its own HTTP client, so none of them route through a registration at all.
# Codex still registers both servers in .codex/config.toml, deliberately: the trusted interactive
# Codex Librarian maintains an open active Hub through the guarded direct write surface, and
# codex.project-access-config holds that registration in place. Guard-BasicMemoryRead stays
# registered on both sides -- inert for Claude now, and the defence that returns the moment anyone
# re-registers the server. Warnings go to stderr only; stdout carries JSON-RPC and any stray byte
# there breaks the protocol.
# Hook scripts are registered at hooks.<Event>[].hooks[].{command,args}. Searching the raw file text
# for the name instead would also match it in a permission entry, a comment, or a block that has been
# commented out -- reporting a guard as registered when nothing runs it. 0.5 asks for the *effective*
# settings, so this walks the parsed object.
function Get-RegisteredHookScript($Settings) {
    $names = [Collections.Generic.List[string]]::new()
    if ($null -eq $Settings -or -not $Settings.PSObject.Properties['hooks']) { return $names }
    foreach ($eventProperty in $Settings.hooks.PSObject.Properties) {
        foreach ($matcher in @($eventProperty.Value)) {
            if ($null -eq $matcher -or -not $matcher.PSObject.Properties['hooks']) { continue }
            foreach ($hook in @($matcher.hooks)) {
                if ($null -eq $hook) { continue }
                foreach ($field in @('command', 'args')) {
                    if (-not $hook.PSObject.Properties[$field]) { continue }
                    foreach ($value in @($hook.$field)) {
                        foreach ($m in [regex]::Matches([string]$value, '[^\\/]+\.ps1')) { [void]$names.Add($m.Value) }
                    }
                }
            }
        }
    }
    $names
}

# $Directory is the .claude state directory itself -- the same one that holds .open-books -- not the
# workspace root. Joining '.claude' onto it again pointed every probe at .claude/.claude, so this
# reported "no settings file found" on every launch and the hook check below, gated on there being no
# prior fault, never ran at all.
function Test-LaunchSettings([string]$Directory) {
    $faults = [Collections.Generic.List[string]]::new()
    $required = @('Guard-BasicMemoryRead.ps1', 'Guard-ShelfBookRead.ps1')
    try {
        $files = @(@('settings.json', 'settings.local.json') |
            ForEach-Object { Join-Path $Directory $_ } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })

        if (-not $files.Count) {
            [void]$faults.Add('no .claude/settings.json or settings.local.json found')
            return $faults
        }

        $parsed = @{}
        foreach ($file in $files) {
            $leaf = Split-Path -Leaf $file
            try { $parsed[$leaf] = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json }
            catch { [void]$faults.Add("$leaf is not valid JSON: $($_.Exception.Message)") }
        }
        if ($faults.Count) { return $faults }

        $registered = @{}
        foreach ($leaf in @($parsed.Keys)) { $registered[$leaf] = @(Get-RegisteredHookScript $parsed[$leaf]) }
        $effective = @($registered.Values | ForEach-Object { $_ })

        foreach ($hook in $required) {
            if ($hook -notin $effective) { [void]$faults.Add("guard hook not registered: $hook") }
        }

        # A settings.local.json carrying its own hooks block is the shadowing case 0.5 names: it is
        # untracked, so nothing in version control shows what it changed.
        if ($parsed.ContainsKey('settings.local.json') -and $parsed['settings.local.json'].PSObject.Properties['hooks']) {
            $shadowed = @($required | Where-Object { $_ -notin $registered['settings.local.json'] })
            if ($shadowed.Count) {
                [void]$faults.Add("settings.local.json declares its own hooks block and does not register: $($shadowed -join ', ')")
            }
        }
    }
    catch {
        [void]$faults.Add("settings could not be checked: $($_.Exception.Message)")
    }
    $faults
}

# The validation is the thing most likely to rot silently, because a broken one looks exactly like a
# healthy workspace: no banner. These fixtures assert it still speaks up.
function Invoke-LaunchValidationSelfTest {
    $sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ('launch-validation-' + [guid]::NewGuid().ToString('N'))
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $guardHooks = @'
{"hooks":{"PreToolUse":[
  {"matcher":"mcp__basic-memory__.*","hooks":[{"type":"command","command":"powershell.exe","args":["-File","${CLAUDE_PROJECT_DIR}/.claude/hooks/Guard-BasicMemoryRead.ps1"]}]},
  {"matcher":"Read|Grep|Glob","hooks":[{"type":"command","command":"powershell.exe","args":["-File","${CLAUDE_PROJECT_DIR}/.claude/hooks/Guard-ShelfBookRead.ps1"]}]}
]}}
'@
    try {
        $cases = [Collections.Generic.List[object]]::new()
        $case = {
            param([string]$Name, [hashtable]$Files, [scriptblock]$Assert)
            $dir = Join-Path $sandbox ([guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            foreach ($fileName in $Files.Keys) { [IO.File]::WriteAllText((Join-Path $dir $fileName), $Files[$fileName], $utf8NoBom) }
            $faults = @(Test-LaunchSettings -Directory $dir)
            if (-not (& $Assert $faults)) { throw "launch validation self-test case failed: $Name (faults: $($faults -join '; '))" }
            [void]$cases.Add($Name)
        }

        # The real workspace shape: a tracked settings.json registering both guards, and nothing else.
        & $case 'healthy settings.json is silent' @{ 'settings.json' = $guardHooks } { param($f) $f.Count -eq 0 }

        & $case 'missing settings file faults' @{} { param($f) $f.Count -eq 1 -and $f[0] -match 'no \.claude/settings\.json' }

        & $case 'malformed JSON faults' @{ 'settings.json' = '{"hooks":{},,}' } { param($f) ($f -join ' ') -match 'not valid JSON' }

        & $case 'missing guard hook faults' @{ 'settings.json' = '{"hooks":{"PreToolUse":[{"matcher":"Read","hooks":[{"type":"command","command":"powershell.exe","args":["-File","x/Guard-ShelfBookRead.ps1"]}]}]}}' } {
            param($f) ($f -join ' ') -match 'guard hook not registered: Guard-BasicMemoryRead\.ps1'
        }

        # The case a raw substring search gets wrong: both names appear in the file, but only as
        # permission strings, so no hook actually runs.
        & $case 'hook named only in permissions still faults' @{ 'settings.json' = '{"permissions":{"allow":["Bash(Guard-BasicMemoryRead.ps1)","Bash(Guard-ShelfBookRead.ps1)"]}}' } {
            param($f) $f.Count -eq 2 -and ($f -join ' ') -match 'guard hook not registered'
        }

        # An untracked local file re-declaring hooks is the shadowing case 0.5 requires be caught.
        & $case 'settings.local.json hooks block flagged as shadowing' @{ 'settings.json' = $guardHooks; 'settings.local.json' = '{"hooks":{"PreToolUse":[{"matcher":"Read","hooks":[{"type":"command","command":"powershell.exe","args":["-File","x/Something-Else.ps1"]}]}]}}' } {
            param($f) ($f -join ' ') -match 'settings\.local\.json declares its own hooks block'
        }

        # A local file with no hooks block of its own is a legitimate machine-local override.
        & $case 'settings.local.json without hooks is accepted' @{ 'settings.json' = $guardHooks; 'settings.local.json' = '{"permissions":{"allow":[]}}' } { param($f) $f.Count -eq 0 }

        [pscustomobject]@{ status = 'passed'; scope = 'launch-validation'; cases = $cases.Count; case_names = @($cases) }
    }
    finally {
        if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
    }
}

if ($LaunchSelfTest) { Invoke-LaunchValidationSelfTest; exit 0 }

$script:LaunchFaults = @(Test-LaunchSettings -Directory $StateDirectory)
if ($script:LaunchFaults.Count) {
    [Console]::Error.WriteLine('')
    [Console]::Error.WriteLine('!!! LIBRARY GUARD WARNING ' + ('!' * 52))
    foreach ($fault in $script:LaunchFaults) { [Console]::Error.WriteLine("  - $fault") }
    [Console]::Error.WriteLine('  The Virtual Desk guards may not be active. Closed Books and the Basic Memory')
    [Console]::Error.WriteLine('  boundary are NOT being enforced. Repair the settings file and restart.')
    [Console]::Error.WriteLine(('!' * 78))
    [Console]::Error.WriteLine('')
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
    # Reset per iteration and BEFORE the try, so the catch below always has a defined value to
    # answer with -- including when ConvertFrom-Json is what threw and $request was never assigned.
    $inboundId = $null
    try {
        $request = $line | ConvertFrom-Json
        # A JSON-RPC notification carries no id at all, and reading $request.id on one throws under
        # Set-StrictMode -- which killed this loop outright rather than skipping one message.
        # Probed 2026-09-03: notifications/cancelled, which a client sends on interrupt, falls to
        # the default branch below, and the guard there was itself the read that threw. The adapter
        # answered initialize and then died before tools/list. Resolve the id ONCE, defensively, and
        # let every arm below treat $null as "this message wants no response".
        # Enumerated rather than read as the aggregate .Name, which throws on a property-less frame
        # -- defect family 4 in .claude/rules/library-development.md.
        if (@($request.PSObject.Properties | ForEach-Object { $_.Name }) -contains 'id') { $inboundId = $request.id }
        switch ([string]$request.method) {
            'initialize' { New-McpResult -Id $inboundId -Result @{ protocolVersion = '2025-03-26'; capabilities = @{ tools = @{ listChanged = $false } }; serverInfo = @{ name = 'AI Library Validated Book Reader'; version = '0.1.0' } } }
            'notifications/initialized' { }
            'tools/list' { New-McpResult -Id $inboundId -Result @{ tools = @(
                @{ name = 'read_book_catalog'; description = 'Read the AI Library Book Catalog: the shared collection, the local Shelf, both, or the shared ARCHIVE. The adapter returns shared content only when the response is the exact canonical catalog record. discover_book_pages covers archived Books and labels every archived hit ARCHIVED, so this listing is the archive''s own index rather than the only way to find one; each Discovery answer states which archives it searched.'; inputSchema = @{ type = 'object'; additionalProperties = $false; properties = @{ location = @{ type = 'string'; enum = @('shared', 'shelf', 'all', 'archive'); description = 'Which collection to list. Defaults to all. Use archive to list Books retired from the shared collection.' } } } },
                @{ name = 'read_open_book_page'; description = 'Read one exact page from an open AI Library Book, shared or Shelf. The adapter rejects closed Books and any page whose canonical file path differs from the requested path.'; inputSchema = @{ type = 'object'; additionalProperties = $false; required = @('slug', 'page'); properties = @{ slug = @{ type = 'string'; description = 'Open Book slug.' }; page = @{ type = 'string'; description = 'Canonical page path below wiki/, without .md.' } } } },
                @{ name = 'read_project_catalog'; description = 'Read the exact active or archived AI Library Project Catalog.'; inputSchema = @{ type = 'object'; additionalProperties = $false; properties = @{ shelf = @{ type = 'string'; enum = @('active', 'archive'); description = 'Project shelf. Defaults to active.' } } } },
                @{ name = 'suggest_active_projects'; description = 'Search concise summaries of active AI Library Project Hubs using reader-provided words. Returns up to five ranked suggestions and never opens or changes a Project.'; inputSchema = @{ type = 'object'; additionalProperties = $false; required = @('query'); properties = @{ query = @{ type = 'string'; description = 'Words describing the work or Project to find.' } } } },
                @{ name = 'read_open_project_page'; description = 'Read one exact page from an open active or archived AI Library Project Hub.'; inputSchema = @{ type = 'object'; additionalProperties = $false; required = @('slug', 'page'); properties = @{ slug = @{ type = 'string'; description = 'Open Project slug.' }; page = @{ type = 'string'; description = 'Canonical Project page path below the Project root, without .md. For example _project or research/Finding.' } } } },
                @{ name = 'read_open_project_briefing'; description = "Give a short return briefing using an open Project Hub's explicit Connected knowledge and Connected tools sections, whether recorded on the Hub root or its companion connections page. It does not search, infer missing dependencies, or open Books."; inputSchema = @{ type = 'object'; additionalProperties = $false; required = @('slug'); properties = @{ slug = @{ type = 'string'; description = 'Open Project slug.' } } } },
                @{ name = 'search_open_books'; description = 'Search the FULL TEXT of Shelf Books that are OPEN on the Desk, returning matching lines with the exact page path and line number that feed read_open_book_page. Closed Books are never searched -- use discover_book_pages for those. An open SHARED Book is named in the answer as out of scope rather than searched, because its pages arrive one network read at a time. Every answer reports what it could not read, what it skipped, and any cap that bound it. A matched line says the term occurs on that page; it is not a reading of the page.'; inputSchema = @{ type = 'object'; additionalProperties = $false; required = @('query'); properties = @{ query = @{ type = 'string'; description = 'A literal term to look for in page text. Matching is literal, case-insensitive, and Unicode-normalised; regular expressions are not interpreted.' }; max_results = @{ type = 'integer'; description = 'Maximum matching lines to return. Defaults to 50; the answer reports the total when it truncates.' } } } },
                @{ name = 'discover_book_pages'; description = 'Find which Books and pages mention a term, across the local Shelf and the shared collection, from closed-readable metadata manifests only. Covers closed Books, opens nothing, reaches no network, and returns Book slug, canonical page path, the heading that matched, and the Book overlap status -- never page text. A hit licenses "shall I open it?", never an answer about what the page says. Every answer states its own coverage: which Books were searched, and any it could not read.'; inputSchema = @{ type = 'object'; additionalProperties = $false; required = @('query'); properties = @{ query = @{ type = 'string'; description = 'A literal term to look for in Book titles, summaries, topics, reader-map links, page titles, and headings. Matching is literal and case-insensitive; regular expressions are not interpreted.' }; max_results = @{ type = 'integer'; description = 'Maximum hits to return. Defaults to 50; the answer reports the total when it truncates.' } } } }
            ) } }
            'tools/call' {
                try {
                    # THE SEAT IS RESOLVED HERE, ONCE PER REQUEST, BEFORE ANY TOOL RUNS (step 11).
                    # Not at load: a binding written after this process started is the ordinary case
                    # on the one-click route, and a cached resolution made it invisible for the
                    # adapter's whole lifetime. Inside the try, so any surprise becomes one tool
                    # error rather than a dead loop; Resolve-SeatName itself never throws.
                    Update-AdapterSeatResolution | Out-Null
                    # params itself is read through the same guard: a tools/call carrying none at all
                    # would otherwise throw a strict-mode error out of the switch condition, before any
                    # tool name existed to blame it on.
                    $callParams = if ($null -ne $request.PSObject.Properties['params']) { $request.params } else { $null }
                    $callName = if ($null -ne $callParams -and $null -ne $callParams.PSObject.Properties['name']) { [string]$callParams.name } else { '' }
                    $callArguments = Get-CallArguments $callParams
                    switch ($callName) {
                        'read_book_catalog' {
                            $requestedLocation = Get-OptionalArgument $callArguments 'location'
                            $location = switch ([string]$requestedLocation) {
                                'shared'  { 'Shared' }
                                'shelf'   { 'Shelf' }
                                'archive' { 'Archive' }
                                default   { 'All' }
                            }
                            $page = Read-ValidatedBookCatalog -Location $location
                        }
                        'read_open_book_page' { $page = Read-ValidatedBookPage -Slug (Get-RequiredArgument $callArguments 'slug') -Page (Get-RequiredArgument $callArguments 'page') }
                        'read_project_catalog' {
                            $requestedShelf = Get-OptionalArgument $callArguments 'shelf'
                            $shelf = if ($null -ne $requestedShelf -and [string]$requestedShelf -eq 'archive') { 'Archive' } else { 'Active' }
                            $page = Read-ValidatedProjectCatalog -Shelf $shelf
                        }
                        'suggest_active_projects' { $page = Get-ProjectSuggestions -Query (Get-RequiredArgument $callArguments 'query') }
                        'read_open_project_page' { $page = Read-ValidatedProjectPage -Slug (Get-RequiredArgument $callArguments 'slug') -Page (Get-RequiredArgument $callArguments 'page') }
                        'read_open_project_briefing' { $page = Get-ProjectReturnBriefing -Slug (Get-RequiredArgument $callArguments 'slug') }
                        'search_open_books' {
                            $page = Get-OpenBookSearch -Query (Get-RequiredArgument $callArguments 'query') -MaxResults (Get-OptionalArgument $callArguments 'max_results')
                        }
                        'discover_book_pages' {
                            $page = Get-BookDiscovery -Query (Get-RequiredArgument $callArguments 'query') -MaxResults (Get-OptionalArgument $callArguments 'max_results')
                        }
                        default { throw 'This adapter exposes only validated Book and Project reader tools.' }
                    }
                    # Claude Code currently displays structuredContent in preference to text blocks.
                    # Keep the validated page body in the standard content block so ordinary readers can read it.
                    New-McpResult -Id $inboundId -Result @{ content = @(@{ type = 'text'; text = $page.content }); isError = $false }
                }
                catch { New-McpError -Id $inboundId -Message $_.Exception.Message }
            }
            default { if ($null -ne $inboundId) { @{ jsonrpc = '2.0'; id = $inboundId; error = @{ code = -32601; message = 'Method not found.' } } | ConvertTo-Json -Compress } }
        }
    }
    catch { if ($null -ne $inboundId) { @{ jsonrpc = '2.0'; id = $inboundId; error = @{ code = -32600; message = 'Invalid request.' } } | ConvertTo-Json -Compress } }
}
