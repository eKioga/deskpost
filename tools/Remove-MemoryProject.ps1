[CmdletBinding()]
param(
    [string]$ProjectName,
    [string]$DataPath,
    [switch]$KeepNotes,
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [switch]$Preflight,
    [switch]$UserConfirmed,
    [string]$ApprovedPlanId,
    [switch]$Json,
    [switch]$SelfTest
)

<#
.SYNOPSIS
    Deregister and delete an entire Basic Memory PROJECT -- not a Book, not a Hub.

.DESCRIPTION
    THE GAP THIS FILLS. `Remove-SharedEntry.ps1` deletes material INSIDE the pinned `ai-library`
    project. Nothing addressed the sibling projects next to it: every top-level folder under the
    Basic Memory knowledge root is its own registered project, and the test projects left behind by
    past acceptance runs are invisible to every Library tool, because every Library tool is pinned to
    `ai-library` by design.

    WHY IT USES delete_project. Deleting the folder in Explorer removes the files but leaves the
    project REGISTERED in Basic Memory's configuration and database -- a dangling entry that still
    lists, still resolves, and still answers as a project with no content. `delete_project` removes
    the registration, and `delete_notes=True` removes the files in the same server-side operation, so
    the two halves cannot drift apart.

    THE HARD REFUSAL. This helper will not delete the pinned Library project under any flag
    combination, by name or by id. That check is not a convenience -- it is the difference between
    this tool and one that can destroy the whole collection with a typo.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')

$McpUrl = Resolve-LibraryMcpUrl -McpUrl $McpUrl -Optional:$SelfTest

# Protected by identity AND by name: a project renamed to something else still carries this id, and a
# new project named 'ai-library' must not inherit the protection by accident. Both are refused.
#
# THE PROTECTED ID IS THE CONFIGURED COLLECTION, not a literal, from 2026-09-19. A hardcoded id
# protected Eric's collection in everyone's clone and protected nobody else's. -Optional is for the
# self-test alone, which never reaches a deletion; a real run that resolved nothing is refused at
# the guard below rather than proceeding, because a delete with no protected id is a delete with
# the guard switched off.
$script:ProtectedProjectId = Resolve-LibraryCollectionId -Optional:$SelfTest
$script:ProtectedProjectNames = @('ai-library')

$script:Session = $null
$script:Request = 1

function Get-TextDigest([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
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
        $request.Content = [Net.Http.ByteArrayContent]::new([Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Depth 20 -Compress)))
        $request.Content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/json; charset=utf-8')
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw "HTTP $([int]$response.StatusCode): $($body.Substring(0, [Math]::Min($body.Length, 2048)))" }
    }
    catch { throw "MCP $Method failed: $($_.Exception.Message)" }
    finally { $client.Dispose() }
    if ($Method -eq 'initialize') {
        $values = [Collections.Generic.IEnumerable[string]]$null
        if (-not $response.Headers.TryGetValues('Mcp-Session-Id', [ref]$values)) { throw 'No MCP session was established.' }
        $script:Session = @($values)[0]
    }
    if ($Notification) { return }
    if ($body.Trim().StartsWith('{')) { return ($body | ConvertFrom-Json) }
    $lines = @($body -split "`r?`n" | Where-Object { $_ -like 'data:*' } | ForEach-Object { $_.Substring(5).Trim() } | Where-Object { $_ })
    # Parse first, THEN select the frame carrying a result -- a keepalive or progress frame has no
    # 'id' at all, and testing $_.id on it throws under Set-StrictMode.
    $parsed = @($lines | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $null -ne $_ })
    $frames = @($parsed | Where-Object { @($_.PSObject.Properties | ForEach-Object { $_.Name }) -contains 'result' -or @($_.PSObject.Properties | ForEach-Object { $_.Name }) -contains 'error' })
    if ($frames.Count -eq 0) { throw "MCP response for request $id carried no result." }
    $frames[-1]
}

function Assert-NoRpcError($Response, [string]$What) {
    $names = @($Response.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -contains 'error' -and $null -ne $Response.error) { throw "$What was rejected: $($Response.error.message)" }
    # `isError` is a tools/call field. An `initialize` result has no such property, and reading it
    # blind throws under Set-StrictMode -- defect family 4. Enumerate before reading.
    if ($names -contains 'result' -and $null -ne $Response.result) {
        $resultNames = @($Response.result.PSObject.Properties | ForEach-Object { $_.Name })
        if ($resultNames -contains 'isError' -and $Response.result.isError) {
            throw "$What was rejected: $([string]($Response.result.content | ConvertTo-Json -Compress -Depth 6))"
        }
    }
}

function Initialize-Mcp {
    $response = Invoke-McpOnce 'initialize' @{ protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'library-project-remover'; version = '1.0.0' } }
    Assert-NoRpcError $response 'MCP initialization'
    Invoke-McpOnce 'notifications/initialized' $null -Notification
}

