[CmdletBinding()]
param(
    [string]$Slug,
    [ValidateSet('book', 'project')][string]$Kind = 'book',
    [ValidateSet('Projects', 'Reference', 'Workflows')][string]$Collection = 'Reference',
    [string]$Title,
    [string]$Summary = '',
    [string]$ProjectId,
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [switch]$Preflight,
    [switch]$UserConfirmed,
    [switch]$Json,
    [switch]$SelfTest
)

<#
.SYNOPSIS
    List an existing shared Book or Project Hub that is missing from its Catalog.

.DESCRIPTION
    THE GAP THIS FILLS. `New-ProjectHub.ps1` and the publishers add a Catalog entry as part of
    CREATING something. Nothing re-lists material that already exists -- so a Book or Hub that was
    published outside the normal path, or whose entry was lost, cannot be catalogued at all: the Desk
    guard permits `edit_note` only against an open active Project path, and a Catalog is neither.

    WHY IT EDITS RATHER THAN REWRITES. `New-ProjectHub` rewrites the whole Catalog body with
    `write_note -overwrite`. That is safe at creation, when the Catalog is small and just read, but
    as a general re-listing path it risks the entire Catalog on every call. This helper issues one
    `edit_note` find_replace against the collection heading instead, so the blast radius is one line
    and every other entry is untouched by construction.

    IT ONLY EVER ADDS. There is no removal mode. A slug already listed is reported as `already_listed`
    and nothing is written -- re-running is safe.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')
# STEP 21: ONE WRITABLE WORKSPACE PER COLLECTION. Resolve-LibraryWriteEndpoint is
# Resolve-LibraryMcpUrl plus the ownership fence, and every shared writer reaches the collection
# through it. tools/CollectionOwnership.ps1, checked by collection.write-fence-coverage.
. (Join-Path $PSScriptRoot 'CollectionOwnership.ps1')

$McpUrl = Resolve-LibraryWriteEndpoint -McpUrl $McpUrl -Optional:$SelfTest -Operation 'listing a Catalog entry'
$ProjectId = Resolve-LibraryCollectionId -CollectionId $ProjectId -Optional:$SelfTest

$script:Session = $null
$script:Request = 1

function ConvertTo-AsciiJson($Value) {
    $json = $Value | ConvertTo-Json -Compress -Depth 32
    [regex]::Replace($json, '[^\x00-\x7f]', { param($match) '\u{0:x4}' -f [int][char]$match.Value })
}

function Get-RpcError($Response) {
    $property = $Response.PSObject.Properties['error']
    if ($null -eq $property) { return $null }
    $property.Value
}

# --- Session recovery -----------------------------------------------------------------------------
# The MCP transport forgets its session when the server restarts or the session expires, and then
# answers every later request with "Session not found". The cached id is permanently wrong from that
# point, so a helper holding one session across several calls fails for the rest of its run while the
# NAS is healthy and answering a fresh initialize on the first try.
#
# Re-initialising and retrying ONCE is the whole fix. It retries only on that one message, only when
# an id was actually cached, and never for `initialize` itself -- so an unreachable NAS still fails on
# the first attempt rather than being retried into a slower identical failure, and the retry cannot
# recurse. Initialize-Mcp deliberately calls the non-retrying primitive for the same reason.
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

function Invoke-Mcp([string]$Method, [hashtable]$Params, [switch]$Notification) {
    try { return (Invoke-McpOnce -Method $Method -Params $Params -Notification:$Notification) }
    catch {
        if ($Method -ceq 'initialize' -or -not $script:Session) { throw }
        if ($_.Exception.Message -notmatch 'Session not found') { throw }
        if (-not (Test-McpRetryIsSafe -Method $Method -Params $Params)) { throw }
        $script:Session = $null
        Initialize-Mcp
        return (Invoke-McpOnce -Method $Method -Params $Params -Notification:$Notification)
    }
}

