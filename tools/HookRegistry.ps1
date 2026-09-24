<#
.SYNOPSIS
    Which hooks the Library requires, and under which events. Dot-sourced; never invoked directly.

.DESCRIPTION
    The Library's boundary is enforced by hooks, so the set of registered hooks is part of the
    Library the way the guard scripts themselves are. Two places need to agree about it:

        tools/Invoke-LibraryChecks.ps1              at commit time, through settings.hooks-registered
        .claude/hooks/Guard-SettingsIntegrity.ps1   at edit time, through ConfigChange

    Before this file the first of those held the list and the second did not exist. The pre-commit
    hook's own comment records why that was not enough: "a malformed settings file has already
    disabled the permission allowlist and both guard hooks once, silently." A commit-time check
    cannot see a settings file that stopped working three hours earlier.

    THE EVENT IS PART OF THE REQUIREMENT, not decoration. A guard moved from PreToolUse to
    PostToolUse is still named in settings.json, still passes a substring search, and no longer
    guards anything -- the tool has already run by the time it is consulted. Registration is
    therefore checked structurally, against the event the hook is actually listed under.
#>

Set-StrictMode -Version Latest

# `optional` marks a hook whose absence is a WARNing rather than a failure. The two original guards
# and the Desk context hook are load-bearing: without them a closed Book is readable and a session
# does not know what is open. The rest add guidance and cannot block, so a checkout that has not yet
# registered them is degraded, not unsafe -- and failing the gate on them would make this file
# impossible to introduce without breaking every existing clone in the same commit.
# `clients` NAMES EVERY HARNESS THAT FIRES THE HOOK, and it is the reason the payload check can be
# trusted in a two-harness world. Four of these are registered in `.codex/hooks.json` as well as in
# `.claude/settings.json`, so their payloads arrive from two different clients that do NOT send the
# same field set: Codex sends `turn_id` and `model` and sends NO `scratchpad_dir`, `prompt_id` or
# `effort` (measured 2026-09-20, codex-cli 0.153.4). A hook reading a Claude-only field is therefore
# fully working in one harness and silently dead in the other, and until this list existed the
# contract check could not tell the difference -- it passed a read as soon as ONE captured client
# carried the name. A hook with no `clients` runs under Claude Code only.
$script:BaseClient = 'claude-code'
$script:RequiredHooks = @(
    @{ file = 'Guard-BasicMemoryRead.ps1';   events = @('PreToolUse');                  optional = $false; clients = @('claude-code', 'codex-cli'); purpose = 'the shared-collection Desk boundary' },
    @{ file = 'Guard-ShelfBookRead.ps1';     events = @('PreToolUse');                  optional = $false; clients = @('claude-code', 'codex-cli'); purpose = 'a closed Shelf Book is unreadable by Read, Grep, Glob, Write and Edit' },
    @{ file = 'Guard-ShellShelfRead.ps1';    events = @('PreToolUse');                  optional = $false; clients = @('claude-code', 'codex-cli'); purpose = 'a closed Shelf Book is unreadable by shell command' },
    @{ file = 'Get-VirtualDeskContext.ps1';  events = @('UserPromptSubmit');            optional = $false; clients = @('claude-code', 'codex-cli'); purpose = 'what is open, on every prompt' },
    @{ file = 'Get-PlaybookContext.ps1';     events = @('PreToolUse');                  optional = $true;  purpose = 'the playbook section for the helper about to run' },
    @{ file = 'Restore-CompactedGuidance.ps1'; events = @('PostCompact', 'SessionStart'); optional = $true;  purpose = 'the path-scoped rule a compaction unloads, and the serve-ledger clear' },
    @{ file = 'Get-SeatStartContext.ps1';    events = @('SessionStart');                optional = $true;  purpose = 'the seat roster and the ask, and the re-bind of a resumed conversation' },
    @{ file = 'Guard-SettingsIntegrity.ps1'; events = @('ConfigChange');                optional = $true;  purpose = 'a settings edit cannot disable the guards' },
    @{ file = 'Add-SearchHitReminder.ps1';   events = @('PostToolUse');                 optional = $true;  purpose = 'a hit is a location, not a reading' }
)

function Get-RequiredHooks { @($script:RequiredHooks) }

