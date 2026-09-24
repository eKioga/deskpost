<#
.SYNOPSIS
    A disposable Basic Memory project for each arm of each shared acceptance row: created before the
    arm's fixture is built, pinned into it, and deleted after the row. Dot-sourced by
    Invoke-AcceptanceMatrix.ps1; never invoked directly except with -SelfTest.

.DESCRIPTION
    THE READER'S RULING, 2026-09-22 (S32). No shared row runs against the reader's collection. Until
    this file, fifteen rows needed "a reachable shared collection" and nothing said WHICH. A fixture is
    pinned to the all-zeroes id, and LibraryDeployment.ps1's last fallback for an endpoint, a pin and a
    share root, when no workspace resolves, is the PROGRAM ROOT's own `.claude/` -- which in this
    checkout names the reader's `ai-library`. What was MEASURED when the rows first ran: the three
    helpers with no -WorkspacePath refuse earlier, on workspace resolution, so none reached that
    fallback. What was PREDICTED and turned out wrong: that they would. The fence below does not rest
    on either -- it names the collection before any fallback is consulted.

    SO EVERY SHARED ARM GETS ITS OWN PROJECT, and three things keep it there:
      1. The project is created here, named `acceptance-<guid>`, and is accepted only if the project
         list afterwards differs from the list before by exactly that one project. Its id therefore
         cannot be any collection that already existed -- the reader's included -- whatever it is
         called and whatever this machine has pinned.
      2. The fixture is BUILT pinned to it (`library init -CollectionId -McpUrl`, the share root
         beside them), every PowerShell step that declares -ProjectId is given `{collection_id}`
         (`acceptance.matrix-shape` refuses a shared row that does not), and every step's child
         process carries AI_LIBRARY_MCP_URL, AI_LIBRARY_PROJECT_ID and LIBRARY_SHARED_COLLECTION_ROOT,
         which outrank every file-based fallback in LibraryDeployment.ps1.
      3. Deletion refuses anything this run did not create, by id, and anything not named like one
         of these projects. `delete_project` with `delete_notes` removes the registration and the
         files in one server-side operation, as Remove-MemoryProject.ps1 documents; the share folder
         is then checked gone rather than assumed.

    ONE PROJECT PER ARM, NOT PER ROW. Each arm builds its own fixture from scratch, and a Hub the
    PowerShell arm created would make the kernel arm's `hub new` a collision rather than the same
    operation. A separate project per arm also lets the harness snapshot what each arm left in the
    COLLECTION, which the workspace effect cannot see: a shared write lands on the share.

    SERVER PATH AND SHARE PATH. A project at server path `/<name>` is `<knowledge root>\<name>` on the
    share -- measured 2026-09-22 against the reader's own collection and a disposable project -- and
    New-AcceptanceDisposableCollection checks it for the project it creates rather than
    trusting the mapping.
#>

# NO param() BLOCK: dot-sourcing a script that declares parameters binds them in the caller's scope.

Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Net.Http

$script:AcceptanceCollectionNamePattern = '^acceptance-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
# Every id this process created, and every project that existed before the first creation. Deletion
# is refused outside the first and inside the second.
$script:AcceptanceCreatedCollectionIds = [Collections.Generic.List[string]]::new()
$script:AcceptancePreexistingCollectionIds = $null

function Test-AcceptanceDisposableName([string]$Name) {
    $Name -cmatch $script:AcceptanceCollectionNamePattern
}

function Test-AcceptanceCollectionDeletable {
    <# Whether a project may be deleted by this file: named as one, created by this run, and new. #>
    param([string]$Name, [string]$Id, [string[]]$Created, [string[]]$Preexisting)
    if (-not (Test-AcceptanceDisposableName $Name)) { return $false }
    if ([string]::IsNullOrWhiteSpace($Id) -or @($Created) -notcontains $Id) { return $false }
    if (@($Preexisting) -contains $Id) { return $false }
    $true
}

function New-AcceptanceMcpSession([Parameter(Mandatory = $true)][string]$McpUrl) {
    $session = [pscustomobject]@{ url = $McpUrl; id = $null; request = 1 }
    Invoke-AcceptanceMcp -Session $session -Method 'initialize' -Params @{
        protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'library-acceptance'; version = '1.0.0' }
    } | Out-Null
    Invoke-AcceptanceMcp -Session $session -Method 'notifications/initialized' -Notification | Out-Null
    $session
}

