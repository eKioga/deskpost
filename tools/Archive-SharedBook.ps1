[CmdletBinding()]
param(
    [string]$BookSlug,
    [string]$ProjectId,
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [switch]$UserConfirmed,
    [switch]$Preflight,
    [switch]$Json,
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
# The move leaves `books/<slug>/` behind with zero files in it, and no MCP verb can see or remove a
# directory. This is the filesystem side of the same operation. See SharedCollectionFiles.ps1.
. (Join-Path $PSScriptRoot 'SharedCollectionFiles.ps1')
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')
# STEP 21: ONE WRITABLE WORKSPACE PER COLLECTION. Resolve-LibraryWriteEndpoint is
# Resolve-LibraryMcpUrl plus the ownership fence, and every shared writer reaches the collection
# through it. tools/CollectionOwnership.ps1, checked by collection.write-fence-coverage.
. (Join-Path $PSScriptRoot 'CollectionOwnership.ps1')
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')

$McpUrl = Resolve-LibraryWriteEndpoint -McpUrl $McpUrl -Optional:$SelfTest -Operation 'archiving a shared Book'
$ProjectId = Resolve-LibraryCollectionId -CollectionId $ProjectId -Optional:$SelfTest
$script:SlugPattern = '^[a-z0-9]+(?:-[a-z0-9]+)*$'
# -cnotmatch, not -notmatch: PowerShell's -notmatch is case-insensitive, so 'My-Book' satisfies this
# lowercase-only rule and travels on as a Book root. See docs/capture-book-model.md.
# Deferred past the -SelfTest branch below, which needs no slug -- it was Mandatory, and Mandatory
# prompts, which in the gate's non-interactive child process is a hang rather than an error.
if (-not $SelfTest) {
    if ([string]::IsNullOrWhiteSpace($BookSlug)) { throw 'BookSlug is required.' }
    if ($BookSlug -cnotmatch $script:SlugPattern) { throw 'BookSlug must use lowercase letters, digits, and single hyphens.' }
}

$activeDirectory = "books/$BookSlug"
$archiveDirectory = "archive/$BookSlug"
$activeRootPath = "$activeDirectory/wiki/_book.md"
$archiveRootPath = "$archiveDirectory/wiki/_book.md"
$activeIndexPath = "$activeDirectory/wiki/_index.md"
$archiveIndexPath = "$archiveDirectory/wiki/_index.md"

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
    $response = Invoke-McpOnce 'initialize' @{ protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'pilot-book-archiver'; version = '1.0.0' } }
    $error = Get-RpcError $response
    if ($null -ne $error) { throw "MCP initialization was rejected: $($error.message)" }
    Invoke-McpOnce 'notifications/initialized' @{} -Notification
}
function Read-ExactOrNull([string]$Path, [switch]$AllowRedirect) {
    $response = Invoke-Mcp 'tools/call' @{ name = 'read_note'; arguments = @{ project_id = $ProjectId; identifier = $Path.Substring(0, $Path.Length - 3); output_format = 'json'; include_frontmatter = $false } }
    $error = Get-RpcError $response
    if ($null -ne $error) { throw "Read '$Path' failed: $($error.message)" }
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
# --- The pilot-era emptiness sentence -------------------------------------------------------------
# archive/README.md opens with prose no helper owns. Its second sentence claims the archive is empty,
# and the page has listed real archived Books since 2026-08-28, so the catalog contradicts itself.
# Nothing here authored that sentence: the body written below when the index is CREATED is correct,
# and every later run only ever appended an entry. The reader has no bounded route to it either --
# the Desk guard rightly refuses a direct edit_note outside an open active Project Hub -- so an
# archive run is the only place the repair can live.
#
# ONE KNOWN SENTENCE, NEVER A PATTERN. Two spellings are recognised, differing only in the separator
# that precedes the sentence on the live page. Both are verbatim prose: neither can match an entry,
# because an entry is a '- [[archive/<slug>/wiki/_book|Title]]' list item and contains none of these
# words. A pattern here could match prose this helper does not own; a literal cannot.
$script:ArchiveEmptinessClaims = @(
    ' The initial pilot has no archived content.',
    'The initial pilot has no archived content.'
)

function Get-EmptinessClaimRepair([string]$CatalogText) {
    <#
    .SYNOPSIS
        Decide whether the catalog carries the known emptiness sentence exactly once. Pure: reads no
        note and writes nothing, so the whole decision is provable offline by -SelfTest.
    #>
    if ([string]::IsNullOrEmpty($CatalogText)) { return [pscustomobject]@{ status = 'absent'; find_text = $null; occurrences = 0 } }
    foreach ($claim in $script:ArchiveEmptinessClaims) {
        # The leading-space spelling is a superset of the bare one, so it is tried first: when the
        # separator is there, both forms match and only the wider one leaves clean text behind.
        $count = ([regex]::Matches($CatalogText, [regex]::Escape($claim))).Count
        if ($count -eq 0) { continue }
        # Exactly one, or nothing. A duplicated sentence is a page anomaly, and expected_replacements
        # would reject the write anyway -- reporting it beats issuing a write certain to fail.
        $status = if ($count -eq 1) { 'ready' } else { 'ambiguous' }
        return [pscustomobject]@{ status = $status; find_text = $claim; occurrences = $count }
    }
    [pscustomobject]@{ status = 'absent'; find_text = $null; occurrences = 0 }
}

function Repair-EmptinessClaim([string]$CatalogText) {
    <#
    .SYNOPSIS
        Remove the known emptiness sentence, if the catalog carries exactly one of it. Sets
        $script:EmptinessClaim and never throws.

    .DESCRIPTION
        IT NEVER THROWS, AND THE ORDER IS THE REASON. This runs after the Book's entry is listed and
        before Remove-ActiveCatalogEntry, so a throw here would leave the Book in BOTH catalogs --
        strictly worse than one stale sentence, which the gate's shared.archive-catalog-consistency
        check reports until the next archive clears it. The outcome is reported in the result object
        instead of aborting an archive that has already done its real work.

        IT CANNOT REMOVE AN ENTRY. find_text is one verbatim prose sentence and content is empty, so
        the single edit deletes that sentence and nothing else; expected_replacements = 1 makes the
        write fail loudly rather than apply if the page changed between the read above and this edit.
    #>
    $repair = Get-EmptinessClaimRepair $CatalogText
    if ($repair.status -cne 'ready') {
        $script:EmptinessClaim = if ($repair.status -ceq 'ambiguous') { "not-repaired: the emptiness sentence appears $($repair.occurrences) times" } else { 'absent' }
        return
    }
    # The readback is inside the try, not after it: a transport failure on the CONFIRMING read would
    # otherwise throw out of a function documented not to, and take the archive down with it.
    try {
        $response = Invoke-Mcp 'tools/call' @{ name = 'edit_note'; arguments = @{ project_id = $ProjectId; identifier = 'archive/README'; operation = 'find_replace'; find_text = $repair.find_text; content = ''; expected_replacements = 1; output_format = 'json' } }
        if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw 'the shared Library rejected the edit' }
        # Readback, the house convention for confirming a shared write, and the only thing that
        # proves the sentence is gone rather than that the call returned.
        $index = Read-ExactOrNull 'archive/README.md'
        if ($null -eq $index) { throw 'the catalog could not be read back' }
        $after = Get-EmptinessClaimRepair ([string]$index.content)
        $script:EmptinessClaim = if ($after.status -ceq 'absent') { 'repaired' } else { 'not-repaired: the sentence survived readback' }
    }
    catch {
        $script:EmptinessClaim = "not-repaired: $($_.Exception.Message)"
    }
}