# Which harnesses fire this hook. Read through a name test rather than by property access, because
# the fixture suites build hook descriptors as bare hashtables with only `file` and `events`, and
# under StrictMode a missing key throws rather than answering $null. An unspecified `clients` means
# Claude Code alone, which is what every hook meant before this field existed.
function Get-HookClientList($Hook) {
    if ($null -eq $Hook) { return @($script:BaseClient) }
    $names = if ($Hook -is [hashtable]) { @($Hook.Keys) } else { @($Hook.PSObject.Properties | ForEach-Object { $_.Name }) }
    if ($names -cnotcontains 'clients') { return @($script:BaseClient) }
    $declared = @(@($Hook.clients) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if (-not $declared.Count) { return @($script:BaseClient) }
    @($declared)
}

# --- The payload contract --------------------------------------------------------------------------
# A hook is handed a JSON payload and reads named fields out of it. A name that is not there is not
# an error: `Get-HookField` answers $null by design, because the payload's shape varies by event. So
# a field the client renames, or one that was guessed in the first place, costs the hook its entire
# job and says nothing at all. It has happened twice in this tree -- `startup_reason` on SessionStart
# and `config_source` on ConfigChange -- and in the second case the hook that went quiet was a guard
# that REFUSES, so its silence was the boundary standing open for thirteen days.
#
# `.claude/hooks/payload-contract.json` answers it with measurement: the field set of a payload
# actually captured from the client, per event. These three functions are what reads it, and they
# live here rather than inside the check so that the check and the fixture cases in
# tools/Test-LibraryHooks.ps1 exercise the same code rather than two implementations of one rule.

# The contract's events, split into measured and merely documented. An entry claiming neither is the
# one shape this must not accept: provenance is the whole value of the file.
function Get-PayloadContractShape($Contract) {
    $roots = @($Contract.PSObject.Properties | ForEach-Object { $_.Name })
    if ($roots -cnotcontains 'events') { throw 'the payload contract has no "events" object.' }
    $fields = @{}
    $captured = [Collections.Generic.List[string]]::new()
    # event -> client -> fields. The base entry is Claude Code's; a `clients` object carries the
    # same event as another harness actually sends it.
    $clientFields = @{}
    foreach ($property in @($Contract.events.PSObject.Properties)) {
        $entry = $property.Value
        $names = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
        if ($names -cnotcontains 'captured' -and $names -cnotcontains 'uncaptured') {
            throw "the payload contract's '$($property.Name)' entry claims neither 'captured' nor 'uncaptured'; an event with no provenance verifies nothing."
        }
        $fields[$property.Name] = if ($names -ccontains 'fields') { @($entry.fields) } else { @() }
        $perClient = @{}
        if ($names -ccontains 'captured') {
            if (-not @($fields[$property.Name]).Count) {
                throw "the payload contract calls '$($property.Name)' captured but lists no fields."
            }
            [void]$captured.Add($property.Name)
            $perClient[$script:BaseClient] = @($fields[$property.Name])
        }
        if ($names -ccontains 'clients') {
            foreach ($clientProperty in @($entry.clients.PSObject.Properties)) {
                $clientNames = @($clientProperty.Value.PSObject.Properties | ForEach-Object { $_.Name })
                if ($clientNames -cnotcontains 'captured') {
                    throw "the payload contract's '$($property.Name)' entry for client '$($clientProperty.Name)' does not claim 'captured'; a per-client entry exists only to record a measurement."
                }
                $clientFieldList = if ($clientNames -ccontains 'fields') { @($clientProperty.Value.fields) } else { @() }
                if (-not $clientFieldList.Count) {
                    throw "the payload contract calls '$($property.Name)' captured for client '$($clientProperty.Name)' but lists no fields."
                }
                $perClient[$clientProperty.Name] = @($clientFieldList)
            }
        }
        $clientFields[$property.Name] = $perClient
    }
    @{ fields = $fields; captured = @($captured); clientFields = $clientFields }
}

# Every payload field every named hook reads, FROM THE PARSER rather than from a grep. Two spellings
# reach the payload and both count: `Get-HookField $call 'x'`, which answers $null and carries on,
# and `$call.x`, which throws under StrictMode and -- in the one guard that spells it that way --
# denies. One is silent and one is loud, but a field that has moved breaks them both.
function Get-HookPayloadReads([string]$HookDirectory, $Hooks) {
    $reads = [Collections.Generic.List[object]]::new()
    foreach ($hook in @($Hooks)) {
        $path = Join-Path $HookDirectory ([string]$hook.file)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "$([string]$hook.file) is a required hook but is not in $HookDirectory."
        }
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$parseErrors)
        if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) {
            throw "$([string]$hook.file) does not parse, so its payload reads cannot be read."
        }
        foreach ($node in @($ast.FindAll({
                param($n)
                $n -is [Management.Automation.Language.CommandAst] -and
                $n.GetCommandName() -eq 'Get-HookField' -and
                @($n.CommandElements).Count -ge 3 -and
                $n.CommandElements[1] -is [Management.Automation.Language.VariableExpressionAst] -and
                $n.CommandElements[1].VariablePath.UserPath -ceq 'call'
            }, $true))) {
            $arg = $node.CommandElements[2]
            if ($arg -isnot [Management.Automation.Language.StringConstantExpressionAst]) {
                throw ("$([string]$hook.file) line $($node.Extent.StartLineNumber) names its payload field with " +
                    "$($arg.Extent.Text) rather than a literal; a captured contract cannot cover a name computed at run time.")
            }
            [void]$reads.Add([pscustomobject]@{
                hook = [string]$hook.file; field = [string]$arg.Value
                line = $node.Extent.StartLineNumber; events = @($hook.events)
                clients = @(Get-HookClientList $hook)
            })
        }
        foreach ($node in @($ast.FindAll({
                param($n)
                $n -is [Management.Automation.Language.MemberExpressionAst] -and
                $n.Expression -is [Management.Automation.Language.VariableExpressionAst] -and
                $n.Expression.VariablePath.UserPath -ceq 'call' -and
                $n.Member -is [Management.Automation.Language.StringConstantExpressionAst] -and
                # PSObject is the adapter, not a payload field. It is on every object whatever the
                # client sent, and it is how Get-HookField itself asks what a payload carries.
                $n.Member.Value -cne 'PSObject'
            }, $true))) {
            [void]$reads.Add([pscustomobject]@{
                hook = [string]$hook.file; field = [string]$node.Member.Value
                line = $node.Extent.StartLineNumber; events = @($hook.events)
                clients = @(Get-HookClientList $hook)
            })
        }
    }
    @($reads)
}