function Invoke-AcceptanceMcp {
    param($Session, [string]$Method, [hashtable]$Params, [switch]$Notification)
    $payload = [ordered]@{ jsonrpc = '2.0'; method = $Method }
    if (-not $Notification) { $payload.id = $Session.request; $Session.request++ }
    if ($null -ne $Params) { $payload.params = $Params }
    $client = [Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(60)
    try {
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $Session.url)
        [void]$request.Headers.TryAddWithoutValidation('Accept', 'application/json, text/event-stream')
        [void]$request.Headers.TryAddWithoutValidation('MCP-Protocol-Version', '2025-03-26')
        if ($Session.id) { [void]$request.Headers.TryAddWithoutValidation('Mcp-Session-Id', $Session.id) }
        $request.Content = [Net.Http.ByteArrayContent]::new([Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Depth 20 -Compress)))
        $request.Content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/json; charset=utf-8')
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw "HTTP $([int]$response.StatusCode): $($body.Substring(0, [Math]::Min($body.Length, 1024)))" }
    }
    catch { throw "MCP $Method failed: $($_.Exception.Message)" }
    finally { $client.Dispose() }
    if ($Method -ceq 'initialize') {
        $values = $null
        if (-not $response.Headers.TryGetValues('Mcp-Session-Id', [ref]$values)) { throw 'No MCP session was established.' }
        $Session.id = @($values)[0]
    }
    if ($Notification) { return }
    $frame = if ($body.Trim().StartsWith('{')) { $body | ConvertFrom-Json } else {
        $parsed = @($body -split "`r?`n" | Where-Object { $_ -like 'data:*' } | ForEach-Object {
                try { $_.Substring(5).Trim() | ConvertFrom-Json } catch { $null } } | Where-Object { $null -ne $_ })
        $answers = @($parsed | Where-Object { $names = @($_.PSObject.Properties | ForEach-Object { $_.Name }); $names -contains 'result' -or $names -contains 'error' })
        if ($answers.Count -eq 0) { throw "MCP $Method carried no result." }
        $answers[-1]
    }
    $names = @($frame.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -contains 'error' -and $null -ne $frame.error) { throw "MCP $Method was rejected: $($frame.error.message)" }
    $frame.result
}

function Invoke-AcceptanceMcpTool($Session, [string]$Name, [hashtable]$Arguments) {
    $result = Invoke-AcceptanceMcp -Session $Session -Method 'tools/call' -Params @{ name = $Name; arguments = $Arguments }
    $text = (@($result.content) | ForEach-Object { [string]$_.text }) -join "`n"
    $names = @($result.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -contains 'isError' -and $result.isError) { throw "Basic Memory refused $Name`: $text" }
    $text
}

function Get-AcceptanceMemoryProjects($Session) {
    $listed = Invoke-AcceptanceMcpTool -Session $Session -Name 'list_memory_projects' -Arguments @{ output_format = 'json' } | ConvertFrom-Json
    @($listed.projects | ForEach-Object { [pscustomobject]@{ name = [string]$_.name; id = [string]$_.external_id; path = [string]$_.path } })
}

