<#
.SYNOPSIS
    The canonical plugin package, the Claude files generated from it, and the one table that names
    an installed MCP tool. Dot-sourced; never invoked directly except with -SelfTest or -Write.

.DESCRIPTION
    PLAN-public-release.md step 19. THE PLUGIN ROOT IS THE PROGRAM ROOT -- this repository -- and the
    Codex manifests under `.codex-plugin/` are CANONICAL: `plugin.json`, `mcp.json`, `hooks.json`,
    with skills shared at `.claude/skills/`. Claude's `.claude-plugin/plugin.json`, its `.mcp.json`,
    its hooks file and both harnesses' repo-scoped marketplace files are GENERATED from those by this
    module and never hand-maintained; `plugin.generated-files-match` regenerates them, fails the gate
    on any drift, and separately judges both hooks documents against the SHAPE a harness will load --
    a diff proves the pair agree, never that either is loadable.

    EVERY ADDRESS IN HERE WAS MEASURED AGAINST AN INSTALLED PLUGIN, not taken from the plan, and
    three of them were wrong: an install copies only the plugin's source directory; Codex reads
    `.codex-plugin/plugin.json` rather than a root `plugin.json`; and its marketplace is
    `.agents/plugins/marketplace.json` with an entry shape of its own. See the S13 entry in
    PLAN-REVIEW-LOG-public-release.md.

    WHY A TABLE AT ALL, WHEN docs/mcp-tool-allowlist-check.md SAYS NOT TO KEEP ONE. That decision --
    "the tool list is asked of the adapter, not kept beside it" -- still stands and is honoured here:
    nothing in this file names a single tool. What a plugin adds is a PREFIX the adapter cannot know,
    because it is composed by the harness at install time out of the plugin id and the server id.
    So the table is not a list of tools; it is the COMPOSITION RULE, and the tool names that go
    through it are still asked of the adapter over JSON-RPC. That distinction is the whole of step
    19's "one table" question.

    THE THREE FORMS, AND WHY THEY DIFFER.
      project   mcp__<server>__<tool>                     a server in a workspace .mcp.json
      plugin    mcp__plugin_<plugin>_<server>__<tool>     the same server supplied by a Claude plugin
      codex     mcp__<server, - as _>__<tool>             Codex, plugin or project server alike

    ALL THREE ARE MEASURED SINCE 2026-09-23 (S37), each in a real session with a probe binary. The
    `plugin` form was only a composition until then, for the reason recorded below; a `--plugin-dir`
    session offered `mcp__plugin_probeplug_probe-reader__probe_tool`. The `codex` form was WRONG until
    then: Codex turns a server's hyphens into underscores, in the name it offers and in a PreToolUse
    payload's `tool_name`.

    AND THE PLUGIN IS THE COMPILED KERNEL SINCE S37: every hook is `bin/library hook <verb>` and
    Claude's reader is `bin/library mcp serve`. Codex's plugin carries NO reader, the reader's ruling
    of 2026-09-23 -- a Codex plugin server starts in the plugin cache with no MCP roots and none of the
    session's environment, so it could never tell which workspace it serves -- and in Codex the reader
    stays the project server `library init` writes. So `.codex-plugin/mcp.json` declares NO server,
    explicitly -- with no `mcpServers` in its manifest, Codex falls back to the plugin root's
    `.mcp.json`, the program's own development config, and served the PowerShell adapter from it
    (measured) -- and the reader Claude's plugin carries is defined in `.codex-plugin/reader.json`.

    AND THE HYPHEN RULE REACHES EVERY SERVER, NOT ONLY THE READER (S38). Basic Memory is
    `mcp__basic_memory__<tool>` in Codex and `mcp__basic-memory__<tool>` in Claude Code, so the plugin's
    guard matches `^mcp__basic[-_]memory__.*$`; and every hook whose sentences name the reader -- the Desk
    hook and both Shelf guards -- is handed `--reader-tool-prefix`, composed through the one table below.

    AND ON 2026-09-21 A SESSION DID START WITH THIS PACKAGE INSTALLED, WHICH SETTLED NOTHING ABOUT
    THE NAME AND A GREAT DEAL ABOUT THE PACKAGE. The plugin was installed from a staged 236-file
    tree and enabled; `claude plugin details` reported 1 skill, 2 hook events and 1 MCP server. In
    the session it contributed NONE OF THEM. Every session transcript captured -- with the project
    `.mcp.json` in place and with it moved aside -- carried

        {"name": "plugin:deskpost:validated-book-reader", "status": "failed", "source": "plugin"}

    in its `init` event, and offered zero reader tools when the project server was the one removed.
    The plugin's hooks never fired either, and its skill never appeared in the skill list. All three
    negatives were controlled: a probe injected into the adapter and into the shell guard, in BOTH
    the install cache and the marketplace source, wrote nothing during a session and wrote
    immediately when the same file was invoked directly.

    [S37: a `claude --plugin-dir` session DID activate all three components of a probe plugin --
    the server `connected`, both hook events fired -- so what follows is a record of an INSTALLED
    plugin, not a property of the package. Whether an installed deskpost plugin now activates is
    unmeasured, because installing it changes the reader's own Claude configuration.]

    SO THE `plugin` ROW STILL CANNOT BE CAPTURED, and the reason has changed from "no session has
    started with it" to "the components do not activate". Two things are nonetheless now known and
    neither supports the composition: the harness's OWN name for the server is
    `plugin:deskpost:validated-book-reader`, colon-separated rather than the underscore form below;
    and `claude mcp list` launches the server perfectly from the same machine, so the adapter is not
    the thing at fault. Do not promote the `plugin` row to "measured" on the strength of a model
    reciting tool names -- the first probe that appeared to confirm it printed exactly the two names
    the Desk hook's own text names, and was parroting them. See the S14 entry in
    PLAN-REVIEW-LOG-public-release.md.
#>
[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$Write,
    [string]$Workspace,
    # Build-KernelRelease.ps1's call: render a staged platform tree's plugin files (Write-ReleasePluginFiles).
    [string]$RenderReleaseStage,
    [string]$Platform
)

Set-StrictMode -Version Latest

# Test-ClaudeHookShape lives here now. HookRegistry.ps1 declares no parameters, so it is safe to
# dot-source from anywhere -- which this file is not, and which is why the judge had to move.
. (Join-Path $PSScriptRoot 'HookRegistry.ps1')

$script:GeneratedHeaderKey = '_generated'
$script:GeneratedNotice = 'GENERATED by tools/PluginPackage.ps1 from the canonical Codex-layout manifests at the program root. Do not hand-edit: plugin.generated-files-match fails the gate on a drift.'

function Get-PluginWorkspace([string]$Candidate) {
    if ($Candidate) { return (Resolve-Path -LiteralPath $Candidate).Path }
    (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
}

# --- reading the canonical package ----------------------------------------------------------------
function Read-PluginCanonical {
    param([Parameter(Mandatory)][string]$Workspace)
    # THE PLUGIN ROOT IS THE PROGRAM ROOT, and until 2026-09-20 it was a `plugin/` subdirectory
    # holding six manifest files. MEASURED, not preferred: Claude Code installs a plugin by copying
    # ONLY the directory a marketplace entry names as its source. `openai-codex` declares
    # `./plugins/codex`; that subtree holds 43 files and the installed cache holds the same 43 --
    # the repository's own `package.json`, `scripts/` and `tests/` never arrive. So a package rooted
    # at `plugin/` would have had to CARRY the program: every hook resolves its code by walking up
    # for `tools/BookRootSchema.ps1`, and above an installed `plugin/` there is nothing to find.
    # That is 110 files and 4.3 MB duplicated into the repository and regenerated on every edit.
    #
    # The repository's TRACKED tree is already exactly the program -- `shelf/`, `notebook/`, `raw/`,
    # `output/` and `internal/` are all gitignored -- so the plugin root and the program root can be
    # one directory with nothing copied anywhere. `${PLUGIN_ROOT}` then resolves to the program
    # root, and the marker walk succeeds on its first step instead of running out.
    $root = (Resolve-Path -LiteralPath $Workspace).Path
    $result = @{ root = $root }
    # THE CANONICAL FILES LIVE UNDER `.codex-plugin/`, measured rather than read off the plan, which
    # had them at the plugin root. Both Codex plugins installed on this machine --
    # `anthropic-skills@claude-cowork` and `documents@openai-primary-runtime` -- carry their manifest
    # at `.codex-plugin/plugin.json` and neither has one at the plugin root. The field set is the one
    # the canonical file already used (name, version, description, author, repository, license,
    # keywords, skills, interface), so the file was right and its address was not; it is the exact
    # mirror of Claude's `.claude-plugin/plugin.json`, which is presumably why the convention exists.
    #
    # AND THE HOOKS FILE'S ADDRESS IS A SAFETY PROPERTY RATHER THAN A
    # PREFERENCE. The canonical hooks document carries `${PLUGIN_ROOT}`, which Claude Code
    # does not expand; `hooks/hooks.json` at the plugin root is exactly where Claude Code looks for
    # its OWN hooks by convention -- the installed `openai-codex` plugin is registered that way and
    # declares no hooks path at all. Leaving the Codex file there would have invited Claude to load
    # a document whose every command names a literal `${PLUGIN_ROOT}`, and a hook that cannot run is
    # a boundary that is not there. Each harness's files now live under its own namespaced
    # directory, and neither can be picked up by the other's convention.
    #
    # Codex resolves these paths against the PLUGIN ROOT, not against the manifest's own directory:
    # `documents@openai-primary-runtime` declares `"skills": "./skills/"` from inside
    # `.codex-plugin/` and its skills sit at the plugin root.
    foreach ($pair in @(
            @{ key = 'manifest'; path = '.codex-plugin/plugin.json' },
            @{ key = 'mcp';      path = '.codex-plugin/mcp.json' },
            @{ key = 'reader';   path = '.codex-plugin/reader.json' },
            @{ key = 'hooks';    path = '.codex-plugin/hooks.json' })) {
        $full = Join-Path $root $pair.path
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            throw "the canonical plugin package has no $($pair.path); the Codex layout is the source and it is incomplete."
        }
        try { $result[$pair.key] = [IO.File]::ReadAllText($full, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json }
        catch { throw "$($pair.path) is not valid JSON: $($_.Exception.Message)" }
    }
    $result
}

function Get-PluginId {
    param([Parameter(Mandatory)]$Canonical)
    $name = [string]$Canonical.manifest.name
    if ([string]::IsNullOrWhiteSpace($name)) { throw 'plugin.json declares no name; an installed tool name cannot be composed without it.' }
    $name
}

function Get-PluginServerId {
    param([Parameter(Mandatory)]$Canonical)
    # FROM reader.json SINCE S37, where the one server is defined; mcp.json is Codex's explicit none.
    $names = @($Canonical.reader.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -cnotcontains 'mcpServers') { throw 'reader.json carries no mcpServers section.' }
    $servers = @($Canonical.reader.mcpServers.PSObject.Properties | ForEach-Object { $_.Name })
    # EXACTLY ONE, asserted rather than assumed. Step 19's ruling is that the plugin exposes one MCP
    # server, the Library's own, with Basic Memory reached behind it -- a second server here would
    # make the composition below ambiguous AND would put a peer server in the reader's harness that
    # the guard was never designed to cover.
    if ($servers.Count -ne 1) {
        throw "reader.json declares $($servers.Count) MCP server(s); the package must expose exactly one, the Library's own."
    }
    $servers[0]
}

# --- THE ONE TABLE --------------------------------------------------------------------------------
function Get-PluginToolNameForm {
    <#
        The composition rule, in one place. Every matcher, allowlist entry, guard comparison and
        advertised reader name is supposed to come through here rather than being typed.
    #>
    param(
        [Parameter(Mandatory)][ValidateSet('project', 'plugin', 'codex')][string]$Mode,
        [Parameter(Mandatory)][string]$PluginId,
        [Parameter(Mandatory)][string]$ServerId,
        # EMPTY IS THE PREFIX ITSELF, which the Desk hook is handed as --reader-tool-prefix.
        [Parameter(Mandatory)][AllowEmptyString()][string]$Tool
    )
    # BOTH NON-PROJECT FORMS ARE MEASURED NOW (S37), each in a real session. Claude Code offered a
    # `--plugin-dir` probe's tool as `mcp__plugin_probeplug_probe-reader__probe_tool`, exactly the
    # composition below. And Codex spells a server's HYPHENS AS UNDERSCORES -- `probe-proj` was listed as
    # `mcp__probe_proj__probe_tool` by Codex's own tool listing and arrived so in a PreToolUse payload's
    # `tool_name` -- for a plugin's server and a project's alike. This row read `mcp__${ServerId}__` until
    # then, which is not a name Codex has ever offered for `validated-book-reader`. Only the hyphen was
    # measured; other characters are not rewritten here because nothing has shown what Codex does to them.
    switch ($Mode) {
        'project' { "mcp__${ServerId}__${Tool}" }
        'codex'   { "mcp__$($ServerId.Replace('-', '_'))__${Tool}" }
        'plugin'  { "mcp__plugin_${PluginId}_${ServerId}__${Tool}" }
    }
}

function Get-PluginToolNames {
    <#
        Every installed name, in every mode, for every tool the ADAPTER declares. The tool names are
        asked, never listed here.
    #>
    param(
        [Parameter(Mandatory)][string]$Workspace,
        [string[]]$ToolNames
    )
    $canonical = Read-PluginCanonical -Workspace $Workspace
    $pluginId = Get-PluginId -Canonical $canonical
    $serverId = Get-PluginServerId -Canonical $canonical

    $tools = @($ToolNames | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if (-not $tools.Count) { $tools = @(Get-PluginAdapterTools -Workspace $Workspace -ServerId $serverId) }
    if (-not $tools.Count) {
        throw 'the adapter declared no tools, so no installed name can be composed. A silent adapter read as "declares nothing" is the quiet clean answer this must never give.'
    }

    $rows = [Collections.Generic.List[object]]::new()
    foreach ($tool in ($tools | Sort-Object)) {
        [void]$rows.Add([pscustomobject]@{
            tool    = $tool
            project = Get-PluginToolNameForm -Mode 'project' -PluginId $pluginId -ServerId $serverId -Tool $tool
            plugin  = Get-PluginToolNameForm -Mode 'plugin'  -PluginId $pluginId -ServerId $serverId -Tool $tool
            codex   = Get-PluginToolNameForm -Mode 'codex'   -PluginId $pluginId -ServerId $serverId -Tool $tool
        })
    }
    @($rows)
}

function Get-PluginAdapterTools {
    <#
        Ask the workspace's own adapter what it declares, over the same JSON-RPC stdio channel the
        reader's client uses. Reuses tools/McpToolInventory.ps1 rather than opening a second way to
        ask the same question.
    #>
    param([Parameter(Mandatory)][string]$Workspace, [Parameter(Mandatory)][string]$ServerId)
    . (Join-Path $PSScriptRoot 'McpToolInventory.ps1')
    # The inventory's rows name the server in `server` and its arguments in `arguments`; reading
    # `name`/`args` here threw under StrictMode and the catch reported "declares no server", which
    # is a different fault entirely. Shape first, then values.
    $servers = @(Get-McpConfiguredServer -Workspace $Workspace)
    $match = @($servers | Where-Object { [string]$_.server -ceq $ServerId })
    if (-not $match.Count) {
        $seen = @($servers | ForEach-Object { [string]$_.server }) -join ', '
        throw "this workspace's .mcp.json declares no server named '$ServerId'; it declares: $seen."
    }
    if (-not $match[0].enumerable) {
        throw "the server '$ServerId' is not enumerable offline ($([string]$match[0].reason)), so its tool names cannot be asked for here."
    }
    @(Invoke-McpToolsList -Command $match[0].command -ArgumentList @($match[0].arguments) -WorkingDirectory $Workspace)
}

# --- generation -----------------------------------------------------------------------------------
function ConvertTo-PluginJsonText($Value) {
    # Pretty, stable, and newline-normalised, so a generated file is reviewable in a diff and a
    # regeneration on the same machine is byte-identical.
    $text = $Value | ConvertTo-Json -Depth 30
    ($text -replace "`r`n", "`n").TrimEnd() + "`n"
}

function ConvertTo-PluginCanonicalJson($Value) {
    <#
        A formatting-independent form, used ONLY for comparison. The gate must fail on a CHANGED
        MANIFEST, not on a PowerShell release that indents differently -- comparing rendered text
        would make the check report drift for an upgrade nobody performed.
    #>
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [string]) { return (ConvertTo-Json $Value -Compress) }
    if ($Value -is [bool] -or $Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) {
        return (ConvertTo-Json $Value -Compress)
    }
    if ($Value -is [Array]) {
        return '[' + ((@($Value) | ForEach-Object { ConvertTo-PluginCanonicalJson $_ }) -join ',') + ']'
    }
    # A DICTIONARY IS NOT A PSCustomObject, and reading one through PSObject.Properties yields
    # `Count`, `Keys`, `Values` and `IsReadOnly` instead of its entries. The generated files were
    # all cast to [pscustomobject] at the TOP level, so this went unnoticed until a generated file
    # carried a nested [ordered]@{} -- which then compared unequal against its own freshly written
    # bytes, on a file nobody had touched. Handled here rather than by casting at each call site:
    # the next nested structure would have repeated it.
    if ($Value -is [System.Collections.IDictionary]) {
        $keys = @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object)
        $entries = foreach ($key in $keys) {
            (ConvertTo-Json $key -Compress) + ':' + (ConvertTo-PluginCanonicalJson $Value[$key])
        }
        return '{' + (@($entries) -join ',') + '}'
    }
    $names = @($Value.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
    $parts = foreach ($name in $names) {
        (ConvertTo-Json $name -Compress) + ':' + (ConvertTo-PluginCanonicalJson $Value.$name)
    }
    '{' + (@($parts) -join ',') + '}'
}

function ConvertTo-ClaudeHookRoot($Value, [string[]]$Literal = @()) {
    # THE FIRST MECHANICAL DIFFERENCE between the two harnesses' hook files. Codex expands
    # ${PLUGIN_ROOT} in a hook command (measured S37: a plugin hook naming it ran the cached binary);
    # Claude expands ${CLAUDE_PLUGIN_ROOT}. Everything else is carried through verbatim, so a matcher or
    # a timeout can only be changed in the canonical file. `-Literal` is the SECOND difference, a list of
    # exact from/to pairs -- the reader's callable prefix, which each harness composes differently and
    # which New-ClaudeGeneratedFiles derives from the one table rather than typing.
    if ($Value -is [string]) {
        $text = $Value -replace '\$\{PLUGIN_ROOT\}', '${CLAUDE_PLUGIN_ROOT}'
        for ($i = 0; $i + 1 -lt $Literal.Count; $i += 2) { $text = $text.Replace($Literal[$i], $Literal[$i + 1]) }
        return $text
    }
    # `,` AND NOT `@()`, AND THE DIFFERENCE WAS THREE MALFORMED EVENTS. This line read
    # `return @(... | ForEach-Object { ... })`, and a function that RETURNS a one-element array
    # unrolls it to the bare element on the way out -- the @() inside is defeated by the return
    # itself. Every `hooks` list in this package holds exactly one command, so all three PreToolUse
    # entries and the whole UserPromptSubmit event were generated as OBJECTS where the harness
    # requires ARRAYS. `,$array` returns a one-element outer array whose unrolling yields the inner
    # array intact, which is the only shape correct at 0, 1 and N.
    #
    # NOTHING CAUGHT IT, and that is the more useful half. `plugin.generated-files-match` regenerates
    # and diffs against what is committed -- both sides come from this function, so a generator that
    # produces a shape no harness accepts produces it identically twice and the check reads clean. A
    # diff proves the pair AGREE; only Test-ClaudeHookShape below proves either is loadable.
    if ($Value -is [Array]) {
        $items = [Collections.Generic.List[object]]::new()
        foreach ($item in @($Value)) { [void]$items.Add((ConvertTo-ClaudeHookRoot $item $Literal)) }
        return ,$items.ToArray()
    }
    if ($null -eq $Value -or $Value -is [bool] -or $Value -is [int] -or $Value -is [long] -or $Value -is [double]) { return $Value }
    $ordered = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties)) { $ordered[$property.Name] = ConvertTo-ClaudeHookRoot $property.Value $Literal }
    [pscustomobject]$ordered
}

