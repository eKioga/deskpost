[CmdletBinding()]
param(
    [string]$ProjectSlug,
    [string]$Title,
    [string]$Purpose = '',
    [string[]]$NextAction = @(),
    [string]$ProjectId,
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [switch]$Dev,
    [switch]$Preflight,
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')

function Assert-ProjectSlug([string]$Slug) {
    # -cnotmatch, not -notmatch: PowerShell's -notmatch is case-insensitive, so 'My-Project' satisfies
    # this lowercase-only rule and travels on as a Project directory. See docs/capture-book-model.md.
    if ($Slug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'ProjectSlug must use lowercase letters, digits, and single hyphens.' }
}

# The dev sections are PLACEHOLDER PROSE, never values. -Dev takes no working-tree, remote, or
# branch parameter by design: like $nowSeed below, the seeded text is an instruction the reader
# replaces. A switch that silently invented a path would be worse than one that asks for it.
#
# The remote line carries its credentials warning where the reader is typing, not in a doc they will
# not open. A Hub is NAS-backed, and docs/project-hub-design.md excludes credentials from Basic
# Memory notes outright -- an authenticated HTTPS remote pasted whole puts a token in the shared
# collection. Nothing validates what actually gets typed, so the wording is the whole guard, which is
# why hub.dev-template-seeds-sections asserts it verbatim.
#
# Decisions holds OPERATIVE pointers only. Without that rule this section reproduces exactly the
# append-only growth the Now seed exists to prevent -- a decision never "closes" the way a task does,
# so an unbounded Decisions list is the same defect wearing different clothes. See ADR-0003.
function New-ProjectDevSections {
    $repoSeed = "- **Working tree:** the local checkout this project's work happens in. Replace this line.`n" +
        "- **Remote:** sanitized remote URL -- no credentials or userinfo.`n" +
        "- **Branch:** the branch work lands on.`n" +
        "- **Gate:** the command that must pass before a change is done.`n" +
        "- **Agent guidance:** point at the working tree's own ``AGENTS.md``; never copy it here, because a copy goes stale silently.`n`n" +
        "Delete any label that does not apply to this subject rather than writing ``n/a``: this section names the working tree the work happens in and what proves a change is done, and the git-shaped labels are the common case rather than the definition. A subject with no repository of its own keeps Working tree and Gate and loses the rest. A dead label costs a reader attention on every orientation, and several would make a live section look broken rather than deliberately short."
    $decisionsSeed = "Settled ground, as one-line pointers. Replace this line.`n`n" +
        "- **<date> -- <what was decided>.** <where its record lives>`n`n" +
        "Pointers only: the reasoning lives in the subject's own ``docs/adr/`` when it has a repository you control, and in this Hub's ``decisions/`` page when it does not. Operative entries only -- remove a pointer when its decision is superseded, and let the record it names carry that history."
    "## Repo`n`n$repoSeed`n`n## Decisions`n`n$decisionsSeed`n"
}

function New-ProjectRootBody([string]$RootTitle, [string]$RootPurpose, [string[]]$RootNextAction, [bool]$DevTemplate = $false) {
    $next = if ($RootNextAction.Count) { ($RootNextAction | ForEach-Object { "- [ ] $_" }) -join "`n" } else { '- [ ] Add the next useful action.' }
    $purposeText = if ([string]::IsNullOrWhiteSpace($RootPurpose)) { 'Describe what this project is for.' } else { $RootPurpose.Trim() }
    # The seed matters: the line this replaced -- "Capture the current state here." -- is exactly
    # the invitation that turned a Now section into an append-only changelog. Orientation and a
    # session log have opposite lifecycles, and a Hub that starts by conflating them keeps doing it.
    # See docs/project-hub-design.md.
    # ADR-0013 replaced this seed's closing sentence. It used to end "An entry leaves this section
    # when it closes", which is the assumption that failed: an unproven limit closes when some event
    # occurs, and the project often cannot cause that event, so those entries never left. Measured
    # over 222 journals, the root grew from 21 KB back to 30 KB in eleven days with narrative
    # correctly routed away the whole time -- shipping a feature closes a Next item and adds a Now
    # limit. The fix is the same move that worked in 2026-08-18: name the destination, do not set a
    # number.
    $nowSeed = "Where this project stands, and anything still open or unproven. Replace this line.`n`nOrientation and open items only. **Every item here must have a closing condition this project can cause.** What *happened* belongs on a dated ``notes/`` history page, append-only and unlimited. Anything that will not close by doing the work leaves: a limit whose proof needs an event you cannot cause goes to the ``limits`` page with a disposition, a settled question goes to ``## Decisions`` and the record it names, and a standing practice goes to the subject's own rules or docs."
    # The non-dev body is pinned to a fixed literal in the self-test so it cannot drift by accident;
    # a deliberate change moves that literal with its reason, as ADR-0013 did.
    $dev = if ($DevTemplate) { "`n" + (New-ProjectDevSections) } else { '' }
    "# $RootTitle`n`n## Purpose`n`n$purposeText`n`n## Now`n`n$nowSeed`n`n## Next`n`n$next`n$dev"
}

function New-ProjectConnectionsBody {
    "# Connections`n`nThe return briefing reads this page instead of the Hub root so the root stays small.`n`n## Connected knowledge`n`n## Connected tools`n"
}

function Get-ConnectionsOverwrite([bool]$RootExists, [bool]$ConnectionsExists) {
    (-not $RootExists -and $ConnectionsExists)
}

function Confirm-WriteReadback($Record, [string]$Path) {
    if ($null -eq $Record) { throw "Write '$Path' did not become readable." }
    $Record
}

function Select-BriefingSectionsSource([string]$RootBody, [string]$RootPath, [string]$ConnectionsBody, [string]$ConnectionsPath) {
    # Validated-BookReader.ps1 cannot be dot-sourced without running its process setup. These two
    # expressions therefore mirror Select-ReturnBriefingSections verbatim and must change with it.
    $hasKnowledge = [regex]::IsMatch($RootBody, '(?m)^##\s+Connected knowledge\s*\r?$')
    $hasTools = [regex]::IsMatch($RootBody, '(?m)^##\s+Connected tools\s*\r?$')
    if (-not $hasKnowledge -and -not $hasTools) { return $ConnectionsPath }
    $RootPath
}

if ($SelfTest) {
    $checks = [Collections.Generic.List[string]]::new()
    function Assert-True([string]$Name, [bool]$Condition) {
        if (-not $Condition) { throw "Self-test failed: $Name" }
        [void]$checks.Add($Name)
    }
    function Assert-Throws([string]$Name, [scriptblock]$Action) {
        $threw = $false
        try { & $Action } catch { $threw = $true }
        Assert-True $Name $threw
    }

    $rootBody = New-ProjectRootBody 'Demo Project' 'Exercise the seed.' @('Take the next step.')
    $connectionsBody = New-ProjectConnectionsBody
    Assert-True 'root contains Purpose, Now, and Next' (($rootBody -match '(?m)^## Purpose$') -and ($rootBody -match '(?m)^## Now$') -and ($rootBody -match '(?m)^## Next$'))
    Assert-True 'root omits Connected knowledge' ($rootBody -notmatch '(?m)^## Connected knowledge\s*$')
    Assert-True 'root omits Connected tools' ($rootBody -notmatch '(?m)^## Connected tools\s*$')

    # --- The -Dev template (ADR-0003) -------------------------------------------------------------
    # The default body is asserted byte-identical to a FIXED literal, because existing Hubs were
    # created by it. Every other assertion here is about what -Dev ADDS; this one is about what it
    # must not change.
    #
    # MOVED ONCE, DELIBERATELY, 2026-09-06 (ADR-0013). The old literal ended "An entry leaves this
    # section when it closes", which measurement falsified: an unproven limit closes on an event the
    # project often cannot cause, so those entries never left and the root grew back from 21 KB to
    # 30 KB in eleven days. The seed now names the three destinations instead. Existing Hubs are
    # unaffected -- they were created, not re-seeded -- so this anchor's job is unchanged: it stops
    # the seed drifting by ACCIDENT, and a deliberate change updates it here with its reason.
    $devBody = New-ProjectRootBody 'Demo Project' 'Exercise the seed.' @('Take the next step.') $true
    $defaultAgain = New-ProjectRootBody 'Demo Project' 'Exercise the seed.' @('Take the next step.') $false
    Assert-True 'the omitted and explicit-false DevTemplate arguments agree' ($defaultAgain -ceq $rootBody)
    # A FIXED expected literal, transcribed from the implementation as it stood before -Dev existed.
    # Comparing two calls to the CURRENT function only proves the parameter default works: reword the
    # seed, change the layout, or drop the terminal newline and both calls change together, so the
    # comparison stays true while six existing Hubs stop matching what the template now produces.
    # Single-quoted parts keep the backticks around `notes/` literal; joining with "`n" keeps the line
    # endings LF regardless of this file's own.
    $expectedDefault = (@(
        '# Demo Project', '',
        '## Purpose', '',
        'Exercise the seed.', '',
        '## Now', '',
        'Where this project stands, and anything still open or unproven. Replace this line.', '',
        'Orientation and open items only. **Every item here must have a closing condition this project can cause.** What *happened* belongs on a dated `notes/` history page, append-only and unlimited. Anything that will not close by doing the work leaves: a limit whose proof needs an event you cannot cause goes to the `limits` page with a disposition, a settled question goes to `## Decisions` and the record it names, and a standing practice goes to the subject''s own rules or docs.', '',
        '## Next', '',
        '- [ ] Take the next step.'
    ) -join "`n") + "`n"
    Assert-True 'default body still matches the pre-Dev template byte for byte' ($rootBody -ceq $expectedDefault)
    Assert-True 'default body omits Repo' ($rootBody -notmatch '(?m)^## Repo\s*$')
    Assert-True 'default body omits Decisions' ($rootBody -notmatch '(?m)^## Decisions\s*$')
    Assert-True 'dev body seeds Repo' ($devBody -match '(?m)^## Repo\s*$')
    Assert-True 'dev body seeds Decisions' ($devBody -match '(?m)^## Decisions\s*$')
    Assert-True 'dev body keeps Purpose, Now, and Next' (($devBody -match '(?m)^## Purpose$') -and ($devBody -match '(?m)^## Now$') -and ($devBody -match '(?m)^## Next$'))
    Assert-True 'dev body is the default body plus the dev sections' ($devBody -ceq ($rootBody + "`n" + (New-ProjectDevSections)))
    # The credentials warning is the only thing standing between a pasted authenticated remote and a
    # token on the NAS. Assert the wording, not merely that a Remote line exists.
    Assert-True 'dev Repo seed warns against credentials in the remote' ($devBody -cmatch 'sanitized remote URL -- no credentials or userinfo')
    Assert-True 'dev Repo seed points at AGENTS.md rather than copying it' ($devBody -cmatch 'never copy it here')
    Assert-True 'dev Decisions seed states the operative-pointers rule' ($devBody -cmatch 'remove a pointer when its decision is superseded')
    # A dev root must stay invisible to the return briefing. This is the real invariant behind
    # assumption 8 -- not that the headings differ by name, but that adding them does not move the
    # briefing off the connections page.
    Assert-True 'dev root does not carry either briefing heading' (($devBody -notmatch '(?m)^## Connected knowledge\s*$') -and ($devBody -notmatch '(?m)^## Connected tools\s*$'))
    $devSelectedSource = Select-BriefingSectionsSource $devBody 'projects/demo/_project.md' $connectionsBody 'projects/demo/connections.md'
    Assert-True 'a dev root still sends the briefing to the connections page' ($devSelectedSource -ceq 'projects/demo/connections.md')
    Assert-True 'connections contains Connected knowledge' ($connectionsBody -match '(?m)^## Connected knowledge\s*$')
    Assert-True 'connections contains Connected tools' ($connectionsBody -match '(?m)^## Connected tools\s*$')
    $selectedSource = Select-BriefingSectionsSource $rootBody 'projects/demo/_project.md' $connectionsBody 'projects/demo/connections.md'
    Assert-True 'return briefing selects the connections page' ($selectedSource -ceq 'projects/demo/connections.md')
    Assert-True 'orphaned connections page is overwritten' (Get-ConnectionsOverwrite $false $true)
    Assert-True 'fresh connections page is not overwritten' (-not (Get-ConnectionsOverwrite $false $false))
    Assert-Throws 'uppercase ProjectSlug is rejected' { Assert-ProjectSlug 'My-Project' }
    Assert-Throws 'a missing write readback is rejected' { Confirm-WriteReadback $null 'projects/demo/connections.md' }

    [pscustomobject]@{ operation = 'Create Project Hub self-test'; passed = $checks.Count; shared_library_write = $false }
    return
}

if ([string]::IsNullOrWhiteSpace($ProjectSlug)) { throw 'ProjectSlug is required.' }
Assert-ProjectSlug $ProjectSlug
if ([string]::IsNullOrWhiteSpace($Title)) { throw 'Title is required.' }
$McpUrl = Resolve-LibraryMcpUrl -McpUrl $McpUrl
$ProjectId = Resolve-LibraryCollectionId -CollectionId $ProjectId

$projectDirectory = "projects/$ProjectSlug"
$projectRootPath = "$projectDirectory/_project.md"
$connectionsPath = "$projectDirectory/connections.md"
$script:Session = $null
$script:Request = 1

function ConvertTo-AsciiJson($Value) {
    $json = $Value | ConvertTo-Json -Compress -Depth 32
    [regex]::Replace($json, '[^\u0000-\u007f]', { param($match) '\u{0:x4}' -f [int][char]$match.Value })
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
    $response = Invoke-McpOnce 'initialize' @{ protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'library-project-hub'; version = '1.0.0' } }
    $error = Get-RpcError $response
    if ($null -ne $error) { throw "MCP initialization was rejected: $($error.message)" }
    Invoke-McpOnce 'notifications/initialized' @{} -Notification
}
function Read-ExactOrNull([string]$Path) {
    $response = Invoke-Mcp 'tools/call' @{ name = 'read_note'; arguments = @{ project_id = $ProjectId; identifier = $Path.Substring(0, $Path.Length - 3); output_format = 'json'; include_frontmatter = $true } }
    $error = Get-RpcError $response
    if ($null -ne $error) { throw "Read '$Path' failed: $($error.message)" }
    if ($response.result.isError) {
        $detail = [string]($response.result.content | ConvertTo-Json -Compress -Depth 8)
        if ($detail -match '(?i)not found|does not exist|no note') { return $null }
        throw "Read '$Path' was rejected: $detail"
    }
    $record = $response.result.structuredContent.result
    if ($null -eq $record -or [string]::IsNullOrWhiteSpace([string]$record.file_path)) { return $null }
    if ([string]$record.file_path -cne $Path) { throw "Read '$Path' returned '$($record.file_path)'; creation stopped." }
    $record
}
function Write-Exact([string]$Directory, [string]$NoteTitle, [string]$Body, [bool]$Overwrite) {
    $response = Invoke-Mcp 'tools/call' @{ name = 'write_note'; arguments = @{ project_id = $ProjectId; directory = $Directory; title = $NoteTitle; content = $Body; note_type = 'note'; overwrite = $Overwrite; output_format = 'json' } }
    if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw "Write '$Directory/$NoteTitle' was rejected." }
    Confirm-WriteReadback (Read-ExactOrNull "$Directory/$NoteTitle.md") "$Directory/$NoteTitle.md"
}
function Get-NoteBody($Record) {
    $body = [string]$Record.content
    if ($body -match '(?s)^---\r?\n.*?\r?\n---\r?\n(.*)$') { return $Matches[1].TrimStart("`r", "`n") }
    $body
}

