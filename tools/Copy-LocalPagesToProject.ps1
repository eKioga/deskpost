[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$ProjectSlug,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Purpose,
    [string[]]$NextAction = @(),
    [string[]]$IncludePage = @(),
    [switch]$AtProjectRoot,
    [string]$DestinationDirectory,
    [string]$WorkspacePath,
    [string]$ProjectId,
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [switch]$ReplaceExisting,
    [string]$JournalPath,
    [string]$ApprovedPlanId,
    [switch]$UserConfirmed,
    [switch]$Preflight,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
# Resolve-LocalSourceRoot and Split-NoteFrontmatter, plus the Desk gate the resolver asserts for a
# capture-Book note.
. (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')

function Read-Utf8([string]$Path) { [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false, $true)) }
function Hash([string]$Text) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($hash.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
function Normalize([string]$Body, $Frontmatter) {
    if ($null -ne $Frontmatter) { $Body = $Body.TrimStart("`r", "`n") }
    $Body.Replace("`r`n", "`n")
}
function Test-Within([string]$Child, [string]$Parent) {
    $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    [IO.Path]::GetFullPath($Child).StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)
}

# THE THREE PAGES A COPY MAY NEVER WRITE. New-ProjectHub seeds `_project` and `connections`, and
# only Edit-ProjectHub rewrites the root -- it journals the previous body, holds the projects/<slug>
# lock, and verifies the readback, none of which a copy does. Guard-BasicMemoryRead's
# Test-HubRootWrite already refuses a write_note to a Hub root on the DIRECT path; a destination
# parameter that could land a page there would be a side door around the same boundary.
#
# -in, NOT -cin, and that inversion of defect family 1 is deliberate: this is a DENYLIST, so the
# case-insensitive operator refuses MORE spellings. '_Project' is turned away rather than admitted.
$script:ReservedProjectRootPages = @('_project', 'connections', 'README')

function Assert-ProjectTargetSafe([string]$Target) {
    $prefix = "projects/$ProjectSlug/"
    if (-not $Target.StartsWith($prefix, [StringComparison]::Ordinal)) {
        throw "Destination '$Target' is not under $prefix; a Project copy writes nowhere else."
    }
    $relative = $Target.Substring($prefix.Length)
    if ([string]::IsNullOrWhiteSpace($relative)) { throw "Destination '$Target' names no page below $prefix." }
    # Belt to the segment whitelist's braces: the whitelist cannot spell '..', but $relative also
    # carries file names read off the disk, so containment is asserted rather than inferred.
    if ($relative -match '(?:^|/)\.\.?(?:/|$)') {
        throw "Destination '$Target' walks out of $prefix through a relative segment."
    }
    if ($relative -notmatch '/' -and [IO.Path]::GetFileNameWithoutExtension($relative) -in $script:ReservedProjectRootPages) {
        throw ("Destination '$Target' is a Project root page. _project, connections and README belong to " +
            'New-ProjectHub.ps1 and Edit-ProjectHub.ps1, which journal a previous body, hold the ' +
            'projects/<slug> lock and verify the readback; a copy does none of those.')
    }
}
function ConvertTo-AsciiJson($Value) {
    $json = $Value | ConvertTo-Json -Compress -Depth 32
    [regex]::Replace($json, '[^\u0000-\u007f]', { param($match) '\u{0:x4}' -f [int][char]$match.Value })
}

# STEP 20: THE WORKSPACE IS SELECTED, NOT ASSUMED. `Split-Path -Parent $PSScriptRoot` answered
# "which workspace" with "one level above my own code", which is right only while the program and
# the workspace are the same directory. Order: -WorkspacePath, then LIBRARY_WORKSPACE, then the
# nearest `.library/workspace.json` above the working directory, then this program's own root --
# and that last one only while the program really is a workspace, which is what keeps an un-split
# checkout working and stops an installed package inventing one. tools/WorkspaceRegistry.ps1.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
# STEP 21: the shared-collection write fence. tools/CollectionOwnership.ps1.
. (Join-Path $PSScriptRoot 'CollectionOwnership.ps1')
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
$WorkspacePath = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
$McpUrl = Resolve-LibraryWriteEndpoint -McpUrl $McpUrl -WorkspacePath $WorkspacePath -Operation 'copying local pages to a Project Hub'
$ProjectId = Resolve-LibraryCollectionId -CollectionId $ProjectId
# -cnotmatch, not -notmatch: PowerShell's -notmatch is case-insensitive, so 'My-Project' satisfies
# this lowercase-only rule and travels on as a Project directory. See docs/capture-book-model.md.
if ($ProjectSlug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'ProjectSlug must use lowercase letters, digits, and single hyphens.' }
# THE DESTINATION IS A PARAMETER (2026-09-08). ADR-0003's decisions/NNNN-slug.md shape had no
# implementation: every route into a Hub reached projects/<slug>/notes/** or one file beside
# _project, so the decisions/ branch of the subject-follows rule had never once been exercised.
#
# WHY IT IS NOT INFERRED FROM THE SOURCE. A folder source's default target is
# notes/<sourceName>/<relative>, so "supporting" decisions/ by naming the source folder `decisions`
# would put notebook/<slug>/decisions/ at projects/<slug>/NOTES/decisions/ and read as if it had
# worked. The prefix comes from here and $sourceName never reaches it.
#
# CONTAINMENT BY WHITELIST rather than by enumerating attacks: '..', '.', a drive letter, a UNC root
# and an absolute path are all refused by not being spellable under this rule. Assert-ProjectTargetSafe
# then re-checks every composed target, because the file half comes off the disk rather than from here.
$destination = ''
if ($PSBoundParameters.ContainsKey('DestinationDirectory')) {
    if ($AtProjectRoot) { throw 'DestinationDirectory and AtProjectRoot both name the destination; pass one, not both.' }
    $destination = $DestinationDirectory.Trim().Replace('\', '/').Trim('/')
    if ([string]::IsNullOrWhiteSpace($destination)) { throw 'DestinationDirectory must name at least one directory below projects/<slug>/.' }
    foreach ($segment in @($destination -split '/')) {
        if ($segment -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') {
            throw "DestinationDirectory segment '$segment' must use lowercase letters, digits, and single hyphens."
        }
    }
}
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
# Two permitted roots since 2026-08-28: notebook/, and one note under a capture Book's wiki/notes/
# so a Holding Shelf finding can reach a Project Hub directly. The resolver owns the rule and
# asserts the Desk gate for the capture-Book case; see ShelfNoteCommon.
$local = Resolve-LocalSourceRoot -Workspace $workspace -SourcePath $SourcePath
$wikiRoot = $local.root
$sourceFull = [IO.Path]::GetFullPath((Join-Path $workspace $SourcePath))
if (-not (Test-Within $sourceFull $wikiRoot)) { throw "SourcePath must be inside $($local.label_root)/." }
$item = Get-Item -LiteralPath $sourceFull -Force
if ($AtProjectRoot -and $item.PSIsContainer) {
    throw 'AtProjectRoot is available only when SourcePath names one Markdown file; a folder would scatter pages beside _project.'
}
$allFiles = @(if ($item.PSIsContainer) { Get-ChildItem -LiteralPath $sourceFull -Recurse -File | Where-Object { $_.Extension -eq '.md' } | Sort-Object FullName } else { if ($item.Extension -ne '.md') { throw 'A Project-copy source must be Markdown.' }; $item })
$files = @($allFiles)
if ($IncludePage.Count) {
    if (-not $item.PSIsContainer) { throw 'IncludePage is available only when SourcePath names a Notebook folder.' }
    $selected = @{}
    foreach ($page in $IncludePage) {
        $normalized = $page.Trim().TrimStart('\', '/').Replace('/', '\')
        if ($normalized -notmatch '\.md$') { throw "IncludePage '$page' must name a Markdown file relative to SourcePath." }
        $candidate = [IO.Path]::GetFullPath((Join-Path $sourceFull $normalized))
        if (-not (Test-Within $candidate $sourceFull) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "IncludePage '$page' is not an exact Markdown file below SourcePath." }
        $selected[$candidate] = $true
    }
    $files = @($allFiles | Where-Object { $selected.ContainsKey($_.FullName) })
}
if ($files.Count -eq 0) { throw 'The selected source contains no Markdown articles.' }
$sourceName = if ($item.PSIsContainer) { $item.Name } else { [IO.Path]::GetFileNameWithoutExtension($item.Name) }
# THE RESERVED-NAME RULE LIVES IN ONE PLACE, and this is where its second copy used to be. An
# -AtProjectRoot check here named only _project and README, compared with -ceq, and ran on one route:
# `connections` was reachable beside _project even though New-ProjectHub seeds it too, and '_Project'
# was admitted. Assert-ProjectTargetSafe now applies the rule to EVERY composed target on EVERY
# route, still before any MCP call, so a second implementation of it is exactly the drift this
# codebase keeps paying for. Removed 2026-09-08.
$records = @($files | ForEach-Object {
    $relative = if ($item.PSIsContainer) { $_.FullName.Substring($sourceFull.Length).TrimStart('\', '/').Replace('\', '/') } else { $_.Name }
    $content = Read-Utf8 $_.FullName
    # A capture note's frontmatter is provenance metadata, not prose. A Project record is a Basic
    # Memory note that carries frontmatter of its own, so copying the block through would give the
    # page two of them -- and Publish-SharedBookCandidate has always separated it on the shared
    # route, so leaving it attached here would make one note read differently by destination.
    if ($local.kind -ceq 'capture-note') { $content = (Split-NoteFrontmatter $content).body }
    # -DestinationDirectory replaces the WHOLE prefix, so a folder source's pages land at
    # <destination>/<relative> and not at notes/<sourceName>/<relative>. $sourceName is deliberately
    # absent from this branch: it is the value that would make a silent fallback look like a success.
    $target = "projects/$ProjectSlug/" + $(
        if ($destination) { "$destination/$relative" }
        elseif ($item.PSIsContainer) { "notes/$sourceName/$relative" }
        elseif ($AtProjectRoot) { $relative }
        else { "notes/$relative" }
    )
    # Every record, on every route -- not only the new one. The default routes were never checked.
    Assert-ProjectTargetSafe $target
    # RELATIVE TO THE RESOLVED ROOT, not to the leaf folder's name. $sourceName is only the LAST
    # segment, so a folder nested below a topic -- notebook/<project>/decisions/ -- labelled its
    # records `notebook/decisions/<file>` and dropped the middle. That field is provenance:
    # Get-LibraryTriageInventory reads it to decide whether a Notebook page already has a copy
    # record, so a wrong label credits a page that does not exist AND leaves the real one reading
    # no-known-copy-record. Unchanged for a topic-level source, which is every existing caller.
    # (The capture-note root is always one file, so it takes the else branch.)
    $sourceLabel = if ($item.PSIsContainer) { $local.label_root + '/' + $_.FullName.Substring($wikiRoot.Length).TrimStart('\', '/').Replace('\', '/') } else { $SourcePath.Replace('\', '/') }
    [pscustomobject]@{ source = $sourceLabel; path = $target; content = $content; sha256 = (Hash $content) }
})
$sourceDigest = Hash (($records | ForEach-Object { "$($_.source)|$($_.sha256)" }) -join "`n")
$manifestDigest = Hash (($records | ForEach-Object { "$($_.source)|$($_.path)|$($_.sha256)" }) -join "`n")
$newProject = Join-Path $PSScriptRoot 'New-ProjectHub.ps1'
$projectPlan = & $newProject -ProjectSlug $ProjectSlug -Title $Title -Purpose $Purpose -NextAction $NextAction -ProjectId $ProjectId -McpUrl $McpUrl -WorkspacePath $WorkspacePath -Preflight
$projectDetails = "$ProjectSlug|$Title|$Purpose|$($NextAction -join "`n")|$($projectPlan.action)"
$planId = 'project-copy-' + (Hash "$sourceDigest|$manifestDigest|$projectDetails")
$plan = [pscustomobject]@{
    operation = 'Copy Local Pages to Project'
    project_id = $ProjectId
    project_slug = $ProjectSlug
    project_action = $projectPlan.action
    source = $SourcePath
    at_project_root = [bool]$AtProjectRoot
    destination_directory = if ($destination) { $destination } else { '(default)' }
    source_file_count = $records.Count
    source_digest_sha256 = $sourceDigest
    page_manifest_sha256 = $manifestDigest
    plan_id = $planId
    planned_project_records = @($records | ForEach-Object { [pscustomobject]@{ path = $_.path; source_path = $_.source; sha256 = $_.sha256 } })
    confirmation_required = $true
    shared_library_write = $false
}
if ($Preflight) { Write-LibraryResult -Result $plan -Json:$Json; return }
if (-not $UserConfirmed) { throw 'Project copy is not yet performed: review the plan and rerun with -UserConfirmed.' }
if ($ApprovedPlanId -cne $planId) { throw 'Project copy is not yet performed: rerun the current preflight and pass its exact plan_id as ApprovedPlanId.' }
# KEYED ON THE MANIFEST DIGEST, NOT THE SOURCE DIGEST (changed 2026-09-08 with -DestinationDirectory).
# The source digest hashes source|sha256; the manifest digest hashes source|PATH|sha256. While every
# route was inferred from the source, the two keys partitioned identically. A destination parameter
# breaks that: one Notebook folder copied to decisions/ and then to notes/ are two operations whose
# completion records would otherwise overwrite each other in internal/, losing the first set of paths.
# Nothing reads this filename -- Get-LibraryTriageInventory globs *.json and reads project_slug and
# planned_records out of the body -- so the key is free to bind what the operation actually is.
if ([string]::IsNullOrWhiteSpace($JournalPath)) { $JournalPath = Join-Path $workspace "internal/publication-journals/project-$ProjectSlug-$manifestDigest.json" }

$script:Session = $null
$script:Request = 1
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
    $id = $null; if (-not $Notification) { $id = $script:Request; $script:Request++ }
    $payload = [ordered]@{ jsonrpc = '2.0'; method = $Method }; if ($null -ne $id) { $payload.id = $id }; if ($null -ne $Params) { $payload.params = $Params }
    $client = [Net.Http.HttpClient]::new()
    try {
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $McpUrl)
        [void]$request.Headers.TryAddWithoutValidation('Accept', 'application/json, text/event-stream')
        [void]$request.Headers.TryAddWithoutValidation('MCP-Protocol-Version', '2025-03-26')
        if ($script:Session) { [void]$request.Headers.TryAddWithoutValidation('Mcp-Session-Id', $script:Session) }
        $request.Content = [Net.Http.ByteArrayContent]::new([Text.Encoding]::ASCII.GetBytes((ConvertTo-AsciiJson $payload)))
        $request.Content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/json; charset=utf-8')
        $response = $client.SendAsync($request).GetAwaiter().GetResult(); $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw "HTTP $([int]$response.StatusCode): $($body.Substring(0, [Math]::Min($body.Length, 4096)))" }
    } catch { throw "MCP $Method failed: $($_.Exception.Message)" } finally { $client.Dispose() }
    if ($Method -eq 'initialize') { $values = [Collections.Generic.IEnumerable[string]]$null; if (-not $response.Headers.TryGetValues('Mcp-Session-Id', [ref]$values)) { throw 'The shared Library did not establish an MCP session.' }; $script:Session = @($values)[0] }
    if ($Notification) { return }
    if ($body.Trim().StartsWith('{')) { return ($body | ConvertFrom-Json) }
    $events = @($body -split "`r?`n" | Where-Object { $_ -like 'data:*' } | ForEach-Object { $_.Substring(5).Trim() } | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
    # An id-less notifications/message log frame has no .id to read, and reading it throws under
    # StrictMode. Enumerate the property names before comparing -- and enumerate rather than reading
    # the aggregate .Name, which throws in turn on a property-less {} frame (defect family 4).
    # Held by mcp.transports-guard-idless-events.
    $result = @($events | Where-Object { @($_.PSObject.Properties | ForEach-Object { $_.Name }) -contains 'id' -and $_.id -eq $id } | Select-Object -Last 1); if ($result.Count -ne 1) { throw "MCP response for request $id was incomplete." }; $result[0]
}
function Initialize-Mcp { Invoke-McpOnce 'initialize' @{ protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'library-project-copy'; version = '1.0.0' } } | Out-Null; Invoke-McpOnce 'notifications/initialized' @{} -Notification }
function Read-ExactOrNull([string]$Path) {
    $response = Invoke-Mcp 'tools/call' @{ name = 'read_note'; arguments = @{ project_id = $ProjectId; identifier = $Path.Substring(0, $Path.Length - 3); output_format = 'json'; include_frontmatter = $false } }
    if ($response.result.isError) { $detail = [string]($response.result.content | ConvertTo-Json -Compress -Depth 8); if ($detail -match '(?i)not found|does not exist|no note') { return $null }; throw "Read '$Path' was rejected: $detail" }
    $record = $response.result.structuredContent.result; if ($null -eq $record -or [string]::IsNullOrWhiteSpace([string]$record.file_path)) { return $null }; if ([string]$record.file_path -cne $Path) { throw "Read '$Path' returned '$($record.file_path)'; Project copy stopped." }; $record
}
function Assert-Matches($Record, $ExpectedRecord) {
    $actual = Normalize ([string]$Record.content) $Record.frontmatter
    $expectedText = Normalize ([string]$ExpectedRecord.content) $null
    if ((Hash $actual) -ne (Hash $expectedText)) { throw "Existing Project record '$($ExpectedRecord.path)' differs from the approved manifest." }
}
$attempted = [Collections.Generic.List[string]]::new(); $created = [Collections.Generic.List[string]]::new(); $reused = [Collections.Generic.List[string]]::new()
function Save-Journal([string]$State, [string]$ErrorText) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $JournalPath) -Force | Out-Null
    $journal = [pscustomobject]@{
        state = $State
        copy_kind = 'project'
        timestamp_utc = [DateTime]::UtcNow.ToString('o')
        project_id = $ProjectId
        project_slug = $ProjectSlug
        destination_directory = if ($destination) { $destination } else { '(default)' }
        source_digest_sha256 = $sourceDigest
        page_manifest_sha256 = $manifestDigest
        approved_plan_id = $planId
        planned_records = @($records | ForEach-Object { [pscustomobject]@{ path = $_.path; source = $_.source; sha256 = $_.sha256 } })
        attempted_records = $attempted
        created_records = $created
        reused_records = $reused
        error = $ErrorText
    }
    [IO.File]::WriteAllText($JournalPath, ($journal | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}

$recordsVerified = $false
try {
    if ($projectPlan.action -eq 'create') { & $newProject -ProjectSlug $ProjectSlug -Title $Title -Purpose $Purpose -NextAction $NextAction -ProjectId $ProjectId -McpUrl $McpUrl -WorkspacePath $WorkspacePath | Out-Null }
    Initialize-Mcp
    foreach ($expected in $records) {
        $existing = Read-ExactOrNull $expected.path
        if ($null -ne $existing) {
            try { Assert-Matches $existing $expected; [void]$reused.Add($expected.path); continue }
            catch { if (-not $ReplaceExisting) { throw }; $overwrite = $true }
        } else { $overwrite = $false }
        [void]$attempted.Add($expected.path)
        $response = Invoke-Mcp 'tools/call' @{ name = 'write_note'; arguments = @{ project_id = $ProjectId; directory = (Split-Path -Parent $expected.path).Replace('\', '/'); title = [IO.Path]::GetFileNameWithoutExtension($expected.path); content = $expected.content; note_type = 'note'; overwrite = $overwrite; output_format = 'json' } }
        if ($response.result.isError) { throw "Write '$($expected.path)' was rejected." }
        Assert-McpWriteNotConflicted -Response $response -Path ($expected.path.Substring(0, $expected.path.Length - 3))
        $readback = Read-ExactOrNull $expected.path; if ($null -eq $readback) { throw "Write '$($expected.path)' did not become readable." }; Assert-Matches $readback $expected; [void]$created.Add($expected.path)
    }
    $recordsVerified = $true
    Save-Journal -State 'complete' -ErrorText ''
}
catch {
    $failure = $_.Exception.Message
    if (-not $recordsVerified) {
        try { Save-Journal -State 'incomplete' -ErrorText $failure } catch { }
    }
    if ($recordsVerified) { throw "Project copy was verified, but its local completion journal could not be saved: $failure" }
    throw
}
Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{ operation = 'Copy Local Pages to Project'; project_slug = $ProjectSlug; plan_id = $planId; page_manifest_sha256 = $manifestDigest; created_records = $created; reused_records = $reused; journal_path = $JournalPath; shared_library_write = $true })