function Get-ProjectRegistry {
    $response = Invoke-Mcp 'tools/call' @{ name = 'list_memory_projects'; arguments = @{ output_format = 'text' } }
    Assert-NoRpcError $response 'Listing projects'
    $text = ($response.result.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join "`n"
    $found = @()
    foreach ($line in @($text -split "`r?`n")) {
        # '- <name> (local) [<uuid>]'. The name is taken up to the LAST '(' so a name containing
        # parentheses or an em-dash survives intact.
        if ($line -notmatch '^\s*-\s+(?<name>.+?)\s+\((?<kind>[^)]*)\)\s+\[(?<id>[0-9a-f-]{36})\]\s*$') { continue }
        $found += [pscustomobject]@{ name = $Matches['name'].Trim(); kind = $Matches['kind']; id = $Matches['id'] }
    }
    @($found)
}

function Test-DeletionIsProtected {
    <#
        Is this target the pinned collection? Fail-closed: with no protected id to compare against,
        the only safe reading of "I do not know what is protected" is "this might be it". The
        caller refuses earlier with a better sentence, but the default here must not be the
        dangerous one -- a guard that answers "not protected" when it knows nothing is not a guard.
    #>
    param(
        [string]$TargetId,
        [string]$TargetName,
        [string]$ProtectedId
    )
    if ([string]::IsNullOrWhiteSpace($ProtectedId)) { return $true }
    if ($TargetId -ceq $ProtectedId) { return $true }
    $script:ProtectedProjectNames -contains $TargetName.ToLowerInvariant()
}

function Invoke-SelfTest {
    $script:selfTestFailures = @()
    # Counted here rather than written down: `checks = 8` was a literal until 2026-09-19 and had
    # already stopped matching the assertions below it. A count that is typed is a count that rots.
    $script:selfTestChecks = 0
    function Assert([bool]$Condition, [string]$Message) {
        $script:selfTestChecks++
        if (-not $Condition) { $script:selfTestFailures += $Message }
    }

    # The protected project is refused by name and by id, in any casing.
    foreach ($n in @('ai-library', 'AI-Library', 'Ai-LiBrArY')) {
        Assert ($script:ProtectedProjectNames -contains $n.ToLowerInvariant()) "the protected-name check missed '$n'"
    }
    # The id itself cannot be pinned any more -- it is whatever collection this workspace is
    # attached to. What IS pinned is that the guard refuses rather than passes when there is none:
    # an unresolved protected id must never read as "nothing is protected".
    Assert ($script:ProtectedProjectId -ceq (Resolve-LibraryCollectionId -Optional)) 'the protected project id is not the configured collection'
    foreach ($empty in @('', '   ')) {
        Assert (Test-DeletionIsProtected -TargetId 'aaaaaaaa-0000-4000-8000-000000000000' -TargetName 'scratch' -ProtectedId $empty) 'an unresolved protected id reported an unrelated project as safe to delete'
    }
    # ... and with a protected id present, the two protected forms are still refused and an
    # unrelated project is still deletable, so the guard has not simply started refusing everything.
    $pinned = '44444444-4444-4444-8444-444444444444'
    Assert (Test-DeletionIsProtected -TargetId $pinned -TargetName 'anything' -ProtectedId $pinned) 'the id guard stopped matching'
    Assert (Test-DeletionIsProtected -TargetId 'bbbbbbbb-0000-4000-8000-000000000000' -TargetName 'AI-Library' -ProtectedId $pinned) 'the name guard stopped matching'
    Assert (-not (Test-DeletionIsProtected -TargetId 'bbbbbbbb-0000-4000-8000-000000000000' -TargetName 'scratch' -ProtectedId $pinned)) 'the guard refused an unrelated project'

    # The registry line parser must survive a name with an em-dash and spaces.
    $line = '- Odysseus Validation ' + [char]0x2014 + ' Shared Memory Smoke Test (local) [020478ec-0bb8-4604-8280-bdd89ed7be4b]'
    $ok = $line -match '^\s*-\s+(?<name>.+?)\s+\((?<kind>[^)]*)\)\s+\[(?<id>[0-9a-f-]{36})\]\s*$'
    Assert $ok 'the registry parser rejected a well-formed line'
    if ($ok) {
        Assert ($Matches['name'] -eq ('Odysseus Validation ' + [char]0x2014 + ' Shared Memory Smoke Test')) "the parser mangled the name: $($Matches['name'])"
        Assert ($Matches['id'] -eq '020478ec-0bb8-4604-8280-bdd89ed7be4b') 'the parser lost the id'
    }

    $result = [pscustomobject]@{
        operation = 'Remove-MemoryProject self-test'
        checks    = $script:selfTestChecks
        failures  = @($script:selfTestFailures)
        passed    = (@($script:selfTestFailures).Count -eq 0)
        scope     = 'Offline only: protection checks and registry parsing. No NAS access and no delete.'
    }
    Write-LibraryResult -Result $result -Json:$Json
    if (-not $result.passed) { throw 'Remove-MemoryProject self-test failed.' }
}

if ($SelfTest) { Invoke-SelfTest; return }
if ([string]::IsNullOrWhiteSpace($ProjectName)) { throw 'ProjectName is required.' }

Initialize-Mcp
$registry = Get-ProjectRegistry
$matches = @($registry | Where-Object { $_.name -eq $ProjectName })
if ($matches.Count -eq 0) { throw "No registered project is named '$ProjectName'. Registered: $((@($registry | ForEach-Object { $_.name })) -join ', ')" }
if ($matches.Count -gt 1) { throw "More than one registered project is named '$ProjectName'; deletion stopped." }
$target = $matches[0]

if ([string]::IsNullOrWhiteSpace($script:ProtectedProjectId)) {
    throw ('This workspace has no configured collection, so there is no pinned Library collection to ' +
           'protect and no deletion can be judged safe. Run tools/Initialize-CodexLibrary.ps1 ' +
           '-McpUrl <url> -CollectionId <id> first. Nothing was deleted.')
}
if (Test-DeletionIsProtected -TargetId ([string]$target.id) -TargetName ([string]$target.name) -ProtectedId $script:ProtectedProjectId) {
    throw "'$($target.name)' [$($target.id)] is the pinned Library collection and is protected from deletion by this helper."
}

$fileCount = $null
$sizeKb = $null
if (-not [string]::IsNullOrWhiteSpace($DataPath)) {
    if (Test-Path -LiteralPath $DataPath) {
        $files = @(Get-ChildItem -LiteralPath $DataPath -Recurse -File -Force -ErrorAction SilentlyContinue)
        $fileCount = $files.Count
        # Measure-Object -Property with ZERO input emits no object at all, so the usual
        # (... | Measure-Object).Sum throws on an empty project -- and an empty project is exactly
        # what this helper is most often pointed at. Guard the count first.
        $sizeKb = if ($fileCount -gt 0) { [math]::Round((($files | Measure-Object Length -Sum).Sum) / 1KB, 1) } else { 0 }
    }
    else { $fileCount = 'path not reachable' }
}

$deleteNotes = -not $KeepNotes
$planId = 'delete-memory-project-' + (Get-TextDigest (@("name=$($target.name)", "id=$($target.id)", "delete_notes=$($deleteNotes.ToString().ToLowerInvariant())") -join "`n"))

$plan = [pscustomobject]@{
    operation             = 'Deregister and delete a Basic Memory project'
    project_name          = $target.name
    project_id            = $target.id
    project_kind          = $target.kind
    data_path             = if ($DataPath) { $DataPath } else { '(not supplied)' }
    file_count            = if ($null -ne $fileCount) { $fileCount } else { '(unknown - pass -DataPath to count)' }
    size_kb               = if ($null -ne $sizeKb) { $sizeKb } else { '(unknown)' }
    delete_notes          = $deleteNotes
    plan_id               = $planId
    confirmation_required = $true
    destructive           = $true
    recoverable           = $false
    scope                 = if ($deleteNotes) { 'Removes the project registration AND its note files. This helper stages nothing: a Basic Memory project can hold thousands of pages, so recovery is the NAS backup, not this workspace.' } else { 'Removes the project registration only. Note files are left on disk and become unreferenced.' }
}

if ($Preflight) { Write-LibraryResult -Result $plan -Json:$Json; return }
if (-not $UserConfirmed) { throw 'Nothing was deleted: review the preflight and rerun with -UserConfirmed.' }
if ($ApprovedPlanId -cne $plan.plan_id) { throw 'Nothing was deleted: rerun the current preflight and pass its exact plan_id as ApprovedPlanId.' }

$response = Invoke-Mcp 'tools/call' @{ name = 'delete_project'; arguments = @{ project_name = $target.name; delete_notes = $deleteNotes } }
Assert-NoRpcError $response "Deleting project '$($target.name)'"

$after = @(Get-ProjectRegistry | Where-Object { $_.id -ceq $target.id })
if ($after.Count -ne 0) { throw "Project '$($target.name)' is still registered after the delete call." }

$residue = $null
if (-not [string]::IsNullOrWhiteSpace($DataPath) -and (Test-Path -LiteralPath $DataPath)) {
    $residue = @(Get-ChildItem -LiteralPath $DataPath -Recurse -File -Force -ErrorAction SilentlyContinue).Count
}

Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
    operation         = $plan.operation
    project_name      = $target.name
    project_id        = $target.id
    deregistered      = $true
    notes_deleted     = $deleteNotes
    files_remaining   = if ($null -ne $residue) { $residue } else { '(not checked)' }
    directory_remains = if (-not [string]::IsNullOrWhiteSpace($DataPath)) { [bool](Test-Path -LiteralPath $DataPath) } else { '(not checked)' }
})
