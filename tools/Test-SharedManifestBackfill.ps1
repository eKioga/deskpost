<#
Rung 7 of Plan item 2.2: the suite for Update-SharedBookManifests.ps1, the shared-collection
manifest backfill.

Rung 5 backfilled the local Shelf off the filesystem. The shared half reads closed Book bodies over
MCP, which is why it stays with the Librarian and why it cannot be tested against the NAS: a suite
that needs the network is a suite that stops proving anything the moment the network is down, and a
suite that only ever sees a healthy server proves only the happy path. So this runs against a
loopback stub endpoint, the same shape as the real one -- JSON-RPC over Server-Sent Events -- and
that stub is fault-injectable. The faults are the point: a substituted read, a truncated listing,
and an unreadable page are what the helper's fail-closed rules exist for.

What it proves:

  - the preflight reads no page body at all, and names no page path, page title, or note title;
  - a scope holding a closed Book is refused without both the exact plan_id and -UserConfirmed,
    before anything is read, locked, or written;
  - an approved run commits every Book at generation 1 with a digest a fresh generation matches;
  - a shared capture Book's note title, note path, and note body reach neither the stored
    generation nor the helper's output, and its page metadata reads `withheld`;
  - a read whose returned file_path differs from the requested one is refused, leaving that Book
    dirty rather than committing a manifest built from another Book's page;
  - a listing missing the Book's own _book page is refused as incomplete rather than committed as
    a short Book;
  - one unreadable Book leaves the rest of the pass committing, and the run reports incomplete;
  - the roster is written from the whole catalog even under -Book, because Discovery needs it to
    tell "unavailable" from "invisible";
  - resume trusts the journal only where the store confirms it, and -Rebuild reports which Book
    changed;
  - prune needs both signals to agree, and never touches the Shelf's stores;
  - -IncludeArchive generates the ARCHIVED shared Books' manifests from the ARCHIVED Books, proved
    against an active Book of the same slug carrying different pages -- the way this passes for the
    wrong reason is a helper that composes books/<slug>/wiki and commits the active twin's pages
    under the archived Book's name, so every assertion here is a wrong VALUE rather than an absence;
  - Discovery then covers the shared archive, labels it, and counts it -- and says NOT COVERED until
    the roster exists, because an absent roster is "we did not look", not "there is nothing there";
  - the archive's store is swept only when the archive was in scope, and the second prune signal is
    read at the ARCHIVED Book's own page rather than its active twin's;
  - an unreadable archive index is fatal to -IncludeArchive and writes no archive roster.

Everything runs against a disposable fixture workspace under the system temp directory and a
loopback stub. No NAS call is made; the reader's Shelf, Notebook, and Virtual Desk are untouched.
The helper is always run as a separate powershell.exe process, because its contract includes a
non-zero exit code. Exit code 0 means every case passed.

    tools/Test-SharedManifestBackfill.ps1
#>
[CmdletBinding()]
param([switch]$KeepFixture)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'BookManifestStore.ps1')
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
# Discovery itself, so the coverage half is proved by ASKING it rather than by inspecting the store.
# ADR-0012's own record of the Shelf half says why: every component was individually correct there,
# and only archiving a Book and then putting a question to Discovery showed the Book gone.
. (Join-Path $PSScriptRoot 'BookDiscovery.ps1')
# Fixtures work at a seat named 'fixture'. Set in this process so CHILD helper processes
# inherit it: they default -Seat to LIBRARY_SEAT, and there is no default seat to fall back on.
$env:LIBRARY_SEAT = 'fixture'

$backfill = Join-Path $PSScriptRoot 'Update-SharedBookManifests.ps1'

$script:passed = 0
$script:failed = @()

function Test-Case([string]$Name, [scriptblock]$Body) {
    try {
        & $Body
        $script:passed++
        Write-Host "  pass  $Name"
    }
    catch {
        $script:failed += "$Name -- $($_.Exception.Message)"
        Write-Host "  FAIL  $Name -- $($_.Exception.Message)"
    }
}

function Assert-True([bool]$Condition, [string]$What) {
    if (-not $Condition) { throw $What }
}

function Assert-Equal([string]$Expected, [string]$Actual, [string]$What) {
    if ($Expected -cne $Actual) { throw "$What was '$Actual', expected '$Expected'" }
}

# --- Stub MCP endpoint ----------------------------------------------------------------------------
# Port 0 picks a free port; the listener is loopback-only, which HttpListener permits without
# administrator rights. Shared state is synchronized so this thread can arm faults while the
# listener thread serves.
$probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$probe.Start()
$port = $probe.LocalEndpoint.Port
$probe.Stop()

$store = [hashtable]::Synchronized(@{
        Notes     = [hashtable]::Synchronized(@{})
        Faults    = [hashtable]::Synchronized(@{
                ReadWrongPath = [hashtable]::Synchronized(@{})
                ReadFail      = [Collections.ArrayList]::Synchronized([Collections.ArrayList]::new())
                ListDrop      = [hashtable]::Synchronized(@{})
                ListFail      = [Collections.ArrayList]::Synchronized([Collections.ArrayList]::new())
                # The server caps the page size it will honour. 0 means "honour what was asked",
                # which is what a co-operative server does; a positive value reproduces the cap the
                # real endpoint applied on 2026-09-05, where an unpaged call read 9 of 17 files.
                ListPageCap   = 0
                # Declare more items than are delivered, so the completeness proof has something to
                # catch that the _book guard structurally cannot.
                ListOverstate = [hashtable]::Synchronized(@{})
            })
        Calls     = [Collections.ArrayList]::Synchronized([Collections.ArrayList]::new())
        SessionId = [guid]::NewGuid().ToString('N')
        Running   = $true
    })

$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Start()

