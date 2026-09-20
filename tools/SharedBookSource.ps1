<#
.SYNOPSIS
    Read the shared collection's Book Catalog, page lists, and page bodies over MCP, exactly enough
    to build a Discovery manifest. Dot-sourced; never invoked directly.

.DESCRIPTION
    Plan item 2.2, seventh rung. The five rungs below Discovery all assume a Book on the local
    filesystem: New-BookManifest calls Get-ShelfBook, parses shelf/_catalog.md, and walks
    shelf/<slug>/wiki. The shared collection has none of that. Its catalog is books/README, its
    pages arrive over Basic Memory MCP, and there is no directory to enumerate. This file is the
    page-enumeration primitive that stands in for the filesystem, and nothing else.

    IT IS THE ONE PIECE THAT COULD NOT BE DESIGNED AROUND. Everything above it -- the manifest
    schema, the caps from item 2.5, the capture exclusion, the digest -- is shared with the Shelf
    through New-BookManifestFromPages, because Discovery reads both collections through one code
    path and a second manifest builder would be a second thing to keep identical.

    IT FAILS CLOSED IN FOUR PLACES, BECAUSE A PARTIAL READ IS THE FAILURE THAT LOOKS LIKE SUCCESS.
    A listing that does not contain the Book's own _book.md is refused rather than treated as a
    short Book -- a truncated or filtered listing would otherwise commit a manifest describing a
    fraction of the Book, and no status could tell that from a small Book. A read whose returned
    file_path differs from the requested one is refused with its content withheld, the same rule the
    validated reader adapter applies. An empty body is refused. And a Book whose catalog entry is
    absent is never generated: an absent entry is the state in which we know least.

    THE CAPTURE UNION RULE STILL FAILS CLOSED, WITH A DIFFERENT SECOND SIGNAL. On the Shelf the two
    signals are the catalog entry and the Book's own _book.md. The shared catalog carries no Kind
    field at all, so the Book's _book.md is the only signal there is -- which means it must be read
    successfully or the Book fails. An unreadable _book.md is never treated as "not capture".

    IT AUTHORIZES NOTHING. Reading a closed shared Book's body crosses the Desk boundary. The caller
    -- Update-SharedBookManifests.ps1 -- owes the preflight, the plan_id, and the reader's explicit
    approval before any function here that reads a page is called.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'BookManifest.ps1')
. (Join-Path $PSScriptRoot 'McpDirectoryListing.ps1')
# THE BOOK-ROOT SCHEMA, because this file turns a Book identity into the directory its pages are
# fetched from, and the archive's `archive/<slug>` shape is the one a caller would guess wrong.
# Composing `books/$slug/wiki` here is what would read an ACTIVE Book for an archived one -- the
# same defect the reader adapter is statically scanned for, and this file is now scanned with it.
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')
$script:SharedBookCatalogPath = 'books/README.md'
# The two index paths, each built from the schema's own prefix for that half of the collection
# rather than written out: 'archive' is the archive's root prefix because BookRootSchema says so.
$script:SharedArchiveRootPrefix = (Split-BookManifestCollection 'shared-archive').root_prefix
$script:SharedArchiveCatalogPath = "$script:SharedArchiveRootPrefix/README.md"

# --- MCP transport --------------------------------------------------------------------------------
#
# The same client Archive-SharedBook.ps1 and Edit-ProjectHub.ps1 have used against the real NAS since
# the pilot: ASCII-escaped JSON over HTTP, an SSE or plain-JSON response, a session id from the
# initialize call. Copied rather than shared because those helpers each own their own copy already
# and unifying them is not this rung's change to make.

function ConvertTo-SharedAsciiJson($Value) {
    $json = $Value | ConvertTo-Json -Compress -Depth 32
    [regex]::Replace($json, '[^\x00-\x7f]', { param($match) '\u{0:x4}' -f [int][char]$match.Value })
}