function Invoke-McpOnce([string]$Method, [hashtable]$Params, [switch]$Notification) {
    $id = $null
    if (-not $Notification) { $id = $script:Request; $script:Request++ }
    $payload = [ordered]@{ jsonrpc = '2.0'; method = $Method }
    if ($null -ne $id) { $payload.id = $id }
    if ($null -ne $Params) { $payload.params = $Params }

    $client = [Net.Http.HttpClient]::new()
    try {
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $McpUrl)
        [void]$request.Headers.TryAddWithoutValidation('Accept', 'application/json, text/event-stream')
        [void]$request.Headers.TryAddWithoutValidation('MCP-Protocol-Version', '2025-03-26')
        if ($script:Session) { [void]$request.Headers.TryAddWithoutValidation('Mcp-Session-Id', $script:Session) }
        $request.Content = [Net.Http.ByteArrayContent]::new([Text.Encoding]::ASCII.GetBytes((ConvertTo-AsciiJson $payload)))
        $request.Content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/json; charset=utf-8')
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw "HTTP $([int]$response.StatusCode): $($body.Substring(0, [Math]::Min($body.Length, 4096)))" }
    }
    catch { throw "MCP $Method failed: $($_.Exception.Message)" }
    finally { $client.Dispose() }

    if ($Method -eq 'initialize') {
        $values = [Collections.Generic.IEnumerable[string]]$null
        if (-not $response.Headers.TryGetValues('Mcp-Session-Id', [ref]$values)) { throw 'The shared Library did not establish an MCP session.' }
        $script:Session = @($values)[0]
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

function Initialize-Mcp {
    $response = Invoke-McpOnce 'initialize' @{ protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'library-catalog-lister'; version = '1.0.0' } }
    $rpcError = Get-RpcError $response
    if ($null -ne $rpcError) { throw "MCP initialization was rejected: $($rpcError.message)" }
    Invoke-McpOnce 'notifications/initialized' @{} -Notification
}

function Read-ExactOrNull([string]$Path) {
    $response = Invoke-Mcp 'tools/call' @{ name = 'read_note'; arguments = @{ project_id = $ProjectId; identifier = $Path.Substring(0, $Path.Length - 3); output_format = 'json'; include_frontmatter = $false } }
    $rpcError = Get-RpcError $response
    if ($null -ne $rpcError) { throw "Read '$Path' failed: $($rpcError.message)" }
    if ($response.result.isError) {
        $detail = [string]($response.result.content | ConvertTo-Json -Compress -Depth 8)
        if ($detail -match '(?i)not found|does not exist|no note') { return $null }
        throw "Read '$Path' was rejected: $detail"
    }
    $record = $response.result.structuredContent.result
    if ($null -eq $record -or [string]::IsNullOrWhiteSpace([string]$record.file_path)) { return $null }
    if ([string]$record.file_path -cne $Path) { throw "Read '$Path' returned '$($record.file_path)'; listing stopped." }
    $record
}

function Invoke-SelfTest {
    $script:selfTestFailures = @()
    function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { $script:selfTestFailures += $Message } }

    $pattern = '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    foreach ($good in @('library-dsh-dev', 'ignis', 'ai-game-design-research')) { Assert ($good -cmatch $pattern) "the slug pattern rejected '$good'" }
    # -cnotmatch, not -notmatch: the default is case-insensitive and would admit these.
    foreach ($bad in @('Library-DSH-Dev', 'Ignis', 'projects/demo', 'demo_two')) { Assert ($bad -cnotmatch $pattern) "the slug pattern admitted '$bad'" }

    # The entry a Book gets and the entry a Hub gets differ, and each Catalog is matched on its own
    # link shape. A shared shape here would make an existing Hub entry invisible to the Book check.
    $bookEntry = "- [[books/demo/wiki/_book|Demo]]"
    $projEntry = "- [[projects/demo/_project|Demo]]"
    Assert ($bookEntry -cne $projEntry) 'the Book and Project entry shapes collided'
    Assert ($bookEntry.Contains('/wiki/_book|')) 'the Book entry lost its _book link'
    Assert ($projEntry.Contains('/_project|')) 'the Project entry lost its _project link'

    $result = [pscustomobject]@{
        operation = 'Add-CatalogEntry self-test'
        checks    = 10
        failures  = @($script:selfTestFailures)
        passed    = (@($script:selfTestFailures).Count -eq 0)
        scope     = 'Offline only: slug validation and entry shapes. No NAS access and no shared write.'
    }
    Write-LibraryResult -Result $result -Json:$Json
    if (-not $result.passed) { throw 'Add-CatalogEntry self-test failed.' }
}

