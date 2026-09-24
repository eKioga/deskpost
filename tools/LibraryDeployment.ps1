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

. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')

# WHERE THE WORKSPACE COMES FROM WHEN THE CALLER DOES NOT NAME ONE.
#
# Until step 22 this file sat at <workspace>/tools/ and its own location answered the question, so
# the line here read "its own location is where the workspace is". The split made that false: the
# program root carries no `.claude/.library-*` at all, and a caller that did not pass
# -WorkspacePath was therefore asking the PROGRAM for the reader's endpoint and being told there
# isn't one. Measured on 2026-09-21 in the first full gate after the migration -- EIGHT suites
# refused with "No Basic Memory endpoint is configured" while `LIBRARY_WORKSPACE` named a workspace
# that had one, and the same call answered correctly the moment the path was passed by hand. That
# second answer is the control: it proves the file is readable and the fault is in who was asked.
#
# So the workspace is resolved the way every other tool resolves it -- explicit, then
# LIBRARY_WORKSPACE, then a walk up from the current directory -- and the location-derived root
# survives only as the LAST resort. It still has one real caller: an un-split checkout whose reader
# ran `Initialize-CodexLibrary.ps1` and never `library init` has deployment state and no workspace
# marker, so nothing above would find it and removing this would break them.
#
# A CONFLICT IS FATAL rather than papered over. Three sources disagreeing about which Library this
# process is about is not something to pick a winner for: answering with the legacy root would read
# one reader's endpoint while every other tool in the same run read another's.
$script:LibraryDeploymentLegacyRoot = Split-Path -Parent $PSScriptRoot

$script:LibraryMcpUrlFileName = '.library-mcp-url'
$script:LibraryCollectionIdFileName = '.library-project'
$script:LibrarySharedRootFileName = '.library-shared-root'

function Get-LibraryDeploymentWorkspaceRoot([string]$WorkspacePath) {
    if (-not [string]::IsNullOrWhiteSpace($WorkspacePath)) { return $WorkspacePath }
    # NOT CACHED, deliberately. `Resolve-LibraryWorkspace` reads the environment at its own
    # parameter default, and this file's self-test -- like any suite that drives two workspaces in
    # one process -- changes that variable between cases. A cache would answer the second case with
    # the first case's workspace and pass for the wrong reason.
    $resolved = Resolve-LibraryWorkspace
    if ([string]$resolved.kind -ceq 'conflict') { throw ([string]$resolved.reason) }
    if ([string]$resolved.kind -ceq 'resolved') { return [string]$resolved.workspace }
    $script:LibraryDeploymentLegacyRoot
}

function Get-LibraryDeploymentStatePath([string]$WorkspacePath, [string]$FileName) {
    Join-Path (Get-LibraryDeploymentWorkspaceRoot $WorkspacePath) (Join-Path '.claude' $FileName)
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

        # 3c. AND IT ARRIVES WITHOUT BEING HANDED OVER, which is the case this file was on the wrong
        # side of until 2026-09-21. Every assertion above passes -WorkspacePath, so every one of them
        # proves the chain works WHEN GIVEN the workspace and not one of them proves the workspace
        # reaches it. The split made the difference load-bearing: the eight full-gate suites that
        # began refusing called these resolvers with nothing at all, from a process whose only
        # statement about which Library it was about was LIBRARY_WORKSPACE.
        $savedWorkspaceVar = $env:LIBRARY_WORKSPACE
        try {
            $env:LIBRARY_WORKSPACE = $sandbox
            # Each read is caught and compared rather than asserted bare: the two that refuse do so
            # by THROWING, and a throw here would abandon the remaining cases and report the suite as
            # a crash rather than naming which resolver the workspace failed to reach.
            $arrivedUrl = ''
            try { $arrivedUrl = Resolve-LibraryMcpUrl } catch { $arrivedUrl = 'THREW: ' + [string]$_.Exception.Message }
            Assert ($arrivedUrl -ceq 'http://fixture.invalid:8000/mcp') "LIBRARY_WORKSPACE did not reach the endpoint resolver; got '$arrivedUrl'"
            $arrivedId = ''
            try { $arrivedId = Resolve-LibraryCollectionId } catch { $arrivedId = 'THREW: ' + [string]$_.Exception.Message }
            Assert ($arrivedId -ceq '11111111-1111-4111-8111-111111111111') "LIBRARY_WORKSPACE did not reach the collection id resolver; got '$arrivedId'"
            Assert ((Resolve-LibrarySharedCollectionRoot) -ceq 'C:\fixture\collection') 'LIBRARY_WORKSPACE did not reach the share root resolver'
            # THE DISCRIMINATOR, because the three above would pass just as well if the resolver were
            # reading some other tree that happened to hold the same values. A workspace with no
            # deployment state must produce the refusal, and it can only do that if the resolver went
            # where it was told rather than where it lives.
            $emptyWorkspace = Join-Path ([IO.Path]::GetTempPath()) ('library-deployment-empty-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $emptyWorkspace -Force | Out-Null
            try {
                $env:LIBRARY_WORKSPACE = $emptyWorkspace
                $strayRefusal = ''
                try { Resolve-LibraryMcpUrl | Out-Null } catch { $strayRefusal = [string]$_.Exception.Message }
                Assert ($strayRefusal -ne '') 'a workspace holding no deployment state resolved an endpoint anyway, so the resolver is reading a tree other than the one it was told about'
            }
            finally { Remove-Item -LiteralPath $emptyWorkspace -Recurse -Force -ErrorAction SilentlyContinue }
        }
        finally { $env:LIBRARY_WORKSPACE = $savedWorkspaceVar }

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