function Get-SharedRpcError($Response) {
    $property = $Response.PSObject.Properties['error']
    if ($null -eq $property) { return $null }
    $property.Value
}

# --- Session recovery -----------------------------------------------------------------------------
# The MCP transport forgets its session when the server restarts or the session expires, and then
# answers every later request with "Session not found". The cached id is permanently wrong from that
# point, so a caller holding one session across several reads fails for the rest of its run while the
# NAS is healthy and answering a fresh initialize on the first try.
#
# The session here belongs to the caller's object rather than to script scope, so recovery clears and
# re-establishes THAT object. It retries only on that one message, only when an id was actually
# cached, and never for `initialize` itself, so an unreachable NAS still fails on the first attempt
# and the retry cannot recurse.
#
# WHY ONE OPERATION FAMILY IS EXCLUDED. "Session not found" is emitted by the MCP transport layer
# (mcp 2.0.0 / fastmcp 4.0.0b1), NOT by Basic Memory -- the string appears nowhere in its source.
# That places the rejection before tool dispatch, which would make a retry safe for every operation.
# That is an inference from where the string is absent, not a verified reading of the code that emits
# it, so the one family that would fail SILENTLY if the inference is wrong is excluded rather than
# trusted: append, prepend and the insert_* edits are not idempotent and a second application
# duplicates content with no error. write_note is permalink-keyed, replace_section is idempotent, and
# find_replace self-guards through expected_replacements, so those stay retryable.
# See the Basic-Memory MCP Book, page basic-memory/write-semantics-and-retry-safety.
function Test-McpRetryIsSafe([string]$Method, $Params) {
    if ($Method -cne 'tools/call' -or $null -eq $Params) { return $true }
    if ([string]$Params['name'] -cne 'edit_note') { return $true }
    $arguments = $Params['arguments']
    if ($null -eq $arguments) { return $true }
    # -cin, not -in: these operation names are lowercase by the tool's own contract, and the
    # case-insensitive default would let 'Append' past the exclusion it is here to enforce.
    -not ([string]$arguments['operation'] -cin @('append', 'prepend', 'insert_before_section', 'insert_after_section'))
}

function Invoke-SharedMcp($Session, [string]$Method, [hashtable]$Params, [switch]$Notification) {
    try { return (Invoke-SharedMcpOnce -Session $Session -Method $Method -Params $Params -Notification:$Notification) }
    catch {
        if ($Method -ceq 'initialize' -or $null -eq $Session -or -not $Session.session_id) { throw }
        if ($_.Exception.Message -notmatch 'Session not found') { throw }
        if (-not (Test-McpRetryIsSafe -Method $Method -Params $Params)) { throw }
        $Session.session_id = $null
        Initialize-SharedMcpSession -Session $Session
        return (Invoke-SharedMcpOnce -Session $Session -Method $Method -Params $Params -Notification:$Notification)
    }
}

# Both calls go to the non-retrying primitive on purpose: this function IS what the retry calls, so
# routing its own two requests back through the wrapper would let a handshake that keeps failing
# re-enter here without bound. Establishing a session must fail on the first attempt.
function Initialize-SharedMcpSession($Session) {
    $init = Invoke-SharedMcpOnce -Session $Session -Method 'initialize' -Params @{ protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'library-shared-manifests'; version = '1.0.0' } }
    $rpcError = Get-SharedRpcError $init
    if ($null -ne $rpcError) { throw "MCP initialization was rejected: $($rpcError.message)" }
    Invoke-SharedMcpOnce -Session $Session -Method 'notifications/initialized' -Params @{} -Notification
}

