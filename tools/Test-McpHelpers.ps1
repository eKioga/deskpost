<#
.SYNOPSIS
    Stub-MCP boundary suite for helpers that need a shared-collection endpoint.

.DESCRIPTION
    Item 0.2 of the plan, MCP half -- the other half of Test-LibraryHelpers.ps1. Covers
    Includes Project Hub editing and the publication, triage, copy, and archive helpers, all against
    a stub endpoint with a disposable fixture workspace.

    Case classes required by the plan, all present below: stale plan_id, fabricated plan_id,
    destination collisions, partial writes, retry after failure, readback mismatch, and resume.

    The stub speaks JSON-RPC over Server-Sent Events on loopback, the same shape as the real
    endpoint, so the helpers' own SSE parsing runs rather than being bypassed by a plain-JSON reply.
    It is fault-injectable: a write can be made to fail once or always, and a read can be made to
    return altered content or a different file_path. Those are what make partial writes, retry, and
    readback mismatch testable at all -- a purely faithful stub can only ever exercise happy paths.

    No NAS call is made and the reader's own Notebook, Shelf, and Desk are never touched.
#>
[CmdletBinding()]
param([switch]$KeepFixture)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolsDir = $PSScriptRoot
$passed = 0
$failures = [Collections.Generic.List[string]]::new()

function Assert-True([bool]$Condition, [string]$Label) {
    if ($Condition) { $script:passed++ } else { [void]$failures.Add($Label) }
}
function Assert-Equal($Expected, $Actual, [string]$Label) {
    if ("$Expected" -ceq "$Actual") { $script:passed++ } else { [void]$failures.Add("$Label (expected '$Expected', got '$Actual')") }
}
function Assert-Refused([scriptblock]$Body, [string]$Fragment, [string]$Label) {
    try { & $Body | Out-Null; [void]$failures.Add("$Label -- it was allowed") }
    catch {
        if ($_.Exception.Message -match [regex]::Escape($Fragment)) { $script:passed++ }
        else { [void]$failures.Add("$Label -- refused for the wrong reason: $($_.Exception.Message)") }
    }
}

# --- Stub MCP endpoint ----------------------------------------------------------------------------
# Shared state lives in synchronized hashtables so the test thread can seed notes and arm faults
# while the listener thread serves. Port 0 picks a free port; the listener is loopback-only, which
# HttpListener permits without administrator rights.
$probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$probe.Start()
$port = $probe.LocalEndpoint.Port
$probe.Stop()

