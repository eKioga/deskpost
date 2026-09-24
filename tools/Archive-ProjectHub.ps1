[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ProjectSlug,
    [string]$ProjectId,
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [switch]$UserConfirmed,
    [switch]$Preflight,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
# The move leaves `projects/<slug>/` behind with zero files in it, and no MCP verb can see or remove
# a directory. This is the filesystem side of the same operation. See SharedCollectionFiles.ps1.
. (Join-Path $PSScriptRoot 'SharedCollectionFiles.ps1')
. (Join-Path $PSScriptRoot 'McpDirectoryListing.ps1')
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')
# STEP 21: ONE WRITABLE WORKSPACE PER COLLECTION. Resolve-LibraryWriteEndpoint is
# Resolve-LibraryMcpUrl plus the ownership fence, and every shared writer reaches the collection
# through it. tools/CollectionOwnership.ps1, checked by collection.write-fence-coverage.
. (Join-Path $PSScriptRoot 'CollectionOwnership.ps1')
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')

$McpUrl = Resolve-LibraryWriteEndpoint -McpUrl $McpUrl -Operation 'archiving a Project Hub'
$ProjectId = Resolve-LibraryCollectionId -CollectionId $ProjectId
# -cnotmatch, not -notmatch: PowerShell's -notmatch is case-insensitive, so 'My-Project' satisfies
# this lowercase-only rule and travels on as a Project directory. See docs/capture-book-model.md.
if ($ProjectSlug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'ProjectSlug must use lowercase letters, digits, and single hyphens.' }

$activeDirectory = "projects/$ProjectSlug"
$archiveDirectory = "archive/projects/$ProjectSlug"
$activeRootPath = "$activeDirectory/_project.md"
$archiveRootPath = "$archiveDirectory/_project.md"
$script:Session = $null
$script:Request = 1

function ConvertTo-AsciiJson($Value) {
    $json = $Value | ConvertTo-Json -Compress -Depth 32
    [regex]::Replace($json, '[^\u0000-\u007f]', { param($match) '\u{0:x4}' -f [int][char]$match.Value })
}
function Get-RpcError($Response) { $property = $Response.PSObject.Properties['error']; if ($null -eq $property) { return $null }; $property.Value }
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
    $response = Invoke-McpOnce 'initialize' @{ protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'library-project-archiver'; version = '1.0.0' } }
    if ($null -ne (Get-RpcError $response)) { throw "MCP initialization was rejected: $((Get-RpcError $response).message)" }
    Invoke-McpOnce 'notifications/initialized' @{} -Notification
}
function Read-ExactOrNull([string]$Path, [switch]$AllowRedirect) {
    $response = Invoke-Mcp 'tools/call' @{ name = 'read_note'; arguments = @{ project_id = $ProjectId; identifier = $Path.Substring(0, $Path.Length - 3); output_format = 'json'; include_frontmatter = $true } }
    if ($null -ne (Get-RpcError $response)) { throw "Read '$Path' failed: $((Get-RpcError $response).message)" }
    if ($response.result.isError) {
        $detail = [string]($response.result.content | ConvertTo-Json -Compress -Depth 8)
        if ($detail -match '(?i)not found|does not exist|no note') { return $null }
        throw "Read '$Path' was rejected: $detail"
    }
    $record = $response.result.structuredContent.result
    if ($null -eq $record -or [string]::IsNullOrWhiteSpace([string]$record.file_path)) { return $null }
    if ([string]$record.file_path -cne $Path -and -not $AllowRedirect) { throw "Read '$Path' returned '$($record.file_path)'; archive stopped." }
    $record
}
function Get-ProjectPages([string]$Directory) {
    # PAGINATED, and proved complete against the server's own total. This read used to be a single
    # unpaged list_directory whose only guard was that _project.md appeared -- and _project.md sorts
    # into the first page, so a Hub of more than ten notes would have been archived with the rest
    # left behind. Measured 2026-09-05 on the Book side of the same endpoint, where the identical
    # code read 9 of 17 pages. The paging and the proof are shared with SharedBookSource.ps1.
    Read-McpDirectoryListing -Directory $Directory -RequiredPath "$Directory/_project.md" -RequestPage {
        param($Page, $PageSize)
        Invoke-Mcp 'tools/call' @{ name = 'list_directory'; arguments = @{ project_id = $ProjectId; dir_name = $Directory; depth = 10; page = $Page; page_size = $PageSize; output_format = 'json' } }
    }
}
function Write-Note([string]$Directory, [string]$Title, [string]$Body, [bool]$Overwrite) {
    $response = Invoke-Mcp 'tools/call' @{ name = 'write_note'; arguments = @{ project_id = $ProjectId; directory = $Directory; title = $Title; content = $Body; note_type = 'note'; overwrite = $Overwrite; output_format = 'json' } }
    if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw "Write '$Directory/$Title' was rejected." }
    Assert-McpWriteNotConflicted -Response $response -Path "$Directory/$Title"
    Read-ExactOrNull "$Directory/$Title.md"
}
function Get-NoteBody($Record) {
    $body = [string]$Record.content
    if ($body -match '(?s)^---\r?\n.*?\r?\n---\r?\n(.*)$') { return $Matches[1].TrimStart("`r", "`n") }
    $body
}
function Ensure-ArchiveCatalog([string]$Title) {
    $entry = "- [[$archiveDirectory/_project|$Title]]"
    $catalog = Read-ExactOrNull 'archive/projects/README.md'
    if ($null -eq $catalog) {
        $body = "# Archived Projects`n`nInactive Project Hubs remain available here when you need their context again.`n`n## Archived Projects`n`n$entry`n"
        $catalog = Write-Note -Directory 'archive/projects' -Title 'README' -Body $body -Overwrite $false
    }
    elseif ((Get-NoteBody $catalog) -notmatch [regex]::Escape("[[$archiveDirectory/_project|$Title]]")) {
        $catalogBody = Get-NoteBody $catalog
        $replacement = if ($catalogBody -match '(?m)^## Archived Projects\s*$') { "$($catalogBody.TrimEnd())`n$entry`n" } else { "$($catalogBody.TrimEnd())`n`n## Archived Projects`n`n$entry`n" }
        $catalog = Write-Note -Directory 'archive/projects' -Title 'README' -Body $replacement -Overwrite $true
    }
    if ([string]$catalog.content -notmatch [regex]::Escape("[[$archiveDirectory/_project|$Title]]")) { throw 'Archived Project Catalog readback did not include the Project Hub.' }
}
function Remove-ActiveCatalogEntry {
    $catalog = Read-ExactOrNull 'projects/README.md'
    if ($null -eq $catalog) { throw 'The active Project Catalog is missing; archive stopped.' }
    $lines = @($catalog.content -split "`r?`n" | Where-Object { $_ -match [regex]::Escape("[[$activeDirectory/_project|") -or $_ -match [regex]::Escape("[[$archiveDirectory/_project|") })
    if ($lines.Count -gt 1) { throw 'The active Project Catalog has more than one matching entry; archive stopped without changing the Catalog.' }
    if ($lines.Count -eq 1) {
        $response = Invoke-Mcp 'tools/call' @{ name = 'edit_note'; arguments = @{ project_id = $ProjectId; identifier = 'projects/README'; operation = 'find_replace'; find_text = $lines[0]; content = ''; expected_replacements = 1; output_format = 'json' } }
        if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw 'Active Project Catalog update was rejected.' }
    }
    $catalog = Read-ExactOrNull 'projects/README.md'
    if ([string]$catalog.content -match [regex]::Escape("[[$activeDirectory/_project|") -or [string]$catalog.content -match [regex]::Escape("[[$archiveDirectory/_project|")) { throw 'Active Project Catalog readback still includes the archived Project Hub.' }
}
function Rewrite-RootSelfLinks {
    $root = Read-ExactOrNull $archiveRootPath
    $find = "[[$activeDirectory/"
    $count = [regex]::Matches([string]$root.content, [regex]::Escape($find)).Count
    if ($count -eq 0) { return }
    $response = Invoke-Mcp 'tools/call' @{ name = 'edit_note'; arguments = @{ project_id = $ProjectId; identifier = $archiveRootPath.Substring(0, $archiveRootPath.Length - 3); operation = 'find_replace'; find_text = $find; content = "[[$archiveDirectory/"; expected_replacements = $count; output_format = 'json' } }
    if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw 'Project root self-link update was rejected.' }
    $root = Read-ExactOrNull $archiveRootPath
    if ([string]$root.content -match [regex]::Escape($find)) { throw 'Project root still contains an active self-link after archive.' }
}