# --- the binary the hooks name ---------------------------------------------------------------------
# THE PLUGIN'S HOOKS AND READER ARE THE COMPILED KERNEL (S37), `bin/library[.exe]` in a release
# (tools/Build-KernelRelease.ps1). The extensionless `bin/library` is the spelling on every platform:
# on Windows, Claude Code's hook runner, Claude Code's MCP launch and Codex's MCP launch all started
# `bin/library.exe` from it, measured with a probe binary in real sessions. A development checkout has
# no bin/ at all; the plugin is installed from a release's `current`, never from the repository.
$script:BinaryCommandPattern = '^"\$\{PLUGIN_ROOT\}/bin/library" hook (?<verb>[a-z-]+)(?<rest>( --[a-z-]+ [^ "]+)*)$'

function ConvertTo-WindowsCodexHooks {
    <#
        The canonical hooks document as a WINDOWS release carries it: `& ` before every command.
        Measured 2026-09-23 on codex-cli 0.153.4: Codex runs a hook command through
        `powershell.exe -Command`, where a line opening with a quoted path is a string expression and
        runs nothing -- the same hook ran with `& "..."`, with a bare path and through `cmd /c`, and did
        not run quoted. Claude Code and a POSIX shell reject a leading `&`, which is why this is a
        render of the Codex file for one platform family and never the committed text. The reader's
        ruling of the same day chose this over an unquoted path, which breaks on a profile with a space.
        Idempotent: a command already carrying the operator is left alone.
    #>
    param([Parameter(Mandatory)]$Document)
    $copy = ($Document | ConvertTo-Json -Depth 30) | ConvertFrom-Json
    foreach ($eventProperty in @($copy.hooks.PSObject.Properties)) {
        foreach ($block in @($eventProperty.Value)) {
            foreach ($hook in @($block.hooks)) {
                if ([string]$hook.command -cmatch '^"') { $hook.command = '& ' + [string]$hook.command }
            }
        }
    }
    $copy
}

