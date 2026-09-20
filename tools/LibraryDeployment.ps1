<#
.SYNOPSIS
    Resolve this deployment's Basic Memory endpoint and collection id, or refuse and name the fix.

.DESCRIPTION
    ONE BOUNDARY FOR TWO DEPLOYMENT FACTS. Until 2026-09-19 the NAS endpoint was written into
    fourteen tracked files as a fallback and the collection id into seventeen more, each as a
    parameter default. Every copy was a statement about Eric's network living in code that is about
    to be published, and a reader who cloned it inherited a machine they have no access to -- the
    helper would not refuse, it would try the wrong address and fail somewhere further in.

    So the values leave the code entirely and are resolved here, in one chain, with one refusal:

      1. what the caller passed explicitly;
      2. the environment -- AI_LIBRARY_MCP_URL, AI_LIBRARY_PROJECT_ID;
      3. generated workspace state written by tools/Initialize-CodexLibrary.ps1;
      4. otherwise a refusal that names all three.

    THE GENERATED STATE IS NOT TRACKED, which is the point. `.claude/.library-project` already
    pinned the collection id for the reader adapter, the Basic Memory guard and Set-VirtualDesk;
    it keeps that exact one-line contract and simply stops being committed.
    `.claude/.library-mcp-url` is its sibling for the endpoint. Both are written by the initializer
    and both are gitignored, so a fresh clone carries no deployment at all until its reader
    configures one.

    WHY A REFUSAL RATHER THAN A DEFAULT. A default is a guess about someone else's network. The
    refusal costs the reader one sentence and tells them exactly which of the three routes to take;
    a wrong default costs them a failed request against a host that is not theirs, diagnosed
    somewhere far from here.

    -Optional is for a self-test, and only for a self-test. Every suite that dot-sources a helper
    runs offline against fixtures, so requiring a configured deployment to run one would make the
    gate untestable on a fresh clone -- the very clone Phase B's acceptance is measured on. An
    -Optional call returns an empty string; anything that then reached the transport would fail
    loudly there rather than quietly succeeding against a host it invented.

    Dot-sourced. Declared `internal` in tools/_helpers.json and deliberately not allowlisted.
#>

Set-StrictMode -Version Latest

# This file sits at <workspace>/tools/, so its own location is where the workspace is, unless a
# caller with better information says otherwise.
$script:LibraryDeploymentDefaultRoot = Split-Path -Parent $PSScriptRoot

$script:LibraryMcpUrlFileName = '.library-mcp-url'
$script:LibraryCollectionIdFileName = '.library-project'
$script:LibrarySharedRootFileName = '.library-shared-root'

function Get-LibraryDeploymentStatePath([string]$WorkspacePath, [string]$FileName) {
    $root = if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $script:LibraryDeploymentDefaultRoot } else { $WorkspacePath }
    Join-Path $root (Join-Path '.claude' $FileName)
}

function Read-LibraryDeploymentState([string]$Path) {
    # An unreadable file is the same condition as an absent one: the chain simply moves on to the
    # refusal, which names every route. Throwing here would report a file permission where the
    # reader needs to be told how to configure a deployment.
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    try { return ([IO.File]::ReadAllText($Path)).Trim() }
    catch { return '' }
}

function Resolve-LibraryMcpUrl {
    <# The Basic Memory endpoint, or a refusal naming all three routes to one. #>
    param(
        [string]$McpUrl,
        [string]$WorkspacePath,
        [switch]$Optional
    )
    $resolved = [string]$McpUrl
    if ([string]::IsNullOrWhiteSpace($resolved)) { $resolved = [string]$env:AI_LIBRARY_MCP_URL }
    if ([string]::IsNullOrWhiteSpace($resolved)) {
        $resolved = Read-LibraryDeploymentState (Get-LibraryDeploymentStatePath $WorkspacePath $script:LibraryMcpUrlFileName)
    }
    if ([string]::IsNullOrWhiteSpace($resolved)) {
        if ($Optional) { return '' }
        throw ('No Basic Memory endpoint is configured, so there is nothing to talk to. Pass -McpUrl <url>, ' +
               'set AI_LIBRARY_MCP_URL, or run tools/Initialize-CodexLibrary.ps1 -McpUrl <url> -CollectionId <id> ' +
               'once to write .claude/.library-mcp-url for this workspace.')
    }
    # -cnotmatch, not -notmatch: the scheme is lowercase by the rule, and the case-insensitive
    # default would admit 'HTTP://' into a string that is concatenated into a request line.
    if ($resolved -cnotmatch '^https?://[^\s]+$') {
        throw "The Basic Memory endpoint must be an absolute http or https URL; got '$resolved'."
    }
    $resolved
}