$store = [hashtable]::Synchronized(@{
        Notes     = [hashtable]::Synchronized(@{})
        Faults    = [hashtable]::Synchronized(@{
                ReadMutate      = [hashtable]::Synchronized(@{})
                ReadWrongPath   = [hashtable]::Synchronized(@{})
                WriteFailAlways = [Collections.ArrayList]::Synchronized([Collections.ArrayList]::new())
                WriteFailOnce   = [Collections.ArrayList]::Synchronized([Collections.ArrayList]::new())
                # path -> the body ANOTHER writer lands there immediately before this write: the race
                # a no-overwrite create exists to lose safely.
                WriteRaceOnce   = [hashtable]::Synchronized(@{})
                MoveFail        = $false
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
    function New-Ok($Record, $Text) { @{ content = @((New-Text $Text)); structuredContent = @{ result = $Record }; isError = $false } }
    function New-Fail([string]$Text) { @{ content = @((New-Text $Text)); structuredContent = @{ result = $null }; isError = $true } }
    function Get-Arg($Arguments, [string]$Name) {
        if ($null -eq $Arguments) { return $null }
        $property = $Arguments.PSObject.Properties[$Name]
        if ($null -eq $property) { return $null }
        $property.Value
    }
    function ConvertTo-NotePath([string]$Identifier) {
        if ($Identifier.EndsWith('.md')) { return $Identifier }
        "$Identifier.md"
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

            # A notification carries no id and expects no body -- only that the POST succeeded.
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
                [void]$Store.Calls.Add($toolName)

                switch ($toolName) {
                    'read_note' {
                        $path = ConvertTo-NotePath ([string](Get-Arg $toolArgs 'identifier'))
                        if (-not $Store.Notes.ContainsKey($path)) { $result = New-Fail "Note not found: $path" }
                        else {
                            $note = $Store.Notes[$path]
                            $content = [string]$note.content
                            if ($Store.Faults.ReadMutate.ContainsKey($path)) { $content = [string]$Store.Faults.ReadMutate[$path] }
                            $filePath = [string]$note.file_path
                            if ($Store.Faults.ReadWrongPath.ContainsKey($path)) { $filePath = [string]$Store.Faults.ReadWrongPath[$path] }
                            $result = New-Ok @{ file_path = $filePath; title = $note.title; content = $content; frontmatter = $note.frontmatter } $content
                        }
                    }
                    'write_note' {
                        $directory = [string](Get-Arg $toolArgs 'directory')
                        $title = [string](Get-Arg $toolArgs 'title')
                        $path = "$directory/$title.md"
                        if ($Store.Faults.WriteFailOnce -contains $path) {
                            [void]$Store.Faults.WriteFailOnce.Remove($path)
                            $result = New-Fail "Injected one-shot write failure for $path"
                        }
                        elseif ($Store.Faults.WriteFailAlways -contains $path) {
                            $result = New-Fail "Injected write failure for $path"
                        }
                        else {
                            if ($Store.Faults.WriteRaceOnce.ContainsKey($path)) {
                                $Store.Notes[$path] = @{ file_path = $path; title = $title; content = [string]$Store.Faults.WriteRaceOnce[$path]; frontmatter = @{ title = $title; type = 'note'; permalink = $path } }
                                $Store.Faults.WriteRaceOnce.Remove($path)
                            }
                            $overwrite = [bool](Get-Arg $toolArgs 'overwrite')
                            if ($Store.Notes.ContainsKey($path) -and -not $overwrite) {
                                # AS THE DEPLOYED SERVER ANSWERS, MEASURED 2026-09-22 (S33): NOT an error.
                                # isError is false and the refusal is `action: conflict` in the result,
                                # with no file_path. This stub answered isError=true until then, so no
                                # helper here was ever tested against the answer it really receives.
                                $record = @{ title = $title; permalink = $path.Substring(0, $path.Length - 3); file_path = $null; checksum = $null; action = 'conflict'; error = 'NOTE_ALREADY_EXISTS' }
                                $result = New-Ok $record ($record | ConvertTo-Json -Compress)
                            }
                            else {
                                $frontmatter = @{ title = $title; type = [string](Get-Arg $toolArgs 'note_type'); permalink = $path }
                                $metadata = Get-Arg $toolArgs 'metadata'
                                if ($null -ne $metadata) {
                                    foreach ($property in $metadata.PSObject.Properties) { $frontmatter[$property.Name] = $property.Value }
                                }
                                $Store.Notes[$path] = @{ file_path = $path; title = $title; content = [string](Get-Arg $toolArgs 'content'); frontmatter = $frontmatter }
                                $result = New-Ok @{ file_path = $path; title = $title; content = $Store.Notes[$path].content; frontmatter = $frontmatter } 'written'
                            }
                        }
                    }
                    'edit_note' {
                        $path = ConvertTo-NotePath ([string](Get-Arg $toolArgs 'identifier'))
                        if (-not $Store.Notes.ContainsKey($path)) { $result = New-Fail "Note not found: $path" }
                        else {
                            $note = $Store.Notes[$path]
                            $operation = [string](Get-Arg $toolArgs 'operation')
                            $content = [string](Get-Arg $toolArgs 'content')
                            if ($operation -eq 'append') {
                                $note.content = [string]$note.content + $content
                                $result = New-Ok @{ file_path = $note.file_path; title = $note.title; content = $note.content; frontmatter = $note.frontmatter } 'edited'
                            }
                            elseif ($operation -eq 'find_replace') {
                                $find = [string](Get-Arg $toolArgs 'find_text')
                                $expectedValue = Get-Arg $toolArgs 'expected_replacements'
                                $expected = if ($null -eq $expectedValue) { 1 } else { [int]$expectedValue }
                                $actual = ([regex]::Matches([string]$note.content, [regex]::Escape($find))).Count
                                if ($actual -ne $expected) { $result = New-Fail "Expected $expected replacements of '$find', found $actual" }
                                else {
                                    $note.content = ([string]$note.content).Replace($find, $content)
                                    $result = New-Ok @{ file_path = $note.file_path; title = $note.title; content = $note.content; frontmatter = $note.frontmatter } 'edited'
                                }
                            }
                            else { $result = New-Fail "Unsupported edit operation '$operation'" }
                        }
                    }
                    'move_note' {
                        if ($Store.Faults.MoveFail) { $result = New-Fail 'Injected move failure' }
                        else {
                            $source = [string](Get-Arg $toolArgs 'identifier')
                            $destination = [string](Get-Arg $toolArgs 'destination_path')
                            $keys = @($Store.Notes.Keys | Where-Object { $_ -ceq "$source.md" -or $_.StartsWith("$source/") })
                            if (-not $keys.Count) { $result = New-Fail "Nothing to move at $source" }
                            else {
                                foreach ($key in $keys) {
                                    $moved = $destination + $key.Substring($source.Length)
                                    $note = $Store.Notes[$key]
                                    $note.file_path = $moved
                                    $Store.Notes[$moved] = $note
                                    $Store.Notes.Remove($key)
                                }
                                $result = New-Ok $null "Moved $($keys.Count) note(s)"
                            }
                        }
                    }
                    'list_directory' {
                        # The real endpoint's json shape, PAGINATED. It used to answer with a bare
                        # row list and no pagination, so the archiver's single unpaged call looked
                        # correct here while it read one page of ten against the live server.
                        $directory = [string](Get-Arg $toolArgs 'dir_name')
                        $paths = @($Store.Notes.Keys | Where-Object { $_.StartsWith("$directory/") } | Sort-Object)
                        $requestedSize = Get-Arg $toolArgs 'page_size'
                        $pageSize = if ($null -ne $requestedSize) { [int]$requestedSize } else { 10 }
                        if ($pageSize -lt 1) { $pageSize = 1 }
                        $requestedPage = Get-Arg $toolArgs 'page'
                        $pageNumber = if ($null -ne $requestedPage) { [int]$requestedPage } else { 1 }
                        if ($pageNumber -lt 1) { $pageNumber = 1 }
                        $slice = @($paths | Select-Object -Skip (($pageNumber - 1) * $pageSize) -First $pageSize)
                        $nodes = @($slice | ForEach-Object { @{ name = [IO.Path]::GetFileName($_); file_path = $_; directory_path = "/$_"; type = 'file'; children = @() } })
                        $payload = @{ nodes = $nodes; page = $pageNumber; page_size = $pageSize; total = $paths.Count; has_more = (($pageNumber * $pageSize) -lt $paths.Count) }
                        $result = @{ content = @((New-Text ($payload | ConvertTo-Json -Depth 8 -Compress))); structuredContent = @{ result = $payload }; isError = $false }
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

function Set-Note([string]$Path, [string]$Content, [hashtable]$Extra) {
    $title = [IO.Path]::GetFileNameWithoutExtension($Path)
    $frontmatter = @{ title = $title; type = 'note'; permalink = $Path }
    if ($Extra) { foreach ($key in $Extra.Keys) { $frontmatter[$key] = $Extra[$key] } }
    $store.Notes[$Path] = @{ file_path = $Path; title = $title; content = $Content; frontmatter = $frontmatter }
}
function Reset-Store {
    $store.Notes.Clear()
    $store.Faults.ReadMutate.Clear()
    $store.Faults.ReadWrongPath.Clear()
    $store.Faults.WriteFailAlways.Clear()
    $store.Faults.WriteFailOnce.Clear()
    $store.Faults.WriteRaceOnce.Clear()
    $store.Faults.MoveFail = $false
    $store.Calls.Clear()
    Set-Note 'books/README.md' "# Book Catalog`n`n## Open a Book`n"
}
# The Catalog entry lines one Book owns, matched the way the publisher matches them -- by the entry's
# own LINK TARGET rather than its rendered title. This is deliberately a reader and not the rule
# itself: if the ownership rule were wrong, this would be wrong the same way, so the cases below pin
# whole literal lines and assert stale text is GONE rather than trusting this count alone.
function Get-CatalogEntryLines([string]$BookRoot) {
    @(([string]$store.Notes['books/README.md'].content -split "`r?`n") |
        Where-Object { $_.TrimStart().StartsWith("- [[$BookRoot/_book|", [StringComparison]::Ordinal) })
}
# Returns a NAMED sentinel rather than indexing an empty array, so a wrong count fails at the
# assertion written for it instead of crashing the suite with an index error under StrictMode.
function Get-CatalogEntryLine([string]$BookRoot) {
    $lines = @(Get-CatalogEntryLines $BookRoot)
    if ($lines.Count -eq 1) { return [string]$lines[0] }
    "<$($lines.Count) Catalog entry lines for $BookRoot>"
}
# The '## Heading' each of this Book's entry lines is filed under, in document order -- '<no
# heading>' for a line above the first. Same caveat as Get-CatalogEntryLines and then some: it walks
# the Catalog the way the publisher does, so the placement cases below ALSO pin a literal
# '## Heading\n\n<entry>' substring and the GRAND TOTAL from Get-CatalogEntryLines, neither of
# which depends on this walk being right.
function Get-CatalogEntryHeadings([string]$BookRoot) {
    $prefix = "- [[$BookRoot/_book|"
    $heading = '<no heading>'
    foreach ($line in ([string]$store.Notes['books/README.md'].content -split "`r?`n")) {
        if ($line -cmatch '^##\s+\S') { $heading = $line.TrimEnd() }
        elseif ($line.TrimStart().StartsWith($prefix, [StringComparison]::Ordinal)) { $heading }
    }
}

# --- Fixture --------------------------------------------------------------------------------------
# Initialize-ShelfCatalogForFixture and Set-ShelfCatalogEntryForFixture: shelf/_catalog.md is
# rendered from the tracked header plus one entry file per Book, so the fixture lists a Book the
# way a writer does rather than by appending to the catalog.
. (Join-Path $PSScriptRoot 'ShelfCatalog.ps1')
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
# Fixtures work at a seat named 'fixture'. Set in this process so CHILD helper processes
# inherit it: they default -Seat to LIBRARY_SEAT, and there is no default seat to fall back on.
$env:LIBRARY_SEAT = 'fixture'

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('library-mcp-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
function New-Fixture {
    New-Item -ItemType Directory -Path (Get-DeskStateDirectory -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture') -Force | Out-Null
    # THE FIXTURE HOLDS ITS SEAT. The helpers driven below are MUTATORS, and a mutator requires a
    # matching live claim token (step 15b). Holding one here is the faithful test rather than an
    # exemption: a fixture that could mutate without a claim would be proving something production
    # cannot do. The handle lives as long as this process, which is what a claim IS -- the suite
    # ending releases it, exactly as a session ending does.
    Enter-FixtureSeatClaim -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' | Out-Null
    foreach ($relative in @('.claude', 'notebook/topic', 'notebook/second', 'internal/triage-plans', 'shelf')) {
        New-Item -ItemType Directory -Path (Join-Path $fixture $relative) -Force | Out-Null
    }
    Set-Content -LiteralPath (Join-Path $fixture '.claude/.library-project') -Value '00000000-0000-0000-0000-000000000000' -Encoding utf8 -NoNewline
    Set-Content -LiteralPath (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books') -Value '' -Encoding utf8
    Set-Content -LiteralPath (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'projects') -Value '' -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/_master-index.md') -Value "# Notebook Index`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/topic/_index.md') -Value "# Topic`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/topic/alpha.md') -Value "# Alpha`nAlpha body.`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/topic/beta.md') -Value "# Beta`nBeta body.`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/second/_index.md') -Value "# Second`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/second/gamma.md') -Value "# Gamma`nGamma body.`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/_catalog.md') -Value "# Local Shelf`n" -Encoding utf8
    # The tracked header, and the render that makes an empty Shelf catalog a rendered one. Books
    # arrive below through their own entry files.
    Initialize-ShelfCatalogForFixture -FixtureRoot $fixture
}
function New-ShelfFixtureBook([string]$Slug, [string]$Title) {
    $wiki = Join-Path $fixture "shelf/$Slug/wiki"
    New-Item -ItemType Directory -Path $wiki -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $wiki '_book.md'), "# $Title`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $wiki '_index.md'), "# $Title - Reader Map`n`n- [[alpha]]`n- [[beta]]`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $wiki 'alpha.md'), "# Alpha`n`nAlpha body.`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $wiki 'beta.md'), "# Beta`n`nBeta body.`n", [Text.UTF8Encoding]::new($false))
    Set-ShelfCatalogEntryForFixture -FixtureRoot $fixture -Slug $Slug -Title $Title -Line @(
        '- **Summary:** Workflow fixture.',
        '- **Topics:** fixture'
    )
    $desk = Join-Path $toolsDir 'Set-VirtualDesk.ps1'
    & $desk -Action Open -Kind Book -Location Shelf -Slug $Slug -WorkspacePath $fixture | Out-Null
}

try {
    New-Fixture
    $projectCopy = Join-Path $toolsDir 'Copy-LocalPagesToProject.ps1'
    $sharedPublish = Join-Path $toolsDir 'Publish-SharedBookCandidate.ps1'
    $publishShelf = Join-Path $toolsDir 'Publish-ShelfBookToShared.ps1'
    $publishShelfBatch = Join-Path $toolsDir 'Publish-ShelfBookBatchToShared.ps1'
    $triage = Join-Path $toolsDir 'Invoke-LibraryTriage.ps1'
    $archiveProject = Join-Path $toolsDir 'Archive-ProjectHub.ps1'
    $archiveBook = Join-Path $toolsDir 'Archive-SharedBook.ps1'
    $hubEdit = Join-Path $toolsDir 'Edit-ProjectHub.ps1'
    $common = @{ WorkspacePath = $fixture; McpUrl = $mcpUrl }

    # === Edit-ProjectHub marker enforcement and readback ===========================================
    Reset-Store
    [IO.File]::WriteAllText((Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'projects'), "projects/demo`n", [Text.UTF8Encoding]::new($false))
    $hubBody = "# Demo`n`n## Purpose`n`nFixture.`n`n## Now`n`nOrientation.`n`n- [ ] Existing`n`n## Next`n`n- [ ] Later`n"
    Set-Note 'projects/demo/_project.md' $hubBody @{}
    Assert-Refused { & $hubEdit @common -ProjectSlug demo -Mode AppendSection -Section Now -Content '- unmarked' } `
        'add - [ ] or - [x]' 'Hub edit refused an unmarked Now entry before writing'
    Assert-Equal $hubBody $store.Notes['projects/demo/_project.md'].content 'refused Hub edit left the page byte-identical'
    Assert-Refused { & $hubEdit @common -ProjectSlug demo -Mode AppendSection -Section Now -Content "## Escaped`n- [ ] hidden" } `
        'must not contain a level-one or level-two heading' 'Hub edit refused a structural heading bypass'
    $hubWritten = & $hubEdit @common -ProjectSlug demo -Mode AppendSection -Section Now -Content '- [ ] Added safely'
    Assert-True $hubWritten.written 'a marked Now entry was written and read back'
    Assert-True ([string]$store.Notes['projects/demo/_project.md'].content -cmatch '(?m)^- \[ \] Added safely$') 'the readback store contains the marked entry'

    # === A ReplaceBody from notebook/ records copy evidence; NOTHING ELSE DOES =====================
    # Until 2026-09-18 this journal carried no planned_records at all, so Get-JournalEntries fell
    # through to its legacy branch -- which returns @() for a project destination -- and a page this
    # helper had just made byte-identical to its Notebook source still read `known-copy-drifted`.
    # The copy advisory then named it as one to act on while Invoke-LibraryTriage refused it as
    # non-additive, which is a closed loop with no way out.
    #
    # ASSERTED THROUGH Get-LibraryTriageInventory, not by reading the field back. The field is only
    # worth writing if the consumer picks it up, and a test that re-reads what this helper just
    # wrote would pass with the two sides still disagreeing about the hash.
    $inventory = Join-Path $toolsDir 'Get-LibraryTriageInventory.ps1'
    $evidenceDir = Join-Path $fixture 'notebook/evidence'
    New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
    # WITH A BOM, deliberately: PS 5.1's -Encoding utf8 emits one, so a real Notebook file can carry
    # it. The inventory hashes raw bytes while this helper's own Get-Sha256 hashes a decoded string,
    # and those two disagree on exactly this file -- a writer reusing Get-Sha256 records a hash that
    # reads as `known-copy-drifted`, which is the state being fixed. The BOM is the decoy.
    Set-Content -LiteralPath (Join-Path $evidenceDir 'page.md') -Value "# Evidence`n`nBody with a BOM.`n" -Encoding utf8
    Set-Note 'projects/demo/notes/evidence.md' "# Evidence`n`nStale body.`n" @{}

    $preEvidence = & $hubEdit @common -ProjectSlug demo -Page 'notes/evidence' -Mode ReplaceBody -ContentPath 'notebook/evidence/page.md' -Preflight
    $doneEvidence = & $hubEdit @common -ProjectSlug demo -Page 'notes/evidence' -Mode ReplaceBody -ContentPath 'notebook/evidence/page.md' -UserConfirmed -ApprovedPlanId $preEvidence.plan_id
    Assert-True $doneEvidence.written 'a ReplaceBody from a Notebook source was written'
    $evidenceJournal = Get-Content -LiteralPath $doneEvidence.journal_path -Raw | ConvertFrom-Json
    # PROJECTED TO FLAT VALUES BEFORE ASSERTING, never indexed. Indexing [0] into the record set
    # reads fine until the defect this pins is actually present -- and then it throws
    # IndexOutOfRange, which ABORTS the suite instead of reporting a red, taking every later case
    # with it. Found by injecting the regression: a check that cannot fail cleanly is a check that
    # hides its neighbours.
    Assert-Equal 1 (@($evidenceJournal.planned_records).Count) 'a ReplaceBody from notebook/ did not journal exactly one copy record'
    $evidenceSources = @(@($evidenceJournal.planned_records) | ForEach-Object { [string]$_.source })
    Assert-True ($evidenceSources -ccontains 'notebook/evidence/page.md') 'the copy record did not name the Notebook source path'

    $invCovered = & $inventory -WorkspacePath $fixture
    $evidenceRows = @(@($invCovered.pages) | Where-Object { [string]$_.path -ceq 'notebook/evidence/page.md' })
    Assert-Equal 1 $evidenceRows.Count 'the inventory did not report the edited Notebook page exactly once'
    Assert-True (@($evidenceRows | ForEach-Object { [string]$_.copy_status }) -ccontains 'known-current-copy') 'the inventory did not read the edited page as covered'
    Assert-True (@($evidenceRows | ForEach-Object { @($_.known_projects) }) -ccontains 'demo') 'the inventory did not attribute the copy to the Project'

    # THE NEGATIVES, which are what stop this recording a copy that is not one. A wrong
    # `known-current-copy` is far worse than the missing one above: it tells a reset that material
    # is safe when it is not. An append puts the source in as a FRAGMENT of the page.
    Set-Content -LiteralPath (Join-Path $evidenceDir 'fragment.md') -Value "- [ ] A fragment`n" -Encoding utf8
    $appended = & $hubEdit @common -ProjectSlug demo -Mode AppendSection -Section Next -ContentPath 'notebook/evidence/fragment.md'
    $appendJournal = Get-Content -LiteralPath $appended.journal_path -Raw | ConvertFrom-Json
    Assert-Equal 0 (@($appendJournal.planned_records).Count) 'an AppendSection from notebook/ wrongly journalled a copy record'

    # A ReplaceBody whose content never came from a file has no Notebook source to name.
    Set-Note 'projects/demo/notes/inline.md' "# Inline`n`nStale body.`n" @{}
    $preInline = & $hubEdit @common -ProjectSlug demo -Page 'notes/inline' -Mode ReplaceBody -Content "# Inline`n`nRewritten from the command line.`n" -Preflight
    $doneInline = & $hubEdit @common -ProjectSlug demo -Page 'notes/inline' -Mode ReplaceBody -Content "# Inline`n`nRewritten from the command line.`n" -UserConfirmed -ApprovedPlanId $preInline.plan_id
    $inlineJournal = Get-Content -LiteralPath $doneInline.journal_path -Raw | ConvertFrom-Json
    Assert-Equal 0 (@($inlineJournal.planned_records).Count) 'an inline -Content ReplaceBody wrongly journalled a copy record'

    # And a ReplaceBody sourced from OUTSIDE notebook/ -- a scratch file, the ordinary case -- names
    # nothing either, because there is no Notebook page whose coverage it could be evidence of.
    $scratchSource = Join-Path $fixture 'scratch-source.md'
    Set-Content -LiteralPath $scratchSource -Value "# Scratch`n`nNot Notebook material.`n" -Encoding utf8
    Set-Note 'projects/demo/notes/scratch.md' "# Scratch`n`nStale body.`n" @{}
    $preScratch = & $hubEdit @common -ProjectSlug demo -Page 'notes/scratch' -Mode ReplaceBody -ContentPath 'scratch-source.md' -Preflight
    $doneScratch = & $hubEdit @common -ProjectSlug demo -Page 'notes/scratch' -Mode ReplaceBody -ContentPath 'scratch-source.md' -UserConfirmed -ApprovedPlanId $preScratch.plan_id
    $scratchJournal = Get-Content -LiteralPath $doneScratch.journal_path -Raw | ConvertFrom-Json
    Assert-Equal 0 (@($scratchJournal.planned_records).Count) 'a ReplaceBody sourced outside notebook/ wrongly journalled a copy record'

    # The fragment must STILL read uncovered after all of that -- the assertion that goes red if the
    # gate above is ever loosened to "any mode, any source".
    $invNegatives = & $inventory -WorkspacePath $fixture
    $fragmentStatus = @(@($invNegatives.pages) | Where-Object { [string]$_.path -ceq 'notebook/evidence/fragment.md' } | ForEach-Object { [string]$_.copy_status })
    Assert-True ($fragmentStatus -ccontains 'no-known-copy-record') 'an appended fragment was wrongly reported as covered'

    # === Copy-LocalPagesToProject =================================================================
    Reset-Store
    $pre = & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'demo' -Title 'Demo' -Purpose 'Fixture project.' -Preflight
    Assert-True (-not [string]::IsNullOrWhiteSpace($pre.plan_id)) 'project-copy preflight returned a plan_id'
    Assert-Equal 'False' $pre.shared_library_write 'project-copy preflight declares no shared write'
    Assert-Equal 0 (@($store.Notes.Keys | Where-Object { $_ -like 'projects/*' }).Count) 'project-copy preflight wrote nothing'

    Assert-Refused { & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'demo' -Title 'Demo' -Purpose 'Fixture project.' -ApprovedPlanId $pre.plan_id } `
        'rerun with -UserConfirmed' 'project-copy without -UserConfirmed was refused'
    Assert-Refused { & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'demo' -Title 'Demo' -Purpose 'Fixture project.' -UserConfirmed -ApprovedPlanId 'fabricated-plan-id' } `
        'exact plan_id' 'project-copy with a fabricated plan_id was refused'

    # Stale plan_id: the source changes after preflight, so the approved digest no longer describes it.
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/topic/alpha.md') -Value "# Alpha`nAlpha body, revised.`n" -Encoding utf8
    Assert-Refused { & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'demo' -Title 'Demo' -Purpose 'Fixture project.' -UserConfirmed -ApprovedPlanId $pre.plan_id } `
        'exact plan_id' 'project-copy with a plan_id staled by an edited source was refused'

    $pre = & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'demo' -Title 'Demo' -Purpose 'Fixture project.' -Preflight
    $done = & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'demo' -Title 'Demo' -Purpose 'Fixture project.' -UserConfirmed -ApprovedPlanId $pre.plan_id
    Assert-True ($store.Notes.ContainsKey('projects/demo/notes/topic/alpha.md')) 'a confirmed project-copy wrote its first page'
    Assert-True ($store.Notes.ContainsKey('projects/demo/notes/topic/beta.md')) 'a confirmed project-copy wrote its second page'
    Assert-True ($store.Notes.ContainsKey('projects/demo/_project.md')) 'a confirmed project-copy created the Project Hub'

    # Resume: re-running an already-satisfied copy reuses records instead of rewriting them.
    $pre2 = & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'demo' -Title 'Demo' -Purpose 'Fixture project.' -Preflight
    $again = & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'demo' -Title 'Demo' -Purpose 'Fixture project.' -UserConfirmed -ApprovedPlanId $pre2.plan_id
    # READ THE JOURNAL THE HELPER REPORTS, not a recomposition of its filename. Recomposing here
    # made this case fail with 'cannot find path' whenever the naming rule changed -- an absence
    # where the real fault was elsewhere, and loud enough to abort the suite before the case that
    # actually pins the naming rule could run. That rule is asserted once, further down.
    $journal = Get-Content -LiteralPath $again.journal_path -Raw | ConvertFrom-Json
    Assert-Equal 'complete' $journal.state 'a resumed project-copy journalled a complete state'
    # Three records: the topic's _index.md plus alpha.md and beta.md.
    Assert-Equal 3 (@($journal.reused_records).Count) 'a resumed project-copy reused every existing record'
    Assert-Equal 0 (@($journal.created_records).Count) 'a resumed project-copy created nothing the second time'

    # Destination collision: an existing record whose content differs from the approved manifest.
    Set-Note 'projects/demo/notes/topic/beta.md' "# Beta`nSomething else entirely.`n"
    $pre3 = & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'demo' -Title 'Demo' -Purpose 'Fixture project.' -Preflight
    Assert-Refused { & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'demo' -Title 'Demo' -Purpose 'Fixture project.' -UserConfirmed -ApprovedPlanId $pre3.plan_id } `
        'differs from the approved manifest' 'project-copy over a differing existing record was refused'

    # -ReplaceExisting is the documented way through that collision.
    $replaced = & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'demo' -Title 'Demo' -Purpose 'Fixture project.' -ReplaceExisting -UserConfirmed -ApprovedPlanId $pre3.plan_id
    Assert-True ([string]$store.Notes['projects/demo/notes/topic/beta.md'].content -match 'Beta body') 'project-copy with -ReplaceExisting restored the approved content'

    # Partial write: the second page is rejected, so the run fails and journals what it had done.
    Reset-Store
    [void]$store.Faults.WriteFailAlways.Add('projects/partial/notes/topic/beta.md')
    $prePartial = & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'partial' -Title 'Partial' -Purpose 'Fixture project.' -Preflight
    Assert-Refused { & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'partial' -Title 'Partial' -Purpose 'Fixture project.' -UserConfirmed -ApprovedPlanId $prePartial.plan_id } `
        'was rejected' 'project-copy stopped when a page write was rejected'
    # A run that throws returns nothing, so there is no reported journal_path to follow. Locate it
    # from OUTSIDE by slug instead of recomposing the digest, and assert there is exactly one.
    $partialFiles = @(Get-ChildItem -LiteralPath (Join-Path $fixture 'internal/publication-journals') -File -Filter 'project-partial-*.json')
    Assert-Equal 1 $partialFiles.Count 'the partial project-copy did not leave exactly one journal'
    $partialJournal = Get-Content -LiteralPath $partialFiles[0].FullName -Raw | ConvertFrom-Json
    Assert-Equal 'incomplete' $partialJournal.state 'a partially written project-copy journalled an incomplete state'
    Assert-Equal 2 (@($partialJournal.created_records).Count) 'the partial journal records only the pages written before the failure'
    Assert-True ($store.Notes.ContainsKey('projects/partial/notes/topic/alpha.md')) 'the first page survived the partial write'
    Assert-True (-not $store.Notes.ContainsKey('projects/partial/notes/topic/beta.md')) 'the rejected page was not written'

    # Retry after failure: clear the fault and rerun; the good page is reused, the failed one written.
    $store.Faults.WriteFailAlways.Clear()
    $preRetry = & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'partial' -Title 'Partial' -Purpose 'Fixture project.' -Preflight
    $retried = & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'partial' -Title 'Partial' -Purpose 'Fixture project.' -UserConfirmed -ApprovedPlanId $preRetry.plan_id
    $retryJournal = Get-Content -LiteralPath $retried.journal_path -Raw | ConvertFrom-Json
    # The retry reuses the failed run's journal rather than starting a second one for the same work.
    Assert-Equal 1 (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'internal/publication-journals') -File -Filter 'project-partial-*.json')).Count `
        'the retry wrote a second journal for the same source and destination'
    Assert-Equal 'complete' $retryJournal.state 'the retry after a failed write completed'
    Assert-Equal 2 (@($retryJournal.reused_records).Count) 'the retry reused the pages written before the failure'
    Assert-Equal 1 (@($retryJournal.created_records).Count) 'the retry wrote only the page that had failed'

    # Readback mismatch: the write is accepted but the record reads back with different content.
    Reset-Store
    $store.Faults.ReadMutate['projects/mismatch/notes/topic/alpha.md'] = "# Alpha`nTampered on readback.`n"
    $preMismatch = & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'mismatch' -Title 'Mismatch' -Purpose 'Fixture project.' -Preflight
    Assert-Refused { & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'mismatch' -Title 'Mismatch' -Purpose 'Fixture project.' -UserConfirmed -ApprovedPlanId $preMismatch.plan_id } `
        'differs from the approved manifest' 'project-copy rejected a record that read back altered'

    # A substituted record -- right request, different file_path -- must never be accepted as the page.
    Reset-Store
    $store.Faults.ReadWrongPath['projects/swap/notes/topic/alpha.md'] = 'projects/swap/notes/topic/somewhere-else.md'
    $preSwap = & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'swap' -Title 'Swap' -Purpose 'Fixture project.' -Preflight
    Assert-Refused { & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'swap' -Title 'Swap' -Purpose 'Fixture project.' -UserConfirmed -ApprovedPlanId $preSwap.plan_id } `
        'Project copy stopped' 'project-copy rejected a substituted record'

    # === Copy-LocalPagesToProject -- the destination is a parameter (2026-09-08) ===================
    #
    # ADR-0003's decisions/NNNN-slug.md shape had NO implementation until -DestinationDirectory: every
    # route into a Hub reached projects/<slug>/notes/** or one file beside _project, so the
    # subject-follows rule's decisions/ branch had never once been exercised.
    Reset-Store
    $decisionsSource = Join-Path $fixture 'notebook/decide'
    New-Item -ItemType Directory -Path $decisionsSource -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $decisionsSource '0001-first.md'), "# 0001 First`n`nThe first decision.`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $decisionsSource '0002-second.md'), "# 0002 Second`n`nThe second decision.`n", [Text.UTF8Encoding]::new($false))

    # THE DECOY, and it is the reason this fixture exists rather than a bare missing-file assertion.
    # A page already sits at the DEFAULT target -- notes/<sourceName>/<relative>, the folder name
    # reused as the prefix -- carrying different content. Correct code writes decisions/ and never
    # looks here. Code that drops -DestinationDirectory and falls back to the source folder name
    # FINDS this page, compares it against the approved manifest, and reports 'differs from the
    # approved manifest': a wrong VERDICT about a real page, not a file it could not locate.
    $decoyPath = 'projects/decide-dest/notes/decide/0001-first.md'
    $decoyBody = "# 0001 First`n`nA DECOY at the default target. A correct run never reads this.`n"
    Set-Note $decoyPath $decoyBody @{}

    $preDest = & $projectCopy @common -SourcePath 'notebook/decide' -ProjectSlug 'decide-dest' -Title 'Decide' -Purpose 'Fixture project.' -DestinationDirectory 'decisions' -Preflight
    # SHAPE BEFORE VALUES: under StrictMode a missing property throws PropertyNotFound, which is a
    # red that names nothing. Enumerate the names rather than reading the aggregate .Name (family 4).
    Assert-True (@($preDest.PSObject.Properties | ForEach-Object { $_.Name }) -ccontains 'destination_directory') `
        'the project-copy plan carries no destination_directory field'
    Assert-Equal 'decisions' $preDest.destination_directory 'the preflight did not report the destination it was given'
    $plannedPaths = @($preDest.planned_project_records | ForEach-Object { [string]$_.path })
    Assert-True ($plannedPaths -ccontains 'projects/decide-dest/decisions/0001-first.md') `
        "the preflight planned '$($plannedPaths -join ', ')' rather than the decisions/ path"
    Assert-True (-not @($plannedPaths | Where-Object { $_ -clike '*/notes/*' })) `
        "an explicit destination still planned a notes/ path: '$($plannedPaths -join ', ')'"

    $doneDest = & $projectCopy @common -SourcePath 'notebook/decide' -ProjectSlug 'decide-dest' -Title 'Decide' -Purpose 'Fixture project.' -DestinationDirectory 'decisions' -UserConfirmed -ApprovedPlanId $preDest.plan_id
    Assert-True ($store.Notes.ContainsKey('projects/decide-dest/decisions/0001-first.md')) 'the copy did not create the first decisions/ page'
    Assert-True ($store.Notes.ContainsKey('projects/decide-dest/decisions/0002-second.md')) 'the copy did not create the second decisions/ page'
    Assert-True ($store.Notes.ContainsKey('projects/decide-dest/_project.md')) 'the copy did not create the Project Hub it wrote decisions into'
    Assert-True (-not $store.Notes.ContainsKey('projects/decide-dest/notes/decide/0002-second.md')) 'the copy also wrote the source folder name under notes/'
    Assert-Equal $decoyBody ([string]$store.Notes[$decoyPath].content) 'the decoy at the default target was overwritten, so the destination fell back to the source folder name'
    # THOSE KEYS ARE THE WIRE, not the helper's summary. The stub composes every stored path as
    # "$directory/$title.md" out of the write_note ARGUMENTS it received, so a key at
    # projects/decide-dest/decisions/0001-first.md is proof that `directory` reached the endpoint as
    # projects/decide-dest/decisions -- the argument the old code derived from the source folder.

    # PROVENANCE SURVIVES NESTING. The source label is built relative to the resolved root, not from
    # the leaf folder's name: a source at notebook/<project>/decisions/ used to label its records
    # `notebook/decisions/<file>`, dropping the middle segment. Get-LibraryTriageInventory reads that
    # field to decide whether a Notebook page already has a copy record, so the wrong label credits a
    # page that does not exist and leaves the real one reading no-known-copy-record. Found by reading
    # a real preflight's planned records, which is why the assertion is on the label's exact value
    # rather than on its shape.
    $nested = Join-Path $fixture 'notebook/topic/nested-decisions'
    New-Item -ItemType Directory -Path $nested -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $nested '0001-deep.md'), "# 0001 Deep`n`nNested two levels below the Notebook root.`n", [Text.UTF8Encoding]::new($false))
    $preNest = & $projectCopy @common -SourcePath 'notebook/topic/nested-decisions' -ProjectSlug 'nest-dest' -Title 'Nest' -Purpose 'Fixture project.' -DestinationDirectory 'decisions' -Preflight
    $nestLabels = @($preNest.planned_project_records | ForEach-Object { [string]$_.source_path })
    Assert-True ($nestLabels -ccontains 'notebook/topic/nested-decisions/0001-deep.md') `
        "a nested source labelled its record '$($nestLabels -join ', ')' rather than its real path below notebook/"
    Assert-True (-not ($nestLabels -ccontains 'notebook/nested-decisions/0001-deep.md')) `
        'the source label was built from the leaf folder name, dropping the intervening topic'
    Remove-Item -LiteralPath $nested -Recurse -Force

    # A TOPIC-LEVEL SOURCE IS UNCHANGED by that fix, which is every pre-existing caller.
    $preFlat = & $projectCopy @common -SourcePath 'notebook/second' -ProjectSlug 'flat-dest' -Title 'Flat' -Purpose 'Fixture project.' -Preflight
    Assert-True (@($preFlat.planned_project_records | ForEach-Object { [string]$_.source_path }) -ccontains 'notebook/second/gamma.md') `
        'a topic-level source stopped labelling its records notebook/<topic>/<file>'

    # THE APPROVAL BINDS THE DESTINATION. $manifestDigest hashes source|PATH|sha256, so a plan_id
    # approved for decisions/ cannot be spent on a run that lands the same pages somewhere else.
    Reset-Store
    $preBind = & $projectCopy @common -SourcePath 'notebook/decide' -ProjectSlug 'bind-dest' -Title 'Bind' -Purpose 'Fixture project.' -DestinationDirectory 'decisions' -Preflight
    Assert-Refused { & $projectCopy @common -SourcePath 'notebook/decide' -ProjectSlug 'bind-dest' -Title 'Bind' -Purpose 'Fixture project.' -DestinationDirectory 'elsewhere' -UserConfirmed -ApprovedPlanId $preBind.plan_id } `
        'exact plan_id' 'a plan_id approved for one destination was spent on another'
    Assert-Refused { & $projectCopy @common -SourcePath 'notebook/decide' -ProjectSlug 'bind-dest' -Title 'Bind' -Purpose 'Fixture project.' -UserConfirmed -ApprovedPlanId $preBind.plan_id } `
        'exact plan_id' 'a plan_id approved for decisions/ was spent on the default notes/ route'
    Assert-Equal 0 (@($store.Notes.Keys | Where-Object { $_ -clike 'projects/bind-dest/*' }).Count) 'a refused destination swap still wrote pages'

    # TWO DESTINATIONS FROM ONE SOURCE ARE TWO OPERATIONS, and each keeps its own completion record.
    # The journal was keyed on the source digest, which could not tell them apart.
    Reset-Store
    $preJourA = & $projectCopy @common -SourcePath 'notebook/decide' -ProjectSlug 'twodest' -Title 'Two' -Purpose 'Fixture project.' -DestinationDirectory 'decisions' -Preflight
    $doneJourA = & $projectCopy @common -SourcePath 'notebook/decide' -ProjectSlug 'twodest' -Title 'Two' -Purpose 'Fixture project.' -DestinationDirectory 'decisions' -UserConfirmed -ApprovedPlanId $preJourA.plan_id
    $preJourB = & $projectCopy @common -SourcePath 'notebook/decide' -ProjectSlug 'twodest' -Title 'Two' -Purpose 'Fixture project.' -Preflight
    $doneJourB = & $projectCopy @common -SourcePath 'notebook/decide' -ProjectSlug 'twodest' -Title 'Two' -Purpose 'Fixture project.' -UserConfirmed -ApprovedPlanId $preJourB.plan_id
    Assert-True ($doneJourA.journal_path -cne $doneJourB.journal_path) 'both destinations wrote the same journal, so the first set of paths was lost'
    foreach ($pair in @(@{ path = $doneJourA.journal_path; expect = 'decisions' }, @{ path = $doneJourB.journal_path; expect = '(default)' })) {
        $doc = ([IO.File]::ReadAllText($pair.path)) | ConvertFrom-Json
        Assert-True (@($doc.PSObject.Properties | ForEach-Object { $_.Name }) -ccontains 'destination_directory') `
            "the journal at $($pair.path) carries no destination_directory field"
        Assert-Equal 'complete' $doc.state "the $($pair.expect) journal did not record a complete state"
        Assert-Equal $pair.expect $doc.destination_directory 'the journal did not record the destination it wrote to'
    }

    # CONTAINMENT AND CASE, refused by a segment WHITELIST rather than by enumerating attacks: '..',
    # a drive letter, an uppercase segment and a space are all simply not spellable under the rule.
    foreach ($bad in @('../elsewhere', '..', 'notes/../..', 'C:/somewhere', 'Decisions', 'with space', 'trailing-', '.')) {
        Assert-Refused { & $projectCopy @common -SourcePath 'notebook/decide' -ProjectSlug 'decide-dest' -Title 'Decide' -Purpose 'Fixture project.' -DestinationDirectory $bad -Preflight } `
            'must use lowercase letters, digits, and single hyphens' "DestinationDirectory '$bad' was accepted"
    }
    Assert-Refused { & $projectCopy @common -SourcePath 'notebook/decide' -ProjectSlug 'decide-dest' -Title 'Decide' -Purpose 'Fixture project.' -DestinationDirectory '   ' -Preflight } `
        'at least one directory below' 'an empty DestinationDirectory was accepted'
    Assert-Refused { & $projectCopy @common -SourcePath 'notebook/decide' -ProjectSlug 'decide-dest' -Title 'Decide' -Purpose 'Fixture project.' -DestinationDirectory 'decisions' -AtProjectRoot -Preflight } `
        'pass one, not both' 'DestinationDirectory and AtProjectRoot were accepted together'

    # A leading separator NORMALISES rather than escaping: it is trimmed, and the result stays under
    # projects/<slug>/. Asserted as an accepted value, so the trim cannot quietly become a passthrough.
    $preNorm = & $projectCopy @common -SourcePath 'notebook/decide' -ProjectSlug 'decide-dest' -Title 'Decide' -Purpose 'Fixture project.' -DestinationDirectory '/decisions/' -Preflight
    Assert-Equal 'decisions' $preNorm.destination_directory 'a separator-wrapped DestinationDirectory did not normalise to its segments'
    Assert-True (@($preNorm.planned_project_records | ForEach-Object { [string]$_.path }) -ccontains 'projects/decide-dest/decisions/0001-first.md') `
        'a separator-wrapped destination did not compose the same path as the bare one'

    # THE THREE RESERVED ROOT PAGES. New-ProjectHub seeds _project and connections; only
    # Edit-ProjectHub rewrites the root, journalling a previous body, holding the projects/<slug>
    # lock and verifying the readback. Guard-BasicMemoryRead refuses a write_note to a Hub root on
    # the DIRECT path, and a copy helper must not be the side door around it. -AtProjectRoot is the
    # only route that can put a page at the root, and until now nothing exercised it at all.
    #
    # TWO DIRECTORIES, and the reason is Windows. NTFS is case-insensitive, so '_project.md' and
    # '_Project.md' in one folder are ONE file: the second write would overwrite the first, Get-Item
    # would hand back the on-disk casing, and the cased variant would silently re-test the lowercase
    # name while reading as though it had proved the denylist is case-insensitive.
    foreach ($group in @(@{ dir = 'reserved'; names = @('_project', 'connections', 'README') },
                         @{ dir = 'reserved-cased'; names = @('_Project', 'Connections', 'readme') })) {
        $reservedSource = Join-Path $fixture "notebook/$($group.dir)"
        New-Item -ItemType Directory -Path $reservedSource -Force | Out-Null
        foreach ($name in $group.names) {
            [IO.File]::WriteAllText((Join-Path $reservedSource "$name.md"), "# $name`n`nMust never land beside _project.`n", [Text.UTF8Encoding]::new($false))
            Assert-Refused { & $projectCopy @common -SourcePath "notebook/$($group.dir)/$name.md" -ProjectSlug 'decide-dest' -Title 'Decide' -Purpose 'Fixture project.' -AtProjectRoot -Preflight } `
                'is a Project root page' "-AtProjectRoot accepted the reserved root page '$name'"
        }
    }
    # The same names are ordinary pages one directory down, which is the boundary being drawn.
    $preNested = & $projectCopy @common -SourcePath 'notebook/reserved/connections.md' -ProjectSlug 'decide-dest' -Title 'Decide' -Purpose 'Fixture project.' -DestinationDirectory 'decisions' -Preflight
    Assert-True (@($preNested.planned_project_records | ForEach-Object { [string]$_.path }) -ccontains 'projects/decide-dest/decisions/connections.md') `
        'a reserved NAME was refused one directory below the root, where it is an ordinary page'

    # === Publish-SharedBookCandidate ==============================================================
    Reset-Store
    $preBook = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'demo-book' -BookTitle 'Demo Book' -Summary 'A fixture Book.' -Preflight
    Assert-True (-not [string]::IsNullOrWhiteSpace($preBook.plan_id)) 'shared publish preflight returned a plan_id'
    Assert-Equal 'False' $preBook.shared_library_write 'shared publish preflight declares no shared write'
    Assert-Equal 0 (@($store.Notes.Keys | Where-Object { $_ -like 'books/demo-book/*' }).Count) 'shared publish preflight wrote nothing'

    Assert-Refused { & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'demo-book' -BookTitle 'Demo Book' -Summary 'A fixture Book.' -ApprovedPlanId $preBook.plan_id } `
        'rerun with -UserConfirmed' 'shared publish without -UserConfirmed was refused'
    Assert-Refused { & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'demo-book' -BookTitle 'Demo Book' -Summary 'A fixture Book.' -UserConfirmed -ApprovedPlanId 'fabricated-plan-id' } `
        'exact plan_id' 'shared publish with a fabricated plan_id was refused'

    Set-Content -LiteralPath (Join-Path $fixture 'notebook/topic/beta.md') -Value "# Beta`nBeta body, revised.`n" -Encoding utf8
    Assert-Refused { & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'demo-book' -BookTitle 'Demo Book' -Summary 'A fixture Book.' -UserConfirmed -ApprovedPlanId $preBook.plan_id } `
        'exact plan_id' 'shared publish with a plan_id staled by an edited source was refused'

    $preBook = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'demo-book' -BookTitle 'Demo Book' -Summary 'A fixture Book.' -Preflight
    $publishedBook = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'demo-book' -BookTitle 'Demo Book' -Summary 'A fixture Book.' -UserConfirmed -ApprovedPlanId $preBook.plan_id
    Assert-True ($store.Notes.ContainsKey('books/demo-book/wiki/_book.md')) 'a confirmed shared publish wrote the Book root'
    Assert-True ($store.Notes.ContainsKey('books/demo-book/wiki/_index.md')) 'a confirmed shared publish wrote the reader map'
    Assert-True ($store.Notes.ContainsKey('books/demo-book/wiki/topic/alpha.md')) 'a confirmed shared publish wrote a source page'
    Assert-True ([string]$store.Notes['books/README.md'].content -match 'demo-book') 'a confirmed shared publish listed the Book in the Catalog'

    # Generated roots gain store frontmatter even though their submitted content has none. A
    # leading newline in that root's readback is an edge difference, not a changed body.
    $leadingRootPath = 'books/leading-newline-book/wiki/_book.md'
    $leadingRootBody = "# Leading Newline Book`n`n## Purpose`n`nA fixture Book.`n`n## Reader map`n`n- [[books/leading-newline-book/wiki/_index|Open the reader map]]`n"
    $store.Faults.ReadMutate[$leadingRootPath] = "`n$leadingRootBody"
    $preLeadingRoot = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'leading-newline-book' -BookTitle 'Leading Newline Book' -Summary 'A fixture Book.' -Preflight
    $publishedLeadingRoot = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'leading-newline-book' -BookTitle 'Leading Newline Book' -Summary 'A fixture Book.' -UserConfirmed -ApprovedPlanId $preLeadingRoot.plan_id
    Assert-Equal 'True' $publishedLeadingRoot.publication_complete 'shared publish rejected a generated root with a leading readback newline'

    # A store may also omit the submitted trailing newline. Verification trims that edge on both
    # sides for every record, including a generated root with no literal source frontmatter.
    $trailingRootPath = 'books/trailing-newline-book/wiki/_book.md'
    $trailingRootBody = "# Trailing Newline Book`n`n## Purpose`n`nA fixture Book.`n`n## Reader map`n`n- [[books/trailing-newline-book/wiki/_index|Open the reader map]]`n"
    $store.Faults.ReadMutate[$trailingRootPath] = $trailingRootBody.TrimEnd([char[]]"`r`n")
    $preTrailingRoot = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'trailing-newline-book' -BookTitle 'Trailing Newline Book' -Summary 'A fixture Book.' -Preflight
    $publishedTrailingRoot = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'trailing-newline-book' -BookTitle 'Trailing Newline Book' -Summary 'A fixture Book.' -UserConfirmed -ApprovedPlanId $preTrailingRoot.plan_id
    Assert-Equal 'True' $publishedTrailingRoot.publication_complete 'shared publish rejected a generated root with its trailing readback newline removed'

    # Destination collision: the Book already exists and the run was not told to replace it.
    $preCollide = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/second' -BookSlug 'demo-book' -BookTitle 'Demo Book' -Summary 'A different source.' -Preflight
    Assert-Refused { & $sharedPublish @common -Destination Shared -SourcePath 'notebook/second' -BookSlug 'demo-book' -BookTitle 'Demo Book' -Summary 'A different source.' -UserConfirmed -ApprovedPlanId $preCollide.plan_id } `
        'different source or manifest' 'shared publish over an existing Book from a different source was refused'

    # Resume: an interrupted publish is completed by rerunning the same approved plan. This is the
    # case the refusal above is guarding -- resume is allowed only when the manifest still matches.
    Reset-Store
    [void]$store.Faults.WriteFailAlways.Add('books/resume-book/wiki/topic/beta.md')
    $preResume = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'resume-book' -BookTitle 'Resume Book' -Summary 'A fixture Book.' -Preflight
    Assert-Refused { & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'resume-book' -BookTitle 'Resume Book' -Summary 'A fixture Book.' -UserConfirmed -ApprovedPlanId $preResume.plan_id } `
        'rejected' 'shared publish stopped when a page write was rejected'
    Assert-True ($store.Notes.ContainsKey('books/resume-book/wiki/_book.md')) 'the interrupted publish had already written the Book root'
    Assert-True (-not $store.Notes.ContainsKey('books/resume-book/wiki/topic/beta.md')) 'the rejected page was not written'

    $store.Faults.WriteFailAlways.Clear()
    $resumed = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'resume-book' -BookTitle 'Resume Book' -Summary 'A fixture Book.' -UserConfirmed -ApprovedPlanId $preResume.plan_id
    Assert-True ($store.Notes.ContainsKey('books/resume-book/wiki/topic/beta.md')) 'resuming the interrupted publish wrote the missing page'

    # A difference in the body proper must still fail with the post-write diagnostic.
    Reset-Store
    $store.Faults.ReadMutate['books/mismatch-book/wiki/_book.md'] = "# Not what was written`n"
    $preBad = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'mismatch-book' -BookTitle 'Mismatch Book' -Summary 'A fixture Book.' -Preflight
    Assert-Refused { & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'mismatch-book' -BookTitle 'Mismatch Book' -Summary 'A fixture Book.' -UserConfirmed -ApprovedPlanId $preBad.plan_id } `
        "Page 'books/mismatch-book/wiki/_book.md' did not read back as written" 'shared publish rejected a Book root that read back altered with the post-write message'

    # --- The Catalog line a refresh owns (2026-09-10) ---------------------------------------------
    # THE DEFECT: a refresh could not update the Catalog entry it owns, and reported that it had.
    # Only two branches could issue an edit -- the wikilink being absent, or the LEGACY candidate
    # string matching exactly -- so an existing modern entry got no edit at all while
    # catalog_updated was set to $true unconditionally. Live damage: books/README advertised
    # 'Orca 1.4.178-rc.2 ... at commit 36e139e on 2026-09-02' for a Book whose _book page said
    # 1.4.197. The stale summary is a DECOY rather than an absence check: a wrong implementation
    # leaves a plausible wrong version string in the Catalog, not a missing line.
    Reset-Store
    New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/catalog') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/catalog/_index.md') -Value "# Catalog Topic`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/catalog/alpha.md') -Value "# Alpha`nFirst generation.`n" -Encoding utf8
    $staleSummary = 'Orca 1.4.178-rc.2, at commit 36e139e on 2026-09-02.'
    $freshSummary = 'Orca 1.4.197, at commit deadbee on 2026-09-10.'
    $catalogArgs = @{ Destination = 'Shared'; SourcePath = 'notebook/catalog'; BookSlug = 'catalog-book'; BookTitle = 'Catalog Book'; Collection = 'Reference' }

    $preInsert = & $sharedPublish @common @catalogArgs -Summary $staleSummary -Preflight
    $inserted = & $sharedPublish @common @catalogArgs -Summary $staleSummary -UserConfirmed -ApprovedPlanId $preInsert.plan_id
    Assert-Equal 'inserted' $inserted.catalog_entry_state 'a first publish did not report inserting its Catalog entry'
    Assert-Equal 'True' $inserted.catalog_updated 'a first publish denied issuing the Catalog edit it issued'
    Assert-Equal 'True' $inserted.catalog_entry_verified 'a first publish did not verify its Catalog entry'
    Assert-Equal "- [[books/catalog-book/wiki/_book|Catalog Book]] $([char]0x2014) $staleSummary" (Get-CatalogEntryLine 'books/catalog-book/wiki') `
        'a first publish did not write exactly one Catalog entry line carrying its summary'

    # THE ASSERTION A HARDCODED $true DIES AT. Nothing about the Book or its summary changed, so the
    # correct Catalog operation is none at all -- and a field reporting one anyway is precisely the
    # defect family this repository keeps paying for.
    $preNoop = & $sharedPublish @common @catalogArgs -Summary $staleSummary -Preflight
    $catalogBeforeNoop = [string]$store.Notes['books/README.md'].content
    $noop = & $sharedPublish @common @catalogArgs -Summary $staleSummary -UserConfirmed -ApprovedPlanId $preNoop.plan_id
    Assert-Equal 'already-current' $noop.catalog_entry_state 'a republication with an unchanged summary claimed a Catalog change'
    Assert-Equal 'False' $noop.catalog_updated 'catalog_updated reported an edit that was never issued'
    Assert-Equal 'True' $noop.catalog_entry_verified 'a correct Catalog no-op did not verify the entry it left alone'
    Assert-Equal $catalogBeforeNoop ([string]$store.Notes['books/README.md'].content) 'a no-op republication rewrote the Catalog anyway'

    # THE REFRESH ITSELF: source and summary both change, which is what -ReplaceExisting is for.
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/catalog/alpha.md') -Value "# Alpha`nSecond generation.`n" -Encoding utf8
    $preRefresh = & $sharedPublish @common @catalogArgs -Summary $freshSummary -Preflight
    $refreshed = & $sharedPublish @common @catalogArgs -Summary $freshSummary -ReplaceExisting -UserConfirmed -ApprovedPlanId $preRefresh.plan_id
    Assert-Equal 'replaced' $refreshed.catalog_entry_state 'a refresh did not report replacing the Catalog entry it owns'
    Assert-Equal 'True' $refreshed.catalog_updated 'a refresh denied issuing the Catalog edit it issued'
    Assert-Equal '' $refreshed.catalog_entry_moved_from 'a refresh within one collection was reported as a move'
    Assert-Equal '## Reference' $refreshed.catalog_entry_heading 'a refresh misreported which collection its entry is filed under'
    Assert-True ([string]$store.Notes['books/README.md'].content -cnotmatch [regex]::Escape($staleSummary)) `
        'the refresh left the stale summary still advertised in the Catalog'
    # AGREEMENT WITH _book, DERIVED rather than retyped: the expected summary is read back out of the
    # published root's own '## Purpose' body, which is the surface that disagreed with books/README
    # live. Retyping the literal here would prove only that the test agrees with itself.
    $publishedRoot = [string]$store.Notes['books/catalog-book/wiki/_book.md'].content
    $purpose = if ($publishedRoot -match '(?ms)^## Purpose\r?\n\r?\n(.+?)\r?\n\r?\n## Reader map') { [string]$Matches[1] } else { '<the published root carries no ## Purpose body>' }
    Assert-Equal "- [[books/catalog-book/wiki/_book|Catalog Book]] $([char]0x2014) $purpose" (Get-CatalogEntryLine 'books/catalog-book/wiki') `
        'the Catalog entry disagrees with the ## Purpose body of the Book root it describes'

    # A RETITLE MUST NOT FORK THE ENTRY. The line is found by link target, so a changed display
    # title updates the same line. Matching the rendered title instead -- which is what the absent
    # branch did -- inserts a second line and leaves the old title advertised beside the new one.
    $retitleArgs = @{ Destination = 'Shared'; SourcePath = 'notebook/catalog'; BookSlug = 'catalog-book'; BookTitle = 'Catalog Book Renamed'; Collection = 'Reference' }
    $preRetitle = & $sharedPublish @common @retitleArgs -Summary $freshSummary -Preflight
    $retitled = & $sharedPublish @common @retitleArgs -Summary $freshSummary -ReplaceExisting -UserConfirmed -ApprovedPlanId $preRetitle.plan_id
    Assert-Equal 'replaced' $retitled.catalog_entry_state 'a retitled Book did not replace its own Catalog line'
    Assert-Equal "- [[books/catalog-book/wiki/_book|Catalog Book Renamed]] $([char]0x2014) $freshSummary" (Get-CatalogEntryLine 'books/catalog-book/wiki') `
        'a retitled Book forked its Catalog entry instead of updating the line it owns'
    Assert-True ([string]$store.Notes['books/README.md'].content -cnotmatch [regex]::Escape('|Catalog Book]]')) `
        'the old title stayed advertised in the Catalog after a retitle'

    # THE READBACK IS THE AGREEMENT CHECK, and it needs its own fault to be falsifiable at all. A
    # Catalog that reads back carrying this Book's wikilink but a DIFFERENT summary is exactly what
    # the live defect produced, and a readback looking only for the wikilink is what let it report
    # success. The fault returns a plausible stale line rather than a missing one, so a weakened
    # check reports a wrong value instead of naming an absent file.
    Reset-Store
    $phantomStale = "- [[books/phantom-book/wiki/_book|Phantom Book]] $([char]0x2014) A summary the Book no longer carries."
    $phantomCatalog = "# Book Catalog`n`n## Projects`n`n## Reference`n`n$phantomStale`n`n## Workflows`n`n## Open a Book`n"
    Set-Note 'books/README.md' $phantomCatalog
    $store.Faults.ReadMutate['books/README.md'] = $phantomCatalog
    $phantomArgs = @{ Destination = 'Shared'; SourcePath = 'notebook/catalog'; BookSlug = 'phantom-book'; BookTitle = 'Phantom Book'; Collection = 'Reference'; Summary = 'Current summary.' }
    $prePhantom = & $sharedPublish @common @phantomArgs -Preflight
    Assert-Refused { & $sharedPublish @common @phantomArgs -UserConfirmed -ApprovedPlanId $prePhantom.plan_id } `
        'current entry line exactly once' 'a Catalog reading back with a different summary was accepted as verified'
    # And the refusal is about the READBACK, not about the edit: the edit it planned was issued and
    # the stored Catalog carries the fresh line. Without this the case above would also pass for a
    # publisher that never edited the Catalog at all.
    $store.Faults.ReadMutate.Clear()
    Assert-Equal "- [[books/phantom-book/wiki/_book|Phantom Book]] $([char]0x2014) Current summary." (Get-CatalogEntryLine 'books/phantom-book/wiki') `
        'the readback refusal was reached without the planned Catalog edit having been issued'

    # THE LEGACY WORDING the removed branch matched by name. The general replacement subsumes it, so
    # a check is what keeps that behaviour provable now that no branch names it.
    Reset-Store
    Set-Note 'books/README.md' "# Book Catalog`n`n## Reference`n`n- [[books/legacy-book/wiki/_book|Legacy Book]] $([char]0x2014) **Candidate** (Local notebook copy, version 0.1.0). Older wording.`n`n## Open a Book`n"
    $preLegacy = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/catalog' -BookSlug 'legacy-book' -BookTitle 'Legacy Book' -Collection Reference -Summary 'Modern wording.' -Preflight
    $legacyDone = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/catalog' -BookSlug 'legacy-book' -BookTitle 'Legacy Book' -Collection Reference -Summary 'Modern wording.' -UserConfirmed -ApprovedPlanId $preLegacy.plan_id
    Assert-Equal 'replaced' $legacyDone.catalog_entry_state 'a legacy candidate entry was not replaced'
    Assert-Equal "- [[books/legacy-book/wiki/_book|Legacy Book]] $([char]0x2014) Modern wording." (Get-CatalogEntryLine 'books/legacy-book/wiki') `
        'the legacy candidate line was not upgraded to the modern entry'
    Assert-True ([string]$store.Notes['books/README.md'].content -cnotmatch 'Local notebook copy') 'the legacy candidate wording survived the publish'

    # TWO LINES SHARING ONE LINK TARGET: refused rather than guessed between. expected_replacements
    # would have refused the edit anyway, but with the endpoint's message instead of one naming the
    # Catalog -- and the journal must still say 'copying', because the Catalog step did not finish.
    Reset-Store
    Set-Note 'books/README.md' "# Book Catalog`n`n## Reference`n`n- [[books/twice-book/wiki/_book|Twice Book]] $([char]0x2014) One.`n- [[books/twice-book/wiki/_book|Twice Book]] $([char]0x2014) Two.`n`n## Open a Book`n"
    $preTwice = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/catalog' -BookSlug 'twice-book' -BookTitle 'Twice Book' -Collection Reference -Summary 'Three.' -Preflight
    Assert-Refused { & $sharedPublish @common -Destination Shared -SourcePath 'notebook/catalog' -BookSlug 'twice-book' -BookTitle 'Twice Book' -Collection Reference -Summary 'Three.' -UserConfirmed -ApprovedPlanId $preTwice.plan_id } `
        'it will not guess which one this publication owns' 'two Catalog lines sharing one link target were not refused'
    $twiceJournal = [IO.File]::ReadAllText((Join-Path $fixture "internal/publication-journals/twice-book-$($preTwice.source_digest_sha256).json")) | ConvertFrom-Json
    Assert-Equal 'copying' $twiceJournal.state 'a refused Catalog step journalled the publication as complete'

    # ONE ENTRY SHAPE, TWO WRITERS. Add-CatalogEntry.ps1 is the documented repair route for a Book
    # missing its line, and the publisher now REPLACES whatever line it finds. If the two shapes
    # drifted, every refresh would rewrite a correct line forever and report 'replaced' each time.
    # Both real implementations, one fixture, the line pinned -- not one reimplemented from the other.
    Reset-Store
    $shapeSummary = 'One derivation, two writers.'
    $preShape = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/catalog' -BookSlug 'shape-book' -BookTitle 'Shape Book' -Collection Reference -Summary $shapeSummary -Preflight
    $shape = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/catalog' -BookSlug 'shape-book' -BookTitle 'Shape Book' -Collection Reference -Summary $shapeSummary -UserConfirmed -ApprovedPlanId $preShape.plan_id
    $publisherLine = Get-CatalogEntryLine 'books/shape-book/wiki'
    Assert-Equal $shape.catalog_entry $publisherLine 'the reported catalog_entry is not the line the Catalog actually carries'
    Set-Note 'books/README.md' "# Book Catalog`n`n## Reference`n`n## Open a Book`n"
    & (Join-Path $toolsDir 'Add-CatalogEntry.ps1') -Slug 'shape-book' -Title 'Shape Book' -Summary $shapeSummary -Collection Reference -McpUrl $mcpUrl -UserConfirmed | Out-Null
    Assert-Equal $publisherLine (Get-CatalogEntryLine 'books/shape-book/wiki') `
        'the publisher and Add-CatalogEntry write different Catalog entry shapes for the same Book'

    # --- A collection change MOVES the Catalog line (2026-09-18) ----------------------------------
    # THE DEFECT, found by reading on 2026-09-10 and never observed live: -Collection rewrites the
    # Book root's `collection` metadata, but the replacing branch above rewrote the entry line WHERE
    # IT ALREADY SAT, and Update-BookCatalog only ever returned the heading an INSERT would use. So
    # a Book moved from Reference to Workflows ended with a root saying Workflows and a Catalog
    # still listing it under Reference, while every reported field stayed true OF THE LINE.
    #
    # THIS FIXTURE PICKS THE QUIETEST FORM ON PURPOSE. Title and summary are unchanged, so only the
    # collection moves -- which means the old code issued NO EDIT AT ALL and reported
    # 'already-current' about a correct-looking line in the wrong section. The wrong implementation
    # therefore leaves a PLAUSIBLE Catalog rather than a broken one, which is why every assertion
    # below is about placement and not about the text of the line.
    Reset-Store
    $moveSummary = 'A Book that changes collections.'
    $moveArgs = @{ Destination = 'Shared'; SourcePath = 'notebook/catalog'; BookSlug = 'move-book'; BookTitle = 'Move Book'; Summary = $moveSummary }
    $preFiled = & $sharedPublish @common @moveArgs -Collection Reference -Preflight
    $filed = & $sharedPublish @common @moveArgs -Collection Reference -UserConfirmed -ApprovedPlanId $preFiled.plan_id
    Assert-Equal 'inserted' $filed.catalog_entry_state 'the first publish of the move fixture did not insert its entry'
    Assert-Equal '## Reference' $filed.catalog_entry_heading 'a first publish did not report which collection it filed the entry under'
    Assert-Equal '' $filed.catalog_entry_moved_from 'a first publish reported moving an entry that had never been listed'

    $preMoved = & $sharedPublish @common @moveArgs -Collection Workflows -Preflight
    $moved = & $sharedPublish @common @moveArgs -Collection Workflows -ReplaceExisting -UserConfirmed -ApprovedPlanId $preMoved.plan_id
    Assert-Equal 'moved' $moved.catalog_entry_state 'a collection change was not reported as a move'
    Assert-Equal '## Reference' $moved.catalog_entry_moved_from 'the move did not report the collection it came from'
    Assert-Equal '## Workflows' $moved.catalog_entry_heading 'the move did not report the collection it filed the entry under'
    Assert-Equal 'True' $moved.catalog_updated 'the move denied issuing the Catalog edits it issued'
    Assert-Equal 'True' $moved.catalog_entry_verified 'the move did not verify its Catalog entry'

    # THE TOTAL IS COUNTED FIRST, AND FROM OUTSIDE ANY SECTION FILTER. 'Exactly one entry under the
    # new heading' passes just as happily on a Catalog that now lists this Book TWICE, which is what
    # an insert-without-remove implementation produces.
    $movedEntry = "- [[books/move-book/wiki/_book|Move Book]] $([char]0x2014) $moveSummary"
    Assert-Equal 1 @(Get-CatalogEntryLines 'books/move-book/wiki').Count 'a collection change did not leave exactly one entry line in the whole Catalog'
    Assert-Equal $movedEntry (Get-CatalogEntryLine 'books/move-book/wiki') 'the moved line is not the entry this Book owns'
    $movedHeadings = @(Get-CatalogEntryHeadings 'books/move-book/wiki')
    Assert-Equal '## Workflows' ($movedHeadings -join ', ') 'the Catalog files this Book somewhere other than the collection it was moved to'
    Assert-Equal 0 @($movedHeadings | Where-Object { $_ -ceq '## Reference' }).Count 'the collection the Book was moved OUT of still lists it'
    Assert-True (([string]$store.Notes['books/README.md'].content).Contains("## Workflows`n`n$movedEntry")) `
        'the moved entry is not filed directly under the requested collection heading'
    # AND THE TWO SURFACES AGREE, which is the fact the defect broke: the root says Workflows too.
    Assert-Equal 'Workflows' ([string]$store.Notes['books/move-book/wiki/_book.md'].frontmatter['collection']) `
        'the Book root did not record the collection the publish was given'

    # THE SECOND DIRECTION, AND THE ONE A FIX FORGETS. A Book whose collection did NOT change must
    # still report 'already-current', must not be reported as moved, and must not rewrite a byte --
    # a publisher that moves every entry it touches is a different defect wearing this one's fix.
    $preSame = & $sharedPublish @common @moveArgs -Collection Workflows -Preflight
    $catalogBeforeSame = [string]$store.Notes['books/README.md'].content
    $same = & $sharedPublish @common @moveArgs -Collection Workflows -UserConfirmed -ApprovedPlanId $preSame.plan_id
    Assert-Equal 'already-current' $same.catalog_entry_state 'a republication into the same collection claimed a Catalog change'
    Assert-Equal 'False' $same.catalog_updated 'a republication into the same collection issued a Catalog edit'
    Assert-Equal '' $same.catalog_entry_moved_from 'a republication into the same collection reported a move'
    Assert-Equal '## Workflows' $same.catalog_entry_heading 'a republication into the same collection misreported where its entry sits'
    Assert-Equal $catalogBeforeSame ([string]$store.Notes['books/README.md'].content) 'a republication into the same collection rewrote the Catalog'

    # AND A REFRESH THAT NAMES NO COLLECTION MOVES NOTHING. '## Open a Book' is the insert target for
    # a Book nobody has filed yet, not a request to file one there: treating it as one would empty
    # the three collections into it, one uncollected refresh at a time.
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/catalog/alpha.md') -Value "# Alpha`nThird generation.`n" -Encoding utf8
    $looseArgs = @{ Destination = 'Shared'; SourcePath = 'notebook/catalog'; BookSlug = 'move-book'; BookTitle = 'Move Book'; Summary = 'A refresh that names no collection.' }
    $preLoose = & $sharedPublish @common @looseArgs -Preflight
    $loose = & $sharedPublish @common @looseArgs -ReplaceExisting -UserConfirmed -ApprovedPlanId $preLoose.plan_id
    Assert-Equal 'replaced' $loose.catalog_entry_state 'a refresh naming no collection did not simply replace the line it owns'
    Assert-Equal '' $loose.catalog_entry_moved_from 'a refresh naming no collection reported a move'
    Assert-Equal '## Workflows' $loose.catalog_entry_heading 'a refresh naming no collection moved the entry out of its collection'
    Assert-Equal 1 @(Get-CatalogEntryLines 'books/move-book/wiki').Count 'a refresh naming no collection forked the entry it owns'
    Assert-Equal '## Workflows' (@(Get-CatalogEntryHeadings 'books/move-book/wiki') -join ', ') `
        'a refresh naming no collection refiled the entry it owns'

    # === Publish-ShelfBookToShared ================================================================
    # One composite approval covers the verified shared publication and only then the permanent
    # local deletion. These are ordinary confirmed workflows against the same fault-injectable MCP
    # boundary as the publisher itself, not calls that bypass either child helper.
    Reset-Store
    New-ShelfFixtureBook -Slug 'publish-delete' -Title 'Publish Delete'
    $workflowPre = & $publishShelf @common -ShelfBookSlug 'publish-delete' -BookSlug 'shared-publish-delete' -BookTitle 'Shared Publish Delete' -Summary 'Published before local deletion.' -Preflight
    Assert-Equal 3 @($workflowPre.execution_order).Count 'publish-and-delete preflight omitted a sequence stage'
    Assert-True $workflowPre.destructive 'publish-and-delete preflight did not disclose deletion'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/publish-delete/wiki/alpha.md')) 'publish-and-delete preflight changed the Shelf Book'
    Assert-True (-not $store.Notes.ContainsKey('books/shared-publish-delete/wiki/_book.md')) 'publish-and-delete preflight wrote to shared storage'
    Assert-Refused { & $publishShelf @common -ShelfBookSlug 'publish-delete' -BookSlug 'blog' -BookTitle 'Forbidden' -Summary 'No.' -Preflight } 'reserved' `
        'publish-and-delete accepted the forbidden blog slug'
    Assert-Refused { & $publishShelf @common -ShelfBookSlug 'publish-delete' -BookSlug 'shared-publish-delete' -BookTitle 'Shared Publish Delete' -Summary 'Published before local deletion.' -ApprovedPlanId $workflowPre.plan_id } 'rerun with -UserConfirmed' `
        'publish-and-delete without confirmation was refused'

    $workflowDone = & $publishShelf @common -ShelfBookSlug 'publish-delete' -BookSlug 'shared-publish-delete' -BookTitle 'Shared Publish Delete' -Summary 'Published before local deletion.' -UserConfirmed -ApprovedPlanId $workflowPre.plan_id
    Assert-Equal 'complete' $workflowDone.status 'publish-and-delete did not complete'
    Assert-True ($store.Notes.ContainsKey('books/shared-publish-delete/wiki/alpha.md')) 'publish-and-delete did not publish the Shelf page'
    Assert-True ([string]$store.Notes['books/README.md'].content -cmatch 'books/shared-publish-delete/wiki/_book') 'publish-and-delete did not verify a shared Catalog entry'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'shelf/publish-delete'))) 'publish-and-delete left the local Book behind'
    $workflowJournal = [IO.File]::ReadAllText((Join-Path $fixture 'internal/publication-journals/publish-delete-to-shared-publish-delete-publish-delete.json')) | ConvertFrom-Json
    Assert-Equal 'complete' $workflowJournal.state 'publish-and-delete journal did not record completion'

    # Publication interruption: no Catalog entry and no local deletion. Rerunning the same approved
    # plan resumes the matching shared root and only deletes locally after Catalog verification.
    Reset-Store
    New-ShelfFixtureBook -Slug 'publish-interrupted' -Title 'Publish Interrupted'
    [void]$store.Faults.WriteFailAlways.Add('books/shared-interrupted/wiki/beta.md')
    $interruptedPre = & $publishShelf @common -ShelfBookSlug 'publish-interrupted' -BookSlug 'shared-interrupted' -BookTitle 'Shared Interrupted' -Summary 'Resume fixture.' -Preflight
    Assert-Refused { & $publishShelf @common -ShelfBookSlug 'publish-interrupted' -BookSlug 'shared-interrupted' -BookTitle 'Shared Interrupted' -Summary 'Resume fixture.' -UserConfirmed -ApprovedPlanId $interruptedPre.plan_id } "incomplete at 'publishing'" `
        'publish-and-delete reported an interrupted publication honestly'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/publish-interrupted/wiki/beta.md')) 'interrupted publication deleted the local Book'
    Assert-True ([string]$store.Notes['books/README.md'].content -cnotmatch 'books/shared-interrupted/wiki/_book') 'interrupted publication entered the shared Catalog'
    $store.Faults.WriteFailAlways.Clear()
    $interruptedDone = & $publishShelf @common -ShelfBookSlug 'publish-interrupted' -BookSlug 'shared-interrupted' -BookTitle 'Shared Interrupted' -Summary 'Resume fixture.' -UserConfirmed -ApprovedPlanId $interruptedPre.plan_id
    Assert-Equal 'complete' $interruptedDone.status 'matching interrupted publication did not resume through local deletion'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'shelf/publish-interrupted'))) 'resumed workflow left the local Book behind'

    # Local deletion failure after a complete shared publication: shared stays complete, the local
    # move and Desk state roll back, and the workflow journal advertises the unfinished second half.
    Reset-Store
    New-ShelfFixtureBook -Slug 'delete-interrupted' -Title 'Delete Interrupted'
    $deleteInterruptedPre = & $publishShelf @common -ShelfBookSlug 'delete-interrupted' -BookSlug 'shared-delete-interrupted' -BookTitle 'Shared Delete Interrupted' -Summary 'Local rollback fixture.' -Preflight
    $localCatalog = Join-Path $fixture 'shelf/_catalog.md'
    (Get-Item -LiteralPath $localCatalog -Force).IsReadOnly = $true
    Assert-Refused { & $publishShelf @common -ShelfBookSlug 'delete-interrupted' -BookSlug 'shared-delete-interrupted' -BookTitle 'Shared Delete Interrupted' -Summary 'Local rollback fixture.' -UserConfirmed -ApprovedPlanId $deleteInterruptedPre.plan_id } "incomplete at 'published-awaiting-local-delete'" `
        'publish-and-delete reported a post-publication deletion failure honestly'
    (Get-Item -LiteralPath $localCatalog -Force).IsReadOnly = $false
    Assert-True ($store.Notes.ContainsKey('books/shared-delete-interrupted/wiki/_book.md')) 'local deletion failure rolled back the verified shared Book'
    Assert-True ([string]$store.Notes['books/README.md'].content -cmatch 'books/shared-delete-interrupted/wiki/_book') 'local deletion failure removed the shared Catalog entry'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/delete-interrupted/wiki/_book.md')) 'local deletion failure did not restore the Shelf Book'
    $deleteInterruptedJournal = [IO.File]::ReadAllText((Join-Path $fixture 'internal/publication-journals/delete-interrupted-to-shared-delete-interrupted-publish-delete.json')) | ConvertFrom-Json
    Assert-Equal 'published-awaiting-local-delete' $deleteInterruptedJournal.state 'workflow journal hid the unfinished local deletion'
    $deleteInterruptedDone = & $publishShelf @common -ShelfBookSlug 'delete-interrupted' -BookSlug 'shared-delete-interrupted' -BookTitle 'Shared Delete Interrupted' -Summary 'Local rollback fixture.' -UserConfirmed -ApprovedPlanId $deleteInterruptedPre.plan_id
    Assert-Equal 'complete' $deleteInterruptedDone.status 'post-publication local deletion did not resume'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'shelf/delete-interrupted'))) 'resumed local deletion left the Shelf Book behind'

    # === Publish-ShelfBookBatchToShared ===========================================================
    # One batch approval binds both child plans. A failed child is reported and preserved, but it
    # does not stop a later independent child from completing.
    Reset-Store
    New-ShelfFixtureBook -Slug 'batch-one' -Title 'Batch One'
    New-ShelfFixtureBook -Slug 'batch-two' -Title 'Batch Two'
    $batchPath = Join-Path $fixture 'batch.json'
    $batchJson = @{
        items = @(
            @{ action = 'publish'; shelf_book_slug = 'batch-one'; book_slug = 'shared-batch-one'; book_title = 'Shared Batch One'; summary = 'First batch fixture.'; topics = 'fixture'; collection = 'Workflows' },
            @{ action = 'publish'; shelf_book_slug = 'batch-two'; book_slug = 'shared-batch-two'; book_title = 'Shared Batch Two'; summary = 'Second batch fixture.'; topics = 'fixture'; collection = 'Workflows' }
        )
    } | ConvertTo-Json -Depth 6
    [IO.File]::WriteAllText($batchPath, $batchJson, [Text.UTF8Encoding]::new($false))
    $batchPre = & $publishShelfBatch @common -PlanPath $batchPath -Preflight
    Assert-Equal 2 @($batchPre.items).Count 'batch preflight did not bind both child plans'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/batch-one')) 'batch preflight changed its first Shelf Book'
    Assert-Refused { & $publishShelfBatch @common -PlanPath $batchPath -ApprovedPlanId $batchPre.plan_id } 'rerun with -UserConfirmed' `
        'batch execution without confirmation was refused'
    $batchDone = & $publishShelfBatch @common -PlanPath $batchPath -UserConfirmed -ApprovedPlanId $batchPre.plan_id
    Assert-Equal 'complete' $batchDone.status 'batch workflow did not complete'
    Assert-True ($store.Notes.ContainsKey('books/shared-batch-one/wiki/_book.md')) 'batch workflow did not publish the first Book'
    Assert-True ($store.Notes.ContainsKey('books/shared-batch-two/wiki/_book.md')) 'batch workflow did not publish the second Book'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'shelf/batch-one'))) 'batch workflow left the first Shelf Book behind'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'shelf/batch-two'))) 'batch workflow left the second Shelf Book behind'

    # === Invoke-LibraryTriage, the shared-destination half ========================================
    Reset-Store
    # The batch travels as -ActionJson and is resolved on every call, so the digests an approval
    # binds are recomputed from the sources rather than read back from a file that claims them.
    $sharedActions = '[{"kind":"book","source_path":"notebook/topic","slug":"triage-book","title":"Triage Book","summary":"Batch published."},{"kind":"project","source_path":"notebook/second","slug":"triage-project","title":"Triage Project","purpose":"Batch copied."}]'

    # Each run is given its own journal. The batch journal is local evidence about a remote
    # destination, so a Reset-Store that empties the stub collection would otherwise leave a
    # journal claiming actions succeeded against records that no longer exist.
    $journalOne = Join-Path $fixture 'internal/triage-journals/run-one.json'
    $journalTwo = Join-Path $fixture 'internal/triage-journals/run-two.json'

    $preTriage = & $triage -ActionJson $sharedActions @common -JournalPath $journalOne -Preflight
    Assert-Equal 2 (@($preTriage.actions).Count) 'triage preflight planned both actions'
    Assert-Equal 'False' $preTriage.shared_library_write 'triage preflight declares no shared write'
    Assert-True ($preTriage.plan_id -clike 'triage-*') 'triage preflight returned an aggregate plan_id'
    # Fixed order: the cheaper, more reversible Project copy runs before the shared Book.
    Assert-Equal 'project:triage-project,book:triage-book' (@($preTriage.execution_order) -join ',') 'the batch did not order project before book'

    Assert-Refused { & $triage -ActionJson $sharedActions @common -JournalPath $journalOne -UserConfirmed -ApprovedPlanId 'fabricated-triage-id' } `
        'exact plan_id' 'triage with a fabricated plan_id was refused'
    Assert-Refused { & $triage -ActionJson $sharedActions @common -JournalPath $journalOne -ApprovedPlanId $preTriage.plan_id } `
        'rerun with -UserConfirmed' 'triage without -UserConfirmed was refused'

    $doneTriage = & $triage -ActionJson $sharedActions @common -JournalPath $journalOne -UserConfirmed -ApprovedPlanId $preTriage.plan_id
    Assert-Equal 'True' $doneTriage.all_succeeded 'a confirmed triage reported every action succeeded'
    Assert-Equal 'complete' $doneTriage.status 'a wholly successful triage was not reported complete'
    Assert-Equal 2 $doneTriage.succeeded_count 'a confirmed triage succeeded twice'
    Assert-True ($store.Notes.ContainsKey('books/triage-book/wiki/_book.md')) 'the triage published its Book'
    Assert-True ($store.Notes.ContainsKey('projects/triage-project/_project.md')) 'the triage created its Project Hub'
    # Honest per-destination reporting: this batch reached the NAS and nothing else.
    Assert-Equal 'True' $doneTriage.shared_collection_write 'a shared-collection write was not reported'
    Assert-Equal 'False' $doneTriage.shelf_write 'a shared-only batch claimed a Shelf write'
    Assert-Equal 'False' $doneTriage.notebook_write 'a batch with no notebook kind claimed to write the Notebook'

    # Continue-on-failure: one action fails, the batch is still reported failed rather than partial.
    Reset-Store
    [void]$store.Faults.WriteFailAlways.Add('projects/triage-project/notes/second/gamma.md')
    $preMixed = & $triage -ActionJson $sharedActions @common -JournalPath $journalTwo -Preflight
    $mixed = & $triage -ActionJson $sharedActions @common -JournalPath $journalTwo -UserConfirmed -ApprovedPlanId $preMixed.plan_id
    Assert-Equal 'False' $mixed.all_succeeded 'a batch with one failing action was not reported as wholly succeeded'
    Assert-Equal 'incomplete' $mixed.status 'a partial triage was not reported incomplete'
    Assert-Equal 1 $mixed.failed_count 'the failing triage action was counted'
    Assert-Equal 1 $mixed.succeeded_count 'the succeeding triage action still completed'
    Assert-Equal 'True' $mixed.shared_library_write 'a partially succeeding triage still declares a shared write'
    # The Project action is ordered first and fails; the Book after it must still be attempted.
    Assert-True ($store.Notes.ContainsKey('books/triage-book/wiki/_book.md')) 'the batch stopped at the first failure instead of continuing'

    # The journal is durable and per-action, which is what makes resume implementable across
    # processes: returning outcomes tells the next process nothing.
    Assert-True (Test-Path -LiteralPath $journalTwo -PathType Leaf) 'the batch journal was not written'
    $mcpJournal = ([IO.File]::ReadAllText($journalTwo)) | ConvertFrom-Json
    Assert-Equal 'incomplete' $mcpJournal.state 'the journal recorded a partial batch as complete'
    Assert-Equal 1 @(@($mcpJournal.actions) | Where-Object { $_.state -ceq 'failed' }).Count 'the journal did not record the failed action'
    Assert-Equal 1 @(@($mcpJournal.actions) | Where-Object { $_.state -ceq 'succeeded' }).Count 'the journal did not record the succeeded action'

    # Resume: the Book already landed, so only the Project action is retried, and the Book is not
    # written a second time.
    $store.Faults.WriteFailAlways.Clear()
    $preResume = & $triage -ActionJson $sharedActions @common -JournalPath $journalTwo -Preflight
    Assert-Equal $preMixed.plan_id $preResume.plan_id 'the batch identity changed between runs of one plan'
    Assert-Equal 1 $preResume.pending_count 'the resume did not narrow to the unfinished action'
    Assert-Equal 1 $preResume.already_succeeded 'the resume did not recognise the completed action'
    $resumed = & $triage -ActionJson $sharedActions @common -JournalPath $journalTwo -UserConfirmed -ApprovedPlanId $preResume.plan_id
    Assert-Equal 'complete' $resumed.status 'the resume did not complete the batch'
    Assert-Equal 1 @(@($resumed.outcomes) | Where-Object { $_.skipped }).Count 'the resume re-ran an action already recorded as succeeded'
    Assert-True ($store.Notes.ContainsKey('projects/triage-project/notes/second/gamma.md')) 'the retried action did not land on resume'

    # include_pages end to end. The plan narrows its own write set to the selection, and the child's
    # preflight has to agree with it -- the first implementation added the selection as metadata
    # after both were built from every file, so every legitimate subset was refused.
    Reset-Store
    $subsetActions = '[{"kind":"book","source_path":"notebook/topic","slug":"subset-book","title":"Subset Book","summary":"One page of two.","include_pages":["alpha.md"]}]'
    $journalThree = Join-Path $fixture 'internal/triage-journals/run-three.json'
    $subsetPre = & $triage -ActionJson $subsetActions @common -JournalPath $journalThree -Preflight
    $subsetDone = & $triage -ActionJson $subsetActions @common -JournalPath $journalThree -UserConfirmed -ApprovedPlanId $subsetPre.plan_id
    Assert-Equal 'complete' $subsetDone.status 'a batch selecting a subset of pages was refused'
    Assert-True ($store.Notes.ContainsKey('books/subset-book/wiki/topic/alpha.md')) 'the selected page was not published'
    Assert-True (-not $store.Notes.ContainsKey('books/subset-book/wiki/topic/beta.md')) 'an unselected page was published anyway'


    # === Triage from the Holding Shelf to the shared collection ===================================
    #
    # THE REACH FORK A ADDED, and the only place it is proved end to end. Before 2026-08-28 a
    # captured finding bound for a Project Hub or a shared Book had to detour through the volatile
    # Notebook, because both child writers refused any source outside notebook/. They now accept one
    # note under a capture Book's wiki/notes/, and the provenance they record names that note rather
    # than a notebook/ path nothing was ever read from.
    Reset-Store
    $captureFixture = Join-Path $fixture 'shelf/holding/wiki/notes'
    New-Item -ItemType Directory -Path $captureFixture -Force | Out-Null
    Set-ShelfCatalogEntryForFixture -FixtureRoot $fixture -Slug 'holding' -Title 'Holding Shelf' -Line @(
        '- **Summary:** Unsorted captures.',
        '- **Kind:** capture'
    )
    [IO.File]::WriteAllText((Join-Path $captureFixture '2026-08-28-captured-finding.md'),
        "---`ncaptured: 2026-08-28T09:00:00Z`nreview: pending`nsource_project: library-dev`n---`n`n# Captured finding`n`nThe body that must travel.`n",
        [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixture 'shelf/holding/wiki/_index.md'), "# Holding Shelf - Reader Map`n", [Text.UTF8Encoding]::new($false))

    $holdingActions = '[{"kind":"book","source":"holding","source_match":"Captured finding","slug":"from-holding","title":"From Holding","summary":"Published straight off the Holding Shelf."},{"kind":"project","source":"holding","source_match":"Captured finding","slug":"from-holding-project","title":"From Holding Project","purpose":"Copied straight off the Holding Shelf."}]'
    $journalFour = Join-Path $fixture 'internal/triage-journals/run-four.json'

    # The gate first: the source Book is closed, so the batch is refused before any approval exists.
    [IO.File]::WriteAllText((Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books'), '', [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $triage -ActionJson $holdingActions @common -JournalPath $journalFour -Preflight } `
        "Shelf Book 'holding' is closed" 'a holding-sourced batch ran with the source Book closed'

    & (Join-Path $toolsDir 'Set-VirtualDesk.ps1') -Action Open -Kind Book -Location Shelf -Slug 'holding' -WorkspacePath $fixture | Out-Null
    $holdingPre = & $triage -ActionJson $holdingActions @common -JournalPath $journalFour -Preflight
    Assert-Equal 2 (@($holdingPre.actions).Count) 'a holding-sourced batch did not plan both actions'
    $bookAction = @(@($holdingPre.actions) | Where-Object { $_.kind -ceq 'book' })[0]
    Assert-Equal 'holding' $bookAction.source 'the action did not record its source'
    Assert-True (([string]$bookAction.source_path) -ceq 'shelf/holding/wiki/notes/2026-08-28-captured-finding.md') `
        "the source path resolved to '$($bookAction.source_path)'"
    # -MatchText is resolved at plan time, so the digest binds the note the approval named rather
    # than whatever that text matches later. Capture is ungated, so that is not a hypothetical race.
    Assert-True (@($bookAction.required_desk_state) -ccontains 'shelf-book-open:holding') 'the action did not require its source Book open'
    Assert-True ($bookAction.delivered_sha256 -cne 'same-as-source') 'a composed destination did not bind the delivered body'

    $holdingDone = & $triage -ActionJson $holdingActions @common -JournalPath $journalFour -UserConfirmed -ApprovedPlanId $holdingPre.plan_id
    Assert-Equal 'complete' $holdingDone.status 'a holding-sourced batch to the shared collection did not complete'
    Assert-Equal 'True' $holdingDone.shared_collection_write 'a shared write was not reported'
    Assert-True ($store.Notes.ContainsKey('books/from-holding/wiki/2026-08-28-captured-finding.md')) 'the note did not reach the shared Book'
    Assert-True ($store.Notes.ContainsKey('projects/from-holding-project/notes/2026-08-28-captured-finding.md')) 'the note did not reach the Project Hub'

    # THE PROVENANCE, in the publication journal -- which is not decoration. It is exactly what
    # Get-LibraryTriageInventory reads to decide whether a page already has a copy record, so a
    # journal naming a notebook/ path nothing was ever read from would credit a Notebook page that
    # does not exist and leave the real Holding Shelf note reading no-known-copy-record.
    $pubJournals = @(Get-ChildItem -LiteralPath (Join-Path $fixture 'internal/publication-journals') -File -Filter 'from-holding-*.json')
    Assert-Equal 1 $pubJournals.Count 'the shared publish wrote no publication journal'
    $pubDoc = ([IO.File]::ReadAllText($pubJournals[0].FullName)) | ConvertFrom-Json
    $recorded = @(@($pubDoc.planned_records) | ForEach-Object { [string]$_.source } | Where-Object { $_ })
    Assert-True ($recorded -ccontains 'shelf/holding/wiki/notes/2026-08-28-captured-finding.md') `
        "the journal recorded sources '$($recorded -join ', ')' rather than the note that was read"
    Assert-True (-not @($recorded | Where-Object { $_.StartsWith('notebook/') })) 'the journal claims a notebook/ source'

    # THE FRONTMATTER. A capture note opens with a metadata block; a shared page and a Basic Memory
    # Project record must not carry it into their own frontmatter.
    foreach ($path in @('books/from-holding/wiki/2026-08-28-captured-finding.md', 'projects/from-holding-project/notes/2026-08-28-captured-finding.md')) {
        $body = [string]$store.Notes[$path].content
        Assert-True (-not $body.TrimStart().StartsWith('---')) "the capture frontmatter reached $path"
        Assert-True ($body.Contains('The body that must travel.')) "$path lost the note body"
        Assert-True (-not $body.Contains('review: pending')) "$path carried the note's review state"
    }

    # === New-ProjectHub ===========================================================================
    # A NO-OVERWRITE CREATE THAT LOSES A RACE MUST SAY SO (S33). Basic Memory answers a conflicting
    # write with isError=false and `action: conflict`; the helper read only isError, then read back
    # the page -- which existed, holding the other writer's body -- and reported `created`.
    $newHub = Join-Path $toolsDir 'New-ProjectHub.ps1'
    Reset-Store
    Set-Note 'projects/README.md' "# Active Projects`n`n## Projects`n"
    $madeHub = & $newHub -ProjectSlug 'fresh' -Title 'Fresh' -McpUrl $mcpUrl -ProjectId '00000000-0000-0000-0000-000000000000'
    Assert-Equal 'True' $madeHub.created 'a Hub created into an empty slot was not reported created'
    Assert-True (([string]$store.Notes['projects/fresh/_project.md'].content).StartsWith('# Fresh')) 'the created Hub root does not hold its own body'
    Reset-Store
    Set-Note 'projects/README.md' "# Active Projects`n`n## Projects`n"
    $store.Faults.WriteRaceOnce['projects/raced/_project.md'] = "# Someone Else`n"
    Assert-Refused { & $newHub -ProjectSlug 'raced' -Title 'Raced' -McpUrl $mcpUrl -ProjectId '00000000-0000-0000-0000-000000000000' } `
        'already exists' 'a Hub root another writer created between the read and the write was reported created'
    Assert-Equal "# Someone Else`n" ([string]$store.Notes['projects/raced/_project.md'].content) 'the losing creation changed the winner''s Hub root'
    Assert-True ([string]$store.Notes['projects/README.md'].content -notmatch 'projects/raced/_project\|Raced') 'the losing creation listed its Hub in the catalog'

    # === Archive-ProjectHub =======================================================================
    Reset-Store
    Set-Note 'projects/arch/_project.md' "# Arch`n`n## Purpose`n`nFixture.`n`n## Now`n`n- [[projects/arch/notes/note|note]]`n"
    Set-Note 'projects/arch/notes/note.md' "# Note`nBody.`n"
    Set-Note 'projects/README.md' "# Active Projects`n`n## Projects`n`n- [[projects/arch/_project|Arch]]`n"

    $preArch = & $archiveProject -ProjectSlug 'arch' -McpUrl $mcpUrl -Preflight
    Assert-Equal 'projects/arch' $preArch.active_path 'project archive preflight named the active path'
    Assert-True ($store.Notes.ContainsKey('projects/arch/_project.md')) 'project archive preflight moved nothing'

    Assert-Refused { & $archiveProject -ProjectSlug 'arch' -McpUrl $mcpUrl } `
        'rerun with -UserConfirmed' 'project archive without -UserConfirmed was refused'

    $archived = & $archiveProject -ProjectSlug 'arch' -McpUrl $mcpUrl -UserConfirmed
    Assert-Equal 'True' $archived.archive_complete 'a confirmed project archive completed'
    Assert-True ($store.Notes.ContainsKey('archive/projects/arch/_project.md')) 'the Project Hub moved into the archive'
    Assert-True (-not $store.Notes.ContainsKey('projects/arch/_project.md')) 'the active Project Hub path is gone'
    Assert-True ([string]$store.Notes['archive/projects/arch/_project.md'].content -notmatch '\[\[projects/arch/') 'archived self-links were rewritten'
    Assert-True ([string]$store.Notes['projects/README.md'].content -notmatch 'projects/arch/_project') 'the active Project Catalog entry was removed'

    # Resume: a second archive of the same Project must not move anything again.
    Assert-Refused { & $archiveProject -ProjectSlug 'arch' -McpUrl $mcpUrl -UserConfirmed } `
        'missing' 're-archiving an already archived Project Hub was refused'

    # A Project that exists in both places is the interrupted case, and must stop before moving.
    Set-Note 'projects/arch/_project.md' "# Arch`n"
    Assert-Refused { & $archiveProject -ProjectSlug 'arch' -McpUrl $mcpUrl -UserConfirmed } `
        'Archive already contains' 'archiving a Project already present in the archive was refused'

    # A rejected move must leave the active Project in place and say so.
    Reset-Store
    Set-Note 'projects/movefail/_project.md' "# Move Fail`n`n## Now`n`nBody.`n"
    Set-Note 'projects/movefail/notes/note.md' "# Note`nBody.`n"
    Set-Note 'projects/README.md' "# Active Projects`n`n## Projects`n`n- [[projects/movefail/_project|Move Fail]]`n"
    $store.Faults.MoveFail = $true
    Assert-Refused { & $archiveProject -ProjectSlug 'movefail' -McpUrl $mcpUrl -UserConfirmed } `
        'left in place' 'a rejected Project move reported the Hub was left in place'
    Assert-True ($store.Notes.ContainsKey('projects/movefail/_project.md')) 'the Project Hub survived a rejected move'
    $store.Faults.MoveFail = $false

    # === Archive-SharedBook =======================================================================
    Reset-Store
    Set-Note 'books/arch-book/wiki/_book.md' "# Arch Book`n`n## Reader map`n`n- [[books/arch-book/wiki/_index|Open the reader map]]`n"
    Set-Note 'books/arch-book/wiki/_index.md' "# Arch Book - Reader Map`n`n- [[books/arch-book/wiki/page|page]]`n"
    Set-Note 'books/arch-book/wiki/page.md' "# Page`nBody.`n"
    Set-Note 'books/README.md' "# Book Catalog`n`n## Open a Book`n`n- [[books/arch-book/wiki/_book|Arch Book]]`n"

    $preArchBook = & $archiveBook -BookSlug 'arch-book' -McpUrl $mcpUrl -Preflight
    Assert-Equal 'archive/arch-book' $preArchBook.archive_path 'Book archive preflight named the archive path'
    Assert-True ($store.Notes.ContainsKey('books/arch-book/wiki/_book.md')) 'Book archive preflight moved nothing'

    Assert-Refused { & $archiveBook -BookSlug 'arch-book' -McpUrl $mcpUrl } `
        'rerun with -UserConfirmed' 'Book archive without -UserConfirmed was refused'

    $archivedBook = & $archiveBook -BookSlug 'arch-book' -McpUrl $mcpUrl -UserConfirmed
    Assert-Equal 'True' $archivedBook.archive_complete 'a confirmed Book archive completed'
    Assert-True ($store.Notes.ContainsKey('archive/arch-book/wiki/_book.md')) 'the Book moved into the archive'
    Assert-True (-not $store.Notes.ContainsKey('books/arch-book/wiki/_book.md')) 'the active Book path is gone'
    Assert-True ([string]$store.Notes['archive/arch-book/wiki/_index.md'].content -notmatch 'books/arch-book') 'archived reader-map links were rewritten'
    Assert-True ([string]$store.Notes['books/README.md'].content -notmatch 'books/arch-book/wiki/_book') 'the active Book Catalog entry was removed'
    Assert-True ($store.Notes.ContainsKey('archive/README.md')) 'the archive index was created'

    # Resume: the archive already holds this Book, so no second move is attempted.
    Set-Note 'books/arch-book/wiki/_book.md' "# Arch Book`n"
    Set-Note 'books/arch-book/wiki/_index.md' "# Arch Book - Reader Map`n"
    Assert-Refused { & $archiveBook -BookSlug 'arch-book' -McpUrl $mcpUrl -UserConfirmed } `
        'Archive already contains' 'archiving a Book already present in the archive was refused'
    Assert-True ($store.Notes.ContainsKey('books/arch-book/wiki/_book.md')) 'the refused re-archive left the active Book alone'

    # An incomplete Book -- root present, reader map missing -- is refused before any move.
    Reset-Store
    Set-Note 'books/partial-book/wiki/_book.md' "# Partial Book`n"
    Assert-Refused { & $archiveBook -BookSlug 'partial-book' -McpUrl $mcpUrl -UserConfirmed } `
        'incomplete or missing' 'archiving an incomplete Book was refused'

    # A rejected move must leave the active Book in place and say so.
    Reset-Store
    Set-Note 'books/movefail-book/wiki/_book.md' "# Move Fail Book`n"
    Set-Note 'books/movefail-book/wiki/_index.md' "# Move Fail Book - Reader Map`n`n- [[books/movefail-book/wiki/page|page]]`n"
    Set-Note 'books/movefail-book/wiki/page.md' "# Page`nBody.`n"
    $store.Faults.MoveFail = $true
    Assert-Refused { & $archiveBook -BookSlug 'movefail-book' -McpUrl $mcpUrl -UserConfirmed } `
        'left in place' 'a rejected Book move reported the Book was left in place'
    Assert-True ($store.Notes.ContainsKey('books/movefail-book/wiki/_book.md')) 'the Book survived a rejected move'
    $store.Faults.MoveFail = $false

    # === The other four no-overwrite writers lose a race the same way (S34) ========================
    # New-ProjectHub was the first found (S33). These four also write with overwrite=false and read
    # only isError, so a note another writer lands between the read and the write came back as
    # `action: conflict` and each went on to a readback of THAT writer's note -- and refused later,
    # under a sentence about a readback, a manifest offset or a Catalog line. The refusal now says
    # what happened, and the winner's note is untouched.
    $raceWinner = "# Someone Else`n"
    Reset-Store
    Set-Note 'projects/race-arch/_project.md' "# Race Arch`n`n## Now`n`nBody.`n"
    Set-Note 'projects/race-arch/notes/note.md' "# Note`nBody.`n"
    Set-Note 'projects/README.md' "# Active Projects`n`n## Projects`n`n- [[projects/race-arch/_project|Race Arch]]`n"
    $store.Faults.WriteRaceOnce['archive/projects/README.md'] = $raceWinner
    Assert-Refused { & $archiveProject -ProjectSlug 'race-arch' -McpUrl $mcpUrl -UserConfirmed } `
        'a note already exists there' 'Archive-ProjectHub did not name a lost race on the archived Project Catalog'
    Assert-Equal $raceWinner ([string]$store.Notes['archive/projects/README.md'].content) 'Archive-ProjectHub changed the archived Project Catalog it lost the race for'

    Reset-Store
    Set-Note 'books/race-book/wiki/_book.md' "# Race Book`n`n## Reader map`n`n- [[books/race-book/wiki/_index|Open the reader map]]`n"
    Set-Note 'books/race-book/wiki/_index.md' "# Race Book - Reader Map`n`n- [[books/race-book/wiki/page|page]]`n"
    Set-Note 'books/race-book/wiki/page.md' "# Page`nBody.`n"
    Set-Note 'books/README.md' "# Book Catalog`n`n## Open a Book`n`n- [[books/race-book/wiki/_book|Race Book]]`n"
    $store.Faults.WriteRaceOnce['archive/README.md'] = $raceWinner
    Assert-Refused { & $archiveBook -BookSlug 'race-book' -McpUrl $mcpUrl -UserConfirmed } `
        'a note already exists there' 'Archive-SharedBook did not name a lost race on the archive index'
    Assert-Equal $raceWinner ([string]$store.Notes['archive/README.md'].content) 'Archive-SharedBook changed the archive index it lost the race for'

    Reset-Store
    $store.Faults.WriteRaceOnce['projects/race-copy/notes/topic/alpha.md'] = $raceWinner
    $raceCopy = & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'race-copy' -Title 'Race Copy' -Purpose 'Fixture project.' -Preflight
    Assert-Refused { & $projectCopy @common -SourcePath 'notebook/topic' -ProjectSlug 'race-copy' -Title 'Race Copy' -Purpose 'Fixture project.' -UserConfirmed -ApprovedPlanId $raceCopy.plan_id } `
        'a note already exists there' 'Copy-LocalPagesToProject did not name a lost race on a copied page'
    Assert-Equal $raceWinner ([string]$store.Notes['projects/race-copy/notes/topic/alpha.md'].content) 'Copy-LocalPagesToProject changed the page it lost the race for'

    Reset-Store
    $store.Faults.WriteRaceOnce['books/race-publish/wiki/topic/alpha.md'] = $raceWinner
    $racePublish = & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'race-publish' -BookTitle 'Race Publish' -Summary 'A fixture Book.' -Preflight
    Assert-Refused { & $sharedPublish @common -Destination Shared -SourcePath 'notebook/topic' -BookSlug 'race-publish' -BookTitle 'Race Publish' -Summary 'A fixture Book.' -UserConfirmed -ApprovedPlanId $racePublish.plan_id } `
        'a note already exists there' 'Publish-SharedBookCandidate did not name a lost race on a published page'
    Assert-Equal $raceWinner ([string]$store.Notes['books/race-publish/wiki/topic/alpha.md'].content) 'Publish-SharedBookCandidate changed the page it lost the race for'
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

if ($failures.Count) {
    [Console]::Error.WriteLine("Test-McpHelpers FAILED ($($failures.Count) of $($passed + $failures.Count)):")
    foreach ($failure in $failures) { [Console]::Error.WriteLine("  - $failure") }
    exit 1
}
Write-Host "Test-McpHelpers passed ($passed checks)."
exit 0