function New-AcceptanceDisposableCollection {
    <#
    .SYNOPSIS
        Create one `acceptance-<guid>` project and return what a fixture is pinned with.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$McpUrl,
        [Parameter(Mandatory = $true)][string]$KnowledgeRoot
    )
    if (-not (Test-Path -LiteralPath $KnowledgeRoot -PathType Container)) {
        throw "the shared knowledge root '$KnowledgeRoot' is not reachable, so no disposable project's files can be seen or fenced"
    }
    $session = New-AcceptanceMcpSession -McpUrl $McpUrl
    $before = @(Get-AcceptanceMemoryProjects $session)
    if ($null -eq $script:AcceptancePreexistingCollectionIds) {
        $script:AcceptancePreexistingCollectionIds = @($before | ForEach-Object { $_.id })
    }
    $name = 'acceptance-' + [guid]::NewGuid().ToString()
    if (@($before | Where-Object { $_.name -ceq $name }).Count) { throw "a project named '$name' already exists; refusing to adopt it" }

    Invoke-AcceptanceMcpTool -Session $session -Name 'create_memory_project' -Arguments @{
        project_name = $name; project_path = "/$name"; set_default = $false; output_format = 'json'
    } | Out-Null

    $after = @(Get-AcceptanceMemoryProjects $session)
    $new = @($after | Where-Object { @($before | ForEach-Object { $_.id }) -notcontains $_.id })
    if ($new.Count -ne 1 -or $new[0].name -cne $name) {
        throw ("creating '$name' did not change the project list by exactly that project (new: " +
            (($new | ForEach-Object { "$($_.name) [$($_.id)]" }) -join ', ') + '); nothing will be pinned to it')
    }
    $created = $new[0]
    if ($created.id -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        throw "the project '$name' was created with an id the Library cannot pin: '$($created.id)'"
    }
    [void]$script:AcceptanceCreatedCollectionIds.Add($created.id)

    $shareRoot = Join-Path $KnowledgeRoot $name
    # The server may create the folder lazily; the fence needs it to exist, so it is made here if
    # absent -- and only here, under the knowledge root, for the project just created.
    if (-not (Test-Path -LiteralPath $shareRoot -PathType Container)) { New-Item -ItemType Directory -Path $shareRoot | Out-Null }
    Initialize-AcceptanceCollectionSkeleton -Session $session -ProjectId $created.id -ShareRoot $shareRoot
    [pscustomobject]@{
        name        = $name
        id          = $created.id
        server_path = $created.path
        share_root  = $shareRoot
        mcp_url     = $McpUrl
    }
}

$script:AcceptanceCollectionSkeleton = @(
    [pscustomobject]@{ directory = 'books'; text = "# Book Catalog`n`n## Open a Book`n" }
    [pscustomobject]@{ directory = 'projects'; text = "# Active Projects`n`nProjects are living context on the NAS. Open one when you need its current notes.`n`n## Projects`n" }
)

