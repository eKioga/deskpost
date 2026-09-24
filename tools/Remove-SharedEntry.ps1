[CmdletBinding()]
param(
    [string]$Slug,
    [ValidateSet('book', 'project')][string]$Kind = 'book',
    [string]$Reason = '',
    [switch]$CatalogOnly,
    [string]$WorkspacePath,
    [string]$ProjectId,
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [switch]$Preflight,
    [switch]$UserConfirmed,
    [string]$ApprovedPlanId,
    [switch]$Json,
    [switch]$SelfTest
)

<#
.SYNOPSIS
    Permanently delete one shared Book or Project Hub from the Basic Memory collection.

.DESCRIPTION
    THE GAP THIS FILLS. `Archive-SharedBook.ps1` retires a shared Book to `archive/<slug>/` and
    `Archive-ProjectHub.ps1` does the same for a Hub. Both keep the material. `Remove-ShelfBook.ps1`
    deletes outright, but only from the LOCAL Shelf -- it never touches Basic Memory. So there was no
    sanctioned way to remove shared test debris, and CLAUDE.md forbids improvising a shared deletion.
    This helper is that path, built to the same ceremony as the Shelf deleter: preflight, a plan_id
    bound to the exact material, one approval, and a re-derivation that refuses if anything moved.

    WHY IT STAGES FIRST, when the Shelf deleter deliberately does not. A Shelf Book lives in a git
    working tree, so its history is already recoverable. A shared page lives only on the NAS. Every
    page body is therefore written to `internal/shared-delete-staging/<plan_id>/` BEFORE the delete
    call, so a mistaken removal is recoverable from the workspace even though the collection itself
    keeps no copy. The staging directory is evidence, not a Book: nothing reads it as Library
    material.

    ORDER MATTERS. The Catalog entry is removed and read back BEFORE the pages are deleted. The
    reverse order can leave the Catalog pointing at pages that no longer exist -- a reader-facing
    broken link -- if the run fails in between. A Catalog that briefly lists nothing is recoverable;
    a Catalog that lies is the failure this ordering prevents.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')
# STEP 21: ONE WRITABLE WORKSPACE PER COLLECTION. Resolve-LibraryWriteEndpoint is
# Resolve-LibraryMcpUrl plus the ownership fence, and every shared writer reaches the collection
# through it. tools/CollectionOwnership.ps1, checked by collection.write-fence-coverage.
. (Join-Path $PSScriptRoot 'CollectionOwnership.ps1')

$McpUrl = Resolve-LibraryWriteEndpoint -McpUrl $McpUrl -Optional:$SelfTest -WorkspacePath $WorkspacePath -Operation 'removing a Catalog entry'
$ProjectId = Resolve-LibraryCollectionId -CollectionId $ProjectId -Optional:$SelfTest

$script:Session = $null
$script:Request = 1

function Get-TextDigest([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

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
    $response = Invoke-McpOnce 'initialize' @{ protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'library-shared-remover'; version = '1.0.0' } }
    $rpcError = Get-RpcError $response
    if ($null -ne $rpcError) { throw "MCP initialization was rejected: $($rpcError.message)" }
    Invoke-McpOnce 'notifications/initialized' @{} -Notification
}

function Read-ExactOrNull([string]$Path) {
    $response = Invoke-Mcp 'tools/call' @{ name = 'read_note'; arguments = @{ project_id = $ProjectId; identifier = $Path.Substring(0, $Path.Length - 3); output_format = 'json'; include_frontmatter = $true } }
    $rpcError = Get-RpcError $response
    if ($null -ne $rpcError) { throw "Read '$Path' failed: $($rpcError.message)" }
    if ($response.result.isError) {
        $detail = [string]($response.result.content | ConvertTo-Json -Compress -Depth 8)
        if ($detail -match '(?i)not found|does not exist|no note') { return $null }
        throw "Read '$Path' was rejected: $detail"
    }
    $record = $response.result.structuredContent.result
    if ($null -eq $record -or [string]::IsNullOrWhiteSpace([string]$record.file_path)) { return $null }
    # No -AllowRedirect escape hatch here, unlike the archiver: a delete that resolved to a different
    # path than the one approved would stage and destroy the wrong page.
    if ([string]$record.file_path -cne $Path) { throw "Read '$Path' returned '$($record.file_path)'; deletion stopped." }
    $record
}