function Invoke-SharedMcpOnce($Session, [string]$Method, [hashtable]$Params, [switch]$Notification) {
    $id = $null
    if (-not $Notification) { $id = $Session.request; $Session.request++ }
    $payload = [ordered]@{ jsonrpc = '2.0'; method = $Method }
    if ($null -ne $id) { $payload.id = $id }
    if ($null -ne $Params) { $payload.params = $Params }

    $client = [Net.Http.HttpClient]::new()
    try {
        $client.Timeout = [TimeSpan]::FromSeconds($Session.timeout_seconds)
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $Session.url)
        [void]$request.Headers.TryAddWithoutValidation('Accept', 'application/json, text/event-stream')
        [void]$request.Headers.TryAddWithoutValidation('MCP-Protocol-Version', '2025-03-26')
        if ($Session.session_id) { [void]$request.Headers.TryAddWithoutValidation('Mcp-Session-Id', $Session.session_id) }
        $request.Content = [Net.Http.ByteArrayContent]::new([Text.Encoding]::ASCII.GetBytes((ConvertTo-SharedAsciiJson $payload)))
        $request.Content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/json; charset=utf-8')
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw "HTTP $([int]$response.StatusCode): $($body.Substring(0, [Math]::Min($body.Length, 2048)))" }
    }
    catch { throw "MCP $Method failed: $($_.Exception.Message)" }
    finally { $client.Dispose() }

    if ($Method -eq 'initialize') {
        $values = [Collections.Generic.IEnumerable[string]]$null
        if (-not $response.Headers.TryGetValues('Mcp-Session-Id', [ref]$values)) { throw 'The shared Library did not establish an MCP session.' }
        $Session.session_id = @($values)[0]
    }
    if ($Notification) { return }
    if ($body.Trim().StartsWith('{')) { return ($body | ConvertFrom-Json) }
    $events = @($body -split "`r?`n" | Where-Object { $_ -like 'data:*' } | ForEach-Object { $_.Substring(5).Trim() } | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
    # An id-less notifications/message log frame has no .id to read, and reading it throws under
    # StrictMode. Enumerate the property names before comparing -- and enumerate rather than reading
    # the aggregate .Name, which throws in turn on a property-less {} frame (defect family 4).
    # Held by mcp.transports-guard-idless-events.
    $result = @($events | Where-Object { @($_.PSObject.Properties | ForEach-Object { $_.Name }) -contains 'id' -and $_.id -eq $id } | Select-Object -Last 1)
    if ($result.Count -ne 1) { throw "MCP response for request $id was incomplete." }
    $result[0]
}

function New-SharedBookSession {
    <#
    .SYNOPSIS
        Open one MCP session against the shared collection. Reads nothing on its own.
    #>
    [CmdletBinding()]
    param(
        [string]$McpUrl,
        [string]$ProjectId,
        [int]$TimeoutSeconds = 60
    )

    $McpUrl = Resolve-LibraryMcpUrl -McpUrl $McpUrl
    $ProjectId = Resolve-LibraryCollectionId -CollectionId $ProjectId

    $session = [pscustomobject]@{
        url             = $McpUrl
        project_id      = $ProjectId
        session_id      = $null
        request         = 1
        timeout_seconds = $TimeoutSeconds
    }
    Initialize-SharedMcpSession -Session $session

    $session
}

# --- Exact reads ----------------------------------------------------------------------------------