function Ensure-ArchiveIndex($BookTitle) {
    $entry = "- [[$archiveDirectory/wiki/_book|$BookTitle]] $([char]0x2014) Archived $(Get-Date -Format 'yyyy-MM-dd')"
    $index = Read-ExactOrNull 'archive/README.md'
    if ($null -eq $index) {
        $body = "# Archive`n`nInactive Books remain available here when you need them again.`n`n## Archived Books`n`n$entry`n"
        $response = Invoke-Mcp 'tools/call' @{ name = 'write_note'; arguments = @{ project_id = $ProjectId; directory = 'archive'; title = 'README'; content = $body; note_type = 'note'; overwrite = $false; output_format = 'json' } }
        if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw 'Archive index creation was rejected.' }
        Assert-McpWriteNotConflicted -Response $response -Path 'archive/README'
    }
    elseif ([string]$index.content -notmatch [regex]::Escape("[[$archiveDirectory/wiki/_book|$BookTitle]]")) {
        if ([string]$index.content -match '(?m)^## Archived Books\s*$') {
            $edit = @{ operation = 'find_replace'; find_text = '## Archived Books'; content = "## Archived Books`n`n$entry"; expected_replacements = 1 }
        }
        else {
            $edit = @{ operation = 'append'; content = "`n## Archived Books`n`n$entry`n" }
        }
        $args = @{ project_id = $ProjectId; identifier = 'archive/README'; operation = $edit.operation; content = $edit.content; output_format = 'json' }
        if ($edit.ContainsKey('find_text')) { $args.find_text = $edit.find_text; $args.expected_replacements = $edit.expected_replacements }
        $response = Invoke-Mcp 'tools/call' @{ name = 'edit_note'; arguments = $args }
        if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw 'Archive index update was rejected.' }
    }
    $index = Read-ExactOrNull 'archive/README.md'
    if ($null -eq $index -or [string]$index.content -notmatch [regex]::Escape("[[$archiveDirectory/wiki/_book|$BookTitle]]")) { throw 'Archive index readback did not include the Book.' }
    # Last, and on the readback the entry-listing assertion above just proved: the entry is in
    # place before anything touches the prose, so a failed repair costs a sentence, not an entry.
    Repair-EmptinessClaim ([string]$index.content)
}
function Rewrite-PublisherOwnedLinks([string]$Path) {
    $record = Read-ExactOrNull $Path
    if ($null -eq $record) { throw "Archived publisher-owned page '$Path' is missing." }
    $body = [string]$record.content
    if ($body -match '(?s)^---\r?\n.*?\r?\n---\r?\n(.*)$') { $body = $Matches[1].TrimStart("`r", "`n") }
    $metadata = @{}
    if ($null -ne $record.frontmatter) {
        foreach ($property in $record.frontmatter.PSObject.Properties) {
            if ($property.Name -notin @('title', 'type', 'permalink', 'tags')) { $metadata[$property.Name] = $property.Value }
        }
    }
    $bodyNeedsRewrite = $body -match [regex]::Escape($activeDirectory)
    $metadataNeedsRewrite = @($metadata.Values | Where-Object { $_ -is [string] -and $_ -match [regex]::Escape($activeDirectory) }).Count -gt 0
    if (-not $bodyNeedsRewrite -and -not $metadataNeedsRewrite) { return }
    $body = $body.Replace($activeDirectory, $archiveDirectory)
    foreach ($key in @($metadata.Keys)) { if ($metadata[$key] -is [string]) { $metadata[$key] = $metadata[$key].Replace($activeDirectory, $archiveDirectory) } }
    $response = Invoke-Mcp 'tools/call' @{ name = 'write_note'; arguments = @{ project_id = $ProjectId; directory = (Split-Path -Parent $Path).Replace('\', '/'); title = [IO.Path]::GetFileNameWithoutExtension($Path); content = $body; note_type = if ($record.frontmatter.type) { $record.frontmatter.type } else { 'note' }; metadata = $metadata; overwrite = $true; output_format = 'json' } }
    if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw "Archive link update was rejected for '$Path'." }
    $record = Read-ExactOrNull $Path
    $readback = [string]$record.content
    $staleMetadata = @()
    foreach ($property in $record.frontmatter.PSObject.Properties) {
        if ($property.Name -notin @('title', 'type', 'permalink') -and $property.Value -is [string] -and $property.Value -match [regex]::Escape($activeDirectory)) { $staleMetadata += $property.Name }
    }
    if ($readback -match [regex]::Escape($activeDirectory) -or $staleMetadata.Count -gt 0) { throw "Archive link readback still contains the active Book path in '$Path'." }
}
function Assert-ReaderMap([string]$IndexPath) {
    $index = Read-ExactOrNull $IndexPath
    if ($null -eq $index) { throw "Archive reader map '$IndexPath' is missing." }
    $pattern = '\[\[(' + [regex]::Escape($archiveDirectory + '/wiki/') + '[^\]|]+)'
    $targets = @([regex]::Matches([string]$index.content, $pattern) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    if ($targets.Count -eq 0) { throw 'Archive reader map contains no archive-local links.' }
    foreach ($target in $targets) {
        $record = Read-ExactOrNull "$target.md"
        if ($null -eq $record) { throw "Archive reader map links to a missing page: $target.md" }
    }
}
function Remove-ActiveCatalogEntry {
    $catalog = Read-ExactOrNull 'books/README.md'
    if ($null -eq $catalog) { throw 'The Book Catalog is missing; archive stopped.' }
    $links = @($catalog.content -split "`r?`n" | Where-Object { $_ -match [regex]::Escape("[[$activeDirectory/wiki/_book|") -or $_ -match [regex]::Escape("[[$archiveDirectory/wiki/_book|") })
    if ($links.Count -gt 1) { throw 'The active Book Catalog has more than one matching entry; archive stopped without changing the Catalog.' }
    if ($links.Count -eq 1) {
        $response = Invoke-Mcp 'tools/call' @{ name = 'edit_note'; arguments = @{ project_id = $ProjectId; identifier = 'books/README'; operation = 'find_replace'; find_text = $links[0]; content = ''; expected_replacements = 1; output_format = 'json' } }
        if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw 'Active Book Catalog update was rejected.' }
    }
    $catalog = Read-ExactOrNull 'books/README.md'
    if ([string]$catalog.content -match [regex]::Escape("[[$activeDirectory/wiki/_book|") -or [string]$catalog.content -match [regex]::Escape("[[$archiveDirectory/wiki/_book|")) { throw 'Active Book Catalog readback still includes the archived Book.' }
}

function Invoke-SelfTest {
    $script:selfTestFailures = @()
    # Counted here rather than written into the result below. A hand-typed total is stale the first
    # time an assertion is added, and a self-test that reports the wrong size is a self-test whose
    # other numbers have to be taken on trust.
    $script:selfTestChecks = 0
    function Assert([bool]$Condition, [string]$Message) {
        $script:selfTestChecks++
        if (-not $Condition) { $script:selfTestFailures += $Message }
    }

    foreach ($good in @('godot-engine-reference', 'ignis', 'b2')) { Assert ($good -cmatch $script:SlugPattern) "the slug pattern rejected '$good'" }
    # -cnotmatch, not -notmatch: the default is case-insensitive and would admit the first two.
    foreach ($bad in @('Godot-Engine-Reference', 'B2', 'books/demo', 'demo_two', '')) { Assert ($bad -cnotmatch $script:SlugPattern) "the slug pattern admitted '$bad'" }

    # The live catalog as of 2026-09-03: a correct opening sentence, the pilot-era claim behind it,
    # and three real entries. The claim is what must go; nothing else may move.
    $entryLines = @(
        '- [[archive/godot-engine-reference/wiki/_book|Godot Engine Reference]] - Archived 2026-08-28',
        '- [[archive/buzz-self-hosting/wiki/_book|Buzz Self-Hosting]] - Archived 2026-08-29',
        '- [[archive/2nd-b-vault-toolchain/wiki/_book|2nd-b Vault Toolchain]] - Archived 2026-08-29'
    )
    $intro = 'Retired or superseded material is retained here with its status and replacement reference.'
    $live = "# Archive`n`n$intro The initial pilot has no archived content.`n`n## Archived Books`n`n$($entryLines -join "`n")`n"

    $repair = Get-EmptinessClaimRepair $live
    Assert ($repair.status -ceq 'ready') "the live catalog shape did not yield a ready repair (got '$($repair.status)')"
    Assert ($repair.occurrences -eq 1) "the live catalog shape reported $($repair.occurrences) occurrences, not 1"
    Assert ($repair.find_text -ceq ' The initial pilot has no archived content.') 'the repair chose the wrong spelling for the live page'

    # The edit this helper issues, applied exactly as the shared Library would apply it.
    $after = $live.Replace($repair.find_text, '')
    Assert (-not $after.Contains('no archived content')) 'the repair left the emptiness claim in place'
    Assert ($after.Contains($intro)) 'the repair took the opening sentence with it'
    foreach ($entry in $entryLines) { Assert ($after.Contains($entry)) "the repair removed an entry: $entry" }
    Assert (@([regex]::Matches($after, [regex]::Escape('[[archive/'))).Count -eq $entryLines.Count) 'the repair changed how many entries the catalog links'
    Assert ($after.Contains('## Archived Books')) 'the repair removed the Archived Books heading'
    Assert ($after -cmatch "(?m)^$([regex]::Escape($intro))\s*$") 'the repair left a dangling separator on the opening line'
    # The repaired page must clear the gate check too. Its detector is broad where this repair is
    # narrow, deliberately, so the coupling that matters is asserted rather than assumed.
    foreach ($pattern in @('has no archived\b', '\bno archived (?:content|books?|projects?|material)\b', '\bnothing (?:is |has been )?archived\b', '\barchive is (?:currently )?empty\b', '\bhas not archived\b')) {
        Assert ($after -notmatch "(?i)$pattern") "the repaired catalog still trips the gate pattern '$pattern'"
    }

    # Idempotent: a second run finds nothing and writes nothing.
    Assert ((Get-EmptinessClaimRepair $after).status -ceq 'absent') 'a second repair would still fire on an already-repaired catalog'

    # The bare spelling, for a catalog where the sentence opens its own line.
    $bare = "# Archive`n`nThe initial pilot has no archived content.`n`n## Archived Books`n`n$($entryLines[0])`n"
    $bareRepair = Get-EmptinessClaimRepair $bare
    Assert ($bareRepair.status -ceq 'ready') 'the bare spelling did not yield a ready repair'
    Assert ($bareRepair.find_text -ceq 'The initial pilot has no archived content.') 'the bare spelling matched the wrong literal'
    Assert (-not $bare.Replace($bareRepair.find_text, '').Contains('no archived content')) 'the bare repair left the claim in place'

    # A duplicated sentence is reported, never written: expected_replacements = 1 would reject the
    # write, and issuing a write certain to fail is worse than declining it.
    $doubled = "# Archive`n`nThe initial pilot has no archived content.`n`nThe initial pilot has no archived content.`n`n## Archived Books`n`n$($entryLines[0])`n"
    $doubledRepair = Get-EmptinessClaimRepair $doubled
    Assert ($doubledRepair.status -ceq 'ambiguous') "a duplicated sentence was not reported as ambiguous (got '$($doubledRepair.status)')"
    Assert ($doubledRepair.occurrences -eq 2) "a duplicated sentence counted $($doubledRepair.occurrences) occurrences, not 2"

    # A catalog that never carried the sentence, and an empty one. Neither may produce a write.
    $clean = "# Archive`n`nInactive Books remain available here when you need them again.`n`n## Archived Books`n`n$($entryLines[0])`n"
    Assert ((Get-EmptinessClaimRepair $clean).status -ceq 'absent') 'a clean catalog produced a repair'
    Assert ((Get-EmptinessClaimRepair '').status -ceq 'absent') 'an empty catalog produced a repair'
    Assert ((Get-EmptinessClaimRepair $null).status -ceq 'absent') 'a null catalog produced a repair'

    # The prose this helper writes when it CREATES the index must never itself be a claim of
    # emptiness -- otherwise the first archive of an empty collection would author the very defect
    # this repair exists to clear.
    $created = 'Inactive Books remain available here when you need them again.'
    Assert ((Get-EmptinessClaimRepair $created).status -ceq 'absent') 'the created-index prose contains the emptiness sentence'
    Assert ($created -notmatch '(?i)no archived|nothing archived|archive is empty') 'the created-index prose claims emptiness'

    # Neither literal can reach an entry. This is the safety boundary the design named, so it is
    # asserted against the entry shape rather than argued for in a comment.
    foreach ($claim in $script:ArchiveEmptinessClaims) {
        Assert (-not $claim.Contains('[[')) "an emptiness literal contains link syntax: '$claim'"
        Assert (-not $claim.TrimStart().StartsWith('- ')) "an emptiness literal is shaped like a list item: '$claim'"
        foreach ($entry in $entryLines) { Assert (-not $entry.Contains($claim.Trim())) "an emptiness literal occurs inside an entry: '$claim'" }
    }

    $result = [pscustomobject]@{
        operation = 'Archive-SharedBook self-test'
        checks    = $script:selfTestChecks
        failures  = @($script:selfTestFailures)
        passed    = (@($script:selfTestFailures).Count -eq 0)
        scope     = 'Offline only: slug validation and the emptiness-sentence repair decision. No NAS access and no shared write.'
    }
    $result
    if (-not $result.passed) { throw 'Archive-SharedBook self-test failed.' }
}

if ($SelfTest) { Invoke-SelfTest; return }

$script:EmptinessClaim = 'not-reached'

Initialize-Mcp
$activeRoot = Read-ExactOrNull $activeRootPath
$archiveRoot = Read-ExactOrNull $archiveRootPath
$activeIndex = Read-ExactOrNull $activeIndexPath
if ($null -eq $activeRoot -or $null -eq $activeIndex) { throw "Active Book '$BookSlug' is incomplete or missing; nothing was archived." }
if ($null -ne $archiveRoot) { throw "Archive already contains '$BookSlug'; no move was attempted." }
$bookTitle = if ([string]$activeRoot.content -match '(?m)^#\s+(.+?)\s*$') { $Matches[1].Trim() } else { $BookSlug }
$plan = [pscustomobject]@{
    operation = 'Archive Book'
    project_id = $ProjectId
    book_slug = $BookSlug
    book_title = $bookTitle
    active_path = $activeDirectory
    archive_path = $archiveDirectory
    active_catalog_entry_removed = $true
    # Named in the plan so the one approval covers it. Reported here rather than assumed: if the
    # collection filesystem is not reachable from this machine the emptied directory will be left
    # behind, and the reader should learn that before approving, not afterwards.
    source_tree_removal = if ($null -eq (Get-SharedCollectionRoot)) { 'unavailable: the emptied directory will be left behind' } else { "the emptied $activeDirectory/ is removed if it holds no files" }
    confirmation_required = $true
    shared_library_write = $false
}
if ($Preflight) { Write-LibraryResult -Result $plan -Json:$Json; return }
if (-not $UserConfirmed) { throw 'Archiving is not yet performed: review the move plan and rerun with -UserConfirmed.' }

$moved = $false
try {
    $response = Invoke-Mcp 'tools/call' @{ name = 'move_note'; arguments = @{ project_id = $ProjectId; identifier = $activeDirectory; destination_path = $archiveDirectory; is_directory = $true; output_format = 'json' } }
    if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw 'The native Basic Memory directory move was rejected.' }
    $moved = $true
    $formerActiveRoot = Read-ExactOrNull $activeRootPath -AllowRedirect
    if ($null -ne $formerActiveRoot -and [string]$formerActiveRoot.file_path -cne $archiveRootPath) { throw "The active Book root resolved unexpectedly after the archive move: $($formerActiveRoot.file_path)" }
    $archiveRoot = Read-ExactOrNull $archiveRootPath
    if ($null -eq $archiveRoot) { throw 'The archived Book root is missing after the move.' }
    Rewrite-PublisherOwnedLinks $archiveRootPath
    Rewrite-PublisherOwnedLinks $archiveIndexPath
    Assert-ReaderMap $archiveIndexPath
    Ensure-ArchiveIndex $bookTitle
    Remove-ActiveCatalogEntry
    # Last, and outside nothing: the archive is already complete and verified by this point, so a
    # cleanup that cannot reach the share reports `unavailable` and the gate's
    # shared.archive-leaves-no-husk picks it up later. It never removes a directory holding a file.
    $huskCleanup = Invoke-SharedHuskCleanup -RelativePath $activeDirectory
    Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{ operation = 'Archive Book'; book_slug = $BookSlug; archive_path = $archiveDirectory; archive_complete = $true; active_catalog_updated = $true; emptiness_claim = $script:EmptinessClaim; source_tree = $huskCleanup.source_tree; source_tree_removed = $huskCleanup.status })
}
catch {
    $location = if ($moved) { "The native move may have completed at '$archiveDirectory'; inspect the archive and Catalog before retrying." } else { 'The active Book was left in place.' }
    throw "Book archival stopped. $location $($_.Exception.Message)"
}