$serverScript = {
    function New-Text($Text) { @{ type = 'text'; text = [string]$Text } }
    function New-Fail([string]$Text) { @{ content = @((New-Text $Text)); structuredContent = @{ result = $null }; isError = $true } }
    function Get-Arg($Arguments, [string]$Name) {
        if ($null -eq $Arguments) { return $null }
        $property = $Arguments.PSObject.Properties[$Name]
        if ($null -eq $property) { return $null }
        $property.Value
    }

    while ($Store.Running) {
        $context = $null
        try { $context = $Listener.GetContext() } catch { break }
        try {
            $request = $context.Request
            $raw = ''
            if ($request.HasEntityBody) {
                $reader = [IO.StreamReader]::new($request.InputStream, [Text.Encoding]::UTF8)
                $raw = $reader.ReadToEnd()
                $reader.Dispose()
            }
            $payload = if ($raw) { $raw | ConvertFrom-Json } else { $null }
            $method = if ($null -ne $payload -and $payload.PSObject.Properties['method']) { [string]$payload.method } else { '' }
            $id = if ($null -ne $payload -and $payload.PSObject.Properties['id']) { $payload.id } else { $null }
            $response = $context.Response

            if ($null -eq $id) {
                $response.StatusCode = 202
                $response.ContentLength64 = 0
                $response.Close()
                continue
            }

            $result = $null
            if ($method -eq 'initialize') {
                $result = @{ protocolVersion = '2025-03-26'; capabilities = @{ tools = @{} }; serverInfo = @{ name = 'stub-basic-memory'; version = '0.0.1' } }
            }
            elseif ($method -eq 'tools/call') {
                $toolName = [string]$payload.params.name
                $toolArgs = $payload.params.arguments
                switch ($toolName) {
                    'read_note' {
                        $identifier = [string](Get-Arg $toolArgs 'identifier')
                        $path = if ($identifier.EndsWith('.md')) { $identifier } else { "$identifier.md" }
                        [void]$Store.Calls.Add("read_note:$path")
                        if ($Store.Faults.ReadFail -contains $path) { $result = New-Fail "Injected read failure for $path" }
                        elseif (-not $Store.Notes.ContainsKey($path)) { $result = New-Fail "Note not found: $path" }
                        else {
                            $note = $Store.Notes[$path]
                            $filePath = [string]$note.file_path
                            if ($Store.Faults.ReadWrongPath.ContainsKey($path)) { $filePath = [string]$Store.Faults.ReadWrongPath[$path] }
                            $record = @{ file_path = $filePath; title = $note.title; content = [string]$note.content }
                            $result = @{ content = @((New-Text ([string]$note.content))); structuredContent = @{ result = $record }; isError = $false }
                        }
                    }
                    'list_directory' {
                        $directory = [string](Get-Arg $toolArgs 'dir_name')
                        [void]$Store.Calls.Add("list_directory:$directory")
                        if ($Store.Faults.ListFail -contains $directory) { $result = New-Fail "Injected listing failure for $directory" }
                        else {
                            $dropped = if ($Store.Faults.ListDrop.ContainsKey($directory)) { [string]$Store.Faults.ListDrop[$directory] } else { '' }
                            $paths = @($Store.Notes.Keys | Where-Object { $_.StartsWith("$directory/") -and $_ -cne $dropped } | Sort-Object)
                            # The real endpoint's json shape, PAGINATED. It used to answer with a
                            # bare row list and no pagination at all, which is why a truncating
                            # server went unnoticed here for the whole of rung 7: the fixture was a
                            # lookalike of the response rather than a model of it, and the code it
                            # exercised could not have failed the way the live server made it fail.
                            $requestedSize = Get-Arg $toolArgs 'page_size'
                            $pageSize = if ($null -ne $requestedSize) { [int]$requestedSize } else { 10 }
                            $cap = [int]$Store.Faults.ListPageCap
                            if ($cap -gt 0 -and $pageSize -gt $cap) { $pageSize = $cap }
                            if ($pageSize -lt 1) { $pageSize = 1 }
                            $requestedPage = Get-Arg $toolArgs 'page'
                            $pageNumber = if ($null -ne $requestedPage) { [int]$requestedPage } else { 1 }
                            if ($pageNumber -lt 1) { $pageNumber = 1 }
                            $declared = $paths.Count
                            if ($Store.Faults.ListOverstate.ContainsKey($directory)) { $declared = [int]$Store.Faults.ListOverstate[$directory] }
                            $slice = @($paths | Select-Object -Skip (($pageNumber - 1) * $pageSize) -First $pageSize)
                            $nodes = @($slice | ForEach-Object { @{ name = [IO.Path]::GetFileName($_); file_path = $_; directory_path = "/$_"; type = 'file'; children = @() } })
                            $payload = @{ nodes = $nodes; page = $pageNumber; page_size = $pageSize; total = $declared; has_more = (($pageNumber * $pageSize) -lt $paths.Count) }
                            $listing = ($payload | ConvertTo-Json -Depth 8 -Compress)
                            $result = @{ content = @((New-Text $listing)); structuredContent = @{ result = $payload }; isError = $false }
                        }
                    }
                    default { $result = New-Fail "Unknown tool '$toolName'" }
                }
            }
            else { $result = New-Fail "Unknown method '$method'" }

            $json = @{ jsonrpc = '2.0'; id = $id; result = $result } | ConvertTo-Json -Depth 32 -Compress
            $bytes = [Text.Encoding]::UTF8.GetBytes("event: message`ndata: $json`n`n")
            $response.StatusCode = 200
            $response.ContentType = 'text/event-stream'
            if ($method -eq 'initialize') { $response.Headers.Add('Mcp-Session-Id', $Store.SessionId) }
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
        }
        catch {
            try {
                $context.Response.StatusCode = 500
                $message = [Text.Encoding]::UTF8.GetBytes([string]$_.Exception.Message)
                $context.Response.ContentLength64 = $message.Length
                $context.Response.OutputStream.Write($message, 0, $message.Length)
                $context.Response.Close()
            }
            catch { }
        }
    }
}

$runspace = [runspacefactory]::CreateRunspace()
$runspace.Open()
$runspace.SessionStateProxy.SetVariable('Listener', $listener)
$runspace.SessionStateProxy.SetVariable('Store', $store)
$server = [powershell]::Create()
$server.Runspace = $runspace
[void]$server.AddScript($serverScript)
$serverHandle = $server.BeginInvoke()

$mcpUrl = "http://127.0.0.1:$port/mcp"

function Set-Note([string]$Path, [string]$Content) {
    $store.Notes[$Path] = @{ file_path = $Path; title = [IO.Path]::GetFileNameWithoutExtension($Path); content = $Content }
}

# --- fixture --------------------------------------------------------------------------------------

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('library-shared-manifests-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$utf8 = [Text.UTF8Encoding]::new($false)

function Write-Fixture([string]$Relative, [string]$Text) {
    $path = Join-Path $fixture $Relative
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($path, $Text, $utf8)
}

# The helper is a process, not a function: its contract includes a non-zero exit code for a run that
# left a Book dirty, and `exit` from an in-process call would end this suite instead.
function Invoke-Backfill([string[]]$ArgumentList) {
    $lines = @()
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $lines = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $backfill @ArgumentList 2>&1) }
    finally { $ErrorActionPreference = $old }
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = $lines }
}

function Get-ResultJson($Invocation) {
    $jsonLines = @($Invocation.Lines | Where-Object { $_ -and $_.ToString().Trim().StartsWith('{') })
    if (-not $jsonLines.Count) { throw "the helper produced no JSON result; output was: $(($Invocation.Lines -join ' | '))" }
    ($jsonLines[-1] | ConvertFrom-Json)
}

function Invoke-Preflight([string[]]$ExtraArgs = @()) {
    $preArgs = @('-Preflight', '-Json', '-WorkspacePath', $fixture, '-McpUrl', $mcpUrl)
    if ($ExtraArgs.Count) { $preArgs += $ExtraArgs }
    $pre = Invoke-Backfill $preArgs
    if ($pre.ExitCode -ne 0) { throw "the preflight failed: $($pre.Lines -join ' | ')" }
    [pscustomobject]@{ Plan = (Get-ResultJson $pre); Lines = $pre.Lines }
}

# Preflight, then run with that plan's exact approval. Every fixture run needs it, because every
# fixture Book is closed. ExtraArgs go to the preflight too: the plan_id covers the mode and the
# scope, so a -Rebuild run must be approved by a -Rebuild preflight's plan_id.
function Approve-And-Run([string[]]$ExtraArgs = @()) {
    $pre = Invoke-Preflight $ExtraArgs
    $runArgs = @('-WorkspacePath', $fixture, '-McpUrl', $mcpUrl, '-Json', '-UserConfirmed', '-ApprovedPlanId', ([string]$pre.Plan.plan_id))
    if ($ExtraArgs.Count) { $runArgs += $ExtraArgs }
    $run = Invoke-Backfill $runArgs
    [pscustomobject]@{ Plan = (Get-ResultJson $run); ExitCode = $run.ExitCode; Lines = $run.Lines; PlanId = [string]$pre.Plan.plan_id }
}

