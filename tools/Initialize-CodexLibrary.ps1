<#
.SYNOPSIS
    Generate machine-local Codex bindings for this copy of the Library.

.DESCRIPTION
    Resolves the Library root from this script's own location, renders the tracked path-free
    templates under .codex/, and writes .codex/config.toml plus .codex/hooks.json only when their
    content changes. The generated files are intentionally gitignored.

    IT ALSO WRITES THE DEPLOYMENT ITSELF, from 2026-09-19. The Basic Memory endpoint and the
    collection id used to sit as literals in thirty-one tracked files, which made every clone a
    statement about Eric's network. They are now generated state: this helper writes
    .claude/.library-mcp-url and .claude/.library-project, both gitignored, and
    tools/LibraryDeployment.ps1 is what every other helper resolves them through. Run it once per
    checkout; without it nothing that reaches the collection will run, and each refusal says so.

    THE `required` FLAG IS SET HERE RATHER THAN SHIPPED. A template that hardcodes
    `required = true` on the Basic Memory server is a deployment assumption: it makes Codex refuse
    to start when no endpoint exists, which is precisely the state a fresh clone is in. The
    template carries a token and this helper decides -- required when an endpoint is configured,
    and not required when the caller explicitly declines one with -NoBasicMemory.
#>
[CmdletBinding()]
param(
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [string]$CollectionId = $env:AI_LIBRARY_PROJECT_ID,
    [string]$SharedCollectionRoot = $env:LIBRARY_SHARED_COLLECTION_ROOT,
    [switch]$NoBasicMemory,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-TomlString([string]$Value) {
    '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Replace-ExactToken([string]$Text, [string]$Token, [string]$Replacement, [int]$ExpectedCount = 1) {
    $count = ([regex]::Matches($Text, [regex]::Escape($Token))).Count
    if ($count -ne $ExpectedCount) { throw "Template token '$Token' must appear exactly $ExpectedCount time(s); found $count." }
    $Text.Replace($Token, $Replacement)
}

function Write-IfChanged([string]$Path, [string]$Content) {
    if ((Test-Path -LiteralPath $Path -PathType Leaf) -and [IO.File]::ReadAllText($Path) -ceq $Content) { return $false }
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
    $true
}

$libraryRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$codexDirectory = Join-Path $libraryRoot '.codex'
$configTemplatePath = Join-Path $codexDirectory 'config.template.toml'
$hooksTemplatePath = Join-Path $codexDirectory 'hooks.template.json'
foreach ($path in @($configTemplatePath, $hooksTemplatePath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required Codex template is missing: $path" }
}

# WHERE THIS URL COMES FROM, AND WHY IT MOVED. .mcp.json used to be its single home: Claude
# registered Basic Memory directly, and Codex's config was rendered from that same entry. Claude no
# longer registers it -- the validated reader is registered alone, so a settings file that fails to
# load cannot leave unguarded Basic Memory tools serving -- while Codex still needs the URL for the
# trusted interactive Librarian's guarded direct write surface. Hence an explicit chain rather than
# one source: argument, then AI_LIBRARY_MCP_URL (the same variable every other helper reads), then
# the state a previous run of THIS helper generated, then the old .mcp.json entry for a checkout
# that still carries it.
#
# READING BACK ITS OWN OUTPUT IS THE POINT, not a loophole. `Re-run the initializer after moving the
# folder` has been the instruction since the bindings became path-absolute, and a re-run that
# demanded the endpoint again every time would make that instruction a lie -- it failed exactly
# that way in codex.portability-selftest, which initialises a fixture twice and asserts the second
# run is idempotent. Generated state is where the deployment is SUPPOSED to live; the refusal below
# is for a workspace that has none anywhere, not for one that was configured yesterday.
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')
. (Join-Path $PSScriptRoot 'HookRegistry.ps1')
. (Join-Path $PSScriptRoot 'CodexBindings.ps1')
if ([string]::IsNullOrWhiteSpace($McpUrl)) { $McpUrl = $env:AI_LIBRARY_MCP_URL }
if ([string]::IsNullOrWhiteSpace($McpUrl)) { $McpUrl = Resolve-LibraryMcpUrl -WorkspacePath $libraryRoot -Optional }
if ([string]::IsNullOrWhiteSpace($CollectionId)) { $CollectionId = Resolve-LibraryCollectionId -WorkspacePath $libraryRoot -Optional }
if ([string]::IsNullOrWhiteSpace($SharedCollectionRoot)) { $SharedCollectionRoot = Resolve-LibrarySharedCollectionRoot -WorkspacePath $libraryRoot }
if ([string]::IsNullOrWhiteSpace($McpUrl)) {
    $claudeConfigPath = Join-Path $libraryRoot '.mcp.json'
    if (Test-Path -LiteralPath $claudeConfigPath -PathType Leaf) {
        try { $claudeConfig = [IO.File]::ReadAllText($claudeConfigPath) | ConvertFrom-Json }
        catch { throw ".mcp.json is not valid JSON: $($_.Exception.Message)" }
        # Walked property by property. Under Set-StrictMode a missing 'basic-memory' THROWS rather
        # than yielding null, and its absence is now the ordinary case rather than a fault -- reading
        # it directly is what broke codex.portability-selftest the moment the entry was removed.
        $serverProperty = $claudeConfig.PSObject.Properties['mcpServers']
        if ($null -ne $serverProperty) {
            $entryProperty = $serverProperty.Value.PSObject.Properties['basic-memory']
            if ($null -ne $entryProperty) { $McpUrl = [string]$entryProperty.Value.url }
        }
    }
}
# NO SHIPPED DEFAULT. Until 2026-09-19 this line read `$McpUrl = 'http://<the NAS>:8000/mcp'` and
# called itself "the same default the reader adapter carries", which was true and was the problem:
# three files agreeing on one reader's network address is still one reader's network address.
if (-not $NoBasicMemory -and [string]::IsNullOrWhiteSpace($McpUrl)) {
    throw ('No Basic Memory endpoint was given, and this workspace has none recorded. Pass -McpUrl ' +
           '<url> or set AI_LIBRARY_MCP_URL. Basic Memory is required in v0; pass -NoBasicMemory only ' +
           'to render Codex bindings without it.')
}
if (-not [string]::IsNullOrWhiteSpace($McpUrl) -and $McpUrl -cnotmatch '^https?://[^\s]+$') {
    throw 'McpUrl must be an absolute HTTP or HTTPS URL.'
}
if (-not $NoBasicMemory -and [string]::IsNullOrWhiteSpace($CollectionId)) {
    throw ('No collection id was given, and this workspace has none recorded. Pass -CollectionId <id> ' +
           'or set AI_LIBRARY_PROJECT_ID. It is the Basic Memory project the Library reads and writes, ' +
           'and nothing addresses a Book without it.')
}

$readerPath = (Join-Path $libraryRoot '.claude/adapters/Validated-BookReader.ps1').Replace('\', '/')
$guardPath = (Join-Path $libraryRoot '.claude/hooks/Guard-BasicMemoryRead.ps1').Replace('\', '/')
$contextPath = (Join-Path $libraryRoot '.claude/hooks/Get-VirtualDeskContext.ps1').Replace('\', '/')
# The Shelf guard reached the Codex bindings on 2026-09-06, in the same pass that fixed the hooks
# file's shape. Codex sessions run in this same checkout, so a closed Shelf Book was readable there
# by shell command exactly as it was in Claude Code.
$shellGuardPath = (Join-Path $libraryRoot '.claude/hooks/Guard-ShellShelfRead.ps1').Replace('\', '/')
# Codex edits files through apply_patch, which is a PATH-shaped tool rather than a shell one, so it
# binds to the path guard rather than to the shell guard beside it.
$patchGuardPath = (Join-Path $libraryRoot '.claude/hooks/Guard-ShelfBookRead.ps1').Replace('\', '/')
foreach ($path in @($readerPath, $guardPath, $contextPath, $shellGuardPath, $patchGuardPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required Library entry point is missing: $path" }
}

$configTemplate = [IO.File]::ReadAllText($configTemplatePath)
$config = Replace-ExactToken $configTemplate '"__BASIC_MEMORY_URL__"' (ConvertTo-TomlString $McpUrl)
$config = Replace-ExactToken $config '"__VALIDATED_READER_PATH__"' (ConvertTo-TomlString $readerPath)
# Rendered as bare TOML booleans, so the quotes around the token in the template go with it: a
# quoted "true" is a string to Codex and would not enable anything.
$basicMemoryOn = if ($NoBasicMemory) { 'false' } else { 'true' }
$config = Replace-ExactToken $config '"__BASIC_MEMORY_ENABLED__"' $basicMemoryOn
$config = Replace-ExactToken $config '"__BASIC_MEMORY_REQUIRED__"' $basicMemoryOn
if ($config -cmatch '__[A-Z0-9_]+__') { throw 'The rendered Codex config still contains a template token.' }

# ONE RENDERER FOR ONE DOCUMENT, from 2026-09-22. `library init` writes this same hooks file into a
# reader's workspace now (ADR-0036, extended to Codex), and the only thing that differs between the
# two copies is nothing at all: both point at THIS program's hook directory. Two renderers for one
# document is the shape `plugin.generated-files-match` was green over for a fortnight, so there is
# one, in tools/CodexBindings.ps1, and the four guard commands and their token counts live with it.
$hooks = New-CodexHooksDocument -TemplatePath $hooksTemplatePath -HookDirectory (Join-Path $libraryRoot '.claude/hooks')
try { $rendered = $hooks | ConvertFrom-Json } catch { throw "Rendered Codex hooks are invalid JSON: $($_.Exception.Message)" }
# VALID JSON WAS NEVER THE BAR, and believing it was cost the Codex boundary entirely. Codex accepts
# only 'description' and 'hooks' at the root of this file. Until 2026-09-06 the Library wrote the
# events at the root instead, so every Codex session started with
#   warning: failed to parse hooks config ...: unknown field `PreToolUse`
# and no Library hook registered at all. The file parsed as JSON the whole time.
#
# THE RULE MOVED TO A JUDGE AND THE JUDGE IS SHARED. `Test-CodexHookShape` asks it, plus the nested
# array shape Claude Code requires and Codex accepts, so this renderer, the workspace initialiser and
# both gate checks ask ONE question -- the same consolidation `Test-ClaudeHookShape` already made on
# the Claude side, and for the same reason: a second copy is a second chance to disagree.
# The judge moved INTO the renderer on 2026-09-22, so a caller cannot skip it. Re-asserted here
# on the parsed document anyway, because this file's own result reports what it wrote and a
# second look at two lines is cheaper than a boundary that is silently absent.
$shapeFaults = @(Test-CodexHookShape -Document $rendered -Label 'the rendered Codex hooks')
if ($shapeFaults.Count) { throw ($shapeFaults -join '; ') }

$configPath = Join-Path $codexDirectory 'config.toml'
$hooksPath = Join-Path $codexDirectory 'hooks.json'
$configChanged = Write-IfChanged -Path $configPath -Content $config
$hooksChanged = Write-IfChanged -Path $hooksPath -Content $hooks

# THE DEPLOYMENT STATE, written last so a rejected template leaves nothing half-configured.
# Both files are one trimmed line with a trailing newline, which is the contract
# .claude/.library-project has always had -- the reader adapter, Guard-BasicMemoryRead.ps1 and
# Set-VirtualDesk.ps1 read it with .Trim() and predate this helper. Only the committing of it
# changed: it is gitignored now, so a clone carries no collection at all until this runs.
$stateDirectory = Join-Path $libraryRoot '.claude'
if (-not (Test-Path -LiteralPath $stateDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
}
$mcpUrlPath = Join-Path $stateDirectory '.library-mcp-url'
$collectionIdPath = Join-Path $stateDirectory '.library-project'
$mcpUrlChanged = $false
$collectionIdChanged = $false
if (-not [string]::IsNullOrWhiteSpace($McpUrl)) {
    $mcpUrlChanged = Write-IfChanged -Path $mcpUrlPath -Content ($McpUrl.Trim() + "`n")
}
if (-not [string]::IsNullOrWhiteSpace($CollectionId)) {
    $collectionIdChanged = Write-IfChanged -Path $collectionIdPath -Content ($CollectionId.Trim() + "`n")
}
# Optional, unlike the other two, because the collection is reachable over MCP without it. It buys
# the filesystem-side cleanup SharedCollectionFiles.ps1 does after an archive; with none configured
# every caller reports `unavailable` and leaves the emptied directory, which it already says.
$sharedRootPath = Join-Path $stateDirectory '.library-shared-root'
$sharedRootChanged = $false
if (-not [string]::IsNullOrWhiteSpace($SharedCollectionRoot)) {
    $sharedRootChanged = Write-IfChanged -Path $sharedRootPath -Content ($SharedCollectionRoot.Trim() + "`n")
}
$result = [pscustomobject]@{
    operation = 'Initialize Codex Library bindings'
    library_root = $libraryRoot
    config = '.codex/config.toml'
    config_changed = $configChanged
    hooks = '.codex/hooks.json'
    hooks_changed = $hooksChanged
    mcp_url_state = '.claude/.library-mcp-url'
    mcp_url_changed = $mcpUrlChanged
    collection_id_state = '.claude/.library-project'
    collection_id_changed = $collectionIdChanged
    shared_root_state = '.claude/.library-shared-root'
    shared_root_changed = $sharedRootChanged
    basic_memory_required = (-not $NoBasicMemory)
    validated_reader_required = $true
    plugin_required = $false
    shared_library_write = $false
}
if ($Json) { $result | ConvertTo-Json -Compress }
else { $result }
