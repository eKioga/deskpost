<#
.SYNOPSIS
    What tools the workspace's own MCP adapters actually declare, and which of them the reader's
    permission allowlist does not name. Dot-sourced; never invoked directly except with -SelfTest.

.DESCRIPTION
    THE GAP THIS CLOSES. `helpers.manifest-matches-allowlist` compares `tools/*.ps1` against
    `.claude/settings.json` and knows nothing about the validated reader adapter's tool list. So a
    new PUBLIC HELPER warns, and a new MCP TOOL raises nothing at all -- it simply prompts once per
    session until a human happens to notice. That has now bitten at rung 6, at item 2.3 (where
    `search_open_books` sat unallowlisted for a day), and it was the closing note of three items
    running.

    READ THE LIST FROM THE ADAPTER, NOT FROM A SECOND LIST. A check that compares the allowlist
    against a hand-maintained roster of tool names has built the drift it was meant to fix: the
    roster is one more place to forget. So this module derives everything from tracked
    configuration. `.mcp.json` names the servers and the exact command line each one launches; the
    adapter itself answers `tools/list`. Nothing here knows the name of a single tool.

    WHY IT RUNS THE ADAPTER RATHER THAN READING ITS SOURCE. The obvious cheap implementation is a
    regex over the adapter's source text for the `tools/list` block. This codebase has already been
    bitten by that shape twice: rung 4's static scan counted a mention inside a block comment as a
    call, so its enforcement was satisfiable by documentation. A static reader here would have to
    strip block comments before matching and would still be a guess at what the adapter declares.
    Asking the adapter is not a guess. The `tools/list` branch touches no network -- the reader
    adapter's remote session is established lazily, on the first read that needs it -- so this stays
    an offline check, which is the property the whole gate depends on. The block-comment trap is
    covered anyway: the suite's fixture adapter carries a tool name inside a block comment,
    and it must never appear in the inventory.

    WARN, DO NOT FAIL. The reader owns `.claude/settings.json` and the Librarian is refused it, so a
    missing allowlist line cannot be fixed by the process that finds it. Blocking the commit would
    block on an edit the committer cannot make. A missing line costs one permission prompt; that is
    friction worth reporting, not worth refusing a commit over. This is the same asymmetry the public
    helper half of `helpers.manifest-matches-allowlist` already draws, and it is drawn the same way
    here on purpose.

    WHAT IT CANNOT SEE, AND SAYS SO. Only a server this workspace launches itself can be enumerated
    offline. `basic-memory` is an HTTP server on the NAS: listing its tools needs the network and a
    session, and its allowlist is a curated subset by deliberate policy rather than the whole tool
    list, so "declared but not allowlisted" would be noise rather than a finding. Such servers are
    returned as `not_enumerable` with the reason, never silently dropped and never counted as clean.
#>

Set-StrictMode -Version Latest

$script:McpToolInventorySchema = 1

# A cold `powershell.exe -File` start of the reader adapter answers tools/list in well under a
# second. The timeout exists so that an adapter which blocks on something -- a prompt, a lock, a
# network call that should not be on this path -- costs the gate a bounded wait and a named failure
# rather than a hung pre-commit hook.
$script:McpToolsListTimeoutMs = 30000