function Get-SharedStatus([string]$Slug) { (Get-StoredBookManifest -Workspace $fixture -Slug $Slug -Collection 'shared').status }
function Get-SharedManifest([string]$Slug) { (Get-StoredBookManifest -Workspace $fixture -Slug $Slug -Collection 'shared').manifest }
function Get-ArchiveStatus([string]$Slug) { (Get-StoredBookManifest -Workspace $fixture -Slug $Slug -Collection 'shared-archive').status }
function Get-ArchiveManifest([string]$Slug) { (Get-StoredBookManifest -Workspace $fixture -Slug $Slug -Collection 'shared-archive').manifest }
# BY ROOT, not by slug, wherever the archive is in play: `books/dup` and `archive/dup` are two rows
# of the same run, and a slug filter would return both and then assert against whichever came first.
function Get-BookResult($Plan, [string]$Slug) { @($Plan.books | Where-Object { $_.slug -ceq $Slug }) }
function Get-RootResult($Plan, [string]$Root) { @($Plan.books | Where-Object { $_.book_root -ceq $Root }) }
function Get-ArchiveRosterPath { Join-Path $fixture 'internal/book-manifests/shared-archive/_roster.json' }
function Invoke-Discovery([string]$Query) {
    Find-BookPages -Workspace $fixture -Query $Query -MaxResults 50 `
        -DeskStateDirectory (Get-DeskStateDirectory -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture')
}

$noteTitleSentinel = 'Unvetted Capture Heading'
$noteBodySentinel = 'UNVETTED-NOTE-BODY-SENTINEL'
$bodySentinel = 'PAGE-BODY-SENTINEL'

function Reset-Stub {
    $store.Notes.Clear()
    $store.Faults.ReadWrongPath.Clear()
    $store.Faults.ReadFail.Clear()
    $store.Faults.ListDrop.Clear()
    $store.Faults.ListFail.Clear()
    $store.Faults.ListPageCap = 0
    $store.Faults.ListOverstate.Clear()
    $store.Calls.Clear()

    # Non-ASCII from code points, never as a literal: this file has no BOM, and a literal accented
    # character in the source would be read as ANSI by Windows PowerShell 5.1. A manifest fixture
    # that is pure ASCII cannot catch an encoding defect -- that is how one hid for a day in rung 2.
    $eAcute = [string][char]0x00E9
    $emDash = [string][char]0x2014

    Set-Note 'books/README.md' @"
# Book Catalog

## Current entries

- [[books/alpha/wiki/_book|Alpha Reference]] $emDash A shared Book about retrieval, with a caf$eAcute in it.
- [[books/hold/wiki/_book|Held Notes]] $emDash A shared capture Book.
- [[books/gamma/wiki/_book|Gamma Guide]] $emDash A third shared Book.

## Open a Book
"@

    Set-Note 'books/alpha/wiki/_book.md' "# Alpha Reference`n`n- **Kind:** curated`n- **Topics:** retrieval, fixtures`n`nOverview carrying $bodySentinel.`n"
    # Full note paths, which is how the shared collection actually writes its reader-map links --
    # observed on rung 7's first real run, where a relative-link fixture had agreed with the code and
    # both had disagreed with the NAS. One dead link and one link out of the Book are here too.
    Set-Note 'books/alpha/wiki/_index.md' "# Alpha Reader Map`n`n## Where retrieval starts`n`n- [[books/alpha/wiki/guide/setup|Setup, on retrieval]]`n- [[books/alpha/wiki/guide/gone|A retrieval page that was deleted]]`n- [[books/gamma/wiki/_book|Gamma, another Book]]`n"
    # A pinned page, so the schema-2 roll-up is exercised over pages that arrived over MCP rather
    # than off disk -- the one thing that differs between the two collections.
    $sharedOid = '0123456789abcdef0123456789abcdef01234567'
    $sharedHash = 'a' * 64
    Set-Note 'books/alpha/wiki/guide/setup.md' ("# Setup Guide`n`n## Retrieval settings`n`nBody carrying $bodySentinel.`n`n## Sources`n`n" +
        "- Upstream ``https://github.com/obsidianmd/obsidian-help`` ref ``refs/heads/master`` at ``$sharedOid``; repo root ``raw/obsidian-help``; captured ``2026-09-04```n" +
        "- ``raw/obsidian-help/en/a.md`` - SHA-256 ``$sharedHash``; provenance: ``external```n")
    Set-Note 'books/alpha/wiki/guide/unicode.md' "# Unicode Page`n`n## Caf$eAcute $emDash retrieval notes`n"

    Set-Note 'books/hold/wiki/_book.md' "# Held Notes`n`n- **Kind:** capture`n- **Topics:** capture`n"
    Set-Note 'books/hold/wiki/notes/held.md' ("# $noteTitleSentinel on retrieval`n`nNote body carrying $noteBodySentinel.`n`n## Sources`n`n" +
        "- Upstream ``https://github.com/private-org/secret-repo`` ref ``refs/heads/main`` at ``$sharedOid``; repo root ``raw/secret``; captured ``2026-09-04```n" +
        "- ``raw/secret/x.md`` - SHA-256 ``$sharedHash``; provenance: ``external```n")

    Set-Note 'books/gamma/wiki/_book.md' "# Gamma Guide`n`n- **Kind:** curated`n`n## Retrieval in gamma`n"
    Set-Note 'books/gamma/wiki/guide/notes.md' "# Gamma Notes`n`n## More retrieval`n"
}

# The one term the archive cases query. Deliberately absent from the base fixture's Books, so a
# Discovery answer here is small and the archive's hits cannot be pushed past the result cap by
# unrelated matches -- a truncated answer would make a missing archive hit look like a wrong value.
$dupTerm = 'duplicated'

function Add-ArchiveFixture {
    <#
    .SYNOPSIS
        Add a shared archive holding two Books, one of which has an ACTIVE Book of the same slug.

    .DESCRIPTION
        THE ACTIVE TWIN IS THE WHOLE POINT, and it is the trap ADR-0012 names for the Shelf half
        arriving on the shared side. A helper that composes `books/<slug>/wiki` for an archived Book
        does not fail: it reads the ACTIVE twin, and commits a manifest with a plausible page count,
        a real reader map, and real headings, under the ARCHIVED Book's name. Nothing is missing, so
        no absence-based assertion can see it.

        So the two copies of `dup` are made to disagree on every observable: different page paths,
        different headings, and a reader map whose links carry the archive root. Each store is then
        asserted to hold ITS OWN Book's content, which makes the wrong answer a wrong VALUE.
    #>
    $emDash = [string][char]0x2014

    # The active twin joins the catalog, so `dup` is a live Book in BOTH halves.
    $catalog = [string]$store.Notes['books/README.md'].content
    Set-Note 'books/README.md' ($catalog + "`n- [[books/dup/wiki/_book|Dup, the active twin]] $emDash The ACTIVE Book of a $dupTerm slug.`n")
    Set-Note 'books/dup/wiki/_book.md' "# Dup, the active twin`n`n- **Kind:** curated`n`n## A $dupTerm slug, in the ACTIVE twin`n"
    Set-Note 'books/dup/wiki/guide/active.md' "# Active Only`n`n## A $dupTerm slug, on a page only the active twin has`n"

    Set-Note 'archive/README.md' @"
# Archive

Retired or superseded material is retained here with its status and replacement reference.

## Archived Books

- [[archive/dup/wiki/_book|Dup, the archived twin]] $emDash Archived 2026-09-03
- [[archive/retired/wiki/_book|Retired Reference]] $emDash Archived 2026-08-28
"@

    Set-Note 'archive/dup/wiki/_book.md' "# Dup, the archived twin`n`n- **Kind:** curated`n- **Topics:** retirement`n`n## A $dupTerm slug, in the ARCHIVED twin`n"
    # A reader map written the way the shared collection writes one -- FULL note paths, under the
    # ARCHIVE root. A helper generating this Book off books/dup/wiki would fail to reduce these to
    # canonical page paths, so the map link is a second, independent witness to which Book was read.
    Set-Note 'archive/dup/wiki/_index.md' "# Archived Reader Map`n`n## Where the archived copy starts`n`n- [[archive/dup/wiki/guide/legacy|The legacy page]]`n"
    Set-Note 'archive/dup/wiki/guide/legacy.md' "# Legacy Only`n`n## A $dupTerm slug, on a page only the archived twin has`n"

    Set-Note 'archive/retired/wiki/_book.md' "# Retired Reference`n`n- **Kind:** curated`n`n## Retrieval, retired`n"
    Set-Note 'archive/retired/wiki/guide/old.md' "# Old Page`n`n## More retrieval, retired`n"
}

function Reset-Fixture {
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
    New-Item -ItemType Directory -Path $fixture -Force | Out-Null
    Write-Fixture (Get-DeskFileRelativePath -Seat 'fixture' -Kind 'books') ''
    # A Shelf catalog and one Shelf store, present only so the shared run can be proved to leave
    # them alone: rung 7 namespaced the store, and a sweep that walked the whole root would measure
    # the Shelf's stores against the shared catalog.
    Write-Fixture 'shelf/_catalog.md' "# Local Shelf`n`n## Shelf Book`n- **Summary:** untouched by any shared run`n- **Topics:** shelf`n- **Path:** shelf/shelfbook`n"
    Write-Fixture 'internal/book-manifests/shelf/shelfbook/current.json' '{ "schema": 1, "slug": "shelfbook", "generation": 1, "committed_utc": "2026-08-19T00:00:00Z", "manifest_sha256": "x", "source_digest": "y" }'
}

try {

Write-Host 'Test-SharedManifestBackfill'

# === the preflight ================================================================================

Reset-Stub
Reset-Fixture

Test-Case 'the preflight plans every catalogued Book and asks for approval' {
    $pre = Invoke-Preflight
    Assert-Equal '3' ([string]$pre.Plan.books_total) 'the preflight Book count'
    Assert-Equal 'True' ([string]$pre.Plan.confirmation_required) 'confirmation_required with three closed Books'
    Assert-True ([string]$pre.Plan.plan_id -clike 'update-shared-book-manifests-*') 'the preflight carries no plan_id of its own operation'
    Assert-Equal 'False' ([string]$pre.Plan.shared_library_write) 'the preflight claims a shared write'
    Assert-Equal '3' ([string]@($pre.Plan.books).Count) 'the preflight listed a different number of Books'
    $alpha = Get-BookResult $pre.Plan 'alpha'
    Assert-Equal '4' ([string]$alpha[0].page_count) "alpha's page count"
    Assert-Equal 'backfill' ([string]$alpha[0].action) "alpha's planned action"
    Assert-Equal 'Alpha Reference' ([string]$alpha[0].title) "alpha's title came from the catalog"
}

Test-Case 'the preflight reads no page body, and discloses no page path or note title' {
    $store.Calls.Clear()
    $pre = Invoke-Preflight
    $reads = @($store.Calls | Where-Object { $_ -clike 'read_note:*' })
    Assert-Equal '1' ([string]$reads.Count) "the preflight read $($reads.Count) note(s); it may read only books/README"
    Assert-Equal 'read_note:books/README.md' ([string]$reads[0]) 'the preflight read a page rather than the catalog'
    $serialized = $pre.Plan | ConvertTo-Json -Depth 10
    Assert-True ($serialized.IndexOf('guide/setup', [StringComparison]::Ordinal) -lt 0) 'a page path reached the preflight'
    Assert-True ($serialized.IndexOf('notes/held', [StringComparison]::Ordinal) -lt 0) 'a note path reached the preflight'
    Assert-True ($serialized.IndexOf($noteTitleSentinel, [StringComparison]::Ordinal) -lt 0) 'a capture note title reached the preflight'
    Assert-True ($serialized.IndexOf('Setup Guide', [StringComparison]::Ordinal) -lt 0) 'a page title reached the preflight'
    Assert-True ($serialized.IndexOf($bodySentinel, [StringComparison]::Ordinal) -lt 0) 'page body text reached the preflight'
    Assert-True ($serialized.IndexOf('unknown until generation', [StringComparison]::Ordinal) -ge 0) 'the preflight guessed a kind it cannot know before reading'
}

Test-Case 'the preflight writes nothing' {
    Invoke-Preflight | Out-Null
    Assert-Equal 'missing' (Get-SharedStatus 'alpha') "alpha's store after a preflight"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'internal/book-manifests/shared/_roster.json'))) 'the preflight wrote a roster'
}

