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
function Get-HookEntryText($Entry) {
    $parts = [Collections.Generic.List[string]]::new()
    if ($Entry.PSObject.Properties.Name -contains 'command' -and $null -ne $Entry.command) {
        [void]$parts.Add([string]$Entry.command)
    }
    if ($Entry.PSObject.Properties.Name -contains 'args' -and $null -ne $Entry.args) {
        foreach ($arg in @($Entry.args)) { [void]$parts.Add([string]$arg) }
    }
    $parts -join ' '
}

# The events each named hook file is registered under, as a hashtable of file -> string[] of events.
function Get-RegisteredHookEvents($Settings) {
    $found = @{}
    if ($null -eq $Settings) { return $found }
    if ($Settings.PSObject.Properties.Name -notcontains 'hooks' -or $null -eq $Settings.hooks) { return $found }
    foreach ($eventProperty in $Settings.hooks.PSObject.Properties) {
        $eventName = $eventProperty.Name
        foreach ($matcherBlock in @($eventProperty.Value)) {
            if ($null -eq $matcherBlock) { continue }
            if ($matcherBlock.PSObject.Properties.Name -notcontains 'hooks') { continue }
            foreach ($entry in @($matcherBlock.hooks)) {
                if ($null -eq $entry) { continue }
                $text = Get-HookEntryText $entry
                foreach ($required in $script:RequiredHooks) {
                    if ($text -match [regex]::Escape($required.file)) {
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