function Get-EntryPages([string]$Root) {
    <#
    .SYNOPSIS
        Every .md path below the entry root, sorted. This listing IS the manifest the plan_id binds.
    #>
    # output_format='json', never the text rendering. The text listing pads a display name ahead of
    # the path and separates fields with '|', and page titles here legitimately contain both spaces
    # and em-dashes -- so every text parse of it is a guess. The structured form carries file_path
    # and external_id as fields.
    $response = Invoke-Mcp 'tools/call' @{ name = 'list_directory'; arguments = @{ project_id = $ProjectId; dir_name = $Root; depth = 10; page_size = 200; output_format = 'json' } }
    $rpcError = Get-RpcError $response
    if ($null -ne $rpcError) { throw "Listing '$Root' failed: $($rpcError.message)" }
    if ($response.result.isError) {
        $detail = [string]($response.result.content | ConvertTo-Json -Compress -Depth 8)
        if ($detail -match '(?i)not found|does not exist') { return @() }
        throw "Listing '$Root' was rejected: $detail"
    }
    $listing = $response.result.structuredContent.result
    if ($null -eq $listing) { throw "Listing '$Root' returned no structured result." }
    # A truncated page would under-report the manifest, and the plan would then approve deleting more
    # than it listed. Refuse rather than silently bind a partial set.
    if ($listing.has_more) { throw "Listing '$Root' was paginated at $($listing.total) items; deletion stopped." }
    $pages = @()
    foreach ($node in @($listing.nodes)) {
        if ([string]$node.type -cne 'file') { continue }
        $path = [string]$node.file_path
        if ([string]::IsNullOrWhiteSpace($path)) { continue }
        if ($path -cne $Root -and $path -cnotlike "$Root/*") { continue }
        $pages += [pscustomobject]@{ path = $path; id = [string]$node.external_id }
    }
    @($pages | Sort-Object -Property path -Unique)
}

# EVERY SEAT'S DESK, NOT THIS ONE'S (step 27). "Is this material in play" is a question about the
# whole Library. Answering it from a single Desk would let a removal proceed while another seat had
# the Book open -- the same check-then-act this release closes for rename and archive, and the reason
# a missed seat is worse than no check: it reports "nothing has this open" and is wrong.
#
# The caller holds the registry lock, so the set of seats cannot change under this scan.
function Test-DeskOpen([string]$Workspace, [string]$Root) {
    $kind = if ($Kind -ceq 'book') { 'books' } else { 'projects' }
    $stateDirectory = Join-Path $Workspace '.claude'
    $slugOnly = ($Root -split '/')[-1]
    foreach ($seat in @(Get-SeatDirectoryNames -StateDirectory $stateDirectory)) {
        $path = Get-DeskFilePath -StateDirectory $stateDirectory -Seat $seat -Kind $kind
        foreach ($entry in @(Get-DeskFileEntries -Path $path)) {
            # A Book may be listed as a bare slug or as books/<slug>; both mean open.
            if ($entry -ceq $Root -or ($Kind -ceq 'book' -and $entry -ceq $slugOnly)) { return $true }
        }
    }
    $false
}