function Resolve-LibraryCollectionId {
    <# The collection this workspace is attached to, or a refusal naming all three routes to one. #>
    param(
        [string]$CollectionId,
        [string]$WorkspacePath,
        [switch]$Optional
    )
    $resolved = [string]$CollectionId
    if ([string]::IsNullOrWhiteSpace($resolved)) { $resolved = [string]$env:AI_LIBRARY_PROJECT_ID }
    if ([string]::IsNullOrWhiteSpace($resolved)) {
        $resolved = Read-LibraryDeploymentState (Get-LibraryDeploymentStatePath $WorkspacePath $script:LibraryCollectionIdFileName)
    }
    if ([string]::IsNullOrWhiteSpace($resolved)) {
        if ($Optional) { return '' }
        throw ('No collection id is configured, so no shared Book or Project Hub can be addressed. Pass ' +
               '-ProjectId <id>, set AI_LIBRARY_PROJECT_ID, or run tools/Initialize-CodexLibrary.ps1 ' +
               '-McpUrl <url> -CollectionId <id> once to write .claude/.library-project for this workspace.')
    }
    $resolved
}

function Resolve-LibrarySharedCollectionRoot {
    <#
        The shared collection's filesystem root, or '' when none is configured.

        THIS ONE NEVER THROWS, and the asymmetry is deliberate. The endpoint and the collection id
        are addresses without which nothing can be attempted, so their absence is a refusal. The
        share root is a convenience over the same collection: SharedCollectionFiles.ps1 exists so
        that an unreachable share resolves to $null and every caller degrades to "unavailable" and
        says so. Turning that into a throw would make an ordinary disconnected-NAS morning into a
        crash, which is the behaviour that file was written to end. So absence stays absence --
        what changed on 2026-09-19 is only that a fresh checkout is absent by default, where it
        used to probe one reader's drive letter and one reader's host.
    #>
    param([string]$WorkspacePath)
    $resolved = [string]$env:LIBRARY_SHARED_COLLECTION_ROOT
    if ([string]::IsNullOrWhiteSpace($resolved)) {
        $resolved = Read-LibraryDeploymentState (Get-LibraryDeploymentStatePath $WorkspacePath $script:LibrarySharedRootFileName)
    }
    $resolved
}