function Read-SharedNoteExact($Session, [string]$Path) {
    <#
    .SYNOPSIS
        Read one shared note by its exact file path, or throw. Never returns a substituted record.
    #>
    $response = Invoke-SharedMcp $Session 'tools/call' @{ name = 'read_note'; arguments = @{ project_id = $Session.project_id; identifier = $Path.Substring(0, $Path.Length - 3); output_format = 'json'; include_frontmatter = $false } }
    $rpcError = Get-SharedRpcError $response
    if ($null -ne $rpcError) { throw "Read '$Path' failed: $($rpcError.message)" }
    if ($response.result.isError) { throw "Read '$Path' was rejected by the shared Library." }

    $record = $response.result.structuredContent.result
    if ($null -eq $record -or -not @($record.PSObject.Properties | ForEach-Object { $_.Name }).Count) {
        # Older servers answer in the text block only. Same record, different envelope.
        $textBlock = @($response.result.content | Where-Object { $_.type -eq 'text' })
        if ($textBlock.Count -ne 1) { throw "Read '$Path' returned an unreadable response." }
        try { $record = $textBlock[0].text | ConvertFrom-Json } catch { throw "Read '$Path' returned an unreadable response." }
    }
    # The rule the validated reader adapter applies to every page it serves, applied here for the
    # same reason: a record for a different path is withheld rather than used. A manifest built from
    # a substituted read would describe one Book under another Book's name.
    if ([string]$record.file_path -cne $Path) { throw "Read '$Path' returned '$([string]$record.file_path)'; its content was withheld." }
    if ([string]::IsNullOrWhiteSpace([string]$record.content)) { throw "Shared page '$Path' has no readable content." }
    $record
}

function Get-SharedBookPagePaths($Session, [string]$BookRoot) {
    <#
    .SYNOPSIS
        Every wiki page path of one shared Book, active or archived, from a directory listing. Reads
        no page body.

    .DESCRIPTION
        The stand-in for Get-BookPageFiles. It is also the preflight's page count, which is why it
        must not read bodies: a count is not a disclosure, and the Desk overview already reports
        counts, but a page title is exactly what ADR-0002 keeps out of a closed-readable place.

        IT TAKES A BOOK ROOT, NOT A SLUG, AND ASKS THE SCHEMA WHERE THE PAGES ARE. `books/x` and
        `archive/x` are two different Books that share a name, so a slug does not identify a Book
        and a composed `books/<slug>/wiki` would read the ACTIVE twin for an archived Book -- a
        manifest full of plausible content, under the archived Book's name, with nothing failing.
        Split-BookRoot's `wiki_root` is the single answer to where a Book's pages are.

        THE PAGING AND THE COMPLETENESS PROOF LIVE IN McpDirectoryListing.ps1, shared with
        Archive-ProjectHub.ps1, which had the identical unpaged defect against the identical
        endpoint. Two copies of a completeness rule is two things to keep true.

        The _book guard is kept, but it is no longer what proves the listing complete -- it never
        could, because _book.md sorts into the first page. It now catches a listing for the wrong
        directory.
    #>
    $parts = Split-BookRoot $BookRoot
    if ($parts.collection -cne 'shared') {
        throw "Book root '$BookRoot' is not in the shared collection, so its pages do not arrive over MCP."
    }
    $directory = $parts.wiki_root
    $paths = Read-McpDirectoryListing -Directory $directory -RequiredPath "$directory/_book.md" -RequestPage {
        param($Page, $PageSize)
        Invoke-SharedMcp $Session 'tools/call' @{ name = 'list_directory'; arguments = @{ project_id = $Session.project_id; dir_name = $directory; depth = 10; page = $Page; page_size = $PageSize; output_format = 'json' } }
    }
    if (@($paths).Count -gt $script:ManifestMaxPagesPerBook) {
        throw "Shared Book '$BookRoot' holds $(@($paths).Count) pages, above the manifest cap of $($script:ManifestMaxPagesPerBook)."
    }
    @($paths)
}

# --- The catalog ----------------------------------------------------------------------------------