# === the refusals =================================================================================

Test-Case 'a run without -UserConfirmed is refused and writes nothing' {
    $pre = Invoke-Preflight
    $run = Invoke-Backfill @('-WorkspacePath', $fixture, '-McpUrl', $mcpUrl, '-Json', '-ApprovedPlanId', ([string]$pre.Plan.plan_id))
    Assert-True ($run.ExitCode -ne 0) 'an unconfirmed run exited 0'
    Assert-True ((($run.Lines -join ' ') -clike '*-UserConfirmed*')) 'the refusal did not name the missing confirmation'
    Assert-Equal 'missing' (Get-SharedStatus 'alpha') "alpha's store after an unconfirmed run"
    $reads = @($store.Calls | Where-Object { $_ -clike 'read_note:books/alpha*' })
    Assert-Equal '0' ([string]$reads.Count) 'a refused run read a Book page anyway'
}

Test-Case 'a run carrying a fabricated plan_id is refused' {
    $run = Invoke-Backfill @('-WorkspacePath', $fixture, '-McpUrl', $mcpUrl, '-Json', '-UserConfirmed', '-ApprovedPlanId', 'update-shared-book-manifests-fabricated')
    Assert-True ($run.ExitCode -ne 0) 'a fabricated plan_id was accepted'
    Assert-Equal 'missing' (Get-SharedStatus 'alpha') "alpha's store after a fabricated approval"
}

Test-Case 'a plan_id approved for one scope does not cover another' {
    $scoped = Invoke-Preflight @('-Book', 'alpha')
    $run = Invoke-Backfill @('-WorkspacePath', $fixture, '-McpUrl', $mcpUrl, '-Json', '-UserConfirmed', '-ApprovedPlanId', ([string]$scoped.Plan.plan_id))
    Assert-True ($run.ExitCode -ne 0) 'a one-Book approval covered the whole collection'
    Assert-Equal 'missing' (Get-SharedStatus 'gamma') "gamma's store after a mis-scoped approval"
}

Test-Case 'an unknown Book slug is refused before anything else happens' {
    $run = Invoke-Backfill @('-WorkspacePath', $fixture, '-McpUrl', $mcpUrl, '-Json', '-Book', 'no-such-book', '-Preflight')
    Assert-True ($run.ExitCode -ne 0) 'an unknown slug was planned'
    Assert-True ((($run.Lines -join ' ') -clike '*books/README*')) 'the refusal did not say where the Book list comes from'
}

# === the approved run =============================================================================

Test-Case 'an approved run commits every Book at generation 1' {
    $run = Approve-And-Run
    Assert-Equal '0' ([string]$run.ExitCode) "the run exited $($run.ExitCode): $($run.Lines -join ' | ')"
    Assert-Equal 'complete' ([string]$run.Plan.status) 'the run status'
    Assert-Equal '0' ([string]$run.Plan.dirty_books) 'the run left Books dirty'
    foreach ($slug in @('alpha', 'hold', 'gamma')) {
        Assert-Equal 'ok' (Get-SharedStatus $slug) "the store for $slug"
        Assert-Equal '1' ([string](Get-StoredBookManifest -Workspace $fixture -Slug $slug -Collection 'shared').generation) "the committed generation for $slug"
    }
    $alphaManifest = Get-SharedManifest 'alpha'
    Assert-Equal 'Alpha Reference' ([string]$alphaManifest.title) "alpha's stored title"
    Assert-Equal 'curated' ([string]$alphaManifest.kind) "alpha's stored kind"
    Assert-Equal '4' ([string]$alphaManifest.page_count) "alpha's stored page count"
    Assert-True (@($alphaManifest.pages | Where-Object { $_.path -ceq 'guide/setup' }).Count -eq 1) 'a shared page path is not canonical below wiki/'
    Assert-True ($null -ne $alphaManifest.reader_map) "alpha's reader map was not captured"
    # The reader map's links must be spelled the way page paths are, or Discovery can never match
    # one to a page and every map hit degrades to a Book-level hit.
    $mapTargets = @($alphaManifest.reader_map.links | ForEach-Object { [string]$_.target })
    Assert-True ($mapTargets -ccontains 'guide/setup') "a shared reader-map link was not reduced to a canonical page path: $($mapTargets -join ', ')"
    Assert-True ($mapTargets -ccontains 'guide/gone') 'a dead reader-map link was not reduced, so it could never be recognised as dead'
    Assert-True ($mapTargets -ccontains 'books/gamma/wiki/_book') 'a link out of the Book was rewritten as though it were a page of this one'
}

Test-Case 'the committed manifest describes the Book as it stands, and holds no body text' {
    $alphaGeneration = [IO.File]::ReadAllText((Join-Path $fixture 'internal/book-manifests/shared/alpha/generations/1.json'))
    Assert-True ($alphaGeneration.IndexOf($bodySentinel, [StringComparison]::Ordinal) -lt 0) 'page body text reached the stored generation'
    # A canary written over ASCII cannot catch an encoding defect: this asserts the accented
    # character survived generation, JSON storage, and the read path.
    $eAcute = [string][char]0x00E9
    $alphaManifest = Get-SharedManifest 'alpha'
    $unicodePage = @($alphaManifest.pages | Where-Object { $_.path -ceq 'guide/unicode' })
    Assert-Equal '1' ([string]$unicodePage.Count) 'the unicode page is missing from the manifest'
    # Every heading, not headings[0]: the accented one is the H2, and an assertion that indexes a
    # fixed position tests whichever heading happens to be there rather than the one it names.
    $unicodeHeadings = @($unicodePage[0].headings | ForEach-Object { [string]$_.text })
    Assert-True (@($unicodeHeadings | Where-Object { $_.IndexOf("Caf$eAcute", [StringComparison]::Ordinal) -ge 0 }).Count -eq 1) 'a non-ASCII heading was mangled between MCP and the store'
    Assert-True (([string]$alphaManifest.summary).IndexOf("caf$eAcute", [StringComparison]::Ordinal) -ge 0) 'a non-ASCII catalog summary was mangled'
}

Test-Case 'a shared Book rolls up its upstream pins, sanitized' {
    $alphaManifest = Get-SharedManifest 'alpha'
    Assert-Equal '2' ([string]$alphaManifest.schema) "alpha's stored manifest body schema"
    Assert-Equal '1' ([string]@($alphaManifest.anchored_upstreams).Count) 'the rolled-up upstream count for a shared Book'
    Assert-Equal 'https://github.com/obsidianmd/obsidian-help' ([string]$alphaManifest.anchored_upstreams[0].url) 'the rolled-up upstream URL'
    Assert-Equal '0' ([string]$alphaManifest.anchor_unreadable) 'a well-formed Sources block was counted as unreadable'
    $alphaGeneration = [IO.File]::ReadAllText((Join-Path $fixture 'internal/book-manifests/shared/alpha/generations/1.json'))
    Assert-True ($alphaGeneration.IndexOf('raw/obsidian-help', [StringComparison]::Ordinal) -lt 0) 'the producer-local repo root reached the stored generation'
}