function Get-CatalogEntryLine([string]$CatalogPath, [string]$Root) {
    $catalog = Read-ExactOrNull $CatalogPath
    if ($null -eq $catalog) { throw "The Catalog '$CatalogPath' is missing; deletion stopped." }
    $needle = if ($Kind -ceq 'book') { "[[$Root/wiki/_book|" } else { "[[$Root/_project|" }
    $lines = @([string]$catalog.content -split "`r?`n" | Where-Object { $_ -match [regex]::Escape($needle) })
    if ($lines.Count -gt 1) { throw "The Catalog has more than one entry for '$Root'; deletion stopped without changing it." }
    if ($lines.Count -eq 1) { return $lines[0] }
    $null
}

function Get-RemovePlan([string]$Workspace, [string]$Root, [string]$CatalogPath, [string]$ReasonText) {
    # @() at the CALL SITE, not only inside Get-EntryPages: a function returning a one-element array
    # unrolls to a bare scalar on assignment, and a Hub with only _project.md is exactly that case.
    $pages = @(Get-EntryPages $Root)
    # -CatalogOnly repairs the wreckage of a Book or Hub deleted OUTSIDE this helper -- in Explorer,
    # say. Basic Memory drops such an entry from its index, but the Catalog keeps listing it, leaving
    # a reader-facing link to pages that no longer exist. That is precisely the state this helper's
    # ordering exists to prevent, so it must also be able to clean it up after the fact.
    #
    # The two guards are symmetric and both matter: -CatalogOnly REQUIRES an empty root, so it can
    # never be used to quietly delist a live Book; and the normal path still requires a non-empty one.
    if ($CatalogOnly) {
        if ($pages.Count -ne 0) { throw "'$Root' still has $($pages.Count) page(s). -CatalogOnly repairs a Catalog entry whose pages are already gone; use the normal path to delete a live entry." }
    }
    elseif ($pages.Count -eq 0) {
        throw "No pages found under '$Root'. If its pages were already deleted elsewhere and only the Catalog entry remains, rerun with -CatalogOnly."
    }

    $rootPagePath = if ($Kind -ceq 'book') { "$Root/wiki/_book.md" } else { "$Root/_project.md" }
    $title = ($Root -split '/')[-1]
    if (@($pages | Where-Object { $_.path -ceq $rootPagePath }).Count -eq 1) {
        $record = Read-ExactOrNull $rootPagePath
        if ($null -ne $record -and [string]$record.content -match '(?m)^#\s+(.+?)\s*$') { $title = $Matches[1].Trim() }
    }

    $catalogLine = Get-CatalogEntryLine $CatalogPath $Root
    if ($CatalogOnly) {
        if ($null -eq $catalogLine) { throw "'$Root' has no pages and no Catalog entry; there is nothing to repair." }
        # The root page is gone, so the title can only come from the Catalog line itself.
        if ($catalogLine -match '\[\[[^\]|]+\|([^\]]+)\]\]') { $title = $Matches[1].Trim() }
    }
    $wasOpen = Test-DeskOpen -Workspace $Workspace -Root $Root

    $digestSource = @(
        "action=$(if ($CatalogOnly) { "delist-shared-$Kind" } else { "delete-shared-$Kind" })",
        "root=$Root",
        "title=$title",
        "reason=$ReasonText",
        "catalog_entry=$(Get-TextDigest ([string]$catalogLine))",
        "desk_open=$($wasOpen.ToString().ToLowerInvariant())"
    ) + @($pages | ForEach-Object { "page=$($_.path):$($_.id)" })
    $planId = "$(if ($CatalogOnly) { "delist-shared-$Kind" } else { "delete-shared-$Kind" })-" + (Get-TextDigest ($digestSource -join "`n"))

    $kindLabel = if ($Kind -ceq 'book') { 'Book' } else { 'Project Hub' }
    [pscustomobject]@{
        operation             = if ($CatalogOnly) { "Remove an orphaned Catalog entry for a deleted $kindLabel" } else { "Permanently delete a shared $kindLabel" }
        root                  = $Root
        title                 = $title
        page_count            = $pages.Count
        pages                 = @($pages | ForEach-Object { $_.path })
        reason                = if ($ReasonText) { $ReasonText } else { '(none given)' }
        catalog_action        = if ($null -ne $catalogLine) { "remove one entry from $CatalogPath" } else { "none (no entry in $CatalogPath)" }
        catalog_entry         = $catalogLine
        desk_action           = if ($wasOpen) { 'BLOCKED: close this entry on the Desk before deleting' } else { 'none (already closed)' }
        desk_open             = $wasOpen
        staging_path          = if ($CatalogOnly) { '(none - no pages exist to stage)' } else { "internal/shared-delete-staging/$planId" }
        plan_id               = $planId
        confirmation_required = $true
        destructive           = $true
        recoverable           = $false
        shared_library_write  = $true
        scope                 = if ($CatalogOnly) { "Removes ONE stale line from $CatalogPath. The pages under '$Root' are already gone; no page is read, staged, or deleted." } else { "Permanently removes every page under '$Root' from the shared Basic Memory collection, after copying each page body into the local staging path above. The collection itself keeps no copy." }
    }
}