# BOTH DIRECTIONS, because the two faults differ and only one of them is loud. A read no captured
# event covers is a hook that may already be dead. A stale entry in `unverified_reads` is an
# exemption outliving its cause, which is how both of the historical instances stayed invisible.
function Get-PayloadContractProblems($Contract, $Shape, $Reads) {
    $roots = @($Contract.PSObject.Properties | ForEach-Object { $_.Name })
    $exempt = @(@(if ($roots -ccontains 'unverified_reads') { $Contract.unverified_reads } else { @() }) |
        Where-Object { $null -ne $_ })
    foreach ($entry in $exempt) {
        $names = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
        foreach ($field in @('hook', 'field', 'reason')) {
            if ($names -cnotcontains $field) {
                throw "an entry in the payload contract's unverified_reads has no '$field'; an exemption with no reason is one nobody can retire."
            }
        }
    }

    $problems = [Collections.Generic.List[string]]::new()
    $needed = [Collections.Generic.List[string]]::new()
    # EVERY CLIENT THAT FIRES THE HOOK, not any one of them. A read satisfied by Claude Code alone is
    # a hook that is silently dead under Codex, which is the exact failure the contract exists to
    # catch and the exact failure the old existential test could not see.
    foreach ($read in @($Reads)) {
        $readNames = @($read.PSObject.Properties | ForEach-Object { $_.Name })
        # @() WRAPS THE WHOLE if-EXPRESSION, not just its branches: assigning from an if unrolls a
        # one-element array to a bare string, and .Count on a string throws under StrictMode.
        $readClients = @(if ($readNames -ccontains 'clients') { @($read.clients) } else { @($script:BaseClient) })
        if (-not $readClients.Count) { $readClients = @($script:BaseClient) }

        foreach ($client in $readClients) {
            $seenOn = @(@($read.events) | Where-Object {
                $perClient = $Shape.clientFields[$_]
                $null -ne $perClient -and $perClient.ContainsKey($client) -and @($perClient[$client]) -ccontains $read.field
            })
            if ($seenOn.Count) { continue }

            $key = "$($read.hook)|$($read.field)"
            if ($needed -cnotcontains $key) { [void]$needed.Add($key) }
            # An exemption naming no client covers every client, which is what every existing
            # exemption meant before clients were distinguished.
            $excused = @($exempt | Where-Object {
                if ("$([string]$_.hook)|$([string]$_.field)" -cne $key) { return $false }
                $exemptNames = @($_.PSObject.Properties | ForEach-Object { $_.Name })
                if ($exemptNames -cnotcontains 'client') { return $true }
                [string]$_.client -ceq $client
            })
            if ($excused.Count) { continue }

            $checkedIn = @(@($read.events) | Where-Object {
                $perClient = $Shape.clientFields[$_]
                $null -ne $perClient -and $perClient.ContainsKey($client)
            })
            $why = if ($checkedIn.Count) { "no $client payload captured for $($checkedIn -join '/') carries that name" }
                else { "no $client payload has been captured for any event it is registered on ($(@($read.events) -join '/'))" }
            [void]$problems.Add("$($read.hook) line $($read.line) reads '$($read.field)' and $why")
        }
    }
    foreach ($entry in @($exempt | Where-Object { $needed -cnotcontains "$([string]$_.hook)|$([string]$_.field)" })) {
        [void]$problems.Add("unverified_reads exempts $([string]$entry.hook) '$([string]$entry.field)', which no longer needs it")
    }
    @($problems)
}