function Write-ReleasePluginFiles {
    <#
        What Build-KernelRelease calls on each staged platform tree: the one place a release's plugin
        files differ from the committed ones. Returns the relative paths it rewrote.
    #>
    param([Parameter(Mandatory)][string]$StageRoot, [Parameter(Mandatory)][string]$Platform)
    if ($Platform -notmatch '^win-') { return @() }
    $relative = '.codex-plugin/hooks.json'
    $path = Join-Path $StageRoot $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "the staged release has no $relative to render for $Platform." }
    $document = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    [IO.File]::WriteAllText($path, (ConvertTo-PluginJsonText (ConvertTo-WindowsCodexHooks -Document $document)), [Text.UTF8Encoding]::new($false))
    @($relative)
}

function Get-KernelHookActions {
    <#
        The hook verbs the kernel DECLARES, asked of it -- `library verbs` is the authority the matrix
        reads too -- so a manifest naming a verb the binary does not answer is a gate failure here rather
        than a hook that exits non-zero in a reader's session, which Claude Code treats as non-blocking.
    #>
    param([Parameter(Mandatory)][string]$Workspace)
    $cli = Join-Path $Workspace 'kernel/src/cli.ts'
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node is not on PATH, so the kernel cannot be asked which hook verbs it declares.' }
    $text = (& node $cli verbs 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0 -or -not $text.Trim()) { throw "library verbs did not answer (exit $LASTEXITCODE)." }
    $verbs = $text | ConvertFrom-Json
    @($verbs.verbs.hook.actions | ForEach-Object { [string]$_ })
}