function ConvertTo-SharedCatalogEntries {
    <#
    .SYNOPSIS
        Parse one shared collection index -- books/README or archive/README -- into slug, title, and
        the text that follows the link. Pure text; no MCP.

    .DESCRIPTION
        ONE PARSER FOR BOTH INDEXES, because there is one entry grammar: Archive-SharedBook.ps1
        writes an archive entry in the same `- [[<prefix>/<slug>/wiki/_book|Title]]` shape the active
        catalog uses. The Shelf half of ADR-0012 split ConvertFrom-ShelfCatalogEntry out rather than
        copy it, for the reason that applies here too -- a second copy of an entry grammar would
        show up as an archived Book whose title or metadata disagreed with its active self.

        WHAT FOLLOWS THE LINK IS NOT THE SAME FACT IN BOTH. The active catalog writes a summary
        there; the archive writes `Archived 2026-09-03`, a date. So the trailer is returned as its
        own field, and -TrailerIsSummary decides AT THE CALL SITE whether it is a summary -- rather
        than every consumer of an entry having to remember which index it came from. An archived
        Book therefore carries no summary, because archiving removed the only place one was written.
    #>
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$CatalogText,
        # The Book-root prefix of the half being parsed. Passed in from the schema by the two
        # callers below, never spelled here: this function must not be a second place that knows
        # where the archive lives.
        [string]$RootPrefix = 'books',
        [switch]$TrailerIsSummary
    )
    $entries = [Collections.Generic.List[object]]::new()
    $seen = @{}
    $pattern = '^\s*-\s*\[\[' + [regex]::Escape($RootPrefix) + '/([a-z0-9][a-z0-9-]*)/wiki/_book\|([^\]]*)\]\](.*)$'
    foreach ($line in @($CatalogText.Replace("`r`n", "`n").Split("`n"))) {
        $match = [regex]::Match($line, $pattern)
        if (-not $match.Success) { continue }
        $slug = $match.Groups[1].Value
        if ($seen.ContainsKey($slug)) { continue }
        $seen[$slug] = $true
        $trailer = $match.Groups[3].Value.Trim()
        # Both indexes write "]] -- <trailer>"; the dash is punctuation, not content.
        $trailer = [regex]::Replace($trailer, '^[\s' + [char]0x2014 + [char]0x2013 + '\-]+', '')
        [void]$entries.Add([pscustomobject]@{
                slug    = $slug
                title   = $match.Groups[2].Value.Trim()
                trailer = $trailer
                summary = if ($TrailerIsSummary) { $trailer } else { '' }
            })
    }
    @($entries)
}

function Get-SharedBookCatalog($Session) {
    <#
    .SYNOPSIS
        The shared Book Catalog's entries, in catalog order. Reads books/README and nothing else.
    #>
    $record = Read-SharedNoteExact $Session $script:SharedBookCatalogPath
    $entries = @(ConvertTo-SharedCatalogEntries -CatalogText ([string]$record.content) -TrailerIsSummary)
    if (-not $entries.Count) { throw 'The shared Book Catalog lists no Books; nothing was generated.' }
    $entries
}

function Get-SharedArchiveCatalog($Session) {
    <#
    .SYNOPSIS
        The shared ARCHIVE's entries, in catalog order. Reads archive/README and nothing else.

    .DESCRIPTION
        AN UNREADABLE ARCHIVE INDEX IS FATAL, NOT AN EMPTY ARCHIVE. ADR-0012 already records why the
        two archives differ here: the Shelf archive is a local directory, so its absence really is
        evidence that nothing is archived, and Get-ArchivedShelfBookSlugs may return an empty list.
        This one is behind MCP, where a read that did not happen is not evidence of anything. An
        empty roster written on a failed read would make Discovery say "the shared archive holds no
        Books" -- a confident, complete-sounding answer about material it never asked about, which is
        the one failure this whole tier exists to prevent.

        An index that reads cleanly and lists nothing IS an empty archive, and returns no entries.
    #>
    $record = $null
    try { $record = Read-SharedNoteExact $Session $script:SharedArchiveCatalogPath }
    catch {
        throw ("The shared collection's archive index ($script:SharedArchiveCatalogPath) could not be read, " +
               "so which Books are archived is unknown and no archive roster was written: $($_.Exception.Message)")
    }
    @(ConvertTo-SharedCatalogEntries -CatalogText ([string]$record.content) -RootPrefix $script:SharedArchiveRootPrefix)
}

# --- Generation -----------------------------------------------------------------------------------