# Every filename a hook entry in a settings tree names, whether the path arrives through `command`
# or through `args`. Both shapes are live: .claude/settings.json splits the interpreter from its
# arguments, and .codex/hooks.json puts the whole invocation in one string.
#
# THE NAMES ARE ENUMERATED AND COMPARED CASE-SENSITIVELY, both since S36 and both measured. Reading
# `.PSObject.Properties.Name` off the aggregate throws under StrictMode when there are no properties
# (defect family 4): a settings file of `{}`, `5` or `true` made this walk throw, and
# Guard-SettingsIntegrity.ps1 -- which fails open by design -- allowed it in silence, with every guard
# unregistered. And `-contains` is case-insensitive where the harnesses that load these files are not:
# a block under `Hooks` read as registered here and loads as nothing there.
function Get-HookEntryText($Entry) {
    $parts = [Collections.Generic.List[string]]::new()
    if ($null -eq $Entry) { return '' }
    $names = @($Entry.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -ccontains 'command' -and $null -ne $Entry.command) {
        [void]$parts.Add([string]$Entry.command)
    }
    if ($names -ccontains 'args' -and $null -ne $Entry.args) {
        foreach ($arg in @($Entry.args)) { [void]$parts.Add([string]$arg) }
    }
    $parts -join ' '
}

# THE BINARY'S SPELLING OF A HOOK (S42). The Claude Code plugin, and `library init` on macOS and Linux,
# register each hook the kernel has ported as `"<root>/bin/library" hook <verb>` rather than by its script,
# so a registration names a required hook by either. Until S42 only the script counted, and a workspace
# guarded wholly by the plugin read as having no guard at all. A verb without its word boundary would
# match `hook shell-shelf-read` as `shelf-read`; the pattern below does not.
$script:HookVerbForScript = [ordered]@{
    'Guard-BasicMemoryRead.ps1'   = 'basic-memory-read'
    'Guard-ShelfBookRead.ps1'     = 'shelf-read'
    'Guard-ShellShelfRead.ps1'    = 'shell-shelf-read'
    'Get-VirtualDeskContext.ps1'  = 'desk-context'
    'Guard-SettingsIntegrity.ps1' = 'settings-integrity'
}
function Get-HookVerbForScript { $script:HookVerbForScript }

function Test-HookEntryNamesHook([string]$Text, [string]$File) {
    if ($Text -match [regex]::Escape($File)) { return $true }
    if (-not $script:HookVerbForScript.Contains($File)) { return $false }
    $Text -match ('(^|\s)hook\s+' + [regex]::Escape([string]$script:HookVerbForScript[$File]) + '(\s|$)')
}

