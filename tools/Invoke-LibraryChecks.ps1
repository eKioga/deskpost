<#
.SYNOPSIS
    Run every Library self-test and static check.

.DESCRIPTION
    One tracked entry point, invoked by the pre-commit hook and used as the acceptance gate for each
    implementation phase. Read-only: it makes no shared-collection write and does not modify the
    workspace.

    Checks that reach the NAS are skipped unless -IncludeShared is passed, so the default run works
    offline and in a pre-commit hook.
#>
[CmdletBinding()]
param(
    [string]$WorkspacePath,
    [switch]$IncludeShared,
    [switch]$Fast,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# The Desk path is resolved, never composed -- see BookRootSchema's SEATS section.
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$results = [Collections.Generic.List[object]]::new()

function Add-Result([string]$Name, [string]$Status, [string]$Detail) {
    [void]$results.Add([pscustomobject]@{ check = $Name; status = $Status; detail = $Detail })
}

function Invoke-Check([string]$Name, [scriptblock]$Body) {
    try {
        $detail = & $Body
        if ($null -eq $detail) { $detail = 'ok' }
        # A check returning a 'WARN: ' prefix reports pressure without failing the commit. A budget
        # that only speaks when it is already breached gives no time to act: CLAUDE.md went from 894
        # to over the line with nothing said in between.
        $text = [string]$detail
        if ($text.StartsWith('WARN: ')) { Add-Result $Name 'warn' $text.Substring(6) }
        else { Add-Result $Name 'pass' $text }
    }
    catch {
        Add-Result $Name 'fail' $_.Exception.Message
    }
}

# --- Settings: parseable, and both guards plus the desk hook actually registered -----------------
# The tracked project file wins once 0.4 lands; until then the .local file is the live one.
Invoke-Check 'settings.parse' {
    # @(...) is load-bearing: a single match unrolls to a bare string, and .Count then fails
    # under StrictMode. The same defect class is recorded in docs/project-hub-design.md.
    $candidates = @(@('settings.json', 'settings.local.json') |
        ForEach-Object { Join-Path $workspace (Join-Path '.claude' $_) } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if (-not $candidates.Count) { throw 'No .claude/settings.json or settings.local.json found.' }
    foreach ($file in $candidates) {
        try { Get-Content -LiteralPath $file -Raw | ConvertFrom-Json | Out-Null }
        catch { throw "$(Split-Path -Leaf $file) is not valid JSON: $($_.Exception.Message)" }
    }
    "parsed $($candidates.Count) file(s)"
}

# Registration is checked STRUCTURALLY, against the event each hook is listed under, rather than by
# searching the file for its name. A guard moved from PreToolUse to PostToolUse still appears in the
# text and no longer guards anything: the tool has already run by the time it is consulted. The
# required set and the events it must be registered under live in tools/HookRegistry.ps1, which
# .claude/hooks/Guard-SettingsIntegrity.ps1 reads too -- one definition, two windows.
Invoke-Check 'settings.hooks-registered' {
    . (Join-Path $PSScriptRoot 'HookRegistry.ps1')
    $files = @(@('settings.json', 'settings.local.json') |
        ForEach-Object { Join-Path $workspace (Join-Path '.claude' $_) } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if (-not $files.Count) { throw 'No .claude/settings.json or settings.local.json found.' }
    # BOTH files, not the first one that exists. The harness merges them, so a hook moved from the
    # tracked file to the local one is still registered, and failing on that would report a working
    # checkout as broken.
    $trees = @($files | ForEach-Object { [IO.File]::ReadAllText($_) | ConvertFrom-Json })
    $problems = @(Get-HookRegistrationProblems -Settings $trees)
    $blocking = @($problems | Where-Object { -not $_.optional })
    if ($blocking.Count) { throw (($blocking | ForEach-Object { $_.detail }) -join '; ') }
    $required = @(Get-RequiredHooks)
    if ($problems.Count) {
        return "WARN: $(($problems | ForEach-Object { $_.detail }) -join '; ')"
    }
    "all $($required.Count) hooks registered under the events they act on"
}

Invoke-Check 'codex.project-access-config' {
    $configTemplatePath = Join-Path $workspace (Join-Path '.codex' 'config.template.toml')
    $hooksTemplatePath = Join-Path $workspace (Join-Path '.codex' 'hooks.template.json')
    $configPath = Join-Path $workspace (Join-Path '.codex' 'config.toml')
    $hooksPath = Join-Path $workspace (Join-Path '.codex' 'hooks.json')
    if (-not (Test-Path -LiteralPath $configTemplatePath -PathType Leaf)) { throw '.codex/config.template.toml is missing.' }
    if (-not (Test-Path -LiteralPath $hooksTemplatePath -PathType Leaf)) { throw '.codex/hooks.template.json is missing.' }
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw '.codex/config.toml is missing.' }
    if (-not (Test-Path -LiteralPath $hooksPath -PathType Leaf)) { throw '.codex/hooks.json is missing.' }

    foreach ($templatePath in @($configTemplatePath, $hooksTemplatePath)) {
        $template = [IO.File]::ReadAllText($templatePath)
        if ($template -cmatch '(?i)(?:[a-z]:[\\/]|/users/|/home/|%userprofile%|\$env:userprofile)') { throw "$(Split-Path -Leaf $templatePath) contains a machine-specific filesystem binding." }
    }

    $config = [IO.File]::ReadAllText($configPath)
    foreach ($section in @('features', 'mcp_servers.basic-memory', 'mcp_servers.validated-book-reader')) {
        if ($config -notmatch "(?m)^\[$([regex]::Escape($section))\]\s*$") { throw "missing [$section] in .codex/config.toml" }
    }
    if ($config -notmatch '(?ms)^\[features\]\s+.*?^hooks\s*=\s*true\s*$') { throw 'Codex project hooks are not enabled.' }
    foreach ($server in @('basic-memory', 'validated-book-reader')) {
        $escaped = [regex]::Escape($server)
        if ($config -notmatch "(?ms)^\[mcp_servers\.$escaped\]\s+.*?^enabled\s*=\s*true\s*$") { throw "$server is not enabled for trusted Codex sessions." }
        if ($config -notmatch "(?ms)^\[mcp_servers\.$escaped\]\s+.*?^required\s*=\s*true\s*$") { throw "$server is not required for trusted Codex sessions." }
    }
    if ($config -cmatch '(?m)^cwd\s*=') { throw 'Codex validated-reader startup must not depend on its process working directory.' }

    try { $hooks = [IO.File]::ReadAllText($hooksPath) | ConvertFrom-Json }
    catch { throw ".codex/hooks.json is not valid JSON: $($_.Exception.Message)" }

    # THE SHAPE, WHICH VALID JSON DOES NOT IMPLY. Until 2026-09-06 this check read
    # $hooks.PreToolUse -- the events at the ROOT of the file -- and passed for months on a file
    # Codex rejected outright:
    #   warning: failed to parse hooks config ...: unknown field `PreToolUse`,
    #                                             expected `description` or `hooks`
    # Every Library hook was therefore absent from every Codex session, and nothing said so: the
    # file existed, parsed as JSON, and named the right scripts. Verified against codex 0.147.0 by
    # driving both shapes through a real `codex exec` run. So the root keys are now the first thing
    # asserted, and the events are read from where Codex actually looks for them.
    $rootNames = @($hooks.PSObject.Properties | ForEach-Object { $_.Name })
    $stray = @($rootNames | Where-Object { $_ -cnotin @('description', 'hooks') })
    if ($stray.Count) { throw "Codex rejects a hooks file with $($stray -join ', ') at the root; every event must nest under 'hooks'." }
    if ($rootNames -cnotcontains 'hooks') { throw ".codex/hooks.json has no top-level 'hooks' key, so Codex registers nothing." }

    # One structural reader now serves both clients, because the corrected Codex shape and
    # .claude/settings.json agree: events under a 'hooks' key, each a list of matcher blocks.
    . (Join-Path $PSScriptRoot 'HookRegistry.ps1')
    $registered = Get-RegisteredHookEvents $hooks
    $codexRequired = @(
        @{ file = 'Guard-BasicMemoryRead.ps1'; event = 'PreToolUse'; detail = 'Codex Basic Memory calls are not registered with the Desk guard' },
        @{ file = 'Guard-ShellShelfRead.ps1';  event = 'PreToolUse'; detail = 'Codex shell commands can read a closed Shelf Book' },
        @{ file = 'Guard-ShelfBookRead.ps1';   event = 'PreToolUse'; detail = 'Codex apply_patch can write into a closed Shelf Book' },
        @{ file = 'Get-VirtualDeskContext.ps1'; event = 'UserPromptSubmit'; detail = 'Codex does not load Virtual Desk context at prompt submission' }
    )
    foreach ($entry in $codexRequired) {
        if (-not $registered.ContainsKey($entry.file)) { throw "$($entry.detail): $($entry.file) is absent." }
        if (@($registered[$entry.file]) -cnotcontains $entry.event) {
            throw "$($entry.detail): $($entry.file) is registered under $(@($registered[$entry.file]) -join ', ') rather than $($entry.event)."
        }
    }

    # The shell guard is useless if its matcher names no tool Codex actually calls, and the obvious
    # guess was wrong. A PreToolUse payload captured from a real `codex exec` run on 2026-09-06
    # carries tool_name 'Bash' -- Codex normalises its shell tool to the Claude Code name for hooks,
    # and 'exec' survives only inside tool_use_id. A matcher of '^exec$' matches nothing, silently,
    # which is the same failure as no guard at all.
    $shellBlocks = @($hooks.hooks.PreToolUse | Where-Object {
        @($_.hooks | Where-Object { (Get-HookEntryText $_) -match 'Guard-ShellShelfRead\.ps1' }).Count
    })
    if (@($shellBlocks | Where-Object { [string]$_.matcher -cmatch '(^|\||\()Bash($|\||\))' }).Count -lt 1) {
        throw "the Codex shell guard's matcher does not name the Bash tool, so it can never fire."
    }

    # The same assertion for the write half, for the same reason and against the same class of
    # mistake. apply_patch is NOT normalised to a Claude Code name the way the shell tool is -- the
    # payload captured 2026-09-07 carries tool_name 'apply_patch' verbatim -- so a matcher naming
    # 'Write' or 'Edit' here would be the `^exec$` failure repeated: registered, and unable to fire.
    $patchBlocks = @($hooks.hooks.PreToolUse | Where-Object {
        @($_.hooks | Where-Object { (Get-HookEntryText $_) -match 'Guard-ShelfBookRead\.ps1' }).Count
    })
    if (@($patchBlocks | Where-Object { [string]$_.matcher -cmatch 'apply_patch' }).Count -lt 1) {
        throw "the Codex patch guard's matcher does not name apply_patch, so it can never fire."
    }

    'both MCP servers required; events nested under hooks; Desk guard, shell guard, patch guard and context hook registered'
}

Invoke-Check 'codex.delegation-runs-hooks' {
    # WHY A RECIPE IS THE WHOLE MECHANISM HERE. Codex records hook trust per CODEX_HOME, under
    # [hooks.state] in that home's own config.toml, and it skips an untrusted hook SILENTLY.
    # `codex exec` has no interactive review with which to earn trust, so a delegate launched
    # without --dangerously-bypass-hook-trust runs with NO Library guard and nothing reports the
    # absence. This repository cannot close that any other way: it may not write another
    # application's trust store, and no check can assert that a per-machine grant happened. The
    # flag on the documented command is the entire fix, and a recipe loses a flag in an ordinary
    # edit without anything failing -- hence a gate check rather than a habit.
    #
    # MEASURED 2026-09-08 on codex-cli 0.153.4, one binary and one workspace, `exec` throughout,
    # moving only the trust variable. With CODEX_HOME redirected by Orca and no flag, a shell
    # command naming a page of the closed `holding` Book RAN to completion; with the flag, the
    # identical command in the identical home was refused by Guard-ShellShelfRead, attributed by
    # Codex's own "Command blocked by PreToolUse hook". A control command naming no Shelf path ran
    # unblocked in both, which is what makes the unguarded row a measurement rather than a broken
    # harness. Record: docs/hook-enforced-boundaries.md.
    $surfaces = @('docs/librarian-operation-playbooks.md', 'docs/model-division-of-labor.md')
    $trustFlag = '--dangerously-bypass-hook-trust'

    $commandCount = 0
    $unguarded = [Collections.Generic.List[string]]::new()
    $silent = [Collections.Generic.List[string]]::new()

    foreach ($relative in $surfaces) {
        $path = Join-Path $workspace $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "$relative is missing." }
        $text = [IO.File]::ReadAllText($path)

        # The delegation COMMAND, not prose that merely mentions codex exec. Anchored on the sandbox
        # flag every documented launch carries, so a rewrite that drops the sandbox is reported as a
        # missing command rather than passing as a command with nothing left to assert.
        $found = @([regex]::Matches($text, '(?m)^[ \t]*codex\s+exec\s+[^\r\n]*--sandbox\s+workspace-write[^\r\n]*$'))
        if (-not $found.Count) {
            throw "$relative carries no delegation command for this check to read; the recipe moved and the assertion is now blind."
        }
        foreach ($hit in $found) {
            $commandCount++
            if ($hit.Value -cnotmatch [regex]::Escape($trustFlag)) {
                [void]$unguarded.Add("$relative : $($hit.Value.Trim())")
            }
        }

        # The cause in words, so a reader who meets an unguarded delegate can name it. A flag with
        # no explanation beside it is a flag the next editor removes as noise.
        if ($text -cnotmatch 'CODEX_HOME') { [void]$silent.Add($relative) }
    }

    if ($unguarded.Count) {
        throw "a documented delegation command omits $trustFlag, so a delegate launched from it runs with no Library hook and nothing says so: $($unguarded -join ' | ')"
    }
    if ($silent.Count) {
        throw "nothing names CODEX_HOME as what decides whether a delegate's hooks run at all on: $($silent -join ', ')"
    }

    "$commandCount delegation command(s) across $($surfaces.Count) surface(s) carry $trustFlag, and both name the CODEX_HOME precondition"
}

# --- Three PowerShell defect families that have each bitten this codebase more than once ----------
# All three are silent: the code reads correctly and does the wrong thing only for particular inputs.
#
#   case    -match/-notmatch/-like are case-insensitive by default, so a rule spelled [a-z0-9]
#           accepts 'Odysseus'. Found in the note triage that is now Invoke-LibraryTriage,
#           Get-CaptureBook, Set-VirtualDesk, and three more places in the validated reader.
#   unroll  A pipeline yielding exactly one item unrolls to a bare scalar, so .Count and [0] on it
#           throw under StrictMode. Recorded in docs/project-hub-design.md.
#   shadow  A local variable whose name matches a script parameter *is* that parameter, and names
#           match case-insensitively: '$preflight = Get-ChildPreflight $action' rewrites
#           [switch]$Preflight, and the resulting binding error is blamed on the invocation rather
#           than on the assignment. Found 2026-08-18. Only script-scope assignments count, and only
#           to non-string parameters: the tree-wide default-if-unset idiom hands string parameters
#           string defaults on purpose, and a lint that cries wolf gets suppressed.
#
# Parsed with PowerShell's own parser rather than grepped, because all three families are about
# structure: which operator variant, whether the right-hand side is wrapped in @(), and which scope
# an assignment lands in. A text search for '-notmatch' cannot tell a lowercase-only rule from a
# message assertion.
Invoke-Check 'powershell.defect-families' {
    $roots = @(
        (Join-Path $workspace 'tools'),
        (Join-Path $workspace '.claude/hooks'),
        (Join-Path $workspace '.claude/adapters')
    )
    $files = @($roots | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.ps1' -File })
    if (-not $files.Count) { throw 'no PowerShell sources found to scan' }

    # Nearest enclosing function, so two same-named locals in one file are not confused for each other.
    function Get-ScopeKey($Node) {
        $parent = $Node.Parent
        while ($null -ne $parent) {
            if ($parent -is [System.Management.Automation.Language.FunctionDefinitionAst]) { return "$($parent.Name)@$($parent.Extent.StartLineNumber)" }
            $parent = $parent.Parent
        }
        '<script>'
    }

    # Does this expression's value travel the PIPELINE, where a collection unrolls? Walked upward
    # rather than pattern-matched, because the same call is safe or unsafe purely by position.
    #
    # A DIRECT expression assignment does not unroll, and neither does @(), $(), a cast, a comma, or
    # being consumed as an argument or a receiver. What does unroll: `return <expr>`, a bare trailing
    # statement whose value leaves the function, and an if/foreach/switch STATEMENT used as a value --
    # including when that statement is then assigned, which is why crossing one is remembered.
    function Get-UnrollPosition($Node) {
        $current = $Node
        $crossedStatement = $false
        while ($null -ne $current.Parent) {
            $parent = $current.Parent
            if ($parent -is [System.Management.Automation.Language.ArrayExpressionAst] -or
                $parent -is [System.Management.Automation.Language.SubExpressionAst] -or
                $parent -is [System.Management.Automation.Language.ParenExpressionAst] -or
                $parent -is [System.Management.Automation.Language.ConvertExpressionAst] -or
                $parent -is [System.Management.Automation.Language.UnaryExpressionAst] -or
                $parent -is [System.Management.Automation.Language.ArrayLiteralAst] -or
                $parent -is [System.Management.Automation.Language.HashtableAst] -or
                $parent -is [System.Management.Automation.Language.BinaryExpressionAst] -or
                $parent -is [System.Management.Automation.Language.IndexExpressionAst] -or
                $parent -is [System.Management.Automation.Language.MemberExpressionAst] -or
                $parent -is [System.Management.Automation.Language.CommandAst]) { return 'safe' }
            if ($parent -is [System.Management.Automation.Language.AssignmentStatementAst]) {
                if ($crossedStatement) { return 'an if/foreach/switch statement used as a value' }
                return 'safe'
            }
            if ($parent -is [System.Management.Automation.Language.ReturnStatementAst]) { return 'a return statement' }
            if ($parent -is [System.Management.Automation.Language.IfStatementAst] -or
                $parent -is [System.Management.Automation.Language.ForEachStatementAst] -or
                $parent -is [System.Management.Automation.Language.SwitchStatementAst] -or
                $parent -is [System.Management.Automation.Language.TryStatementAst] -or
                $parent -is [System.Management.Automation.Language.LoopStatementAst]) { $crossedStatement = $true }
            if ($parent -is [System.Management.Automation.Language.NamedBlockAst] -or
                $parent -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
                $parent -is [System.Management.Automation.Language.ScriptBlockAst]) {
                if ($crossedStatement) { return 'an if/foreach/switch statement used as a value' }
                return 'a bare trailing statement'
            }
            $current = $parent
        }
        'safe'
    }

    $findings = [Collections.Generic.List[string]]::new()
    # Calls that can legitimately return an EMPTY array. SPLIT IS DELIBERATELY ABSENT: splitting even
    # an empty string yields one element, so it never unrolls to nothing -- including it would flag
    # twenty correct sites and teach the reader to skip this finding. The set is emptiness, not
    # arrayness. $emptyCapableSites counts what it examined, because a set that matched nothing --
    # one renamed method away -- would pass vacuously forever, which is the silent pass
    # gate.fast-roster-matches-suites refuses for the same reason.
    $emptyCapableCalls = @('ReadAllBytes', 'ReadAllLines', 'GetFiles', 'GetDirectories', 'GetFileSystemEntries')
    $emptyCapableSites = 0
    $automatic = @('null', 'true', 'false', 'args', 'input', 'error', 'errorview', 'executioncontext', 'foreach', 'home', 'host', 'lastexitcode', 'matches', 'myinvocation', 'nestedpromptlevel', 'pid', 'profile', 'psboundparameters', 'pscmdlet', 'pscommandpath', 'psculture', 'psdebugcontext', 'pshome', 'psitem', 'psscriptroot', 'pssenderinfo', 'psuiculture', 'psversiontable', 'pwd', 'sender', 'shellid', 'stacktrace', 'switch', 'this', 'ofs', '?', '^', '_')
    foreach ($file in $files) {
        $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$parseErrors)
        if ($parseErrors -and @($parseErrors).Count) { throw "$($file.Name) does not parse: $(@($parseErrors)[0].Message)" }

        # -- case ---------------------------------------------------------------------------------
        foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.BinaryExpressionAst] }, $true)) {
            # The AST names the case-insensitive variants with an I prefix: -match is Imatch,
            # -cmatch is Cmatch. That distinction is the whole check.
            if ($node.Operator.ToString() -notin @('Imatch', 'Inotmatch', 'Ilike', 'Inotlike')) { continue }
            $right = $node.Right
            if ($right -is [System.Management.Automation.Language.CommandExpressionAst]) { $right = $right.Expression }
            if ($right -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { continue }
            $pattern = [string]$right.Value
            if ($pattern -match '\(\?i\)') { continue }        # case-insensitivity asked for on purpose
            if ($pattern -cmatch '[A-Z]') { continue }         # not a lowercase-only rule
            if ($pattern -cnotmatch '\[a-z') { continue }      # no lowercase-only character class
            [void]$findings.Add("$($file.Name):$($node.Extent.StartLineNumber) case-insensitive operator on a lowercase-only rule: $($node.Extent.Text -replace '\s+', ' ')")
        }

        # -- unroll -------------------------------------------------------------------------------
        $consumed = @{}
        foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.MemberExpressionAst] }, $true)) {
            if ($node.Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
                $node.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
                $node.Member.Value -in @('Count', 'Length')) {
                $consumed["$(Get-ScopeKey $node)|$($node.Expression.VariablePath.UserPath)"] = $true
            }
        }
        foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.IndexExpressionAst] }, $true)) {
            if ($node.Target -is [System.Management.Automation.Language.VariableExpressionAst]) {
                $consumed["$(Get-ScopeKey $node)|$($node.Target.VariablePath.UserPath)"] = $true
            }
        }
        foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)) {
            if ($node.Left -isnot [System.Management.Automation.Language.VariableExpressionAst]) { continue }
            if (-not $consumed.ContainsKey("$(Get-ScopeKey $node)|$($node.Left.VariablePath.UserPath)")) { continue }
            $rhs = $node.Right
            if ($rhs -is [System.Management.Automation.Language.CommandExpressionAst]) { $rhs = $rhs.Expression }
            if ($rhs -is [System.Management.Automation.Language.ArrayExpressionAst] -or $rhs -is [System.Management.Automation.Language.ArrayLiteralAst]) { continue }
            if ($node.Right -isnot [System.Management.Automation.Language.PipelineAst]) { continue }
            $risky = $node.Right.PipelineElements.Count -gt 1
            if (-not $risky -and $node.Right.PipelineElements[0] -is [System.Management.Automation.Language.CommandAst]) {
                $command = [string]$node.Right.PipelineElements[0].GetCommandName()
                $risky = $command -and $command -match '^(Get-ChildItem|Where-Object|Select-Object|Sort-Object|Group-Object)$'
            }
            if ($risky) { [void]$findings.Add("$($file.Name):$($node.Extent.StartLineNumber) pipeline result counted or indexed without @(): $($node.Extent.Text -replace '\s+', ' ')") }
        }

        # -- unroll, the OTHER direction: a value that unrolls on the way OUT ----------------------
        # The detector above reads the CONSUMPTION side -- a pipeline result counted or indexed
        # without @(). This one reads the PRODUCTION side, which that one structurally cannot see: a
        # call that can legitimately return an EMPTY array, sitting where its value travels the
        # pipeline. An empty collection unrolls to NOTHING, so the caller receives $null and dies
        # inside GetString, ToBase64String or .Length -- naming a null array rather than the file,
        # which sends the diagnosis to the caller.
        #
        # WHY IT EARNS ITS PLACE. PLAN-multi-desk.md risk 6 recorded this blind spot and scoped the
        # fix out when the class had bitten once. On 2026-09-09 it bit three times in one hour:
        # Get-DeskMigrationPlan could not preflight a seat whose Desk files were empty -- which is
        # every seat before its first opened Book, and the live 2nd-b-vault-dev seat was in exactly
        # that state and could not be entered -- while Get-DeskBytes and Read-AtomicBytes returned
        # $null from the same cause on the same inputs. Two of the three were function RETURNS, which
        # no assignment-shaped rule can see, so this keys on the call and its position instead.
        foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)) {
            if ($node.Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { continue }
            if ($node.Member.Value -notin $emptyCapableCalls) { continue }
            $emptyCapableSites++
            $position = Get-UnrollPosition $node
            if ($position -ceq 'safe') { continue }
            [void]$findings.Add("$($file.Name):$($node.Extent.StartLineNumber) $($node.Member.Value) can return an EMPTY array and its value reaches the pipeline through $position, so an empty result arrives as `$null -- assign it directly, or wrap it in @() or a comma: $($node.Extent.Text -replace '\s+', ' ')")
        }

        # -- shadow -------------------------------------------------------------------------------
        # Family 5: a local whose name matches a script parameter *is* that parameter, and names
        # match case-insensitively. Only script-scope assignments count -- an assignment inside a
        # function writes that function's scope, never the script's parameter. Only non-string
        # parameters are flagged: handing a switch (or any typed non-string) parameter a computed
        # value is what corrupts its type, while the tree's default-if-unset idiom reassigns string
        # parameters to string defaults on purpose. Prefer a miss over a false positive.
        $paramBlock = $ast.ParamBlock
        if ($null -ne $paramBlock) {
            $shadowParams = @($paramBlock.Parameters | Where-Object { $_.StaticType -ne [string] } | ForEach-Object { $_.Name.VariablePath.UserPath })
            foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)) {
                if ($node.Left -isnot [System.Management.Automation.Language.VariableExpressionAst]) { continue }
                $variable = $node.Left.VariablePath
                if (-not $variable.IsUnqualified) { continue }                                    # $script:x is deliberate
                if ($variable.UserPath.ToLowerInvariant() -in $automatic) { continue }            # $null = ... etc.
                if ($node.Extent.StartOffset -ge $paramBlock.Extent.StartOffset -and
                    $node.Extent.EndOffset -le $paramBlock.Extent.EndOffset) { continue }         # param() default value
                if ((Get-ScopeKey $node) -cne '<script>') { continue }                            # function-local scope
                $shadowed = $null
                foreach ($name in $shadowParams) { if ($variable.UserPath -ieq $name) { $shadowed = $name; break } }
                if ($null -eq $shadowed) { continue }
                [void]$findings.Add("$($file.Name):$($node.Extent.StartLineNumber) assignment to script parameter '$shadowed': $($node.Extent.Text -replace '\s+', ' ')")
            }
        }
    }

    if ($findings.Count) { throw ($findings -join ' || ') }
    # SCOPED TO THIS REPOSITORY'S OWN TREE. Zero sites is the correct answer for a scratch fixture
    # holding one synthetic file -- Test-LibraryHelpers builds exactly those, and an unscoped guard
    # failed its two family 5 NEGATIVE controls, which is the guard reporting on the fixture's shape
    # rather than on the detector. Against our own sources zero means the call set matched nothing.
    $ownTree = ((Resolve-Path -LiteralPath $workspace).Path -ceq (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path)
    if ($ownTree -and $emptyCapableSites -eq 0) {
        throw ('the empty-capable call set matched nothing across this repository, so the unroll family''s ' +
               'production-side detector examined no site and would pass vacuously; a method was renamed, ' +
               'or the scan lost its files.')
    }
    "$($files.Count) sources scanned, all three families clean; $emptyCapableSites empty-capable call site(s) positioned safely"
}

# --- The launch-time validation in the reader, which nothing else can vouch for -------------------
# Two parts, because either alone has a blind spot. The fixture suite proves the validator still
# recognises a fault; the live launch proves it is pointed at the real settings file. The defect this
# replaces was a wrong *default* for $StateDirectory -- every fixture passes its own directory, so no
# fixture could ever have caught it, and the validator sat inert for a whole phase reporting a fault
# that was always false and gating its own hook check behind it.
# --- Every MCP transport recovers from an expired session -----------------------------------------
# Ten helper-owned copies of this transport existed with NO recovery while the reader adapter alone
# carried the fix. An expired session id stays cached, so every later call in that run fails while the
# NAS is healthy and answering a fresh initialize on the first try. The copies are deliberate --
# tools/SharedBookSource.ps1 records the decision not to unify them -- so this check holds every copy
# to one contract instead of pretending any single one is canonical.
Invoke-Check 'mcp.transports-recover-sessions' {
    $roots = @(
        (Join-Path $workspace 'tools'),
        (Join-Path $workspace '.claude/adapters')
    )
    $files = @($roots | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.ps1' -File })
    if (-not $files.Count) { throw 'no PowerShell sources found to scan' }

    $findings = [Collections.Generic.List[string]]::new()
    $transports = [Collections.Generic.List[string]]::new()

    foreach ($source in $files) {
        $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($source.FullName, [ref]$null, [ref]$parseErrors)
        if ($parseErrors -and @($parseErrors).Count) { throw "$($source.Name) does not parse: $(@($parseErrors)[0].Message)" }

        # Declarations, not a text match. The retry's own comment block names both "Session not
        # found" and edit_note, so any string-based discriminator would count a comment as a
        # transport and a test fixture as a caller.
        $declared = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Name })
        $wrappers = @($declared | Where-Object { $_ -cmatch '^Invoke-(?:Shared|Remote)?Mcp$' })
        if (-not $wrappers.Count) { continue }
        [void]$transports.Add($source.Name)

        foreach ($wrapper in $wrappers) {
            if (-not (@($declared) -ccontains "${wrapper}Once")) {
                [void]$findings.Add("$($source.Name): $wrapper has no non-retrying ${wrapper}Once primitive")
            }
        }

        $body = [IO.File]::ReadAllText($source.FullName)
        if ($body -cnotmatch 'Session not found') {
            [void]$findings.Add("$($source.Name): no recovery from an expired session")
        }

        # The handshake must call the primitive. Routed through the retrying wrapper, a handshake that
        # keeps failing re-enters the retry without bound.
        $lineNumber = 0
        foreach ($line in @($body -split "`r?`n")) {
            $lineNumber++
            if ($line -cnotmatch "'initialize'") { continue }
            if ($line -cmatch '^\s*#') { continue }
            if ($line -cmatch 'Invoke-(?:Shared|Remote)?Mcp\b' -and $line -cnotmatch 'Invoke-(?:Shared|Remote)?McpOnce\b') {
                [void]$findings.Add("$($source.Name):$lineNumber handshake routed through the retrying wrapper")
            }
        }

        # A transport that can issue edit_note must consult the additive-operation exclusion. append,
        # prepend and the insert_* edits are not idempotent: a second application duplicates content
        # with no error, which is the one failure a blind retry would hide. Every call site today uses
        # find_replace, which self-guards through expected_replacements -- this keeps that true.
        if ($body -cmatch "name = 'edit_note'" -and -not (@($declared) -ccontains 'Test-McpRetryIsSafe')) {
            [void]$findings.Add("$($source.Name): issues edit_note with no additive-operation exclusion")
        }
    }

    if (-not $transports.Count) { throw 'no MCP transport declarations found; this check''s discriminator has drifted' }
    if ($findings.Count) { throw ($findings -join '; ') }
    "$($transports.Count) MCP transport(s) recover from an expired session"
}
# --- Every MCP transport survives an id-less event ------------------------------------------------
# Basic Memory interleaves id-less notifications/message log frames into the SSE stream ahead of the
# response it is logging about: list_memory_projects emits {"level":"info","data":{"msg":"Listing all
# available projects"}} before its own result. Nine copies of this transport picked their response
# with a bare $_.id comparison, and under Set-StrictMode -Version Latest reading .id on a frame that
# has none THROWS -- "The property 'id' cannot be found on this object", an error naming the client
# rather than the server that logged. Verified by raw SSE capture and reproduced against the shipped
# ConvertFrom-SseJson on 2026-09-03. Every call the Library makes today survived only because those
# particular server methods happen not to log mid-call: luck, not design.
#
# The guard must ENUMERATE the property names rather than read the aggregate .Name, which throws in
# turn on a property-less {} frame -- defect family 4 in .claude/rules/library-development.md. Both
# spellings are checked, because the aggregate one looks correct and fails only on the rarer frame.
Invoke-Check 'mcp.transports-guard-idless-events' {
    $roots = @(
        (Join-Path $workspace 'tools'),
        (Join-Path $workspace '.claude/adapters')
    )
    $files = @($roots | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.ps1' -File })
    if (-not $files.Count) { throw 'no PowerShell sources found to scan' }

    $findings = [Collections.Generic.List[string]]::new()
    $transports = [Collections.Generic.List[string]]::new()
    $guarded = 0

    foreach ($source in $files) {
        $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($source.FullName, [ref]$null, [ref]$parseErrors)
        if ($parseErrors -and @($parseErrors).Count) { throw "$($source.Name) does not parse: $(@($parseErrors)[0].Message)" }

        # Same discriminator as mcp.transports-recover-sessions: a declared wrapper, not a text
        # match, so a comment naming .id cannot make a file look like a transport and a test
        # harness reading its own child's stdout is correctly left out.
        $declared = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Name })
        if (-not @($declared | Where-Object { $_ -cmatch '^Invoke-(?:Shared|Remote)?Mcp$' }).Count) { continue }
        [void]$transports.Add($source.Name)

        # Scope to the function that splits the SSE stream. That is where frames the SERVER wrote
        # are read, and it is the only place an id-less frame can arrive. Everywhere else in these
        # files, .id is read off an object we built ourselves ($payload.id) or off a record that
        # always carries one -- guarding those would be noise, and a check that cries wolf on
        # correct code is how a real finding gets scrolled past.
        $sseFunctions = @($ast.FindAll({
            param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $n.Extent.Text -match "-like\s+'data:\*'"
        }, $true))
        if (-not $sseFunctions.Count) {
            [void]$findings.Add("$($source.Name): declares an MCP transport but no function splits the SSE stream; this check's discriminator has drifted")
            continue
        }

        # $_.id inside that function -- the frame the pipeline is currently filtering. A transport
        # that selects on result/error presence instead, the way Remove-MemoryProject.ps1 does,
        # reads no .id here at all and correctly contributes nothing.
        $reads = @($sseFunctions | ForEach-Object {
            $_.FindAll({
                param($n)
                $n -is [System.Management.Automation.Language.MemberExpressionAst] -and
                $n.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
                $n.Member.Value -ieq 'id' -and
                $n.Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
                $n.Expression.VariablePath.UserPath -ieq '_'
            }, $true)
        })

        foreach ($read in $reads) {
            # The guard has to sit in the same scriptblock that does the reading, which is where a
            # Where-Object filter puts it. Walking out to the enclosing block is what proves that.
            $scope = $read
            while ($null -ne $scope -and -not ($scope -is [System.Management.Automation.Language.ScriptBlockExpressionAst])) { $scope = $scope.Parent }
            $text = if ($null -ne $scope) { $scope.Extent.Text } else { $read.Parent.Extent.Text }

            if ($text -imatch '@\(\s*\$_\.PSObject\.Properties\s*\|\s*ForEach-Object\s*\{\s*\$_\.Name\s*\}\s*\)\s*-contains\s+''id''') {
                $guarded++
                continue
            }
            if ($text -imatch '\$_\.PSObject\.Properties\.Name\s*-contains\s+''id''') {
                [void]$findings.Add("$($source.Name):$($read.Extent.StartLineNumber) guards .id through the aggregate .Name, which throws on a property-less frame; enumerate instead")
                continue
            }
            [void]$findings.Add("$($source.Name):$($read.Extent.StartLineNumber) reads .id with no presence guard; an id-less log frame throws here")
        }
    }

    if (-not $transports.Count) { throw 'no MCP transport declarations found; this check''s discriminator has drifted' }
    if (-not $guarded) {
        # Not a pass. Either every copy moved to selecting on result/error presence, the way
        # Remove-MemoryProject.ps1 does -- in which case retire this check deliberately -- or the
        # guard's spelling drifted and this check was about to pass while proving nothing.
        throw 'no guarded .id read found in any transport: either every copy now selects on result/error presence (retire this check) or the guard spelling has drifted'
    }
    if ($findings.Count) { throw ($findings -join '; ') }
    "$($transports.Count) MCP transport(s); $guarded .id read(s) guarded against id-less frames, none bare"
}
Invoke-Check 'reader.launch-validation' {
    $adapter = Join-Path $workspace '.claude/adapters/Validated-BookReader.ps1'
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $adapter -LaunchSelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 6) -join ' | ') }

    $stamp = [guid]::NewGuid().ToString('N')
    $stdin = Join-Path ([IO.Path]::GetTempPath()) "launch-in-$stamp.txt"
    $stderrPath = Join-Path ([IO.Path]::GetTempPath()) "launch-err-$stamp.txt"
    $stdoutPath = Join-Path ([IO.Path]::GetTempPath()) "launch-out-$stamp.txt"
    try {
        # Empty stdin: the adapter's JSON-RPC loop reads to EOF and exits without serving anything.
        [IO.File]::WriteAllText($stdin, '', [Text.UTF8Encoding]::new($false))
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$adapter`"" `
            -RedirectStandardInput $stdin -RedirectStandardError $stderrPath -RedirectStandardOutput $stdoutPath `
            -NoNewWindow -Wait | Out-Null
        $emitted = Get-Content -Raw -LiteralPath $stderrPath
        if (-not [string]::IsNullOrWhiteSpace($emitted)) {
            throw "reader emitted at launch against the real workspace: $(($emitted.Trim() -replace '\s+', ' '))"
        }
        'fixture suite passed; live launch silent'
    }
    finally {
        foreach ($path in @($stdin, $stderrPath, $stdoutPath)) {
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
        }
    }
}

# --- Helper manifest versus the permission allowlist ---------------------------------------------
Invoke-Check 'helpers.manifest-matches-allowlist' {
    $manifestPath = Join-Path $PSScriptRoot '_helpers.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'tools/_helpers.json is missing.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $declared = @($manifest.helpers.PSObject.Properties.Name)

    $onDisk = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File | ForEach-Object { $_.Name })
    $undeclared = @($onDisk | Where-Object { $_ -notin $declared })
    if ($undeclared.Count) { throw "script(s) not declared in _helpers.json: $($undeclared -join ', ')" }
    $ghosts = @($declared | Where-Object { $_ -notin $onDisk })
    if ($ghosts.Count) { throw "declared but missing from disk: $($ghosts -join ', ')" }

    $settingsFile = @('settings.json', 'settings.local.json') |
        ForEach-Object { Join-Path $workspace (Join-Path '.claude' $_) } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    $allowRaw = Get-Content -LiteralPath $settingsFile -Raw

    # The two directions are NOT symmetric, and treating them alike made a papercut fail the commit.
    #
    # An internal or test helper that IS allowlisted is silently runnable when nothing is supposed to
    # invoke it. That is a real safety property, so it still throws.
    #
    # A public helper that is NOT allowlisted only costs a permission prompt on first use. Failing the
    # gate for that blocks the commit until .claude/settings.json is edited -- and that file is guarded
    # against the agent that just wrote the helper, so a new public helper could not land without a
    # human editing settings.json by hand. Prompt friction is worth reporting, not worth blocking.
    $unsafe = [Collections.Generic.List[string]]::new()
    $friction = [Collections.Generic.List[string]]::new()
    foreach ($name in $declared) {
        $role = [string]$manifest.helpers.$name.role
        $allowlisted = $allowRaw -match [regex]::Escape("tools/$name")
        if ($role -eq 'public' -and -not $allowlisted) {
            [void]$friction.Add($name)
        }
        elseif ($role -ne 'public' -and $allowlisted) {
            [void]$unsafe.Add("$name is $role but IS allowlisted")
        }
    }
    if ($unsafe.Count) { throw ($unsafe -join '; ') }

    # The other direction of the same list, added 2026-09-19 when step 10 deleted two delegate
    # helpers and nothing said their allowlist lines were still there. The loop above walks the
    # MANIFEST, so an allowlist entry for a helper that no longer exists is read by nothing: the
    # entry grants permission to run a file that is gone, and it ships in .claude/settings.json.
    # Warn rather than fail, for the reason the friction half warns -- only the reader can edit that
    # file, so failing would block a commit on an edit the committer is refused.
    $orphanAllow = @([regex]::Matches($allowRaw, 'tools/([A-Za-z0-9._-]+\.ps1)') |
        ForEach-Object { $_.Groups[1].Value } |
        Sort-Object -Unique |
        Where-Object { $_ -notin $declared })

    # --- The other half of the same question: the MCP tools this workspace's own adapters declare ---
    #
    # Until now this check read `tools/*.ps1` and nothing else, so a new PUBLIC HELPER warned and a
    # new MCP TOOL raised NOTHING -- it simply prompted once per session until a human noticed. That
    # bit at rung 6, at item 2.3 (where `search_open_books` sat unallowlisted for a day), and it was
    # the closing note of three items running. The inventory is asked of the adapter itself over
    # JSON-RPC rather than kept as a second list here, because a hand-maintained roster of tool names
    # would be the drift it exists to fix. Reasoning and boundaries: tools/McpToolInventory.ps1.
    #
    # It warns rather than fails for exactly the reason the public-helper half does: only the reader
    # can edit .claude/settings.json, so failing the gate would block a commit on an edit the
    # committer is refused.
    . (Join-Path $PSScriptRoot 'McpToolInventory.ps1')
    $mcp = Get-McpToolAllowlistStatus -Workspace $workspace -SettingsPath $settingsFile
    $mcpDeclared = @($mcp.declared)
    $mcpMissing = @($mcp.missing)
    $mcpBlind = @($mcp.not_enumerable | ForEach-Object { [string]$_.server })

    $warnings = [Collections.Generic.List[string]]::new()
    if ($friction.Count) {
        [void]$warnings.Add("public helper(s) not allowlisted, so each raises a permission prompt until settings.json names it: $(@($friction | Sort-Object) -join ', ')")
    }
    if ($mcpMissing.Count) {
        [void]$warnings.Add("MCP tool(s) declared by an adapter but not allowlisted, so each prompts once per session: $(@($mcpMissing | Sort-Object) -join ', ')")
    }
    if ($orphanAllow.Count) {
        [void]$warnings.Add("allowlist entr(ies) naming a helper no longer in _helpers.json, so settings.json grants a file that is gone: $($orphanAllow -join ', ')")
    }

    # The count of servers this check could NOT ask is carried in every answer, clean or not. A
    # coverage figure that only appears when something is wrong is a coverage figure nobody reads.
    $blindNote = if ($mcpBlind.Count) { "; not enumerable offline: $(@($mcpBlind | Sort-Object) -join ', ')" } else { '' }
    $scope = "$($declared.Count) helpers and $($mcpDeclared.Count) MCP tool(s) from $(@($mcp.servers_enumerated).Count) local adapter(s)$blindNote"

    if ($warnings.Count) { return "WARN: $scope; $($warnings -join ' | ')" }
    "$scope -- allowlist consistent"
}

# --- Shelf references name Books that exist ------------------------------------------------------
# The 1.1 rename had a touch list spanning helper defaults, the guard hooks, the library-help Skill,
# and the root guides. A list like that is remembered once and rots after; this is the invariant
# underneath it, so a stale reference fails the commit instead of waiting to be noticed.
#
# docs/ is deliberately out of scope: a design record naming shelf/inbox under a 2026-08-16 date is a
# true statement about that day, and rewriting it would falsify the record. Declared test runners are
# out of scope too -- their Shelf paths are fixture slugs that intentionally do not exist.
# --- 2.1: the overlap record file agrees with the catalog it names -------------------------------
# These records outlive the session that wrote them and are read by nothing that would notice drift:
# a Book renamed or archived after a record was written leaves the record naming a Book that no
# longer exists, and nothing else in the tree would say so. The helper owns the rules; this check
# runs them on every commit rather than only when someone happens to add a record.
Invoke-Check 'shelf.overlap-records' {
    $recordPath = Join-Path $workspace 'internal/overlap-records.json'
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) { return 'no overlap records yet' }
    $result = & (Join-Path $PSScriptRoot 'Set-TopicOverlap.ps1') -Action Validate -WorkspacePath $workspace
    "$($result.count) overlap record(s), all valid"
}

# --- 3.1: the raw batch ownership records are structurally sound ----------------------------------
# Same reasoning as the overlap records above: these outlive the session that wrote them and nothing
# else would notice a malformed one. Deliberately offline and deliberately blind to whether the
# Project exists or the batch is still on disk -- both are read-time questions, and a pre-commit
# check that needed the NAS would fail whenever the NAS was down.
Invoke-Check 'raw.batch-owners' {
    $recordPath = Join-Path $workspace 'internal/raw-batch-owners.json'
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) { return 'no raw batch ownership records yet' }
    $result = & (Join-Path $PSScriptRoot 'Set-RawBatchOwner.ps1') -Action Validate -WorkspacePath $workspace
    "$($result.count) raw batch ownership record(s), all valid"
}

# --- 3.2: the Book-root state schema has exactly one definition -----------------------------------
# Before 3.2 the books/<slug>|shelf/<slug> shape was written out independently in eight places, so
# adding a third location meant finding every one of them and hoping. This is the invariant that
# replaces the hoping: no file except the schema itself may carry a Book-root VALIDATION pattern.
#
# WHAT THIS CAN AND CANNOT ENFORCE, stated rather than implied. It catches a second definition of
# which roots are well-formed -- the thing that would silently accept or reject the wrong Desk state.
# It does NOT catch a site that composes a root by string interpolation; those are covered
# behaviourally by desk.book-root-selftest instead, which drives the real producer and the real
# consumers against a fixture workspace. A check that documentation could satisfy is worse than no
# check, so the half that cannot be gated is named here as a limit.
#
# Block comments are stripped before matching, because rung 4's static scan counted a mention inside
# <# #> as a call and the same trap is available here -- this file's own comment above says
# "books/<slug>" and must not fail itself.
# --- The Desk path resolves; it is never composed (PLAN-multi-desk.md step 29) --------------------
#
# NECESSARY AND NOT SUFFICIENT, and saying so is the point. This proves the two literals disappeared
# from every file but the schema. It does NOT prove that every consumer resolves the same SEAT --
# only the two-seat acceptance test does that, and a green run here with a red run there is exactly
# the half-migrated state Release 2 refuses to ship: a Book open for reading and closed for
# searching.
#
# WHAT STOPS 19 SITES REGROWING INTO 25. That is the number this release migrated, and the count only
# became knowable after the fact: an earlier scan for `'.open-books'` MISSED the combined form
# `'.claude/.open-books'` and missed `".claude\.$Name"` entirely, so the first estimate of the work
# was wrong in the safe direction by luck rather than by design.
#
# MATCHED ON EXACT VALUE, NOT ON CONTAINMENT. A refusal that says "Virtual Desk configuration is
# missing .open-books." mentions the filename and composes nothing, and flagging it would train the
# next author to stop naming the file in the message a reader has to act on. So a string is an
# offender only when it IS the filename, or IS a path ending in it -- which is what composition
# looks like and what prose never does.
Invoke-Check 'desk.seat-paths-resolve' {
    $schemaFile = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'BookRootSchema.ps1')).Path
    $roots = @('tools', '.claude') | ForEach-Object { Join-Path $workspace $_ }
    $sources = @($roots | Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.ps1' -Recurse -File -ErrorAction SilentlyContinue })

    $offenders = [Collections.Generic.List[string]]::new()
    $scanned = 0
    foreach ($source in $sources) {
        if ($source.FullName -ceq $schemaFile) { continue }
        $scanned++
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($source.FullName), [ref]$null, [ref]$parseErrors)
        if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) { throw "$($source.Name) does not parse; the Desk-path check cannot read it." }
        # Through the AST, so a literal inside a comment or a here-string of documentation is not a
        # composition. The same reason hub.briefing-regex-mirror compares ASTs rather than text.
        $literals = @($ast.FindAll({ $args[0] -is [Management.Automation.Language.StringConstantExpressionAst] }, $true) |
            ForEach-Object { [string]$_.Value })
        foreach ($literal in $literals) {
            if ($literal -cmatch '^(?:.*[\\/])?\.open-(?:books|projects)$') {
                [void]$offenders.Add("$($source.Name) composes '$literal'; resolve it with Get-DeskFilePath or Get-DeskFileInDirectory")
                break
            }
        }
    }
    if ($offenders.Count) { throw ($offenders -join '; ') }

    # AND THE SCHEMA MUST STILL BE THE PLACE THEY LIVE. A check that only ever says "not here" passes
    # perfectly on the day someone deletes the definition and every caller starts composing again.
    $schemaLiterals = @([Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($schemaFile), [ref]$null, [ref]$null).
        FindAll({ $args[0] -is [Management.Automation.Language.StringConstantExpressionAst] }, $true) |
        ForEach-Object { [string]$_.Value } | Where-Object { $_ -cmatch '^\.open-(?:books|projects)$' })
    if (@($schemaLiterals | Sort-Object -Unique).Count -ne 2) {
        throw "BookRootSchema.ps1 no longer spells both Desk filenames; it holds $(@($schemaLiterals | Sort-Object -Unique).Count) of 2."
    }
    "$scanned source(s) scanned; the Desk filenames are spelled only in BookRootSchema.ps1"
}

# --- The claim requirement is the declared set, and nothing else (2026-09-08) ---------------------
#
# WHY THIS EXISTS. Three documents said "every seat-aware mutator requires a matching live claim",
# and Start-LibrarySeat.ps1's help named editing a Hub as something the launcher was needed for.
# Nine helpers take a -Seat and mutate; five call Assert-SeatClaimHeld. The four absentees are
# deliberate -- Get-ClaimGatedHelpers records which and why -- but nothing in the repository said so,
# and nothing could have caught it: docs.links-resolve proves prose is REACHABLE, never that it is
# TRUE. Every one of those false sentences was perfectly well linked.
#
# READ FROM THE DECLARATION, NEVER RESTATED HERE, for the reason desk.lock-order already records: a
# second copy is how the check and the code come to disagree about the one thing the check exists to
# be right about.
#
# WHAT IT CATCHES, IN BOTH DIRECTIONS, and both are real failure modes rather than symmetry for its
# own sake. A declared helper that STOPS calling the assertion is a claim gate silently removed, so
# an unclaimed session could compile or move a Desk and reset would then quarantine live work. An
# undeclared helper that STARTS calling it is a decision made without one: it makes the launcher
# mandatory for something new, which is a reader-facing change, and it would leave every document
# describing the set wrong again.
#
# WHAT IT CANNOT SEE, stated rather than implied. It matches the call by name through the AST, so it
# proves the assertion is INVOKED, not that it is reached on every path or that its result is
# honoured -- Assert-SeatClaimHeld throws rather than returning a value a caller could ignore, and
# the two-seat acceptance suite is what exercises the behaviour. Test runners are excluded on
# purpose: Test-TwoSeatAcceptance.ps1 calls the assertion directly to falsify it, which is the suite
# working, not a helper acquiring a gate.
Invoke-Check 'desk.claim-coverage' {
    $seatFile = Join-Path $PSScriptRoot 'LibrarySeat.ps1'
    if (-not (Test-Path -LiteralPath $seatFile -PathType Leaf)) { throw 'tools/LibrarySeat.ps1 is missing; the claim-gated set has no declaration.' }
    . $seatFile
    $declared = @(Get-ClaimGatedHelpers)
    if ($declared.Count -lt 1) { throw 'Get-ClaimGatedHelpers declares no helper; the claim gate would be unenforced and this check would pass vacuously.' }

    $declaringFile = (Resolve-Path -LiteralPath $seatFile).Path
    $roots = @('tools', '.claude') | ForEach-Object { Join-Path $workspace $_ }
    $sources = @($roots | Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.ps1' -Recurse -File -ErrorAction SilentlyContinue })

    $observed = [Collections.Generic.List[string]]::new()
    $scanned = 0
    foreach ($source in $sources) {
        # The declaring file defines the function and documents the set; a test runner falsifies it.
        if ($source.FullName -ceq $declaringFile) { continue }
        if ($source.Name -cmatch '^Test-') { continue }
        $scanned++
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($source.FullName), [ref]$null, [ref]$parseErrors)
        if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) { throw "$($source.Name) does not parse; the claim-coverage check cannot read it." }
        # Through the AST, so the function name inside a comment or a doc here-string is not a call.
        # This file's own comment block above names it, and must not count itself.
        $calls = @($ast.FindAll({ $args[0] -is [Management.Automation.Language.CommandAst] }, $true) |
            Where-Object { [string]$_.GetCommandName() -ceq 'Assert-SeatClaimHeld' })
        if (@($calls).Count -gt 0) { [void]$observed.Add($source.Name) }
    }

    $declaredSet = @($declared | Sort-Object -Unique)
    $observedSet = @($observed | Sort-Object -Unique)
    $missing = @($declaredSet | Where-Object { $observedSet -cnotcontains $_ })
    $extra = @($observedSet | Where-Object { $declaredSet -cnotcontains $_ })

    $problems = [Collections.Generic.List[string]]::new()
    foreach ($name in $missing) {
        [void]$problems.Add("$name is declared claim-gated but never calls Assert-SeatClaimHeld; an unclaimed session could change what reset judges")
    }
    foreach ($name in $extra) {
        [void]$problems.Add("$name calls Assert-SeatClaimHeld but is not declared in Get-ClaimGatedHelpers; add it there and correct docs/seats.md, or drop the call")
    }
    if ($problems.Count) { throw ($problems -join '; ') }

    "$scanned source(s) scanned; the $($declaredSet.Count) declared helper(s) are exactly those requiring a live claim"
}

# --- The maintenance barrier is wired where its coverage is DERIVED (2026-09-19) -------------------
#
# WHY THIS EXISTS. PLAN-public-release.md step 6 requires that every claim-gated mutator and both
# seat launchers refuse while a cutover is in progress. Nine helpers and two launchers is eleven
# places a guard could be added and one place it could be forgotten, so it is not written eleven
# times: Assert-SeatClaimHeld is the single door the declared set already passes through --
# desk.claim-coverage above proves that, in both directions -- and the barrier is enforced there.
# The launchers are separate because they are NOT in that set: they are what ACQUIRES the claim, so
# the assertion inside it never runs for them.
#
# THAT DERIVATION IS THE THING THAT CAN SILENTLY BREAK. Delete one line from Assert-SeatClaimHeld
# and eleven refusals disappear at once, with every existing test still green -- the claim gate
# itself is untouched and nothing else reads the barrier. So the wiring is asserted here.
#
# WHAT IT CANNOT SEE, stated rather than implied. It matches calls by name through the AST, so it
# proves the guard is INVOKED, not that it is reached on every path. maintenance.folder-move is the
# behavioural half: it raises a real barrier and drives Set-VirtualDesk and both launchers against
# it, with the same calls succeeding without one as the positive control.
#
# AND IT PINS WHO MAY RAISE ONE, BOTH WAYS. A second engager would be a second authority over when
# the Library is stopped, and a mover that stopped raising one would leave every refusal above
# guarding a marker nothing writes.
Invoke-Check 'maintenance.barrier-coverage' {
    $seatFile = Join-Path $PSScriptRoot 'LibrarySeat.ps1'
    $barrierFile = Join-Path $PSScriptRoot 'MaintenanceBarrier.ps1'
    foreach ($required in @($seatFile, $barrierFile)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "$required is missing; the maintenance barrier has no definition." }
    }

    function Get-Ast([string]$Path) {
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($Path), [ref]$null, [ref]$parseErrors)
        if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) { throw "$(Split-Path -Leaf $Path) does not parse; the barrier-coverage check cannot read it." }
        $ast
    }
    function Get-CallsTo([object]$Ast, [string]$Name) {
        @($Ast.FindAll({ $args[0] -is [Management.Automation.Language.CommandAst] }, $true) |
            Where-Object { [string]$_.GetCommandName() -ceq $Name })
    }

    $problems = [Collections.Generic.List[string]]::new()

    # 1. THE DERIVATION. Assert-SeatClaimHeld's own body, not the file: a call somewhere else in
    #    LibrarySeat.ps1 would pass a file-wide search and guard nothing the declared set reaches.
    $seatAst = Get-Ast $seatFile
    $assertion = @($seatAst.FindAll({
        $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] -and
        [string]$args[0].Name -ceq 'Assert-SeatClaimHeld'
    }, $true))
    if (@($assertion).Count -ne 1) { throw "LibrarySeat.ps1 defines Assert-SeatClaimHeld $(@($assertion).Count) time(s); the barrier's coverage cannot be derived from it." }
    if (@(Get-CallsTo $assertion[0] 'Assert-NoMaintenanceBarrier').Count -lt 1) {
        [void]$problems.Add('Assert-SeatClaimHeld does not call Assert-NoMaintenanceBarrier, so every claim-gated mutator would run during a cutover and a verified copy would go stale under it')
    }
    # The set it stands for must be non-empty, or the sentence above is true of nothing.
    . $seatFile
    if (@(Get-ClaimGatedHelpers).Count -lt 1) { throw 'Get-ClaimGatedHelpers declares no helper, so this check would pass vacuously.' }

    # 2. THE TWO ENTRY ROUTES, each in its own script body rather than inside a function: a guard
    #    reached only from a helper nothing calls is not a guard.
    foreach ($launcher in @('Start-LibrarySeat.ps1', 'Enter-LibrarySeat.ps1')) {
        $launcherPath = Join-Path $PSScriptRoot $launcher
        if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { throw "$launcher is missing; the seat entry routes cannot be checked." }
        $calls = @(Get-CallsTo (Get-Ast $launcherPath) 'Assert-NoMaintenanceBarrier' |
            Where-Object {
                $inFunction = $false
                $node = $_.Parent
                while ($null -ne $node) {
                    if ($node -is [Management.Automation.Language.FunctionDefinitionAst]) { $inFunction = $true; break }
                    $node = $node.Parent
                }
                -not $inFunction
            })
        if ($calls.Count -lt 1) {
            [void]$problems.Add("$launcher does not call Assert-NoMaintenanceBarrier in its script body; a new claim could be taken in the middle of a cutover, which is the one thing the barrier exists to prevent")
        }
    }

    # 3. WHO RAISES AND LOWERS ONE, DERIVED FROM THE CODE AND COMPARED IN BOTH DIRECTIONS.
    $declaringFile = (Resolve-Path -LiteralPath $barrierFile).Path
    $roots = @('tools', '.claude') | ForEach-Object { Join-Path $workspace $_ }
    $sources = @($roots | Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.ps1' -Recurse -File -ErrorAction SilentlyContinue })
    #    THE TWO VERBS ARE COUNTED APART, and the reason is a falsification that got through when
    #    they were one set: deleting the mover's New-MaintenanceBarrier left its Remove calls
    #    standing, so 'raises or lowers' was still true of it and a cutover that stopped stopping
    #    the Library passed clean. An OR over two capabilities reports on neither.
    $raisers = [Collections.Generic.List[string]]::new()
    $lowerers = [Collections.Generic.List[string]]::new()
    $spellers = [Collections.Generic.List[string]]::new()
    $scanned = 0
    foreach ($source in $sources) {
        if ($source.FullName -ceq $declaringFile) { continue }
        # A suite raises and lowers barriers to falsify the guards, which is the suite working.
        if ($source.Name -cmatch '^Test-') { continue }
        $scanned++
        $ast = Get-Ast $source.FullName
        if (@(Get-CallsTo $ast 'New-MaintenanceBarrier').Count -gt 0) { [void]$raisers.Add($source.Name) }
        if (@(Get-CallsTo $ast 'Remove-MaintenanceBarrier').Count -gt 0) { [void]$lowerers.Add($source.Name) }
        # THE MARKER IS SPELLED IN ONE PLACE. A guard reading a different filename from the one the
        # writer writes passes every test and protects nothing.
        $literals = @($ast.FindAll({ $args[0] -is [Management.Automation.Language.StringConstantExpressionAst] }, $true) |
            ForEach-Object { [string]$_.Value } | Where-Object { $_ -cmatch 'maintenance-barrier\.json' })
        if (@($literals).Count -gt 0) { [void]$spellers.Add($source.Name) }
    }
    $expected = @('Move-LibraryFolder.ps1')
    $raiserSet = @(@($raisers) | Sort-Object -Unique)
    $lowererSet = @(@($lowerers) | Sort-Object -Unique)
    foreach ($pair in @(
        [pscustomobject]@{ verb = 'raises'; observed = $raiserSet; consequence = 'so every refusal that reads a barrier is guarding a marker nothing writes' },
        [pscustomobject]@{ verb = 'lowers'; observed = $lowererSet; consequence = 'so a completed cutover would leave the Library stopped with no route back' }
    )) {
        foreach ($name in @($expected | Where-Object { @($pair.observed) -cnotcontains $_ })) {
            [void]$problems.Add("$name no longer $($pair.verb) a maintenance barrier, $($pair.consequence)")
        }
        foreach ($name in @(@($pair.observed) | Where-Object { $expected -cnotcontains $_ })) {
            [void]$problems.Add("$name $($pair.verb) a maintenance barrier and is not the cutover helper; one cutover protocol owns the barrier, or 'the Library is stopped' stops meaning one thing")
        }
    }
    if (@($spellers).Count -gt 0) {
        [void]$problems.Add("the barrier's filename is spelled outside MaintenanceBarrier.ps1, in $(@($spellers) -join ', '); a guard reading a second spelling would protect nothing")
    }

    if ($problems.Count) { throw ($problems -join '; ') }
    "$scanned source(s) scanned; the claim gate and both seat entry routes refuse on the barrier, and $($raiserSet -join ', ') is the only helper that raises one and lowers it"
}

# --- The registry lock covers every cross-seat Desk scan ------------------------------------------
#
# THE CHECK desk.lock-order COULD NOT BE. That one flags an inversion between two acquisitions and
# is blind to an ABSENCE, so on 2026-09-09 it passed clean while four of the eight helpers
# `docs/seats.md` named as taking the registry lock took none: Rename, Archive and Remove scanned
# every seat's Desk against a snapshot a concurrent Set-VirtualDesk Open could invalidate, and Reset
# read seat liveness and wrote Desk files the same way. Set-VirtualDesk holds only that lock, so the
# Book locks those helpers did take excluded nothing relevant. Eleven confirmed findings sat behind a
# green gate, and the reason was that the contract lived in prose -- asserted four times in one
# document and wrong all four times.
#
# SO THE RULE IS DERIVED FROM THE CODE AND COMPARED, the way desk.claim-coverage does for the claim.
# Three parts, because no one of them is enforcement:
#
#   1. Each declared function actually calls Assert-SeatRegistryLockHeld in its OWN body. Deleting
#      the assertion is the cheapest way to reintroduce the whole family.
#   2. Every source that calls one of those functions also calls Enter-SeatRegistryLock, and the set
#      of such sources equals the declared set BOTH WAYS. A missing lock and an undeclared new
#      caller are different faults and only the first is loud.
#   3. A LIVE FIXTURE RUN: the same call refused without the lock and answered with it. Parts 1 and 2
#      are static and would both pass against an assertion that had been reduced to `return $true`.
#
# WHAT IT CANNOT SEE, stated rather than implied. Part 2 matches by file, so it proves the lock is
# taken SOMEWHERE in the same source, not that it is held at the moment of the call -- that is what
# part 3's runtime assertion enforces at every call site, in production as in the fixture. And it
# cannot follow a call graph; a wrapper in a third file would defeat part 2 and still be refused at
# runtime by part 3's mechanism.
Invoke-Check 'desk.registry-lock-coverage' {
    $seatFile = Join-Path $PSScriptRoot 'LibrarySeat.ps1'
    if (-not (Test-Path -LiteralPath $seatFile -PathType Leaf)) { throw 'tools/LibrarySeat.ps1 is missing; the registry-lock contract has no declaration.' }
    . $seatFile
    $guarded = @(Get-RegistryLockedFunctions)
    $declared = @(Get-RegistryLockedHelpers)
    if ($guarded.Count -lt 1) { throw 'Get-RegistryLockedFunctions declares no function; this check would pass vacuously.' }
    if ($declared.Count -lt 1) { throw 'Get-RegistryLockedHelpers declares no helper; this check would pass vacuously.' }

    $problems = [Collections.Generic.List[string]]::new()
    $declaringFile = (Resolve-Path -LiteralPath $seatFile).Path
    $roots = @('tools', '.claude') | ForEach-Object { Join-Path $workspace $_ }
    $sources = @($roots | Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.ps1' -Recurse -File -ErrorAction SilentlyContinue })

    # --- 1. every guarded function asserts, in its own body ---------------------------------------
    # Found by SCANNING for the definition rather than by looking in LibrarySeat.ps1, because
    # Get-NotebookResetTargets is guarded and lives in NotebookOwnership.ps1. A guarded name whose
    # definition cannot be found anywhere is itself a failure: a stale declaration is exactly what
    # this check exists to stop.
    $definitions = @{}
    foreach ($source in $sources) {
        $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($source.FullName), [ref]$null, [ref]$null)
        foreach ($fn in @($ast.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] }, $true))) {
            if ($fn.Name -cin $guarded) { $definitions[$fn.Name] = [pscustomobject]@{ file = $source.Name; ast = $fn } }
        }
    }
    foreach ($name in $guarded) {
        if (-not $definitions.ContainsKey($name)) {
            [void]$problems.Add("$name is declared registry-locked but no source under tools/ or .claude/ defines it")
            continue
        }
        $asserts = @($definitions[$name].ast.Body.FindAll({
            $args[0] -is [Management.Automation.Language.CommandAst] -and
            ([string]$args[0].GetCommandName()) -ceq 'Assert-SeatRegistryLockHeld'
        }, $true))
        if (@($asserts).Count -lt 1) {
            [void]$problems.Add("$($definitions[$name].file)'s $name does not call Assert-SeatRegistryLockHeld, so it would answer a cross-seat question against a snapshot another seat can invalidate")
        }
    }

    # --- 2. every caller takes the lock, and the declared set is exact -----------------------------
    $observed = [Collections.Generic.List[string]]::new()
    $unlocked = [Collections.Generic.List[string]]::new()
    $scanned = 0
    foreach ($source in $sources) {
        # The declaring file defines them; a test runner drives them directly to falsify the guard,
        # which is the suite working rather than a helper acquiring a cross-seat surface. This gate
        # is excluded for the same reason: part 3 below calls the guarded function twice on purpose,
        # and the first version of this check duly reported the gate as an undeclared cross-seat
        # caller of itself.
        if ($source.FullName -ceq $declaringFile) { continue }
        if ($source.Name -cmatch '^Test-') { continue }
        if ($source.Name -ceq 'Invoke-LibraryChecks.ps1') { continue }
        $scanned++
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($source.FullName), [ref]$null, [ref]$parseErrors)
        if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) { throw "$($source.Name) does not parse; the registry-lock-coverage check cannot read it." }
        $calls = @($ast.FindAll({ $args[0] -is [Management.Automation.Language.CommandAst] }, $true) |
            ForEach-Object { [string]$_.GetCommandName() })
        $usesGuarded = @(@($calls) | Where-Object { $_ -cin $guarded })
        if (@($usesGuarded).Count -lt 1) { continue }
        [void]$observed.Add($source.Name)
        if (@($calls) -cnotcontains 'Enter-SeatRegistryLock') {
            [void]$unlocked.Add("$($source.Name) calls $(@($usesGuarded | Sort-Object -Unique) -join ', ') and never calls Enter-SeatRegistryLock")
        }
    }
    foreach ($line in $unlocked) { [void]$problems.Add($line) }
    $observedSet = @($observed | Sort-Object -Unique)
    $declaredSet = @($declared | Sort-Object -Unique)
    foreach ($name in @($declaredSet | Where-Object { $observedSet -cnotcontains $_ })) {
        [void]$problems.Add("$name is declared as a cross-seat caller but calls none of the registry-locked functions; drop it from Get-RegistryLockedHelpers and correct docs/seats.md, or restore the scan")
    }
    foreach ($name in @($observedSet | Where-Object { $declaredSet -cnotcontains $_ })) {
        [void]$problems.Add("$name performs a cross-seat Desk scan but is not declared in Get-RegistryLockedHelpers; add it there, take the registry lock before the Book lock, and say so in docs/seats.md")
    }

    # --- 3. the assertion is live, not merely present ---------------------------------------------
    # A fixture, because a count cannot prove a detector still matches: parts 1 and 2 both pass
    # against an Assert-SeatRegistryLockHeld body reduced to `return $true`. This runs the real
    # function twice against a throwaway workspace and requires the two answers to differ.
    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('registry-lock-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        New-Item -ItemType Directory -Path (Get-DeskStateDirectory -StateDirectory (Join-Path $fixture '.claude') -Seat 'probe') -Force | Out-Null
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'probe' -Kind 'books') -Text "shelf/probe-book`n" | Out-Null
        $refusal = $null
        try { Get-SeatsHoldingEntry -Workspace $fixture -StateDirectory (Join-Path $fixture '.claude') -Kind 'books' -Entry 'shelf/probe-book' | Out-Null }
        catch { $refusal = [string]$_.Exception.Message }
        if ($null -eq $refusal) { [void]$problems.Add('a cross-seat scan answered with no registry lock held; the assertion is present but inert') }
        elseif ($refusal -cnotlike '*registry/Desk lock*') { [void]$problems.Add("the unlocked cross-seat scan failed for the wrong reason: $refusal") }

        $probeLock = Enter-SeatRegistryLock -Workspace $fixture
        try {
            $holders = @(Get-SeatsHoldingEntry -Workspace $fixture -StateDirectory (Join-Path $fixture '.claude') -Kind 'books' -Entry 'shelf/probe-book')
            if ((@($holders) -join ',') -cne 'probe') { [void]$problems.Add("the locked cross-seat scan answered '$(@($holders) -join ',')' rather than 'probe'; the guard refuses its own callers") }
        }
        finally { Exit-BookLock -Lock $probeLock }
        # And the ledger lets go: a released lock that still read as held would let the next unlocked
        # call through, which is the one failure mode a ledger can invent on its own.
        if (Test-SeatRegistryLockHeld -Workspace $fixture) { [void]$problems.Add('the registry lock still read as held after release; the in-process ledger leaks') }
    }
    finally { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }

    if ($problems.Count) { throw ($problems -join '; ') }
    "$scanned source(s) scanned; $($guarded.Count) function(s) refuse without the registry lock, the $($declaredSet.Count) declared caller(s) are exactly those scanning across seats, and the refusal was falsified against a fixture"
}

# --- A topic's ownership changes only under that topic's lock (ADR-0019) --------------------------
#
# THE RULE THIS HOLDS. Ownership used to be remappable with no topic lock at all, while the reset
# revalidated each move under one -- so a reassignment could land between the revalidation and the
# Directory.Move, and the comment claiming the lock stabilised the answer was simply wrong. Codex
# reported it as check-then-move in the 2026-09-09 seats review; its recommended fix, holding the
# ownership lock through the moves, would have deadlocked against three writers that take that lock
# INSIDE a topic lock. ADR-0019 ruled the other way: the topic lock is the authority, the ownership
# record lock became the last class in the order, and this is the check that keeps it true.
#
# THREE PARTS, BECAUSE NO ONE OF THEM IS ENFORCEMENT -- the shape desk.registry-lock-coverage
# settled on the same day:
#
#   1. Each declared function calls Assert-NotebookTopicLockHeld in its OWN body. Deleting that
#      assertion is the cheapest way to reintroduce the whole family.
#   2. The set of sources calling the two functions that require their CALLER to hold the lock equals
#      the declared set, both ways. A new caller is a new place the rule has to hold, and a
#      disappearing one means the write moved somewhere this check is not looking.
#   3. A LIVE FIXTURE: refused without the lock, answered with it, and a planted FOREIGN owner
#      refused under the lock -- so a verdict that said "writable" to everything fails here rather
#      than passing part 1 with an assertion reduced to `return $true`.
#
# WHY PART 2 DOES NOT ALSO DEMAND THE CALLER TAKE THE LOCK STATICALLY. It cannot tell a caller that
# holds it from one that does not -- Set-NotebookTopicOwner deliberately takes the lock itself when
# its caller has none -- and part 3's assertion answers that question at every call site in
# production, from the lock primitive's own ledger, which is stronger than any file-level scan.
Invoke-Check 'desk.topic-lock-coverage' {
    $ownershipFile = Join-Path $PSScriptRoot 'NotebookOwnership.ps1'
    if (-not (Test-Path -LiteralPath $ownershipFile -PathType Leaf)) { throw 'tools/NotebookOwnership.ps1 is missing; the topic-lock contract has no declaration.' }
    . $ownershipFile
    $guarded = @(Get-TopicLockedFunctions)
    $declared = @(Get-TopicLockedHelpers)
    if ($guarded.Count -lt 1) { throw 'Get-TopicLockedFunctions declares no function; this check would pass vacuously.' }
    if ($declared.Count -lt 1) { throw 'Get-TopicLockedHelpers declares no helper; this check would pass vacuously.' }

    $problems = [Collections.Generic.List[string]]::new()
    $declaringFile = (Resolve-Path -LiteralPath $ownershipFile).Path
    $roots = @('tools', '.claude') | ForEach-Object { Join-Path $workspace $_ }
    $sources = @($roots | Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.ps1' -Recurse -File -ErrorAction SilentlyContinue })

    # --- 1. every guarded function asserts, in its own body ---------------------------------------
    $definitions = @{}
    foreach ($source in $sources) {
        $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($source.FullName), [ref]$null, [ref]$null)
        foreach ($fn in @($ast.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] }, $true))) {
            if ($fn.Name -cin $guarded) { $definitions[$fn.Name] = [pscustomobject]@{ file = $source.Name; ast = $fn } }
        }
    }
    foreach ($name in $guarded) {
        if (-not $definitions.ContainsKey($name)) {
            [void]$problems.Add("$name is declared topic-locked but no source under tools/ or .claude/ defines it")
            continue
        }
        $asserts = @($definitions[$name].ast.Body.FindAll({
            $args[0] -is [Management.Automation.Language.CommandAst] -and
            ([string]$args[0].GetCommandName()) -ceq 'Assert-NotebookTopicLockHeld'
        }, $true))
        if (@($asserts).Count -lt 1) {
            [void]$problems.Add("$($definitions[$name].file)'s $name does not call Assert-NotebookTopicLockHeld, so it would act on an ownership answer another writer can invalidate first")
        }
    }

    # --- 2. the callers that must hold the lock are exactly the declared ones ----------------------
    # DERIVED FROM THE DECLARATION WITH ONE NAMED EXCEPTION, rather than retyped. Set-NotebookTopicOwner
    # is not in this set on purpose: it takes the lock itself when the caller has none, so calling it
    # is not a claim to be holding one. Every OTHER guarded function is caller-facing by definition --
    # it refuses a caller that does not hold the lock -- so listing them separately was a second copy
    # of Get-TopicLockedFunctions, and a function added there and forgotten here would have been
    # guarded in part 1 and invisible to part 2 (2026-09-10, when the two recovery routes were added).
    $selfLocking = @('Set-NotebookTopicOwner')
    $callerFacing = @(@($guarded) | Where-Object { $selfLocking -cnotcontains $_ })
    if (-not $callerFacing.Count) { throw 'every topic-locked function is declared self-locking; part 2 would observe nothing and pass vacuously.' }
    $observed = [Collections.Generic.List[string]]::new()
    $scanned = 0
    foreach ($source in $sources) {
        if ($source.FullName -ceq $declaringFile) { continue }
        if ($source.Name -cmatch '^Test-') { continue }
        if ($source.Name -ceq 'Invoke-LibraryChecks.ps1') { continue }
        $scanned++
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($source.FullName), [ref]$null, [ref]$parseErrors)
        if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) { throw "$($source.Name) does not parse; the topic-lock-coverage check cannot read it." }
        $calls = @($ast.FindAll({ $args[0] -is [Management.Automation.Language.CommandAst] }, $true) |
            ForEach-Object { [string]$_.GetCommandName() })
        if (@(@($calls) | Where-Object { $_ -cin $callerFacing }).Count -ge 1) { [void]$observed.Add($source.Name) }
    }
    $observedSet = @($observed | Sort-Object -Unique)
    $declaredSet = @($declared | Sort-Object -Unique)
    foreach ($name in @($declaredSet | Where-Object { $observedSet -cnotcontains $_ })) {
        [void]$problems.Add("$name is declared as a Notebook writer that checks topic ownership and calls none of $($callerFacing -join ', '); restore the check, or drop it from Get-TopicLockedHelpers and correct docs/seats.md")
    }
    foreach ($name in @($observedSet | Where-Object { $declaredSet -cnotcontains $_ })) {
        [void]$problems.Add("$name acts on a Notebook topic's ownership but is not declared in Get-TopicLockedHelpers; add it there, hold the topic lock across the check and the write, and say so in docs/seats.md")
    }

    # --- 3. the assertion is live, and the verdict is not vacuously permissive --------------------
    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('topic-lock-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/probe') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $fixture 'internal') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $fixture 'notebook/probe/_index.md'), "# probe`n", [Text.UTF8Encoding]::new($false))
        # THE DECOY: the topic is owned by a seat that is NOT the one asking. An implementation that
        # answered "writable" to everything passes an absence-based check and fails this one.
        Set-NotebookTopicOwner -Workspace $fixture -Topic 'probe' -Seat 'decoy-seat'

        $refusal = $null
        try { Assert-NotebookTopicWritable -Workspace $fixture -Topic 'probe' -Seat 'decoy-seat' | Out-Null }
        catch { $refusal = [string]$_.Exception.Message }
        if ($null -eq $refusal) { [void]$problems.Add('an ownership check answered with no topic lock held; the assertion is present but inert') }
        elseif ($refusal -cnotlike '*lock for notebook/probe*') { [void]$problems.Add("the unlocked ownership check failed for the wrong reason: $refusal") }

        $probeLock = Enter-BookLock -Workspace $fixture -BookRoot (Get-NotebookTopicLockRoot 'probe')
        try {
            if (-not (Assert-NotebookTopicWritable -Workspace $fixture -Topic 'probe' -Seat 'decoy-seat')) {
                [void]$problems.Add('the owning seat was refused its own topic under the lock; the guard refuses its own callers')
            }
            $foreign = $null
            try { Assert-NotebookTopicWritable -Workspace $fixture -Topic 'probe' -Seat 'other-seat' | Out-Null }
            catch { $foreign = [string]$_.Exception.Message }
            if ($null -eq $foreign) { [void]$problems.Add('A FOREIGN SEAT WAS ALLOWED TO WRITE INTO AN OWNED TOPIC') }
            elseif ($foreign -cnotlike "*seat 'decoy-seat'*") { [void]$problems.Add("the foreign-owner refusal did not name the owner: $foreign") }
        }
        finally { Exit-BookLock -Lock $probeLock }
        if (Test-BookLockHeld -Workspace $fixture -BookRoot (Get-NotebookTopicLockRoot 'probe')) {
            [void]$problems.Add('the topic lock still read as held after release; the in-process ledger leaks')
        }
    }
    finally { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }

    if ($problems.Count) { throw ($problems -join '; ') }
    "$scanned source(s) scanned; $($guarded.Count) function(s) refuse without the topic lock, the $($declaredSet.Count) declared writer(s) are exactly those checking topic ownership, and both the refusal and a foreign owner were falsified against a fixture"
}

# --- One total lock order, gate-enforced (PLAN-multi-desk.md step 9a; re-ruled by ADR-0019) -------
#
#     registry/Desk  ->  Book (sorted)  ->  topic (sorted)  ->  render  ->  notebook-topic-owners
#
# The risk this covers is no longer that no order exists -- it is that a future helper acquires out
# of order, and that is the part most likely to be skipped under time pressure.
#
# IT WAS BLIND TO THE WHOLE NOTEBOOK FAMILY UNTIL 2026-09-09, which is how three writers came to
# invert the declared order under a green gate. It read `Enter-BookLock` with a LITERAL -BookRoot and
# nothing else -- so every topic lock ("notebook/$Topic", composed), the owners lock (behind
# Enter-NotebookOwnersLock) and the render lock (behind Invoke-NotebookRender) were all invisible,
# and `desk.lock-order` reported 25 acquisitions while observing not one of the ones that mattered.
# Three things changed: the wrapper functions are read from Get-SeatLockAcquiringFunctions, a
# composed root is classified by the literal prefix it starts with, and a root produced by
# Get-NotebookTopicLockRoot or Get-NotebookRenderLockRoot is classified by that call.
#
# AND IT NOW REFUSES TO PASS VACUOUSLY. Every class in the declared order must be observed somewhere,
# derived from the order itself rather than from a typed count -- so a classifier that silently stops
# recognising a class fails here instead of reporting a clean order it can no longer see.
#
# WHAT IT CAN AND CANNOT SEE, stated rather than implied. It reads the order acquisitions are WRITTEN
# in each function or script, which catches the inversion a reader would introduce by adding a second
# lock above an existing one. It cannot see a lock taken inside a function called from between two
# others -- beyond the declared wrappers -- and it does not model RELEASES, so two locks taken and
# released one after the other read as nested. That last limitation is why test runners are excluded:
# a suite takes and releases locks case by case, in whatever order each case needs, and reading that
# as nesting reports an inversion that does not exist. The runtime assertions are what enforce the
# contract at the moment of the call -- Assert-SeatRegistryLockHeld for the registry lock and
# Assert-NotebookTopicLockHeld for a topic's -- and this check is what keeps the written order honest.
Invoke-Check 'desk.lock-order' {
    $seatFile = Join-Path $PSScriptRoot 'LibrarySeat.ps1'
    if (-not (Test-Path -LiteralPath $seatFile -PathType Leaf)) { throw 'tools/LibrarySeat.ps1 is missing; the lock order has no definition.' }
    # The order is read from the one file that declares it, never restated here -- a second copy is
    # how the check and the code come to disagree about the thing the check exists to enforce.
    . $seatFile
    $order = @(Get-SeatLockOrder)
    if ($order.Count -ne 5) { throw "the declared lock order has $($order.Count) classes, expected 5." }
    $rank = @{}
    for ($i = 0; $i -lt $order.Count; $i++) { $rank[$order[$i]] = $i }

    # The wrapper functions, read from the declaration rather than restated -- same rule as the order
    # itself. A caller's line that says Invoke-NotebookRender IS a render acquisition.
    $wrappers = @{}
    foreach ($row in @(Get-SeatLockAcquiringFunctions)) { $wrappers[[string]$row.function] = [string]$row.class }
    if (-not $wrappers.Count) { throw 'Get-SeatLockAcquiringFunctions declares no wrapper; every composed acquisition would be invisible and this check would pass vacuously.' }
    foreach ($declaredClass in @($wrappers.Values | Sort-Object -Unique)) {
        if ($declaredClass -cnotin $order) { throw "Get-SeatLockAcquiringFunctions names class '$declaredClass', which is not in the declared lock order." }
    }
    # A root PRODUCED by a call rather than written as a string. Both are single-purpose composers of
    # one lock name, so the call site names its class as plainly as a literal would.
    $rootComposers = @{ 'Get-NotebookTopicLockRoot' = 'topic'; 'Get-NotebookRenderLockRoot' = 'render' }

    function Get-LockClass([string]$Root) {
        if ([string]::IsNullOrWhiteSpace($Root)) { return $null }
        $value = $Root.Trim().ToLowerInvariant()
        if ($value -cmatch '^registry/') { return 'registry' }
        if ($value -cmatch '^render/') { return 'render' }
        if ($value -cmatch 'notebook-topic-owners') { return 'notebook-topic-owners' }
        if ($value -cmatch '^notebook/') { return 'topic' }
        # Everything else that takes this primitive is a Book root or another per-subject record,
        # and those sit in the Book class. Tested by MEMBERSHIP on the first segment rather than by an
        # alternation pattern: `'^(books|shelf|...)/'` is the exact shape desk.book-root-schema exists
        # to catch as a second Book-root definition, and it caught this one. It is not a definition --
        # it maps a lock name to its class -- but a checker that has to be told which alternations are
        # innocent is a checker nobody can trust.
        if (($value -split '/')[0] -cin @('books', 'shelf', 'archive', 'internal', 'projects')) { return 'book' }
        return $null
    }

    # ONE CLASSIFIER FOR ONE CALL, so the scan and the fixture below drive the same code. Returns
    # $null for an acquisition that cannot be classified statically -- which is skipped rather than
    # guessed at, because a checker that guesses is confidently wrong about the thing it exists for.
    function Get-CallLockClass($Call) {
        $name = [string]$Call.GetCommandName()
        if ($wrappers.ContainsKey($name)) { return [string]$wrappers[$name] }
        $class = $null
        $elements = @($Call.CommandElements)
        for ($i = 0; $i -lt $elements.Count - 1; $i++) {
            if (-not ($elements[$i] -is [Management.Automation.Language.CommandParameterAst])) { continue }
            if (([string]$elements[$i].ParameterName) -cne 'BookRoot') { continue }
            $argument = $elements[$i + 1]
            if ($argument -is [Management.Automation.Language.StringConstantExpressionAst]) {
                $class = Get-LockClass ([string]$argument.Value)
            }
            elseif ($argument -is [Management.Automation.Language.ExpandableStringExpressionAst]) {
                # `notebook/$Topic` -- the class lives in the literal head, which is exactly the part
                # interpolation leaves alone.
                $class = Get-LockClass ([string]$argument.Value)
            }
            else {
                $inner = @($argument.FindAll({ $args[0] -is [Management.Automation.Language.CommandAst] }, $true) |
                    ForEach-Object { [string]$_.GetCommandName() } | Where-Object { $rootComposers.ContainsKey($_) })
                if (@($inner).Count -ge 1) { $class = [string]$rootComposers[@($inner)[0]] }
            }
        }
        $class
    }

    $roots = @('tools', '.claude') | ForEach-Object { Join-Path $workspace $_ }
    $sources = @($roots | Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.ps1' -Recurse -File -ErrorAction SilentlyContinue })
    $inversions = [Collections.Generic.List[string]]::new()
    $observed = 0
    $seenClasses = [Collections.Generic.HashSet[string]]::new()
    $scanned = 0
    foreach ($source in $sources) {
        # A suite takes and RELEASES locks case by case; this check does not model releases, so a
        # test runner's sequential acquisitions would read as nesting. Excluded for the same reason
        # desk.claim-coverage and desk.registry-lock-coverage exclude them, and the gate itself.
        if ($source.Name -cmatch '^Test-') { continue }
        if ($source.Name -ceq 'Invoke-LibraryChecks.ps1') { continue }
        $scanned++
        $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($source.FullName), [ref]$null, [ref]$null)
        # Each function body, and the script body, is one scope.
        $scopes = @($ast.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] }, $true))
        $scopeList = @(@($scopes | ForEach-Object { [pscustomobject]@{ name = $_.Name; ast = $_.Body } }) +
            [pscustomobject]@{ name = '<script>'; ast = $ast })
        foreach ($scope in $scopeList) {
            $wrapperNames = @($wrappers.Keys)
            $calls = @($scope.ast.FindAll({
                $args[0] -is [Management.Automation.Language.CommandAst] -and
                (([string]$args[0].GetCommandName()) -ceq 'Enter-BookLock' -or ([string]$args[0].GetCommandName()) -cin $wrapperNames)
            }, $false) | Sort-Object { $_.Extent.StartOffset })
            $sequence = [Collections.Generic.List[object]]::new()
            foreach ($call in $calls) {
                $class = Get-CallLockClass $call
                if ($null -eq $class) { continue }
                [void]$sequence.Add([pscustomobject]@{ class = $class; line = $call.Extent.StartLineNumber })
            }
            foreach ($step in $sequence) { [void]$seenClasses.Add([string]$step.class) }
            if ($sequence.Count -lt 2) { continue }
            $observed += $sequence.Count
            for ($i = 1; $i -lt $sequence.Count; $i++) {
                if ($rank[$sequence[$i].class] -lt $rank[$sequence[$i - 1].class]) {
                    [void]$inversions.Add("$($source.Name):$($sequence[$i].line) takes the $($sequence[$i].class) lock after the $($sequence[$i - 1].class) lock, inverting $($order -join ' -> ')")
                }
            }
        }
    }
    if ($inversions.Count) { throw ($inversions -join '; ') }
    # THE VACUITY GUARD, DERIVED FROM THE ORDER rather than from a typed number. A count cannot prove
    # a classifier still recognises anything -- this check reported 25 acquisitions for months while
    # seeing no topic, owners or render lock at all.
    $unseen = @($order | Where-Object { -not $seenClasses.Contains($_) })
    if ($unseen.Count) {
        throw ("no acquisition was observed for the $($unseen -join ', ') lock class(es), so the order is unenforced for " +
               'them. Either the classifier stopped recognising a class, or a class left the code and should leave ' +
               'Get-SeatLockOrder too.')
    }

    # AND THE CLASSIFIER IS PINNED BOTH WAYS AGAINST A FIXTURE, because the per-class guard above
    # cannot see one ROUTE going blind. Measured by doing it: deleting the `^notebook/` prefix rule
    # left four real topic acquisitions invisible and the topic class STILL observed, through
    # Get-NotebookTopicLockRoot. So each recognised form is driven here, and so are the two that must
    # NOT be classified -- an unknown namespace and a bare variable -- which are what stop this check
    # inventing an order for acquisitions it cannot actually read.
    $fixtureSource = @'
function Probe {
    $a = Enter-SeatRegistryLock -Workspace $w
    $b = Enter-BookLock -Workspace $w -BookRoot "notebook/$Topic"
    $c = Enter-BookLock -Workspace $w -BookRoot (Get-NotebookTopicLockRoot 'x')
    $d = Enter-BookLock -Workspace $w -BookRoot 'shelf/demo'
    $e = Enter-BookLock -Workspace $w -BookRoot (Get-NotebookRenderLockRoot)
    $f = Enter-BookLock -Workspace $w -BookRoot 'internal/notebook-topic-owners'
    $g = Enter-NotebookOwnersLock -Workspace $w
    $h = Invoke-NotebookRender -Workspace $w
    $i = Enter-BookLock -Workspace $w -BookRoot "triage/$id"
    $j = Enter-BookLock -Workspace $w -BookRoot $aVariable
}
'@
    $expected = 'registry|topic|topic|book|render|notebook-topic-owners|notebook-topic-owners|render|-|-'
    $fixtureAst = [Management.Automation.Language.Parser]::ParseInput($fixtureSource, [ref]$null, [ref]$null)
    $fixtureCalls = @($fixtureAst.FindAll({
        $args[0] -is [Management.Automation.Language.CommandAst] -and
        (([string]$args[0].GetCommandName()) -ceq 'Enter-BookLock' -or ([string]$args[0].GetCommandName()) -cin @($wrappers.Keys))
    }, $true) | Sort-Object { $_.Extent.StartOffset })
    $actual = @(@($fixtureCalls) | ForEach-Object {
        $class = Get-CallLockClass $_
        if ($null -eq $class) { '-' } else { $class }
    }) -join '|'
    if ($actual -cne $expected) {
        throw "the lock classifier reads its own fixture as '$actual' rather than '$expected'; an acquisition form it used to recognise has gone blind, or one it must not classify is being guessed at"
    }
    "the order is $($order -join ' -> '); $scanned source(s) scanned, $observed classified acquisition(s) in multi-lock scopes, all $($order.Count) class(es) observed, no inversion"
}

Invoke-Check 'desk.book-root-schema' {
    $schemaFile = Join-Path $PSScriptRoot 'BookRootSchema.ps1'
    if (-not (Test-Path -LiteralPath $schemaFile -PathType Leaf)) { throw 'tools/BookRootSchema.ps1 is missing; the Book-root shape has no definition.' }

    $roots = @('tools', '.claude') | ForEach-Object { Join-Path $workspace $_ }
    $sources = @($roots | Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.ps1' -Recurse -File -ErrorAction SilentlyContinue })
    # Every shape that DEFINES which Book roots are well-formed. Anchored alternations only: a
    # composed path like "shelf/$slug/wiki" is not a definition and is not this check's business.
    # `\(?` before the character class, because the first version of this check anchored on the
    # prefix and the class being ADJACENT and a copy spelled '^shelf/([a-z0-9]...' slipped straight
    # past it. A `(?i)` form is deliberately NOT matched: those match a reader-supplied filesystem
    # path case-insensitively on purpose, and are a different rule from Desk state.
    $patterns = @('books\|shelf', 'books\|archive\|shelf', '\^\(\?:books/', '\^\(\?:shelf/',
        '\^books/\(?\[a-z0-9', '\^shelf/\(?\[a-z0-9', '\^archive/\(?\[a-z0-9')
    # The manifest-collection NAMES are the schema's too (ADR-0012). A single name is a use and is
    # fine -- Archive-ShelfBook names 'shelf-archive' because that is where it puts one Book. A LIST
    # of them is a definition, and a second definition is how a fifth collection would end up known
    # to the store and unknown to Discovery. Matched as "both archive names inside one literal array",
    # which no use ever needs.
    $collectionListPattern = "@\([^)]*'shelf-archive'[^)]*'shared-archive'[^)]*\)|@\([^)]*'shared-archive'[^)]*'shelf-archive'[^)]*\)"
    $offenders = [Collections.Generic.List[string]]::new()
    foreach ($source in $sources) {
        if ($source.FullName -ceq (Resolve-Path -LiteralPath $schemaFile).Path) { continue }
        $text = [IO.File]::ReadAllText($source.FullName)
        $text = [regex]::Replace($text, '(?s)<#.*?#>', '')
        $text = [regex]::Replace($text, '(?m)^\s*#.*$', '')
        foreach ($pattern in $patterns) {
            if ([regex]::IsMatch($text, $pattern)) {
                [void]$offenders.Add("$($source.Name) carries its own Book-root pattern ($pattern)")
                break
            }
        }
        if ([regex]::IsMatch($text, $collectionListPattern)) {
            [void]$offenders.Add("$($source.Name) carries its own list of manifest collections; call Get-BookManifestCollections")
        }
    }
    # NOR MAY ANY FILE THAT TURNS A BOOK IDENTITY INTO A PAGE PATH TO FETCH. Composing
    # `books/$Slug/wiki` in one of these reads the ACTIVE Book for a Book that is archived, and the
    # failure is not an error: it is a complete, well-formed answer about the wrong Book. Three files
    # have that job -- the reader adapter, which serves a page from a Desk root, and the two shared
    # helpers, which enumerate and read a Book's pages over MCP. The adapter cannot be caught
    # behaviourally at all (no stub endpoint), and the shared pair is caught behaviourally by
    # shared.manifest-backfill's active-and-archived-twin cases; this static scan is what keeps the
    # composition from coming back into any of them. A mutation sweep found the adapter half firing
    # nothing in its suite; the shared half was a live defect until 2026-09-08.
    $composedSources = @('.claude/adapters/Validated-BookReader.ps1', 'tools/SharedBookSource.ps1', 'tools/Update-SharedBookManifests.ps1')
    foreach ($relative in $composedSources) {
        $composedPath = Join-Path $workspace $relative
        if (-not (Test-Path -LiteralPath $composedPath -PathType Leaf)) { continue }
        $composedText = [IO.File]::ReadAllText($composedPath)
        $composedText = [regex]::Replace($composedText, '(?s)<#.*?#>', '')
        $composedText = [regex]::Replace($composedText, '(?m)^\s*#.*$', '')
        # Assembled from parts rather than written out, so this check does not match ITSELF -- and,
        # more to the point, so it stays honest: a hand-written copy of the alternation anywhere,
        # including in this runner, still fails the scan above.
        #
        # The character class covers `$slug`, `$($parts.slug)` and `${slug}`, because the
        # subexpression form is how a real composition is actually spelled -- an earlier version
        # matched only a bare `$name` and would have let `books/$($entry.slug)/wiki` straight past.
        $composedPattern = '(?:' + (@('books', 'archive', 'shelf') -join '|') + ')/\$[A-Za-z_({]'
        $composed = @([regex]::Matches($composedText, $composedPattern) | ForEach-Object { $_.Value } | Sort-Object -Unique)
        if ($composed.Count) {
            [void]$offenders.Add("$(Split-Path -Leaf $relative) composes a Book page path itself ($(@($composed) -join ', ')); use Split-BookRoot's wiki_root")
        }
    }
    if ($offenders.Count) { throw ($offenders -join '; ') }
    "$($sources.Count) source(s) scanned; the Book-root shape is defined only in BookRootSchema.ps1, and $($composedSources.Count) page-fetching source(s) compose no page path"
}

Invoke-Check 'shelf.references-resolve' {
    $catalogPath = Join-Path $workspace 'shelf/_catalog.md'
    if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw 'shelf/_catalog.md is missing.' }
    $catalog = Get-Content -LiteralPath $catalogPath -Raw

    $known = @{}
    foreach ($section in @([regex]::Matches($catalog, '(?ms)^##\s+(.+?)\s*\r?\n(.*?)(?=^##\s+|\z)'))) {
        $pathLine = [regex]::Match($section.Groups[2].Value, '(?m)^\s*-\s+\*\*Path:\*\*\s+shelf/([a-z0-9][a-z0-9-]*)\s*$')
        if (-not $pathLine.Success) { continue }
        $slug = $pathLine.Groups[1].Value
        if ($known.ContainsKey($slug)) { throw "shelf/_catalog.md lists shelf/$slug more than once" }
        $known[$slug] = [regex]::IsMatch($section.Groups[2].Value, '(?m)^\s*-\s+\*\*Kind:\*\*\s+capture\s*$')
    }
    if (-not $known.Count) { throw 'shelf/_catalog.md lists no Books.' }

    $missing = @($known.Keys | Where-Object { -not (Test-Path -LiteralPath (Join-Path $workspace "shelf/$_/wiki") -PathType Container) })
    if ($missing.Count) { throw "catalog entries with no Book on disk: $(@($missing | Sort-Object) -join ', ')" }

    # Markdown only. PowerShell sources name a Book as "shelf/$Slug", never as a literal path -- the
    # only literal Shelf paths in .ps1 files are self-test fixtures, which are supposed to name Books
    # that do not exist. The helper defaults, which are literal, are checked by AST below instead.
    $sources = @()
    $skills = Join-Path $workspace '.claude/skills'
    if (Test-Path -LiteralPath $skills -PathType Container) {
        $sources += @(Get-ChildItem -LiteralPath $skills -File -Recurse | Where-Object { $_.Extension -eq '.md' })
    }
    $sources += @(@('CLAUDE.md', 'CONTEXT.md') |
        ForEach-Object { Join-Path $workspace $_ } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        ForEach-Object { Get-Item -LiteralPath $_ })

    $stale = [Collections.Generic.List[string]]::new()
    foreach ($file in $sources) {
        $text = [IO.File]::ReadAllText($file.FullName)
        foreach ($hit in @([regex]::Matches($text, 'shelf/([a-z0-9][a-z0-9-]*)'))) {
            $slug = $hit.Groups[1].Value
            if ($known.ContainsKey($slug)) { continue }
            [void]$stale.Add("$($file.Name) names shelf/$slug, which is not in the Shelf catalog")
        }
    }

    # A capture helper whose default destination does not exist is the same defect one layer down,
    # and its slug is bare rather than a path, so the scan above cannot see it.
    foreach ($helper in @('Add-ShelfNote.ps1', 'Invoke-LibraryTriage.ps1')) {
        $helperPath = Join-Path $PSScriptRoot $helper
        if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) { continue }
        $helperAst = [System.Management.Automation.Language.Parser]::ParseFile($helperPath, [ref]$null, [ref]$null)
        $bookSlug = @($helperAst.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -ceq 'BookSlug' })
        if (-not $bookSlug.Count) { continue }
        $default = $bookSlug[0].DefaultValue
        if ($default -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { continue }
        $slug = [string]$default.Value
        if (-not $known.ContainsKey($slug)) { [void]$stale.Add("$helper defaults to -BookSlug '$slug', which is not in the Shelf catalog") }
        elseif (-not $known[$slug]) { [void]$stale.Add("$helper defaults to -BookSlug '$slug', which is not capture-enabled") }
    }

    if ($stale.Count) { throw ($stale -join '; ') }
    "$($known.Count) Books catalogued, $($sources.Count) sources reference only Books that exist"
}

# --- How a seat resolves, and what each state permits (ADR-0018, PLAN-seat-launch.md step 16) ------
#
# WHY THIS EXISTS. A seat now binds to the running agent PROCESS, and `LIBRARY_SEAT` became a
# convenience that must AGREE with the binding rather than an authority of its own. Every part of
# that is invisible to every other check: `desk.seat-paths-resolve` proves the Desk FILENAMES are
# composed in one place, which was true on the day a resolver that ignored bindings would have sent
# four consumers to another seat's Desk with every literal still in the right file.
#
# FOUR PARTS, AND THE FIRST TWO ARE THE ONES THAT COULD PASS VACUOUSLY ALONE.
#
#   1. A LIVE FIXTURE over the REAL resolver: each of the three sources answers, in order, and the
#      `source` field says which. An implementation that quietly dropped the binding route would
#      still answer `named` from the environment for every call -- so `binding` must be OBSERVED,
#      not merely permitted.
#   2. THE DISAGREEMENT IS A REFUSAL naming both, over the same fixture. Deleting that branch leaves
#      a resolver that answers, which is the failure mode with no symptom.
#   3. THE MATRIX IS TOTAL AND ITS INVARIANTS HOLD, read from Get-SeatStateMatrix rather than
#      restated: every combination is ruled, and the properties ADR-0018 rests on -- a foreign agent
#      is refused everywhere, a mutator needs a HELD claim at its own seat, retirement needs an idle
#      seat -- are asserted as properties over the declared table. A copy of the rows here would be
#      the second authority `desk.lock-order` already records the cost of.
#   4. EVERY CALL SITE PASSES THE STATE DIRECTORY. This is the drift guard, and it is the one that
#      makes the other three durable: the resolver cannot read a binding without it, and a caller
#      that omits it gets environment-only resolution with no error and no symptom until two
#      consumers of one session disagree about which Desk they are on.
#
# WHAT IT CANNOT SEE, stated rather than implied. Part 4 proves the argument is PASSED, not that the
# value is the right directory -- a caller handing over the wrong `.claude` resolves a real seat from
# the wrong tree, and only the two-seat acceptance suite exercises that. Test runners are excluded
# from part 4 for the reason desk.claim-coverage excludes them: a suite calls the resolver WITHOUT a
# state directory on purpose, to prove that refusal exists.
Invoke-Check 'seat.resolution-contract' {
    $seatFile = Join-Path $PSScriptRoot 'LibrarySeat.ps1'
    if (-not (Test-Path -LiteralPath $seatFile -PathType Leaf)) { throw 'tools/LibrarySeat.ps1 is missing; the seat state matrix has no declaration.' }
    . $seatFile

    # --- 1 and 2. THE RESOLUTION ORDER, OVER A LIVE FIXTURE ---------------------------------------
    # THIS PROCESS STANDS IN FOR THE AGENT. The rule under test is "the process this binding names is
    # still that process", and $PID is a process that genuinely exists with a readable start time --
    # which a fabricated number is not, and a fabricated number would let every assertion below pass
    # against a resolver that never compared anything.
    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('seat-resolution-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $fixtureState = Join-Path $fixture '.claude'
    $callerSeat = $env:LIBRARY_SEAT
    $observed = [Collections.Generic.List[string]]::new()
    $problems = [Collections.Generic.List[string]]::new()
    try {
        New-Item -ItemType Directory -Path $fixtureState -Force | Out-Null
        Initialize-SeatForFixture -StateDirectory $fixtureState -Seat 'alpha' -Project 'alpha-proj' | Out-Null
        Initialize-SeatForFixture -StateDirectory $fixtureState -Seat 'beta' -Project 'beta-proj' | Out-Null
        $agentIdentity = Get-AgentProcessIdentity -ProcessId $PID
        if ([string]::IsNullOrWhiteSpace($agentIdentity) -or $agentIdentity -ceq 'unreadable') {
            throw 'this process has no readable start time, so the binding route below would pass without comparing identities.'
        }

        # --- 1a. THE TWO REFUSALS DIFFER, AND THE NEGATIVE IS THE LOAD-BEARING HALF (2026-09-18) --
        #
        # A HELPER WHOSE OWN `-Seat` MEANS SOMETHING ELSE MUST NOT BE TOLD TO PASS `-Seat`. The
        # reader hit that circle live on 2026-09-15 running Set-NotebookTopicOwner.ps1, whose
        # `-Seat` names the topic's assignee. What decays here is not the new wording but the
        # OTHER one: a later edit that "simplifies" the two branches into one puts the circle back,
        # and a check pinning only the acting-seat message would stay green through it. So the
        # ordinary remedy is asserted just as hard, and the two are compared.
        #
        # THE `unset` ROUTE IS REACHED HERE, BEFORE ANY BINDING EXISTS, because once this process
        # is bound the resolver answers instead of refusing.
        $env:LIBRARY_SEAT = ''
        $means = "the topic's assignee"
        $ordinaryUnset = [string](Resolve-SeatName -StateDirectory $fixtureState -AgentProcessId $PID).message
        $actingUnset = [string](Resolve-SeatName -StateDirectory $fixtureState -AgentProcessId $PID `
            -ActingSeatOnly -SeatArgumentMeans $means).message
        if ($ordinaryUnset -cnotmatch 'pass -Seat explicitly') {
            [void]$problems.Add("the ORDINARY seatless refusal stopped offering -Seat, which is the remedy a caller whose -Seat IS the acting seat depends on: $ordinaryUnset")
        }
        if ($actingUnset -cmatch 'pass -Seat') {
            [void]$problems.Add("the acting-seat refusal tells the reader to pass -Seat, which is the switch they have already passed: $actingUnset")
        }
        if ($actingUnset -cnotmatch 'no -Seat argument to the helper you ran can name it') {
            [void]$problems.Add("the acting-seat refusal does not say why the caller's own -Seat cannot answer: $actingUnset")
        }
        if ($actingUnset -cnotmatch [regex]::Escape($means)) {
            [void]$problems.Add("the acting-seat refusal dropped -SeatArgumentMeans, so it says the caller's -Seat is not the answer without saying what it is: $actingUnset")
        }
        foreach ($route in @('tools/Enter-LibrarySeat.ps1', 'LIBRARY_SEAT')) {
            if ($actingUnset -cnotmatch [regex]::Escape($route)) {
                [void]$problems.Add("the acting-seat refusal does not name $route, which is the only way the acting seat can be set: $actingUnset")
            }
        }
        if ($actingUnset -ceq $ordinaryUnset) {
            [void]$problems.Add('the acting-seat and ordinary seatless refusals are the same sentence, so -ActingSeatOnly changed nothing')
        }
        # A CONTRADICTORY CALL REFUSES RATHER THAN PICKING A READING, and never throws.
        $contradiction = Resolve-SeatName -Seat 'alpha' -StateDirectory $fixtureState -AgentProcessId $PID -ActingSeatOnly
        if ([string]$contradiction.status -cne 'malformed' -or [string]$contradiction.message -cnotmatch 'contradict') {
            [void]$problems.Add("-Seat together with -ActingSeatOnly resolved '$([string]$contradiction.seat)' instead of refusing as a call-site defect")
        }
        $orphanedMeans = Resolve-SeatName -StateDirectory $fixtureState -AgentProcessId $PID -SeatArgumentMeans $means
        if ([string]$orphanedMeans.status -cne 'malformed') {
            [void]$problems.Add('-SeatArgumentMeans without -ActingSeatOnly was accepted and silently dropped, which is a refusal worded for the wrong caller')
        }

        # --- 1b. THE REMEDY A MALFORMED NAME OFFERS MUST ANSWER THAT SAME INPUT (2026-09-18) ------
        #
        # THE SAME CIRCLE AS 1a, AT THE OTHER REFUSAL IN THIS FUNCTION. The malformed-name message
        # ends "List the seats with tools/Get-DeskOverview.ps1", and that helper answered a
        # malformed seat by throwing this very sentence -- the remedy was the thing that had just
        # refused them. One message serves roughly twenty consumers, so the fix landed in the named
        # helper rather than in the sentence, and this part is what keeps it landed.
        #
        # THE HELPER IS READ OUT OF THE MESSAGE, NEVER TYPED HERE. An edit that points the remedy at
        # some other helper sends this check to THAT helper; a guard naming one would otherwise go
        # on proving a route the reader is no longer given.
        $malformed = Resolve-SeatName -Seat 'Bad_Seat' -StateDirectory $fixtureState -AgentProcessId $PID
        if ([string]$malformed.status -cne 'malformed') {
            [void]$problems.Add("'Bad_Seat' resolved to '$([string]$malformed.seat)' instead of being refused as a malformed name")
        }
        $remedy = [regex]::Match([string]$malformed.message, 'tools/([A-Za-z][A-Za-z0-9-]*\.ps1)')
        if (-not $remedy.Success) {
            [void]$problems.Add("the malformed-name refusal names no helper to run, so a reader who cannot name their seat is told nothing: $([string]$malformed.message)")
        }
        else {
            $remedyName = "tools/$($remedy.Groups[1].Value)"
            $remedyPath = Join-Path $PSScriptRoot $remedy.Groups[1].Value
            if (-not (Test-Path -LiteralPath $remedyPath -PathType Leaf)) {
                [void]$problems.Add("the malformed-name refusal names $remedyName, which does not exist")
            }
            else {
                # RUN IN-PROCESS, NOT THROUGH `-File`. A child process renders its terminating error
                # through the console, which hard-wraps at the host's width and splits words -- the
                # same run showed "star ting" -- so matching a sentence in that text is a check whose
                # verdict depends on how wide the terminal was. `&` runs the script in a CHILD SCOPE,
                # so nothing it dot-sources or assigns reaches this runner, and the exception carries
                # the message exactly as written.
                $remedyThrew = $false
                $remedyMessage = ''
                $remedyReturned = $null
                try { $remedyReturned = & $remedyPath -WorkspacePath $fixture -Seat 'Bad_Seat' -Json }
                catch { $remedyThrew = $true; $remedyMessage = [string]$_.Exception.Message }

                # THE NEGATIVE, AND IT IS THE LOAD-BEARING HALF: answering is not succeeding. The
                # reader asked for a Desk and there is none to show, so a remedy that starts
                # RETURNING instead of refusing has closed the circle the wrong way -- and
                # `docs/seats.md` and the recovery playbook both tell readers this helper throws
                # without a seat.
                if (-not $remedyThrew) {
                    [void]$problems.Add("$remedyName answered a seat it cannot resolve instead of refusing, so a blocked read now reads as a success: $($remedyReturned | Out-String)")
                }
                else {
                    # THE POSITIVE. Both fixture seats BY NAME, so a roster sentence emptied out
                    # cannot satisfy this the way matching the sentence alone would.
                    foreach ($existing in @('alpha', 'beta')) {
                        if ($remedyMessage -cnotmatch [regex]::Escape($existing)) {
                            [void]$problems.Add("$remedyName refused a malformed seat without naming seat '$existing', so the remedy does not answer the question it is named for: $remedyMessage")
                        }
                    }
                    if ($remedyMessage -cnotmatch [regex]::Escape((Get-SeatRosterSentence -Seats @('alpha', 'beta')))) {
                        [void]$problems.Add("$remedyName lists the seats in a second spelling rather than through Get-SeatRosterSentence, so the two can drift apart: $remedyMessage")
                    }
                    # The roster is ADDED to the refusal, never swapped in for it: the sentence that
                    # named this helper has to survive, or the next reader is refused with no reason.
                    if ($remedyMessage -cnotmatch [regex]::Escape([string]$malformed.message)) {
                        [void]$problems.Add("$remedyName replaced the resolver's refusal instead of carrying it, so the reader is told the seats without being told what was wrong: $remedyMessage")
                    }
                }
            }
        }

        # No binding yet: LIBRARY_SEAT answers, and says so.
        $env:LIBRARY_SEAT = 'beta'
        $viaEnvironment = Resolve-SeatName -StateDirectory $fixtureState -AgentProcessId $PID
        if ([string]$viaEnvironment.status -cne 'named' -or [string]$viaEnvironment.seat -cne 'beta') {
            [void]$problems.Add("LIBRARY_SEAT did not resolve with no binding present: $([string]$viaEnvironment.status)/$([string]$viaEnvironment.seat)")
        }
        if ([string]$viaEnvironment.source -cne 'environment') {
            [void]$problems.Add("an environment resolution reported source '$([string]$viaEnvironment.source)', not 'environment'")
        }
        [void]$observed.Add([string]$viaEnvironment.source)

        $bindingLock = Enter-SeatRegistryLock -Workspace $fixture
        try {
            Write-SeatBinding -Workspace $fixture -StateDirectory $fixtureState -Seat 'alpha' `
                -AgentProcessId $PID -AgentStartUtc $agentIdentity -SessionId 'conv-contract' -State 'committed' | Out-Null
        }
        finally { Exit-BookLock -Lock $bindingLock }

        # THE DISAGREEMENT, WITH LIBRARY_SEAT STILL NAMING beta. A refusal naming BOTH, never a
        # preference for either.
        $conflict = Resolve-SeatName -StateDirectory $fixtureState -AgentProcessId $PID
        if ([string]$conflict.status -ceq 'named') {
            [void]$problems.Add("a binding at 'alpha' and LIBRARY_SEAT at 'beta' resolved to '$([string]$conflict.seat)' instead of refusing")
        }
        else {
            foreach ($named in @('alpha', 'beta')) {
                if ([string]$conflict.message -cnotmatch [regex]::Escape("'$named'")) {
                    [void]$problems.Add("the binding-versus-environment refusal does not name '$named': $([string]$conflict.message)")
                }
            }
        }
        # THE SECOND PLACE THE REMEDY IS WORDED, pinned for the same reason. A fix applied only to
        # the `unset` sentence leaves this one sending an acting-seat caller round the same circle,
        # and it is the harder one to reach by hand: it needs a binding and a disagreeing
        # LIBRARY_SEAT at once.
        $actingConflict = Resolve-SeatName -StateDirectory $fixtureState -AgentProcessId $PID `
            -ActingSeatOnly -SeatArgumentMeans $means
        if ([string]$actingConflict.status -ceq 'named') {
            [void]$problems.Add("the acting-seat route resolved '$([string]$actingConflict.seat)' through a binding/environment disagreement instead of refusing")
        }
        else {
            if ([string]$actingConflict.message -cmatch 'pass -Seat') {
                [void]$problems.Add("the acting-seat disagreement refusal tells the reader to pass -Seat: $([string]$actingConflict.message)")
            }
            if ([string]$actingConflict.message -ceq [string]$conflict.message) {
                [void]$problems.Add('the acting-seat and ordinary disagreement refusals are the same sentence, so -ActingSeatOnly changed nothing on this route')
            }
            foreach ($named in @('alpha', 'beta')) {
                if ([string]$actingConflict.message -cnotmatch [regex]::Escape("'$named'")) {
                    [void]$problems.Add("the acting-seat disagreement refusal stopped naming '$named': $([string]$actingConflict.message)")
                }
            }
        }

        # THE BINDING, once the environment stops disagreeing. This is the route that must be
        # OBSERVED: a resolver that never read a binding would have passed everything above.
        $env:LIBRARY_SEAT = ''
        $viaBinding = Resolve-SeatName -StateDirectory $fixtureState -AgentProcessId $PID
        if ([string]$viaBinding.status -cne 'named' -or [string]$viaBinding.seat -cne 'alpha') {
            [void]$problems.Add("a committed binding for this process did not resolve: $([string]$viaBinding.status)/$([string]$viaBinding.seat)")
        }
        if ([string]$viaBinding.source -cne 'binding') {
            [void]$problems.Add("a binding resolution reported source '$([string]$viaBinding.source)', not 'binding'")
        }
        [void]$observed.Add([string]$viaBinding.source)

        # AND EXPLICIT BEATS BOTH, which is what keeps every cross-seat sweep able to name a seat.
        $env:LIBRARY_SEAT = 'beta'
        $viaExplicit = Resolve-SeatName -Seat 'beta' -StateDirectory $fixtureState -AgentProcessId $PID
        if ([string]$viaExplicit.status -cne 'named' -or [string]$viaExplicit.seat -cne 'beta') {
            [void]$problems.Add("an explicit -Seat did not win over a binding: $([string]$viaExplicit.status)/$([string]$viaExplicit.seat)")
        }
        if ([string]$viaExplicit.source -cne 'explicit') {
            [void]$problems.Add("an explicit resolution reported source '$([string]$viaExplicit.source)', not 'explicit'")
        }
        [void]$observed.Add([string]$viaExplicit.source)
    }
    finally {
        $env:LIBRARY_SEAT = $callerSeat
        if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
    }
    foreach ($source in @('explicit', 'binding', 'environment')) {
        if (@($observed) -cnotcontains $source) { [void]$problems.Add("the '$source' resolution route was never reached, so this check would pass without it") }
    }

    # --- 3. THE MATRIX IS TOTAL, AND ITS INVARIANTS ARE ADR-0018'S --------------------------------
    $matrix = @(Get-SeatStateMatrix)
    if ($matrix.Count -lt 1) { throw 'Get-SeatStateMatrix declares no row; every decision below would be unruled and this check would pass vacuously.' }
    # THE OPERATION SET IS PINNED, and that is this check enforcing a warning Get-SeatStateMatrix has
    # carried in prose since ADR-0016: a whole-tree reset's other seats are on no row, because
    # liveness is not the question -WholeTree asks, and a row named for it "would invite a future
    # reader to answer it from here". A written warning cannot stop that; going red can. It also
    # catches the quieter direction -- a new operation added with no invariants of its own below,
    # which is a row-set nothing pins.
    $matrixOperations = @(@($matrix | ForEach-Object { [string]$_.operation }) | Sort-Object -Unique)
    $pinnedOperations = @('enter', 'mutate', 'retire', 'sweep')
    if (@(Compare-Object -ReferenceObject $pinnedOperations -DifferenceObject $matrixOperations -SyncWindow 0).Count) {
        throw ("the seat-state matrix declares operations [$($matrixOperations -join ', ')] and this check pins [$($pinnedOperations -join ', ')]. " +
               'A new operation needs its own invariants here before it is trusted, and a whole-tree row needs ADR-0016 re-read before it is added at all.')
    }
    $decisions = @{}
    foreach ($operation in @('enter', 'mutate', 'retire', 'sweep')) {
        foreach ($state in @('free', 'held', 'orphaned')) {
            foreach ($same in @($true, $false)) {
                $decisions["$operation|$state|$same"] = [string](Get-SeatStateDecision -Operation $operation -State $state -SameAgent $same)
            }
        }
    }
    if (@($decisions.Values | Sort-Object -Unique).Count -lt 2) {
        throw "every operation in every state decides '$(@($decisions.Values)[0])'; the matrix rules nothing."
    }
    # A FOREIGN AGENT IS REFUSED EVERYWHERE. This is the whole of D2 and it is one line to break.
    foreach ($operation in @('enter', 'mutate')) {
        foreach ($state in @('held', 'orphaned')) {
            if ($decisions["$operation|$state|False"] -cne 'refuse') {
                [void]$problems.Add("the matrix lets a DIFFERENT agent '$operation' a $state seat: $($decisions["$operation|$state|False"])")
            }
        }
    }
    # A MUTATOR NEEDS A LIVE HANDLE AT ITS OWN SEAT, and nothing else will do: `free` is a lost
    # session and `orphaned` is a lost holder, and both must refuse rather than write.
    foreach ($state in @('free', 'orphaned')) {
        foreach ($same in @($true, $false)) {
            if ($decisions["mutate|$state|$same"] -cne 'refuse') {
                [void]$problems.Add("the matrix admits a mutation at a $state seat (same agent: $same): $($decisions["mutate|$state|$same"])")
            }
        }
    }
    if ($decisions['mutate|held|True'] -cne 'allow') { [void]$problems.Add("the matrix refuses a mutation at this agent's own held seat: $($decisions['mutate|held|True'])") }
    # RETIREMENT NEEDS AN IDLE SEAT, whoever is asking: it is what makes a seat's material eligible
    # for a whole-tree reset.
    foreach ($state in @('held', 'orphaned')) {
        foreach ($same in @($true, $false)) {
            if ($decisions["retire|$state|$same"] -cne 'refuse') {
                [void]$problems.Add("the matrix retires a $state seat (same agent: $same): $($decisions["retire|$state|$same"])")
            }
        }
    }
    if ($decisions['retire|free|True'] -cne 'allow') { [void]$problems.Add("the matrix refuses to retire a FREE seat: $($decisions['retire|free|True'])") }
    # AND THE SAME AGENT RECOVERS ITS OWN ORPHAN, which is the row the whole `orphaned` state exists
    # for: without it a lost claim holder is a seat nobody can get back into.
    if ($decisions['enter|orphaned|True'] -cne 'restore') { [void]$problems.Add("the matrix does not let this agent restore its own orphaned seat: $($decisions['enter|orphaned|True'])") }
    # A SWEEP IS PINNED BOTH WAYS (ADR-0023). A guard that pins only the positive stays green when a
    # recognised state goes blind, and this row-set is the only thing between "clear every idle seat"
    # and "clear every seat" -- so the negatives are asserted one state at a time rather than as
    # "not allow", which one wrong decision value would satisfy.
    foreach ($same in @($true, $false)) {
        if ($decisions["sweep|free|$same"] -cne 'allow') {
            [void]$problems.Add("the matrix will not sweep an IDLE seat (same agent: $same): $($decisions["sweep|free|$same"]); a sweep that takes nothing is not one")
        }
        if ($decisions["sweep|held|$same"] -cne 'skip') {
            [void]$problems.Add("the matrix does not SKIP a held seat in a sweep (same agent: $same): $($decisions["sweep|held|$same"]); somebody is writing there, and a refusal would abort the run instead of naming the seat")
        }
        if ($decisions["sweep|orphaned|$same"] -cne 'skip') {
            [void]$problems.Add("the matrix does not SKIP an orphaned seat in a sweep (same agent: $same): $($decisions["sweep|orphaned|$same"]); its agent is still running")
        }
    }

    # --- 4. EVERY CALL SITE HANDS OVER THE STATE DIRECTORY ----------------------------------------
    $schemaFile = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'BookRootSchema.ps1')).Path
    $roots = @('tools', '.claude') | ForEach-Object { Join-Path $workspace $_ }
    $sources = @($roots | Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.ps1' -Recurse -File -ErrorAction SilentlyContinue })
    # --- 5. A HELPER WHOSE OWN `-Seat` MEANS SOMETHING ELSE DECLARES IT (2026-09-18) --------------
    #
    # THE ENCLOSING SCOPE, NOT THE FILE, AND THAT IS THE WHOLE VALUE OF THIS PART.
    # NotebookOwnership.ps1 declares no script parameters at all and still holds this construction
    # inside Set-NotebookTopicOwner(), whose `-Seat` is the assignee -- a file-level test walks
    # straight past it. The Hub named one site; scoping by function found two.
    #
    # `Get-DeskStateDirectory` IS IN SCOPE TOO because it is where the refusal is thrown, so a
    # caller reaching it without a seat would raise the same circle one frame further out.
    function Get-NearestSeatScope($FileAst, $Call) {
        $best = $null
        foreach ($fn in @($FileAst.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] }, $true))) {
            if ($fn.Extent.StartOffset -le $Call.Extent.StartOffset -and $fn.Extent.EndOffset -ge $Call.Extent.EndOffset) {
                if ($null -eq $best -or $fn.Extent.StartOffset -gt $best.Extent.StartOffset) { $best = $fn }
            }
        }
        $parameters = @()
        $scopeName = '<script>'
        if ($null -ne $best) {
            $scopeName = [string]$best.Name
            # BOTH SPELLINGS. `function f([string]$Seat)` parks them on .Parameters and
            # `function f { param(...) }` on the body's param block; reading one finds half.
            if ($null -ne $best.Parameters) { $parameters = @($best.Parameters) }
            elseif ($null -ne $best.Body -and $null -ne $best.Body.ParamBlock) { $parameters = @($best.Body.ParamBlock.Parameters) }
        }
        elseif ($null -ne $FileAst.ParamBlock) { $parameters = @($FileAst.ParamBlock.Parameters) }
        $declares = $false
        foreach ($parameter in $parameters) {
            if ([string]$parameter.Name.VariablePath.UserPath -ceq 'Seat') { $declares = $true }
        }
        [pscustomobject]@{ name = $scopeName; declares_seat = $declares }
    }

    $callSites = 0
    $actingSites = 0
    foreach ($source in $sources) {
        if ($source.FullName -ceq $schemaFile) { continue }
        if ($source.Name -cmatch '^Test-') { continue }
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($source.FullName), [ref]$null, [ref]$parseErrors)
        if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) { throw "$($source.Name) does not parse; the resolution-contract check cannot read it." }
        foreach ($command in @($ast.FindAll({ $args[0] -is [Management.Automation.Language.CommandAst] }, $true))) {
            $name = $command.GetCommandName()
            $resolves = ($name -ceq 'Resolve-SeatName' -or $name -ceq 'Get-DeskStateDirectory')
            if (-not $resolves) { continue }
            # -ieq, not -ceq: PowerShell binds `-statedirectory` and `-Seat` alike, so a scan that
            # compared case-sensitively would read a legal call as an absent parameter. This widens
            # part 4's original test, which can only catch more.
            $passesState = $false
            $bindsSeat = $false
            $bindsActing = $false
            foreach ($element in @($command.CommandElements)) {
                if ($element -isnot [Management.Automation.Language.CommandParameterAst]) { continue }
                $parameterName = [string]$element.ParameterName
                if ($parameterName -ieq 'StateDirectory') { $passesState = $true }
                if ($parameterName -ieq 'Seat') { $bindsSeat = $true }
                if ($parameterName -ieq 'ActingSeatOnly') { $bindsActing = $true }
            }
            if ($name -ceq 'Resolve-SeatName') {
                $callSites++
                if (-not $passesState) {
                    [void]$problems.Add("$($source.Name):$($command.Extent.StartLineNumber) calls Resolve-SeatName without -StateDirectory, so it cannot see this process's binding")
                }
            }
            # THERE IS DELIBERATELY NO STATIC RULE AGAINST PASSING BOTH -Seat AND -ActingSeatOnly,
            # and it was written and removed rather than never tried. It went red on its first run
            # against the fixture twenty lines above, which passes both ON PURPOSE to prove the
            # runtime refusal exists -- so the static copy could only stand by exempting the one
            # call site that proves the property it duplicates. Resolve-SeatName refuses the
            # contradiction itself, loudly and at the call, which is where it bites; part 1a pins
            # that refusal. One check, where the fault is.
            if ($bindsSeat) { continue }
            $scope = Get-NearestSeatScope $ast $command
            if (-not $scope.declares_seat) { continue }
            $actingSites++
            if (-not $bindsActing) {
                [void]$problems.Add(
                    "$($source.Name):$($command.Extent.StartLineNumber) resolves the ACTING seat inside $($scope.name)(), which declares a -Seat of its own, " +
                    'without -ActingSeatOnly -- so its refusal tells the reader to pass the switch they have already passed')
            }
        }
    }
    # SCOPED TO THIS REPOSITORY'S OWN TREE, the way powershell.defect-families is: zero call sites is
    # the correct answer for the one-file scratch workspaces Test-LibraryHelpers builds and runs this
    # gate against, and an unscoped floor would report on the fixture's shape rather than on the scan.
    # Against our own sources, a collapse to a handful means the scan stopped reading the repository.
    $ownTree = ((Resolve-Path -LiteralPath $workspace).Path -ceq (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path)
    if ($ownTree -and $callSites -lt 10) {
        throw "only $callSites Resolve-SeatName call site(s) were found across this repository; the call-site scan is no longer reading it, so part 4 would pass vacuously."
    }
    # THE CONSTRUCTION IS STILL BEING FOUND. Zero FLAGGED sites is the correct answer once they all
    # carry the switch, so the flagged count proves nothing on its own; what would go quiet
    # undetected is the SCOPE WALK -- a change that stops resolving enclosing functions drops
    # numerator and denominator together and reads clean. This floor is the assertion from outside.
    if ($ownTree -and $actingSites -lt 2) {
        throw "only $actingSites acting-seat call site(s) were found; the enclosing-scope walk is no longer finding the construction, so part 5 would pass vacuously."
    }

    if ($problems.Count) { throw ($problems -join '; ') }
    "3 resolution source(s) observed in order, the disagreement refused naming both, the acting-seat refusal differs from it on both routes, the malformed-name refusal's own named remedy answers that same input and still refuses, $($decisions.Count) matrix decision(s) ruled, $callSites call site(s) pass the state directory, and $actingSites acting-seat site(s) declare themselves"
}

# --- Both seat-creation routes pass the same gate (SeatCreation.ps1, 2026-09-10) -------------------
#
# WHY THIS EXISTS, AND IT IS A DEFECT RATHER THAN A PRECAUTION. Two helpers create a seat, and until
# 2026-09-10 they validated different things: `Enter-LibrarySeat.ps1` checked that the Project Hub
# existed and was active, and `Start-LibrarySeat.ps1` checked the slug's shape and its uniqueness and
# nothing else. So the same reader got different answers depending on which route they took, and the
# looser one made one-seat-per-project unenforceable -- an invented project slug is unique by
# construction, so the collision check could never fire for one.
#
# BOTH DIRECTIONS, the way desk.claim-coverage and desk.registry-lock-coverage already are. A
# declared helper that stops calling the gate is the divergence coming back. A helper that STARTS
# creating seats without being declared is a third route nobody decided to add, and it would begin
# with whichever subset of the rules its author remembered -- which is exactly how the two existing
# routes came to disagree.
#
# WHAT IT CANNOT SEE, stated rather than implied. It matches the call by name through the AST, so it
# proves the gate is INVOKED, not that it is reached on every path or that its verdict is honoured --
# Assert-NewSeatIsCreatable throws rather than returning something a caller could ignore, and case 1b
# of `seat.lifecycle` is what exercises the behaviour, driving the launcher as a real process against
# a Project that does not exist. Test runners are excluded for desk.claim-coverage's reason: a suite
# calls the gate directly to falsify it, which is the suite working rather than a new creation route.
Invoke-Check 'seat.creation-gate' {
    $creationFile = Join-Path $PSScriptRoot 'SeatCreation.ps1'
    if (-not (Test-Path -LiteralPath $creationFile -PathType Leaf)) { throw 'tools/SeatCreation.ps1 is missing; the seat-creation gate has no definition.' }
    . $creationFile
    $declared = @(Get-SeatCreatingHelpers)
    if ($declared.Count -lt 2) { throw "Get-SeatCreatingHelpers declares $($declared.Count) helper(s); with fewer than two there is no shared gate to keep, and this check would pass vacuously." }

    $declaringFile = (Resolve-Path -LiteralPath $creationFile).Path
    $roots = @('tools', '.claude') | ForEach-Object { Join-Path $workspace $_ }
    $sources = @($roots | Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.ps1' -Recurse -File -ErrorAction SilentlyContinue })

    # TWO SHARED CALLS, NOT ONE. The gate says what a legal seat IS; Get-NewSeatDeskEntry says what
    # the seat then LOOKS like. The routes agreed on the first and disagreed on the second until
    # 2026-09-10 -- the launcher created its Desk empty while Enter-LibrarySeat.ps1 opened the seat's
    # own Project Hub -- so a seat created at a terminal had to be told to open its own Project. The
    # same divergence, one layer down, and it is checked the same way.
    # TWO CALLS AND TWO DECLARED SETS, because validating a creation and building the new Desk are
    # different routes: SeatPicker.ps1 runs the gate, shows the plan and takes the yes, then hands an
    # approved plan_id to the launcher, which does the writing.
    $shared = @(
        [pscustomobject]@{ call = 'Assert-NewSeatIsCreatable'; declared = @(Get-SeatCreatingHelpers) }
        [pscustomobject]@{ call = 'Get-NewSeatDeskEntry'; declared = @(Get-SeatDeskBuildingHelpers) }
    )
    $observedByCall = @{}
    foreach ($row in $shared) { $observedByCall[[string]$row.call] = [Collections.Generic.List[string]]::new() }
    $scanned = 0
    foreach ($source in $sources) {
        if ($source.FullName -ceq $declaringFile) { continue }
        if ($source.Name -cmatch '^Test-') { continue }
        # AND THIS FILE, which calls the gate below to falsify it. That is the check working, exactly
        # as a suite calling it is, and counting its own host as a creation route would make the
        # declaration permanently wrong.
        if ($source.Name -ceq 'Invoke-LibraryChecks.ps1') { continue }
        $scanned++
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($source.FullName), [ref]$null, [ref]$parseErrors)
        if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) { throw "$($source.Name) does not parse; the creation-gate check cannot read it." }
        $called = @(@($ast.FindAll({ $args[0] -is [Management.Automation.Language.CommandAst] }, $true)) |
            ForEach-Object { [string]$_.GetCommandName() } | Sort-Object -Unique -CaseSensitive)
        foreach ($row in $shared) {
            if (@($called) -ccontains [string]$row.call) { [void]$observedByCall[[string]$row.call].Add($source.Name) }
        }
    }
    $observed = @($observedByCall['Assert-NewSeatIsCreatable'])

    $problems = [Collections.Generic.List[string]]::new()
    foreach ($row in $shared) {
        $name = [string]$row.call
        $expected = @($row.declared)
        if ($expected.Count -lt 2) { throw "The declared set for $name names $($expected.Count) helper(s); with fewer than two there is nothing shared to keep, and this check would pass vacuously." }
        $seen = @($observedByCall[$name])
        foreach ($helper in $expected) {
            if (@($seen) -cnotcontains $helper) {
                [void]$problems.Add("$helper is declared as a seat-creation route and never calls $name; it would use whatever its own code happens to remember")
            }
        }
        foreach ($helper in @($seen)) {
            if (@($expected) -cnotcontains $helper) {
                [void]$problems.Add("$helper calls $name and is not declared for it in SeatCreation.ps1; declare it, or stop creating seats there")
            }
        }
    }

    # AND THE GATE MUST STILL REFUSE. A declaration and two call sites prove nothing about an
    # assertion reduced to `return $true`, which is the cheapest way to reintroduce the whole family.
    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('seat-gate-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        New-Item -ItemType Directory -Path (Join-Path $fixture '.claude') -Force | Out-Null
        $registry = [pscustomobject]@{ schema = 1; seats = @([pscustomobject]@{ seat = 'held'; project = 'taken-proj'; created_utc = '2026-01-01T00:00:00.0000000Z' }) }
        $cases = @(
            @{ why = 'a Project Hub that is not active'; seat = 'fresh'; project = 'ghost-proj'; active = @('taken-proj', 'free-proj'); expect = 'no active Project Hub' }
            @{ why = 'a project another seat already holds'; seat = 'fresh'; project = 'taken-proj'; active = @('taken-proj', 'free-proj'); expect = 'already bound to seat' }
            @{ why = 'a seat that already exists'; seat = 'held'; project = 'free-proj'; active = @('taken-proj', 'free-proj'); expect = 'already exists' }
            @{ why = 'no Project at all'; seat = 'fresh'; project = ''; active = @('taken-proj', 'free-proj'); expect = 'needs the Project it is for' }
        )
        foreach ($case in $cases) {
            $refusal = $null
            try {
                Assert-NewSeatIsCreatable -Workspace $fixture -StateDirectory (Join-Path $fixture '.claude') `
                    -Registry $registry -Seat ([string]$case.seat) -Project ([string]$case.project) `
                    -ActiveProjects ([string[]]@($case.active)) | Out-Null
            }
            catch { $refusal = [string]$_.Exception.Message }
            if ($null -eq $refusal) { [void]$problems.Add("the creation gate admitted $([string]$case.why)") }
            elseif ($refusal -cnotmatch [regex]::Escape([string]$case.expect)) {
                [void]$problems.Add("the refusal for $([string]$case.why) did not say so: $refusal")
            }
        }
        # THE POSITIVE CONTROL, or every assertion above passes against a gate that refuses
        # everything -- which is the other way to make this check meaningless.
        Assert-NewSeatIsCreatable -Workspace $fixture -StateDirectory (Join-Path $fixture '.claude') `
            -Registry $registry -Seat 'fresh' -Project 'free-proj' -ActiveProjects ([string[]]@('taken-proj', 'free-proj')) | Out-Null
    }
    finally { if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue } }

    if ($problems.Count) { throw ($problems -join '; ') }
    "$scanned source(s) scanned; the $($declared.Count) declared creation route(s) are exactly those calling the gate, and it refused 4 illegal seats while admitting a legal one"
}


# --- RETIREMENT IS A RECORD, AND THIS WORKSPACE'S SEATS ARE ACCOUNTED FOR -------------------------
#
# THE DEFECT IT GUARDS WAS ONE `rm -rf` AWAY. Until 2026-09-10 a seat counted as retired because it
# was absent from `.claude/seats/`, so deleting one seat's directory by hand -- the obvious thing to
# try when a stale claim will not clear -- made every Notebook topic it owned eligible for the next
# seat's whole-tree reset, silently. Both `.claude/seats/` and `internal/` are gitignored, so no
# commit restores either and no diff shows it happening.
#
# TWO HALVES, AND THEY PROVE DIFFERENT THINGS. The first plants each state in a fixture and drives
# `Get-NotebookResetTargets` -- the REAL consumer, under its own registry lock -- so a classifier
# reduced to "everything is retired" fails rather than passes, and so does one reduced to the
# opposite. The second reads THIS workspace and reports a live disagreement, because a guard that
# only ever runs against fixtures cannot tell the reader their own checkout is broken.
#
# THE LIVE HALF TAKES NO LOCK, deliberately. `Get-SeatRegistryConsistency` and the ownership sweep
# are reads of records that are replaced atomically, and making the gate acquire an ordered lock
# every run would make it fail for a reason that has nothing to do with health. The classifier they
# call is the same one the reset uses; the fixture half is what pins the reset to it.
Invoke-Check 'desk.seat-retirement-identity' {
    . (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')
    $problems = [Collections.Generic.List[string]]::new()

    # THE OWNERSHIP SWEEP IS WRITTEN ONCE AND RUN TWICE: over the fixture below, where a row whose
    # incarnation nothing accounts for is planted and MUST come back, and over this workspace,
    # where none should. A sweep that only ever ran live could be emptied without anything going
    # red, because a healthy checkout and a deleted sweep give the same answer -- which is the
    # coverage-count trap this repository has paid for before.
    function Get-UnaccountedOwnership([string]$Root) {
        $registry = Read-SeatRegistry -StateDirectory (Join-Path $Root '.claude')
        $retirements = @((Read-SeatRetirementRecords -Workspace $Root).records)
        @(@(Get-NotebookOwnershipInventory -Workspace $Root) |
            Where-Object { [string]$_.scope -ceq 'owned' } |
            Where-Object { (Get-SeatIncarnationStatus -Registry $registry -Retirements $retirements -Seat ([string]$_.seat) -SeatId ([string]$_.seat_id)) -ceq 'unaccounted' })
    }

    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('seat-retire-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        $fixtureState = Join-Path $fixture '.claude'
        New-Item -ItemType Directory -Path $fixtureState -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $fixture 'internal') -Force | Out-Null

        # FOUR TOPICS, ONE PER STATE, ALL PRESENT AT ONCE. A fixture that showed the states one at a
        # time could not catch a classifier that answers the same thing for all of them, and the
        # acting seat's own topic is the decoy for one that answers `retired` to everything.
        foreach ($seat in @('actor', 'living')) {
            Initialize-SeatForFixture -StateDirectory $fixtureState -Seat $seat -Project "$seat-proj" | Out-Null
        }
        foreach ($topic in @('actor-topic', 'living-topic', 'gone-topic', 'stranded-topic')) {
            New-Item -ItemType Directory -Path (Join-Path $fixture "notebook/$topic") -Force | Out-Null
        }
        Set-NotebookTopicOwner -Workspace $fixture -Topic 'actor-topic' -Seat 'actor'
        Set-NotebookTopicOwner -Workspace $fixture -Topic 'living-topic' -Seat 'living'
        # The two absent seats are written straight into the record: neither has a registry entry,
        # so no helper would record them, and this is planted state rather than an operation.
        $owners = Read-NotebookTopicOwners -Workspace $fixture
        $planted = @(@($owners.topics) +
            [pscustomobject]@{ topic = 'gone-topic'; scope = 'owned'; seat = 'gone'; project = 'gone-proj'; recorded_utc = '2026-01-01T00:00:00.0000000Z'; seat_id = 'gone-one' } +
            [pscustomobject]@{ topic = 'stranded-topic'; scope = 'owned'; seat = 'stranded'; project = 'stranded-proj'; recorded_utc = '2026-01-01T00:00:00.0000000Z'; seat_id = 'stranded-one' })
        $ownersLock = Enter-NotebookOwnersLock -Workspace $fixture
        try { Write-NotebookTopicOwners -Workspace $fixture -Owners ([pscustomobject]@{ schema = 1; topics = $planted }) }
        finally { Exit-BookLock -Lock $ownersLock }
        # ONLY `gone` GETS A RETIREMENT RECORD, and it names the incarnation the row does. That one
        # difference is the whole subject: `stranded` differs from it in nothing else.
        $archive = Join-Path (Get-SeatArchiveDirectory -Workspace $fixture) 'gone-20260101-000000'
        New-Item -ItemType Directory -Path $archive -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $archive 'seat.json'),
            '{"seat":"gone","seat_id":"gone-one","project":"gone-proj","retired_utc":"2026-01-01T00:00:00.0000000Z"}' + "`n",
            [Text.UTF8Encoding]::new($false))

        $fixtureLock = Enter-SeatRegistryLock -Workspace $fixture
        try { $selection = Get-NotebookResetTargets -Workspace $fixture -Seat 'actor' -WholeTree }
        finally { Exit-BookLock -Lock $fixtureLock }
        $expected = @(
            @{ bucket = 'targets';     topics = 'actor-topic,gone-topic'; why = 'this seat''s own topic and the one whose seat has a retirement record' }
            @{ bucket = 'foreign';     topics = 'living-topic';           why = 'the topic of a seat that is still registered' }
            @{ bucket = 'retired';     topics = 'gone-topic';             why = 'the topic of the one seat with a retirement record' }
            @{ bucket = 'unaccounted'; topics = 'stranded-topic';         why = 'the topic of a seat with neither a registry entry nor a retirement record' }
        )
        foreach ($row in $expected) {
            $actual = (@(@($selection.($row.bucket)) | ForEach-Object { [string]$_.topic }) | Sort-Object -CaseSensitive) -join ','
            if ($actual -cne [string]$row.topics) {
                [void]$problems.Add("reset selection put '$actual' in $($row.bucket) where it should hold $($row.topics) -- $($row.why)")
            }
        }
        if (-not (@($selection.refusals) -join ' ').Contains('cannot be accounted for')) {
            [void]$problems.Add('a whole-tree reset over a seat with no registry entry and no retirement record did not refuse')
        }

        # THE SWEEP, over the fixture while `gone` is still properly retired, so exactly one row
        # is unaccounted for. It runs HERE rather than after the deletion below, which makes a
        # second row unaccounted on purpose -- and it runs at all because the live half cannot
        # prove it: a healthy checkout and a deleted sweep give the same answer.
        $sweptFixture = (@(Get-UnaccountedOwnership $fixture | ForEach-Object { [string]$_.topic }) | Sort-Object -CaseSensitive) -join ','
        if ($sweptFixture -cne 'stranded-topic') {
            [void]$problems.Add("the ownership sweep found '$sweptFixture' where the fixture plants exactly stranded-topic")
        }

        # AND REMOVING THE RECORD MOVES THE ANSWER, which is what makes the archive load-bearing
        # rather than decorative: `gone` is absent from the registry either way.
        Remove-Item -LiteralPath (Join-Path $archive 'seat.json') -Force
        $fixtureLock = Enter-SeatRegistryLock -Workspace $fixture
        try { $without = Get-NotebookResetTargets -Workspace $fixture -Seat 'actor' -WholeTree }
        finally { Exit-BookLock -Lock $fixtureLock }
        if (@(@($without.targets) | Where-Object { [string]$_.topic -ceq 'gone-topic' }).Count) {
            [void]$problems.Add('an archive with no seat.json still licensed a whole-tree reset over the topics it names')
        }
    }
    finally { if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue } }

    # --- AND THIS WORKSPACE ---------------------------------------------------------------------
    $consistency = Get-SeatRegistryConsistency -Workspace $workspace -StateDirectory (Join-Path $workspace '.claude')
    foreach ($fault in @($consistency.faults)) { [void]$problems.Add($fault) }
    foreach ($row in @(Get-UnaccountedOwnership $workspace)) {
        [void]$problems.Add("notebook/$([string]$row.topic) is owned by seat '$([string]$row.seat)', which has no registry entry and no " +
            'retirement record in internal/seat-archive/: no reset can reach that topic and the seat name cannot be reused. ' +
            'Take it over with tools/Set-NotebookTopicOwner.ps1, or declare it shared.')
    }
    $ownedHere = @(@(Get-NotebookOwnershipInventory -Workspace $workspace) | Where-Object { [string]$_.scope -ceq 'owned' })

    if ($problems.Count) { throw ($problems -join '; ') }
    "4 planted states classified by the real selector, the archive record proved load-bearing, the ownership sweep caught its planted row, and this workspace's $(@($consistency.seats).Count) seat(s) and $($ownedHere.Count) owned topic(s) all accounted for"
}

# --- The seats contract table is a RENDERING of the declarations, not a second authority ----------
#
# WHY THIS EXISTS, AND THE HISTORY IS THE ARGUMENT. `docs/seats.md` restated the registry-lock rule
# in prose four times, and all four were wrong for four helpers, with the gate green throughout --
# `docs.links-resolve` proves prose is REACHABLE and never that it is TRUE. The seats review then
# asked for a contract table so a reader could answer "what does archive take?" without reading the
# history of what used to be wrong. A hand-written table would have been the fifth copy of the thing
# that had already been wrong four times, so the table is checked against the code that declares it.
#
# FOUR COLUMNS, FOUR DECLARATIONS, BOTH DIRECTIONS. A cell that disagrees with its declaration, a
# declared helper with no row, and a row naming a helper no declaration knows are three different
# faults and each is silent on its own. The fifth column is checked differently: a proving test is a
# human judgement about which suite carries a helper, so what is verified is that the name is a
# check this runner actually registers -- a row citing a suite that was renamed or deleted is a
# citation to nothing.
#
# WHAT IT CANNOT SEE, stated rather than implied. It does not know whether the cited check really
# exercises that helper, only that the check exists; and the first column renders the CROSS-SEAT
# declaration, so a helper that takes the registry lock for its own seat and calls none of those
# functions is correctly `no`. The table says so in prose, and that prose is not checked either.
# --- A HOOK SERVES A HEADING THAT EXISTS (ADR-0014, PLAN-seat-launch.md step 9) -------------------
#
# THE FAILURE MODE THIS EXISTS FOR IS SILENT AND HAS ALREADY HAPPENED ONCE HERE. A hook that cuts a
# named section out of a tracked document serves NOTHING when the heading is reworded -- no error, no
# warning, just a session that stops being told the thing the hook was written to tell it. ADR-0014
# accepted that trade explicitly, on the condition that the gate assert the heading resolves;
# `library-hooks.boundary-suite` already does it for the playbook routes, and this does it for the
# seat routes.
#
# BOTH SIDES ARE DERIVED. The headings come out of the hook's own source rather than being retyped
# here -- a retyped list is the copy that falls behind, which this repository has now paid for in
# `-Fast` rosters and in a playbook route asserted by nothing. The guard against reading nothing at
# all is explicit: a hook whose -Heading arguments stopped matching would otherwise produce an empty
# set and pass.
Invoke-Check 'seats.session-start-section-resolves' {
    $hook = Join-Path $workspace '.claude/hooks/Get-SeatStartContext.ps1'
    if (-not (Test-Path -LiteralPath $hook -PathType Leaf)) { throw 'the SessionStart seat hook is missing; a seatless session is offered nothing.' }
    $doc = Join-Path $workspace 'docs/seats.md'
    if (-not (Test-Path -LiteralPath $doc -PathType Leaf)) { throw 'docs/seats.md is missing; the seat hook has no document to serve.' }
    # The REAL cutter, not a reimplementation of it: a check that parsed headings its own way would
    # pass on a document the hook cannot cut.
    . (Join-Path $workspace '.claude/hooks/HookContext.ps1')

    $hookText = [IO.File]::ReadAllText($hook)
    $headings = @(@([regex]::Matches($hookText, "-Heading\s+'([^']+)'") | ForEach-Object { $_.Groups[1].Value }) | Select-Object -Unique)
    if (-not $headings.Count) { throw 'no served heading was found in the SessionStart seat hook; this check read nothing rather than proving anything.' }

    foreach ($heading in $headings) {
        $section = Get-MarkdownSection -Path $doc -Heading $heading
        if ([string]::IsNullOrWhiteSpace($section)) {
            throw "the SessionStart seat hook serves '$heading' from docs/seats.md, and that heading does not resolve. A seatless session would be handed a roster with no instruction."
        }
        # THE CUT IS BOUNDED. An end-marker cut in this repository once swallowed four unrelated
        # sections; a section that ran on would put the whole document into every session start.
        if ($section.Contains('## Where a Desk lives')) { throw "the '$heading' cut ran past its own section into the next one." }
        # AND IT CARRIES THE INSTRUCTION, not merely a heading with prose under it. The hook adds
        # STATE and nothing else, so if this sentence leaves the document nothing tells a seatless
        # session what to do.
        if (-not $section.Contains('Ask the reader which seat')) {
            throw "the '$heading' section no longer tells a seatless session to ask which seat; the hook holds no wording of its own to fall back on (ADR-0014)."
        }
    }
    "$($headings.Count) served heading(s) resolve in docs/seats.md, bounded, and carry the ask"
}

Invoke-Check 'seats.contract-table-matches-code' {
    . (Join-Path $PSScriptRoot 'SeatCreation.ps1')
    $doc = Join-Path $workspace 'docs/seats.md'
    if (-not (Test-Path -LiteralPath $doc -PathType Leaf)) { throw 'docs/seats.md is missing; the seat contract has no reader-facing rendering.' }
    $text = [IO.File]::ReadAllText($doc)

    $declared = [ordered]@{
        'cross-seat' = @(Get-RegistryLockedHelpers)
        'claim'      = @(Get-ClaimGatedHelpers)
        'ownership'  = @(Get-TopicLockedHelpers)
        'creation'   = @(Get-SeatCreatingHelpers)
    }
    foreach ($name in @($declared.Keys)) {
        if (@($declared[$name]).Count -lt 1) { throw "the '$name' declaration is empty; every cell in that column would be 'no' and this check would pass vacuously." }
    }

    # THE ROWS, READ OUT OF THE TABLE ITSELF. Anchored on the exact five-column shape, so a row that
    # loses a column is not silently read as a shorter one that happens to parse.
    $rows = @{}
    $order = [Collections.Generic.List[string]]::new()
    foreach ($match in [regex]::Matches($text, '(?m)^\|\s*`tools/([A-Za-z0-9.-]+\.ps1)`\s*\|\s*(yes|no)\s*\|\s*(yes|no)\s*\|\s*(yes|no)\s*\|\s*(yes|no)\s*\|\s*`([a-z0-9.-]+)`\s*\|\s*$')) {
        $helper = $match.Groups[1].Value
        if ($rows.ContainsKey($helper)) { throw "the seats contract table lists $helper twice." }
        $rows[$helper] = [pscustomobject]@{
            'cross-seat' = ($match.Groups[2].Value -ceq 'yes')
            'claim'      = ($match.Groups[3].Value -ceq 'yes')
            'ownership'  = ($match.Groups[4].Value -ceq 'yes')
            'creation'   = ($match.Groups[5].Value -ceq 'yes')
            'proof'      = $match.Groups[6].Value
        }
        [void]$order.Add($helper)
    }
    $expectedRows = @(@($declared.Values | ForEach-Object { $_ }) | Sort-Object -Unique)
    if ($rows.Count -lt $expectedRows.Count) {
        throw "the seats contract table parsed as $($rows.Count) row(s) against $($expectedRows.Count) declared helper(s); the table's shape changed and this check can no longer read it."
    }

    $problems = [Collections.Generic.List[string]]::new()
    foreach ($column in @($declared.Keys)) {
        foreach ($helper in @($declared[$column])) {
            if (-not $rows.ContainsKey($helper)) {
                [void]$problems.Add("$helper is declared under '$column' and has no row in the seats contract table")
                continue
            }
            if (-not $rows[$helper].$column) {
                [void]$problems.Add("the table says $helper is not '$column' and the code declares that it is")
            }
        }
    }
    foreach ($helper in @($order)) {
        foreach ($column in @($declared.Keys)) {
            if ($rows[$helper].$column -and @($declared[$column]) -cnotcontains $helper) {
                [void]$problems.Add("the table says $helper is '$column' and no declaration says so")
            }
        }
        if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $helper) -PathType Leaf)) {
            [void]$problems.Add("the table has a row for $helper, which is not in tools/")
        }
    }

    # THE PROVING TEST MUST BE A CHECK THIS RUNNER REGISTERS. Read from its own AST rather than a
    # list here, for the reason the whole table exists: a second copy of a set is how the two come
    # to disagree.
    $registered = @([Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($PSCommandPath), [ref]$null, [ref]$null).
        FindAll({ $args[0] -is [Management.Automation.Language.CommandAst] }, $true) |
        Where-Object { [string]$_.GetCommandName() -ceq 'Invoke-Check' } |
        ForEach-Object { $_.CommandElements } |
        Where-Object { $_ -is [Management.Automation.Language.StringConstantExpressionAst] } |
        ForEach-Object { [string]$_.Value })
    if ($registered.Count -lt 20) { throw "only $($registered.Count) check name(s) were read from this runner; the proving-test column cannot be verified." }
    foreach ($helper in @($order)) {
        $proof = [string]$rows[$helper].proof
        if (@($registered) -cnotcontains $proof) {
            [void]$problems.Add("the table cites '$proof' as what proves $helper, and this runner registers no such check")
        }
    }

    if ($problems.Count) { throw ($problems -join '; ') }
    "$($rows.Count) row(s) in docs/seats.md match the $($declared.Count) declaration(s) they render, both ways, and every proving test names a registered check"
}

# --- The gate row for the two-seat suite is a rendering of the suite's own sections (2026-09-18) ---
#
# WHAT IT COST TO WRITE THAT ROW BY HAND. Until today it credited `desk.two-seat-acceptance` with
# Discovery, Hub edits, archive/remove and a restart cutover, and the suite exercises NONE of those:
# Discovery is not Desk-gated at all, no Project page is touched, the two Shelf helpers named are
# never driven -- only the single-seat Desk writer they share -- and section 7 exists precisely to
# prove a restart is not needed. A reader sizing their risk from that row was reading four
# guarantees nothing holds, and the row had already carried a note admitting as much rather than
# being narrowed.
#
# SO THE ROW IS A RENDERING AND THIS COMPARES IT, BOTH WAYS. A credit the suite cannot back needs a
# section id that does not exist, and a section the row is silent about is a capability the gate has
# and nobody knows it has. The same reasoning as `seats.contract-table-matches-code` one table up,
# applied to the one row it does not cover.
#
# THE SECTION HEADERS ARE THE DECLARATION, deliberately, rather than a list kept beside them. A
# declaration in a third place is a third thing to keep current -- and these headers cannot drift
# from the sections, because they ARE the sections.
#
# IT IS REGISTERED ABOVE THE if ($Fast) BLOCK because it is a static read of two files, not a run of
# the suite. The suite itself is a spawned one and does not run in -Fast, which is exactly why this
# must: the row is edited far more often than the sections are.
Invoke-Check 'seats.two-seat-row-matches-suite' {
    $doc = Join-Path $workspace 'docs/seats.md'
    $suite = Join-Path $PSScriptRoot 'Test-TwoSeatAcceptance.ps1'
    foreach ($required in @($doc, $suite)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "$required is missing; the two-seat gate row has nothing to compare against." }
    }

    $rowLines = @([IO.File]::ReadAllLines($doc) | Where-Object { $_.StartsWith('| `desk.two-seat-acceptance` |') })
    if (@($rowLines).Count -ne 1) {
        throw "expected exactly one ``desk.two-seat-acceptance`` row in docs/seats.md, found $(@($rowLines).Count); this check no longer reads the row it is about."
    }
    # `**<id>**` is the row's own mark for "this credit is section N". A credit written without one
    # is invisible to this comparison, which is why the row says in as many words that it carries one
    # entry per section -- and why a prose credit with no id is caught by the emptiness guard below
    # only if EVERY id goes, so the wording of that sentence is load-bearing.
    $rowSections = @([regex]::Matches($rowLines[0], '\*\*([0-9]+[a-z]?)\*\*') | ForEach-Object { $_.Groups[1].Value })
    $suiteSections = @([regex]::Matches([IO.File]::ReadAllText($suite), '(?m)^\s*#\s*---\s*([0-9]+[a-z]?)\.\s') | ForEach-Object { $_.Groups[1].Value })

    if (-not $rowSections.Count) { throw 'the two-seat gate row names no sections at all; this check read nothing rather than proving anything.' }
    if (-not $suiteSections.Count) { throw 'Test-TwoSeatAcceptance.ps1 carries no numbered section headers; this check read nothing rather than proving anything.' }

    $problems = [Collections.Generic.List[string]]::new()
    foreach ($duplicated in @($rowSections | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })) {
        [void]$problems.Add("the gate row names section $duplicated more than once")
    }
    foreach ($duplicated in @($suiteSections | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })) {
        [void]$problems.Add("Test-TwoSeatAcceptance.ps1 has two sections numbered $duplicated, so the row cannot render both")
    }
    $credited = @($rowSections | Sort-Object -Unique)
    $exercised = @($suiteSections | Sort-Object -Unique)
    $overCredited = @($credited | Where-Object { $exercised -cnotcontains $_ })
    $unreported = @($exercised | Where-Object { $credited -cnotcontains $_ })
    if ($overCredited.Count) {
        [void]$problems.Add("the gate row credits section(s) $($overCredited -join ', '), which the suite does not have: a reader sizing their risk from docs/seats.md is reading a guarantee nothing holds")
    }
    if ($unreported.Count) {
        [void]$problems.Add("section(s) $($unreported -join ', ') of the suite are absent from the gate row, so the gate holds more than docs/seats.md says it does")
    }

    if ($problems.Count) { throw ($problems -join '; ') }
    "$($credited.Count) section(s) credited in the docs/seats.md gate row and $($exercised.Count) in Test-TwoSeatAcceptance.ps1, sets equal both ways"
}

# --- The seat model's vocabulary is defined in the glossary, not invented in code ------------------
#
# ADR-0015's own consequence says it: "a domain term cannot enter the code ahead of the glossary",
# and nothing enforced it. ADR-0018 adds three more terms the seat code is about to depend on --
# Binding, Claim holder, Seat incarnation -- and a later trim of CONTEXT.md would leave the code
# naming vocabulary the project no longer defines, with every link still resolving and every other
# check still green. That is `docs.links-resolve`'s standing limit: prose is proven REACHABLE, never
# proven present.
#
# READ FROM THE DECLARATION, the way desk.claim-coverage and desk.lock-order already are. LibrarySeat.ps1
# declares which glossary terms the seat model rests on; CONTEXT.md is the authority for what they
# mean. A term declared here and absent there is the defect.
#
# WHAT IT CANNOT SEE, stated rather than implied. It proves each term has a glossary entry with an
# `_Avoid_` line -- the shape every entry in that file has -- and nothing about whether the
# definition is any good, or whether a seat term exists in the glossary that the code forgot to
# declare. The second direction is not detectable: nothing in CONTEXT.md marks an entry as belonging
# to the seat model.
Invoke-Check 'context.seat-vocabulary' {
    $seatFile = Join-Path $PSScriptRoot 'LibrarySeat.ps1'
    if (-not (Test-Path -LiteralPath $seatFile -PathType Leaf)) { throw 'tools/LibrarySeat.ps1 is missing; the seat vocabulary has no declaration.' }
    . $seatFile
    $declared = @(Get-SeatVocabulary)
    if ($declared.Count -lt 1) { throw 'Get-SeatVocabulary declares no term; this check would pass vacuously.' }

    $contextPath = Join-Path $workspace 'CONTEXT.md'
    if (-not (Test-Path -LiteralPath $contextPath -PathType Leaf)) { throw 'CONTEXT.md is missing; the glossary is the only authority for these terms.' }
    # ReadAllText and a multiline pattern, not a line-at-a-time read: an entry is a bold term, then
    # its definition over as many lines as it takes, then an `_Avoid_` line, then a blank line. The
    # body is captured up to the next blank line, which is what separates every entry from the next.
    $text = [IO.File]::ReadAllText($contextPath)
    $entries = @{}
    foreach ($match in [regex]::Matches($text, '(?ms)^\*\*(?<name>[^*\r\n]+)\*\*:\r?\n(?<body>.*?)(?=\r?\n\r?\n|\z)')) {
        $entries[$match.Groups['name'].Value] = $match.Groups['body'].Value
    }
    if ($entries.Count -lt $declared.Count) { throw "CONTEXT.md parsed as $($entries.Count) glossary entr(ies), fewer than the $($declared.Count) declared; the entry shape changed and this check can no longer read it." }

    $problems = [Collections.Generic.List[string]]::new()
    foreach ($term in $declared) {
        if (-not $entries.ContainsKey($term)) {
            [void]$problems.Add("the seat model names '$term' and CONTEXT.md does not define it; define it there or stop declaring it in Get-SeatVocabulary")
            continue
        }
        $body = [string]$entries[$term]
        if ([string]::IsNullOrWhiteSpace($body)) { [void]$problems.Add("CONTEXT.md's '$term' entry has no definition") ; continue }
        if ($body -cnotmatch '(?m)^_Avoid_:') { [void]$problems.Add("CONTEXT.md's '$term' entry carries no _Avoid_ line, so the words it displaces are undeclared") }
    }
    if ($problems.Count) { throw ($problems -join '; ') }
    "$($entries.Count) glossary entr(ies); the $($declared.Count) term(s) the seat model rests on are all defined with an _Avoid_ line"
}

# --- The always-on instruction surface ------------------------------------------------------------
# Two ceilings, because one file's budget cannot see the whole cost. CLAUDE.md keeps the 900-word
# limit the plan locked; the combined ceiling covers every other surface that also loads at launch,
# so relieving CLAUDE.md by moving words into a Skill description is honest rather than a shell game.
#
# Counted, because it loads every session whether or not it is used:
#   CLAUDE.md                            in full, and re-injected after a /compact
#   .claude/skills/*/SKILL.md            the frontmatter description only; the body loads on demand
#   .claude/rules/*.md with no paths:    at launch, same priority as CLAUDE.md
#
# Not counted:
#   .claude/rules/*.md with paths:       only when Claude reads a file the pattern matches
#   block-level HTML comments            stripped before injection, so they cost nothing
#
# @path imports are deliberately absent and must stay absent. They load at launch, so importing a
# section moves its words out of this count without moving any of its cost -- it would pass this
# check while changing nothing. If this budget ever binds, move words to a path-scoped rule or a
# Skill body, never to an import.
Invoke-Check 'context.always-on-budget' {
    $fileBudget = 900
    $totalBudget = 1100
    $warnFraction = 0.9

    function Measure-InstructionWords([string]$Text) {
        # Same tokenizer the plan named: whitespace-separated non-empty tokens, after removing the
        # comments that never reach the context window.
        $loaded = [regex]::Replace([string]$Text, '(?s)<!--.*?-->', ' ')
        @($loaded -split '\s+' | Where-Object { $_ }).Count
    }

    $parts = [Collections.Generic.List[object]]::new()

    $claudeMd = Join-Path $workspace 'CLAUDE.md'
    if (-not (Test-Path -LiteralPath $claudeMd -PathType Leaf)) { throw 'CLAUDE.md is missing.' }
    $fileWords = Measure-InstructionWords (Get-Content -LiteralPath $claudeMd -Raw)
    [void]$parts.Add([pscustomobject]@{ name = 'CLAUDE.md'; words = $fileWords })

    # A Skill costs its name and description in every session; only the body is on demand.
    $skillsRoot = Join-Path $workspace '.claude/skills'
    if (Test-Path -LiteralPath $skillsRoot -PathType Container) {
        foreach ($skill in @(Get-ChildItem -LiteralPath $skillsRoot -Filter 'SKILL.md' -File -Recurse | Sort-Object FullName)) {
            $text = Get-Content -LiteralPath $skill.FullName -Raw
            $frontmatter = [regex]::Match($text, '(?ms)\A---\r?\n(.*?)^---\r?\n')
            if (-not $frontmatter.Success) { continue }
            $description = [regex]::Match($frontmatter.Groups[1].Value, '(?ms)^description:[ \t]*(.*?)(?=^[A-Za-z_][\w-]*:|\z)')
            if (-not $description.Success) { continue }
            [void]$parts.Add([pscustomobject]@{
                name  = "skill:$(Split-Path -Leaf (Split-Path -Parent $skill.FullName))"
                words = Measure-InstructionWords $description.Groups[1].Value
            })
        }
    }

    # A rule with no paths: frontmatter loads at launch and is therefore part of the surface.
    # One definition of the list-item pattern, proved below against both line endings. A list parsed
    # one line at a time is the third defect family: a `[ \t]*$` tail matches nothing on a CRLF file,
    # so a valid rule would parse to zero patterns and throw the "declares paths: with no patterns"
    # error on a file that is perfectly correct. The probe shares this exact regex, so a future edit
    # cannot quietly drift the parser away from the case it is meant to handle.
    $rulePatternRegex = '(?m)^[ \t]*-[ \t]*["'']?([^"''\r\n]+?)["'']?[ \t]*\r?$'
    foreach ($probe in @(
        [pscustomobject]@{ label = 'LF';   text = "  - `"a/**`"`n  - `"b/**`"`n" }
        [pscustomobject]@{ label = 'CRLF'; text = "  - `"a/**`"`r`n  - `"b/**`"`r`n" }
    )) {
        $hits = @([regex]::Matches($probe.text, $rulePatternRegex) | ForEach-Object { $_.Groups[1].Value })
        if ($hits.Count -ne 2 -or $hits[0] -cne 'a/**' -or $hits[1] -cne 'b/**') {
            throw "the paths: list parser fails on $($probe.label) input"
        }
    }

    $rulesRoot = Join-Path $workspace '.claude/rules'
    if (Test-Path -LiteralPath $rulesRoot -PathType Container) {
        foreach ($rule in @(Get-ChildItem -LiteralPath $rulesRoot -Filter '*.md' -File -Recurse | Sort-Object FullName)) {
            $text = Get-Content -LiteralPath $rule.FullName -Raw
            $frontmatter = [regex]::Match($text, '(?ms)\A---\r?\n(.*?)^---\r?\n')
            $paths = if ($frontmatter.Success) { [regex]::Match($frontmatter.Groups[1].Value, '(?ms)^paths:[ \t]*\r?\n(.*?)(?=^[A-Za-z_][\w-]*:|\z)') } else { $null }
            if ($null -eq $paths -or -not $paths.Success) {
                [void]$parts.Add([pscustomobject]@{ name = "rule:$($rule.Name)"; words = Measure-InstructionWords $text })
                continue
            }

            # A path-scoped rule costs nothing at launch, which also means an unreachable pattern
            # leaves it silently inert -- the same shape as 0.5's launch validation, which reported
            # a fault that was always false for a whole phase and gated its own hook check behind it.
            # Whether the client LOADS the rule is not answerable from here; whether its patterns
            # name anything real in this workspace is, and that is the likelier way to lose one.
            $patterns = @([regex]::Matches($paths.Groups[1].Value, $rulePatternRegex) |
                ForEach-Object { $_.Groups[1].Value })
            if (-not $patterns.Count) { throw "$($rule.Name) declares paths: with no patterns under it" }
            foreach ($pattern in $patterns) {
                $literal = @($pattern -split '[*?\[]')[0].TrimEnd('/')
                if ([string]::IsNullOrWhiteSpace($literal)) { continue }
                if (-not (Test-Path -LiteralPath (Join-Path $workspace $literal))) {
                    throw "$($rule.Name) is scoped to '$pattern', which matches nothing in this workspace"
                }
            }
        }
    }

    $total = 0
    foreach ($part in $parts) { $total += $part.words }

    if ($fileWords -gt $fileBudget) { throw "CLAUDE.md is $fileWords words, over its $fileBudget-word budget by $($fileWords - $fileBudget)" }
    if ($total -gt $totalBudget) {
        $breakdown = @($parts | ForEach-Object { "$($_.name) $($_.words)" }) -join ', '
        throw "the always-on surface is $total words, over the $totalBudget-word budget by $($total - $totalBudget): $breakdown"
    }

    $summary = "CLAUDE.md $fileWords/$fileBudget, all always-on $total/$totalBudget words"
    if ($fileWords -ge [int]($fileBudget * $warnFraction) -or $total -ge [int]($totalBudget * $warnFraction)) {
        return "WARN: $summary -- within $([int](100 - $warnFraction * 100))% of a ceiling; move words to a path-scoped rule or a Skill body, never to an @import"
    }
    $summary
}

# --- docs/ relative links resolve ------------------------------------------------------------------
Invoke-Check 'docs.links-resolve' {
    $broken = [Collections.Generic.List[string]]::new()
    $roots = @($workspace, (Join-Path $workspace 'docs'))
    $files = @(Get-ChildItem -LiteralPath (Join-Path $workspace 'docs') -Filter '*.md' -File -Recurse)
    $files += @(Get-ChildItem -LiteralPath $workspace -Filter '*.md' -File)
    foreach ($file in $files) {
        $text = Get-Content -LiteralPath $file.FullName -Raw
        foreach ($m in [regex]::Matches($text, '\]\(([^)#:]+\.md)(?:#[^)]*)?\)')) {
            $target = $m.Groups[1].Value
            $resolved = Join-Path (Split-Path -Parent $file.FullName) $target
            if (-not (Test-Path -LiteralPath $resolved)) {
                [void]$broken.Add("$($file.Name) -> $target")
            }
        }
    }
    if ($broken.Count) { throw "broken link(s): $($broken -join '; ')" }
    "$($files.Count) files scanned, all links resolve"
}

# --- Every ADR on disk is reachable from the docs index -------------------------------------------
#
# WHY THIS IS NOT docs.links-resolve. That check proves a link that EXISTS points at something real;
# it is structurally unable to see a record nobody linked at all. ADR-0022, 0023 and 0024 were each
# written, committed and passed by a green gate with no index line, and three in a row went
# unnoticed because the only surface that would have shown the gap is the index itself. A decision
# record the reader cannot find is a decision that gets re-litigated -- which is exactly what
# happened to the `excluded` question on 2026-09-15.
#
# BOTH DIRECTIONS AND NEVER A COUNT, the rule skill.library-help-pointers-resolve already records
# for a list standing for a set. A missing entry and a stale one naming a deleted record are
# different faults, and a count would pass while one was swapped for the other.
Invoke-Check 'docs.adr-index-is-complete' {
    $adrRoot = Join-Path $workspace 'docs/adr'
    if (-not (Test-Path -LiteralPath $adrRoot -PathType Container)) { throw 'docs/adr is missing.' }
    $onDisk = @(@(Get-ChildItem -LiteralPath $adrRoot -Filter '*.md' -File) | ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
    if (-not $onDisk.Count) { throw 'docs/adr holds no ADR, so this check has no subject.' }
    $indexText = [IO.File]::ReadAllText((Join-Path $workspace 'docs/_index.md'), [Text.UTF8Encoding]::new($false, $true))
    $linked = @(@([regex]::Matches($indexText, '\]\(adr/([^)#]+\.md)')) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -CaseSensitive -Unique)
    $missing = @($onDisk | Where-Object { $linked -cnotcontains $_ })
    $stale = @($linked | Where-Object { $onDisk -cnotcontains $_ })
    if ($missing.Count) { throw "docs/_index.md links no entry for: $($missing -join ', ')" }
    if ($stale.Count) { throw "docs/_index.md links ADR(s) that are not on disk: $($stale -join ', ')" }
    "all $($onDisk.Count) ADRs are linked from docs/_index.md, and every ADR link resolves to one"
}

# --- The library-help Skill can actually be reached, in both directions ---------------------------
#
# WHY THIS IS SEPARATE FROM docs.links-resolve. That check walks `docs/` and the repository root,
# so it never opens `.claude/skills/`, and it proves a link RESOLVES rather than that a set is
# COMPLETE. The Skill is the reader's help surface: a reference file it stops naming is a guide
# nothing loads, and a broken `../../../docs/` hop is a pointer that reads fine in the source and
# dead-ends at use. Neither failure is loud, which is the argument for checking it at all.
#
# BOTH DIRECTIONS, THREE TIMES, AND NEVER A COUNT -- the rule .claude/rules/library-development.md
# already records for a list standing for a table. A missing entry and a stale entry are different
# faults and only one of them is loud:
#
#   1. every relative .md link out of the Skill resolves (missing target);
#   2. the reference files on disk and the reference files SKILL.md names are THE SAME SET;
#   3. the reader guides listed under `## Guides` in docs/_index.md and the ones SKILL.md offers
#      under `## Guides to hand the reader` are THE SAME SET.
#
# `docs/_index.md` is the declaration for (3) rather than a literal here, so adding a guide to the
# index and forgetting the Skill fails, and so does the reverse.
Invoke-Check 'skill.library-help-pointers-resolve' {
    $skillRoot = Join-Path $workspace '.claude/skills/library-help'
    $skillFile = Join-Path $skillRoot 'SKILL.md'
    if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) {
        throw 'the library-help Skill is missing its SKILL.md; nothing can load the reader help surface'
    }
    $skillText = Get-Content -LiteralPath $skillFile -Raw
    $problems = [Collections.Generic.List[string]]::new()

    # --- 1. Every relative .md link out of the Skill resolves. --------------------------------------
    $skillFiles = @(Get-ChildItem -LiteralPath $skillRoot -Filter '*.md' -File -Recurse)
    foreach ($file in $skillFiles) {
        $text = Get-Content -LiteralPath $file.FullName -Raw
        foreach ($m in [regex]::Matches($text, '\]\(([^)#:]+\.md)(?:#[^)]*)?\)')) {
            $target = $m.Groups[1].Value
            $resolved = Join-Path (Split-Path -Parent $file.FullName) $target
            if (-not (Test-Path -LiteralPath $resolved)) {
                [void]$problems.Add("$($file.Name) -> $target does not resolve")
            }
        }
    }

    # --- 2. The reference set, derived from disk and from SKILL.md, compared both ways. -------------
    $referencesDir = Join-Path $skillRoot 'references'
    $onDisk = @()
    if (Test-Path -LiteralPath $referencesDir -PathType Container) {
        $onDisk = @(Get-ChildItem -LiteralPath $referencesDir -Filter '*.md' -File | ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
    }
    $named = @([regex]::Matches($skillText, 'references/([A-Za-z0-9_.-]+\.md)') |
        ForEach-Object { $_.Groups[1].Value } | Sort-Object -CaseSensitive -Unique)
    if (-not $onDisk.Count) { throw 'the library-help Skill has no reference files; this check would pass vacuously' }
    foreach ($name in $onDisk) {
        if ($named -cnotcontains $name) {
            [void]$problems.Add("references/$name exists but SKILL.md never names it, so nothing loads it")
        }
    }
    foreach ($name in $named) {
        if ($onDisk -cnotcontains $name) {
            [void]$problems.Add("SKILL.md names references/$name, which is not on disk")
        }
    }

    # --- 3. The reader guides, derived from docs/_index.md, compared both ways. ---------------------
    #
    # THE INDEX IS THE DECLARATION. A guide is reader-facing because `## Guides` says so, and the
    # Skill is how a session hands one over -- so a guide in one and not the other is a guide the
    # reader cannot be given, or a pointer to something no longer offered.
    $indexFile = Join-Path $workspace 'docs/_index.md'
    if (-not (Test-Path -LiteralPath $indexFile -PathType Leaf)) { throw 'docs/_index.md is missing' }
    $indexText = Get-Content -LiteralPath $indexFile -Raw
    $indexGuidesSection = [regex]::Match($indexText, '(?ms)^##\s+Guides\s*$(.*?)(?=^##\s|\z)')
    if (-not $indexGuidesSection.Success) {
        throw 'docs/_index.md has no "## Guides" section, so there is no declaration of what the reader guides are'
    }
    # THE DECLARATION IS THE BULLET LIST, NOT EVERY LINK IN THE SECTION. Both sections open with a
    # sentence of prose that may itself link -- the index's names `guides/README.md`, the folder's own
    # front page -- and scooping those up makes a fifth "guide" that the other side can never carry.
    # Measured rather than reasoned about: this check failed on exactly that, one edit after it was
    # written. So a guide is a LIST ITEM, which is what the eye reads as the list too.
    #
    # BOTH SIDES ARE THEN NORMALISED TO A docs/-RELATIVE PATH, so the two sets are comparable at all:
    # the index links `guides/x.md` and the Skill links `../../../docs/guides/x.md`.
    $indexGuides = @([regex]::Matches($indexGuidesSection.Groups[1].Value, '(?m)^[*-]\s+\[[^\]]*\]\(([A-Za-z0-9_./-]+\.md)\)') |
        ForEach-Object { $_.Groups[1].Value } | Sort-Object -CaseSensitive -Unique)
    if (-not $indexGuides.Count) { throw 'docs/_index.md "## Guides" lists nothing; this half would pass vacuously' }

    # AND A READER GUIDE LIVES UNDER docs/guides/, ruled 2026-09-11 by Eric after getting lost in
    # `docs/`. The four guides were scattered alphabetically among forty design records, which is a
    # navigation fault and a currency one: a guide has to stay current and a design record is a dated
    # snapshot that is SUPPOSED to freeze, so filing them together applies the wrong maintenance
    # expectation to both. Checked here because the next guide will otherwise be dropped loose into
    # `docs/` and re-create it -- the failure is silent, and it is silent in the reader's direction.
    foreach ($guide in $indexGuides) {
        if (-not $guide.StartsWith('guides/')) {
            [void]$problems.Add("docs/_index.md lists docs/$guide as a reader guide, but a reader guide belongs under docs/guides/ where someone browsing the folder will find it")
        }
    }

    $skillGuidesSection = [regex]::Match($skillText, '(?ms)^##\s+Guides to hand the reader\s*$(.*?)(?=^##\s|\z)')
    if (-not $skillGuidesSection.Success) {
        throw 'SKILL.md has no "## Guides to hand the reader" section, so a session is never told the reader guides exist'
    }
    $skillGuides = @([regex]::Matches($skillGuidesSection.Groups[1].Value, '(?m)^[*-]\s+\[[^\]]*\]\(\.\./\.\./\.\./docs/([A-Za-z0-9_./-]+\.md)\)') |
        ForEach-Object { $_.Groups[1].Value } | Sort-Object -CaseSensitive -Unique)
    if (-not $skillGuides.Count) { throw 'SKILL.md "## Guides to hand the reader" lists nothing; this half would pass vacuously' }
    foreach ($guide in $indexGuides) {
        if ($skillGuides -cnotcontains $guide) {
            [void]$problems.Add("docs/_index.md offers docs/$guide as a reader guide and SKILL.md does not, so no session will hand it over")
        }
    }
    foreach ($guide in $skillGuides) {
        if ($indexGuides -cnotcontains $guide) {
            [void]$problems.Add("SKILL.md offers docs/$guide as a reader guide and docs/_index.md's ## Guides does not list it")
        }
    }

    if ($problems.Count) { throw ($problems -join '; ') }
    "$($skillFiles.Count) Skill files, $($onDisk.Count) references and $($indexGuides.Count) reader guides all reachable both ways"
}

# --- The pre-commit gate must actually be installed -----------------------------------------------
# Git hooks are not cloned, so a tracked hook file proves nothing on its own: core.hooksPath has to
# point at it. Without both, settings validation silently stops running before commits.
Invoke-Check 'git.pre-commit-installed' {
    $hookFile = Join-Path $workspace '.githooks/pre-commit'
    if (-not (Test-Path -LiteralPath $hookFile -PathType Leaf)) { throw '.githooks/pre-commit is missing.' }
    $configured = (& git -C $workspace config --get core.hooksPath 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($configured)) {
        throw 'core.hooksPath is not set. Run: git config core.hooksPath .githooks'
    }
    $configured = $configured.Trim()
    if ($configured -ne '.githooks') { throw "core.hooksPath is '$configured', expected '.githooks'" }
    'tracked and installed'
}

# --- 2.6: the rule every retrieval answer closes on ----------------------------------------------
#
# WHAT THIS CAN PROVE, AND WHAT IT CANNOT. Plan item 0.1 asks for an acceptance test proving the
# Librarian recommends opening and does not answer from a heading. That is a claim about a MODEL'S
# BEHAVIOUR, and this gate is offline PowerShell -- it cannot observe a reply, so it cannot gate one.
# Pretending otherwise would be the exact failure this codebase has already paid for twice: a check
# that documentation satisfies, standing in for the enforcement it was named after.
#
# So the split is drawn explicitly. ENFORCED: every tier's rendered answer still closes on the rule,
# from ONE source, and all three reader-facing surfaces still carry it -- a future change that drops
# the rule from a renderer, from the voice doc, from the Skill, or from CLAUDE.md fails here rather
# than shipping. A RULE ONLY, ungated and recorded as such: whether the Librarian obeys it. The
# reasoning and the known limit are in docs/hit-is-a-location.md.
#
# The render half is not redundant with the tier suites. book-fulltext and raw-search each assert
# their own closing line; book-discovery asserted NOTHING about its own, which is how three tiers
# ended up stating one rule three different ways. This is the check that ties them together.
Invoke-Check 'retrieval.hit-is-a-location' {
    . (Join-Path $PSScriptRoot 'BookDiscovery.ps1')
    . (Join-Path $PSScriptRoot 'BookFullText.ps1')
    . (Join-Path $PSScriptRoot 'RawSearch.ps1')
    $stem = $script:SearchHitRuleStem
    if ([string]::IsNullOrWhiteSpace($stem)) { throw 'SearchBoundaries.ps1 declares no hit rule stem.' }

    # 1. The three surfaces a reader or the Librarian can meet the rule on.
    $surfaces = @('CLAUDE.md', 'docs/librarian-voice-and-wayfinding.md', '.claude/skills/library-help/SKILL.md')
    $silent = [Collections.Generic.List[string]]::new()
    foreach ($relative in $surfaces) {
        $path = Join-Path $workspace $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "$relative is missing." }
        if ([IO.File]::ReadAllText($path).IndexOf($stem, [StringComparison]::OrdinalIgnoreCase) -lt 0) { [void]$silent.Add($relative) }
    }
    if ($silent.Count) { throw "the hit-is-a-location rule is absent from: $($silent -join ', ')" }

    # 2. Every tier still closes on it. Rendered from a real EMPTY answer, because an answer with no
    # results is where a closing rule is most easily lost and most needed -- absence is exactly the
    # shape a reader is likeliest to over-read.
    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('hit-rule-' + [guid]::NewGuid().ToString('N'))
    try {
        $utf8 = [Text.UTF8Encoding]::new($false)
        foreach ($directory in @('.claude', 'shelf/probe/wiki', 'raw/probe-batch')) {
            New-Item -ItemType Directory -Path (Join-Path $fixture $directory) -Force | Out-Null
        }
        # The fixture's own Desk. Passed explicitly below rather than resolved from LIBRARY_SEAT:
        # the gate runs from the pre-commit hook, which has no seat, and a check that needed one
        # would fail for every commit while passing for every interactive run.
        $probeDesk = Initialize-FixtureDesk -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture'
        [IO.File]::WriteAllText((Join-Path $fixture 'shelf/_catalog.md'), "# Shelf`n`n## Probe Book`n`n- **Path:** shelf/probe`n- **Kind:** reference`n", $utf8)
        [IO.File]::WriteAllText((Join-Path $fixture 'shelf/probe/wiki/_book.md'), "# Probe Book`n`nnothing here`n", $utf8)
        [IO.File]::WriteAllText((Join-Path $fixture 'raw/probe-batch/a.md'), "nothing here`n", $utf8)

        $term = 'zzqqxxnothingmatchesthis'
        $rendered = @(
            [pscustomobject]@{ tier = 'discovery'; text = (Format-DiscoveryResult (Find-BookPages -Workspace $fixture -Query $term -DeskStateDirectory $probeDesk)) }
            [pscustomobject]@{ tier = 'book';      text = (Format-FullTextResult (Find-OpenBookLines -Workspace $fixture -Query $term -DeskStateDirectory $probeDesk)) }
            [pscustomobject]@{ tier = 'raw';       text = (Format-RawSearchResult (Find-RawBatchLines -Workspace $fixture -Batch 'probe-batch' -Query $term)) }
        )
        $wrong = [Collections.Generic.List[string]]::new()
        foreach ($answer in $rendered) {
            $expected = Get-SearchClosingRule $answer.tier
            if ($expected.IndexOf($stem, [StringComparison]::Ordinal) -lt 0) { [void]$wrong.Add("$($answer.tier): its rule does not state the shared stem"); continue }
            $last = @(@($answer.text -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -Last 1)
            $lastLine = if ($last.Count) { [string]$last[0] } else { '' }
            if ($lastLine -cne $expected) { [void]$wrong.Add("$($answer.tier): its answer does not close on the rule (last line: '$lastLine')") }
        }
        if ($wrong.Count) { throw ($wrong -join '; ') }
        "3 tiers close on the rule; $($surfaces.Count) always-on surfaces carry it -- behaviour itself is a rule, not a gate"
    }
    finally {
        if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
# --- Library vocabulary must win over generic coding-agent semantics ------------------------------
# THE INCIDENT THIS CLOSES, 2026-08-23. A session rooted here read "reset my workspace" as a Git
# working-tree cleanup, reported the branch clean, and left the Desk holding two Books and a Project
# Hub. Nothing was reset, and nothing said so.
#
# Two independent things have to hold, and a check asserting only the first would pass on a workspace
# that still gives the wrong answer: the surfaces a session actually reads must claim the reader's own
# wording, AND the helper that would do the work must disclaim Git at the moment of approval. So this
# check does both, and drives the helper rather than reading its source.
Invoke-Check 'reset.vocabulary-routes' {
    $surfaces = @('CLAUDE.md', 'CONTEXT.md', 'AGENTS.md', 'docs/librarian-operation-playbooks.md',
        '.claude/skills/library-help/SKILL.md')

    # BOTH PATTERNS MATCH ACROSS NEWLINES, AND THAT IS NOT INCIDENTAL. Every one of these surfaces
    # is hard-wrapped prose, so 'start fresh' and the evidence sentence genuinely straddle a line
    # break on four of the five. A literal IndexOf, or any line-at-a-time search, reports them
    # missing on exactly the files that carry them -- the third defect family in
    # .claude/rules/library-development.md, met head-on. Hence \s+ between every token, and
    # ReadAllText rather than Get-Content.
    $vocabularyRule = 'start\s+fresh'
    # Phrasing differs by surface deliberately -- one says `git status` where another says working
    # tree -- so this matches the CLAIM, not one sentence a legitimate rewrite would falsify.
    $evidenceRule = 'clean\s+(?:working tree|`?git status`?)\s+is\s+(?:never|not|no)\s+evidence'

    # THE PROSE TRIGGER, and the reason it is a gate check rather than a habit. Handoff was defined
    # as "the sweep that makes a reset safe", and that sentence is what made the Librarian OFFER it
    # when a reader said "reset". When Handoff collapsed into Triage on 2026-08-28, every line of
    # code survived the rename and the urgency did not: `triage` is a tidying verb. So the two
    # surfaces that carry the reset procedure must say it in words. Without this, the merge deletes
    # the safety prompt while passing every other check in this file.
    $triageFirstSurfaces = @('CONTEXT.md', 'docs/librarian-operation-playbooks.md')
    $triageFirstRule = 'triage\s+the\s+Notebook\s+first'

    $unclaimed = [Collections.Generic.List[string]]::new()
    $silent = [Collections.Generic.List[string]]::new()
    foreach ($relative in $surfaces) {
        $path = Join-Path $workspace $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "$relative is missing." }
        $text = [IO.File]::ReadAllText($path)
        if ($text -notmatch $vocabularyRule) { [void]$unclaimed.Add($relative) }
        if ($text -notmatch $evidenceRule) { [void]$silent.Add($relative) }
    }
    if ($unclaimed.Count) { throw "the reader's own reset wording is unclaimed on: $($unclaimed -join ', ')" }
    if ($silent.Count) { throw "nothing says a clean working tree is not evidence of a Reset on: $($silent -join ', ')" }

    $untriaged = [Collections.Generic.List[string]]::new()
    foreach ($relative in $triageFirstSurfaces) {
        $text = [IO.File]::ReadAllText((Join-Path $workspace $relative))
        if ($text -notmatch $triageFirstRule) { [void]$untriaged.Add($relative) }
    }
    if ($untriaged.Count) {
        throw "nothing tells the Librarian to triage the Notebook before a reset on: $($untriaged -join ', '). Triage is a tidying verb; the urgency Handoff carried lives only in this sentence."
    }

    # THE HELPER'S OWN PREFLIGHT, driven for real against a fixture. This is the sentence a reader
    # meets at the approval moment, and the advisories beside it are the thing that IS evidence, so
    # one run asserts both. In-process with & so these are real properties rather than parsed text.
    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('reset-routing-' + [guid]::NewGuid().ToString('n'))
    $callerSeat = $env:LIBRARY_SEAT
    # Saved as well as the seat: this check plants a fixture claim token, and clobbering the real
    # session's would leave the gate's own caller unable to mutate anything afterwards.
    $callerClaim = $env:LIBRARY_SEAT_CLAIM
    $env:LIBRARY_SEAT = 'fixture'
    $fixtureClaim = $null
    try {
        $utf8 = [Text.UTF8Encoding]::new($false)
        New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/topic') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $fixture '.claude') -Force | Out-Null
        # THROUGH Initialize-SeatForFixture, WHICH REGISTERS THE SEAT (2026-09-10). This fixture
        # used to make the Desk directory by hand, so it had a seat with no registry entry -- a
        # shape production cannot produce, since both creation routes write the entry inside the
        # same locked transaction. Reset target selection now asserts the acting seat IS registered,
        # because without an entry its incarnation resolves to '' and it would match every
        # pre-identity row in the ownership record. This fixture was day-one data for that refusal
        # in exactly the way the claim comment below records it being for the last one.
        . (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
        Initialize-SeatForFixture -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Project 'fixture' | Out-Null
        [IO.File]::WriteAllText((Join-Path $fixture 'notebook/_master-index.md'), "# Notebook`n", $utf8)
        [IO.File]::WriteAllText((Join-Path $fixture 'notebook/topic/note.md'), "# Note`n", $utf8)
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books') -Text "shelf/demo`n" | Out-Null
        Write-AtomicText -Path (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'projects') -Text "projects/demo`n" | Out-Null

        # THE FIXTURE HOLDS A CLAIM, because since 2026-09-09 the reset probes it BEFORE issuing the
        # plan. It used to assert below the preflight's `return`, so a claimless session was handed a
        # full quarantine plan it could not execute. This fixture was exactly such a session, which
        # is the day-one data a new refusal has to face: the tightened helper's first run failed
        # here, not in a suite. The token goes into the environment so the helper's own resolution
        # finds it exactly as a launched session's would.
        $fixtureClaim = Enter-SeatClaim -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture'
        $env:LIBRARY_SEAT_CLAIM = $fixtureClaim.token

        $resetPreflight = & (Join-Path $PSScriptRoot 'Reset-LocalNotebook.ps1') -WorkspacePath $fixture -Preflight
        if ($null -eq $resetPreflight) { throw 'the reset preflight returned nothing.' }
        if ([string]::IsNullOrWhiteSpace([string]$resetPreflight.plan_id)) { throw 'the reset preflight issued no plan_id for the reader to approve.' }
        $scope = [string]$resetPreflight.scope
        if ($scope -notmatch '(?i)no repository file is touched') { throw 'the reset preflight no longer says it touches no repository file.' }
        if ($scope -notmatch $evidenceRule) { throw 'the reset preflight no longer disclaims a clean working tree as evidence.' }
        # WHAT IS EVIDENCE: the Desk state the incident ignored. A preflight silent here would let
        # "the branch is clean" stand in for "the Desk is clear" all over again.
        if (@($resetPreflight.open_books_advisory) -cnotcontains 'shelf/demo') { throw 'the reset preflight did not report the open Book that a clean branch says nothing about.' }
        if (@($resetPreflight.open_projects_advisory) -cnotcontains 'projects/demo') { throw 'the reset preflight did not report the open Project Hub.' }
        if ($resetPreflight.confirmation_required -ne $true) { throw 'the reset preflight stopped requiring confirmation.' }
    }
    finally {
        # The handle is released before the directory goes, or the file cannot be deleted:
        # Enter-SeatClaim opens it with a share mode Windows still honours against removal.
        if ($null -ne $fixtureClaim) { Exit-SeatClaim -Claim $fixtureClaim }
        $env:LIBRARY_SEAT = $callerSeat
        $env:LIBRARY_SEAT_CLAIM = $callerClaim
        if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
    }

    "reset vocabulary routed on $($surfaces.Count) surfaces; the helper preflight issues a plan_id, disclaims Git and names the open Desk"
}

# --- The two briefing heading patterns that are mirrored rather than shared -----------------------
# Select-BriefingSectionsSource in tools/New-ProjectHub.ps1 decides whether a new Hub can leave both
# Connected headings off its root; Select-ReturnBriefingSections in the reader adapter decides which
# page the briefing then reads them from. They must agree exactly, and they cannot share code: the
# adapter performs its process setup at load, so it cannot be dot-sourced. So the seed carries a
# copy, verified byte-identical on 2026-08-26 -- and a copy nothing compares diverges silently, with
# the seed self-test still passing while the acceptance it exists to protect quietly breaks.
#
# Compared through the AST, not by matching source text, so a comment quoting a pattern cannot
# satisfy it. WHAT THIS CANNOT ENFORCE, stated rather than implied: it compares literal patterns. A
# side that composes its pattern by interpolation has none to compare, and this check fails loudly
# rather than passing on an empty match -- but it cannot tell you the composed result is equivalent.
Invoke-Check 'hub.briefing-regex-mirror' {
    $sites = @(
        [pscustomobject]@{ path = (Join-Path $workspace 'tools/New-ProjectHub.ps1'); name = 'Select-BriefingSectionsSource' },
        [pscustomobject]@{ path = (Join-Path $workspace '.claude/adapters/Validated-BookReader.ps1'); name = 'Select-ReturnBriefingSections' }
    )
    $found = @{}
    foreach ($site in $sites) {
        if (-not (Test-Path -LiteralPath $site.path -PathType Leaf)) { throw "$($site.path) is missing; the briefing heading patterns have no definition there." }
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($site.path), [ref]$null, [ref]$parseErrors)
        if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) { throw "$($site.path) does not parse." }
        $definitions = @($ast.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] }, $true) |
            Where-Object { $_.Name -ceq $site.name })
        if ($definitions.Count -ne 1) { throw "$($site.path) defines $($definitions.Count) copies of $($site.name); the mirror cannot be compared." }
        $patterns = @($definitions[0].FindAll({ $args[0] -is [Management.Automation.Language.StringConstantExpressionAst] }, $true) |
            ForEach-Object { [string]$_.Value } |
            Where-Object { $_ -cmatch '^\(\?m\)\^##' } |
            Sort-Object -CaseSensitive)
        if ($patterns.Count -ne 2) { throw "$($site.name) holds $($patterns.Count) literal heading patterns, not 2; one built by interpolation cannot be compared literally." }
        $found[$site.name] = $patterns
    }
    $mirror = $found['Select-BriefingSectionsSource']
    $original = $found['Select-ReturnBriefingSections']
    for ($i = 0; $i -lt 2; $i++) {
        if ($mirror[$i] -cne $original[$i]) {
            throw "The Hub seed mirrors the reader's briefing heading patterns and has diverged: New-ProjectHub.ps1 has '$($mirror[$i])' where the adapter has '$($original[$i])'."
        }
    }
    "both heading patterns identical: $($original -join '  ')"
}

# ADR-0003's dev Hub template. new-project-hub.selftest already asserts the RENDERING -- exact bodies,
# the byte-identical default, the credentials wording, and that a dev root still sends the briefing to
# the connections page. This check asserts the thing a self-test structurally cannot see: that the
# seed and the documentation still agree. The template is unenforced by design, so seed wording is the
# entire mechanism carrying its discipline, and wording that drifts away from the docs describing it
# is exactly how an unenforced convention rots without anything going red.
# ADR-0013. The Now seed is the only thing that tells a Hub author an item which cannot close does
# not belong on the root, and where each kind goes instead. It is the same class of guard as the
# credentials warning in the Repo seed: nothing validates what a reader types into a NAS-backed Hub,
# so the seed's wording IS the mechanism, and a reword that quietly drops a destination puts the
# growth straight back. Asserted against BOTH surfaces, because a seed that names a destination the
# design record does not describe is half a rule.
#
# What this deliberately does NOT do is judge live Hub content. No check can tell an open item from
# an accepted limit by reading it -- that is the author's call every time.
Invoke-Check 'hub.sections-name-their-destinations' {
    $hubPath = Join-Path $workspace 'tools/New-ProjectHub.ps1'
    $designPath = Join-Path $workspace 'docs/project-hub-design.md'
    $adrPath = Join-Path $workspace 'docs/adr/0013-a-hub-section-holds-only-what-the-project-can-close.md'
    foreach ($required in @($hubPath, $designPath, $adrPath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "$required is missing; the Hub section rule has no definition." }
    }
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($hubPath), [ref]$null, [ref]$parseErrors)
    if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) { throw 'tools/New-ProjectHub.ps1 does not parse.' }
    $definitions = @($ast.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] }, $true) |
        Where-Object { $_.Name -ceq 'New-ProjectRootBody' })
    if ($definitions.Count -ne 1) { throw "tools/New-ProjectHub.ps1 defines $($definitions.Count) copies of New-ProjectRootBody, not 1." }
    $seed = $definitions[0].Extent.Text

    # The rule, then each of the three destinations by name. Phrased as the claim rather than as one
    # sentence's punctuation, so a legitimate rewording still passes and a dropped destination fails.
    $required = [ordered]@{
        'the closable rule'      = 'closing condition this project can cause'
        'the notes destination'  = 'notes/'
        'the limits destination' = 'limits'
        'the decisions destination' = '## Decisions'
        'the guidance destination'  = 'own rules or docs'
    }
    $missing = [Collections.Generic.List[string]]::new()
    foreach ($name in @($required.Keys)) {
        if ($seed.IndexOf([string]$required[$name], [StringComparison]::Ordinal) -lt 0) { [void]$missing.Add($name) }
    }
    if ($missing.Count) { throw "the Now seed no longer names: $($missing -join ', '). Without a named destination an item that cannot close stays on the root, which is the growth ADR-0013 measured." }

    # The design record has to describe the same tier, or the seed is pointing somewhere undocumented.
    $design = [IO.File]::ReadAllText($designPath)
    foreach ($claim in @('closing condition the project can cause', 'limits` page', 'accepted', 'awaiting', 'promoted')) {
        if ($design.IndexOf($claim, [StringComparison]::Ordinal) -lt 0) {
            throw "docs/project-hub-design.md no longer describes '$claim', so the seed names a tier its own record does not define."
        }
    }

    # And the ledger page must stay size-exempt: capping it recreates the pressure that put accepted
    # limits in Now to begin with.
    $editorPath = Join-Path $workspace 'tools/Edit-ProjectHub.ps1'
    $editorSrc = [IO.File]::ReadAllText($editorPath)
    $editorAst = [Management.Automation.Language.Parser]::ParseInput($editorSrc, [ref]$null, [ref]$null)
    $exempt = @($editorAst.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] }, $true) |
        Where-Object { $_.Name -ceq 'Test-HubPageSizeExempt' })
    if ($exempt.Count -ne 1) { throw "tools/Edit-ProjectHub.ps1 defines $($exempt.Count) copies of Test-HubPageSizeExempt, not 1." }
    Invoke-Expression $exempt[0].Extent.Text
    foreach ($case in @(@('projects/x/limits.md', $true), @('projects/x/notes/y.md', $true), @('projects/x/_project.md', $false), @('projects/x/connections.md', $false))) {
        $actual = [bool](Test-HubPageSizeExempt $case[0])
        if ($actual -ne [bool]$case[1]) { throw "Test-HubPageSizeExempt('$($case[0])') returned $actual, expected $($case[1])." }
    }

    "the Now seed names all $(@($required.Keys).Count) destinations, the design record defines the tier, and limits/ is size-exempt"
}

Invoke-Check 'hub.dev-template-seeds-sections' {
    $hubPath = Join-Path $workspace 'tools/New-ProjectHub.ps1'
    $designPath = Join-Path $workspace 'docs/project-hub-design.md'
    $adrPath = Join-Path $workspace 'docs/adr/0003-decisions-follow-their-subject.md'
    foreach ($required in @($hubPath, $designPath, $adrPath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "$required is missing; the dev template and its record cannot be compared." }
    }
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($hubPath), [ref]$null, [ref]$parseErrors)
    if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) { throw 'tools/New-ProjectHub.ps1 does not parse.' }
    $definitions = @($ast.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] }, $true) |
        Where-Object { $_.Name -ceq 'New-ProjectDevSections' })
    if ($definitions.Count -ne 1) { throw "tools/New-ProjectHub.ps1 defines $($definitions.Count) copies of New-ProjectDevSections, not 1." }
    # The function's SOURCE TEXT, not its string constants. The headings live in an interpolated
    # string ("## Repo`n`n$repoSeed`n`n## Decisions..."), which is an ExpandableStringExpressionAst
    # and carries no .Value -- so a StringConstantExpressionAst sweep silently finds neither heading
    # and this check fails claiming the template dropped them. hub.briefing-regex-mirror hit the same
    # wall and documents it: "one built by interpolation cannot be compared literally."
    #
    # The trade this makes: extent text would also match a heading inside a comment in this function.
    # That is acceptable here because this check asserts seed-and-docs AGREEMENT, while
    # new-project-hub.selftest asserts what the function actually renders.
    $seed = $definitions[0].Extent.Text

    # The two section names the template promises. A rename here without a docs change is the drift
    # this check exists to catch.
    foreach ($heading in @('## Repo', '## Decisions')) {
        if ($seed -cnotmatch [regex]::Escape($heading)) { throw "New-ProjectDevSections no longer seeds '$heading'." }
    }
    # A seeded heading must never be one the return briefing selects on, or a dev Hub would pull the
    # briefing off its connections page. The self-test proves this for the current names; this proves
    # it survives a rename.
    foreach ($briefingHeading in @('## Connected knowledge', '## Connected tools')) {
        if ($seed -cmatch [regex]::Escape($briefingHeading)) { throw "New-ProjectDevSections seeds '$briefingHeading', which the return briefing selects on." }
    }
    $credentialWarning = 'sanitized remote URL -- no credentials or userinfo'
    if ($seed -cnotmatch [regex]::Escape($credentialWarning)) {
        throw "The Repo seed no longer carries its credentials warning verbatim. Nothing validates what a reader types into a NAS-backed Hub, so this wording is the whole guard."
    }
    # The omission rule, settled 2026-09-06 on the first subject with no repository of its own
    # (2nd-b-vault-dev: a working tree with a .gitignore and no .git). Without it the seed's five
    # git-shaped labels invite three `n/a` lines on a live Hub root, which reads as broken rather than
    # as deliberately short. The wording IS the mechanism here, exactly as the credentials warning is.
    if ($seed -cnotmatch 'Delete any label that does not apply') {
        throw 'The Repo seed no longer tells a reader to delete a label that does not apply. Without it a subject with no repository fills three of five labels with n/a on a live Hub root.'
    }
    if ($seed -cnotmatch 'remove a pointer when its decision is superseded') {
        throw 'The Decisions seed no longer carries the operative-pointers rule, without which the section reproduces the append-only growth the Now seed prevents.'
    }

    # The -Dev SWITCH must actually reach the body builder. Without this, deleting the argument at the
    # write site leaves the seed intact, the docs intact, and every self-test assertion green -- while
    # `New-ProjectHub.ps1 -Dev` quietly creates an ordinary Hub. The self-test cannot catch it because
    # it calls New-ProjectRootBody directly, and the preflight cannot be driven here because it needs
    # the NAS, so the wiring is asserted at the source.
    $rootBodyCalls = @($ast.FindAll({
        $args[0] -is [Management.Automation.Language.CommandAst] -and
        $args[0].GetCommandName() -ceq 'New-ProjectRootBody'
    }, $true) | Where-Object {
        @($_.FindAll({ $args[0] -is [Management.Automation.Language.VariableExpressionAst] -and $args[0].VariablePath.UserPath -ceq 'Dev' }, $true)).Count -gt 0
    })
    if ($rootBodyCalls.Count -lt 1) {
        throw 'No call to New-ProjectRootBody passes the -Dev switch. The template would render, the docs would agree, and every self-test would pass, while New-ProjectHub.ps1 -Dev created an ordinary Hub.'
    }
    # And the preflight must disclose the choice, because it is the only way to see what -Dev would
    # write without creating a Hub that nothing in this repository can delete.
    $hubSource = [IO.File]::ReadAllText($hubPath)
    foreach ($planField in @('dev_template', 'planned_root_sections')) {
        if ($hubSource -cnotmatch "(?m)^\s*$planField\s*=") { throw "The preflight plan no longer reports '$planField', so -Dev -Preflight cannot show what it would write." }
    }

    $design = [IO.File]::ReadAllText($designPath)
    foreach ($documented in @('## Repo', '## Decisions')) {
        if ($design -cnotmatch [regex]::Escape($documented)) { throw "docs/project-hub-design.md does not document '$documented'; the template seeds a section nothing describes." }
    }
    if ($design -cnotmatch 'subject') { throw 'docs/project-hub-design.md does not document the subject-follows rule the Decisions seed depends on.' }
    "dev seed and its documentation agree: 2 sections, credentials warning, operative-pointers rule"
}

# The repository root is a SHARED namespace, and `PLAN.md` is the name every plan-authoring skill
# defaults to. On 2026-08-31 a second product's plan -- Librarian 2.0, whose subject is a portable
# prompt set and not this workspace -- was found sitting in the working tree ON TOP of the Library's
# own 922-line plan, uncommitted, reduced to 113 lines. The repository was clean; one `git add -A`
# would have destroyed it, and roughly nineteen sources cite `PLAN.md` BY ITEM NUMBER as authoritative
# about the Library (`docs/discovery-manifests.md`, `docs/hit-is-a-location.md`,
# `docs/scoped-raw-search.md`, `tools/RawSearch.ps1`, `BookRootSchema.ps1`, and the reader adapter
# among them). `Rename-ShelfBook.ps1` even rewrites into `PLAN.md` as a Library self-file beside
# CLAUDE.md and CONTEXT.md.
#
# Nothing caught it. `docs.links-resolve` passes throughout, because the file EXISTS -- a link can
# resolve perfectly while the content it names has been replaced by another project's. This check
# closes that gap: it validates ownership, which is what a citation actually depends on.
#
# The convention already existed and two prior sessions followed it by hand
# (PLAN-token-efficiency.md, PLAN-dev-architecture.md); the third project ignored it, because a
# convention nothing enforces is a convention until it is inconvenient. Same shape as
# raw.batch-owners, and the owner is a Project Hub slug for the same reason.
Invoke-Check 'workspace.plans-declare-their-owner' {
    $plans = @(Get-ChildItem -LiteralPath $workspace -File -Filter 'PLAN*.md' | Sort-Object -Property Name)
    if ($plans.Count -eq 0) { return 'no root plan files' }
    $unqualified = @('PLAN.md', 'PLAN-REVIEW-LOG.md')
    $owners = [ordered]@{}
    foreach ($plan in $plans) {
        # ReadAllText, never Get-Content -Raw: these files carry em-dashes and most of this repo is
        # BOM-less, so 5.1 would decode them as ANSI. See .claude/rules/library-development.md.
        $text = [IO.File]::ReadAllText($plan.FullName)
        $match = [regex]::Match($text, '(?m)^>\s+\*\*Owner:\*\*\s+(?<slug>[a-z0-9][a-z0-9-]*)\s*\r?$')
        if (-not $match.Success) {
            throw "$($plan.Name) declares no owner. Add a '> **Owner:** <project-hub-slug>' line under its heading, so a plan for another project cannot silently occupy a name this repository cites."
        }
        $slug = $match.Groups['slug'].Value
        $owners[$plan.Name] = $slug
        # -cne, not -ne: a lowercase-only slug rule compared case-insensitively accepts Library-Dev
        # and travels on as a different owner that nothing else will match.
        if ($plan.Name -cin $unqualified -and $slug -cne 'library-dev') {
            throw "$($plan.Name) is owned by '$slug', but the unqualified plan names belong to this workspace. A plan whose subject is anything other than the Library must be namespaced -- PLAN-$slug.md -- because $($plan.Name) is what docs/ and tools/ cite by item number."
        }
    }
    foreach ($required in $unqualified) {
        if (-not $owners.Contains($required) -and (Test-Path -LiteralPath (Join-Path $workspace $required) -PathType Leaf)) {
            throw "$required exists but was not enumerated; the owner scan cannot vouch for it."
        }
    }
    $foreign = @($owners.Keys | Where-Object { $owners[$_] -cne 'library-dev' })
    $summary = "$($owners.Count) root plan file(s) declare an owner"
    if ($foreign.Count) { $summary += "; $($foreign.Count) belong to another project and are namespaced: $($foreign -join ', ')" }
    $summary
}

# The Library develops products that INSTALL THEMSELVES INTO A WORKSPACE ROOT, and this workspace is
# a root. Librarian 2.0 is the instance: a portable prompt set whose layer 2 writes `_triage.md` and
# `holding.md` beside a `CLAUDE.md` it also authors, then creates notebook/, shelf/ and books/. Run
# one of its bootstrap prompts with D:\Library as the working directory -- the obvious mistake, since
# that is where the Hub, the plan and the review skills all live -- and it overwrites the Library's
# own standing rules with the thing being developed. CLAUDE.md is tracked and would come back; the
# notebook and Shelf it would merge into are gitignored by design and would not.
#
# The plan-ownership check above catches a foreign product occupying a name this repository cites.
# It cannot catch this, because an installed `_triage.md` occupies no name the Library uses -- it is
# simply a file that has no business existing here.
#
# Named files, not a marker string, and deliberately: the design documents that would define a layer
# marker live in Librarian 2.0's own repository now, so a marker asserted here could go stale without
# this repository ever seeing the change. `_triage.md` and `holding.md` are load-bearing filenames in
# 2.0's install and are attested by its Hub. The CLAUDE.md assertion is the general half -- it does
# not care WHICH product overwrote the file, only that what remains still introduces this workspace.
Invoke-Check 'workspace.no-foreign-install' {
    # @() around the PIPELINE, not just the source literal: `@(a,b) | Where-Object` returns $null for
    # zero matches and a bare string for one, and .Count then throws instead of reading 0 or 1. The
    # first version of this check had exactly that defect and powershell.defect-families caught it.
    $installed = @(@('_triage.md', 'holding.md') |
        Where-Object { Test-Path -LiteralPath (Join-Path $workspace $_) -PathType Leaf })
    if ($installed.Count) {
        throw "$($installed -join ', ') at the repository root: a workspace-installing product was bootstrapped here. The Library is the foundry for those products, never a target -- install tests belong in a disposable sandbox. Remove these and check CLAUDE.md, notebook/ and shelf/ for merged content."
    }

    # ReadAllText, never Get-Content -Raw: BOM-less UTF-8 with em-dashes, which 5.1 decodes as ANSI.
    $claudeMd = Join-Path $workspace 'CLAUDE.md'
    if (-not (Test-Path -LiteralPath $claudeMd -PathType Leaf)) { throw 'CLAUDE.md is missing; this workspace no longer introduces itself.' }
    $text = [IO.File]::ReadAllText($claudeMd)
    foreach ($anchor in @('# The Librarian', 'You are the Librarian of **the Library**', '[CONTEXT.md](CONTEXT.md) is the glossary')) {
        if ($text -cnotmatch [regex]::Escape($anchor)) {
            throw "CLAUDE.md no longer carries '$anchor'. Either this workspace's standing rules were rewritten by another product's install, or the anchor was edited -- update this check deliberately if the latter."
        }
    }
    'no foreign install at the root; CLAUDE.md still declares this workspace'
}
# --- No helper stamps a known_limits on a published Book ------------------------------------------
# Until 2026-09-17 Publish-SharedBookCandidate.ps1 baked
# known_limits='Copied local notes. Refresh the source when current information matters.' into the
# metadata of every Book it published. It had ZERO consumers anywhere in the workspace, and it was
# FALSE on several of the 20 Books that carried it: unifi-network-admin was compiled from Ubiquiti's
# help centre, komodo-admin from an upstream docs site, basic-memory read at source. A field that
# says the same wrong thing on every Book reads as a per-Book judgement and is not, which is worse
# than no field at all -- and the mirror was about to put all 20 copies of it side by side in the
# 2nd_b vault, where the repetition is obvious in a way it never was one Book at a time.
#
# THE GUARD IS ON THE NAME, NOT ON THAT ONE SENTENCE. Re-authoring the field per Book was weighed
# against removing it and declined, because nothing reads it and every Book already states its real
# limits in _book.md prose or a sources-and-limits page. So a helper that reintroduces known_limits
# -- as a literal, a parameter, or a default -- should reopen that ruling deliberately rather than
# slide back in, and this check is where it is made to ask.
Invoke-Check 'books.no-hardcoded-known-limits' {
    $root = Join-Path $workspace 'tools'
    $sources = @(Get-ChildItem -LiteralPath $root -Filter '*.ps1' -File)
    if (-not $sources.Count) { throw 'no helpers found; this check''s discriminator has drifted' }
    $scanned = 0
    $findings = New-Object System.Collections.Generic.List[string]
    foreach ($source in $sources) {
        # A Test- helper may name the field to falsify this very check.
        if ($source.Name -cmatch '^Test-') { continue }
        $scanned++
        $body = [IO.File]::ReadAllText($source.FullName, [Text.UTF8Encoding]::new($false, $true))
        $lineNumber = 0
        foreach ($line in ($body -split "`r?`n")) {
            $lineNumber++
            # A COMMENT MAY NAME THE FIELD; ONLY CODE MAY NOT. The first version of this check had no
            # such exemption and its very first run failed on THIS FILE, line 2908 -- the comment
            # above explaining why known_limits was removed. Exempting the file would have hidden a
            # real reintroduction here later, so the exemption is a property of the LINE KIND instead:
            # a comment cannot stamp anything on a Book, and a here-string or assignment still is.
            #
            # AND THE PATTERN MATCHES AN ASSIGNMENT, NOT THE BARE WORD. With the bare word the check
            # failed on its own two code lines -- the pattern literal below and the finding message
            # beneath it -- so a clean tree and a tree with the regression re-injected came back
            # IDENTICALLY RED, which is a guard that cannot tell you anything. Requiring `=` or `:`
            # after the name matches how the field is actually stamped (`known_limits='...'` in a
            # metadata hashtable, `known_limits:` in frontmatter) and matches neither of those lines.
            if ($line -cmatch '^\s*#') { continue }
            if ($line -cmatch 'known_limits\s*[=:]') {
                [void]$findings.Add("$($source.Name):$lineNumber reintroduces known_limits")
            }
        }
    }
    if (-not $scanned) { throw 'no non-test helpers scanned; this check''s discriminator has drifted' }
    if ($findings.Count) { throw ($findings -join '; ') }
    "$scanned helper(s) stamp no known_limits"
}

# --- A reader map labels a page with its title, never with its path -------------------------------
# Until 2026-09-18 FIVE separate writers built a Book's reader map by labelling each link with the
# page PATH: Publish-BookCopy, Publish-SharedBookCandidate, Import-ExternalWikiToShelf, and both of
# ShelfNoteCommon's curated-map writers -- one of which carried the comment "The link shape matches
# both publishers exactly", which is how one defect stays consistent across a codebase. The reader
# map is the route every reader takes into a Book, since _book links to it and nothing else, so this
# was the single surface that read as a file listing. The Discovery manifest for the SAME page
# already held the title: `page-title: jellyfin -- Jellyfin` against a map saying `jellyfin.md`.
#
# THE RULE IS ABOUT THE LABEL SEGMENT, NOT ABOUT THOSE FIVE HELPERS. A sixth publisher is the likely
# way this returns, so the check reads every non-test helper rather than a fixed list. A label passes
# when it is a literal, or when it names somewhere a title legitimately comes from: Get-ReaderMapLabel,
# a `title`, a `heading`, or a `$Label` a caller supplies (Compile-RawBatchToNotebook's Add-IndexLink
# takes the article title that way).
Invoke-Check 'books.reader-map-labels-are-titles' {
    $root = Join-Path $workspace 'tools'
    $sources = @(Get-ChildItem -LiteralPath $root -Filter '*.ps1' -File)
    if (-not $sources.Count) { throw 'no helpers found; this check''s discriminator has drifted' }
    $linkPattern = '-\s*\[\[(?<target>[^\|\]]+)\|(?<label>[^\]]*)\]\]'
    $constructions = 0
    $wired = New-Object System.Collections.Generic.HashSet[string]
    $findings = New-Object System.Collections.Generic.List[string]
    foreach ($source in $sources) {
        # A Test- helper writes fixture maps by hand and may label them anything, including the
        # regression, to falsify this check.
        if ($source.Name -cmatch '^Test-') { continue }
        $lineNumber = 0
        $builds = $false
        $calls = $false
        foreach ($line in ([IO.File]::ReadAllText($source.FullName, [Text.UTF8Encoding]::new($false, $true)) -split "`r?`n")) {
            $lineNumber++
            # A comment may show the old shape -- the ones above this check and in ShelfNoteCommon
            # both quote `- [[<page>|<page>.md]]` to explain what was wrong. Only code may not.
            if ($line -cmatch '^\s*#') { continue }
            # The CALL, never the definition: ShelfNoteCommon declares the function and also uses it,
            # and only the second of those makes it a wired writer.
            if (($line -cmatch 'Get-ReaderMapLabel') -and ($line -cnotmatch '^\s*function\s')) { $calls = $true }
            foreach ($m in [regex]::Matches($line, $linkPattern)) {
                $constructions++
                $builds = $true
                $label = $m.Groups['label'].Value
                if ($label -notmatch '\$') { continue }
                # CASE-INSENSITIVE DELIBERATELY. The first version used -cmatch and failed on the
                # correctly fixed tree: every real label is $pageTitle, $Title or $BookTitle, and
                # none of those contains a lowercase 'title'. What the rule EXCLUDES is unchanged --
                # the five defect labels were `$_`, `$Page.md` and two .Substring() calls on a path,
                # and not one of them names a title, a heading or a label.
                if ($label -match 'Get-ReaderMapLabel|title|heading|label') { continue }
                [void]$findings.Add("$($source.Name):$lineNumber labels a reader-map link with '$label'")
            }
        }
        # The label segment is nearly always a variable assigned a line earlier, so wiring is a
        # property of the FILE -- it builds a reader-map link and it resolves labels through the
        # shared helper -- and not something readable out of the link construction itself. The first
        # version of this check looked inside the label and found zero wired helpers in a correctly
        # fixed tree.
        if ($builds -and $calls) { [void]$wired.Add($source.Name) }
    }
    if ($constructions -lt 10) { throw "only $constructions reader-map link construction(s) were read; the pattern has drifted" }
    # A POSITIVE DISCRIMINATOR, NOT ONLY AN ABSENCE. Deleting the Get-ReaderMapLabel calls would make
    # the findings list empty too, so the check would pass on the reverted code it exists to catch.
    if ($wired.Count -lt 4) { throw "only $($wired.Count) helper(s) label a reader-map link through Get-ReaderMapLabel; expected the four writers that build one from a page path" }
    if ($findings.Count) { throw ($findings -join '; ') }
    "$constructions reader-map link construction(s), $($wired.Count) through Get-ReaderMapLabel, none labelled with a path"
}

# --- The reader-map label and the manifest page title are the same answer -------------------------
# Get-ReaderMapLabel restates a rule BookManifest.ps1 already owns, and it does so deliberately: the
# manifest derives its title through Get-MarkdownHeadings, in a file that dot-sources ShelfNoteCommon,
# so calling it from there would resolve against whatever the entry point happened to load and
# Add-ShelfBookPage reaches the map writers with only ShelfNoteCommon loaded. A second copy of a small
# rule beats a function that exists on some call paths and not others -- but only if the copy is held
# to the original, which is what this does. Two surfaces disagreeing about a page's name is the whole
# defect being fixed, so it must not come back by drift.
Invoke-Check 'books.reader-map-label-matches-manifest-title' {
    . (Join-Path $PSScriptRoot 'BookManifest.ps1')
    if (-not (Get-Command Get-ReaderMapLabel -ErrorAction SilentlyContinue)) { throw 'Get-ReaderMapLabel is not defined; ShelfNoteCommon did not load' }
    if (-not (Get-Command Get-MarkdownHeadings -ErrorAction SilentlyContinue)) { throw 'Get-MarkdownHeadings is not defined; BookManifest did not load' }

    $long = 'L' * 340
    # Each case is shaped so that plausible WRONG code returns a plausible wrong value rather than
    # nothing: the fenced case hands a naive first-'# ' scan a heading out of a code block, and the
    # sub-heading case hands it a '## ' line it should have skipped.
    $cases = @(
        @{ name = 'plain H1';             path = 'jellyfin.md';                 text = "# Jellyfin`n`nBody." }
        @{ name = 'frontmatter then H1';  path = 'a.md';                        text = "---`ntitle: decoy`n---`n# Real Title`n`nBody." }
        @{ name = 'fenced decoy';         path = 'b.md';                        text = "``````text`n# Not A Title`n```````n`n# Actual Title`n" }
        @{ name = 'sub-heading first';    path = 'c.md';                        text = "## Section`n`n# The H1`n" }
        @{ name = 'trailing hashes';      path = 'd.md';                        text = "#   Spaced Title   ###`n" }
        @{ name = 'crlf';                 path = 'nested/e.md';                 text = "# CRLF Title`r`n`r`nBody.`r`n" }
        @{ name = 'over-long title';      path = 'f.md';                        text = "# $long`n" }
        @{ name = 'no H1 at all';         path = 'topic/no-heading.md';         text = "Just body text.`n" }
    )
    $checked = 0
    $fallbacks = 0
    $findings = New-Object System.Collections.Generic.List[string]
    foreach ($case in $cases) {
        $label = Get-ReaderMapLabel $case.text $case.path
        $firstH1 = @(Get-MarkdownHeadings $case.text | Where-Object { $_.level -eq 1 })
        $manifestTitle = if ($firstH1.Count) { [string]$firstH1[0].text } else { '' }
        if ([string]::IsNullOrEmpty($manifestTitle)) {
            # The ONE accepted divergence, pinned rather than described: the manifest stores '' for a
            # page with no H1, which is right for a search index and useless as a link label.
            $fallbacks++
            $expected = $case.path -replace '\.md$', ''
            if ($label -cne $expected) { [void]$findings.Add("$($case.name): no-H1 fallback was '$label', expected '$expected'") }
            continue
        }
        $checked++
        if ($label -cne $manifestTitle) { [void]$findings.Add("$($case.name): label '$label' != manifest title '$manifestTitle'") }
    }
    if ($checked -lt 7) { throw "only $checked case(s) produced a manifest title; the corpus is not exercising the shared rule" }
    if ($fallbacks -lt 1) { throw 'no case exercised the no-H1 fallback; the accepted divergence is unpinned' }
    if ($findings.Count) { throw ($findings -join '; ') }
    "$checked title(s) agree with the manifest, $fallbacks fallback(s) pinned"
}

# Restore-BookSource.ps1's journal validator, driven directly. It had NO SUITE AT ALL: the helper
# runs its Desk gate before it defines its functions, so a -SelfTest switch cannot reach them
# without restructuring a helper that writes real Notebook pages. The function is imported from the
# AST instead -- the same way New-HubMigrationSnapshot.ps1 reads its two sources -- so this check
# drives the real validator rather than a copy of its rules.
#
# The case that earned it: a Book PUBLISHED FROM A SHELF BOOK carries journal sources under
# shelf/<slug>/wiki/, so it can never be restored to notebook/<slug>/ and has no restore route at
# all. It refused correctly and said only "does not resolve below notebook/<slug>/", which reads as
# a damaged journal and sends the reader hunting for corruption in an intact file.
# library-development-design-history is the standing example. Recorded on the library-dev Hub
# 2026-09-04, fixed 2026-09-05. The generic refusal is still asserted below, because naming the
# Shelf class must not swallow the case it was carved out of.
Invoke-Check 'restore-book-source.canonical-source' {
    $helperPath = Join-Path $PSScriptRoot 'Restore-BookSource.ps1'
    if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) { throw 'tools/Restore-BookSource.ps1 is missing.' }
    $helperText = [IO.File]::ReadAllText($helperPath, [Text.UTF8Encoding]::new($false, $true))
    $helperErrors = $null
    $helperAstRoot = [Management.Automation.Language.Parser]::ParseInput($helperText, [ref]$null, [ref]$helperErrors)
    if ($null -ne $helperErrors -and @($helperErrors).Count) { throw 'Restore-BookSource.ps1 does not parse.' }
    $defined = @{}
    # $false: top-level definitions only, which is where this one lives.
    foreach ($definition in $helperAstRoot.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
        if (-not $defined.ContainsKey($definition.Name)) { $defined[$definition.Name] = $definition.Extent.Text }
    }
    if (-not $defined.ContainsKey('Test-CanonicalNotebookSource')) {
        throw 'Restore-BookSource.ps1 no longer defines Test-CanonicalNotebookSource; this check reads its behaviour from that file and will not guess.'
    }
    $imported = @('Set-StrictMode -Version Latest', "`$ErrorActionPreference = 'Stop'", $defined['Test-CanonicalNotebookSource']) -join "`n`n"
    $scope = New-Module -ScriptBlock ([scriptblock]::Create($imported)) -AsCustomObject

    $bookSlug = 'obsidian-app'
    $cases = @(
        @{ value = 'notebook/obsidian-app/bases.md';     expect = '';                             label = 'a canonical Notebook page is accepted' },
        @{ value = 'shelf/obsidian-app/wiki/bases.md';   expect = 'published from a Shelf Book';  label = 'a Shelf-published Book is refused BY NAME, not as corruption' },
        @{ value = 'shelf/another-book/wiki/bases.md';   expect = 'published from a Shelf Book';  label = 'a Shelf page under a different slug names the class too' },
        @{ value = 'books/obsidian-app/wiki/bases.md';   expect = 'does not resolve below';       label = 'a shared page still gets the generic refusal' },
        @{ value = 'notebook\obsidian-app\bases.md';     expect = 'forward slashes';              label = 'a backslash path is refused' },
        @{ value = 'C:/notebook/obsidian-app/bases.md';  expect = 'workspace-relative';           label = 'an absolute Windows path is refused' },
        @{ value = '/notebook/obsidian-app/bases.md';    expect = 'workspace-relative';           label = 'a rooted path is refused' },
        @{ value = 'notebook/obsidian-app/../out.md';    expect = 'relative or empty path segment'; label = 'a traversal segment is refused' },
        @{ value = 'notebook/obsidian-app/bases.txt';    expect = 'not a Markdown page';          label = 'a non-Markdown page is refused' },
        @{ value = '';                                   expect = 'no source path';               label = 'an empty source is refused' }
    )
    foreach ($case in $cases) {
        # Two scalar arguments, so .Invoke() binds them positionally. A single ARRAY argument would
        # be spread across the parameters instead -- defect family 6 in .claude/rules.
        $actual = [string]$scope.'Test-CanonicalNotebookSource'.Invoke([string]$case.value, $bookSlug)
        if ([string]::IsNullOrEmpty([string]$case.expect)) {
            if ($actual -cne '') { throw "$($case.label): expected acceptance, got '$actual'" }
        }
        elseif ($actual -cnotmatch [regex]::Escape([string]$case.expect)) {
            throw "$($case.label): '$($case.value)' returned '$actual', which does not name '$($case.expect)'"
        }
    }
    "$(@($cases).Count) canonical-source cases pass, including the Shelf-published class by name"
}

# Get-BookCurrency.ps1's roll-up rule, at BOTH tiers. Two things are checked, because either alone
# would pass while the answer stayed wrong: the shared function is DRIVEN over real count mixes, and
# the two call sites are read from the AST to confirm each still leads its order with `cannot
# verify`. The function cannot know its own priority -- the order is the argument -- so a check that
# only exercised the function would sail through a reordered call site, which is exactly the defect.
#
# The defect: until 2026-09-05 the collection tier ordered `upstream advanced` → `current` →
# `cannot verify`, so a collection of nineteen Books where eighteen could not be measured reported
# `current`. That was fixed; the PER-BOOK tier was left ordering `refresh due` → `current` →
# `cannot verify`, so a Book with one measurable article and thirteen unreadable ones still reported
# `current` -- the same shape one tier down, found by reading on 2026-09-05 and ruled worst-row at
# both tiers. An absence must never be reported as currency, at any scope.
Invoke-Check 'book-currency.roll-up-is-worst-row' {
    $currencyPath = Join-Path $PSScriptRoot 'Get-BookCurrency.ps1'
    if (-not (Test-Path -LiteralPath $currencyPath -PathType Leaf)) { throw 'tools/Get-BookCurrency.ps1 is missing.' }
    $currencyText = [IO.File]::ReadAllText($currencyPath, [Text.UTF8Encoding]::new($false, $true))
    $currencyErrors = $null
    $currencyAst = [Management.Automation.Language.Parser]::ParseInput($currencyText, [ref]$null, [ref]$currencyErrors)
    if ($null -ne $currencyErrors -and @($currencyErrors).Count) { throw 'Get-BookCurrency.ps1 does not parse.' }

    # --- 1. Every call site still leads with the worst verdict ---
    $callSites = @($currencyAst.FindAll({
        $args[0] -is [Management.Automation.Language.CommandAst] -and
        [string]$args[0].GetCommandName() -ceq 'Get-RollUpVerdict'
    }, $true))
    if ($callSites.Count -ne 2) {
        throw "expected the per-Book and collection tiers to be the only two Get-RollUpVerdict call sites; found $($callSites.Count). A third tier gets the same rule, or this check is out of date."
    }
    foreach ($callSite in $callSites) {
        $elements = @($callSite.CommandElements)
        $orderAt = -1
        for ($i = 0; $i -lt $elements.Count; $i++) {
            if ($elements[$i] -is [Management.Automation.Language.CommandParameterAst] -and $elements[$i].ParameterName -ceq 'Order') { $orderAt = $i; break }
        }
        if ($orderAt -lt 0 -or ($orderAt + 1) -ge $elements.Count) {
            throw "a Get-RollUpVerdict call at line $($callSite.Extent.StartLineNumber) passes no -Order; the priority is the argument, so it cannot be left implicit."
        }
        # The AST locates the argument exactly; the assertion is then on that argument's own text,
        # so reformatting anywhere else in the file cannot move it.
        $orderText = [string]$elements[$orderAt + 1].Extent.Text
        if ($orderText -cnotmatch "^@\(\s*'cannot verify'") {
            throw "the Get-RollUpVerdict call at line $($callSite.Extent.StartLineNumber) does not lead its order with 'cannot verify': $orderText"
        }
    }

    # --- 2. The shared function actually behaves that way ---
    $defined = @{}
    foreach ($definition in $currencyAst.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
        if (-not $defined.ContainsKey($definition.Name)) { $defined[$definition.Name] = $definition.Extent.Text }
    }
    if (-not $defined.ContainsKey('Get-RollUpVerdict')) {
        throw 'Get-BookCurrency.ps1 no longer defines Get-RollUpVerdict; this check reads its behaviour from that file and will not guess.'
    }
    $imported = @('Set-StrictMode -Version Latest', "`$ErrorActionPreference = 'Stop'", $defined['Get-RollUpVerdict']) -join "`n`n"
    $scope = New-Module -ScriptBlock ([scriptblock]::Create($imported)) -AsCustomObject

    $advanced = 'upstream advanced -- article inspection required'
    $bookOrder = @('cannot verify', 'refresh due', 'not anchored', 'partially anchored', 'current')
    $allOrder = @('cannot verify', $advanced, 'not anchored', 'current')
    function New-CountMap([hashtable]$Values, [string[]]$Names) {
        $map = [ordered]@{}
        foreach ($countName in $Names) { $map[$countName] = 0 }
        foreach ($key in $Values.Keys) { $map[[string]$key] = $Values[$key] }
        $map
    }
    $bookNames = @('current', 'refresh due', 'not anchored', 'partially anchored', 'cannot verify', 'skipped')
    $allNames = @('current', $advanced, 'not anchored', 'cannot verify')

    $cases = @(
        @{ label = 'per-Book: thirteen unreadable articles outrank one current one'; order = $bookOrder; names = $bookNames; counts = @{ 'cannot verify' = 13; 'current' = 1 }; expect = 'cannot verify' },
        @{ label = 'per-Book: one unreadable article outranks a measured change';    order = $bookOrder; names = $bookNames; counts = @{ 'cannot verify' = 1; 'refresh due' = 4 }; expect = 'cannot verify' },
        @{ label = 'per-Book: a measured change outranks current';                   order = $bookOrder; names = $bookNames; counts = @{ 'refresh due' = 1; 'current' = 9 }; expect = 'refresh due' },
        @{ label = 'per-Book: an absence outranks current';                          order = $bookOrder; names = $bookNames; counts = @{ 'not anchored' = 1; 'current' = 9 }; expect = 'not anchored' },
        @{ label = 'per-Book: a partial anchor is still an absence';                 order = $bookOrder; names = $bookNames; counts = @{ 'partially anchored' = 1; 'current' = 9 }; expect = 'partially anchored' },
        @{ label = 'per-Book: all current is current';                               order = $bookOrder; names = $bookNames; counts = @{ 'current' = 4 }; expect = 'current' },
        @{ label = 'per-Book: an all-skipped capture Book has nothing to check';     order = $bookOrder; names = $bookNames; counts = @{ 'skipped' = 12 }; expect = 'nothing to check' },
        @{ label = 'collection: eighteen unmeasurable Books outrank one current';    order = $allOrder;  names = $allNames;  counts = @{ 'cannot verify' = 18; 'current' = 1 }; expect = 'cannot verify' },
        @{ label = 'collection: cannot verify outranks a moved tip';                 order = $allOrder;  names = $allNames;  counts = @{ 'cannot verify' = 1; $advanced = 6 }; expect = 'cannot verify' },
        @{ label = 'collection: a moved tip outranks current';                       order = $allOrder;  names = $allNames;  counts = @{ $advanced = 1; 'current' = 9 }; expect = $advanced },
        @{ label = 'collection: an empty collection has nothing to check';           order = $allOrder;  names = $allNames;  counts = @{}; expect = 'nothing to check' }
    )
    foreach ($case in $cases) {
        $map = New-CountMap $case.counts $case.names
        # Three scalar-and-array arguments bind positionally; a LONE array argument would be spread
        # across the parameters instead -- defect family 6 in .claude/rules.
        $actual = [string]$scope.'Get-RollUpVerdict'.Invoke($map, [string[]]$case.order, 'nothing to check')
        if ($actual -cne [string]$case.expect) { throw "$($case.label): expected '$($case.expect)', got '$actual'" }
    }

    # An order naming a bucket the counts do not carry is a silent under-report, so it must throw.
    $caught = ''
    try { [void]$scope.'Get-RollUpVerdict'.Invoke((New-CountMap @{} $bookNames), [string[]]@('typo verdict'), 'nothing to check') }
    catch { $caught = [string]$_.Exception.Message }
    if ($caught -cnotmatch 'which the counts do not carry') {
        throw "an order name absent from the counts must be refused, not ignored; got '$caught'"
    }

    "both tiers lead with 'cannot verify'; $(@($cases).Count) roll-up cases pass"
}

# --- A manifest updater reports the cause it actually failed with -------------------------------
# Both updaters used to wrap Enter-BookLock AND Enter-BookMutation in one try and label every throw
# from it 'locked by another writer', each asserting in a comment that nothing else could throw.
# Enter-BookMutation validates the slug, the collection/root pairing and the lock's identity, and
# writes the dirty marker: four ways to fail, all reported as contention. A shared rebuild hit that
# on 2026-09-05, left a stale lock and a dirty Book, and its journals could not contradict the
# label. The rule lived twice, so the two files had already drifted apart in their comments.
Invoke-Check 'manifests.lock-failure-names-its-cause' {
    $transactionPath = Join-Path $PSScriptRoot 'BookManifestTransaction.ps1'
    if (-not (Test-Path -LiteralPath $transactionPath -PathType Leaf)) { throw 'tools/BookManifestTransaction.ps1 is missing.' }
    $transactionText = [IO.File]::ReadAllText($transactionPath, [Text.UTF8Encoding]::new($false, $true))
    $transactionErrors = $null
    $transactionAst = [Management.Automation.Language.Parser]::ParseInput($transactionText, [ref]$null, [ref]$transactionErrors)
    if ($null -ne $transactionErrors -and @($transactionErrors).Count) { throw 'BookManifestTransaction.ps1 does not parse.' }

    # --- 1. The shared function behaves the way both updaters depend on ---
    $defined = @{}
    foreach ($definition in $transactionAst.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
        if (-not $defined.ContainsKey($definition.Name)) { $defined[$definition.Name] = $definition.Extent.Text }
    }
    if (-not $defined.ContainsKey('New-BookMutationFailure')) {
        throw 'BookManifestTransaction.ps1 no longer defines New-BookMutationFailure; this check reads its behaviour from that file and will not guess.'
    }
    $imported = @('Set-StrictMode -Version Latest', "`$ErrorActionPreference = 'Stop'", $defined['New-BookMutationFailure']) -join "`n`n"
    $scope = New-Module -ScriptBlock ([scriptblock]::Create($imported)) -AsCustomObject

    $contention = 'Another operation holds the lock for books/demo. Wait for it to finish, or investigate C:\x\demo.lock.'
    $malformed  = "Book slug 'Demo' must contain only lowercase letters, digits, and hyphens."
    $cases = @(
        @{ label = 'an acquire failure is skipped, because the marker is written inside the lock'; stage = 'acquire'; message = $contention; status = 'skipped'; expect = $contention },
        @{ label = 'an acquire failure passes its own message through, contention or not';          stage = 'acquire'; message = 'A Book lock needs a Book root.'; status = 'skipped'; expect = 'A Book lock needs a Book root.' },
        @{ label = 'a window that would not open is dirty and names the real cause';                stage = 'open';    message = $malformed; status = 'dirty'; expect = "the mutation window would not open: $malformed" },
        @{ label = 'a commit failure keeps the wording Complete-BookMutation already reports';      stage = 'commit';  message = 'the store refused generation 4'; status = 'dirty'; expect = 'dirty until rebuilt: the store refused generation 4' }
    )
    foreach ($case in $cases) {
        # Three scalar arguments bind positionally; a LONE array argument would be spread across the
        # parameters instead -- defect family 6 in .claude/rules.
        $actual = $scope.'New-BookMutationFailure'.Invoke('demo', [string]$case.stage, [string]$case.message)
        if ([string]$actual.status -cne [string]$case.status) { throw "$($case.label): expected status '$($case.status)', got '$($actual.status)'" }
        if ([string]$actual.summary -cne [string]$case.expect) { throw "$($case.label): expected summary '$($case.expect)', got '$($actual.summary)'" }
    }

    # Two different acquire failures must not collapse to one sentence. That collapse IS the defect.
    $first  = $scope.'New-BookMutationFailure'.Invoke('demo', 'acquire', $contention)
    $second = $scope.'New-BookMutationFailure'.Invoke('demo', 'acquire', 'A Book lock needs a Book root.')
    if ([string]$first.summary -ceq [string]$second.summary) {
        throw 'two unrelated acquire failures produced the same summary; a fixed string is exactly what this check exists to prevent.'
    }

    # A causeless report cannot be checked against what happened, so it must be refused at the source.
    $caught = ''
    try { [void]$scope.'New-BookMutationFailure'.Invoke('demo', 'open', '  ') }
    catch { $caught = [string]$_.Exception.Message }
    if ($caught -cnotmatch 'must carry the message it failed with') {
        throw "an empty failure message must be refused, not reported; got '$caught'"
    }

    # --- 2. Neither updater can reach the old shape again ---
    $updaters = @(
        [pscustomobject]@{ path = (Join-Path $PSScriptRoot 'Update-BookManifests.ps1');       stages = @('acquire', 'open') },
        [pscustomobject]@{ path = (Join-Path $PSScriptRoot 'Update-SharedBookManifests.ps1'); stages = @('acquire', 'open', 'commit') }
    )
    foreach ($updater in $updaters) {
        $leaf = Split-Path -Leaf $updater.path
        if (-not (Test-Path -LiteralPath $updater.path -PathType Leaf)) { throw "tools/$leaf is missing." }
        $text = [IO.File]::ReadAllText($updater.path, [Text.UTF8Encoding]::new($false, $true))
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$parseErrors)
        if ($null -ne $parseErrors -and @($parseErrors).Count) { throw "$leaf does not parse." }

        # The structural rule: acquiring the lock and opening the window must not share a try, or one
        # catch has to describe both and will get one of them wrong.
        foreach ($try in $ast.FindAll({ $args[0] -is [Management.Automation.Language.TryStatementAst] }, $true)) {
            $names = @($try.Body.FindAll({ $args[0] -is [Management.Automation.Language.CommandAst] }, $true) |
                ForEach-Object { [string]$_.GetCommandName() })
            if (($names -ccontains 'Enter-BookLock') -and ($names -ccontains 'Enter-BookMutation')) {
                throw "$leaf line $($try.Extent.StartLineNumber): Enter-BookLock and Enter-BookMutation are inside one try again, so a single catch has to label both."
            }
        }

        # The fixed string that used to stand in for every cause -- read from the parse tree, not
        # from the text. Update-BookManifests.ps1's .DESCRIPTION says "A Book locked by another
        # writer is skipped, not failed", which is true prose about behaviour and not the label
        # this check is hunting. Only a VALUE can be reported to the reader as a cause.
        $fixedLabel = @($ast.FindAll({
            ($args[0] -is [Management.Automation.Language.StringConstantExpressionAst] -or
             $args[0] -is [Management.Automation.Language.ExpandableStringExpressionAst]) -and
            ([string]$args[0].Value) -cmatch 'locked by another writer'
        }, $true))
        if ($fixedLabel.Count) {
            throw "$leaf line $($fixedLabel[0].Extent.StartLineNumber) still hard-codes 'locked by another writer' as a value; the message belongs to Enter-BookLock, which already names the Book and the lock path."
        }

        # And every stage this updater can reach actually routes through the shared function.
        $staged = @($ast.FindAll({
            $args[0] -is [Management.Automation.Language.CommandAst] -and
            [string]$args[0].GetCommandName() -ceq 'New-BookMutationFailure'
        }, $true) | ForEach-Object {
            $elements = @($_.CommandElements)
            $value = ''
            for ($i = 0; $i -lt $elements.Count; $i++) {
                if ($elements[$i] -is [Management.Automation.Language.CommandParameterAst] -and
                    $elements[$i].ParameterName -ceq 'Stage' -and ($i + 1) -lt $elements.Count) {
                    $value = ([string]$elements[$i + 1].Extent.Text).Trim("'", '"')
                    break
                }
            }
            $value
        })
        foreach ($stage in $updater.stages) {
            if (-not ($staged -ccontains $stage)) {
                throw "$leaf never reports a '$stage' failure through New-BookMutationFailure; that stage is reachable there, so it must."
            }
        }
    }

    "$(@($cases).Count) failure-stage cases pass; both updaters split acquire from open and route every stage through one function"
}

# --- The derived indexes, and the writers that must not compose them by hand ----------------------
# PLAN-multi-desk.md Release 1, steps 1-4. Three of these read the live workspace and one is static.
# The state checks DELIBERATELY DO NOT REPAIR: a check that fixed what it found would report a
# healthy Library on every run while the writer that caused the drift stayed broken.

Invoke-Check 'notebook.master-index-renders' {
    . (Join-Path $PSScriptRoot 'NotebookIndex.ps1')
    $problems = @(Get-NotebookMasterIndexDrift -Workspace $workspace)
    if ($problems.Count) { throw ($problems -join '; ') }
    $topics = @(Get-NotebookTopicInventory -NotebookRoot (Join-Path $workspace 'notebook'))
    "notebook/_master-index.md matches the $($topics.Count) topic(s) on disk and their headings"
}

Invoke-Check 'shelf.catalog-renders-from-entries' {
    . (Join-Path $PSScriptRoot 'ShelfCatalog.ps1')
    $problems = @(Get-ShelfCatalogDrift -Workspace $workspace)
    if ($problems.Count) { throw ($problems -join '; ') }
    $inventory = Get-ShelfCatalogEntryInventory -Workspace $workspace
    "shelf/_catalog.md matches the tracked header plus $(@($inventory.entries).Count) validated entry file(s)"
}

# output/ IS ONE DIRECTORY SHARED BY EVERY SEAT, so an un-namespaced deliverable is a file two
# projects can both want to write. The namespace is a project slug (PLAN-multi-desk.md step 6,
# decided rather than left open: the alternative needed an ownership mechanism that would have made
# Release 1 depend on seats). This is the gate on new un-namespaced files the step asks for.
#
# Until 2026-09-19 this comment said "tracked and shared", and step 13 untracked it -- but the
# collision it guards is between SEATS in one workspace, not between clones, so the check is
# unchanged and only its reason needed correcting. LibrarySeat.ps1 and SeatCreation.ps1 make the
# same point from the other end: notebook/<slug>/ and output/<slug>/ are what a seat is namespaced by.
Invoke-Check 'output.namespaced-by-project' {
    $outputRoot = Join-Path $workspace 'output'
    if (-not (Test-Path -LiteralPath $outputRoot -PathType Container)) { return 'output/ does not exist yet' }
    $loose = @(Get-ChildItem -LiteralPath $outputRoot -File -Force | ForEach-Object { $_.Name })
    if ($loose.Count) {
        throw ("$($loose.Count) file(s) sit directly in output/: $(@($loose | Sort-Object) -join ', '). " +
            'A deliverable goes under its project slug -- output/<project-slug>/<name>.md -- because every ' +
            'seat in this workspace shares one output/, so two projects writing output/report.md collide.')
    }
    $slugs = @(Get-ChildItem -LiteralPath $outputRoot -Directory -Force | ForEach-Object { $_.Name })
    $bad = @($slugs | Where-Object { $_ -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$' })
    if ($bad.Count) { throw "output/ holds directory(ies) that are not project slugs: $(@($bad | Sort-Object) -join ', ')" }
    "$($slugs.Count) project namespace(s), no loose files"
}

# THE DERIVED FILES ARE WRITTEN ATOMICALLY OR NOT AT ALL, and this is what stops that decaying. The
# narrow render lock is only safe because a derived index rewritten with no render lock held cannot
# be read half-written; a later "simplify this to WriteAllText" would take that guarantee away and
# break no other test, because observing a torn read needs a concurrent reader.
#
# IT FOLLOWS THE PATH VARIABLE, NOT THE FILENAME ON THE WRITE LINE. The first version matched a
# line naming a derived file AND a writer call, and it was useless in both directions: it fired on
# five FIXTURE writes -- `WriteAllText((Join-Path $fixture 'shelf/_catalog.md'), ...)`, which is
# exactly what a fixture should do -- while missing every real one, because production code writes
# `Write-Utf8 $catalogPath (...)` and that line names no filename at all. So the check taints the
# variables and property names a derived path is assigned to, propagates one hop at a time to a
# fixed point, and flags a non-atomic write whose target is tainted. A fixture inlining the literal
# taints nothing and is correctly ignored.
#
# THREE FILENAMES, NOT FOUR. A topic `_index.md` is deliberately out of scope here: the name is
# shared with every Book's reader map, which is legitimately written with Write-Utf8, so tainting it
# would fire on correct code. The topic index's atomicity is held at RUNTIME instead, by
# notebook.render-lock-narrow case 5 -- a concurrent reader that never sees a torn file.
Invoke-Check 'derived-indexes.written-atomically' {
    # The renderers are the mechanism: BookWriteGuard defines Write-AtomicText and the two modules
    # are the only things allowed to publish these files.
    $exempt = @('BookWriteGuard.ps1', 'NotebookIndex.ps1', 'ShelfCatalog.ps1')
    $derived = @('_master-index.md', '_catalog.md', '_catalog-entry.md')
    # TWO SETS, BECAUSE THE TWO RULES DISAGREE ABOUT ONE FILE. `_catalog-entry.md` must be written
    # atomically like the others -- it is published by the renderer inside the render lock -- but it
    # is a Book's own authored authority, so journaling it is CORRECT and Rename-ShelfBook does.
    # Only the two RENDERED files are barred from a journal. A single list would either miss the
    # entry file's atomicity or forbid the one journal entry that makes a Shelf rollback work.
    $derivedRendered = @('_master-index.md', '_catalog.md')
    $writers = @('WriteAllText', 'AppendAllText', 'Set-Content', 'Add-Content', 'Write-Utf8', 'Out-File')
    $offenders = [Collections.Generic.List[string]]::new()
    $scanned = 0

    # The taint walk, run once per seed list. Its reasoning is at the two call sites below.
    $taintOf = {
        param([string[]]$Lines, [string[]]$Seeds)
        $set = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($line in $Lines) {
            $assignment = [regex]::Match($line, '^\s*\$?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$')
            if (-not $assignment.Success) { continue }
            if (@($Seeds | Where-Object { $assignment.Groups[2].Value.Contains($_) }).Count) {
                [void]$set.Add($assignment.Groups[1].Value)
            }
        }
        for ($pass = 0; $pass -lt 8; $pass++) {
            $before = $set.Count
            foreach ($line in $Lines) {
                $assignment = [regex]::Match($line, '^\s*\$?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$')
                if (-not $assignment.Success) { continue }
                $right = $assignment.Groups[2].Value.Trim()
                $composes = $right.Contains('Join-Path')
                foreach ($name in @($set)) {
                    $bounded = '(?<![A-Za-z0-9_])' + [regex]::Escape($name) + '(?![A-Za-z0-9_])'
                    if ($right -cnotmatch $bounded) { continue }
                    # An alias is the whole right-hand side: `$a = $b`, or `$a = $obj.b`.
                    $isAlias = $right -cmatch ('^\$?(?:[A-Za-z_][A-Za-z0-9_]*\.)?' + [regex]::Escape($name) + '$')
                    if ($isAlias -or $composes) {
                        [void]$set.Add($assignment.Groups[1].Value)
                        break
                    }
                }
            }
            if ($set.Count -eq $before) { break }
        }
        , $set
    }

    # SCOPED BY DECLARED ROLE, not by a filename prefix. A test runner builds fixtures that hold a
    # catalog at a chosen state on purpose -- that is the opposite of a defect -- and _helpers.json
    # already says which files those are. Reading the roles from there means the exemption cannot
    # drift from the manifest the allowlist check reads.
    $manifest = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '_helpers.json')) | ConvertFrom-Json
    $roles = @{}
    foreach ($property in @($manifest.helpers.PSObject.Properties)) { $roles[$property.Name] = [string]$property.Value.role }

    foreach ($file in @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.ps1')) {
        if ($file.Name -cin $exempt) { continue }
        if ($roles.ContainsKey($file.Name) -and $roles[$file.Name] -ceq 'test') { continue }
        $scanned++
        $text = [IO.File]::ReadAllText($file.FullName)
        $lines = @($text -split "`r?`n" | Where-Object { -not $_.TrimStart().StartsWith('#') })
        # Seed: anything assigned an expression that names a derived file. Both `$x = ...` and a
        # `key = ...` inside an object literal, because the compiler carried its paths across on a
        # plan object -- `_master_path = $masterPath` -- and wrote through the property.
        #
        # PROPAGATE ALONG PATHS ONLY, NEVER ALONG CONTENT. Propagating through any expression that
        # mentions a tainted name walks straight out of the path domain and into the file's text:
        # $catalogText = ReadAllText($catalogPath) taints the text, then the entry parsed out of it,
        # then the title read off the entry -- and Rename-ShelfBook's perfectly correct reader-map
        # rewrite was flagged because the new map heading descends from the catalog's title. So a
        # hop counts only when the right-hand side is an ALIAS of a tainted name, or a Join-Path
        # composed from one. Reading a file is where the path stops and the content begins.
        $tainted = & $taintOf $lines $derived
        $taintedRendered = & $taintOf $lines $derivedRendered

        foreach ($line in $lines) {
            $writerHit = @($writers | Where-Object { $line.Contains($_) })
            if (-not $writerHit.Count) { continue }
            if ($line.Contains('Write-AtomicText')) { continue }
            foreach ($name in @($tainted)) {
                if ($line -cmatch ('(?<![A-Za-z0-9_])' + [regex]::Escape($name) + '(?![A-Za-z0-9_])')) {
                    [void]$offenders.Add("$($file.Name): $($writerHit[0]) targets a derived index path held in '$name' -- $($line.Trim())")
                    break
                }
            }
        }

        # --- AND THE SAME PATH MUST NEVER REACH A JOURNAL --------------------------------------
        #
        # THE RESTORE PATH IS A WRITE TOO, and until 2026-09-18 it was the one this check could not
        # see. Restore-BookJournal writes back whatever a journal recorded, so a helper that listed
        # a derived index in Write-BookJournal -Paths had bought itself a whole-file write to that
        # index, outside the render lock, performed at the one moment something has already gone
        # wrong. Four helpers did. The failure is not merely a torn read: the bytes restored are a
        # snapshot of a SHARED view taken before the run started, so a rollback drops whatever
        # another seat rendered into it in between -- the lost-topic race, through the rollback door.
        #
        # READ FROM THE AST, NOT FROM THE LINE. The compiler's call is split across a backtick
        # continuation, so -Paths and the command name are on different lines and no line scan sees
        # both. The AST also gives the argument EXPRESSION, which is what the taint set is about:
        # `-Paths $journalTargets` names no file, and $journalTargets is tainted precisely because
        # the taint walked there one Join-Path at a time.
        if (-not $text.Contains('Write-BookJournal')) { continue }
        $journalErrors = $null
        $journalAst = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$journalErrors)
        if ($null -ne $journalErrors -and @($journalErrors).Count -gt 0) {
            [void]$offenders.Add("$($file.Name): does not parse, so its Write-BookJournal calls could not be read")
            continue
        }
        $journalCalls = @($journalAst.FindAll({
            param($node)
            $node -is [Management.Automation.Language.CommandAst] -and
            $null -ne $node.GetCommandName() -and $node.GetCommandName() -ceq 'Write-BookJournal'
        }, $true))
        foreach ($call in $journalCalls) {
            $elements = @($call.CommandElements)
            for ($i = 0; $i -lt $elements.Count - 1; $i++) {
                $parameter = $elements[$i] -as [Management.Automation.Language.CommandParameterAst]
                if ($null -eq $parameter -or $parameter.ParameterName -cne 'Paths') { continue }
                $argument = $elements[$i + 1]
                $argumentText = $argument.Extent.Text
                # A literal is as damning as a variable here, and cheaper to spot: the journal
                # guard's own fixture aside, nothing legitimately spells one of these names inline.
                $named = @($derivedRendered | Where-Object { $argumentText.Contains($_) })
                foreach ($hit in $named) {
                    [void]$offenders.Add("$($file.Name): Write-BookJournal -Paths names the derived index $hit -- $($argumentText.Trim())")
                }
                # $taintedRendered, NOT $tainted. The entry file is tainted for the atomic-write
                # rule and is LEGITIMATE in a journal -- it is a Book's own authored authority, and
                # Rename-ShelfBook records it on purpose. Only a name carrying a RENDERED index is
                # an offender, which is why the taint walk runs twice with different seeds.
                foreach ($name in @($taintedRendered)) {
                    $bounded = '(?<![A-Za-z0-9_])' + [regex]::Escape($name) + '(?![A-Za-z0-9_])'
                    if ($argumentText -cnotmatch $bounded) { continue }
                    [void]$offenders.Add("$($file.Name): Write-BookJournal -Paths carries a derived index held in '$name' -- $($argumentText.Trim())")
                    break
                }
            }
        }
    }

    if ($offenders.Count) {
        throw ("$($offenders.Count) derived-index violation(s): $(@($offenders) -join ' | '). " +
            'A derived index is replaced with Write-AtomicText, which publishes by rename, because a reader can ' +
            'be reading it while it is rewritten -- that is what lets the render lock stay narrow. And it is never ' +
            'journaled at all: a rollback must re-derive it from the authority it restored, with ' +
            'Invoke-NotebookRenderAfterRollback or Invoke-ShelfCatalogRenderAfterRollback. See docs/derived-indexes.md.')
    }
    "$scanned source(s) scanned; every derived-index write goes through Write-AtomicText and no journal carries one"
}

# --- THE DESK IS THE OTHER FILE TWO PROCESSES SHARE, AND ITS CONTRACT HAS TWO HALVES -------------
#
# `AtomicFile.ps1:6-9` states the rule: Write-AtomicText guarantees a reader never sees a PARTIAL
# file, and Read-AtomicBytes is what makes that guarantee usable, because the rename-over holds the
# destination for an instant and a reader arriving in that instant is refused rather than served.
# "Using one without the other is the bug."
#
# UNTIL 2026-09-18 THE DESK HAD NEITHER HALF. Set-VirtualDesk.ps1 and Reset's -ClearDesk truncated in
# place, and twenty reads across sixteen files each carried their own hand-copied Get-Content
# pipeline. The registry lock is not a substitute and never was: it serialises WRITERS, and every
# Desk READER holds no lock by design -- three of them are hooks, which is the worst place for the
# failure to land, because a PreToolUse guard that reads an empty Desk denies the reader's tool call
# and explains nothing.
#
# SO ONE CHECK HOLDS BOTH HALVES. A pass that routed the writers and left the readers would have
# traded a torn read for an occasional sharing violation and called it a fix.
#
# SCOPE-AWARE TAINT, WHICH THE DERIVED-INDEX WALK ABOVE DOES NOT NEED AND THIS ONE CANNOT DO WITHOUT.
# Every Desk reader in the repository takes its path as a PARAMETER of a local helper --
# `Read-StateLines([string]$Path, ...)` appears in four files -- so an assignment-only walk sees no
# Desk path at any of them and passes green on a repository that never had the fix. Tainting `$Path`
# file-wide instead is no good either: it is a common enough name that it would flag the
# `.library-project` pin read two functions away, which is a different file with a different
# contract. So a parameter's taint is confined to the extent of the function that declares it.
Invoke-Check 'desk.state-read-and-written-atomically' {
    $roots = @(
        (Join-Path $workspace 'tools'),
        (Join-Path $workspace '.claude/hooks'),
        (Join-Path $workspace '.claude/adapters')
    )
    $files = @($roots | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.ps1' -File })
    if (-not $files.Count) { throw 'no PowerShell sources found to scan' }

    # ROLES FROM THE MANIFEST, the same source the derived-index check reads. A test runner builds
    # fixture Desks at chosen states on purpose, which is the opposite of a defect. An exemption keyed
    # to the DECLARED ROLE is a property of the file; one keyed to a directory is a property of where
    # the file sits, and stops applying the day it moves. Every non-test fixture writer was routed
    # rather than exempted, which is why there is no second list here.
    $manifest = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '_helpers.json')) | ConvertFrom-Json
    $roles = @{}
    foreach ($property in @($manifest.helpers.PSObject.Properties)) { $roles[$property.Name] = [string]$property.Value.role }

    # A DESK PATH IS PRODUCED IN EXACTLY THESE WAYS. The two spellers are the schema's own, and the
    # literals catch the archived copies plus LibrarySeat's composed ".open-$kind".
    $seed = 'Get-DeskFilePath|Get-DeskFileInDirectory|\.open-books|\.open-projects|\.open-\$'
    $rawReaders = @('Get-Content', 'ReadAllText', 'ReadAllLines')
    $rawWriters = @('WriteAllText', 'WriteAllBytes', 'WriteAllLines', 'AppendAllText', 'Set-Content', 'Add-Content', 'Out-File', 'Write-Utf8')

    $propagate = {
        param([string[]]$Lines, $Set)
        for ($pass = 0; $pass -lt 8; $pass++) {
            $before = $Set.Count
            foreach ($line in $Lines) {
                $assignment = [regex]::Match($line, '^\s*\$?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$')
                if (-not $assignment.Success) { continue }
                $right = $assignment.Groups[2].Value.Trim()
                if ($right -cmatch $seed) { [void]$Set.Add($assignment.Groups[1].Value); continue }
                # PATHS ONLY, NEVER CONTENT -- the same rule the derived-index walk states at length.
                # A hop counts when the right-hand side is an ALIAS of a tainted name or a Join-Path
                # composed from one. Reading a file is where the path stops and the content begins.
                $composes = $right.Contains('Join-Path')
                foreach ($name in @($Set)) {
                    $bounded = '(?<![A-Za-z0-9_])' + [regex]::Escape($name) + '(?![A-Za-z0-9_])'
                    if ($right -cnotmatch $bounded) { continue }
                    $isAlias = $right -cmatch ('^\$?(?:[A-Za-z_][A-Za-z0-9_]*\.)?' + [regex]::Escape($name) + '$')
                    if ($isAlias -or $composes) { [void]$Set.Add($assignment.Groups[1].Value); break }
                }
            }
            if ($Set.Count -eq $before) { break }
        }
        , $Set
    }

    $offenders = [Collections.Generic.List[string]]::new()
    $scanned = 0
    $filesWithDeskPaths = 0
    $routedReads = 0
    $routedWrites = 0

    foreach ($file in $files) {
        if ($roles.ContainsKey($file.Name) -and $roles[$file.Name] -ceq 'test') { continue }
        $scanned++
        $text = [IO.File]::ReadAllText($file.FullName)

        # COMMENTS BLANKED FROM THE TOKEN STREAM, not filtered by a leading '#'. Half the reasoning in
        # this repository lives in <# .DESCRIPTION #> blocks whose lines start with a letter, and
        # several of them name Get-Content in the course of explaining why it is no longer used. A
        # line filter reads those as code. Offsets are overwritten with spaces so line numbers hold.
        $tokens = $null
        $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
        if ($null -ne $errors -and @($errors).Count -gt 0) {
            [void]$offenders.Add("$($file.Name): does not parse, so its Desk reads and writes could not be read")
            continue
        }
        $chars = $text.ToCharArray()
        foreach ($token in @($tokens | Where-Object { $_.Kind -eq [Management.Automation.Language.TokenKind]::Comment })) {
            for ($i = $token.Extent.StartOffset; $i -lt $token.Extent.EndOffset -and $i -lt $chars.Length; $i++) {
                if ($chars[$i] -ne "`n" -and $chars[$i] -ne "`r") { $chars[$i] = ' ' }
            }
        }
        $lines = @((-join $chars) -split "`r?`n")

        $globalTaint = & $propagate $lines ([Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal))

        # --- THE PARAMETER HOP, one function at a time ------------------------------------------
        $localTaint = @{}
        $functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true))
        $byName = @{}
        foreach ($function in $functions) { $byName[$function.Name] = $function }
        foreach ($call in @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true))) {
            $called = $call.GetCommandName()
            if ([string]::IsNullOrEmpty($called) -or -not $byName.ContainsKey($called)) { continue }
            $target = $byName[$called]
            $parameters = @(if ($null -ne $target.Parameters) { $target.Parameters } elseif ($null -ne $target.Body.ParamBlock) { $target.Body.ParamBlock.Parameters } else { @() })
            if (-not $parameters.Count) { continue }
            $names = @($parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
            $key = "$($target.Name)@$($target.Extent.StartLineNumber)"
            if (-not $localTaint.ContainsKey($key)) { $localTaint[$key] = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal) }
            $elements = @($call.CommandElements)
            $positional = 0
            for ($i = 1; $i -lt $elements.Count; $i++) {
                $element = $elements[$i]
                $bound = $null
                $argument = $null
                if ($element -is [Management.Automation.Language.CommandParameterAst]) {
                    # PowerShell binds a parameter by UNAMBIGUOUS prefix, so -Path and -Pat are the
                    # same argument and an ambiguous prefix binds nothing at all. Requiring exactly
                    # one match is what the runtime does; `[0]` on the empty case throws under
                    # StrictMode, which is how this line announced itself on its first run.
                    $candidates = @($names | Where-Object { $_.StartsWith($element.ParameterName, [StringComparison]::OrdinalIgnoreCase) })
                    if ($candidates.Count -eq 1) { $bound = $candidates[0] }
                    if ($null -ne $element.Argument) { $argument = $element.Argument }
                    elseif ($i + 1 -lt $elements.Count -and -not ($elements[$i + 1] -is [Management.Automation.Language.CommandParameterAst])) {
                        $i++
                        $argument = $elements[$i]
                    }
                }
                else {
                    if ($positional -lt $names.Count) { $bound = $names[$positional] }
                    $positional++
                    $argument = $element
                }
                if ($null -eq $bound -or $null -eq $argument) { continue }
                $argumentText = $argument.Extent.Text
                $carries = $argumentText -cmatch $seed
                if (-not $carries) {
                    foreach ($name in @($globalTaint)) {
                        if ($argumentText -cmatch ('(?<![A-Za-z0-9_])' + [regex]::Escape($name) + '(?![A-Za-z0-9_])')) { $carries = $true; break }
                    }
                }
                if ($carries) { [void]$localTaint[$key].Add($bound) }
            }
        }
        # Propagate each function's tainted parameters through that function's OWN lines only.
        $scopes = [Collections.Generic.List[object]]::new()
        foreach ($function in $functions) {
            $key = "$($function.Name)@$($function.Extent.StartLineNumber)"
            # ASSIGNED IN A STATEMENT, NOT THROUGH AN `if` EXPRESSION. A scriptblock's value travels
            # the output pipeline and the pipeline UNROLLS a collection, so an EMPTY HashSet from the
            # else branch arrives as $null and the next line's .Count throws. Caught on this check's
            # first run, which is the whole argument for running a new branch rather than reading it.
            $set = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            if ($localTaint.ContainsKey($key)) { $set = $localTaint[$key] }
            if ($set.Count) {
                $own = @($lines[($function.Extent.StartLineNumber - 1)..($function.Extent.EndLineNumber - 1)])
                $set = & $propagate $own $set
            }
            [void]$scopes.Add([pscustomobject]@{
                    first = $function.Extent.StartLineNumber
                    last  = $function.Extent.EndLineNumber
                    taint = $set
                })
        }

        if ($globalTaint.Count -or @($scopes | Where-Object { $_.taint.Count }).Count) { $filesWithDeskPaths++ }

        for ($number = 1; $number -le $lines.Count; $number++) {
            $line = $lines[$number - 1]
            if ([string]::IsNullOrWhiteSpace($line)) { continue }

            # THE CALLING CONVENTION IS PART OF THE CONTRACT. Neither reader is comma-returned, and
            # that was chosen on a measurement: assigned bare, an empty Desk arrives as $null, whose
            # .Count throws under StrictMode. @( ) is the correct wrapper and the one every call site
            # already used. Measured 2026-09-18; the reasoning is in BookRootSchema.ps1.
            if ($line -cmatch '=\s*(Get-DeskFileEntries|Read-DeskFileLines)\b') {
                [void]$offenders.Add("$($file.Name):${number}: assigns a Desk reader bare -- wrap it in @( ), or an empty Desk arrives as `$null -- $($line.Trim())")
            }
            # Read-AtomicBytes counts too. The contract is the RETRYING READ, not a particular
            # wrapper over it: a caller that legitimately wants the bytes verbatim -- a save-and-
            # restore, say -- satisfies it directly and must not be pushed through a line splitter.
            if ($line -cmatch '(?<![A-Za-z0-9_-])(Get-DeskFileEntries|Read-DeskFileLines|Read-AtomicBytes)(?![A-Za-z0-9_-])') { $routedReads++ }

            $taint = [Collections.Generic.HashSet[string]]::new($globalTaint, [StringComparer]::Ordinal)
            foreach ($scope in @($scopes | Where-Object { $number -ge $_.first -and $number -le $_.last })) {
                foreach ($name in @($scope.taint)) { [void]$taint.Add($name) }
            }
            if (-not $taint.Count) { continue }

            $named = ''
            foreach ($name in @($taint)) {
                if ($line -cmatch ('(?<![A-Za-z0-9_])' + [regex]::Escape($name) + '(?![A-Za-z0-9_])')) { $named = $name; break }
            }
            if (-not $named) { continue }

            if ($line -cmatch '(?<![A-Za-z0-9_-])(Write-AtomicText|Write-AtomicBytes)(?![A-Za-z0-9_-])') { $routedWrites++ }
            $readerHit = @($rawReaders | Where-Object { $line.Contains($_) })
            if ($readerHit.Count) {
                [void]$offenders.Add("$($file.Name):${number}: $($readerHit[0]) reads a Desk path held in '$named' -- use Get-DeskFileEntries or Read-DeskFileLines -- $($line.Trim())")
            }
            $writerHit = @($rawWriters | Where-Object { $line.Contains($_) })
            if ($writerHit.Count) {
                [void]$offenders.Add("$($file.Name):${number}: $($writerHit[0]) truncates a Desk path held in '$named' -- use Write-AtomicText -- $($line.Trim())")
            }
        }
    }

    if ($offenders.Count) {
        throw ("$($offenders.Count) Desk-state violation(s): $(@($offenders) -join ' | '). " +
            'A Desk file is replaced with Write-AtomicText, which publishes by rename, and read with ' +
            'Get-DeskFileEntries or Read-DeskFileLines, which retry through Read-AtomicBytes. The two are ' +
            'one contract (AtomicFile.ps1:6-9) and half of it is not a fix: the readers hold no lock by ' +
            'design and three of them are hooks. See docs/notebook-and-desk-model.md.')
    }
    # THE SUBJECT SET IS DERIVED AND MUST NOT BE EMPTY. Rename either speller, or reshape the AST walk,
    # and every one of these counters goes to zero -- which would otherwise report "0 of 0 correct" in
    # green. That silent pass is the failure this whole family of checks keeps having to be defended
    # against, and it is why the three counts are asserted separately rather than summed.
    if (-not $filesWithDeskPaths) { throw 'no source was found to carry a Desk path at all; the taint walk read nothing rather than proving anything.' }
    if (-not $routedReads) { throw 'no source was found to call Get-DeskFileEntries or Read-DeskFileLines; the routed reader has been renamed or removed.' }
    if (-not $routedWrites) { throw 'no source was found to write a Desk path through Write-AtomicText; the routed writer has been renamed or removed.' }
    "$scanned source(s) scanned, $filesWithDeskPaths carrying a Desk path; $routedReads routed read(s) and $routedWrites routed write(s), no truncating write and no unretried read"
}

# A ROLLBACK RE-DERIVES THE DERIVED INDEX; THE CHECK ABOVE ONLY STOPS IT RESTORING ONE (2026-09-18).
#
# The two rules are halves of one repair and neither is sufficient. Taking the master index out of a
# journal stops a rollback writing a stale snapshot back -- and leaves the index describing a state
# that no longer exists, because the topic the failed run promoted has just been withdrawn. So every
# writer that renders on its way in has to render on its way out, and that is what this holds.
#
# THE SUBJECT SET IS DERIVED, NEVER LISTED. A helper is subject to the rule exactly when it calls a
# renderer AND calls Restore-BookJournal: the first says it can move the derived index, the second
# says it has a rollback path to move it back from. Four helpers qualify today. A list here would be
# a second copy of that fact, stale the next time a writer is added -- the defect
# gate.fast-roster-matches-suites exists for, one subject over.
#
# IT FAILS ON AN EMPTY SUBJECT SET RATHER THAN PASSING. A renamed wrapper, a reshaped catch, or an
# AST walk that finds nothing would otherwise report "0 of 0 correct" in green, which is the silent
# pass this whole family of checks keeps having to be defended against.
#
# AND IT PINS THE SAFE FORM. Three helpers call Restore-BookJournal and no renderer at all --
# Add-ShelfBookPage, Add-ShelfNote, Set-ShelfBookPageStub -- and requiring a render of them would be
# the check firing on correct code. At least one must be observed OUTSIDE the subject set, or the
# scoping has quietly become "every rollback".
Invoke-Check 'derived-indexes.rollback-re-renders' {
    $renderers = @('Invoke-NotebookRender', 'Invoke-ShelfCatalogRender')
    $rollbackRenderers = @('Invoke-NotebookRenderAfterRollback', 'Invoke-ShelfCatalogRenderAfterRollback')
    $manifest = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '_helpers.json')) | ConvertFrom-Json
    $roles = @{}
    foreach ($property in @($manifest.helpers.PSObject.Properties)) { $roles[$property.Name] = [string]$property.Value.role }

    # The wrappers must exist where they are documented to, or every requirement below is satisfiable
    # by a name nothing defines.
    foreach ($pair in @(@{ file = 'NotebookIndex.ps1'; fn = 'Invoke-NotebookRenderAfterRollback' },
                        @{ file = 'ShelfCatalog.ps1'; fn = 'Invoke-ShelfCatalogRenderAfterRollback' })) {
        $moduleText = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $pair.file))
        if ($moduleText -cnotmatch ('(?m)^function\s+' + [regex]::Escape($pair.fn) + '\s*\{')) {
            throw "$($pair.file) does not define $($pair.fn), so the rollback rule below names a function nothing provides."
        }
    }

    $subjects = [Collections.Generic.List[string]]::new()
    $restoreOnly = [Collections.Generic.List[string]]::new()
    $offenders = [Collections.Generic.List[string]]::new()
    $catchesChecked = 0

    foreach ($file in @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.ps1')) {
        if ($file.Name -cin @('NotebookIndex.ps1', 'ShelfCatalog.ps1', 'BookWriteGuard.ps1')) { continue }
        if ($roles.ContainsKey($file.Name) -and $roles[$file.Name] -ceq 'test') { continue }
        $text = [IO.File]::ReadAllText($file.FullName)
        if (-not $text.Contains('Restore-BookJournal')) { continue }

        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$parseErrors)
        if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) { throw "$($file.Name) does not parse; the rollback rule cannot read it." }

        # Command NAMES from the AST, never a substring of the source: a quoted name, a name in a
        # throw message and a name in a .DESCRIPTION are all not calls, and each has cost this
        # repository a false positive before.
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($command in @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true))) {
            $commandName = $command.GetCommandName()
            if ($null -ne $commandName) { [void]$names.Add($commandName) }
        }
        if (-not $names.Contains('Restore-BookJournal')) { continue }
        if (-not @(@($renderers) + @($rollbackRenderers) | Where-Object { $names.Contains($_) }).Count) {
            [void]$restoreOnly.Add($file.Name)
            continue
        }
        [void]$subjects.Add($file.Name)

        foreach ($catchClause in @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CatchClauseAst] }, $true))) {
            $inCatch = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            foreach ($command in @($catchClause.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true))) {
                $commandName = $command.GetCommandName()
                if ($null -ne $commandName) { [void]$inCatch.Add($commandName) }
            }
            if (-not $inCatch.Contains('Restore-BookJournal')) { continue }
            $catchesChecked++
            if (@($rollbackRenderers | Where-Object { $inCatch.Contains($_) }).Count) { continue }
            [void]$offenders.Add("$($file.Name) line $($catchClause.Extent.StartLineNumber): a catch restores a journal and never re-renders")
        }
    }

    if (-not $subjects.Count) {
        throw ('No helper was found that both renders a derived index and restores a journal, so this check ' +
            'asserted nothing. Either the renderer or Restore-BookJournal has been renamed, or the AST walk is broken.')
    }
    if (-not $catchesChecked) {
        throw ("$($subjects.Count) subject(s) were found but no catch clause among them restores a journal, so the " +
            'rule matched nothing. A reshaped rollback is not an exemption from it.')
    }
    if (-not $restoreOnly.Count) {
        throw ('Every helper that restores a journal now also renders, so the safe form -- a rollback with no derived ' +
            'index behind it -- is unobserved and this rule can no longer be shown to be scoped.')
    }
    if ($offenders.Count) {
        throw ("$($offenders.Count) rollback(s) restore a journal without re-deriving the index they moved: " +
            "$(@($offenders) -join ' | '). The journal holds the AUTHORITY -- the topic _index.md, the Book " +
            '_catalog-entry.md -- and the derived index is rendered from it afterwards, inside the render lock, with ' +
            'Invoke-NotebookRenderAfterRollback or Invoke-ShelfCatalogRenderAfterRollback. See docs/derived-indexes.md.')
    }
    ("$($subjects.Count) writer(s) render and roll back -- $(@($subjects | Sort-Object) -join ', ') -- and all " +
        "$catchesChecked restoring catch(es) re-derive; $($restoreOnly.Count) journal-only rollback(s) correctly exempt")
}

# --- An `excluded` declaration is earned, or it is refused (ADR-0025, encoded 2026-09-18) --------
#
# IT IS REGISTERED ABOVE THE if ($Fast) BLOCK, so it runs in the pre-commit gate as well as the full
# one: it is in-process and fixture-only, and the ruling it encodes had already been misjudged twice
# while it was still prose -- d8481c3 upheld the shield ADR-0025 refutes. A ruling not encoded in a
# check decays, and this one has the receipts.
#
# THE NEGATIVES ARE THE HALF THAT MATTERS, and there are four. A guard keyed on "this slug has a
# published Book" refuses a topic that legitimately holds what its Book does not, which is a real use
# blocked by a guard firing on correct code. `partly` is the DECOY among them: a completed journal,
# nothing drifted, and one page the Book never received -- so a guard reading
# known_copy_drifted_count instead of ADR-0022's pages_without_current_copy is green on every other
# row here and wrong on that one.
#
# IT DRIVES THE REAL WRITER. Set-NotebookTopicOwner is called, not its condition re-implemented, so
# deleting the guard from the writer turns the positive red rather than leaving a suite that agrees
# with itself.
Invoke-Check 'notebook.exclusion-must-be-earned' {
    . (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')
    $problems = [Collections.Generic.List[string]]::new()
    $utf8 = [Text.UTF8Encoding]::new($false)
    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('nb-excl-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        New-Item -ItemType Directory -Path (Join-Path $fixture '.claude') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $fixture 'internal/publication-journals') -Force | Out-Null

        function New-FixturePage([string]$Topic, [string]$Name, [string]$Text) {
            $full = Join-Path $fixture "notebook/$Topic/$Name"
            New-Item -ItemType Directory -Path (Split-Path -Parent $full) -Force | Out-Null
            [IO.File]::WriteAllText($full, $Text, $utf8)
            $sha = [Security.Cryptography.SHA256]::Create()
            try { ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($full)))).Replace('-', '').ToLowerInvariant() }
            finally { $sha.Dispose() }
        }
        function New-FixtureRecord([string]$Topic, [string]$Name, [string]$Sha) {
            [ordered]@{ path = "books/$Topic/wiki/$Topic/$Name"; source = "notebook/$Topic/$Name"; sha256 = $Sha }
        }
        # THE REAL JOURNAL SHAPE, field for field from internal/publication-journals: a completed Book
        # publish carries state, timestamp_utc and book_slug, plus one planned_record per page holding
        # the SOURCE hash it copied. The two readers this guard composes key on different subsets of
        # those -- the evidence function on the header, the inventory on the records -- so a fixture
        # inventing a shape would prove neither of them.
        function New-FixtureJournal([string]$Slug, $Records) {
            $body = [ordered]@{
                state = 'complete'
                timestamp_utc = '2026-09-01T00:00:00.0000000Z'
                book_slug = $Slug
                collection = 'Reference'
                planned_records = @($Records)
                attempted_records = @()
                created_records = @()
                reused_records = @()
                error = ''
            }
            [IO.File]::WriteAllText((Join-Path $fixture ('internal/publication-journals/' + $Slug + '-' + ('1' * 64) + '.json')),
                ($body | ConvertTo-Json -Depth 6), $utf8)
        }

        # reproducible -- every page a hash-bound current copy. The live notebook/orca-ide shape.
        $reproducibleOne = New-FixturePage 'reproducible' 'one.md' "# One`n"
        $reproducibleTwo = New-FixturePage 'reproducible' 'two.md' "# Two`n"
        New-FixtureJournal 'reproducible' @((New-FixtureRecord 'reproducible' 'one.md' $reproducibleOne), (New-FixtureRecord 'reproducible' 'two.md' $reproducibleTwo))

        # drifted -- page two's recorded hash is of another version, so the Notebook holds text the
        # Book does not and a rebuild would lose it. The case the drift half exists for.
        $driftedOne = New-FixturePage 'drifted' 'one.md' "# One`n"
        $null = New-FixturePage 'drifted' 'two.md' "# Two, edited since it was published`n"
        New-FixtureJournal 'drifted' @((New-FixtureRecord 'drifted' 'one.md' $driftedOne), (New-FixtureRecord 'drifted' 'two.md' ('0' * 64)))

        # partly -- THE DECOY. A completed journal, nothing drifted, and page two never published.
        $partlyOne = New-FixturePage 'partly' 'one.md' "# One`n"
        $null = New-FixturePage 'partly' 'two.md' "# Two, written after the publish`n"
        New-FixtureJournal 'partly' @((New-FixtureRecord 'partly' 'one.md' $partlyOne))

        # unpublished -- no journal at all. The declaration this guard exists to leave alone.
        $null = New-FixturePage 'unpublished' 'one.md' "# One`n"

        # emptied -- a completed journal and no page on disk, so pages_without_current_copy is
        # vacuously zero. A vacuous truth must not drive a refusal.
        New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/emptied') -Force | Out-Null
        New-FixtureJournal 'emptied' @((New-FixtureRecord 'emptied' 'gone.md' ('f' * 64)))

        # --- the numbers the refusal is built from, before anything is declared -------------------
        foreach ($expected in @(
            @{ topic = 'reproducible'; journals = 1; pages = 2; drifted = 0; unproven = 0; verdict = $true }
            @{ topic = 'drifted';      journals = 1; pages = 2; drifted = 1; unproven = 1; verdict = $false }
            @{ topic = 'partly';       journals = 1; pages = 2; drifted = 0; unproven = 1; verdict = $false }
            @{ topic = 'unpublished';  journals = 0; pages = 1; drifted = 0; unproven = 1; verdict = $false }
        )) {
            $evidence = Get-NotebookTopicReproducibility -Workspace $fixture -Topic ([string]$expected.topic)
            $actual = "$([int]$evidence.complete_publication_journals)/$([int]$evidence.page_count)/$([int]$evidence.known_copy_drifted_count)/$([int]$evidence.pages_without_current_copy)/$([bool]$evidence.provably_reproducible)"
            $wanted = "$([int]$expected.journals)/$([int]$expected.pages)/$([int]$expected.drifted)/$([int]$expected.unproven)/$([bool]$expected.verdict)"
            if ($actual -cne $wanted) {
                [void]$problems.Add("notebook/$($expected.topic) reads journals/pages/drifted/unproven/verdict $actual, expected $wanted")
            }
        }
        # The empty topic separately, because what it proves is a field rather than a count: its
        # journal half IS satisfied, so the allow has to come from the pages half being unmeasured.
        $emptied = Get-NotebookTopicReproducibility -Workspace $fixture -Topic 'emptied'
        if ([int]$emptied.complete_publication_journals -ne 1) {
            [void]$problems.Add("the empty topic's journal was not read at all, so it proves nothing about the pages half: $([int]$emptied.complete_publication_journals) completed journal(s), expected 1")
        }
        if ([bool]$emptied.pages_measured -or [bool]$emptied.provably_reproducible) {
            [void]$problems.Add('a topic with a completed journal and no page on disk read as measured or as provably reproducible; zero pages without a current copy is a vacuous truth, not proof')
        }

        function Get-FixtureScope([string]$Topic) {
            $entry = Get-NotebookTopicOwner -Owners (Read-NotebookTopicOwners -Workspace $fixture) -Topic $Topic
            if ($null -eq $entry) { 'unmapped' } else { [string]$entry.scope }
        }
        function Invoke-Exclusion([string]$Topic, [switch]$Accept) {
            try {
                Set-NotebookTopicOwner -Workspace $fixture -Topic $Topic -Scope excluded -AcceptReproducible:$Accept
                [pscustomobject]@{ refused = $false; message = '' }
            }
            catch { [pscustomobject]@{ refused = $true; message = [string]$_.Exception.Message } }
        }

        # --- the positive: refused, with the evidence and the route, and NOTHING written ----------
        $refusal = Invoke-Exclusion 'reproducible'
        if (-not $refusal.refused) {
            [void]$problems.Add('a topic whose every page is a hash-bound current copy of a published Book was declared excluded without a word -- ADR-0025 is prose again')
        }
        else {
            foreach ($fragment in @('provably reproducible', 'ADR-0025', 'tools/Restore-BookSource.ps1 -Book reproducible', '-AcceptReproducible')) {
                if (-not $refusal.message.Contains($fragment)) {
                    [void]$problems.Add("the refusal never names '$fragment', so the reader is stopped without the evidence or the way past it: $($refusal.message)")
                }
            }
        }
        if ((Get-FixtureScope 'reproducible') -cne 'unmapped') {
            [void]$problems.Add("the refused declaration wrote a record anyway: notebook/reproducible reads '$(Get-FixtureScope 'reproducible')'")
        }

        # --- the negatives: four topics that must still be declarable -----------------------------
        foreach ($case in @(
            @{ topic = 'drifted';     why = 'it holds a page of which the Book has an older version -- the case the drift half exists for' }
            @{ topic = 'partly';      why = 'it holds a page the Book never received, which no drifted count reports' }
            @{ topic = 'unpublished'; why = 'no completed publication journal names a Book of its slug at all' }
            @{ topic = 'emptied';     why = 'it has no page on disk, so nothing was measured and nothing is proven' }
        )) {
            $allowed = Invoke-Exclusion ([string]$case.topic)
            if ($allowed.refused) {
                [void]$problems.Add("notebook/$($case.topic) was refused an excluded declaration, but $($case.why): $($allowed.message)")
            }
            elseif ((Get-FixtureScope ([string]$case.topic)) -cne 'excluded') {
                [void]$problems.Add("notebook/$($case.topic) was allowed, but its record reads '$(Get-FixtureScope ([string]$case.topic))'")
            }
        }

        # --- the override: the declaration stays the reader's, it just has to survive the look ----
        $accepted = Invoke-Exclusion 'reproducible' -Accept
        if ($accepted.refused) {
            [void]$problems.Add("-AcceptReproducible did not get past the refusal, so that refusal names a remedy which does not work: $($accepted.message)")
        }
        elseif ((Get-FixtureScope 'reproducible') -cne 'excluded') {
            [void]$problems.Add("-AcceptReproducible reported success and left the record reading '$(Get-FixtureScope 'reproducible')'")
        }

        # --- and the guard is scoped to `excluded`, which is the word that claims preciousness -----
        # `shared` means deliberately common ground, and a shared topic that is also a published Book
        # is an ordinary correct use of it. A guard that spread to both would block that.
        try {
            Set-NotebookTopicOwner -Workspace $fixture -Topic 'reproducible' -Scope shared
            if ((Get-FixtureScope 'reproducible') -cne 'shared') {
                [void]$problems.Add("declaring a reproducible topic -Scope shared left the record reading '$(Get-FixtureScope 'reproducible')'")
            }
        }
        catch {
            [void]$problems.Add("a reproducible topic was refused -Scope shared; the guard has spread past the declaration it was written for: $($_.Exception.Message)")
        }

        if ($problems.Count) { throw ($problems -join '; ') }
        'five fixture topics: one provably reproducible and refused, then written under -AcceptReproducible, and four still declarable -- drifted, partly published, unpublished, and empty'
    }
    finally {
        if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

# --- The -Fast roster stands for the suites it reports skipped (2026-09-08) ----------------------
#
# WHY THIS EXISTS. This runner spells every spawned suite's name TWICE: as an Invoke-Check call
# inside the $Fast else branch, and as a string roster in the $Fast arm that reports each one
# skipped. A name in the else branch but missing from the roster does not run in -Fast AND is not
# reported skipped, so the pre-commit hook's summary line silently counts one fewer. That line is
# the whole report for most commits, which makes a quiet undercount worse than a failure, because
# it reads as success.
#
# IT HAS HAPPENED TWICE, and neither time was it a check that found it. The comment above
# meter-status.selftest records the first instance of the class; reader.project-pin-selftest shipped
# unrostered on 4daadc3 and was corrected in 0ef4731. Both were caught by a person reading the
# summary's arithmetic, which is not a mechanism.
#
# BOTH SETS COME FROM THIS FILE'S OWN AST, and there is deliberately no expected count anywhere in
# this check. A literal number would be a THIRD copy of the same list, stale the next time a suite
# is added, and two copies disagreeing is the entire defect. desk.seat-paths-resolve and
# desk.lock-order already carry that rule for their own subjects.
#
# IT IS REGISTERED HERE, ABOVE THE if ($Fast) BLOCK, WHICH IS THE POINT. It is a static read of
# source text, not a spawned suite: put it in the else branch and -Fast skips it, which is the exact
# run it exists to protect. Confirm it appears in BOTH modes after any edit to it.
#
# SCOPED TO THE $Fast ELSE BRANCH ONLY. The three -IncludeShared suites sit outside it in their own
# if/else and are reported skipped for a different reason by a different arm; pulling them in would
# make this check fail on correct code.
#
# ASSERTED IN BOTH DIRECTIONS, because the two faults differ. A roster name matching no check is a
# suite nothing runs in EITHER mode. A check missing from the roster is the defect that shipped.
#
# WHAT MAKES A WRONG IMPLEMENTATION REPORT A WRONG VALUE RATHER THAN FIND NOTHING. Reading every
# string literal out of the two branches, instead of the roster array and the call names, picks up
# 'skipped', the skip reason and every suite's 'passed', so it fails loudly. A regex over the source
# text picks up the decoy planted in a comment at the top of the else branch. And an AST walk that
# locates no branch, no roster, or an empty set throws here rather than comparing two empty sets and
# passing: 0 equals 0 is the silent pass this check would otherwise have.
Invoke-Check 'gate.fast-roster-matches-suites' {
    $runner = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'Invoke-LibraryChecks.ps1')).Path
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($runner), [ref]$null, [ref]$parseErrors)
    if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) {
        throw 'Invoke-LibraryChecks.ps1 does not parse; the -Fast roster check cannot read it.'
    }

    # The one branch, matched on the condition's identity rather than its text, and required to be
    # the bare switch: a reshaped condition stops this check reading anything, and it must say so
    # rather than compare two empty sets.
    $branches = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.IfStatementAst] -and
        @($node.Clauses).Count -eq 1 -and
        $null -ne $node.ElseClause -and
        $node.Clauses[0].Item1 -is [Management.Automation.Language.PipelineAst] -and
        $node.Clauses[0].Item1.GetPureExpression() -is [Management.Automation.Language.VariableExpressionAst] -and
        $node.Clauses[0].Item1.GetPureExpression().VariablePath.UserPath -eq 'Fast'
    }, $true))
    if (@($branches).Count -ne 1) {
        throw ("expected exactly one bare if (`$Fast) { ... } else { ... } statement in this runner, found " +
            "$(@($branches).Count). Both name sets are derived from that statement, so a reshaped branch leaves " +
            'this check reading nothing -- reshape the derivation with it rather than deleting this assertion.')
    }
    $fastArm = $branches[0].Clauses[0].Item2
    $elseArm = $branches[0].ElseClause

    # The roster, from the foreach's enumerated array and nowhere else in that arm: the arm also
    # holds 'skipped' and the skip reason, which are not suite names.
    $loops = @($fastArm.FindAll({ $args[0] -is [Management.Automation.Language.ForEachStatementAst] }, $true))
    if (@($loops).Count -ne 1) {
        throw "expected one foreach over the -Fast roster, found $(@($loops).Count); the roster is no longer where this check reads it."
    }
    $roster = @($loops[0].Condition.FindAll({ $args[0] -is [Management.Automation.Language.StringConstantExpressionAst] }, $true) |
        ForEach-Object { [string]$_.Value })

    # The suites, from the first argument of every Invoke-Check call in the else branch.
    $suites = [Collections.Generic.List[string]]::new()
    foreach ($call in @($elseArm.FindAll({
            param($node)
            $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Invoke-Check'
        }, $true))) {
        $arg = $call.CommandElements[1]
        if ($arg -isnot [Management.Automation.Language.StringConstantExpressionAst]) {
            throw ("the Invoke-Check on line $($call.Extent.StartLineNumber) names its check with $($arg.Extent.Text) " +
                'rather than a literal; a roster cannot stand for a name computed at run time.')
        }
        [void]$suites.Add([string]$arg.Value)
    }

    if (-not $roster.Count) { throw 'the -Fast roster is empty; this check read nothing rather than proving anything.' }
    if (-not $suites.Count) { throw 'no Invoke-Check call was found in the $Fast else branch; this check read nothing rather than proving anything.' }

    # Duplicates first, because a repeated name makes the two counts agree while one suite is
    # rostered twice and another not at all.
    $rosterSet = @($roster | Sort-Object -Unique)
    $suiteSet = @($suites | Sort-Object -Unique)
    if ($rosterSet.Count -ne $roster.Count) {
        throw "the -Fast roster names $(@($roster | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name }) -join ', ') more than once."
    }
    if ($suiteSet.Count -ne $suites.Count) {
        throw "the `$Fast else branch registers $(@($suites | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name }) -join ', ') more than once."
    }

    $unrun = @($rosterSet | Where-Object { $suiteSet -notcontains $_ })
    $unreported = @($suiteSet | Where-Object { $rosterSet -notcontains $_ })
    $faults = [Collections.Generic.List[string]]::new()
    if ($unrun.Count) {
        [void]$faults.Add("$($unrun.Count) -Fast roster name(s) match no Invoke-Check in the `$Fast else branch, so nothing runs them in EITHER mode: $($unrun -join ', ')")
    }
    if ($unreported.Count) {
        [void]$faults.Add("$($unreported.Count) spawned suite(s) are absent from the -Fast roster, so -Fast neither runs nor reports them and the pre-commit summary counts that many short: $($unreported -join ', ')")
    }
    if ($faults.Count) { throw ($faults -join '; ') }

    "$($rosterSet.Count) -Fast roster name(s) and $($suiteSet.Count) spawned suite(s), sets equal both ways"
}

# --- Every payload field a hook reads has been seen on a real payload ------------------------------
# A hook is handed a JSON payload by the harness and reads named fields out of it. `Get-HookField`
# answers $null for a name that is not there, on purpose, because the payload's shape varies by
# event -- so a field that is RENAMED, MOVED or GUESSED costs the hook its entire job and says
# nothing. It is the quietest failure in this tree, and it has now shipped three times:
#
#   `startup_reason` on SessionStart   Restore-CompactedGuidance.ps1 exited early on every session
#                                      start for four days; found 2026-09-09 by capturing a payload.
#   `config_source` on ConfigChange    Guard-SettingsIntegrity.ps1 -- a hook that REFUSES -- never
#                                      judged one real settings edit between 2026-09-06 and
#                                      2026-09-19. The field is `source`. Found by capturing one.
#   the serve ledger's own cap         not this shape, but mistaken for it by two reports, because a
#                                      silent $null is what a dead hook looks like from the outside.
#
# A SUITE THAT COMPOSES THE PAYLOAD CANNOT CATCH THIS, and section 5 of Test-LibraryHooks.ps1 is the
# proof: it fed `config_source` to the settings guard and asserted every denial correctly for
# thirteen days. It proved the guard works when GIVEN the field. Nothing asserted the field arrives.
# That is the gap this check closes, and it closes it with measurement rather than with a rule --
# `.claude/hooks/payload-contract.json` holds the field set of a payload actually captured from the
# client, per event, and this compares the reads against it.
#
# BOTH DIRECTIONS, because the two faults differ. A read no captured event covers is a hook that may
# already be dead. A stale entry in `unverified_reads` is an exemption outliving its cause -- and an
# exemption nobody re-derives is how the first two of those three defects stayed invisible.
#
# WHAT MAKES A WRONG IMPLEMENTATION FAIL RATHER THAN FIND NOTHING. Three vacuity guards, because
# every one of them is a way this check could pass while reading nothing: no registered hook, no
# captured event, or no payload read found. A count cannot prove a detector still matches, so
# `library-hooks.boundary-suite` plants the two historical field names against a fixture contract
# and requires them rejected.
#
# IT IS REGISTERED HERE, ABOVE THE if ($Fast) BLOCK, because it is a static read of source text and
# one JSON file, and a hook that has stopped firing is exactly what a pre-commit gate should say.
Invoke-Check 'hooks.payload-fields-are-captured' {
    . (Join-Path $PSScriptRoot 'HookRegistry.ps1')
    $hookDir = Join-Path $workspace '.claude/hooks'
    $contractPath = Join-Path $hookDir 'payload-contract.json'
    if (-not (Test-Path -LiteralPath $contractPath -PathType Leaf)) {
        throw '.claude/hooks/payload-contract.json is missing, so no hook payload read can be checked against anything.'
    }
    try { $contract = [IO.File]::ReadAllText($contractPath) | ConvertFrom-Json }
    catch { throw ".claude/hooks/payload-contract.json is not valid JSON: $($_.Exception.Message)" }

    $shape = Get-PayloadContractShape $contract
    if (-not @($shape.captured).Count) {
        throw 'payload-contract.json records no captured event, so every read would be verified against nothing.'
    }

    $required = @(Get-RequiredHooks)
    if (-not $required.Count) { throw 'HookRegistry.ps1 declares no hooks; this check read nothing rather than proving anything.' }
    foreach ($hook in $required) {
        foreach ($eventName in @($hook.events)) {
            if (-not $shape.fields.ContainsKey($eventName)) {
                throw "payload-contract.json has no entry for '$eventName', which $($hook.file) is registered on; a read on that event would be judged by silence."
            }
        }
    }

    $reads = @(Get-HookPayloadReads $hookDir $required)
    if (-not $reads.Count) { throw 'no payload field read was found in any registered hook; this check read nothing rather than proving anything.' }

    $problems = @(Get-PayloadContractProblems $contract $shape $reads)
    if ($problems.Count) {
        throw ("$($problems.Count) payload-contract fault(s): " + ($problems -join '; ') +
            '. Capture a payload into .claude/hooks/.capture/ and rebuild the contract, or correct the field name.')
    }

    $roots = @($contract.PSObject.Properties | ForEach-Object { $_.Name })
    $exempt = if ($roots -ccontains 'unverified_reads') { @(@($contract.unverified_reads) | Where-Object { $null -ne $_ }).Count } else { 0 }
    $hookCount = @($reads | ForEach-Object { $_.hook } | Sort-Object -Unique).Count
    # THE PER-CLIENT COVERAGE IS IN EVERY ANSWER, CLEAN OR NOT. A second harness is only guarded for
    # the events actually captured from it, and a figure that appears only on failure is one nobody
    # reads -- the same rule mcp-tool-inventory follows for its not_enumerable servers.
    $perClient = @{}
    foreach ($eventName in @($shape.clientFields.Keys)) {
        foreach ($clientName in @($shape.clientFields[$eventName].Keys)) {
            if (-not $perClient.ContainsKey($clientName)) { $perClient[$clientName] = [Collections.Generic.List[string]]::new() }
            [void]$perClient[$clientName].Add($eventName)
        }
    }
    $coverage = @(@($perClient.Keys) | Sort-Object | ForEach-Object { "$_ $(@($perClient[$_]).Count)" }) -join ', '
    "$($reads.Count) payload read(s) across $hookCount hook(s); captured events per client: $coverage; $exempt declared unverified"
}

# --- The collection export lock reaches every writer ----------------------------------------------
#
# PLAN-public-release.md step 15, contract (a): publication, refresh, archive and Hub-edit helpers
# must refuse while a collection-wide export holds the workspace. That coverage rests on exactly two
# lines -- one in Enter-BookLock, one in Assert-SeatClaimHeld -- and both live in functions nobody
# edits for this reason, so either could be dropped in an unrelated refactor and nothing would fail.
# It is the same shape as the barrier's coverage and is checked the same way: through the AST, on
# the call rather than on the text, so a mention in a comment does not satisfy it.
Invoke-Check 'export-lock.reaches-both-chokepoints' {
    # Declared here rather than shared: Invoke-Check runs each body in a child scope, so a function
    # defined inside another check is not in scope in this one.
    function Get-ExportLockAst([string]$Path) {
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($Path), [ref]$null, [ref]$parseErrors)
        if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) { throw "$(Split-Path -Leaf $Path) does not parse; the export-lock coverage check cannot read it." }
        $ast
    }

    $problems = [Collections.Generic.List[string]]::new()
    $checked = 0
    foreach ($pair in @(@{ file = 'BookWriteGuard.ps1'; fn = 'Enter-BookLock' }, @{ file = 'LibrarySeat.ps1'; fn = 'Assert-SeatClaimHeld' })) {
        $path = Join-Path $PSScriptRoot $pair.file
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { [void]$problems.Add("$($pair.file) is missing, so the export lock's coverage cannot be read"); continue }
        $ast = Get-ExportLockAst $path
        $wanted = $pair.fn
        $target = @($ast.FindAll({
            $args[0] -is [Management.Automation.Language.FunctionDefinitionAst]
        }, $true) | Where-Object { [string]$_.Name -ceq $wanted })
        if (@($target).Count -ne 1) { [void]$problems.Add("$($pair.file) defines $wanted $(@($target).Count) time(s); the export lock's coverage cannot be derived from it"); continue }
        # THE FUNCTION'S OWN BODY, not the file: a call anywhere else in BookWriteGuard.ps1 would
        # pass a file-wide search and guard nothing a writer actually passes through.
        $calls = @($target[0].FindAll({ $args[0] -is [Management.Automation.Language.CommandAst] }, $true) |
            Where-Object { [string]$_.GetCommandName() -ceq 'Assert-NoCollectionExport' })
        if (-not @($calls).Count) {
            [void]$problems.Add("$wanted does not call Assert-NoCollectionExport, so a writer could start inside a whole-collection capture and be mirrored half-done")
        }
        $checked++
    }
    if ($problems.Count) { throw ($problems -join '; ') }
    "$checked chokepoint(s) refuse while a collection export holds the workspace"
}

# --- No deployment default reaches a product file -------------------------------------------------
#
# PLAN-public-release.md step 11. The Basic Memory endpoint used to sit in fourteen tracked files,
# the share roots in one and the collection id in seventeen; all of it is generated state now, and
# THIS is what keeps it that way. Above the -Fast branch on purpose: it is the one check standing
# between a pasted-back endpoint and a public repository, so it runs on every commit, not only in
# the twenty-minute gate.
#
# NO ENUMERATED INVENTORY IS TRUSTED. It does not check thirty-two known files -- it asks every
# product file git tracks whether it says where this collection lives. tools/DeploymentScan.ps1
# owns the two detectors, the scope rules and the documentation allowances, and its own fixture
# suite is what stops the detectors going vacuous; see deployment-scan.selftest below. A count
# cannot prove a detector still matches, so the count here is reported and never asserted on.
Invoke-Check 'public.no-deployment-defaults' {
    . (Join-Path $PSScriptRoot 'DeploymentScan.ps1')
    $files = @(Get-DeploymentScanFiles -Workspace $workspace)
    $denylist = @(Get-DeploymentScanDenylist -Workspace $workspace)
    $hits = @(Find-DeploymentScanHits -Workspace $workspace -Files $files -Denylist $denylist)
    if ($hits.Count) {
        $named = @($hits | ForEach-Object { "$($_.file):$($_.line) [$($_.kind)] $($_.match)" } | Sort-Object -Unique)
        throw ("$($hits.Count) deployment default(s) in product files: " + ($named -join '; ') +
            '. These ship. Move the value into generated state and resolve it through tools/LibraryDeployment.ps1.')
    }
    # The configured-deployment half is empty on a workspace with none, which is a legitimate state
    # and not a pass worth hiding -- so the denylist size is stated in every answer, clean or not.
    "$($files.Count) product file(s) clean against $($denylist.Count) configured value(s) and the structural detectors"
}

# --- No identity of the reader's reaches a public commit -------------------------------------------
#
# PLAN-public-release.md step 12, local half, and the second half of what tools/DeploymentScan.ps1
# carries. Above the -Fast branch beside public.no-deployment-defaults, for the same reason: it is a
# gate on the commit, and a gate that only runs in the twenty-minute suite is not on the commit.
#
# THE DIFFERENCE BETWEEN THE TWO CHECKS IS THE FILE SET, AND IT IS THE WHOLE POINT.
# public.no-deployment-defaults reads the WORKING TREE, because a deployment default is a property
# of the product's source whether or not anyone is committing today. This one reads the INDEX --
# `git diff --cached` for the paths, `git cat-file blob :<path>` for the bytes -- because identity
# is a property of what a commit PUBLISHES, and the working tree is a different set of bytes the
# moment anyone stages a hunk or edits after staging.
#
# The denylist is never in a repository: %USERPROFILE%\.library\identity-denylist.txt, with the
# approved-attribution allowlist beside it. Its absence FAILS on a maintainer machine, because a
# check whose denylist nobody created has never matched anything and would read green forever;
# LIBRARY_IDENTITY_SCAN=contributor downgrades that absence to a warning and reaches for gitleaks.
# The commit message is scanned at the other boundary, by .githooks/commit-msg, because a message
# is not a blob until after that hook has passed it.
Invoke-Check 'public.identity-scan' {
    . (Join-Path $PSScriptRoot 'DeploymentScan.ps1')
    $result = Invoke-IdentityScan -Workspace $workspace
    if ($result.status -eq 'fail') { throw $result.detail }
    if ($result.status -eq 'warn') { return "WARN: $($result.detail)" }
    $result.detail
}

# --- Offline self-test suites ---------------------------------------------------------------------
if ($Fast) {
    foreach ($name in @('library-hooks.boundary-suite', 'library-helpers.boundary-suite', 'mcp-helpers.boundary-suite', 'book-write-guard.selftest', 'book-manifest.selftest', 'book-manifest-store.selftest', 'book-manifest-transaction.selftest', 'git-source.selftest', 'sources-block.selftest', 'mcp-directory-listing.selftest', 'library-deployment.selftest', 'deployment-scan.selftest', 'library-output.selftest', 'reader.shelf-selftest', 'reader.project-pin-selftest', 'new-project-hub.selftest', 'edit-project-hub.selftest', 'shelf-note.boundary-suite', 'shelf.manifest-backfill', 'shared.manifest-backfill', 'book-currency.shelf-path', 'shelf.writers-route-manifests', 'archive.search-coverage', 'book-discovery.selftest', 'book-fulltext.selftest', 'raw-search.selftest', 'mcp-tool-inventory.selftest', 'raw-batch-ownership.selftest', 'desk.book-root-selftest', 'desk.two-seat-acceptance', 'seat.lifecycle', 'recovery.routes', 'notebook.idle-seat-sweep', 'triage-inventory.selftest', 'triage.history-readable', 'meter-status.selftest', 'meter.parsers-agree', 'reader.dispatch-selftest', 'codex.portability-selftest', 'token-baseline.selftest', 'hub-migration-acceptance.selftest', 'hub-migration-snapshot.selftest', 'add-catalog-entry.selftest', 'remove-shared-entry.selftest', 'remove-memory-project.selftest', 'archive-shared-book.selftest', 'shared-collection-files.selftest', 'notebook-index.selftest', 'shelf-catalog.selftest', 'notebook.render-lock-narrow', 'maintenance.folder-move', 'collection-vault-export.selftest', 'public-tree-export.selftest', 'mirror-job.allowlist-rule-parity', 'plugin.generated-files-match')) {
        # This roster is the -Fast summary's only record that these suites exist. A check absent from
        # it does not run in -Fast AND is not reported skipped, so the pre-commit hook's line silently
        # counts one fewer -- the same shape as a suite nothing runs, one step quieter. The three
        # token-efficiency suites were added here for that reason, not because they behave differently.
        Add-Result $name 'skipped' 'suite skipped in -Fast mode'
    }
}
else {

# A DECOY FOR gate.fast-roster-matches-suites, DELIBERATE -- do not delete it. The next line spells
# the registration form of a suite that does not exist:
#     Invoke-Check 'roster.decoy-scraped-from-a-comment'
# That check reads this branch through the AST, where a comment is not a node, so it does not see
# the name. A regex or text implementation of the same check does see it, calls it a suite absent
# from the -Fast roster, and fails on correct code. That is the point: the wrong implementation
# reports a WRONG VALUE here rather than quietly agreeing with the right one on today's file.

Invoke-Check 'codex.portability-selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-CodexPortability.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 8) -join ' | ') }
    'passed'
}

# The JSON-RPC dispatch layer's argument guards, driven as a real process over stdio. A suite rather
# than a static check because it spawns the adapter; offline because every case fails at the guard
# before any Desk or network read.
Invoke-Check 'reader.dispatch-selftest' {
    $adapter = Join-Path $workspace '.claude/adapters/Validated-BookReader.ps1'
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $adapter -DispatchSelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

Invoke-Check 'reader.shelf-selftest' {
    $adapter = Join-Path $workspace '.claude/adapters/Validated-BookReader.ps1'
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $adapter -ShelfSelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}
# --- The Project pin is read from the workspace, at every seat (2026-09-08) -----------------------
#
# WHY THIS EXISTS. The seat migration split the WORKSPACE pin (`.claude/.library-project`, one per
# workspace) from the Desk files (per-seat) and taught Get-DeskState to take both directories.
# Read-ValidatedProjectCatalog and Read-ValidatedActiveProjectRoot resolved the pin themselves and
# passed the SEAT directory, so read_project_catalog and suggest_active_projects were refused at
# EVERY seat with 'Virtual Desk configuration is missing .library-project' while
# read_open_project_page and read_open_project_briefing, which route through Get-DeskState, answered
# in the same session. Two documented flows dead-ended on it: CLAUDE.md sends a reader who has not
# named their Project to suggest_active_projects, and the library-dev Hub names read_project_catalog
# as how to read which Hubs are active INSTEAD of writing a count that would go stale.
#
# WHY NOTHING CAUGHT IT, which is the part worth encoding. Both functions are network-dependent, so
# the adapter's offline self-tests could not reach them -- and its fixture models the split
# correctly, so the fixture was never the gap. The only existing test naming suggest_active_projects
# is a dispatch case that fails at the argument guard BEFORE any pin is resolved, so it passes
# whatever this bug does. No file in tools/ referenced either tool, and desk.two-seat-acceptance
# passed 26 cross-seat checks without touching them: 80 passed, 0 failed, and green was not coverage.
#
# WHAT THE SUITE DOES ABOUT IT. It EXECUTES both call sites offline against a shadowed transport and
# asserts the id that reached the wire, with a decoy pin planted in the seat's Desk directory so a
# call site reading the wrong one sends the wrong VALUE rather than merely failing to find a file.
# Its other half asserts the seat gate still refuses a Deskless session, because the workspace pin
# always exists -- fixing the directory without keeping that gate would have opened a hole.
Invoke-Check 'reader.project-pin-selftest' {
    $adapter = Join-Path $workspace '.claude/adapters/Validated-BookReader.ps1'
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $adapter -ProjectSelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# Every hook, driven as the real process the harness runs, against a fixture Desk. A hook is the one
# kind of code here that nothing calls during development: it is invoked by the harness, consumed by
# the harness, and a broken one does not throw where anybody is looking -- it stops guarding, or
# stops speaking, and the session carries on. Registration above proves they are switched on; this
# proves they do anything.
Invoke-Check 'library-hooks.boundary-suite' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-LibraryHooks.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 12) -join ' | ') }
    (($out | Select-Object -Last 1) | Out-String).Trim()
}

# The maintenance barrier and the folder cutover, driven against their own fixtures. A suite rather
# than a static check because it raises a real barrier and then runs the real Set-VirtualDesk and
# both real launchers against it -- maintenance.barrier-coverage proves the guards are WIRED, and
# only this proves they refuse, with the same calls succeeding without a barrier as the control.
Invoke-Check 'maintenance.folder-move' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-LibraryFolderMove.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 6) -join ' | ') }
    (($out | Select-Object -Last 1) | Out-String).Trim()
}

Invoke-Check 'library-helpers.boundary-suite' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-LibraryHelpers.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 6) -join ' | ') }
    'passed'
}

# Loopback only -- the stub endpoint stands in for the NAS, so this runs with the network down.
Invoke-Check 'mcp-helpers.boundary-suite' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-McpHelpers.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 8) -join ' | ') }
    'passed'
}

Invoke-Check 'book-write-guard.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'BookWriteGuard.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

Invoke-Check 'notebook-index.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'NotebookIndex.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

Invoke-Check 'shelf-catalog.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'ShelfCatalog.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# PLAN-multi-desk.md step 28a, and the slowest check in the gate by some way -- it launches eight
# processes and rewrites one file eight hundred times. It earns that: without it the narrow critical
# section is a claim rather than a property, and a widened lock breaks no other test and produces no
# wrong bytes. It only makes the Library slow in the exact case this project exists to make fast.
Invoke-Check 'notebook.render-lock-narrow' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-NotebookRenderLock.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 8) -join ' | ') }
    'passed'
}

Invoke-Check 'book-manifest.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'BookManifest.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

Invoke-Check 'book-manifest-store.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'BookManifestStore.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

Invoke-Check 'book-manifest-transaction.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'BookManifestTransaction.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# 2.2 rung 6's gate check. Discovery is the rung that finally reads the manifests, so it is the rung
# where a leak would actually reach a reader: body text in a result, a closed capture Book's note
# named, a dirty Book served as though it were current, or -- the quiet one -- a Book skipped without
# the answer admitting it. Every one of those has a canary in this suite.
# Book currency anchoring, step 1. This is the suite that holds the transport surface closed: it
# proves the ext:: rewrite through url.*.insteadOf cannot reach an isolated environment, that a
# repository's own config is refused before any repository-aware git command runs, and -- the case
# that would otherwise mint a false pin -- that discovery stops at the batch root instead of walking
# up into the Library's own repository, which is what bare `git -C raw/<batch>` actually does here.
Invoke-Check 'git-source.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'GitSource.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# Book currency anchoring, step 2. The round trip is the whole check: parse(emit(x)) == x. The file
# line is lifted verbatim from the compiler because every already-published article carries that
# exact spelling in the shared collection, where nothing local can rewrite it -- so a well-meaning
# tidy-up here would orphan pages that cannot be migrated. The malformed cases are covered too,
# because the Currency check's branch ordering depends on them being separable from `not anchored`.
Invoke-Check 'sources-block.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'SourcesBlock.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# The completeness proof for a paginated list_directory, shared by the shared-Book manifest source
# and the Project archiver. Both used to issue ONE unpaged call and check only that the directory's
# root note came back -- a guard a truncation satisfies whenever that name sorts early, which it
# always does. Measured 2026-09-05: 9 of obsidian-app's 17 pages, 4 of game-server-admin's 25.
Invoke-Check 'mcp-directory-listing.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'McpDirectoryListing.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

Invoke-Check 'book-discovery.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'BookDiscovery.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# 2.3's gate check. This is the first tier that returns body text, so its canaries assert the
# OPPOSITE of Discovery's: not that content never appears, but that it appears only for a Book the
# Desk says is open -- including a Book closed midway through the query, whose lines were already
# read and must still not be emitted. Sanitisation and the shared 2.5 caps are asserted here too.
Invoke-Check 'book-fulltext.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'BookFullText.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# 2.4's gate check. The third and last retrieval tier, and the only one whose material has no Desk,
# no catalog, and no manifest behind it. Its canaries are therefore about scope and provenance rather
# than about a Book being open: a hit from outside the NAMED batch, a Pilot-era line returned without
# its historical label, an unreadable file dropped instead of named, a cap exceeded without saying so,
# and a junction followed out of the batch. The historical label is the severe one -- it is what stops
# the Library's own retired instructions being cited back as current policy.
Invoke-Check 'raw-search.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'RawSearch.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# The MCP tool inventory's own suite. Its canaries are about the ENUMERATION rather than about the
# comparison: a tool named only inside a block comment must never reach the inventory, an adapter that
# answers nothing must fail rather than read as declaring nothing, and an adapter that hangs must cost
# a bounded wait. The fixture adapter is a real process over redirected stdin, because the invocation
# is the half that can actually break.
Invoke-Check 'mcp-tool-inventory.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'McpToolInventory.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# 3.1's gate check. Its canaries are about OWNERSHIP rather than about retrieval: an undeclared batch
# given an owner by name inference, a stored mapping that is not the canonical path RawSearch
# resolved, two records for one directory differing only in case, a deeper mapping losing to its
# parent -- and the severe one, an eviction offer or an empty candidate list stated as a finding when
# the Project Catalogs were never read. That last shape is 2.4's worst defect in another costume and
# it survived 87 green checks until the first live run.
Invoke-Check 'raw-batch-ownership.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'RawBatchOwnership.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# 3.2's gate check, and it is a MIGRATION's check rather than a feature's. Half of it exercises the
# schema directly; the other half drives the real producer, the real Desk overview, the real guard
# hook and the real reader adapter -- as separate processes, against a fixture workspace -- because a
# unit test of the schema would pass with half the codebase still carrying its own copy of the shape.
# The sharp canary is that opening the ARCHIVED Book must not open its active twin.
# THE CHECK THE STATIC ONE CANNOT BE. `desk.seat-paths-resolve` proves the Desk filenames disappeared
# from every file but the schema; it cannot prove every consumer resolves the same SEAT. That gap is
# the exact failure Release 2 exists to prevent -- a Book open for reading and closed for searching --
# so this drives real helpers and real guards as separate processes against two seats and asserts
# they agree. Necessary and sufficient only together.
Invoke-Check 'desk.two-seat-acceptance' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-TwoSeatAcceptance.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 8) -join ' | ') }
    [string]($out | Select-Object -Last 1)
}

# THE LIFECYCLE ITSELF, which the two-seat suite deliberately does not drive. That one fabricates its
# pair with Initialize-SeatForFixture because every assertion it makes is about two CONSUMERS
# disagreeing about one Desk. This one drives Start-LibrarySeat.ps1 and Retire-Seat.ps1 as REAL
# PROCESSES against a fixture workspace, because until 2026-09-09 the code that MINTS EVERY CLAIM on
# the mutation critical path appeared in no tools/Test-*.ps1 and carried no -SelfTest at all.
# PLAN-multi-desk.md risk 9.
#
# -NoLaunch IS WHAT MAKES IT POSSIBLE, and why no case here launches an agent. A claim is a handle
# held by the launching process, so a seat created with -NoLaunch is left UNCLAIMED -- the only state
# in which Retire-Seat's plan body is reachable at all, since it refuses a claimed seat by design and
# every seat in the live registry is claimed by the session that would be testing it.
#
# ITS FIRST RUN FOUND THREE LATENT FAULTS, every one on a path nothing had ever executed: an empty
# Desk file made Get-DeskMigrationPlan unable to preflight a seat AT ALL (the live 2nd-b-vault-dev
# seat was in exactly that state and could not be entered), Get-DeskBytes and Read-AtomicBytes each
# returned $null for an empty file, and Retire-Seat -Preflight -Json never returned because
# Get-Content's decorated lines dragged the PowerShell provider graph into ConvertTo-Json.
Invoke-Check 'seat.lifecycle' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-SeatLifecycle.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 8) -join ' | ') }
    [string]($out | Select-Object -Last 1)
}

# --- THE RECOVERY ROUTES (2026-09-10) ------------------------------------------------------------
#
# WHY IT IS A SUITE OF ITS OWN RATHER THAN MORE OF seat.lifecycle. Two of the four routes DESTROY:
# the quarantine purge deletes material and its ownership rows, and the seat-archive purge deletes a
# retirement record. A destructive case run in a shared fixture leaves every later case reading state
# it broke on purpose, so the red names an unrelated crash rather than the defect -- the shape this
# repository has already paid for. Each section here builds its own workspace.
#
# AND IT IS THE TABLE'S PROOF FOR TWO NEW HELPERS. `seats.contract-table-matches-code` requires every
# row to cite a check this runner registers, and Restore-NotebookQuarantine.ps1 and
# Remove-NotebookQuarantine.ps1 both cite this one.
Invoke-Check 'recovery.routes' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-RecoveryRoutes.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 8) -join ' | ') }
    [string]($out | Select-Object -Last 1)
}

# THE CROSS-SEAT SWEEP, END TO END (ADR-0023). It is the first operation here that moves material
# belonging to a seat other than the one running it, so what it must get right is almost entirely
# CLASSIFICATION -- idle against busy, registered against retired, owned against shared -- and a
# classification is exactly what a suite can stop covering with nothing going red. Its own file
# rather than a section of recovery.routes: the mutation harness that falsifies these guards needs a
# red that names the sweep rather than an unrelated crash in a neighbouring case.
Invoke-Check 'notebook.idle-seat-sweep' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-NotebookSweep.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 8) -join ' | ') }
    [string]($out | Select-Object -Last 1)
}

Invoke-Check 'desk.book-root-selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'BookRootSchema.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 6) -join ' | ') }
    'passed'
}

# The triage inventory's suite. Its canaries are about the REFERENCE scan rather than about
# copy_status, which was already evidence-based and hash-bound: the fail-closed one asserts that with
# no tracked-path set every reference reads `unknown` and never `untracked`, because answering
# `untracked` when git could not be consulted makes a page look MORE at risk than it is -- the same
# misreading this scan exists to prevent, pointed the other way. Prose carrying a slash, like 24/7,
# must never become a reference.
#
# Since 2026-08-28 it also pins the invariant the previous helper got wrong: NEITHER source has to
# exist. Reset-LocalNotebook calls this helper to build the advisory a reader reads at the reset
# approval, and a Reset DELETES notebook/ -- so the state a second reset meets was the state that
# made the advisory read `unavailable`.
Invoke-Check 'triage-inventory.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Get-LibraryTriageInventory.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 6) -join ' | ') }
    'passed'
}

# --- The handoff records fork A left behind --------------------------------------------------------
#
# READ BOTH, WRITE ONE. internal/handoff-plans/ and internal/handoff-journals/ hold real records of
# real batches that really ran. The 2026-08-28 merge renamed the verb and moved new records to
# triage-named paths; it must not have made the old ones unreadable, and it must never rewrite one.
#
# A record is evidence of a write that actually happened, so this check is deliberately harsher than
# "it parses": it also asserts that running the gate does not TOUCH them. internal/ is gitignored, so
# `git status` says nothing here and a rewritten journal would leave no trace anywhere else.
Invoke-Check 'triage.history-readable' {
    $roots = @('internal/handoff-plans', 'internal/handoff-journals') |
        ForEach-Object { Join-Path $workspace $_ } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Container }
    if (-not @($roots).Count) { return 'no legacy handoff records on disk' }

    $files = @($roots | ForEach-Object { Get-ChildItem -LiteralPath $_ -File -Filter '*.json' } | Sort-Object FullName)
    $unreadable = [Collections.Generic.List[string]]::new()
    $before = @{}
    foreach ($file in $files) {
        $before[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        try { $null = ([IO.File]::ReadAllText($file.FullName, [Text.UTF8Encoding]::new($false, $true))) | ConvertFrom-Json }
        catch { [void]$unreadable.Add("$($file.Name): $($_.Exception.Message)") }
    }
    if ($unreadable.Count) { throw "legacy handoff records no longer parse: $($unreadable -join '; ')" }

    # The runner must still ACCEPT a legacy path and refuse it for the honest reason -- schema, not
    # "no such directory". Driven against a real file so the path guard is exercised, and against a
    # disposable copy so the real record is never the thing a refusal might touch.
    $planFiles = @($files | Where-Object { $_.FullName -match 'handoff-plans' })
    $verdict = 'no legacy plan to probe'
    if ($planFiles.Count) {
        $probe = Join-Path $workspace "internal/handoff-plans/$([guid]::NewGuid().ToString('n')).probe.json"
        [IO.File]::Copy($planFiles[0].FullName, $probe, $false)
        try {
            $message = ''
            try { & (Join-Path $PSScriptRoot 'Invoke-LibraryTriage.ps1') -PlanPath $probe -WorkspacePath $workspace -Preflight | Out-Null }
            catch { $message = $_.Exception.Message }
            if ($message -notmatch 'schema 2') {
                throw "a legacy handoff plan was not refused as a schema 2 record; it said: $message"
            }
            if ($message -match 'must be inside') { throw 'the runner no longer accepts internal/handoff-plans/ as a plan path' }
            $verdict = 'legacy plan readable and refused as schema 2'
        }
        finally { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
    }

    $changed = @($files | Where-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -cne $before[$_.FullName] })
    if ($changed.Count) { throw "these legacy records were REWRITTEN by this check: $(@($changed | ForEach-Object { $_.Name }) -join ', ')" }
    $missing = @($files | Where-Object { -not (Test-Path -LiteralPath $_.FullName -PathType Leaf) })
    if ($missing.Count) { throw "these legacy records were removed: $(@($missing | ForEach-Object { $_.Name }) -join ', ')" }

    "$($files.Count) legacy record(s) parse and are unchanged; $verdict"
}

# Get-MeterStatus.ps1 has carried a -SelfTest since 2026-08-18 and NOTHING RAN IT. Found while adding
# the check above. A suite the gate never invokes is the Phase 2 lesson in its purest form -- there, a
# check sat inside the -Fast else branch so it ran in the full gate and never in the pre-commit hook;
# here it ran nowhere at all, and any drift in the meter parser would have been invisible.
Invoke-Check 'meter-status.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Get-MeterStatus.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 6) -join ' | ') }
    'passed'
}

# The Codex meter is parsed in TWO INDEPENDENT PLACES BY DECISION: Get-MeterStatus.ps1 above, which
# is step 0 of the delegation preflight, and ~/.claude/statusline.sh, which is what the reader
# actually looks at before deciding whether to delegate. The library-dev Hub recorded on 2026-08-18
# that nothing checked the two keep agreeing. On 2026-09-05 they did not, and had not for as long as
# both existed: the status line matched the substring '"primary":{"used_percent"' anywhere in a
# rollout and took the LAST hit, so a session that merely QUOTED a rate-limits blob -- pasting a spec
# into Codex is enough -- was rendered to the reader as a live meter. Its own comment called that
# matching "structural" because it was narrower than a bare "rate_limits" search; narrower is not
# structural. Get-MeterStatus.ps1 had guarded that exact decoy since 2026-08-18 and says so in its
# self-test; the two were simply never compared. The status line now runs a jq filter mirroring
# Get-RateLimitsFromRecord step for step, and this check is what keeps them mirrored.
#
# It runs BOTH REAL PARSERS over one fixture rather than reimplementing either -- reimplementing the
# thing under test is how the substring matcher passed its own author's reading for a year. It pins
# the EXPECTED VALUE as well as their agreement, because two parsers drifting the same way would
# agree and still be wrong. Three properties of the fixture are load-bearing:
#
#   - the decoy sits AFTER the last genuine reading, so the substring parser this replaced fails
#     here (it answers 99) rather than passing by accident;
#   - the deciding record carries BOTH rate_limits shapes, so preferring payload.rate_limits over
#     payload.info.rate_limits fails here too (it answers 44);
#   - a truncated final line proves both tolerate a rollout being written as it is read.
Invoke-Check 'meter.parsers-agree' {
    $statusLine = Join-Path $env:USERPROFILE '.claude\statusline.sh'
    if (-not (Test-Path -LiteralPath $statusLine -PathType Leaf)) {
        return "skipped: no status line at $statusLine, so this machine has no second parser to disagree"
    }
    # Git Bash specifically, derived from git.exe rather than taken from PATH: a bare `bash.exe`
    # resolves to the WindowsApps WSL shim, which cannot open a C:\ path at all and would fail this
    # check for a reason that has nothing to do with the meter.
    $gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($null -eq $gitCommand) { return 'skipped: git.exe is not on PATH, so Git Bash cannot be located' }
    $bashExe = Join-Path (Split-Path -Parent (Split-Path -Parent $gitCommand.Source)) 'bin\bash.exe'
    if (-not (Test-Path -LiteralPath $bashExe -PathType Leaf)) { return "skipped: no Git Bash at $bashExe" }

    $fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("meter-agree-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    # Three levels below the sessions root, because the status line globs */*/*/rollout-*.jsonl
    # where Get-MeterStatus.ps1 recurses. Real Codex rollouts are laid out year/month/day, so the
    # fixture matches the layout rather than the looser of the two readers.
    $sessionsRoot = Join-Path $fixtureRoot 'sessions'
    $sessionDay = Join-Path $sessionsRoot '2026\08\18'
    New-Item -ItemType Directory -Path $sessionDay -Force | Out-Null
    try {
        $expected = 82.0
        $body = @(
            '{"timestamp":"2026-08-12T01:50:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100},"rate_limits":{"limit_id":"codex","primary":{"used_percent":10.0,"window_minutes":60,"resets_at":1787240000},"secondary":null,"credits":{"has_credits":false},"plan_type":"plus"}}}}',
            '{"timestamp":"2026-08-12T01:51:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"sibling","primary":{"used_percent":33.0,"window_minutes":300,"resets_at":1787241000},"secondary":null,"plan_type":"plus"}}}',
            '{"timestamp":"2026-08-12T01:51:46.299Z","type":"event_msg","payload":{"type":"token_count","info":{"rate_limits":{"limit_id":"codex","primary":{"used_percent":82.0,"window_minutes":10080,"resets_at":1787245625},"secondary":null,"credits":{"has_credits":false},"plan_type":"plus"}},"rate_limits":{"limit_id":"outranked","primary":{"used_percent":44.0}}}}',
            '{"type":"event_msg","payload":{"type":"message","text":"the build spec quoted rate_limits JSON"},"rate_limits":{"limit_id":"decoy","primary":{"used_percent":99.0}}}',
            '{"type":"event_msg","payload":"a quoted payload"}',
            '{"timestamp":"2026-08-12T01:52:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"rate_limits":'
        ) -join "`r`n"
        [IO.File]::WriteAllText((Join-Path $sessionDay 'rollout-agree.jsonl'), $body, [Text.UTF8Encoding]::new($false))

        $meterRaw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Get-MeterStatus.ps1') -SessionsRoot $sessionsRoot -Json
        if ($LASTEXITCODE -ne 0) { throw "Get-MeterStatus.ps1 failed over the fixture: $((@($meterRaw) | Select-Object -Last 3) -join ' | ')" }
        $reading = (@($meterRaw) -join '') | ConvertFrom-Json
        if ($null -eq $reading.primary) { throw "Get-MeterStatus.ps1 found no reading in the fixture at all (status $($reading.status))" }
        $fromPowerShell = [double]$reading.primary.used_percent

        # The status line is pointed at the fixture through the two overrides it reads for exactly
        # this purpose, so the reader's own meter cache is never touched.
        $cachePath = Join-Path $fixtureRoot 'meter-cache'
        $env:CODEX_SESSIONS_ROOT = $sessionsRoot -replace '\\', '/'
        $env:CODEX_METER_CACHE = $cachePath -replace '\\', '/'
        try {
            $stdinJson = '{"model":{"display_name":"gate"},"context_window":{"used_percentage":1.0,"context_window_size":1000,"current_usage":{"input_tokens":10}}}'
            $rendered = (@($stdinJson | & $bashExe ($statusLine -replace '\\', '/') 2>$null) -join '')
        }
        finally { Remove-Item Env:CODEX_SESSIONS_ROOT, Env:CODEX_METER_CACHE -ErrorAction SilentlyContinue }

        # The cache holds the unrounded figure the parser actually produced; the rendered line holds
        # it rounded. Compare on the cache so a real divergence under half a percent cannot hide.
        if (-not (Test-Path -LiteralPath $cachePath -PathType Leaf)) {
            throw 'the status line found no reading in the fixture at all -- its rollout glob or its jq filter has changed'
        }
        $cacheFields = @(([IO.File]::ReadAllText($cachePath)).Trim() -split '\s+' | Where-Object { $_ -cne '' })
        if (-not $cacheFields.Count) { throw 'the status line wrote an empty meter cache over the fixture' }
        $fromStatusLine = [double]$cacheFields[0]

        if ($fromPowerShell -ne $expected) {
            throw "Get-MeterStatus.ps1 read $fromPowerShell where the fixture's last genuine reading is $expected"
        }
        if ($fromStatusLine -ne $expected) {
            throw "the status line read $fromStatusLine where the fixture's last genuine reading is $expected -- 99 means it matched the quoted decoy, 44 means it preferred payload.rate_limits over payload.info.rate_limits"
        }
        $renderedPattern = 'codex\s+' + [Math]::Round($expected) + '%'
        if ($rendered -cnotmatch $renderedPattern) {
            throw "both parsers read $expected but it does not reach the rendered line: $rendered"
        }
        "both parsers read $expected from one fixture, and it reaches the rendered line"
    }
    finally { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

# Phase 1's baseline is useful only if its two non-additive accounting formulas, cumulative epochs,
# deduplication, lineage, malformed-tail handling, and replay containment all stay under the gate.
Invoke-Check 'token-baseline.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Get-TokenBaseline.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 8) -join ' | ') }
    'passed'
}

# The deployment resolver, which is the whole of step 11's behavioural half: with nothing passed,
# nothing in the environment and no generated state, every helper must refuse and name the three
# routes to a configured value. The suite pins the refusals, the precedence order, and BOTH
# directions of the endpoint validator -- the malformed forms it must reject and the ordinary ones
# it must not, because a validator that matched nothing would pass every negative case on its own.
Invoke-Check 'library-deployment.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'LibraryDeployment.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# The fixture half of BOTH public checks, and the half that stops either going vacuous. It builds a
# throwaway git repository -- a real one, because one scan derives its file set from `git ls-files`
# and the other from `git diff --cached` against a real base commit -- carrying a planted default
# per detector, a planted identity per boundary, the documentation placeholders and approved
# attribution that must NOT be flagged, and the categories that are out of scope. Then it empties
# each detector's match set and asserts every positive disappears, which is the only thing that
# proves the positives were the detectors matching rather than the fixture agreeing with itself.
#
# Two of its cases exist only to catch a wrong implementation that agrees with the right one
# everywhere else: a file whose staged blob and working-tree copy say opposite things, which is red
# unless the identity scan reads the index; and a term that is on the denylist AND the allowlist,
# which is red unless an approved name has to CONTAIN a hit to excuse it rather than merely touch it.
# The vault exporter's acceptance suite: PLAN-public-release.md step 15's five named cases and the
# guards they sit on. Spawned rather than dot-sourced because the exporter takes a real collection-
# wide lock, renames real directories and writes real journals against a temp workspace, and a
# suite sharing this runspace would leave that lock ledger behind in the checks runner's own scope.
#
# It falsifies itself five ways -- each of the five cases goes red on a named assertion when its
# guard is removed, verified by injection rather than by reasoning -- and it reports collected
# failures even when a later case throws on the damage an earlier defect left, because an abort
# that skips the report is how a real regression came back looking like one unrelated crash.
Invoke-Check 'collection-vault-export.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Export-CollectionToVault.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 8) -join ' | ') }
    (@($out) | Select-Object -Last 1)
}

# PLAN-public-release.md step 14. Spawned rather than dot-sourced for the same reason the two above
# are: it builds throwaway git repositories and sets GIT_AUTHOR_EMAIL, and neither belongs in the
# gate's own process.
Invoke-Check 'public-tree-export.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Export-PublicTree.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 8) -join ' | ') }
    (@($out) | Select-Object -Last 1)
}

Invoke-Check 'deployment-scan.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'DeploymentScan.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# --- One allowlist rule, two implementations, never compared until now ---------------------------
#
# PLAN-public-release.md step 12's server half. `tools/DeploymentScan.ps1` implements whole-span
# containment at an exact position; `docs/mirror-publishing-job.md` approximates the same rule by
# deleting every allowlisted string and grepping what is left. Both claim to be the rule "a denied
# term is excused only when an allowlisted string covers the WHOLE match", and S7 shipped the second
# one untested because no Actions runner exists to run it against.
#
# NOT IN -Fast, DELIBERATELY. The document's scanner is not executed at commit time -- it runs on a
# server, on a snapshot -- so this is a design-parity check rather than a leak gate, and the 23-second
# pre-commit budget is reserved for the checks that stand between a paste and a public repository.
# Its sibling public.no-deployment-defaults sits above the -Fast branch for exactly the opposite
# reason, and the contrast is the point.
# --- The Claude plugin files are generated, and a drift is a gate failure ------------------------
#
# PLAN-public-release.md step 19. The Codex layout under `plugin/` is canonical; Claude's
# `.claude-plugin/plugin.json`, its `.mcp.json` and its hooks file are generated from it, and the one
# mechanical difference between the harnesses -- `${PLUGIN_ROOT}` against `${CLAUDE_PLUGIN_ROOT}` --
# lives in the generator rather than in two hand-maintained files that drift apart quietly.
#
# IT COMPARES PARSED STRUCTURE, NOT RENDERED TEXT. A PowerShell release that indents differently
# would otherwise report drift for an upgrade nobody performed, and a check that cries wolf on its
# own toolchain is one people start regenerating past without reading.
Invoke-Check 'plugin.generated-files-match' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'PluginPackage.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw ((@($out) | Select-Object -Last 8) -join ' | ') }
    (@($out) | Select-Object -Last 1)
}

Invoke-Check 'mirror-job.allowlist-rule-parity' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-AllowlistRuleParity.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw ((@($out) | Select-Object -Last 8) -join ' | ') }
    (@($out) | Select-Object -Last 1)
}

Invoke-Check 'library-output.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'LibraryOutput.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

Invoke-Check 'edit-project-hub.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Edit-ProjectHub.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

Invoke-Check 'new-project-hub.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'New-ProjectHub.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# The three shared-collection editors. Two of them are the most destructive helpers in this
# repository -- Remove-SharedEntry permanently deletes a Book or Hub, Remove-MemoryProject
# deregisters and deletes an entire Basic Memory project -- and all three shipped carrying a
# -SelfTest that nothing ran. A self-test no gate drives is a self-test that passes until the day it
# matters, which is exactly the wrong day for the delete path.
# Written out one per check rather than generated in a loop. A `foreach` with
# `.GetNewClosure()` was tried first and was WRONG in a way a green run hid: GetNewClosure snapshots
# the enclosing scope, so `$LASTEXITCODE` inside the closure is a captured copy that the closure's
# own `& powershell.exe` never updates. The first broken script then poisoned the NEXT check, which
# reported FAIL while printing its own success output -- two failures from one defect, and the second
# one unfalsifiable from its own message. Three explicit blocks, like every other suite in this file.
Invoke-Check 'add-catalog-entry.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Add-CatalogEntry.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

Invoke-Check 'remove-shared-entry.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Remove-SharedEntry.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

Invoke-Check 'remove-memory-project.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Remove-MemoryProject.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# The fourth shared-collection editor, and the newest. Its suite is offline by construction: the
# emptiness-sentence repair decision is a pure function of the catalog text, so every branch --
# the live page's spelling, the bare spelling, a duplicate, a clean catalog, an empty one -- is
# provable without the NAS. It also asserts the safety boundary the design named rather than
# arguing it in a comment: the repaired text keeps every entry, keeps the opening sentence, and
# clears the shared.archive-catalog-consistency patterns that this file owns.
Invoke-Check 'archive-shared-book.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Archive-SharedBook.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

# The filesystem half of archiving, which no MCP verb can reach. Its suite is offline against a
# fixture shaped like the collection, deliberately: a self-test that needed the share would be
# skipped on exactly the machines where a wrong answer costs something. The assertions that matter
# are the refusals -- a directory holding a file, or holding only a HIDDEN file, is never removed --
# and the one that an explicitly given root which fails validation throws instead of quietly
# resolving to the real NAS collection.
Invoke-Check 'shared-collection-files.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'SharedCollectionFiles.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

Invoke-Check 'hub-migration-acceptance.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-HubMigrationAcceptance.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 8) -join ' | ') }
    'passed'
}

# The producer for the verifier above. Its own suite is the round trip: it captures a snapshot from a
# fixture Hub, simulates the three writes with Edit-ProjectHub's own composition, then runs the real
# verifier's assertions against the page that simulation produced. So this check fails if the writer,
# the verifier, or the producer drifts from either of the other two -- which is the whole reason the
# producer imports their functions instead of copying them.
Invoke-Check 'hub-migration-snapshot.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'New-HubMigrationSnapshot.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 8) -join ' | ') }
    'passed'
}

# 2.2 rung 4's gate check. A writer that mutates a Shelf Book without routing through the manifest
# transaction desynchronises manifest and Book silently, and no Claude-side hook runs in a delegate
# process -- so the writers are where the invariant lives and this is where it is proved.
# --- The currency check's Shelf path (2026-09-08) ------------------------------------------------
#
# `-Book <slug>` has two article sources and only one of them was covered. The pin comparison was
# proved live against the shared collection in both directions -- `current` at the tip and
# `refresh due` from a moved tip, whose tree diff agreed with `git diff --name-status` over the
# same range -- but the SHELF branch was verified once by hand against the `holding` Book and had
# no fixture at all. A fixture exercising the pin comparison would have proved the shared branch
# again; the pin comparison is not where the branches differ.
#
# The Shelf branch is the only place this tier consults the Virtual Desk, and that guard has
# already failed in the direction nothing notices: it looked for `internal/virtual-desk.json`, a
# file this workspace does not have, so an OPEN Shelf Book was refused as closed and the whole
# branch was unreachable. Both directions are asserted, per seat.
#
# OFFLINE WITHOUT SHADOWING A TRANSPORT: no git runs, because every fixture article resolves
# before the network boundary and the deepest case stops at `refused source` -- a well-formed pin
# on a host the allowlist does not carry, which is what proves Shelf-read TEXT reached the pin
# mapping. Falsified 2026-09-08 by reintroducing six faults one at a time (the gate deleted, the
# gate comparing a slug instead of a Book root, each exclusion dropped, the Notebook branch
# testing its directory instead of its articles, and the two branches swapped); each was caught,
# and each wrong answer was a WRONG VERDICT rather than a missing file, because every Book that
# must be refused carries a decoy article and the two excluded front-matter pages carry a
# malformed anchor -- which outranks every other verdict in the roll-up.
Invoke-Check 'book-currency.shelf-path' {
    # -Last 14, not 8: twelve cases plus the count line outruns a shorter tail, and the tail is
    # where the FAILED summary and the individual failures are. A window that clips them reports a
    # red run as a wall of passes.
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-BookCurrencyShelfPath.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 14) -join ' | ') }
    'passed'
}

Invoke-Check 'shelf.writers-route-manifests' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-ShelfWriterRouting.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 6) -join ' | ') }
    'passed'
}

# 2.2 rung 5's gate check. Rung 4 routes writers through the mutation window; nothing has
# backfilled the Books nothing has touched, and "dirty until rebuilt" named a repair that did not
# exist. This suite proves the backfill, the -Rebuild that detects an out-of-band edit, the
# journal resume, the prune, and the closed-Book approval -- all against a disposable fixture
# Shelf, never the reader's own.
Invoke-Check 'shelf.manifest-backfill' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-ManifestBackfill.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 6) -join ' | ') }
    'passed'
}

# ADR-0012's gate check, and the reason it is a SUITE rather than a static scan: archiving used to
# retire a Book's Discovery manifest, and every part involved -- the archiver, the store, the schema,
# Discovery -- was individually correct. Only running an archive and then asking Discovery a question
# shows the Book gone. It also holds the coverage COUNT, which is the half that made the old answer
# read complete while excluding what it had just dropped.
Invoke-Check 'archive.search-coverage' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-ArchiveSearchCoverage.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 8) -join ' | ') }
    'passed'
}

# 2.2 rung 7's gate check. The shared half of the backfill reads closed Book bodies over MCP, so its
# suite runs against a fault-injectable loopback stub rather than the NAS: a suite that needs the
# network stops proving anything the moment the network is down, and a faithful-only stub can prove
# nothing about a substituted read or a truncated listing, which are the failures the helper's
# fail-closed rules exist for.
Invoke-Check 'shared.manifest-backfill' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-SharedManifestBackfill.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 6) -join ' | ') }
    'passed'
}

Invoke-Check 'shelf-note.boundary-suite' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-ShelfNoteBoundary.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    'passed'
}

}

if ($IncludeShared) {
    # --- The archive catalog must not contradict itself -------------------------------------------
    # archive/README.md opens with a pilot-era sentence saying nothing is archived, and it has listed
    # real archived Books since 2026-08-28. No helper authored that sentence: Archive-SharedBook.ps1
    # writes correct prose when it CREATES the index, and only ever appends entries afterwards. It is
    # unowned text, so this check is the durable detector for the contradiction and that helper's
    # find_replace repair is the only thing that clears it.
    #
    # WARN, NOT FAIL, BY DESIGN. It flags the live page today, and the repair heals the page on the
    # NEXT archive rather than now -- the Desk guard rightly refuses a direct edit_note outside an
    # open active Hub, and working around it to hand-correct one sentence is not a trade this Library
    # makes. A FAIL would block every commit until an unrelated archive happened to run.
    #
    # THE DETECTOR IS BROAD WHERE THE REPAIR IS NARROW, DELIBERATELY. The patterns below match any
    # claim of emptiness; Archive-SharedBook.ps1 replaces one verbatim sentence and nothing else,
    # because a detector that misses a variant only stays quiet while a writer that matches loosely
    # edits prose it does not own. The two lists are therefore NOT shared code. If they drift, the
    # symptom is a warning that an archive run fails to clear -- visible, not silent.
    #
    # This reads archive/README.md, a collection index rather than a Book page, so SharedBookSource's
    # "the caller owes the preflight and the reader's approval" rule -- which governs closed-Book
    # BODIES -- does not apply. Dot-sourced inside the check body so its functions stay out of the
    # gate's own scope.
    Invoke-Check 'shared.archive-catalog-consistency' {
        # SharedBookSource.ps1 uses HttpClient but does not load it -- Update-SharedBookManifests.ps1,
        # its only other caller, does the Add-Type itself. Same contract honoured here.
        Add-Type -AssemblyName System.Net.Http
        . (Join-Path $PSScriptRoot 'SharedBookSource.ps1')
        $session = New-SharedBookSession
        $response = Invoke-SharedMcp $session 'tools/call' @{ name = 'read_note'; arguments = @{ project_id = $session.project_id; identifier = 'archive/README'; output_format = 'json'; include_frontmatter = $false } }
        $rpcError = Get-SharedRpcError $response
        if ($null -ne $rpcError) { throw "reading archive/README.md failed: $($rpcError.message)" }
        if ($response.result.isError) {
            # An absent catalog is a real pass, not a hidden one: nothing is archived and nothing
            # claims otherwise. Every OTHER rejection is a failure, because a read that did not
            # happen is not evidence the page is consistent.
            $detail = [string]($response.result.content | ConvertTo-Json -Compress -Depth 8)
            if ($detail -match '(?i)not found|does not exist|no note') { return 'no archive catalog on the NAS yet' }
            throw "reading archive/README.md was rejected: $detail"
        }
        $record = $response.result.structuredContent.result
        if ($null -eq $record -or [string]::IsNullOrWhiteSpace([string]$record.file_path)) { throw 'the archive catalog read returned no record.' }
        if ([string]$record.file_path -cne 'archive/README.md') { throw "the archive catalog read returned '$([string]$record.file_path)'; its content was withheld." }
        $text = [string]$record.content
        if ([string]::IsNullOrWhiteSpace($text)) { throw 'the archive catalog has no readable content.' }

        $lines = @($text -split "`r?`n")
        # An entry is a list item linking into either archive half. Anchored at the line start so a
        # sentence that merely mentions a link cannot be counted as an entry.
        $entries = @($lines | Where-Object { $_ -match '^\s*[-*]\s*\[\[archive/' })
        $claimPatterns = @(
            'has no archived\b',
            '\bno archived (?:content|books?|projects?|material)\b',
            '\bnothing (?:is |has been )?archived\b',
            '\barchive is (?:currently )?empty\b',
            '\bhas not archived\b'
        )
        # Entry lines are excluded from the claim scan: an archived Book whose TITLE contains one of
        # these phrases would otherwise report its own catalog as broken.
        $prose = @($lines | Where-Object { $_ -notmatch '^\s*[-*]\s*\[\[archive/' })
        $claims = @($prose | Where-Object { $line = $_; @($claimPatterns | Where-Object { $line -match "(?i)$_" }).Count -gt 0 })

        if (-not $entries.Count) { return "no entries listed; $($claims.Count) emptiness claim(s) present and correct" }
        if (-not $claims.Count) { return "$($entries.Count) entr(ies) listed and no emptiness claim" }
        $quoted = $claims[0].Trim()
        if ($quoted.Length -gt 160) { $quoted = $quoted.Substring(0, 160) + '...' }
        "WARN: the archive catalog lists $($entries.Count) entr(ies) and still claims emptiness in $($claims.Count) line(s): `"$quoted`" -- Archive-SharedBook.ps1 repairs this on the next archive"
    }

    # --- Archiving must leave no emptied directory behind ------------------------------------------
    # THE ONLY CHECK THE LIBRARY OWNS THAT LOOKS AT THE COLLECTION'S FILESYSTEM, and it exists
    # because every index-backed surface is structurally blind here. Basic Memory indexes NOTES:
    # after `move_note ... is_directory = $true` empties `books/<slug>/`, list_directory returns the
    # same {"nodes":[],"total":0} for that path as for a path that never existed. On 2026-08-29 the
    # reader found six such husks in Explorer while the Librarian, having checked five index-backed
    # surfaces, reported the collection clean. No amount of care with those surfaces would have
    # found it, which is why this one leaves them.
    #
    # WARN, NOT FAIL, and skipped when the share is unreachable. A husk holds no content, so it is
    # untidiness rather than damage, and failing every commit over a leftover directory on a NAS
    # that this machine may not even have mapped would be out of proportion. The archivers remove
    # theirs as they go; this catches what they could not reach and anything archived before the
    # cleanup existed.
    Invoke-Check 'shared.archive-leaves-no-husk' {
        . (Join-Path $PSScriptRoot 'SharedCollectionFiles.ps1')
        $root = Get-SharedCollectionRoot
        if ($null -eq $root) { return 'skipped: the shared collection filesystem is not reachable from this machine' }
        $husks = @(Find-SharedCollectionHusks -Root $root)
        if ($husks.Count -eq 0) { return "no emptied directories under books/, projects/ or archive/ ($root)" }
        $shown = @($husks | Select-Object -First 6)
        $suffix = if ($husks.Count -gt $shown.Count) { " (+$($husks.Count - $shown.Count) more)" } else { '' }
        "WARN: $($husks.Count) emptied director(ies) left behind under $root -- $($shown -join ', ')$suffix. Each holds no files; remove them in the collection's filesystem."
    }

    # --- Creating a seat, end to end, against a DISPOSABLE workspace -------------------------------
    #
    # WHY THIS IS IN THE SHARED TIER AND THE REST OF THE SEAT COVER IS NOT. Creating a seat validates
    # that its Project Hub exists and is ACTIVE, and the only authority for that is the Active Project
    # Catalog in the shared collection. So one read reaches the NAS -- and nothing else here does:
    # the registry, the Desk and the binding all go to a temporary workspace, and the confirmed run
    # reports shared_library_write as false because it makes none.
    #
    # `seat.lifecycle` holds every refusal that happens before that read or after one that failed --
    # no confirmation, no plan_id, an unreadable catalog. What can only be proved with the catalog in
    # hand is the transaction itself, and that is this: a preflight that offers the real active
    # Projects, a plan_id bound to both slugs and the registry, a stale approval refused, and the
    # confirmed run leaving a registered seat whose Desk holds its own Hub and whose binding is
    # committed to a live agent.
    #
    # THE AGENT IS A REAL PROCESS, for the reason every other binding case spawns one: the rule is
    # "this PID, started at this moment, is still running", and a fabricated number tests neither half.
    Invoke-Check 'seat.create-acceptance' {
        . (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
        $fixture = Join-Path ([IO.Path]::GetTempPath()) ('seat-create-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        $fixtureState = Join-Path $fixture '.claude'
        $callerSeat = $env:LIBRARY_SEAT
        $agent = $null
        $problems = [Collections.Generic.List[string]]::new()
        try {
            New-Item -ItemType Directory -Path $fixtureState -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook') -Force | Out-Null
            Initialize-SeatForFixture -StateDirectory $fixtureState -Seat 'incumbent' -Project 'incumbent-proj' | Out-Null
            $env:LIBRARY_SEAT = ''
            $agent = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden `
                -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240')
            $enter = Join-Path $PSScriptRoot 'Enter-LibrarySeat.ps1'
            $run = {
                param([string[]]$Arguments)
                $old = $ErrorActionPreference
                $ErrorActionPreference = 'Continue'
                $lines = @()
                try { $lines = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $enter -WorkspacePath $fixture @Arguments 2>&1) }
                finally { $ErrorActionPreference = $old }
                $code = $LASTEXITCODE
                $out = @($lines | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
                [pscustomobject]@{
                    ExitCode = $code
                    Json     = @($out | Where-Object { $_.Trim().StartsWith('{') })
                    Text     = (((@($lines) | ForEach-Object { [string]$_ }) -join ' ') -replace '\s+', ' ')
                }
            }
            # ONE ACTIVE PROJECT IS ENOUGH FOR EVERY CASE BELOW, and that is deliberate: keying the
            # cases to $active[1] and $active[2] would make this check's coverage depend on how many
            # Hubs happen to be active. So each case that KEEPS a seat is cleaned up before the next
            # one needs the project back.
            $plan = { param([string]$SeatName, [string]$ProjectSlug)
                $preflight = & $run @('-Seat', $SeatName, '-Project', $ProjectSlug, '-AgentProcessId', ([string]$agent.Id), '-Create', '-Preflight', '-Json')
                if ($preflight.ExitCode -ne 0) { throw "the create preflight refused seat '$SeatName': $($preflight.Text)" }
                [string](($preflight.Json[-1] | ConvertFrom-Json).plan_id)
            }

            # 1. THE OFFER. With no -Project the preflight lists the real active Hubs rather than
            #    refusing, and issues no plan_id: nothing has been decided yet.
            $offer = & $run @('-Seat', 'candidate', '-AgentProcessId', ([string]$agent.Id), '-Create', '-Preflight', '-Json')
            if ($offer.ExitCode -ne 0) { throw "the create preflight could not read the Active Project Catalog: $($offer.Text)" }
            $offered = ($offer.Json[-1] | ConvertFrom-Json)
            if ($null -ne $offered.plan_id) { [void]$problems.Add('the preflight issued a plan_id with no Project named') }
            $active = @($offered.active_projects)
            if ($active.Count -lt 1) { throw 'the Active Project Catalog listed no Projects, so nothing below is exercised.' }
            if (@($active) -cnotcontains 'library-dev') { [void]$problems.Add("the active Project list does not include this workspace's own Hub: $($active -join ', ')") }
            $project = [string]$active[0]

            # 2. A STALE APPROVAL IS REFUSED, and refused before anything is written.
            $stale = & $run @('-Seat', 'candidate', '-Project', $project, '-AgentProcessId', ([string]$agent.Id),
                '-Create', '-UserConfirmed', '-ApprovedPlanId', ('0' * 16), '-Json')
            # THROWN RATHER THAN ACCUMULATED. A stale approval that succeeded has already created the
            # seat, so every assertion after it reports on a world the check did not intend -- the
            # first falsification run of this check named "the confirmed creation failed: seat already
            # exists", which is a consequence three steps downstream of the fault.
            if ($stale.ExitCode -eq 0) { throw 'a seat was created against a plan_id the preflight never issued.' }
            if (Test-Path -LiteralPath (Join-Path (Get-SeatsDirectory $fixtureState) 'candidate')) {
                [void]$problems.Add('a refused creation left the seat directory behind')
            }
            if ($null -ne (Get-SeatEntry -Registry (Read-SeatRegistry -StateDirectory $fixtureState) -Seat 'candidate')) {
                [void]$problems.Add('a refused creation left a registry entry behind')
            }

            # 3. A FAILURE AFTER THE SEAT DIRECTORY EXISTS, which case 2 cannot reach: that one is
            #    refused by the digest comparison, before anything is written. A deadline too short
            #    for a PowerShell process to start is a real injection rather than a test backdoor --
            #    the handshake times out, the handle is free because the holder never started, and the
            #    abort must take the whole seat back with it.
            $aborted = & $run @('-Seat', 'halfbuilt', '-Project', $project, '-AgentProcessId', ([string]$agent.Id),
                '-Create', '-UserConfirmed', '-ApprovedPlanId', (& $plan 'halfbuilt' $project), '-DeadlineSeconds', '0.05', '-Json')
            if ($aborted.ExitCode -eq 0) { [void]$problems.Add('a creation whose claim holder never readied reported success') }
            # THROWN, NOT ACCUMULATED, for case 2's reason: a rollback that did not happen holds the
            # Project, so the very next preflight refuses with a clash and the check reports that
            # instead of the fault two steps above it.
            if (Test-Path -LiteralPath (Join-Path (Get-SeatsDirectory $fixtureState) 'halfbuilt')) {
                throw 'an aborted creation left its seat directory behind.'
            }
            if ($null -ne (Get-SeatEntry -Registry (Read-SeatRegistry -StateDirectory $fixtureState) -Seat 'halfbuilt')) {
                throw 'an aborted creation left its registry entry behind.'
            }

            # 4. AND AN ABORT THAT CANNOT FREE THE HANDLE LEAVES THE SEAT WHOLE, never half-removed.
            #    The directory is pre-created with a claim file this process holds open, so the
            #    spawned holder is refused and the abort's wait for a free handle cannot succeed.
            #    Removing the directory then deletes the Desk files and FAILS on the claim file,
            #    leaving a seat with no route back; leaving it registered is a seat the reader can
            #    enter or retire. That is not hypothetical -- it is what this check found on the day
            #    it was written, because the abort read "no attempt object" as "nothing to release".
            $wedgedSeat = 'wedged'
            $wedgedDesk = Join-Path (Get-SeatsDirectory $fixtureState) $wedgedSeat
            New-Item -ItemType Directory -Path $wedgedDesk -Force | Out-Null
            $wedgedHandle = [IO.File]::Open((Join-Path $wedgedDesk '.claim'), [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
            try {
                $wedged = & $run @('-Seat', $wedgedSeat, '-Project', $project, '-AgentProcessId', ([string]$agent.Id),
                    '-Create', '-UserConfirmed', '-ApprovedPlanId', (& $plan $wedgedSeat $project), '-DeadlineSeconds', '1', '-Json')
                if ($wedged.ExitCode -eq 0) { [void]$problems.Add('a creation whose seat was already claimed reported success') }
                if (-not $wedged.Text.Contains('LEFT IN PLACE')) {
                    [void]$problems.Add("the wedged abort did not say the seat was left in place: $($wedged.Text)")
                }
                foreach ($kind in @('books', 'projects')) {
                    if (-not (Test-Path -LiteralPath (Get-DeskFilePath -StateDirectory $fixtureState -Seat $wedgedSeat -Kind $kind) -PathType Leaf)) {
                        [void]$problems.Add("the wedged abort half-removed the seat: its .open-$kind is gone while its claim file is still held")
                    }
                }
                if ($null -eq (Get-SeatEntry -Registry (Read-SeatRegistry -StateDirectory $fixtureState) -Seat $wedgedSeat)) {
                    [void]$problems.Add('the wedged abort removed the registry entry for a seat it could not remove')
                }
            }
            finally { $wedgedHandle.Dispose() }
            # The wedged seat is deliberately KEPT by the helper, so this fixture gives the project
            # back before the last case needs it. Registry and directory, through the fixture rather
            # than through a helper: the seat under test is corrupt state this check planted.
            $afterWedged = Read-SeatRegistry -StateDirectory $fixtureState
            Write-SeatRegistry -StateDirectory $fixtureState -Registry ([pscustomobject]@{
                schema = 1; seats = @(@($afterWedged.seats) | Where-Object { [string]$_.seat -cne $wedgedSeat }) })
            Remove-Item -LiteralPath $wedgedDesk -Recurse -Force

            # 5. THE TRANSACTION. Registered, Desk holding its own Hub and nothing else, binding
            #    committed to the live agent, and a seat_id on the registry entry.
            $planId = & $plan 'candidate' $project
            if ($planId -cnotmatch '^[0-9a-f]{16}$') { [void]$problems.Add("the create preflight issued no usable plan_id: '$planId'") }
            $created = & $run @('-Seat', 'candidate', '-Project', $project, '-AgentProcessId', ([string]$agent.Id),
                '-SessionId', 'conv-create-acceptance', '-Create', '-UserConfirmed', '-ApprovedPlanId', $planId, '-Json')
            if ($created.ExitCode -ne 0) { throw "the confirmed creation failed: $($created.Text)" }
            $entry = Get-SeatEntry -Registry (Read-SeatRegistry -StateDirectory $fixtureState) -Seat 'candidate'
            if ($null -eq $entry) { [void]$problems.Add('the confirmed creation registered no seat') }
            elseif ([string]$entry.project -cne $project) { [void]$problems.Add("the new seat was bound to '$([string]$entry.project)', not '$project'") }
            elseif ([string]::IsNullOrWhiteSpace([string]$entry.seat_id)) { [void]$problems.Add('the new registry entry carries no seat_id') }
            $deskProjects = @(Get-DeskFileEntries -Path (Get-DeskFilePath -StateDirectory $fixtureState -Seat 'candidate' -Kind 'projects'))
            if (($deskProjects -join ',') -cne "projects/$project") {
                [void]$problems.Add("the new seat's Desk holds '$($deskProjects -join ',')' instead of exactly projects/$project")
            }
            $binding = Read-SeatBinding -StateDirectory $fixtureState -Seat 'candidate'
            if ($null -eq $binding -or [string]$binding.state -cne 'committed') { [void]$problems.Add('the new seat has no committed binding') }
            $state = [string](Get-SeatClaimState -StateDirectory $fixtureState -Seat 'candidate' -AgentProcessId $agent.Id).state
            if ($state -cne 'held') { [void]$problems.Add("the new seat reads '$state' rather than held; its claim holder did not take the handle") }

            # 6. AND THE INCUMBENT SEAT IS UNTOUCHED. A creation that quietly rewrote the registry
            #    would pass every assertion above.
            if ($null -eq (Get-SeatEntry -Registry (Read-SeatRegistry -StateDirectory $fixtureState) -Seat 'incumbent')) {
                [void]$problems.Add('creating a seat removed the seat that was already registered')
            }
        }
        finally {
            $env:LIBRARY_SEAT = $callerSeat
            if ($null -ne $agent) { Stop-Process -Id $agent.Id -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Milliseconds 600
            if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
        }
        if ($problems.Count) { throw ($problems -join '; ') }
        'the create preflight offered the live active Projects, a stale approval and two aborts were refused leaving nothing half-built, and the confirmed transaction registered a bound seat with its own Hub on its Desk'
    }
    Invoke-Check 'reader.shared-selftest' {
        $adapter = Join-Path $workspace '.claude/adapters/Validated-BookReader.ps1'
        $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $adapter -SelfTest 2>&1
        if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
        'passed'
    }
}
else {
    Add-Result 'shared.archive-catalog-consistency' 'skipped' 'needs the NAS; pass -IncludeShared'
    Add-Result 'shared.archive-leaves-no-husk' 'skipped' 'needs the NAS; pass -IncludeShared'
    Add-Result 'seat.create-acceptance' 'skipped' 'needs the NAS; pass -IncludeShared'
    Add-Result 'reader.shared-selftest' 'skipped' 'needs the NAS; pass -IncludeShared'
}

# --- Report ---------------------------------------------------------------------------------------
$failed = @($results | Where-Object { $_.status -eq 'fail' })
$summary = [pscustomobject]@{
    operation            = 'Library Checks'
    workspace            = $workspace
    total                = $results.Count
    passed               = @($results | Where-Object { $_.status -eq 'pass' }).Count
    warned               = @($results | Where-Object { $_.status -eq 'warn' }).Count
    failed               = $failed.Count
    skipped              = @($results | Where-Object { $_.status -eq 'skipped' }).Count
    checks               = $results.ToArray()
    shared_library_write = $false
}

if ($Json) {
    $summary | ConvertTo-Json -Depth 6 -Compress
}
else {
    foreach ($r in $results) {
        $mark = switch ($r.status) { 'pass' { '  OK  ' } 'fail' { ' FAIL ' } 'warn' { ' WARN ' } default { ' SKIP ' } }
        Write-Host ("[{0}] {1,-38} {2}" -f $mark, $r.check, $r.detail)
    }
    Write-Host ''
    Write-Host ("{0} passed, {1} warned, {2} failed, {3} skipped" -f $summary.passed, $summary.warned, $summary.failed, $summary.skipped)
}

if ($failed.Count) { exit 1 }
exit 0