function Get-MatcherToolNames([string]$Matcher) {
    # The tool names a matcher of the Library's own shapes names: an alternation, optionally anchored
    # and parenthesised, with `.*` standing for a sample tool. Not a regex expander -- a matcher outside
    # these shapes is reported by the caller rather than guessed at.
    $core = ([string]$Matcher).Trim()
    if ($core.StartsWith('^')) { $core = $core.Substring(1) }
    if ($core.EndsWith('$')) { $core = $core.Substring(0, $core.Length - 1) }
    if ($core -cmatch '^\((.*)\)$') { $core = $Matches[1] }
    @($core -split '\|' | ForEach-Object { $_.Replace('.*', 'read_note') } | Where-Object { $_ })
}

function Get-GuardedToolExpectations {
    <#
        Every (hook verb, tool name) pair the Library's OWN registrations guard, read from the two files
        `library init` renders -- the program's `.claude/settings.json` and `.codex/hooks.template.json`
        -- so the plugin cannot quietly guard less than a direct install. Until S37 the plugin carried
        the Codex matchers alone, and a Claude session with only the plugin would have left Read, Grep,
        Glob, Write, Edit and the PowerShell tool unguarded over a closed Book.
    #>
    param([Parameter(Mandatory)][string]$Workspace)
    $byScript = @{
        'Guard-BasicMemoryRead.ps1' = 'basic-memory-read'; 'Guard-ShelfBookRead.ps1' = 'shelf-read'
        'Guard-ShellShelfRead.ps1' = 'shell-shelf-read'
    }
    $byPlaceholder = @{
        '__BASIC_MEMORY_GUARD_COMMAND__' = 'basic-memory-read'; '__PATCH_GUARD_COMMAND__' = 'shelf-read'
        '__SHELL_GUARD_COMMAND__' = 'shell-shelf-read'
    }
    $pairs = [Collections.Generic.List[object]]::new()
    foreach ($source in @(
            @{ path = '.claude/settings.json'; map = $byScript },
            @{ path = '.codex/hooks.template.json'; map = $byPlaceholder })) {
        $document = [IO.File]::ReadAllText((Join-Path $Workspace $source.path), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
        foreach ($block in @($document.hooks.PreToolUse)) {
            foreach ($hook in @($block.hooks)) {
                # THE COMMAND AND ITS ARGS, as the registry reads a hook: the program's settings name the
                # script in `args`, the template in `command`.
                $text = Get-HookEntryText $hook
                foreach ($key in @($source.map.Keys)) {
                    if (-not $text.Contains($key)) { continue }
                    foreach ($tool in @(Get-MatcherToolNames $block.matcher)) {
                        [void]$pairs.Add([pscustomobject]@{ verb = $source.map[$key]; tool = $tool; source = $source.path })
                    }
                }
            }
        }
    }
    @($pairs)
}

function New-ClaudeGeneratedFiles {
    <#
        Returns the generated Claude files as published-path -> object, ready to be written or
        compared. Nothing here is written to disk.
    #>
    param([Parameter(Mandatory)][string]$Workspace)
    $canonical = Read-PluginCanonical -Workspace $Workspace
    $manifest = $canonical.manifest

    # NO `_generated` KEY HERE, and it is the one generated file that may not carry one. `claude
    # plugin validate` reports every unknown manifest field -- "_generated: Unknown field. Claude
    # Code ignores it at load time" -- and a published plugin whose own manifest fails its harness's
    # validator teaches the reader to ignore that validator. The provenance note stays in the two
    # files the validator does not read, and the drift protection was never the comment anyway: it
    # is plugin.generated-files-match.
    #
    # THE THREE COMPONENT FIELDS ARE CARRIED, AND DROPPING THEM IS WHAT MADE THE PACKAGE INERT.
    # `skills`, `mcpServers` and `hooks` were absent from the generated manifest while the canonical
    # one declared all three, so Claude's copy advertised no skills, no MCP server and no hooks --
    # and `claude plugin validate` passed it, because a field that is not there is a path that
    # cannot be missing. With them present the validator checks each path RESOLVES, which is exactly
    # the "the package cannot start" fault, caught before an install rather than after one.
    #
    # The skills directory is shared verbatim: it is the same folder for both harnesses. The other
    # two point at Claude's OWN generated copies, because those are the files carrying
    # ${CLAUDE_PLUGIN_ROOT}; pointing Claude at the canonical pair would hand it ${PLUGIN_ROOT},
    # which it does not expand, and every hook command would run against a literal.
    $pluginManifest = [ordered]@{
        name        = [string]$manifest.name
        description = [string]$manifest.description
        version     = [string]$manifest.version
        author      = $manifest.author
        repository  = [string]$manifest.repository
        skills      = [string]$manifest.skills
        mcpServers  = './.claude-plugin/.mcp.json'
        hooks       = './.claude-plugin/hooks/hooks.json'
    }

    # Claude's plugin MCP config takes the same mcpServers object, with the root variable rewritten.
    $mcpConfig = [ordered]@{
        $script:GeneratedHeaderKey = $script:GeneratedNotice
        mcpServers = (ConvertTo-ClaudeHookRoot $canonical.reader.mcpServers)
    }

    # THE READER'S CALLABLE PREFIX, from the table: the Desk hook names the tool the harness offers
    # (ADR-0007), and under Claude's plugin that is the plugin form, where the canonical file carries
    # Codex's. A canonical file carrying anything else is refused by the self-test, not rewritten here.
    $pluginId = Get-PluginId -Canonical $canonical
    $serverId = Get-PluginServerId -Canonical $canonical
    $codexPrefix = Get-PluginToolNameForm -Mode 'codex' -PluginId $pluginId -ServerId $serverId -Tool ''
    $pluginPrefix = Get-PluginToolNameForm -Mode 'plugin' -PluginId $pluginId -ServerId $serverId -Tool ''
    $hooksConfig = [ordered]@{
        description = $script:GeneratedNotice + ' Source: .codex-plugin/hooks.json. ' + [string]$canonical.hooks.description
        hooks       = (ConvertTo-ClaudeHookRoot $canonical.hooks.hooks @("--reader-tool-prefix $codexPrefix", "--reader-tool-prefix $pluginPrefix"))
    }

    # THE REPO-SCOPED MARKETPLACE, GENERATED FOR THE SAME REASON THE MANIFEST IS. Step 19 asks that
    # `/plugin marketplace add Kioga/<name>` work against this repository, and `claude plugin tag`
    # validates "that plugin.json and any enclosing marketplace entry agree" -- so the entry's name,
    # description and version are a copy of the manifest's by construction, never by hand.
    #
    # `source: "./"` IS THE WHOLE POINT OF THE LAYOUT. The plugin's source directory is the
    # repository root, which is the program root, so an install copies the program and the hooks
    # find `tools/BookRootSchema.ps1` on the first step of their walk.
    # No `_generated` here either, and for the reason given on the manifest above: `claude plugin
    # validate` reads this file too and reports the key as unknown.
    $marketplace = [ordered]@{
        name     = [string]$manifest.name
        owner    = $manifest.author
        metadata = [ordered]@{
            description = [string]$manifest.description
            version     = [string]$manifest.version
        }
        plugins  = @(
            [ordered]@{
                name        = [string]$manifest.name
                description = [string]$manifest.description
                version     = [string]$manifest.version
                author      = $manifest.author
                source      = './'
            }
        )
    }

    # CODEX'S MARKETPLACE IS A DIFFERENT FILE IN A DIFFERENT PLACE WITH A DIFFERENT SHAPE, and
    # assuming otherwise would have shipped a repository only one of the two harnesses could add.
    # Measured from the two marketplaces configured on this machine: Codex reads
    # `.agents/plugins/marketplace.json`, and its entries carry `source` as an OBJECT --
    # `{ path, source }` -- where Claude's is a bare string. Step 19 asks that both
    # `/plugin marketplace add` and `codex plugin marketplace add` work against this repository;
    # that is two files, generated from one manifest so they cannot disagree about the version.
    $codexMarketplace = [ordered]@{
        name    = [string]$manifest.name
        plugins = @(
            [ordered]@{
                name   = [string]$manifest.name
                source = [ordered]@{
                    path   = './'
                    source = 'local'
                }
            }
        )
    }

    [ordered]@{
        '.claude-plugin/plugin.json'      = [pscustomobject]$pluginManifest
        '.claude-plugin/.mcp.json'        = [pscustomobject]$mcpConfig
        '.claude-plugin/hooks/hooks.json' = [pscustomobject]$hooksConfig
        '.claude-plugin/marketplace.json' = [pscustomobject]$marketplace
        '.agents/plugins/marketplace.json' = [pscustomobject]$codexMarketplace
    }
}

# Test-ClaudeHookShape MOVED to tools/HookRegistry.ps1 on 2026-09-21. It was written here for the
# package, and then a second consumer appeared: library init derives a workspace's hook block by
# rebuilding the program's own, and shipped the SAME unrolling defect this judge was written to
# catch. Two copies of that rule is how the two come to disagree, and this file cannot be
# dot-sourced -- it declares a param block -- so the judge moved to the file that can be.
function Write-PluginGeneratedFiles {
    param([Parameter(Mandatory)][string]$Workspace)
    $root = (Resolve-Path -LiteralPath $Workspace).Path
    $generated = New-ClaudeGeneratedFiles -Workspace $Workspace
    $written = [Collections.Generic.List[string]]::new()
    foreach ($relative in @($generated.Keys)) {
        $target = Join-Path $root $relative
        $parent = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) { [void](New-Item -ItemType Directory -Path $parent -Force) }
        [IO.File]::WriteAllText($target, (ConvertTo-PluginJsonText $generated[$relative]), [Text.UTF8Encoding]::new($false))
        [void]$written.Add($relative)
    }
    @($written)
}