function Invoke-LibraryDeploymentSelfTest {
    $failures = [Collections.Generic.List[string]]::new()
    # Counted, never typed: a self-test that announces a number it does not derive starts lying the
    # first time a case is added to it, and this codebase already carries one that did.
    $script:deploymentChecks = 0
    function Assert([bool]$Condition, [string]$Message) {
        $script:deploymentChecks++
        if (-not $Condition) { [void]$failures.Add($Message) }
    }

    $sandbox = Join-Path ([IO.Path]::GetTempPath()) ('library-deployment-' + [guid]::NewGuid().ToString('N'))
    $state = Join-Path $sandbox '.claude'
    New-Item -ItemType Directory -Path $state -Force | Out-Null
    $utf8 = [Text.UTF8Encoding]::new($false)
    $savedUrl = $env:AI_LIBRARY_MCP_URL
    $savedId = $env:AI_LIBRARY_PROJECT_ID
    try {
        $env:AI_LIBRARY_MCP_URL = $null
        $env:AI_LIBRARY_PROJECT_ID = $null

        # 1. Nothing configured anywhere: both refuse, and each refusal names all three routes.
        $urlRefusal = ''
        try { Resolve-LibraryMcpUrl -WorkspacePath $sandbox | Out-Null }
        catch { $urlRefusal = [string]$_.Exception.Message }
        Assert ($urlRefusal -ne '') 'an unconfigured endpoint resolved instead of refusing'
        foreach ($route in @('-McpUrl', 'AI_LIBRARY_MCP_URL', 'Initialize-CodexLibrary.ps1')) {
            Assert ($urlRefusal -clike "*$route*") "the endpoint refusal does not name $route"
        }
        $idRefusal = ''
        try { Resolve-LibraryCollectionId -WorkspacePath $sandbox | Out-Null }
        catch { $idRefusal = [string]$_.Exception.Message }
        Assert ($idRefusal -ne '') 'an unconfigured collection id resolved instead of refusing'
        foreach ($route in @('-ProjectId', 'AI_LIBRARY_PROJECT_ID', 'Initialize-CodexLibrary.ps1')) {
            Assert ($idRefusal -clike "*$route*") "the collection refusal does not name $route"
        }
        # The two refusals are distinct, so a caller is told WHICH value is missing rather than
        # being handed one shared sentence for two different configuration faults.
        Assert ($urlRefusal -cne $idRefusal) 'the endpoint and collection refusals are the same sentence'

        # 2. -Optional is the self-test escape and returns empty rather than throwing.
        Assert ((Resolve-LibraryMcpUrl -WorkspacePath $sandbox -Optional) -ceq '') '-Optional did not yield an empty endpoint'
        Assert ((Resolve-LibraryCollectionId -WorkspacePath $sandbox -Optional) -ceq '') '-Optional did not yield an empty collection id'

        # 3. Generated state answers, and is the LAST resort rather than the first.
        # 3b. The share root is the one value whose absence is NOT a refusal.
        Assert ((Resolve-LibrarySharedCollectionRoot -WorkspacePath $sandbox) -ceq '') 'an unconfigured share root threw or invented a path instead of returning empty'
        [IO.File]::WriteAllText((Join-Path $state '.library-shared-root'), "C:\fixture\collection`n", $utf8)
        Assert ((Resolve-LibrarySharedCollectionRoot -WorkspacePath $sandbox) -ceq 'C:\fixture\collection') 'generated state did not supply the share root'
        $savedShare = $env:LIBRARY_SHARED_COLLECTION_ROOT
        try {
            $env:LIBRARY_SHARED_COLLECTION_ROOT = 'C:\fixture\from-env'
            Assert ((Resolve-LibrarySharedCollectionRoot -WorkspacePath $sandbox) -ceq 'C:\fixture\from-env') 'the environment did not outrank generated state for the share root'
        }
        finally { $env:LIBRARY_SHARED_COLLECTION_ROOT = $savedShare }

        [IO.File]::WriteAllText((Join-Path $state '.library-mcp-url'), "http://fixture.invalid:8000/mcp`n", $utf8)
        [IO.File]::WriteAllText((Join-Path $state '.library-project'), "11111111-1111-4111-8111-111111111111`n", $utf8)
        Assert ((Resolve-LibraryMcpUrl -WorkspacePath $sandbox) -ceq 'http://fixture.invalid:8000/mcp') 'generated state did not supply the endpoint'
        Assert ((Resolve-LibraryCollectionId -WorkspacePath $sandbox) -ceq '11111111-1111-4111-8111-111111111111') 'generated state did not supply the collection id'

        # 4. The environment outranks generated state, and an explicit argument outranks both.
        $env:AI_LIBRARY_MCP_URL = 'http://env.invalid:9000/mcp'
        $env:AI_LIBRARY_PROJECT_ID = '22222222-2222-4222-8222-222222222222'
        Assert ((Resolve-LibraryMcpUrl -WorkspacePath $sandbox) -ceq 'http://env.invalid:9000/mcp') 'the environment did not outrank generated state for the endpoint'
        Assert ((Resolve-LibraryCollectionId -WorkspacePath $sandbox) -ceq '22222222-2222-4222-8222-222222222222') 'the environment did not outrank generated state for the collection id'
        Assert ((Resolve-LibraryMcpUrl -McpUrl 'http://explicit.invalid/mcp' -WorkspacePath $sandbox) -ceq 'http://explicit.invalid/mcp') 'an explicit endpoint did not outrank the environment'
        Assert ((Resolve-LibraryCollectionId -CollectionId '33333333-3333-4333-8333-333333333333' -WorkspacePath $sandbox) -ceq '33333333-3333-4333-8333-333333333333') 'an explicit collection id did not outrank the environment'

        # 5. A configured endpoint that is not an absolute http(s) URL is refused rather than
        #    concatenated into a request line. A share path is the one a reader would actually paste.
        foreach ($bad in @('HTTP://upper.invalid/mcp', '\\nas\basic-memory', 'nas:8000/mcp', 'http://has space/mcp')) {
            $rejected = $false
            try { Resolve-LibraryMcpUrl -McpUrl $bad -WorkspacePath $sandbox | Out-Null }
            catch { $rejected = $true }
            Assert $rejected "the endpoint validator admitted '$bad'"
        }
        # ... and the safe forms are NOT rejected, which is what stops the validator firing on a
        # correct endpoint. A pinned negative alone would pass with the pattern matching nothing.
        foreach ($good in @('http://192.0.2.10:8000/mcp', 'https://memory.example.invalid/mcp', 'http://localhost:8000/mcp')) {
            Assert ((Resolve-LibraryMcpUrl -McpUrl $good -WorkspacePath $sandbox) -ceq $good) "the endpoint validator rejected '$good'"
        }

        # 6. An unreadable or absent generated file is the same condition as an unconfigured one:
        #    it falls through to the refusal rather than reporting a file fault.
        $env:AI_LIBRARY_MCP_URL = $null
        $env:AI_LIBRARY_PROJECT_ID = $null
        [IO.File]::WriteAllText((Join-Path $state '.library-mcp-url'), "   `n", $utf8)
        $blankRefused = $false
        try { Resolve-LibraryMcpUrl -WorkspacePath $sandbox | Out-Null } catch { $blankRefused = $true }
        Assert $blankRefused 'a whitespace-only generated endpoint resolved instead of refusing'
    }
    finally {
        $env:AI_LIBRARY_MCP_URL = $savedUrl
        $env:AI_LIBRARY_PROJECT_ID = $savedId
        Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($failures.Count) {
        [Console]::Error.WriteLine("LibraryDeployment self-test FAILED: $($failures -join '; ')")
        exit 1
    }
    Write-Host "LibraryDeployment self-test passed ($($script:deploymentChecks) checks)."
    exit 0
}

# Run with:  powershell.exe -File tools/LibraryDeployment.ps1 -SelfTest
if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') {
    Invoke-LibraryDeploymentSelfTest
}