function Invoke-SelfTest {
    $failures = @()
    function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { $script:selfTestFailures += $Message } }
    $script:selfTestFailures = @()

    # The digest is stable for identical input and moves when any bound field moves.
    $a = Get-TextDigest "action=delete-shared-book`nroot=books/demo"
    $b = Get-TextDigest "action=delete-shared-book`nroot=books/demo"
    $c = Get-TextDigest "action=delete-shared-book`nroot=books/other"
    Assert ($a -ceq $b) 'the digest was not stable for identical input'
    Assert ($a -cne $c) 'the digest did not change when the root changed'

    # Slug validation is case-sensitive: 'My-Book' must not pass as a lowercase slug.
    $pattern = '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    foreach ($good in @('demo', 'demo-two', 'dsh-parity-pub-test')) { Assert ($good -cmatch $pattern) "the slug pattern rejected '$good'" }
    foreach ($bad in @('My-Book', 'Demo', 'books/demo', 'demo_two', '-demo', 'demo-')) { Assert ($bad -cnotmatch $pattern) "the slug pattern admitted '$bad'" }

    $result = [pscustomobject]@{
        operation = 'Remove-SharedEntry self-test'
        checks    = 11
        failures  = @($script:selfTestFailures)
        passed    = (@($script:selfTestFailures).Count -eq 0)
        scope     = 'Offline only: digest stability and slug validation. No NAS access and no shared write.'
    }
    Write-LibraryResult -Result $result -Json:$Json
    if (-not $result.passed) { throw 'Remove-SharedEntry self-test failed.' }
}

if ($SelfTest) { Invoke-SelfTest; return }

if ([string]::IsNullOrWhiteSpace($Slug)) { throw 'Slug is required.' }
if ($Slug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'Slug must use lowercase letters, digits, and single hyphens.' }
# STEP 20: THE WORKSPACE IS SELECTED, NOT ASSUMED. `Split-Path -Parent $PSScriptRoot` answered
# "which workspace" with "one level above my own code", which is right only while the program and
# the workspace are the same directory. Order: -WorkspacePath, then LIBRARY_WORKSPACE, then the
# nearest `.library/workspace.json` above the working directory, then this program's own root --
# and that last one only while the program really is a workspace, which is what keeps an un-split
# checkout working and stops an installed package inventing one. tools/WorkspaceRegistry.ps1.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
$WorkspacePath = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

$root = if ($Kind -ceq 'book') { "books/$Slug" } else { "projects/$Slug" }
$catalogPath = if ($Kind -ceq 'book') { 'books/README.md' } else { 'projects/README.md' }

Initialize-Mcp
$preview = Get-RemovePlan -Workspace $workspace -Root $root -CatalogPath $catalogPath -ReasonText $Reason