function Get-SharedBookMetadata([string]$BookPageText) {
    <#
    .SYNOPSIS
        The Kind and Topics a shared Book declares on its own _book page.
    #>
    $isCapture = [regex]::IsMatch($BookPageText, '(?m)^\s*-\s+\*\*Kind:\*\*\s+capture\s*$')
    $topics = @()
    $match = [regex]::Match($BookPageText, '(?m)^\s*-\s+\*\*Topics:\*\*\s+(.+?)\s*$')
    if ($match.Success) {
        $topics = @($match.Groups[1].Value.Split(',') | ForEach-Object { ConvertTo-ManifestText $_ } | Where-Object { $_ })
    }
    [pscustomobject]@{ is_capture = $isCapture; topics = $topics }
}

function New-SharedBookManifest {
    <#
    .SYNOPSIS
        Build one shared Book's manifest by reading its pages over MCP. Writes nothing.

    .DESCRIPTION
        READS CLOSED BOOK BODIES. The caller owes the reader's explicit approval before this is
        called; nothing here checks for it, exactly as New-BookManifest does not.

        The manifest itself is built by New-BookManifestFromPages -- the same function, the same
        schema, the same caps, the same capture exclusion -- so a shared manifest and a Shelf
        manifest cannot drift apart.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Session,
        [Parameter(Mandatory = $true)][object]$Entry,
        # The Book this manifest is about, as a Desk root. Mandatory and separate from $Entry
        # because a slug does not identify a Book once the archive exists, and the page prefix is
        # the schema's answer rather than a string built here.
        [Parameter(Mandatory = $true)][string]$BookRoot,
        [object[]]$PagePaths = $null
    )

    $parts = Split-BookRoot $BookRoot
    $slug = $parts.slug
    # The entry and the root must agree about which Book this is. A mismatch is a caller defect
    # whose only symptom would be one Book's pages stored under another Book's name, so it is a
    # refusal rather than a preference for one of the two.
    if (-not [string]::IsNullOrWhiteSpace([string]$Entry.slug) -and ([string]$Entry.slug -cne $slug)) {
        throw "Catalog entry '$([string]$Entry.slug)' was passed with Book root '$BookRoot'; no manifest was generated."
    }
    $prefix = $parts.wiki_root + '/'
    if ($null -eq $PagePaths) { $PagePaths = @(Get-SharedBookPagePaths $Session $BookRoot) }

    $pages = [Collections.Generic.List[object]]::new()
    $bookPageText = $null
    foreach ($path in @($PagePaths)) {
        $record = Read-SharedNoteExact $Session $path
        $text = [string]$record.content
        if ($path -ceq ($prefix + '_book.md')) { $bookPageText = $text }
        [void]$pages.Add([pscustomobject]@{
                # Canonical: below wiki/, no extension, forward slashes -- what read_open_book_page
                # accepts, so a hit is a path the reader can open rather than a riddle.
                path  = ($path.Substring($prefix.Length) -replace '\.md$', '')
                text  = $text
                bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
            })
    }

    # The only capture signal the shared collection has. Its absence is a failure, never a licence
    # to publish page metadata: the union rule fails closed on the Shelf by needing both signals to
    # say "not capture", and here the one signal must at least have been read.
    if ($null -eq $bookPageText) {
        throw "Shared Book '$slug' has no readable _book page, so its Kind could not be established; no manifest was generated."
    }
    $metadata = Get-SharedBookMetadata $bookPageText

    # -LinkPrefix: the shared collection writes its reader-map links as full note paths, so without
    # this every one of them would fail to match a page path and Discovery would hand the reader the
    # Book instead of the page the map points at.
    New-BookManifestFromPages -Slug $slug -Title ([string]$Entry.title) -Summary ([string]$Entry.summary) `
        -Topics @($metadata.topics) -IsCapture $metadata.is_capture -Pages @($pages) -LinkPrefix $prefix
}