function Test-PluginGeneratedFiles {
    <#
        Regenerate in memory and compare against what is committed. Returns one fault per file that
        is missing, unparseable or different.
    #>
    param([Parameter(Mandatory)][string]$Workspace)
    $root = (Resolve-Path -LiteralPath $Workspace).Path
    $generated = New-ClaudeGeneratedFiles -Workspace $Workspace
    $faults = [Collections.Generic.List[string]]::new()
    # EXAMINED, not "agreed". A drifted file HAS been read and compared -- counting it as unexamined
    # made the coverage assertion below fire alongside the real fault and report that this check had
    # not read what it claims, which was false and buried the one message that mattered.
    $examined = 0
    $unreadable = 0
    foreach ($relative in @($generated.Keys)) {
        $target = Join-Path $root $relative
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            [void]$faults.Add("$relative is missing; regenerate with tools/PluginPackage.ps1 -Write")
            $unreadable++
            continue
        }
        try { $onDisk = [IO.File]::ReadAllText($target, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json }
        catch {
            [void]$faults.Add("$relative is not valid JSON: $($_.Exception.Message)")
            $unreadable++
            continue
        }
        $expected = ConvertTo-PluginCanonicalJson $generated[$relative]
        $actual = ConvertTo-PluginCanonicalJson $onDisk
        if ($expected -cne $actual) {
            [void]$faults.Add("$relative does not match what the canonical package generates; it was hand-edited or the canonical file moved on")
        }
        $examined++
    }
    # ASSERTED FROM OUTSIDE THE LOOP: a generated file dropped from the set above would leave the
    # numerator and the denominator agreeing and the check reading clean.
    if ($examined + $unreadable -ne @($generated.Keys).Count) {
        [void]$faults.Add('the generated-file set and the examined count disagree; this check did not read what it claims to have read')
    }

    # AND THE SHAPE, ON BOTH FILES, read off disk rather than out of the generator. The diff above
    # says the pair agree; these two say each is a document a harness will load. Both are asserted
    # because the two harnesses read different files and a shape fixed in one is not fixed in the
    # other -- the most repeated failure in this repository.
    $shaped = 0
    foreach ($pair in @(
            @{ path = '.codex-plugin/hooks.json';         label = 'the canonical hooks file' },
            @{ path = '.claude-plugin/hooks/hooks.json';   label = "Claude's generated hooks file" })) {
        $full = Join-Path $root $pair.path
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            [void]$faults.Add("$($pair.path) is missing, so its shape could not be judged")
            continue
        }
        try { $document = [IO.File]::ReadAllText($full, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json }
        catch {
            [void]$faults.Add("$($pair.path) is not valid JSON, so its shape could not be judged")
            continue
        }
        foreach ($fault in @(Test-ClaudeHookShape -Document $document -Label $pair.label)) { [void]$faults.Add($fault) }
        $shaped++
    }
    if ($shaped -ne 2) { [void]$faults.Add("only $shaped of the 2 hooks files were shape-checked") }

    [pscustomobject]@{ faults = @($faults); compared = $examined; total = @($generated.Keys).Count; shaped = $shaped }
}