Test-Case 'a shared capture Book stores counts only' {
    $holdManifest = Get-SharedManifest 'hold'
    Assert-Equal 'capture' ([string]$holdManifest.kind) "hold's stored kind"
    Assert-Equal 'withheld' ([string]$holdManifest.page_metadata) "hold's page metadata"
    Assert-Equal '0' ([string]@($holdManifest.pages).Count) 'a capture Book stored page metadata'
    $holdGeneration = [IO.File]::ReadAllText((Join-Path $fixture 'internal/book-manifests/shared/hold/generations/1.json'))
    Assert-True ($holdGeneration.IndexOf($noteTitleSentinel, [StringComparison]::Ordinal) -lt 0) 'a capture note title reached the stored generation'
    Assert-True ($holdGeneration.IndexOf('notes/held', [StringComparison]::Ordinal) -lt 0) 'a capture note path reached the stored generation'
    Assert-True ($holdGeneration.IndexOf($noteBodySentinel, [StringComparison]::Ordinal) -lt 0) 'capture note body text reached the stored generation'
    # The schema-2 canary, against a capture note that DOES carry a pin.
    Assert-Equal '0' ([string]@($holdManifest.anchored_upstreams).Count) 'a shared capture Book carried anchor data'
    Assert-True ($holdGeneration.IndexOf('private-org', [StringComparison]::Ordinal) -lt 0) 'a capture note''s upstream URL reached the stored generation'
    Assert-True ($holdGeneration.IndexOf('secret-repo', [StringComparison]::Ordinal) -lt 0) 'a capture note''s repository name reached the stored generation'
}

Test-Case 'the roster names every catalogued Book' {
    $roster = [IO.File]::ReadAllText((Join-Path $fixture 'internal/book-manifests/shared/_roster.json')) | ConvertFrom-Json
    $slugs = @($roster.books | ForEach-Object { [string]$_.slug })
    Assert-Equal '3' ([string]$slugs.Count) 'the roster Book count'
    foreach ($slug in @('alpha', 'hold', 'gamma')) { Assert-True ($slugs -ccontains $slug) "the roster omits $slug" }
}

Test-Case 'a second run is idempotent and reads no page body' {
    $store.Calls.Clear()
    $run = Approve-And-Run
    Assert-Equal '0' ([string]$run.ExitCode) 'the second run failed'
    foreach ($slug in @('alpha', 'hold', 'gamma')) {
        $entry = Get-BookResult $run.Plan $slug
        Assert-Equal 'already current' ([string]$entry[0].status) "the second run's outcome for $slug"
        Assert-Equal '1' ([string](Get-StoredBookManifest -Workspace $fixture -Slug $slug -Collection 'shared').generation) "$slug advanced a generation with nothing to do"
    }
    $pageReads = @($store.Calls | Where-Object { $_ -clike 'read_note:books/alpha/wiki/guide*' })
    Assert-Equal '0' ([string]$pageReads.Count) 'a no-work run read page bodies anyway'
}

Test-Case 'the Shelf collection is untouched by a shared run' {
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'internal/book-manifests/shelf/shelfbook/current.json')) 'a shared run removed a Shelf Book''s store'
}

# === failure injection ============================================================================

Test-Case 'a substituted read leaves that Book dirty and commits nothing for it' {
    Reset-Stub
    Reset-Fixture
    $store.Faults.ReadWrongPath['books/alpha/wiki/guide/setup.md'] = 'books/gamma/wiki/guide/notes.md'
    $run = Approve-And-Run
    Assert-True ($run.ExitCode -ne 0) 'a run with a substituted read exited 0'
    Assert-Equal 'incomplete' ([string]$run.Plan.status) 'the run status with a substituted read'
    Assert-Equal 'dirty' (Get-SharedStatus 'alpha') "alpha's store after a substituted read"
    $entry = Get-BookResult $run.Plan 'alpha'
    Assert-True (([string]$entry[0].detail) -clike '*withheld*') 'the substituted read was not reported as a withheld record'
    Assert-Equal 'ok' (Get-SharedStatus 'gamma') 'one Book''s substituted read cost another Book its manifest'
    Assert-Equal 'ok' (Get-SharedStatus 'hold') 'one Book''s substituted read cost the capture Book its manifest'
}

Test-Case 'a truncated listing is refused rather than committed as a short Book' {
    Reset-Stub
    Reset-Fixture
    # The Book's own _book page dropped from the listing: the one truncation a listing can be
    # checked against, because every Book has one and the catalog links to it.
    $store.Faults.ListDrop['books/gamma/wiki'] = 'books/gamma/wiki/_book.md'
    $run = Approve-And-Run
    Assert-True ($run.ExitCode -ne 0) 'a truncated listing was accepted'
    Assert-Equal 'dirty' (Get-SharedStatus 'gamma') "gamma's store after a truncated listing"
    $entry = Get-BookResult $run.Plan 'gamma'
    Assert-True (([string]$entry[0].detail) -clike '*incomplete*') 'the truncated listing was not reported as incomplete'
    Assert-Equal 'ok' (Get-SharedStatus 'alpha') 'a truncated listing for one Book cost another its manifest'
}

Test-Case 'a paginated listing is followed to its last page' {
    Reset-Stub
    Reset-Fixture
    # One item per page, so every Book needs several round trips. This is the defect that shipped:
    # a single unpaged call read page 1 and the _book guard passed, because _book.md sorts first.
    $store.Faults.ListPageCap = 1
    $run = Approve-And-Run
    Assert-Equal 0 $run.ExitCode 'a paginated listing was not followed to its last page'
    Assert-Equal 'ok' (Get-SharedStatus 'alpha') "alpha's store after a paginated listing"
    # alpha holds _book, _index, guide/setup and guide/unicode. A page-1-only read would find one.
    $manifest = Get-SharedManifest 'alpha'
    Assert-Equal '4' ([string]$manifest.page_count) 'the paginated listing lost pages'
    Assert-True ($store.Calls -contains 'list_directory:books/alpha/wiki') 'the listing was never called'
}

Test-Case 'a listing that delivers fewer items than it declares is refused' {
    Reset-Stub
    Reset-Fixture
    # The _book guard cannot see this one: _book.md is present and every delivered row is real.
    # Only the count the server itself declares catches a short listing.
    $store.Faults.ListOverstate['books/gamma/wiki'] = 9
    $run = Approve-And-Run
    Assert-True ($run.ExitCode -ne 0) 'a short listing was accepted'
    Assert-Equal 'dirty' (Get-SharedStatus 'gamma') "gamma's store after a short listing"
    $entry = Get-BookResult $run.Plan 'gamma'
    Assert-True (([string]$entry[0].detail) -clike '*incomplete*') 'the short listing was not reported as incomplete'
    Assert-Equal 'ok' (Get-SharedStatus 'alpha') 'a short listing for one Book cost another its manifest'
}

Test-Case 'an unreadable page leaves one Book dirty and the pass carries on' {
    Reset-Stub
    Reset-Fixture
    [void]$store.Faults.ReadFail.Add('books/alpha/wiki/guide/unicode.md')
    $run = Approve-And-Run
    Assert-True ($run.ExitCode -ne 0) 'a run with an unreadable page exited 0'
    Assert-Equal 'dirty' (Get-SharedStatus 'alpha') "alpha's store after an unreadable page"
    Assert-Equal 'ok' (Get-SharedStatus 'gamma') 'one unreadable page took down another Book'
    Assert-Equal 'ok' (Get-SharedStatus 'hold') 'one unreadable page took down the capture Book'
    Assert-Equal '1' ([string]$run.Plan.dirty_books) 'the run did not report exactly one dirty Book'
    # And the repair: with the fault cleared, the plain run covers `dirty` as well as `missing`.
    $store.Faults.ReadFail.Clear()
    $repair = Approve-And-Run
    Assert-Equal '0' ([string]$repair.ExitCode) 'the repair run failed'
    Assert-Equal 'ok' (Get-SharedStatus 'alpha') "alpha's store after the repair run"
    Assert-Equal 'repair' ([string](Get-BookResult $repair.Plan 'alpha')[0].action) 'the repair was not planned as a repair'
}

Test-Case 'a Book whose _book page cannot be read is never generated as curated' {
    Reset-Stub
    Reset-Fixture
    # The one capture signal the shared collection has. Losing it must fail the Book, never publish
    # its page metadata on the assumption that it is curated.
    [void]$store.Faults.ReadFail.Add('books/hold/wiki/_book.md')
    $run = Approve-And-Run
    Assert-Equal 'dirty' (Get-SharedStatus 'hold') "hold's store with an unreadable _book page"
    $stored = Get-StoredBookManifest -Workspace $fixture -Slug 'hold' -Collection 'shared'
    Assert-True ($null -eq $stored.manifest) 'a Book with an unreadable _book page still served a manifest'
}