if ($Preflight) { Write-LibraryResult -Result $preview -Json:$Json; return }
if ($preview.desk_open) { throw "'$root' is open on the Virtual Desk. Close it with tools/Set-VirtualDesk.ps1 before deleting." }
if (-not $UserConfirmed) { throw 'Nothing was deleted: review the preflight and rerun with -UserConfirmed.' }
if ($ApprovedPlanId -cne $preview.plan_id) { throw 'Nothing was deleted: rerun the current preflight and pass its exact plan_id as ApprovedPlanId.' }

$stagingRoot = Join-Path $workspace (Join-Path 'internal/shared-delete-staging' $preview.plan_id)
if (-not $CatalogOnly -and (Test-Path -LiteralPath $stagingRoot)) { throw "Deletion staging already exists at internal/shared-delete-staging/$($preview.plan_id); inspect it before retrying." }

$catalogUpdated = $false
$deleteStarted = $false
try {
    # 1. Stage every page body locally, before anything is destroyed. Skipped under -CatalogOnly,
    #    which is defined by there being no pages left to stage.
    if (-not $CatalogOnly) {
        [void](New-Item -ItemType Directory -Path $stagingRoot -Force)
        $staged = 0
        foreach ($page in $preview.pages) {
            $record = Read-ExactOrNull $page
            if ($null -eq $record) { throw "page '$page' vanished between preflight and staging" }
            $relative = $page.Substring($root.Length + 1)
            $target = Join-Path $stagingRoot $relative
            [void](New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force)
            [IO.File]::WriteAllText($target, [string]$record.content, [Text.UTF8Encoding]::new($false))
            $staged++
        }
        if ($staged -ne $preview.page_count) { throw "staged $staged of $($preview.page_count) pages" }
    }

    # 2. Remove the Catalog entry FIRST and read it back, so a failure below never leaves the
    #    Catalog pointing at deleted pages.
    if ($null -ne $preview.catalog_entry) {
        $identifier = $catalogPath.Substring(0, $catalogPath.Length - 3)
        $response = Invoke-Mcp 'tools/call' @{ name = 'edit_note'; arguments = @{ project_id = $ProjectId; identifier = $identifier; operation = 'find_replace'; find_text = $preview.catalog_entry; content = ''; expected_replacements = 1; output_format = 'json' } }
        if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw 'the Catalog edit was rejected' }
        if ($null -ne (Get-CatalogEntryLine $catalogPath $root)) { throw 'the Catalog readback still lists this entry' }
        $catalogUpdated = $true
    }

    # 3. Delete the directory, then prove it is gone. Under -CatalogOnly there is nothing to delete:
    #    the pages were already gone before this run started, which the plan verified.
    if (-not $CatalogOnly) {
        $deleteStarted = $true
        $response = Invoke-Mcp 'tools/call' @{ name = 'delete_note'; arguments = @{ project_id = $ProjectId; identifier = $root; is_directory = $true; output_format = 'json' } }
        if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw 'the delete call was rejected' }
        $remaining = @(Get-EntryPages $root)
        if ($remaining.Count -ne 0) { throw "$($remaining.Count) page(s) still exist under '$root' after the delete" }
    }

    Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
        operation        = $preview.operation
        root             = $root
        title            = $preview.title
        pages_deleted    = $preview.page_count
        catalog_updated  = $catalogUpdated
        staging_path     = if ($CatalogOnly) { '(none)' } else { "internal/shared-delete-staging/$($preview.plan_id)" }
        deletion_complete = $true
    })
}
catch {
    $state = if ($deleteStarted) { "The delete call had already started; inspect '$root' and the Catalog before retrying." }
    elseif ($catalogUpdated) { "The Catalog entry was removed but no page was deleted; restore the entry or rerun." }
    else { "Nothing was deleted and the Catalog is unchanged." }
    throw "Shared deletion stopped. $state Staged copies, if any, are at internal/shared-delete-staging/$($preview.plan_id). $($_.Exception.Message)"
}