if ($SelfTest) { Invoke-SelfTest; return }

if ([string]::IsNullOrWhiteSpace($Slug)) { throw 'Slug is required.' }
if ($Slug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'Slug must use lowercase letters, digits, and single hyphens.' }

$root = if ($Kind -ceq 'book') { "books/$Slug" } else { "projects/$Slug" }
$rootPage = if ($Kind -ceq 'book') { "$root/wiki/_book.md" } else { "$root/_project.md" }
$catalogPath = if ($Kind -ceq 'book') { 'books/README.md' } else { 'projects/README.md' }
$linkTarget = if ($Kind -ceq 'book') { "$root/wiki/_book" } else { "$root/_project" }
# A Project Catalog has one flat '## Projects' list; a Book Catalog has the three collection
# headings from docs/library-organization.md.
$heading = if ($Kind -ceq 'book') { "## $Collection" } else { '## Projects' }

Initialize-Mcp

$rootRecord = Read-ExactOrNull $rootPage
if ($null -eq $rootRecord) { throw "'$rootPage' does not exist; nothing was listed." }
if ([string]::IsNullOrWhiteSpace($Title)) {
    $Title = if ([string]$rootRecord.content -match '(?m)^#\s+(.+?)\s*$') { $Matches[1].Trim() } else { $Slug }
}

$catalog = Read-ExactOrNull $catalogPath
if ($null -eq $catalog) { throw "The Catalog '$catalogPath' is missing; nothing was listed." }
$catalogBody = [string]$catalog.content

$alreadyListed = $catalogBody -match [regex]::Escape("[[$linkTarget|")
$entry = if ([string]::IsNullOrWhiteSpace($Summary)) { "- [[$linkTarget|$Title]]" } else { "- [[$linkTarget|$Title]] $([char]0x2014) $($Summary.Trim())" }
$headingPresent = $catalogBody -cmatch ('(?m)^' + [regex]::Escape($heading) + '\s*$')

$plan = [pscustomobject]@{
    operation             = "List an existing $(if ($Kind -ceq 'book') { 'Book' } else { 'Project Hub' }) in its Catalog"
    root                  = $root
    title                 = $Title
    catalog_path          = $catalogPath
    heading               = $heading
    heading_present       = $headingPresent
    entry                 = $entry
    already_listed        = $alreadyListed
    action                = if ($alreadyListed) { 'none (already listed)' } elseif ($headingPresent) { "insert one line under '$heading'" } else { "create '$heading' and insert one line" }
    confirmation_required = -not $alreadyListed
    destructive           = $false
    shared_library_write  = -not $alreadyListed
    scope                 = 'Adds exactly one Catalog line. Removes nothing and rewrites no other entry.'
}

if ($Preflight) { Write-LibraryResult -Result $plan -Json:$Json; return }
if ($alreadyListed) { Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{ operation = $plan.operation; root = $root; catalog_path = $catalogPath; already_listed = $true; changed = $false }); return }
if (-not $UserConfirmed) { throw 'Nothing was listed: review the preflight and rerun with -UserConfirmed.' }

$identifier = $catalogPath.Substring(0, $catalogPath.Length - 3)
if ($headingPresent) {
    # find_replace on the heading, with expected_replacements=1: a Catalog carrying the same heading
    # twice would otherwise take an ambiguous edit. One match or the edit is refused.
    $arguments = @{ project_id = $ProjectId; identifier = $identifier; operation = 'find_replace'; find_text = $heading; content = "$heading`n`n$entry"; expected_replacements = 1; output_format = 'json' }
}
else {
    $arguments = @{ project_id = $ProjectId; identifier = $identifier; operation = 'append'; content = "`n$heading`n`n$entry`n"; output_format = 'json' }
}
$response = Invoke-Mcp 'tools/call' @{ name = 'edit_note'; arguments = $arguments }
if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw "The Catalog edit was rejected for '$catalogPath'." }

$after = Read-ExactOrNull $catalogPath
if ($null -eq $after -or [string]$after.content -notmatch [regex]::Escape("[[$linkTarget|")) { throw 'The Catalog readback does not contain the new entry.' }

Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
    operation    = $plan.operation
    root         = $root
    title        = $Title
    catalog_path = $catalogPath
    heading      = $heading
    entry        = $entry
    changed      = $true
})