# === scoping, resume, rebuild, prune ==============================================================

Test-Case 'a -Book run touches one Book and still writes the whole roster' {
    Reset-Stub
    Reset-Fixture
    $run = Approve-And-Run @('-Book', 'alpha')
    Assert-Equal '0' ([string]$run.ExitCode) 'the scoped run failed'
    Assert-Equal 'ok' (Get-SharedStatus 'alpha') "alpha's store after a scoped run"
    Assert-Equal 'missing' (Get-SharedStatus 'gamma') 'a scoped run generated an out-of-scope Book'
    $roster = [IO.File]::ReadAllText((Join-Path $fixture 'internal/book-manifests/shared/_roster.json')) | ConvertFrom-Json
    Assert-Equal '3' ([string]@($roster.books).Count) 'a scoped run wrote a partial roster, which would make the other Books invisible rather than unavailable'
}

Test-Case 'resume trusts the journal only where the store confirms it' {
    Reset-Stub
    Reset-Fixture
    Approve-And-Run | Out-Null
    $journals = @(Get-ChildItem -LiteralPath (Join-Path $fixture 'internal/manifest-journals') -File -Filter 'shared-backfill-*.json')
    Assert-Equal '1' ([string]$journals.Count) 'the run wrote no journal, or wrote more than one'
    # The store is the authority: remove one Book's store and the resumed run must redo exactly it.
    Remove-Item -LiteralPath (Join-Path $fixture 'internal/book-manifests/shared/gamma') -Recurse -Force
    $store.Calls.Clear()
    $resumed = Approve-And-Run
    Assert-Equal '0' ([string]$resumed.ExitCode) 'the resumed run failed'
    Assert-Equal 'ok' (Get-SharedStatus 'gamma') "gamma's store after the resumed run"
    Assert-Equal 'committed' ([string](Get-BookResult $resumed.Plan 'gamma')[0].status) 'the resumed run did not redo the Book whose store was gone'
    Assert-Equal 'already current' ([string](Get-BookResult $resumed.Plan 'alpha')[0].status) 'the resumed run redid a Book the store still confirms'
    $alphaReads = @($store.Calls | Where-Object { $_ -clike 'read_note:books/alpha/wiki/guide*' })
    Assert-Equal '0' ([string]$alphaReads.Count) 'the resumed run re-read a Book it did not need to'
}

Test-Case 'an unreadable journal is treated as absent rather than fatal' {
    $journals = @(Get-ChildItem -LiteralPath (Join-Path $fixture 'internal/manifest-journals') -File -Filter 'shared-*.json')
    [IO.File]::WriteAllText($journals[0].FullName, 'not json at all', $utf8)
    $run = Approve-And-Run
    Assert-Equal '0' ([string]$run.ExitCode) 'an unreadable journal was fatal'
}

Test-Case '-Rebuild reports which Book changed out of band' {
    Reset-Stub
    Reset-Fixture
    Approve-And-Run | Out-Null
    $unchanged = Approve-And-Run @('-Rebuild')
    Assert-Equal '0' ([string]$unchanged.ExitCode) 'the rebuild failed'
    foreach ($slug in @('alpha', 'gamma')) {
        $entry = Get-BookResult $unchanged.Plan $slug
        Assert-Equal 'committed' ([string]$entry[0].status) "the rebuild did not commit $slug"
        Assert-Equal 'False' ([string]$entry[0].changed) "the rebuild reported an unchanged Book as changed: $slug"
        Assert-Equal '2' ([string](Get-StoredBookManifest -Workspace $fixture -Slug $slug -Collection 'shared').generation) "$slug did not advance a generation under -Rebuild"
    }
    Set-Note 'books/gamma/wiki/guide/notes.md' "# Gamma Notes`n`n## More retrieval`n`n## And a heading nobody committed`n"
    $changed = Approve-And-Run @('-Rebuild')
    Assert-Equal 'True' ([string](Get-BookResult $changed.Plan 'gamma')[0].changed) 'an edited Book was reported unchanged'
    Assert-Equal 'False' ([string](Get-BookResult $changed.Plan 'alpha')[0].changed) 'an untouched Book was reported changed'
}

Test-Case 'prune needs both signals to agree' {
    Reset-Stub
    Reset-Fixture
    Approve-And-Run | Out-Null
    # A store for a Book in neither the catalog nor the collection: an orphan, removed.
    Write-Fixture 'internal/book-manifests/shared/ghost/current.json' '{ "schema": 1, "slug": "ghost", "generation": 1, "committed_utc": "2026-08-19T00:00:00Z", "manifest_sha256": "x", "source_digest": "y" }'
    # A store for a Book that EXISTS in the collection but is missing from the catalog: a catalog
    # problem, and deleting derived state is the wrong response to a state we do not understand.
    Set-Note 'books/uncatalogued/wiki/_book.md' "# Uncatalogued`n"
    Write-Fixture 'internal/book-manifests/shared/uncatalogued/current.json' '{ "schema": 1, "slug": "uncatalogued", "generation": 1, "committed_utc": "2026-08-19T00:00:00Z", "manifest_sha256": "x", "source_digest": "y" }'
    $run = Approve-And-Run
    Assert-True (@($run.Plan.pruned) -ccontains 'ghost') 'an orphan store was not pruned'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'internal/book-manifests/shared/ghost'))) 'the orphan store directory survived'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'internal/book-manifests/shared/uncatalogued')) 'a store whose Book still exists was deleted on one signal'
    Assert-True (@($run.Plan.stores_kept_unresolved | ForEach-Object { [string]$_.slug }) -ccontains 'uncatalogued') 'the kept store was not reported as unresolved'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'internal/book-manifests/shelf/shelfbook/current.json')) 'the shared prune sweep removed a Shelf store'
}

# === the shared collection's archive =============================================================
#
# ADR-0012 closed the Shelf half and left this one open, because generating an archived shared Book's
# manifest means reading it over MCP. Everything below is that half. The load-bearing cases are the
# two ADR-0012 names: an active and archived Book OF THE SAME SLUG, which is where a fixture is most
# likely to pass for the wrong reason, and the COVERAGE COUNT, which is what the original defect got
# wrong while still reading complete.

Test-Case 'the archive is out of scope by default: not read, not rostered, not swept' {
    Reset-Stub
    Reset-Fixture
    Add-ArchiveFixture
    # An orphan archive store, planted before a run that was never asked about the archive. Pruning
    # it would be deleting derived state on no evidence.
    Write-Fixture 'internal/book-manifests/shared-archive/ghost/current.json' '{ "schema": 1, "slug": "ghost", "generation": 1, "committed_utc": "2026-09-08T00:00:00Z", "manifest_sha256": "x", "source_digest": "y" }'
    $store.Calls.Clear()
    $run = Approve-And-Run
    Assert-Equal '0' ([string]$run.ExitCode) "the default run failed: $($run.Lines -join ' | ')"
    Assert-Equal 'False' ([string]$run.Plan.archive_in_scope) 'a default run put the archive in scope'
    Assert-Equal '0' ([string]@($store.Calls | Where-Object { $_ -clike '*archive/README*' }).Count) 'a default run read the archive index'
    Assert-Equal '0' ([string]@($store.Calls | Where-Object { $_ -clike '*archive/dup*' }).Count) 'a default run read an archived Book'
    Assert-True (-not (Test-Path -LiteralPath (Get-ArchiveRosterPath))) 'a default run wrote an archive roster, which would claim coverage it never checked'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'internal/book-manifests/shared-archive/ghost')) 'a default run pruned an archive store it never had evidence about'
    Assert-Equal 'missing' (Get-ArchiveStatus 'dup') 'a default run generated an archived Book'
    # And the active twin IS generated, from its own pages.
    Assert-Equal 'ok' (Get-SharedStatus 'dup') "the active twin's store"
}

Test-Case 'Discovery says NOT COVERED while the archive has no roster' {
    $result = Invoke-Discovery $dupTerm
    Assert-Equal 'False' ([string]$result.shared_archive_covered) 'the archive read as covered with no roster'
    Assert-True ([string]$result.archive_note -clike '*NOT covered*') "the archive sentence did not name the gap: $($result.archive_note)"
    # The repair it names must be one that can be followed -- the dead-end-hint rule.
    Assert-True ([string]$result.archive_note -clike '*-IncludeArchive*') "the archive sentence named no runnable repair: $($result.archive_note)"
    Assert-Equal '0' ([string]$result.shared_archive_books_total) 'an uncovered archive reported Books'
}