function Initialize-AcceptanceCollectionSkeleton {
    <#
    .SYNOPSIS
        Give a new project the two catalogs that make it a Library collection, and wait until the
        share shows them.

    .DESCRIPTION
        NO LIBRARY WRITER CREATES A SHARED COLLECTION (S33, measured). Every writer assumes one:
        Publish-SharedBookCandidate refuses "The Book Catalog is missing; it will not be created
        implicitly", and the ownership fence reads a folder without `books\README.md` and
        `projects\README.md` as "not a collection" -- so a bare disposable project could not be owned,
        published to or archived into, and every row that needs one refused before its subject.

        SO THIS WRITES ONLY WHAT NO WRITER DOES, AND IN THE WRITERS' OWN WORDS. The Book Catalog as
        Test-McpHelpers.ps1's store starts its publisher cases, its heading and the `## Open a Book`
        insert target; and the Active Project Catalog as New-ProjectHub.ps1 creates it when it is
        missing, less the entry -- present here only because the fence reads it as a marker. The
        archive catalogs are NOT written: Archive-ProjectHub.ps1 and Archive-SharedBook.ps1 create
        their own on first use, so a row that archives measures that too. Not `library init`'s
        local-collection bodies, whose prose says "local collection" and would be false on a share.
        Written through Basic Memory, as the shared writers write.

        THE MARKERS ARE WAITED FOR, NOT ASSUMED: the fence reads them through the SMB client, which
        may still be serving the listing it cached when the folder was created.
    #>
    param([Parameter(Mandatory = $true)]$Session, [Parameter(Mandatory = $true)][string]$ProjectId, [Parameter(Mandatory = $true)][string]$ShareRoot)
    foreach ($note in $script:AcceptanceCollectionSkeleton) {
        Invoke-AcceptanceMcpTool -Session $Session -Name 'write_note' -Arguments @{
            project_id = $ProjectId; directory = $note.directory; title = 'README'; content = $note.text
            note_type = 'note'; overwrite = $false; output_format = 'json'
        } | Out-Null
    }
    $deadline = [DateTime]::UtcNow.AddSeconds((Get-AcceptanceShareCacheSeconds) + 10)
    do {
        $missing = @($script:AcceptanceCollectionSkeleton | Where-Object {
                -not (Test-Path -LiteralPath (Join-Path $ShareRoot (Join-Path $_.directory 'README.md')) -PathType Leaf) })
        if (-not $missing.Count) { return }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw ("the disposable project's catalogs were written and never appeared on the share under ${ShareRoot}: " +
        (($missing | ForEach-Object { "$($_.directory)/README.md" }) -join ', '))
}

function Remove-AcceptanceDisposableCollection {
    <#
    .SYNOPSIS
        Delete one project this run created, and report whether its registration and files are gone.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Collection)
    $allowed = Test-AcceptanceCollectionDeletable -Name ([string]$Collection.name) -Id ([string]$Collection.id) `
        -Created @($script:AcceptanceCreatedCollectionIds) -Preexisting @($script:AcceptancePreexistingCollectionIds)
    if (-not $allowed) {
        throw "refusing to delete '$($Collection.name)' [$($Collection.id)]: it is not a disposable acceptance project this run created"
    }
    $session = New-AcceptanceMcpSession -McpUrl ([string]$Collection.mcp_url)
    Invoke-AcceptanceMcpTool -Session $session -Name 'delete_project' -Arguments @{ project_name = [string]$Collection.name; delete_notes = $true } | Out-Null
    $still = @(Get-AcceptanceMemoryProjects $session | Where-Object { $_.id -ceq [string]$Collection.id })
    # Polled, bounded by the SMB cache lifetime: the first measurement read `files_left` straight after
    # the delete and was answered from the client's cache, while the folder was already going.
    $deadline = [DateTime]::UtcNow.AddSeconds((Get-AcceptanceShareCacheSeconds) + 5)
    while (($filesLeft = Test-Path -LiteralPath ([string]$Collection.share_root)) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 500 }
    [pscustomobject]@{
        name         = [string]$Collection.name
        deregistered = ($still.Count -eq 0)
        files_left   = [bool]$filesLeft
    }
}

function Get-AcceptanceShareCacheSeconds {
    <#
    .SYNOPSIS
        How long this machine's SMB client may answer a share read from its own cache, in seconds.

    .DESCRIPTION
        MEASURED BEFORE IT WAS WRITTEN (S32). A note Basic Memory wrote answered in ~70 ms and its file
        became visible on the share at 5.1 s, three times out of three, with the read-back through MCP
        succeeding at once: the file was on the NAS, and the client was serving a cached "not found".
        The first shared row snapshotted its project straight after the arm and saw an empty folder,
        because the before-snapshot had just listed it. The client caches a missing file
        (FileNotFoundCacheLifetime, default 5), a directory listing (DirectoryCacheLifetime, default 10)
        and file metadata (FileInfoCacheLifetime, default 10); an administrator may change any of them,
        so they are read rather than assumed.
    #>
    $defaults = [ordered]@{ FileNotFoundCacheLifetime = 5; DirectoryCacheLifetime = 10; FileInfoCacheLifetime = 10 }
    $key = 'HKLM:\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters'
    $longest = 0
    foreach ($name in $defaults.Keys) {
        $value = $defaults[$name]
        try {
            $item = Get-ItemProperty -LiteralPath $key -Name $name -ErrorAction Stop
            $value = [int]$item.$name
        }
        catch { }
        if ($value -gt $longest) { $longest = $value }
    }
    $longest
}

function Wait-AcceptanceShareSettled {
    <# Wait out the SMB client's caches, so a snapshot of a project reads the NAS rather than this client's memory of it. #>
    Start-Sleep -Seconds ((Get-AcceptanceShareCacheSeconds) + 1)
}

function Get-AcceptanceCollectionEffect {
    <#
    .SYNOPSIS
        What an arm left in its disposable project, as `shared/<relative path>` -> normalised content.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$ShareRoot,
        [Parameter(Mandatory = $true)]$Tokens,
        # Given for a BEFORE-snapshot: its notes are then read through Basic Memory, never from the share.
        $Collection
    )
    # THE BEFORE-SNAPSHOT MUST NOT READ A NOTE FROM THE SHARE (S33, measured). This machine's SMB client
    # keeps serving a file it has READ ONCE after Basic Memory rewrites it on the NAS -- still stale at
    # 240 s, three measurements, while a file it had never read showed the rewrite at once and Basic
    # Memory's own readback had it immediately. The cache lifetimes waited out below govern new files
    # and listings, not that. So a before-snapshot read from the share turned the after-snapshot into
    # the before-snapshot's memory: `hub.new`'s catalog compared its old body against the kernel's new
    # one, and a `readonly` shared row could never have seen a note change. Notes are read through Basic
    # Memory here, so the share's own read of them -- the after-snapshot -- is this machine's first.
    # Anything that is not a note (the `.owner` records) is written by this machine and read from disk.
    $readBytes = $null
    if ($null -ne $Collection) {
        $session = New-AcceptanceMcpSession -McpUrl ([string]$Collection.mcp_url)
        $projectId = [string]$Collection.id
        $readBytes = {
            param($File, [string]$Relative)
            if (-not $Relative.EndsWith('.md')) { return , [IO.File]::ReadAllBytes($File.FullName) }
            $answer = Invoke-AcceptanceMcpTool -Session $session -Name 'read_note' -Arguments @{
                project_id = $projectId; identifier = $Relative.Substring(0, $Relative.Length - 3); output_format = 'json'; include_frontmatter = $true
            } | ConvertFrom-Json
            if ($null -eq $answer -or [string]$answer.file_path -cne $Relative) {
                throw "the before-snapshot could not read '$Relative' through Basic Memory, and reading it from the share would blind the after-snapshot"
            }
            , [Text.UTF8Encoding]::new($false).GetBytes([string]$answer.content)
        }
        # NOT .GetNewClosure(): that binds the block to a new module, where this file's functions are not
        # visible. Invoked from Get-AcceptanceEffect, it reads $session and $projectId up the call stack.
    }
    # The workspace's own snapshot rules, re-keyed: one normaliser, not two that could drift apart.
    $effect = [ordered]@{}
    $snapshot = Get-AcceptanceEffect -Workspace $ShareRoot -Tokens $Tokens -ReadBytes $readBytes
    foreach ($key in @($snapshot.Keys)) { $effect["shared/$key"] = $snapshot[$key] }
    $effect
}

function Invoke-AcceptanceSharedCollectionSelfTest {
    $failures = [Collections.Generic.List[string]]::new()
    $counter = @{ checks = 0 }
    function Assert([bool]$Condition, [string]$Message) { $counter.checks++; if (-not $Condition) { [void]$failures.Add($Message) } }
    $id = '0123abcd-0000-4000-8000-000000000001'
    $name = 'acceptance-0123abcd-0000-4000-8000-00000000000a'
    Assert (Test-AcceptanceDisposableName $name) 'a disposable project name was not recognised'
    foreach ($bad in @('ai-library', 'main', 'acceptance-', 'acceptance-x', "$name-x", 'Acceptance-0123abcd-0000-4000-8000-00000000000a', "x$name")) {
        Assert (-not (Test-AcceptanceDisposableName $bad)) "'$bad' was recognised as a disposable project name"
    }
    Assert (Test-AcceptanceCollectionDeletable -Name $name -Id $id -Created @($id) -Preexisting @()) 'a project this run created was not deletable'
    Assert (-not (Test-AcceptanceCollectionDeletable -Name 'ai-library' -Id $id -Created @($id) -Preexisting @())) 'a project not named as disposable was deletable'
    Assert (-not (Test-AcceptanceCollectionDeletable -Name $name -Id $id -Created @() -Preexisting @())) 'a project this run did not create was deletable'
    Assert (-not (Test-AcceptanceCollectionDeletable -Name $name -Id $id -Created @($id) -Preexisting @($id))) 'a project that existed before the run was deletable'
    Assert (-not (Test-AcceptanceCollectionDeletable -Name $name -Id '' -Created @('') -Preexisting @())) 'a project with no id was deletable'
    [pscustomobject]@{ passed = ($failures.Count -eq 0); checks = $counter.checks; failures = @($failures) }
}

if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') {
    $result = Invoke-AcceptanceSharedCollectionSelfTest
    if (-not $result.passed) { Write-Output "acceptance-shared-collection selftest: $(@($result.failures).Count) of $($result.checks) FAILED"; $result.failures | ForEach-Object { "  - $_" }; exit 1 }
    Write-Output "acceptance-shared-collection selftest: $($result.checks) checks passed"
}