function Get-McpConfiguredServer {
    <#
    .SYNOPSIS
        Every MCP server this workspace declares, split into the ones that can be enumerated offline
        and the ones that cannot, with the reason.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Workspace)

    $root = (Resolve-Path -LiteralPath $Workspace).Path
    $configPath = Join-Path $root '.mcp.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw 'This workspace declares no .mcp.json, so no MCP server can be enumerated.'
    }
    $config = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
    if ($null -eq $config.PSObject.Properties['mcpServers']) {
        throw '.mcp.json carries no mcpServers section.'
    }

    $servers = [Collections.Generic.List[object]]::new()
    foreach ($property in @($config.mcpServers.PSObject.Properties)) {
        $name = $property.Name
        $entry = $property.Value
        $command = if ($null -ne $entry.PSObject.Properties['command']) { [string]$entry.command } else { '' }
        if ([string]::IsNullOrWhiteSpace($command)) {
            $kind = if ($null -ne $entry.PSObject.Properties['type']) { [string]$entry.type } else { 'remote' }
            [void]$servers.Add([pscustomobject]@{
                server      = $name
                enumerable  = $false
                reason      = "it is a $kind server this workspace does not launch, so listing its tools needs the network"
                command     = ''
                arguments   = @()
                script_path = ''
            })
            continue
        }

        $arguments = @()
        if ($null -ne $entry.PSObject.Properties['args']) { $arguments = @($entry.args | ForEach-Object { [string]$_ }) }

        # The adapter is identified by the -File argument rather than by position, because a command
        # line is the reader's to arrange and this check has no business insisting on its shape.
        $scriptPath = ''
        for ($i = 0; $i -lt $arguments.Count - 1; $i++) {
            if ($arguments[$i] -eq '-File' -or $arguments[$i] -eq '-f') { $scriptPath = $arguments[$i + 1]; break }
        }
        if ([string]::IsNullOrWhiteSpace($scriptPath)) {
            [void]$servers.Add([pscustomobject]@{
                server      = $name
                enumerable  = $false
                reason      = "its command line names no -File script, so this check cannot identify an adapter to ask"
                command     = $command
                arguments   = $arguments
                script_path = ''
            })
            continue
        }

        $resolved = if ([IO.Path]::IsPathRooted($scriptPath)) { $scriptPath } else { Join-Path $root $scriptPath }
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            throw ".mcp.json points server '$name' at '$scriptPath', which is not a file in this workspace."
        }

        [void]$servers.Add([pscustomobject]@{
            server      = $name
            enumerable  = $true
            reason      = ''
            command     = $command
            arguments   = $arguments
            script_path = (Resolve-Path -LiteralPath $resolved).Path
        })
    }
    if (-not $servers.Count) { throw '.mcp.json declares no servers.' }
    @($servers)
}

function Invoke-McpToolsList {
    <#
    .SYNOPSIS
        Ask one adapter what tools it declares, over the same JSON-RPC stdio channel the reader's
        client uses. Returns the tool names, sorted.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [int]$TimeoutMs = $script:McpToolsListTimeoutMs
    )

    # Piping objects into the adapter does not bind; the request has to arrive on redirected stdin
    # as a file. That is how the client speaks to it and it is how this check speaks to it too.
    $stem = Join-Path ([IO.Path]::GetTempPath()) ("mcp-toolslist-" + [guid]::NewGuid().ToString('N'))
    $requestPath = "$stem.jsonl"
    $outPath = "$stem.out"
    $errPath = "$stem.err"
    [IO.File]::WriteAllText($requestPath, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' + "`n", [Text.UTF8Encoding]::new($false))

    try {
        $quoted = @($ArgumentList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
        $startArguments = @{
            FilePath               = $Command
            WorkingDirectory       = $WorkingDirectory
            RedirectStandardInput  = $requestPath
            RedirectStandardOutput = $outPath
            RedirectStandardError  = $errPath
            NoNewWindow            = $true
            PassThru               = $true
        }
        if ($quoted.Count) { $startArguments.ArgumentList = $quoted }
        $process = Start-Process @startArguments
        if (-not $process.WaitForExit($TimeoutMs)) {
            try { $process.Kill() } catch { }
            throw "the adapter did not answer tools/list within $([int]($TimeoutMs / 1000))s"
        }

        $stdout = if (Test-Path -LiteralPath $outPath -PathType Leaf) { [IO.File]::ReadAllText($outPath) } else { '' }
        $names = $null
        foreach ($line in @($stdout -split "`r?`n")) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $message = $null
            try { $message = $line | ConvertFrom-Json } catch { continue }
            if ($null -eq $message.PSObject.Properties['result']) { continue }
            if ($null -eq $message.result.PSObject.Properties['tools']) { continue }
            $names = @(@($message.result.tools) | ForEach-Object { if ($null -ne $_.PSObject.Properties['name']) { [string]$_.name } else { '' } })
            break
        }
        if ($null -eq $names) {
            $stderr = if (Test-Path -LiteralPath $errPath -PathType Leaf) { [IO.File]::ReadAllText($errPath) } else { '' }
            $detail = ($stderr.Trim() -split "`r?`n" | Where-Object { $_ -notmatch '^\s*$' } | Select-Object -Last 1)
            throw "the adapter returned no tools/list result$(if ($detail) { " (last stderr line: $detail)" })"
        }
        $blank = @($names | Where-Object { [string]::IsNullOrWhiteSpace($_) })
        if ($blank.Count) { throw 'the adapter declared a tool with no name' }
        @($names | Sort-Object)
    }
    finally {
        foreach ($path in @($requestPath, $outPath, $errPath)) {
            if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
        }
    }
}