Test-Case 'the -IncludeArchive preflight plans both halves, by root, and reads no page body' {
    $store.Calls.Clear()
    $pre = Invoke-Preflight @('-IncludeArchive')
    Assert-Equal 'True' ([string]$pre.Plan.archive_in_scope) 'archive_in_scope on an -IncludeArchive preflight'
    # alpha, hold, gamma, dup active; plus dup archived and retired.
    Assert-Equal '6' ([string]$pre.Plan.books_total) 'the preflight Book count with the archive in scope'
    Assert-Equal '2' ([string]$pre.Plan.archive_books_total) 'the preflight archived-Book count'
    $reads = @($store.Calls | Where-Object { $_ -clike 'read_note:*' })
    Assert-Equal '2' ([string]$reads.Count) "the preflight read $($reads.Count) note(s); it may read only the two indexes"
    Assert-True ($reads -ccontains 'read_note:archive/README.md') 'the preflight never read the archive index'
    $serialized = $pre.Plan | ConvertTo-Json -Depth 10
    Assert-True ($serialized.IndexOf('guide/legacy', [StringComparison]::Ordinal) -lt 0) 'an archived page path reached the preflight'
    Assert-True ($serialized.IndexOf('Legacy Only', [StringComparison]::Ordinal) -lt 0) 'an archived page title reached the preflight'
    # The two `dup` rows must be distinguishable, or a reader cannot see which Book they approved.
    $dupRows = Get-BookResult $pre.Plan 'dup'
    Assert-Equal '2' ([string]$dupRows.Count) 'the two Books named dup did not both reach the plan'
    $roots = @($dupRows | ForEach-Object { [string]$_.book_root })
    Assert-True ($roots -ccontains 'books/dup' -and $roots -ccontains 'archive/dup') "the plan did not name both dup roots: $($roots -join ', ')"
    Assert-Equal '3' ([string](Get-RootResult $pre.Plan 'archive/dup')[0].page_count) "the archived dup's page count came from the wrong Book"
    Assert-Equal '2' ([string](Get-RootResult $pre.Plan 'books/dup')[0].page_count) "the active dup's page count"
}

Test-Case 'an approved -IncludeArchive run commits every archived Book' {
    Reset-Stub
    Reset-Fixture
    Add-ArchiveFixture
    $run = Approve-And-Run @('-IncludeArchive')
    Assert-Equal '0' ([string]$run.ExitCode) "the -IncludeArchive run failed: $($run.Lines -join ' | ')"
    Assert-Equal 'complete' ([string]$run.Plan.status) 'the -IncludeArchive run status'
    foreach ($slug in @('dup', 'retired')) { Assert-Equal 'ok' (Get-ArchiveStatus $slug) "the archive store for $slug" }
    Assert-Equal '2' ([string]$run.Plan.archive_books_total) 'the run''s archived-Book count'
}

# SEPARATE FROM THE RUN'S OWN OUTCOME, DELIBERATELY. A helper that composes books/<slug>/wiki
# CONSISTENTLY commits a well-formed manifest full of the wrong Book's pages, and if this shared a
# case with the exit-code assertion above, the message would be "the run failed" -- naming the Book
# that had no active twin to steal from rather than the one whose manifest is now a lie. Reading only
# the stores makes the wrong VALUE the thing that speaks.
Test-Case 'the archived store holds the ARCHIVED Book''s pages, never its active twin''s' {
    $archived = Get-ArchiveManifest 'dup'
    $active = Get-SharedManifest 'dup'
    # THE DECOY: both stores exist and both hold a well-formed manifest. What separates correct from
    # composed-path is WHOSE pages are in which store.
    Assert-Equal 'Dup, the archived twin' ([string]$archived.title) "the archive store's title came from the wrong catalog"
    Assert-Equal 'Dup, the active twin' ([string]$active.title) "the active store's title"
    Assert-Equal '3' ([string]$archived.page_count) "the archive store's page count -- 2 means it read the ACTIVE twin"
    Assert-Equal '2' ([string]$active.page_count) "the active store's page count"
    $archivedPages = @($archived.pages | ForEach-Object { [string]$_.path })
    Assert-True ($archivedPages -ccontains 'guide/legacy') "the archive store is missing the archived Book's own page: $($archivedPages -join ', ')"
    Assert-True ($archivedPages -cnotcontains 'guide/active') 'the archive store holds the ACTIVE twin''s page, so it was generated off books/dup'
    $activePages = @($active.pages | ForEach-Object { [string]$_.path })
    Assert-True ($activePages -ccontains 'guide/active') 'the active store lost its own page'
    Assert-True ($activePages -cnotcontains 'guide/legacy') 'the active store holds the ARCHIVED Book''s page'
    # The headings are the second, independent witness: each copy carries one the other does not.
    $archivedHeadings = @($archived.pages | ForEach-Object { $_.headings } | ForEach-Object { [string]$_.text })
    Assert-True (@($archivedHeadings | Where-Object { $_ -clike '*ARCHIVED twin*' }).Count -eq 1) "the archive store carries no ARCHIVED heading: $($archivedHeadings -join ' | ')"
    Assert-True (@($archivedHeadings | Where-Object { $_ -clike '*ACTIVE twin*' }).Count -eq 0) 'the archive store carries the ACTIVE twin''s heading'
    # And the reader map, whose links are written as full ARCHIVE note paths: reducing them needs the
    # archive prefix, so a link left unreduced is a third witness to a composed books/ prefix.
    Assert-True ($null -ne $archived.reader_map) "the archived Book's reader map was not captured"
    $mapTargets = @($archived.reader_map.links | ForEach-Object { [string]$_.target })
    Assert-True ($mapTargets -ccontains 'guide/legacy') "an archived reader-map link was not reduced to a canonical page path: $($mapTargets -join ', ')"
    # An archived Book carries no summary: the archive index writes a date where the active catalog
    # writes a description. The trailer is not silently promoted into one.
    Assert-Equal '' ([string]$archived.summary) 'an archived date was stored as the Book''s summary'
    Assert-True (([string]$active.summary) -clike "*$dupTerm slug*") "the active twin's summary came from the catalog"
}

Test-Case 'the archive roster names every archived Book, even under -Book' {
    $roster = [IO.File]::ReadAllText((Get-ArchiveRosterPath)) | ConvertFrom-Json
    $slugs = @($roster.books | ForEach-Object { [string]$_.slug })
    Assert-Equal '2' ([string]$slugs.Count) 'the archive roster Book count'
    foreach ($slug in @('dup', 'retired')) { Assert-True ($slugs -ccontains $slug) "the archive roster omits $slug" }

    Reset-Stub
    Reset-Fixture
    Add-ArchiveFixture
    # A slug that names ONLY an archived Book is a legitimate -Book scope, and the roster it writes
    # must still be whole -- a partial roster makes the other archived Books invisible rather than
    # unavailable, which is the failure the roster exists for.
    $scoped = Approve-And-Run @('-IncludeArchive', '-Book', 'retired')
    Assert-Equal '0' ([string]$scoped.ExitCode) "a -Book run naming only an archived Book failed: $($scoped.Lines -join ' | ')"
    Assert-Equal 'ok' (Get-ArchiveStatus 'retired') "the archive store for the scoped Book"
    Assert-Equal 'missing' (Get-ArchiveStatus 'dup') 'a scoped run generated an out-of-scope archived Book'
    $scopedRoster = [IO.File]::ReadAllText((Get-ArchiveRosterPath)) | ConvertFrom-Json
    Assert-Equal '2' ([string]@($scopedRoster.books).Count) 'a scoped run wrote a partial archive roster'
}