# --- self-test ------------------------------------------------------------------------------------
function Invoke-PluginPackageSelfTest {
    param([Parameter(Mandatory)][string]$Workspace)
    $failures = 0
    function Check([bool]$Condition, [string]$Message) {
        if ($Condition) { Write-Output "  ok   $Message" } else { Write-Output "  FAIL $Message"; $script:SelfTestFailures++ }
    }
    $script:SelfTestFailures = 0

    $canonical = Read-PluginCanonical -Workspace $Workspace
    $pluginId = Get-PluginId -Canonical $canonical
    $serverId = Get-PluginServerId -Canonical $canonical
    Check ($pluginId -ceq 'deskpost') "the canonical package names the plugin 'deskpost' (got '$pluginId')"
    Check (-not [string]::IsNullOrWhiteSpace($serverId)) "the canonical package declares exactly one MCP server ('$serverId')"

    # The composition rule, against a tool name the fixture supplies rather than one asked of a live
    # adapter: this case is about the RULE, and an adapter round-trip here would make it a test of
    # the adapter instead.
    $rows = @(Get-PluginToolNames -Workspace $Workspace -ToolNames @('read_open_book_page'))
    Check ($rows.Count -eq 1) "one tool in, one row out (got $($rows.Count))"
    Check ($rows[0].project -ceq "mcp__${serverId}__read_open_book_page") "project form: $($rows[0].project)"
    Check ($rows[0].plugin -ceq "mcp__plugin_${pluginId}_${serverId}__read_open_book_page") "plugin form: $($rows[0].plugin)"
    Check ($rows[0].codex -ceq "mcp__$($serverId.Replace('-', '_'))__read_open_book_page") "codex form, hyphens as underscores as Codex was measured spelling them: $($rows[0].codex)"
    Check ($rows[0].codex -cnotmatch '-') "the codex form carries no hyphen (got $($rows[0].codex))"
    Check ($rows[0].plugin -cne $rows[0].project) 'the plugin form differs from the project form, which is the whole reason the table exists'

    # The root rewrite, in both directions.
    $rewritten = ConvertTo-ClaudeHookRoot ([pscustomobject]@{ command = 'x "${PLUGIN_ROOT}/hooks/A.ps1" y' })
    Check ($rewritten.command -ceq 'x "${CLAUDE_PLUGIN_ROOT}/hooks/A.ps1" y') 'the Claude form rewrites ${PLUGIN_ROOT} to ${CLAUDE_PLUGIN_ROOT}'
    $untouched = ConvertTo-ClaudeHookRoot ([pscustomobject]@{ matcher = '^(Bash|exec)$'; timeout = 30 })
    Check ($untouched.matcher -ceq '^(Bash|exec)$') 'a matcher is carried through verbatim'
    Check ($untouched.timeout -eq 30) 'a timeout is carried through verbatim'

    # Canonical JSON ignores key order and indentation but not values -- the property the drift
    # comparison depends on.
    $a = '{"b":1,"a":{"d":2,"c":[1,2]}}' | ConvertFrom-Json
    $b = '{"a":{"c":[1,2],"d":2},"b":1}' | ConvertFrom-Json
    $c = '{"a":{"c":[1,3],"d":2},"b":1}' | ConvertFrom-Json
    Check ((ConvertTo-PluginCanonicalJson $a) -ceq (ConvertTo-PluginCanonicalJson $b)) 'reordered keys compare equal'
    Check ((ConvertTo-PluginCanonicalJson $a) -cne (ConvertTo-PluginCanonicalJson $c)) 'a changed VALUE compares unequal'

    # A DICTIONARY AND THE OBJECT IT PARSES BACK AS MUST COMPARE EQUAL. Without this the comparison
    # reads a hashtable's Count/Keys/Values as its contents, and a generated file carrying a nested
    # [ordered]@{} reports drift against bytes it just wrote itself.
    $nested = [ordered]@{ b = 1; a = [ordered]@{ d = 'x'; c = @(1, 2) } }
    $roundTripped = ($nested | ConvertTo-Json -Depth 10) | ConvertFrom-Json
    Check ((ConvertTo-PluginCanonicalJson $nested) -ceq (ConvertTo-PluginCanonicalJson $roundTripped)) `
        'a nested dictionary compares equal to the object it parses back as'
    Check ((ConvertTo-PluginCanonicalJson $nested) -cne (ConvertTo-PluginCanonicalJson ([ordered]@{ b = 1; a = [ordered]@{ d = 'x'; c = @(1, 3) } }))) `
        'a changed value inside a nested dictionary still compares unequal'

    # THE SHAPE JUDGE, PINNED IN BOTH DIRECTIONS. A positive alone would pass for a function that
    # never looks at anything, so the negative here is the EXACT document the old generator produced:
    # a one-element `hooks` list unrolled to a bare object, and a whole event unrolled the same way.
    # It must be rejected, and the fault must name the event, because "some fault somewhere" is
    # satisfied by a judge that is wrong for an unrelated reason.
    $goodShape = '{"hooks":{"PreToolUse":[{"matcher":"^x$","hooks":[{"type":"command","command":"c"}]}]}}' | ConvertFrom-Json
    Check (@(Test-ClaudeHookShape -Document $goodShape).Count -eq 0) 'the array shape both working consumers use is accepted'

    $unrolledInner = '{"hooks":{"PreToolUse":[{"matcher":"^x$","hooks":{"type":"command","command":"c"}}]}}' | ConvertFrom-Json
    $innerFaults = @(Test-ClaudeHookShape -Document $unrolledInner)
    Check ($innerFaults.Count -eq 1 -and $innerFaults[0] -match "'PreToolUse' entry 0 has 'hooks' as a") `
        "a one-element hooks list unrolled to an object is rejected and named (got: $($innerFaults -join '; '))"

    $unrolledEvent = '{"hooks":{"UserPromptSubmit":{"hooks":[{"type":"command","command":"c"}]}}}' | ConvertFrom-Json
    $eventFaults = @(Test-ClaudeHookShape -Document $unrolledEvent)
    Check ($eventFaults.Count -eq 1 -and $eventFaults[0] -match "event 'UserPromptSubmit' is a") `
        "a one-entry event unrolled to an object is rejected and named (got: $($eventFaults -join '; '))"

    $noCommand = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command"}]}]}}' | ConvertFrom-Json
    Check (@(Test-ClaudeHookShape -Document $noCommand).Count -eq 1) 'a hook with no command is rejected'
    Check (@(Test-ClaudeHookShape -Document ('{"description":"x"}' | ConvertFrom-Json)).Count -eq 1) 'a document with no hooks key is rejected'

    # THE GENERATOR'S OWN OUTPUT, before it touches disk. The regression this pins is not "the
    # committed file is wrong" -- it is "the function that writes it unrolls", which is what made
    # the committed file wrong in the first place.
    $freshHooks = (New-ClaudeGeneratedFiles -Workspace $Workspace)['.claude-plugin/hooks/hooks.json']
    Check (@(Test-ClaudeHookShape -Document $freshHooks).Count -eq 0) `
        "what the generator produces in memory is a loadable shape$(if (@(Test-ClaudeHookShape -Document $freshHooks).Count) { ': ' + ((Test-ClaudeHookShape -Document $freshHooks) -join '; ') })"

    # EVERY COMPONENT THE CANONICAL MANIFEST DECLARES SURVIVES INTO CLAUDE'S. Dropping them is what
    # made the package inert while every check stayed green, and `claude plugin validate` cannot see
    # a field that is absent.
    $freshManifest = (New-ClaudeGeneratedFiles -Workspace $Workspace)['.claude-plugin/plugin.json']
    $manifestNames = @($freshManifest.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($field in @('skills', 'mcpServers', 'hooks')) {
        Check ($manifestNames -ccontains $field) "the generated manifest declares '$field'"
    }
    foreach ($field in @('skills', 'mcpServers', 'hooks')) {
        $declared = [string]$freshManifest.$field
        $resolved = Join-Path $Workspace ($declared -replace '^\./', '')
        Check (Test-Path -LiteralPath $resolved) "the generated manifest's '$field' path exists: $declared"
    }
    # THE TWO FILES `claude plugin validate` READS may carry no unknown key; the two it does not read
    # keep the provenance note. Both halves are asserted, because dropping the note everywhere would
    # also pass an assertion that only looked for its absence.
    $fresh = New-ClaudeGeneratedFiles -Workspace $Workspace
    foreach ($validated in @('.claude-plugin/plugin.json', '.claude-plugin/marketplace.json')) {
        $keys = @($fresh[$validated].PSObject.Properties | ForEach-Object { $_.Name })
        Check ($keys -cnotcontains $script:GeneratedHeaderKey) `
            "$validated carries no '$script:GeneratedHeaderKey' field, which claude plugin validate reports as unknown"
    }
    foreach ($unread in @('.claude-plugin/.mcp.json', '.claude-plugin/hooks/hooks.json')) {
        $keys = @($fresh[$unread].PSObject.Properties | ForEach-Object { $_.Name })
        $hasNotice = ($keys -ccontains $script:GeneratedHeaderKey) -or
                     (($keys -ccontains 'description') -and ([string]$fresh[$unread].description).Contains('GENERATED by'))
        Check $hasNotice "$unread still says in its own bytes that it is generated"
    }

    # The marketplace entry and the manifest must agree, which is what `claude plugin tag` checks at
    # release time. Derived from one source here, and asserted anyway: the assertion is what says the
    # derivation is still happening.
    $market = $fresh['.claude-plugin/marketplace.json']
    $selfManifest = $fresh['.claude-plugin/plugin.json']
    Check (@($market.plugins).Count -eq 1) "the marketplace lists exactly one plugin (got $(@($market.plugins).Count))"
    Check ([string]@($market.plugins)[0].name -ceq [string]$selfManifest.name) 'the marketplace entry and the manifest name the same plugin'
    Check ([string]@($market.plugins)[0].version -ceq [string]$selfManifest.version) 'the marketplace entry and the manifest agree on the version'
    Check ([string]@($market.plugins)[0].source -ceq './') 'the marketplace entry sources the plugin from the repository root, which is the program root'

    # --- THE BINARY (S37) ---------------------------------------------------------------------------
    # EVERY CANONICAL HOOK IS `"${PLUGIN_ROOT}/bin/library" hook <verb>`, and every verb is one the
    # kernel declares. A hook that names a verb the binary refuses exits non-zero, which Claude Code
    # treats as a non-blocking error: the tool runs, and the guard was never there.
    $declared = @(Get-KernelHookActions -Workspace $Workspace)
    Check ($declared.Count -ge 4) "the kernel declares its hook verbs ($($declared -join ', '))"
    $canonicalByVerb = @{}
    foreach ($eventProperty in @($canonical.hooks.hooks.PSObject.Properties)) {
        foreach ($block in @($eventProperty.Value)) {
            foreach ($hook in @($block.hooks)) {
                $command = [string]$hook.command
                $isBinary = $command -cmatch $script:BinaryCommandPattern
                Check $isBinary "a canonical hook names the binary as bin/library hook <verb>: $command"
                if (-not $isBinary) { continue }
                $verb = $Matches['verb']
                Check ($declared -ccontains $verb) "the kernel declares 'hook $verb', which the manifest names"
                $matcher = if ($block.PSObject.Properties['matcher']) { [string]$block.matcher } else { '' }
                $canonicalByVerb[$verb] = [pscustomobject]@{ event = $eventProperty.Name; matcher = $matcher; command = $command }
            }
        }
    }
    foreach ($pair in @(@('basic-memory-read', 'PreToolUse'), @('shell-shelf-read', 'PreToolUse'), @('shelf-read', 'PreToolUse'), @('desk-context', 'UserPromptSubmit'))) {
        Check ($canonicalByVerb.ContainsKey($pair[0]) -and $canonicalByVerb[$pair[0]].event -ceq $pair[1]) "the plugin registers hook $($pair[0]) under $($pair[1])"
    }

    # THE PLUGIN GUARDS NO LESS THAN A DIRECT INSTALL, read from the two files `library init` renders.
    $expectations = @(Get-GuardedToolExpectations -Workspace $Workspace)
    Check ($expectations.Count -ge 9) "the program's own registrations name the guarded tools ($($expectations.Count) pairs)"
    foreach ($expected in $expectations) {
        $entry = $canonicalByVerb[$expected.verb]
        Check ($null -ne $entry -and $expected.tool -cmatch $entry.matcher) `
            "the plugin's hook $($expected.verb) fires on '$($expected.tool)', which $($expected.source) guards$(if ($entry) { " (matcher $($entry.matcher))" })"
    }

    # THE DESK HOOK'S PREFIX: the codex form in the canonical file, the plugin form in Claude's.
    $codexPrefix = Get-PluginToolNameForm -Mode 'codex' -PluginId $pluginId -ServerId $serverId -Tool ''
    $pluginPrefix = Get-PluginToolNameForm -Mode 'plugin' -PluginId $pluginId -ServerId $serverId -Tool ''
    Check ($canonicalByVerb['desk-context'].command.EndsWith(" --reader-tool-prefix $codexPrefix")) "the canonical Desk hook advertises Codex's name for the reader ($codexPrefix)"
    $claudeDesk = @(@($freshHooks.hooks.UserPromptSubmit)[0].hooks)[0].command
    Check ($claudeDesk -ceq "`"`${CLAUDE_PLUGIN_ROOT}/bin/library`" hook desk-context --reader-tool-prefix $pluginPrefix") "Claude's generated Desk hook advertises the plugin's name for the reader: $claudeDesk"
    Check (-not (($freshHooks | ConvertTo-Json -Depth 30).Contains($codexPrefix))) "Claude's generated hooks carry no Codex reader name"
    # EVERY HOOK THAT NAMES THE READER IS HANDED ITS PREFIX (S38), not the Desk hook alone: both Shelf
    # guards' denials send the session to read_open_book_page, and under the project default that is a
    # tool neither plugin's session is offered. The Basic Memory guard names no reader and takes none.
    foreach ($verb in @('desk-context', 'shelf-read', 'shell-shelf-read')) {
        Check ($canonicalByVerb.ContainsKey($verb) -and $canonicalByVerb[$verb].command.EndsWith(" --reader-tool-prefix $codexPrefix")) "the canonical hook $verb is handed Codex's name for the reader"
    }
    Check ($canonicalByVerb.ContainsKey('basic-memory-read') -and -not $canonicalByVerb['basic-memory-read'].command.Contains('--reader-tool-prefix')) 'the Basic Memory guard, which names no reader, is handed no prefix'
    $claudeCommands = @(foreach ($p in @($freshHooks.hooks.PSObject.Properties)) { foreach ($b in @($p.Value)) { foreach ($h in @($b.hooks)) { [string]$h.command } } })
    Check (@($claudeCommands | Where-Object { $_.EndsWith(" --reader-tool-prefix $pluginPrefix") }).Count -eq 3) "Claude's generated hooks hand all three reader-naming hooks the plugin's name ($($claudeCommands -join ' | '))"

    # THE READER: Claude's plugin carries it, Codex's does not (the reader's ruling, S37).
    # NONE MUST BE SAID, NOT LEFT UNSAID: an absent `mcpServers` makes Codex serve the root .mcp.json.
    $declaredMcp = if ($canonical.manifest.PSObject.Properties['mcpServers']) { [string]$canonical.manifest.mcpServers } else { '(absent)' }
    Check ($declaredMcp -ceq './.codex-plugin/mcp.json') "the Codex manifest names its explicit MCP declaration (got '$declaredMcp')"
    Check (@($canonical.mcp.mcpServers.PSObject.Properties).Count -eq 0) 'the Codex plugin declares no MCP server: a Codex plugin server cannot learn its workspace'
    $claudeMcp = (New-ClaudeGeneratedFiles -Workspace $Workspace)['.claude-plugin/.mcp.json']
    $server = $claudeMcp.mcpServers.$serverId
    Check ([string]$server.command -ceq '${CLAUDE_PLUGIN_ROOT}/bin/library' -and ((@($server.args) -join ' ') -ceq 'mcp serve')) "Claude's reader is bin/library mcp serve (got $([string]$server.command) $(@($server.args) -join ' '))"

    # THE WINDOWS RENDER: `& ` before every command, idempotent, and only for a win-* stage.
    $windows = ConvertTo-WindowsCodexHooks -Document $canonical.hooks
    $windowsCommands = @(foreach ($p in @($windows.hooks.PSObject.Properties)) { foreach ($b in @($p.Value)) { foreach ($h in @($b.hooks)) { [string]$h.command } } })
    Check ($windowsCommands.Count -eq 4 -and @($windowsCommands | Where-Object { $_ -cnotmatch '^& "\$\{PLUGIN_ROOT\}/bin/library" hook ' }).Count -eq 0) "the Windows render prefixes every command with & ($($windowsCommands -join ' | '))"
    $twice = ConvertTo-WindowsCodexHooks -Document $windows
    Check ((ConvertTo-PluginCanonicalJson $twice) -ceq (ConvertTo-PluginCanonicalJson $windows)) 'the Windows render is idempotent'
    Check ((ConvertTo-PluginCanonicalJson $canonical.hooks) -cne (ConvertTo-PluginCanonicalJson $windows)) 'the render did not rewrite the canonical document it was handed'
    $stage = Join-Path ([IO.Path]::GetTempPath()) ("plugin-render-" + [guid]::NewGuid().ToString('N'))
    try {
        foreach ($platform in @('win-x64', 'linux-x64')) {
            $root = Join-Path $stage $platform
            [void](New-Item -ItemType Directory -Path (Join-Path $root '.codex-plugin') -Force)
            Copy-Item -LiteralPath (Join-Path $Workspace '.codex-plugin/hooks.json') -Destination (Join-Path $root '.codex-plugin/hooks.json')
            $rewritten = @(Write-ReleasePluginFiles -StageRoot $root -Platform $platform)
            # PARSED, NOT SEARCHED: Windows PowerShell's ConvertTo-Json writes `&` as &, which is the
            # same JSON string and a different byte sequence.
            $staged = [IO.File]::ReadAllText((Join-Path $root '.codex-plugin/hooks.json')) | ConvertFrom-Json
            $stagedDesk = [string]@(@($staged.hooks.UserPromptSubmit)[0].hooks)[0].command
            if ($platform -like 'win-*') { Check ($rewritten.Count -eq 1 -and $stagedDesk.StartsWith('& "${PLUGIN_ROOT}/bin/library"')) "a $platform release renders the Codex hooks with & ($stagedDesk)" }
            else { Check ($rewritten.Count -eq 0 -and $stagedDesk.StartsWith('"${PLUGIN_ROOT}/bin/library"')) "a $platform release keeps the committed spelling ($stagedDesk)" }
        }
    } finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }

    $state = Test-PluginGeneratedFiles -Workspace $Workspace
    Check ($state.faults.Count -eq 0) "the committed generated files match the canonical package ($($state.compared) of $($state.total) compared, $($state.shaped) shape-checked)$(if ($state.faults.Count) { ': ' + ($state.faults -join '; ') })"

    if ($script:SelfTestFailures) { throw "$($script:SelfTestFailures) plugin package self-test failure(s)" }
    Write-Output "passed: plugin package, $($state.compared) generated file(s) match the canonical Codex layout"
}

if ($RenderReleaseStage) {
    try {
        if (-not $Platform) { throw '-RenderReleaseStage needs -Platform.' }
        $rendered = @(Write-ReleasePluginFiles -StageRoot $RenderReleaseStage -Platform $Platform)
        Write-Output "rendered $($rendered.Count) plugin file(s) for ${Platform}: $($rendered -join ', ')"
        exit 0
    }
    catch {
        Write-Output "FAILED: $($_.Exception.Message)"
        exit 1
    }
}

if ($SelfTest -or $Write) {
    try {
        $ws = Get-PluginWorkspace $Workspace
        if ($Write) {
            $written = @(Write-PluginGeneratedFiles -Workspace $ws)
            Write-Output "wrote $($written.Count) generated file(s): $($written -join ', ')"
        }
        if ($SelfTest) { Invoke-PluginPackageSelfTest -Workspace $ws }
        exit 0
    }
    catch {
        Write-Output "FAILED: $($_.Exception.Message)"
        exit 1
    }
}