function Get-McpAllowlistEntry {
    <#
    .SYNOPSIS
        The permission allowlist as exact entries, read from the settings file the reader owns.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$SettingsPath)

    if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf)) { throw "no settings file at $SettingsPath" }
    $settings = [IO.File]::ReadAllText($SettingsPath) | ConvertFrom-Json
    if ($null -eq $settings.PSObject.Properties['permissions']) { return @() }
    if ($null -eq $settings.permissions.PSObject.Properties['allow']) { return @() }
    @(@($settings.permissions.allow) | ForEach-Object { [string]$_ })
}

function Test-McpToolAllowlisted {
    <#
    .SYNOPSIS
        Whether one tool is covered, by its exact entry or by a server-wide entry.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Server,
        [Parameter(Mandatory = $true)][string]$Tool,
        [string[]]$Allowlist = @()
    )
    $exact = "mcp__${Server}__$Tool"
    $wholeServer = "mcp__$Server"
    foreach ($entry in $Allowlist) {
        if ($entry -ceq $exact) { return $true }
        if ($entry -ceq $wholeServer) { return $true }
        if ($entry -ceq "${wholeServer}__*") { return $true }
    }
    $false
}

function Get-McpToolAllowlistStatus {
    <#
    .SYNOPSIS
        Every locally launched adapter's declared tools, and which of them the allowlist does not
        name. The answer always carries what it could not enumerate.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$SettingsPath,
        [int]$TimeoutMs = $script:McpToolsListTimeoutMs
    )

    $root = (Resolve-Path -LiteralPath $Workspace).Path
    $allowlist = @(Get-McpAllowlistEntry -SettingsPath $SettingsPath)
    $servers = @(Get-McpConfiguredServer -Workspace $root)

    $declared = [Collections.Generic.List[string]]::new()
    $missing = [Collections.Generic.List[string]]::new()
    $notEnumerable = [Collections.Generic.List[object]]::new()

    foreach ($server in $servers) {
        if (-not $server.enumerable) {
            [void]$notEnumerable.Add([pscustomobject]@{ server = $server.server; reason = $server.reason })
            continue
        }
        $tools = @(Invoke-McpToolsList -Command $server.command -ArgumentList $server.arguments -WorkingDirectory $root -TimeoutMs $TimeoutMs)
        foreach ($tool in $tools) {
            [void]$declared.Add("mcp__$($server.server)__$tool")
            if (-not (Test-McpToolAllowlisted -Server $server.server -Tool $tool -Allowlist $allowlist)) {
                [void]$missing.Add("mcp__$($server.server)__$tool")
            }
        }
    }

    [pscustomobject]@{
        servers_enumerated = @($servers | Where-Object { $_.enumerable } | ForEach-Object { $_.server })
        declared           = @($declared)
        missing            = @($missing)
        not_enumerable     = @($notEnumerable)
    }
}