Test-Case 'Discovery covers the archive, labels it, and counts it' {
    Reset-Stub
    Reset-Fixture
    Add-ArchiveFixture
    Approve-And-Run @('-IncludeArchive') | Out-Null
    $result = Invoke-Discovery $dupTerm

    Assert-Equal 'True' ([string]$result.shared_archive_covered) 'the archive read as uncovered after its roster was written'
    Assert-Equal '2' ([string]$result.shared_archive_books_total) 'the archive Book total'
    # THE COVERAGE COUNT, which is the assertion the original defect fails: it moved in lockstep with
    # the omission, so the answer went on reading complete.
    Assert-Equal '2' ([string]$result.shared_archive_books_searched) 'the archive searched count'
    Assert-True ([string]$result.archive_note -clike '*shared archive: all 2 Book(s) searched*') "the archive coverage sentence is wrong: $($result.archive_note)"
    Assert-True ([string]$result.archive_note -cnotlike '*NOT covered*') 'the archive still reported itself uncovered'
    Assert-True ([string]$result.shared_archive_roster_as_of -clike '20*') 'the archive roster date is missing from the answer'

    # THE HIT ITSELF, AND WHOSE CONTENT IT CARRIES. Both dup Books match, so the two hits must be
    # told apart by root and by shelf -- and the archived one must carry the ARCHIVED heading. A
    # composed books/ prefix produces a hit at archive/dup whose heading is the ACTIVE twin's.
    $archiveHits = @($result.results | Where-Object { [string]$_.book_root -ceq 'archive/dup' })
    Assert-True ($archiveHits.Count -gt 0) 'the archived Book contributed no hit'
    foreach ($hit in $archiveHits) {
        Assert-Equal 'archive' ([string]$hit.book_shelf) 'an archived hit was not labelled archived'
        Assert-Equal 'shared' ([string]$hit.collection) 'an archived shared hit named the wrong collection'
        Assert-True ([string]$hit.heading -cnotlike '*ACTIVE twin*') "an archive/dup hit carries the ACTIVE twin's heading: $($hit.heading)"
    }
    Assert-True (@($archiveHits | Where-Object { [string]$_.heading -clike '*ARCHIVED twin*' }).Count -eq 1) "no archive/dup hit carries the archived Book's own heading: $(@($archiveHits | ForEach-Object { $_.heading }) -join ' | ')"
    # The page only the archived copy has, reached as a page-level hit.
    Assert-True (@($archiveHits | Where-Object { [string]$_.page -ceq 'guide/legacy' }).Count -eq 1) 'the archived Book''s own page produced no hit'
    # And the active twin is still its own Book, at its own root.
    $activeHits = @($result.results | Where-Object { [string]$_.book_root -ceq 'books/dup' })
    Assert-True ($activeHits.Count -gt 0) 'the active twin contributed no hit'
    Assert-Equal 'active' ([string]$activeHits[0].book_shelf) 'the active twin was labelled archived'
    Assert-True (@($activeHits | Where-Object { [string]$_.page -ceq 'guide/active' }).Count -eq 1) 'the active twin''s own page produced no hit'
}

Test-Case 'the journal records both Books named dup, keyed on the root' {
    # A SLUG KEY LOSES ONE OF THEM. The journal is the progress record a resume reasons from, and
    # Set-ManifestJournalEntry writes one property per key -- so under a slug key the archived Book's
    # commit overwrites the active one's and the file ends up holding ONE entry named `dup`, carrying
    # the archived Book's digest while claiming to be the record of both. That is a wrong value, not
    # a missing file, which is why the digests are compared against the stores rather than merely
    # counted. The same argument the Shelf half's journal comment makes, arriving one collection over.
    $journals = @(Get-ChildItem -LiteralPath (Join-Path $fixture 'internal/manifest-journals') -File -Filter 'shared-*.json')
    Assert-Equal '1' ([string]$journals.Count) "the -IncludeArchive run wrote $($journals.Count) journal(s)"
    Assert-True ($journals[0].Name -clike '*backfill+archive*') "the journal does not name the archive mode: $($journals[0].Name)"
    $journal = [IO.File]::ReadAllText($journals[0].FullName) | ConvertFrom-Json
    $keys = @($journal.entries.PSObject.Properties | ForEach-Object { $_.Name })
    Assert-True ($keys -ccontains 'books/dup') "the journal has no entry for the active twin: $($keys -join ', ')"
    Assert-True ($keys -ccontains 'archive/dup') "the journal has no entry for the archived Book: $($keys -join ', ')"
    Assert-True ($keys -cnotcontains 'dup') 'the journal keyed an entry on a bare slug, so one dup Book''s progress overwrote the other''s'
    # THE DECOY: each entry's digest must be its OWN Book's. A slug-keyed journal that happened to
    # keep both names would still be caught here if it recorded the wrong Book's digest.
    Assert-Equal ([string](Get-StoredBookManifest -Workspace $fixture -Slug 'dup' -Collection 'shared').source_digest) `
                 ([string]$journal.entries.'books/dup'.source_digest) 'the active twin''s journal digest'
    Assert-Equal ([string](Get-StoredBookManifest -Workspace $fixture -Slug 'dup' -Collection 'shared-archive').source_digest) `
                 ([string]$journal.entries.'archive/dup'.source_digest) 'the archived Book''s journal digest'
    Assert-True (([string]$journal.entries.'books/dup'.source_digest) -cne ([string]$journal.entries.'archive/dup'.source_digest)) `
                'the two dup Books recorded one digest, so the journal cannot tell them apart'
}

Test-Case 'the archive prune reads the ARCHIVED Book''s own page as its second signal' {
    Reset-Stub
    Reset-Fixture
    Add-ArchiveFixture
    # An archive store for a slug absent from the archive index, whose ACTIVE twin's page is present
    # in the collection and whose ARCHIVED page is not. Correct code asks archive/twin/wiki/_book.md,
    # finds nothing, and prunes. Asking books/twin/wiki/_book.md finds a page -- about a different
    # Book -- and keeps the orphan forever on evidence that was never about it.
    Write-Fixture 'internal/book-manifests/shared-archive/twin/current.json' '{ "schema": 1, "slug": "twin", "generation": 1, "committed_utc": "2026-09-08T00:00:00Z", "manifest_sha256": "x", "source_digest": "y" }'
    Set-Note 'books/twin/wiki/_book.md' "# Twin, active only`n"
    # And the converse, so the two-signal rule is proved in both directions: an archived Book that
    # EXISTS in the collection but is missing from the index is a catalog problem, and its store is
    # kept and reported rather than deleted.
    Write-Fixture 'internal/book-manifests/shared-archive/unlisted/current.json' '{ "schema": 1, "slug": "unlisted", "generation": 1, "committed_utc": "2026-09-08T00:00:00Z", "manifest_sha256": "x", "source_digest": "y" }'
    Set-Note 'archive/unlisted/wiki/_book.md' "# Unlisted, archived`n"

    $run = Approve-And-Run @('-IncludeArchive')
    Assert-Equal '0' ([string]$run.ExitCode) "the prune run failed: $($run.Lines -join ' | ')"
    Assert-True (@($run.Plan.pruned) -ccontains 'archive/twin') "the orphaned archive store was not pruned: $(@($run.Plan.pruned) -join ', ')"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'internal/book-manifests/shared-archive/twin'))) 'the orphaned archive store directory survived'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'internal/book-manifests/shared-archive/unlisted')) 'an archive store whose Book still exists was deleted on one signal'
    Assert-True (@($run.Plan.stores_kept_unresolved | ForEach-Object { [string]$_.book_root }) -ccontains 'archive/unlisted') 'the kept archive store was not reported as unresolved'
    # The active half's store for `dup` is not an orphan and must not be touched by the archive sweep.
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'internal/book-manifests/shared/dup')) 'the archive sweep removed the active twin''s store'
}

Test-Case 'an unreadable archive index is fatal to -IncludeArchive and writes no archive roster' {
    Reset-Stub
    Reset-Fixture
    Add-ArchiveFixture
    [void]$store.Faults.ReadFail.Add('archive/README.md')
    $pre = Invoke-Backfill @('-Preflight', '-Json', '-IncludeArchive', '-WorkspacePath', $fixture, '-McpUrl', $mcpUrl)
    Assert-True ($pre.ExitCode -ne 0) 'an unreadable archive index was planned around'
    Assert-True ((($pre.Lines -join ' ') -clike '*archive/README.md*')) "the refusal did not name the archive index: $($pre.Lines -join ' | ')"
    Assert-True (-not (Test-Path -LiteralPath (Get-ArchiveRosterPath))) 'an empty archive roster was written from a failed read, which would report the archive as holding no Books'
    # The failure lands before any store is touched, so nothing was generated either.
    Assert-Equal 'missing' (Get-ArchiveStatus 'dup') 'a run with an unreadable archive index generated an archived Book'
    Assert-Equal 'missing' (Get-SharedStatus 'alpha') 'a run refused for the archive index still generated an active Book'
}

}
finally {
    $store.Running = $false
    try { $listener.Stop() } catch { }
    try { $listener.Close() } catch { }
    try { [void]$server.EndInvoke($serverHandle) } catch { }
    try { $server.Dispose() } catch { }
    try { $runspace.Close(); $runspace.Dispose() } catch { }
    if ($KeepFixture) { Write-Host "Fixture kept at $fixture" }
    else { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($script:failed.Count) {
    [Console]::Error.WriteLine("Test-SharedManifestBackfill FAILED ($($script:failed.Count) of $($script:passed + $script:failed.Count)):")
    foreach ($failure in $script:failed) { [Console]::Error.WriteLine("  - $failure") }
    exit 1
}
Write-Host "Test-SharedManifestBackfill passed ($($script:passed) cases)."
exit 0