# THE ENABLED DESKPOST PLUGIN'S OWN REGISTRATIONS, as one more settings tree (S42). A plugin's hooks are
# not in the workspace's .claude/ at all, so a workspace guarded by the plugin alone was judged unguarded.
# MEASURED, NOT RECALLED (claude 2.1.281, a plugin installed into a scratch CLAUDE_CONFIG_DIR): which plugins
# are on is `enabledPlugins` in <config>/settings.json, keyed `<plugin>@<marketplace>`; where one is
# installed is `installPath` in <config>/plugins/installed_plugins.json; and the manifest at
# <installPath>/.claude-plugin/plugin.json names its hooks and servers files relative to that path. A
# workspace's .claude/settings.json, then settings.local.json, may set `enabledPlugins` over the user's,
# as for any setting. CONCEDED: only a user-scope install was measured; a project- or local-scope entry is
# read when its `projectPath` is this workspace, which is a reading of the file, not a measurement.
# ${CLAUDE_PLUGIN_ROOT} is replaced by the install path, so what the tree names can be checked on disk.
function Get-EnabledClaudePluginHooks([string]$Workspace) {
    $config = if (-not [string]::IsNullOrWhiteSpace($env:CLAUDE_CONFIG_DIR)) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
    $readJson = {
        param([string]$Path)
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
        try { [IO.File]::ReadAllText($Path) | ConvertFrom-Json } catch { $null }
    }
    $key = $null; $enabled = $false
    foreach ($settingsPath in @((Join-Path $config 'settings.json'), (Join-Path $Workspace '.claude/settings.json'), (Join-Path $Workspace '.claude/settings.local.json'))) {
        $settings = & $readJson $settingsPath
        if ($null -eq $settings -or -not $settings.PSObject.Properties['enabledPlugins'] -or $null -eq $settings.enabledPlugins) { continue }
        foreach ($property in @($settings.enabledPlugins.PSObject.Properties)) {
            if ($property.Name -cmatch '^deskpost@') { $key = $property.Name; $enabled = ($property.Value -eq $true) }
        }
    }
    if (-not $enabled) { return $null }
    $installed = & $readJson (Join-Path $config 'plugins/installed_plugins.json')
    if ($null -eq $installed -or -not $installed.PSObject.Properties['plugins'] -or -not $installed.plugins.PSObject.Properties[$key]) { return $null }
    $install = $null
    foreach ($entry in @($installed.plugins.$key)) {
        if ($null -eq $entry -or -not $entry.PSObject.Properties['installPath']) { continue }
        $scope = if ($entry.PSObject.Properties['scope']) { [string]$entry.scope } else { 'user' }
        $project = if ($entry.PSObject.Properties['projectPath']) { [string]$entry.projectPath } else { '' }
        if ($scope -ceq 'user' -or ($project -and $project.TrimEnd('\', '/') -ieq $Workspace.TrimEnd('\', '/'))) { $install = [string]$entry.installPath; break }
    }
    if ([string]::IsNullOrWhiteSpace($install)) { return $null }
    $manifest = & $readJson (Join-Path $install '.claude-plugin/plugin.json')
    $hooksRelative = if ($null -ne $manifest -and $manifest.PSObject.Properties['hooks'] -and $manifest.hooks -is [string]) { [string]$manifest.hooks } else { 'hooks/hooks.json' }
    $serversRelative = if ($null -ne $manifest -and $manifest.PSObject.Properties['mcpServers'] -and $manifest.mcpServers -is [string]) { [string]$manifest.mcpServers } else { '.mcp.json' }
    $root = $install.Replace('\', '/').TrimEnd('/')
    $hooksPath = Join-Path $install $hooksRelative
    $tree = $null
    if (Test-Path -LiteralPath $hooksPath -PathType Leaf) {
        try { $tree = [IO.File]::ReadAllText($hooksPath).Replace('${CLAUDE_PLUGIN_ROOT}', $root) | ConvertFrom-Json } catch { $tree = $null }
    }
    $servers = & $readJson (Join-Path $install $serversRelative)
    $declaresReader = $null -ne $servers -and $servers.PSObject.Properties['mcpServers'] -and $null -ne $servers.mcpServers -and
        [bool]$servers.mcpServers.PSObject.Properties['validated-book-reader']
    [pscustomobject]@{ key = $key; install_path = $install; tree = $tree; declares_reader = [bool]$declaresReader }
}

# The events each named hook file is registered under, as a hashtable of file -> string[] of events.
function Get-RegisteredHookEvents($Settings) {
    $found = @{}
    if ($null -eq $Settings) { return $found }
    $settingsNames = @($Settings.PSObject.Properties | ForEach-Object { $_.Name })
    if ($settingsNames -cnotcontains 'hooks' -or $null -eq $Settings.hooks) { return $found }
    foreach ($eventProperty in $Settings.hooks.PSObject.Properties) {
        $eventName = $eventProperty.Name
        foreach ($matcherBlock in @($eventProperty.Value)) {
            if ($null -eq $matcherBlock) { continue }
            if (@($matcherBlock.PSObject.Properties | ForEach-Object { $_.Name }) -cnotcontains 'hooks') { continue }
            foreach ($entry in @($matcherBlock.hooks)) {
                if ($null -eq $entry) { continue }
                $text = Get-HookEntryText $entry
                foreach ($required in $script:RequiredHooks) {
                    if (Test-HookEntryNamesHook $text $required.file) {
                        if (-not $found.ContainsKey($required.file)) { $found[$required.file] = @() }
                        if (@($found[$required.file]) -cnotcontains $eventName) {
                            $found[$required.file] = @(@($found[$required.file]) + $eventName)
                        }
                    }
                }
            }
        }
    }
    $found
}

# Returns one record per required hook that is missing or mis-registered, each carrying whether it is
# a hard failure. An empty result means every required hook is registered under an event it can
# actually act on.
#
# The Settings arguments are the PARSED trees of every settings file in play. More than one is passed
# because .claude/settings.json and .claude/settings.local.json are merged by the harness, so a hook
# present in either is registered; requiring it in a particular file would fail a machine that had
# legitimately moved it.
function Get-HookRegistrationProblems {
    param([object[]]$Settings)
    $registered = @{}
    foreach ($tree in @($Settings)) {
        foreach ($pair in (Get-RegisteredHookEvents $tree).GetEnumerator()) {
            if (-not $registered.ContainsKey($pair.Key)) { $registered[$pair.Key] = @() }
            $registered[$pair.Key] = @(@($registered[$pair.Key]) + @($pair.Value) | Select-Object -Unique)
        }
    }
    $problems = [Collections.Generic.List[object]]::new()
    foreach ($required in $script:RequiredHooks) {
        if (-not $registered.ContainsKey($required.file)) {
            [void]$problems.Add([pscustomobject]@{
                file = $required.file; optional = $required.optional
                detail = "$($required.file) is not registered ($($required.purpose))"
            })
            continue
        }
        $actual = @($registered[$required.file])
        # EVERY declared event must be present, not merely one of them. Restore-CompactedGuidance.ps1
        # needs both PostCompact and SessionStart: the first covers a compaction inside a live
        # session, the second covers resuming one that was already compacted, and a checkout holding
        # only one of them has a hole exactly the shape of the case it dropped.
        $missingEvents = @($required.events | Where-Object { $actual -cnotcontains $_ })
        if ($missingEvents.Count) {
            [void]$problems.Add([pscustomobject]@{
                file = $required.file; optional = $required.optional
                detail = "$($required.file) is registered under $($actual -join ', ') but not $($missingEvents -join ', ')"
            })
        }
    }
    @($problems)
}

function Test-ClaudeHookShape {
    <#
        Does this hooks document have the shape a harness will actually load? Returns one fault per
        place it does not.

        THIS IS NOT A DIFF, AND THAT IS ITS ENTIRE REASON FOR EXISTING. Test-PluginGeneratedFiles
        regenerates and compares against what is committed, so it proves the canonical file and the
        generated one AGREE -- and a generator emitting a shape no harness accepts emits it
        identically twice. `plugin.generated-files-match` was green for the whole life of a hooks
        file whose three PreToolUse entries and whole UserPromptSubmit event were OBJECTS where an
        ARRAY is required, because a one-element array unrolls on its way out of a function. An
        installed plugin would have registered no hooks at all, which is S11's packaged fail-open
        wearing different clothes: the boundary absent, and nothing saying so.

        THE SHAPE IS A LITERAL HERE, AND IT IS PINNED TO TWO WORKING CONSUMERS rather than to this
        file's own opinion -- a threshold cannot pin itself. Measured 2026-09-20: this workspace's
        own `.claude/settings.json`, which demonstrably registers six events, and the installed
        `openai-codex` plugin's `hooks/hooks.json`, which demonstrably fires. Both spell it

            hooks: { <Event>: [ { matcher?: string, hooks: [ { type, command, ... } ] } ] }

        arrays at BOTH levels, on every event, including the ones holding exactly one entry.
    #>
    param([Parameter(Mandatory)]$Document, [string]$Label = 'the hooks document')
    $faults = [Collections.Generic.List[string]]::new()

    $names = @($Document.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -cnotcontains 'hooks') {
        [void]$faults.Add("$Label has no top-level 'hooks' key")
        return @($faults)
    }
    $events = $Document.hooks
    # AN OBJECT, OR NOTHING BELOW MEANS ANYTHING (S36, measured). The walk reads events off the
    # adapter's property list, so a STRING `hooks` was judged as one event named 'Length', and an ARRAY
    # as eight -- 'SyncRoot' among them, whose value is the array itself, so its elements were judged
    # as that event's entries. Either way the file was refused, for a reason that named no real fault.
    if ($events -isnot [Management.Automation.PSCustomObject]) {
        [void]$faults.Add("$Label has 'hooks' as a $(if ($null -eq $events) { 'null' } else { $events.GetType().Name }), not an object of events")
        return @($faults)
    }
    $eventNames = @($events.PSObject.Properties | ForEach-Object { $_.Name })
    if (-not $eventNames.Count) { [void]$faults.Add("$Label registers no events at all") }

    foreach ($eventName in $eventNames) {
        $entries = $events.$eventName
        if (-not ($entries -is [Array])) {
            [void]$faults.Add("$Label event '$eventName' is a $(if ($null -eq $entries) { 'null' } else { $entries.GetType().Name }), not an array; a one-element list that unrolled reads exactly like this")
            continue
        }
        for ($i = 0; $i -lt $entries.Count; $i++) {
            $entry = $entries[$i]
            # A NULL ENTRY IS A FAULT, NOT A THROW (S36, measured). `$null.PSObject` throws under
            # StrictMode, and the settings guard's catch turned `{"hooks":{"PreToolUse":[null]}}` into
            # a silent allow.
            if ($null -eq $entry) {
                [void]$faults.Add("$Label event '$eventName' entry $i is null")
                continue
            }
            $entryNames = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
            if ($entryNames -cnotcontains 'hooks') {
                [void]$faults.Add("$Label event '$eventName' entry $i declares no 'hooks'")
                continue
            }
            $commands = $entry.hooks
            if (-not ($commands -is [Array])) {
                [void]$faults.Add("$Label event '$eventName' entry $i has 'hooks' as a $(if ($null -eq $commands) { 'null' } else { $commands.GetType().Name }), not an array")
                continue
            }
            for ($j = 0; $j -lt $commands.Count; $j++) {
                if ($null -eq $commands[$j]) {
                    [void]$faults.Add("$Label event '$eventName' entry $i hook $j is null")
                    continue
                }
                $commandNames = @($commands[$j].PSObject.Properties | ForEach-Object { $_.Name })
                foreach ($required in @('type', 'command')) {
                    if ($commandNames -cnotcontains $required) {
                        [void]$faults.Add("$Label event '$eventName' entry $i hook $j has no '$required'")
                    }
                }
            }
        }
    }
    @($faults)
}

# --- The Codex half of the same question ----------------------------------------------------------
#
# WHICH HOOKS A CODEX SESSION NEEDS, AND UNDER WHICH MATCHER. Four of the Library's nine hooks fire
# in Codex; the other five are registered for Claude Code alone, because Codex fires no PostToolUse
# for its own tools and has no ConfigChange event. The list lives here rather than inside a check
# because two checks now ask it -- `codex.project-access-config` of the program's own `.codex/`, and
# `workspace.codex-guards-registered` of a reader's workspace -- and a second copy of a boundary is
# a second chance for one of them to be wrong about it.
#
# THE MATCHER IS PART OF THE REQUIREMENT, and both of these were guessed wrong once. A PreToolUse
# payload captured from a real `codex exec` run on 2026-09-06 carries tool_name `Bash`: Codex
# normalises its shell tool to the Claude Code name for hooks, and `exec` survives only inside
# tool_use_id, so the original `^exec$` matched nothing, silently. `apply_patch` is NOT normalised --
# the payload captured 2026-09-07 carries it verbatim -- so a matcher naming `Write` or `Edit` here
# would be the same failure repeated: registered, and unable to fire.
#
# AND THE THIRD WAS NEVER ASKED AT ALL, until S38. The Basic Memory guard's matcher was `$null` here,
# so any matcher read as registered -- and every Codex binding `library init` wrote carried
# `^mcp__basic-memory__.*$`, while Codex names the tool `mcp__basic_memory__<tool>`: it spells a
# server's hyphens as underscores (measured S37). So a `sample` is a TOOL NAME the registered matcher
# must match as Codex would test it, where `matcher` is a pattern the matcher's own TEXT must match;
# a matcher is a regex over tool names, and only a sample asks what it actually fires on.
$script:CodexRequiredHooks = @(
    @{ file = 'Guard-BasicMemoryRead.ps1';  event = 'PreToolUse';       matcher = $null; sample = 'mcp__basic_memory__list_directory';
       matcherDetail = "the Codex Basic Memory guard's matcher does not match mcp__basic_memory__list_directory -- Codex spells a server's hyphens as underscores -- so it can never fire";
       detail = 'Codex Basic Memory calls are not registered with the Desk guard' },
    @{ file = 'Guard-ShellShelfRead.ps1';   event = 'PreToolUse';       matcher = '(^|\||\()Bash($|\||\))';
       matcherDetail = "the Codex shell guard's matcher does not name the Bash tool, so it can never fire";
       detail = 'Codex shell commands can read a closed Shelf Book' },
    @{ file = 'Guard-ShelfBookRead.ps1';    event = 'PreToolUse';       matcher = 'apply_patch';
       matcherDetail = "the Codex patch guard's matcher does not name apply_patch, so it can never fire";
       detail = 'Codex apply_patch can write into a closed Shelf Book' },
    @{ file = 'Get-VirtualDeskContext.ps1'; event = 'UserPromptSubmit'; matcher = $null;
       detail = 'Codex does not load Virtual Desk context at prompt submission' }
)

function Get-CodexRequiredHooks { @($script:CodexRequiredHooks) }

function Get-CodexRegistrationProblems {
    <#
        One string per Codex hook that is absent, registered under the wrong event, or bound to a
        matcher it can never fire on. An empty result means all four are registered where they act.

        It asks nothing about SHAPE -- Test-CodexHookShape does that -- and nothing about whether the
        scripts exist, which is the caller's question because only the caller knows which program
        tree the paths are supposed to point into.
    #>
    param([Parameter(Mandatory)]$Document)

    $problems = [Collections.Generic.List[string]]::new()
    $registered = Get-RegisteredHookEvents $Document
    foreach ($required in $script:CodexRequiredHooks) {
        if (-not $registered.ContainsKey($required.file)) {
            [void]$problems.Add("$($required.detail): $($required.file) is absent.")
            continue
        }
        if (@($registered[$required.file]) -cnotcontains $required.event) {
            [void]$problems.Add("$($required.detail): $($required.file) is registered under $(@($registered[$required.file]) -join ', ') rather than $($required.event).")
            continue
        }
        $sample = if ($required.ContainsKey('sample')) { [string]$required.sample } else { $null }
        if ($null -eq $required.matcher -and $null -eq $sample) { continue }
        $blocks = @($Document.hooks.$($required.event) | Where-Object {
            @(@($_.hooks) | Where-Object { Test-HookEntryNamesHook (Get-HookEntryText $_) $required.file }).Count
        })
        # @() AROUND THE `if`, NOT INSIDE IT: an `if` used as a value unrolls what it returns, so an
        # empty match reached `.Count` as $null and StrictMode threw -- which the first run of S38's rows
        # reported as the check's whole detail.
        $fires = @(if ($null -ne $sample) {
            # A matcher that is not a regex fires on nothing, so it is a matcher that cannot fire.
            $blocks | Where-Object { try { $sample -cmatch [string]$_.matcher } catch { $false } }
        } else {
            $blocks | Where-Object { [string]$_.matcher -cmatch $required.matcher }
        })
        if ($fires.Count -lt 1) {
            [void]$problems.Add([string]$required.matcherDetail + '.')
        }
    }
    @($problems)
}

function Test-CodexHookShape {
    <#
        Does this hooks document have the shape CODEX will actually load? One fault per place it
        does not.

        TWO RULES, AND THE FIRST IS CODEX'S ALONE. Codex accepts only `description` and `hooks` at
        the root of this file and rejects the whole document --

            failed to parse hooks config <path>: unknown field `PreToolUse`,
                                                 expected `description` or `hooks`

        -- if an event is placed there. The Library wrote it that way until 2026-09-06 and every
        Codex session ran with no Library hook at all, while the file parsed as JSON throughout.

        RE-MEASURED 2026-09-22 ON codex-cli 0.153.4, AND THE RE-MEASUREMENT IS WHY THIS JUDGE MATTERS
        MORE THAN IT DID. The client names the file and the field in that warning -- but only when
        the project is TRUSTED. In an untrusted project the same malformed file produces no line at
        all, so the evidence a reader would diagnose from is exactly the evidence a session cannot
        see. A judge that runs at commit time is the only window on it.

        The second rule is the nested shape, which is Claude Code's too and is therefore asked once,
        of Test-ClaudeHookShape: events under a `hooks` key, arrays at both levels.
    #>
    param([Parameter(Mandatory)]$Document, [string]$Label = 'the Codex hooks document')
    $faults = [Collections.Generic.List[string]]::new()

    $names = @($Document.PSObject.Properties | ForEach-Object { $_.Name })
    $stray = @($names | Where-Object { $_ -cnotin @('description', 'hooks') })
    if ($stray.Count) {
        [void]$faults.Add("$Label puts $($stray -join ', ') at the root; Codex accepts only 'description' and 'hooks' there and rejects the whole file")
    }
    foreach ($fault in @(Test-ClaudeHookShape -Document $Document -Label $Label)) { [void]$faults.Add($fault) }
    @($faults)
}