Initialize-Mcp
$existingRoot = Read-ExactOrNull $projectRootPath
$catalog = Read-ExactOrNull 'projects/README.md'
$existingConnections = Read-ExactOrNull $connectionsPath
# Rendered BEFORE the preflight return, not after it. A preflight whose output is identical whether
# or not -Dev was passed cannot be evidence of what -Dev would write, and this preflight is the only
# offline way to see the intended body without creating a Hub -- which nothing in this repository can
# delete afterwards.
$body = New-ProjectRootBody $Title $Purpose $NextAction ([bool]$Dev)
$plan = [pscustomobject]@{
    operation = 'Create Project Hub'
    project_slug = $ProjectSlug
    project_path = $projectDirectory
    catalog_path = 'projects/README.md'
    connections_path = $connectionsPath
    existing_project = ($null -ne $existingRoot)
    action = if ($null -ne $existingRoot) { 'existing' } else { 'create' }
    dev_template = [bool]$Dev
    planned_root_sections = @([regex]::Matches($body, '(?m)^##\s+(.+?)\s*$') | ForEach-Object { $_.Groups[1].Value })
    planned_root_bytes = [Text.UTF8Encoding]::new($false).GetByteCount($body)
    shared_library_write = $false
}
if ($Preflight) { $plan; return }
if ($null -ne $existingRoot) { throw "Project Hub '$ProjectSlug' already exists; no write was performed." }
$catalogBody = if ($null -eq $catalog) { '' } else { Get-NoteBody $catalog }
$entry = "- [[$projectDirectory/_project|$Title]]"
$connectionsBody = New-ProjectConnectionsBody
$connectionsOverwrite = Get-ConnectionsOverwrite ($null -ne $existingRoot) ($null -ne $existingConnections)
try {
    $connections = Write-Exact -Directory $projectDirectory -NoteTitle 'connections' -Body $connectionsBody -Overwrite $connectionsOverwrite
}
catch {
    if ($null -ne $existingConnections) {
        throw "The companion connections page '$connectionsPath' already exists but could not be refreshed, and the Hub root '$projectRootPath' does not exist; re-run this command to finish the creation. $($_.Exception.Message)"
    }
    throw "Neither the companion connections page '$connectionsPath' nor the Hub root '$projectRootPath' was created; re-run this command to try again. $($_.Exception.Message)"
}
try {
    $root = Write-Exact -Directory $projectDirectory -NoteTitle '_project' -Body $body -Overwrite $false
}
catch {
    throw "The companion connections page '$connectionsPath' was created but the Hub root '$projectRootPath' was not; re-run this command to finish the creation. $($_.Exception.Message)"
}
try {
    if ($null -eq $catalog) {
        $catalogBody = "# Active Projects`n`nProjects are living context on the NAS. Open one when you need its current notes.`n`n## Projects`n`n$entry`n"
        $catalog = Write-Exact -Directory 'projects' -NoteTitle 'README' -Body $catalogBody -Overwrite $false
    }
    elseif ($catalogBody -notmatch [regex]::Escape("[[$projectDirectory/_project|$Title]]")) {
        $replacement = if ($catalogBody -match '(?m)^## Projects\s*$') { "$($catalogBody.TrimEnd())`n$entry`n" } else { "$($catalogBody.TrimEnd())`n`n## Projects`n`n$entry`n" }
        $catalog = Write-Exact -Directory 'projects' -NoteTitle 'README' -Body $replacement -Overwrite $true
    }
    if ([string]$catalog.content -notmatch [regex]::Escape("[[$projectDirectory/_project|$Title]]")) { throw 'Active Project Catalog readback did not include the new Project Hub.' }
}
catch {
    throw "The companion connections page '$connectionsPath' and Hub root '$projectRootPath' were created, but the Active Project Catalog 'projects/README.md' was not updated with the new Hub entry. $($_.Exception.Message)"
}
[pscustomobject]@{ operation = 'Create Project Hub'; project_slug = $ProjectSlug; project_path = $projectDirectory; catalog_path = 'projects/README.md'; connections_path = $connectionsPath; created = $true; shared_library_write = $true }