# ---------------------------------------------------------------------------------------------------
# Self-test. Fixture-only and offline; run by Invoke-LibraryChecks.ps1 as `mcp-tool-inventory.selftest`.
#
# The fixture adapter is a REAL script launched as a REAL process over redirected stdin, because the
# thing most likely to break here is the invocation rather than the comparison, and a mocked invoker
# would test the half that cannot fail.
# ---------------------------------------------------------------------------------------------------
if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') {
    $script:failures = [Collections.Generic.List[string]]::new()
    $script:checks = 0
    function Assert([bool]$Condition, [string]$Message) {
        $script:checks++
        if (-not $Condition) { [void]$script:failures.Add($Message) }
    }
    # A throwing call must be a failed assertion, not a dead suite: one exception in the middle
    # otherwise hides every canary after it.
    function Invoke-Safely([scriptblock]$Action) {
        try { return [pscustomobject]@{ ok = $true; value = (& $Action); error = '' } }
        catch { return [pscustomobject]@{ ok = $false; value = $null; error = $_.Exception.Message } }
    }

    $utf8 = [Text.UTF8Encoding]::new($false)
    function Write-Fixture([string]$Path, [string]$Text) {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [IO.File]::WriteAllText($Path, $Text, $utf8)
    }

    $sandbox = Join-Path ([IO.Path]::GetTempPath()) ("mcp-tool-inventory-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $sandbox -Force | Out-Null
    try {
        # --- The fixture adapter -------------------------------------------------------------------
        # It answers tools/list from stdin exactly as the real adapter does, and it carries a tool
        # name inside a <# #> block comment. Documentation must never satisfy this enumeration --
        # that is the failure shape rung 4's static scan actually had, and the reason this check asks
        # the adapter instead of reading it.
        $adapter = Join-Path $sandbox 'fixture-adapter.ps1'
        Write-Fixture $adapter @'
Set-StrictMode -Version Latest
<#
    A documentation block that names a tool the adapter does not declare:
    @{ name = 'ghost_tool_from_a_comment' }
#>
while (($line = [Console]::In.ReadLine()) -ne $null) {
    $request = $line | ConvertFrom-Json
    if ([string]$request.method -eq 'tools/list') {
        $payload = @{ jsonrpc = '2.0'; id = $request.id; result = @{ tools = @(
            @{ name = 'read_thing'; description = 'a' },
            @{ name = 'search_thing'; description = 'b' }
        ) } }
        [Console]::Out.WriteLine((ConvertTo-Json $payload -Depth 8 -Compress))
    }
}
'@

        $silent = Join-Path $sandbox 'silent-adapter.ps1'
        Write-Fixture $silent "Set-StrictMode -Version Latest`r`nwhile (([Console]::In.ReadLine()) -ne `$null) { }`r`n"

        $hanging = Join-Path $sandbox 'hanging-adapter.ps1'
        Write-Fixture $hanging "Set-StrictMode -Version Latest`r`nStart-Sleep -Seconds 30`r`n"

        $nameless = Join-Path $sandbox 'nameless-adapter.ps1'
        Write-Fixture $nameless @'
Set-StrictMode -Version Latest
while (($line = [Console]::In.ReadLine()) -ne $null) {
    $request = $line | ConvertFrom-Json
    if ([string]$request.method -eq 'tools/list') {
        [Console]::Out.WriteLine((ConvertTo-Json @{ jsonrpc = '2.0'; id = $request.id; result = @{ tools = @(@{ description = 'no name' }) } } -Depth 8 -Compress))
    }
}
'@

        function New-Config([string]$Body) { Write-Fixture (Join-Path $sandbox '.mcp.json') $Body }
        function New-Settings([string[]]$Allow) {
            $json = ConvertTo-Json @{ permissions = @{ allow = @($Allow); deny = @() } } -Depth 6
            Write-Fixture (Join-Path $sandbox '.claude/settings.json') $json
            Join-Path $sandbox '.claude/settings.json'
        }
        $adapterConfig = @"
{ "mcpServers": { "fixture-reader": { "command": "powershell.exe", "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "fixture-adapter.ps1"] } } }
"@

        # --- 1. The inventory is what the adapter answers, not what its source text says -----------
        New-Config $adapterConfig
        $settingsAll = New-Settings @('mcp__fixture-reader__read_thing', 'mcp__fixture-reader__search_thing')
        $full = Invoke-Safely { Get-McpToolAllowlistStatus -Workspace $sandbox -SettingsPath $settingsAll -TimeoutMs 30000 }
        Assert $full.ok "enumerating the fixture adapter threw: $($full.error)"
        if ($full.ok) {
            Assert (@($full.value.declared).Count -eq 2) "expected 2 declared tools, got $(@($full.value.declared).Count)"
            Assert (@($full.value.declared) -contains 'mcp__fixture-reader__read_thing') 'read_thing was not enumerated'
            Assert (@($full.value.declared) -contains 'mcp__fixture-reader__search_thing') 'search_thing was not enumerated'
            Assert (-not (@($full.value.declared) -contains 'mcp__fixture-reader__ghost_tool_from_a_comment')) 'a tool named only inside a <# #> block comment reached the inventory'
            Assert (@($full.value.missing).Count -eq 0) "a fully allowlisted adapter reported missing entries: $(@($full.value.missing) -join ', ')"
            Assert (@($full.value.servers_enumerated) -contains 'fixture-reader') 'the enumerated server was not named'
        }

        # --- 2. A tool the allowlist does not name is reported -------------------------------------
        $settingsPartial = New-Settings @('mcp__fixture-reader__read_thing')
        $partial = Invoke-Safely { Get-McpToolAllowlistStatus -Workspace $sandbox -SettingsPath $settingsPartial -TimeoutMs 30000 }
        Assert $partial.ok "the partial-allowlist run threw: $($partial.error)"
        if ($partial.ok) {
            Assert (@($partial.value.missing) -contains 'mcp__fixture-reader__search_thing') 'an unallowlisted tool was not reported -- this is the whole gap being closed'
            Assert (-not (@($partial.value.missing) -contains 'mcp__fixture-reader__read_thing')) 'an allowlisted tool was reported as missing'
            Assert (@($partial.value.declared).Count -eq 2) 'the declared list changed with the allowlist'
        }

        # --- 3. An empty allowlist reports every tool ----------------------------------------------
        $settingsNone = New-Settings @()
        $none = Invoke-Safely { Get-McpToolAllowlistStatus -Workspace $sandbox -SettingsPath $settingsNone -TimeoutMs 30000 }
        Assert $none.ok "the empty-allowlist run threw: $($none.error)"
        if ($none.ok) { Assert (@($none.value.missing).Count -eq 2) "an empty allowlist reported $(@($none.value.missing).Count) missing rather than 2" }

        # --- 4. Server-wide allowlist forms count as covered ---------------------------------------
        foreach ($form in @('mcp__fixture-reader', 'mcp__fixture-reader__*')) {
            $settingsWide = New-Settings @($form)
            $wide = Invoke-Safely { Get-McpToolAllowlistStatus -Workspace $sandbox -SettingsPath $settingsWide -TimeoutMs 30000 }
            Assert $wide.ok "the '$form' run threw: $($wide.error)"
            if ($wide.ok) { Assert (@($wide.value.missing).Count -eq 0) "the server-wide entry '$form' did not cover its tools" }
        }

        # --- 5. A near-miss entry does not cover a tool --------------------------------------------
        # Substring matching would let `search_thing` be satisfied by `search_thing_extra`, which is
        # how a check reports clean while the prompt still fires.
        $settingsNear = New-Settings @('mcp__fixture-reader__read_thing', 'mcp__fixture-reader__search_thing_extra')
        $near = Invoke-Safely { Get-McpToolAllowlistStatus -Workspace $sandbox -SettingsPath $settingsNear -TimeoutMs 30000 }
        Assert $near.ok "the near-miss run threw: $($near.error)"
        if ($near.ok) { Assert (@($near.value.missing) -contains 'mcp__fixture-reader__search_thing') 'a longer, different entry satisfied the exact tool name' }
        $settingsCase = New-Settings @('mcp__fixture-reader__read_thing', 'mcp__fixture-reader__Search_Thing')
        $case = Invoke-Safely { Get-McpToolAllowlistStatus -Workspace $sandbox -SettingsPath $settingsCase -TimeoutMs 30000 }
        Assert $case.ok "the case run threw: $($case.error)"
        if ($case.ok) { Assert (@($case.value.missing) -contains 'mcp__fixture-reader__search_thing') 'a differently cased entry satisfied the tool name' }

        # --- 6. A server this workspace does not launch is named, not silently dropped -------------
        New-Config @"
{ "mcpServers": {
    "fixture-reader": { "command": "powershell.exe", "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "fixture-adapter.ps1"] },
    "remote-thing": { "type": "http", "url": "http://127.0.0.1:9/mcp" }
} }
"@
        $mixed = Invoke-Safely { Get-McpToolAllowlistStatus -Workspace $sandbox -SettingsPath $settingsAll -TimeoutMs 30000 }
        Assert $mixed.ok "the mixed-config run threw: $($mixed.error)"
        if ($mixed.ok) {
            Assert (@($mixed.value.not_enumerable | ForEach-Object { $_.server }) -contains 'remote-thing') 'an HTTP server was not reported as un-enumerable'
            $reason = @($mixed.value.not_enumerable | Where-Object { $_.server -ceq 'remote-thing' } | ForEach-Object { [string]$_.reason }) -join ''
            Assert (-not [string]::IsNullOrWhiteSpace($reason)) 'the un-enumerable server carried no reason'
            Assert (@(@($mixed.value.missing) | Where-Object { $_ -clike 'mcp__remote-thing__*' }).Count -eq 0) 'an un-enumerable server produced missing entries it cannot have'
            Assert (@($mixed.value.servers_enumerated).Count -eq 1) 'the un-enumerable server was counted as enumerated'
        }

        # --- 7. A command line with no -File is un-enumerable rather than a silent pass -------------
        New-Config @"
{ "mcpServers": { "node-thing": { "command": "node", "args": ["server.mjs"] } } }
"@
        $noFile = Invoke-Safely { Get-McpToolAllowlistStatus -Workspace $sandbox -SettingsPath $settingsAll -TimeoutMs 30000 }
        Assert $noFile.ok "the no -File run threw: $($noFile.error)"
        if ($noFile.ok) {
            Assert (@($noFile.value.not_enumerable | ForEach-Object { $_.server }) -contains 'node-thing') 'a server with no -File script was not reported'
            Assert (@($noFile.value.declared).Count -eq 0) 'a server that could not be asked still produced declared tools'
        }

        # --- 8. A declared adapter that is not on disk FAILS ---------------------------------------
        # This one is not friction: the reader's client is pointed at a file that does not exist, so
        # the tool is not prompting, it is absent.
        New-Config @"
{ "mcpServers": { "fixture-reader": { "command": "powershell.exe", "args": ["-NoProfile", "-File", "does-not-exist.ps1"] } } }
"@
        $ghost = Invoke-Safely { Get-McpToolAllowlistStatus -Workspace $sandbox -SettingsPath $settingsAll -TimeoutMs 30000 }
        Assert (-not $ghost.ok) 'an adapter missing from disk did not raise'
        Assert ($ghost.error -match 'not a file in this workspace') "the missing-adapter message did not name the cause: $($ghost.error)"

        # --- 9. An adapter that answers nothing FAILS ----------------------------------------------
        New-Config @"
{ "mcpServers": { "fixture-reader": { "command": "powershell.exe", "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "silent-adapter.ps1"] } } }
"@
        $mute = Invoke-Safely { Get-McpToolAllowlistStatus -Workspace $sandbox -SettingsPath $settingsAll -TimeoutMs 30000 }
        Assert (-not $mute.ok) 'an adapter that returned no tools/list result was treated as declaring nothing'
        Assert ($mute.error -match 'no tools/list result') "the silent-adapter message did not name the cause: $($mute.error)"

        # --- 10. An adapter that declares a nameless tool FAILS ------------------------------------
        New-Config @"
{ "mcpServers": { "fixture-reader": { "command": "powershell.exe", "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "nameless-adapter.ps1"] } } }
"@
        $blank = Invoke-Safely { Get-McpToolAllowlistStatus -Workspace $sandbox -SettingsPath $settingsAll -TimeoutMs 30000 }
        Assert (-not $blank.ok) 'a tool declared with no name was accepted'
        Assert ($blank.error -match 'no name') "the nameless-tool message did not name the cause: $($blank.error)"

        # --- 11. A hanging adapter is killed and named, not waited on forever -----------------------
        New-Config @"
{ "mcpServers": { "fixture-reader": { "command": "powershell.exe", "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "hanging-adapter.ps1"] } } }
"@
        $started = Get-Date
        $hang = Invoke-Safely { Get-McpToolAllowlistStatus -Workspace $sandbox -SettingsPath $settingsAll -TimeoutMs 3000 }
        $elapsed = ((Get-Date) - $started).TotalSeconds
        Assert (-not $hang.ok) 'a hanging adapter did not raise'
        Assert ($hang.error -match 'did not answer tools/list within') "the timeout message did not name the cause: $($hang.error)"
        Assert ($elapsed -lt 20) "the timeout did not bound the wait; it took $([math]::Round($elapsed, 1))s"

        # --- 12. A workspace with no .mcp.json FAILS rather than reporting clean --------------------
        Remove-Item -LiteralPath (Join-Path $sandbox '.mcp.json') -Force
        $noConfig = Invoke-Safely { Get-McpToolAllowlistStatus -Workspace $sandbox -SettingsPath $settingsAll -TimeoutMs 30000 }
        Assert (-not $noConfig.ok) 'a workspace with no .mcp.json reported a clean inventory'
        Assert ($noConfig.error -match 'no .mcp.json') "the missing-config message did not name the cause: $($noConfig.error)"

        # --- 13. A settings file with no allowlist is empty, not an error ---------------------------
        Write-Fixture (Join-Path $sandbox '.claude/bare.json') '{ "hooks": {} }'
        $bare = Invoke-Safely { Get-McpAllowlistEntry -SettingsPath (Join-Path $sandbox '.claude/bare.json') }
        Assert $bare.ok "a settings file with no permissions section threw: $($bare.error)"
        if ($bare.ok) { Assert (@($bare.value).Count -eq 0) 'a settings file with no allowlist produced entries' }
        $absent = Invoke-Safely { Get-McpAllowlistEntry -SettingsPath (Join-Path $sandbox '.claude/not-there.json') }
        Assert (-not $absent.ok) 'a missing settings file did not raise'
    }
    finally {
        if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue }
    }

    if ($script:failures.Count) {
        Write-Host "mcp-tool-inventory self-test: $($script:failures.Count) of $($script:checks) checks FAILED" -ForegroundColor Red
        foreach ($failure in $script:failures) { Write-Host "  - $failure" -ForegroundColor Red }
        exit 1
    }
    Write-Host "mcp-tool-inventory self-test: $($script:checks) checks passed" -ForegroundColor Green
    exit 0
}