Initialize-Mcp
$activeRoot = Read-ExactOrNull $activeRootPath
$archiveRoot = Read-ExactOrNull $archiveRootPath
if ($null -eq $activeRoot) { throw "Active Project Hub '$ProjectSlug' is missing; nothing was archived." }
if ($null -ne $archiveRoot) { throw "Archive already contains Project Hub '$ProjectSlug'; no move was attempted." }
$pages = @(Get-ProjectPages $activeDirectory)
$title = if ([string]$activeRoot.content -match '(?m)^#\s+(.+?)\s*$') { $Matches[1].Trim() } else { $ProjectSlug }
# source_tree_removal is named in the plan so the one approval covers it, and reports unavailable
# up front rather than leaving the reader to discover the leftover directory afterwards.
$sourceTreeRemoval = if ($null -eq (Get-SharedCollectionRoot)) { 'unavailable: the emptied directory will be left behind' } else { "the emptied $activeDirectory/ is removed if it holds no files" }
$plan = [pscustomobject]@{ operation = 'Archive Project Hub'; project_id = $ProjectId; project_slug = $ProjectSlug; active_path = $activeDirectory; archive_path = $archiveDirectory; page_count = $pages.Count; source_tree_removal = $sourceTreeRemoval; confirmation_required = $true; shared_library_write = $false }
if ($Preflight) { Write-LibraryResult -Result $plan -Json:$Json; return }
if (-not $UserConfirmed) { throw 'Archiving is not yet performed: review the move plan and rerun with -UserConfirmed.' }

$moved = $false
try {
    $response = Invoke-Mcp 'tools/call' @{ name = 'move_note'; arguments = @{ project_id = $ProjectId; identifier = $activeDirectory; destination_path = $archiveDirectory; is_directory = $true; output_format = 'json' } }
    if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw 'The native Basic Memory directory move was rejected.' }
    $moved = $true
    $former = Read-ExactOrNull $activeRootPath -AllowRedirect
    if ($null -ne $former -and [string]$former.file_path -cne $archiveRootPath) { throw "The active Project root resolved unexpectedly after the move: $($former.file_path)" }
    foreach ($page in $pages) {
        $archivedPage = $page.Replace($activeDirectory, $archiveDirectory)
        if ($null -eq (Read-ExactOrNull $archivedPage)) { throw "Archived Project page is missing: $archivedPage" }
    }
    Rewrite-RootSelfLinks
    Ensure-ArchiveCatalog $title
    Remove-ActiveCatalogEntry
    # Last, after the archive is complete and verified. Never removes a directory holding a file;
    # an unreachable share reports `unavailable` and the gate catches the leftover later.
    $huskCleanup = Invoke-SharedHuskCleanup -RelativePath $activeDirectory
    Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{ operation = 'Archive Project Hub'; project_slug = $ProjectSlug; archive_path = $archiveDirectory; page_count = $pages.Count; archive_complete = $true; shared_library_write = $true; source_tree = $huskCleanup.source_tree; source_tree_removed = $huskCleanup.status })
}
catch {
    $location = if ($moved) { "The native move may have completed at '$archiveDirectory'; inspect the archive before retrying." } else { 'The active Project Hub was left in place.' }
    throw "Project archival stopped. $location $($_.Exception.Message)"
}
