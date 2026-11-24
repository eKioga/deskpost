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
    # THE READER'S WORKSPACE: their Shelf, Notebook, output/ and internal records. Until step 22
    # this was the same directory as the program, so one parameter answered both questions and
    # every check closed over it. It no longer is. Measured on 2026-09-21, the day the split
    # happened: 35 checks read only the program, 2 read only the workspace, and
    # `shelf.catalog-renders-from-entries` reads BOTH -- it renders the workspace's Shelf through a
    # template that ships with the program, so no single value can satisfy it.
    #
    # Resolved explicitly, then from LIBRARY_WORKSPACE, then by walking up from the current
    # directory to a marker. When none of those answer, the workspace-reading checks SKIP rather
    # than fail: a contributor holding a clone of the program and no Library of their own is a
    # supported state, and a gate that failed for them would be reporting on the absence of a
    # Library rather than on their change.
    [string]$WorkspacePath,
    # THE PROGRAM: these checks, the tools they scan, docs/ and .claude/. Always the directory this
    # file lives in, and a parameter only so a fixture can point at a copy of the tree.
    [string]$ProgramPath,
    [switch]$IncludeShared,
    [switch]$Fast,
    # ONLY THE CHECKS THAT READ THE READER'S MATERIAL, which is what `library doctor` answers. Added
    # 2026-09-22 (S17) for `checks.reports-every-registered-check`, which compared this runner's
    # WHOLE report against the kernel and differed on 395 of 432 fields: of 128 checks, some fifty
    # scan THIS PROGRAM's PowerShell source ("130 sources scanned", the kernel's own self-test, the
    # staged diff) and sixty-three are whole test suites. None of those is a fact about a workspace,
    # all of them change with the program checkout rather than with the fixture, and a kernel that
    # reproduced "130 PowerShell sources scanned" would be lying about which program answered.
    #
    # THE LINE IS THE ONE THIS FILE ALREADY DRAWS. `Invoke-WorkspaceCheck` is how a check declares
    # that it reads a Shelf, a Notebook, output/, internal/ or the Desk, and it is what makes such a
    # check skip when no workspace is attached. This switch keeps exactly those and drops the rest
    # without running them -- AND the workspace checks registered inside the suite branch too, because
    # those are suites, PowerShell test harnesses that drive PowerShell helpers, and a doctor is not a
    # test runner. So a workspace-only report is the same with or without -Fast.
    [switch]$WorkspaceOnly,
    # ONE CHECK, BY NAME (PLAN-fast-gates.md Unit B step 1): `gate.ts --tier push` runs each suite as its own
    # child through this. A filter that adds no check: every other check is not run, every result path
    # (Invoke-Check, Invoke-WorkspaceCheck, the -Fast roster and the -IncludeShared stand-ins) keeps only this
    # name, and a run reports exactly one result for it. A name nothing registers is a FAIL, not an empty pass.
    # One name per invocation: a list would not survive `powershell.exe -File` and the console relaunch below.
    [string]$Only,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# THE GATE NEVER HANDS A CHILD A KEYBOARD (S44). Every suite is started with `&`, so it inherits this
# process's stdin, and its own children inherit it again. Run from an agent's tool -- every gate run until S44
# -- that stdin is redirected and empty, so a child reading it meets the end of input. Run by a person at a
# console, as the README says, it is the keyboard: the seat picker asked `Seat:` for ever, a hook reading its
# payload waited in silence, and the full gate on a fresh clone in Windows Sandbox never finished (S7). Nothing
# here reads input, so at a console the gate runs itself again with stdin redirected and closed, its output
# still on the console, and reports that run's exit code. The marker stops a second relaunch whatever the host.
if (-not [Console]::IsInputRedirected -and [string]$env:LIBRARY_CHECKS_STDIN_DETACHED -cne '1') {
    $relaunchArguments = [Collections.Generic.List[string]]::new()
    foreach ($argument in @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)) { [void]$relaunchArguments.Add($argument) }
    foreach ($name in @($PSBoundParameters.Keys)) {
        $value = $PSBoundParameters[$name]
        if ($value -is [Management.Automation.SwitchParameter]) { if ($value.IsPresent) { [void]$relaunchArguments.Add("-$name") } }
        else { [void]$relaunchArguments.Add("-$name"); [void]$relaunchArguments.Add([string]$value) }
    }
    $relaunch = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'powershell.exe'))
    $relaunch.Arguments = (@($relaunchArguments | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }) -join ' ')
    $relaunch.UseShellExecute = $false
    $relaunch.RedirectStandardInput = $true
    $relaunch.EnvironmentVariables['LIBRARY_CHECKS_STDIN_DETACHED'] = '1'
    $detached = [Diagnostics.Process]::Start($relaunch)
    $detached.StandardInput.Close()
    $detached.WaitForExit()
    exit $detached.ExitCode
}

# The Desk path is resolved, never composed -- see BookRootSchema's SEATS section.
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
# For Use-DeploymentEnvironment below: the endpoint and collection id a spawned suite needs, read
# from the attached workspace rather than from wherever the child happens to be launched.
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')

if ([string]::IsNullOrWhiteSpace($ProgramPath)) { $ProgramPath = Split-Path -Parent $PSScriptRoot }
$program = (Resolve-Path -LiteralPath $ProgramPath).Path

# `Resolve-LibraryWorkspace` rather than `Resolve-ToolWorkspace`, because the tool form THROWS on
# `none` and this is the one caller for which `none` is an answer rather than a failure. A
# `conflict` stays fatal: three sources disagreeing about which Library is being checked is not
# something to pick a winner for.
$script:WorkspaceAbsentReason = ''
$resolvedWorkspace = Resolve-LibraryWorkspace -Explicit $WorkspacePath
if ([string]$resolvedWorkspace.kind -ceq 'conflict') { throw ([string]$resolvedWorkspace.reason) }
if ([string]$resolvedWorkspace.kind -ceq 'none') {
    $workspace = ''
    $script:WorkspaceAbsentReason = ('no reader workspace is attached, so nothing was read from a Shelf, a Notebook or ' +
                                     'internal/; pass -WorkspacePath <folder>, set LIBRARY_WORKSPACE, or run from inside ' +
                                     'a workspace. `library init <folder>` creates one.')
}
else { $workspace = (Resolve-Path -LiteralPath ([string]$resolvedWorkspace.workspace)).Path }

# A SEATED SESSION'S VARIABLES NEVER REACH A SUITE (the Report Inbox's S50 note, measured in S69). Run from a
# seat, the gate inherited what `seat start` set -- the Library, the seat, its claim, which assistant and which
# launcher -- and the Orca tab's handle, and every suite it spawned inherited them again:
# `workspace-init.selftest` and `codex.portability-selftest` both failed, and the kernel self-test retitled
# the reader's tab. The workspace above is resolved first, so a seated run still attaches its Library for
# the workspace checks; Use-WorkspaceEnvironment hands it back to the one child that asks. The deployment
# variables are not cleared: a run that set them in its own shell keeps them (Use-DeploymentEnvironment).
$script:SeatedSessionVariables = @('LIBRARY_WORKSPACE', 'LIBRARY_SEAT', 'LIBRARY_SEAT_CLAIM', 'DESKPOST_ASSISTANT', 'DESKPOST_LAUNCHER_PID', 'ORCA_TERMINAL_HANDLE')
function Clear-SeatedSessionEnvironment {
    foreach ($name in $script:SeatedSessionVariables) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
}
Clear-SeatedSessionEnvironment

# SOME CHILDREN NEED IT AND MOST MUST NOT SEE IT. Several checks are whole suites run as their own
# processes, and a child resolves its workspace from scratch. Before the split they needed nothing:
# the program root they were launched from WAS a workspace, so their own walk-up found it. It is not
# one any more, and the first full gate after the split failed four checks for exactly that.
#
# SETTING IT ONCE FOR THE WHOLE RUN IS THE OBVIOUS FIX AND IT IS WRONG. Measured on 2026-09-21: it
# turned three green suites red, and all three had workspace RESOLUTION as their subject.
# `workspace-init.selftest` asserts that a cwd inside a freshly initialised workspace resolves by
# its marker, and got `environment` instead; `library-hooks.boundary-suite` and
# `codex.portability-selftest` drive packaged guards that must resolve a FIXTURE. An ambient
# variable is not a neutral default for a suite whose job is to decide where a workspace comes from.
#
# So it is scoped to the one child that asked for it, and restored afterwards.
function Use-WorkspaceEnvironment {
    param([Parameter(Mandatory = $true)][scriptblock]$Body)
    $previous = $env:LIBRARY_WORKSPACE
    $env:LIBRARY_WORKSPACE = $workspace
    try { & $Body }
    finally { $env:LIBRARY_WORKSPACE = $previous }
}

# THE OTHER HALF A CHILD LOST AT THE SPLIT, AND IT IS A DIFFERENT HALF. `LIBRARY_WORKSPACE` says
# WHICH LIBRARY. These two say WHICH DEPLOYMENT -- the Basic Memory endpoint and the collection id --
# and before step 22 they sat in the program's own `.claude/.library-*`, so every child found them by
# being launched from there. They live in the reader's workspace now, and five suites that ask nothing
# whatever about workspace resolution began refusing with "No Basic Memory endpoint is configured".
#
# NOT `LIBRARY_WORKSPACE`, DELIBERATELY, AND THE DIFFERENCE IS A SAFETY ONE. Handing these five the
# reader's workspace would point every helper they drive at the reader's REAL Shelf the moment one
# fixture forgot to pass an explicit path -- and `codex.portability-selftest` is one of the three S17
# measured breaking under an ambient workspace, because resolution is its subject. A deployment value
# carries no such hazard: it names a server to talk to, not a place to write.
#
# A value already in the environment is left alone, so a run that set one in its own shell keeps it.
# ALL THREE OF THEM, which took one more round to find. The endpoint and the collection id are what
# the refusals named, so they went in first; the share root is what the WRITE FENCE needs, and a
# child that had the first two refused instead with "attached to a Basic Memory collection with no
# filesystem view of it, so its writes cannot be fenced". Three files under `.claude/` hold this
# deployment -- `.library-mcp-url`, `.library-project`, `.library-shared-root` -- and
# `Get-DeploymentScanDenylist` already reads exactly that set. A subset of a deployment is not a
# deployment.
function Use-DeploymentEnvironment {
    param([Parameter(Mandatory = $true)][scriptblock]$Body)
    $savedUrl = $env:AI_LIBRARY_MCP_URL
    $savedId = $env:AI_LIBRARY_PROJECT_ID
    $savedShare = $env:LIBRARY_SHARED_COLLECTION_ROOT
    try {
        if ([string]::IsNullOrWhiteSpace($savedUrl)) {
            $env:AI_LIBRARY_MCP_URL = Resolve-LibraryMcpUrl -WorkspacePath $workspace -Optional
        }
        if ([string]::IsNullOrWhiteSpace($savedId)) {
            $env:AI_LIBRARY_PROJECT_ID = Resolve-LibraryCollectionId -WorkspacePath $workspace -Optional
        }
        if ([string]::IsNullOrWhiteSpace($savedShare)) {
            $env:LIBRARY_SHARED_COLLECTION_ROOT = Resolve-LibrarySharedCollectionRoot -WorkspacePath $workspace
        }
        & $Body
    }
    finally {
        $env:AI_LIBRARY_MCP_URL = $savedUrl
        $env:AI_LIBRARY_PROJECT_ID = $savedId
        $env:LIBRARY_SHARED_COLLECTION_ROOT = $savedShare
    }
}

$results = [Collections.Generic.List[object]]::new()

# A LINE PER CHECK AS IT IS RECORDED (s127 row 7): the table prints only at the end, so a -Fast run showed nothing for
# minutes. Not in the table's "[ OK ] name" shape, which tools/gate.ts parses as an outcome and would count twice; not
# under -Json, whose stdout is one document, nor -WorkspaceOnly, which filters the results later.
function Add-Result([string]$Name, [string]$Status, [string]$Detail) {
    if ($Only -and $Name -cne $Only) { return }
    [void]$results.Add([pscustomobject]@{ check = $Name; status = $Status; detail = $Detail })
    if (-not $Json -and -not $WorkspaceOnly) { Write-Host ('progress: {0} {1} {2}' -f (Get-Date -Format 'HH:mm:ss'), $Status, $Name) }
}

# THE NAMES REGISTERED THROUGH Invoke-WorkspaceCheck, collected as they run, so -WorkspaceOnly
# filters on the declaration each check already makes rather than on a second list of names.
$script:WorkspaceCheckNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$script:InWorkspaceCheck = $false
# Set on entry to the -Fast else branch, which is where every spawned suite is registered. NOT by
# assigning -Fast: a script parameter reassigned in the body is defect family 4, and the gate says so.
$script:InSuiteBranch = $false

function Invoke-Check([string]$Name, [scriptblock]$Body) {
    # A PROGRAM CHECK UNDER -WorkspaceOnly IS NOT RUN AT ALL, rather than run and filtered: several
    # of them take seconds, and a doctor that paid for a scan of this program's source to throw the
    # answer away would be slow for nothing.
    if ($WorkspaceOnly -and -not $script:InWorkspaceCheck) { return }
    if ($Only -and $Name -cne $Only) { return }
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

# EVERY NAME A CHECK CAN BE REGISTERED UNDER, in one place. Two separate AST scans read this
# runner's own source to derive the set of registered checks -- gate.fast-roster-matches-suites and
# seats.contract-table-matches-code -- and on 2026-09-21 adding a second invoker broke both, each
# reporting that a check it could plainly see was registered by nothing. A scan that knows one
# invoker silently shrinks its set every time another is added, which is the same defect as a
# hardcoded copy of a table.
$script:CheckInvokerNames = @('Invoke-Check', 'Invoke-WorkspaceCheck')

function Invoke-WorkspaceCheck([string]$Name, [scriptblock]$Body) {
    <#
        A check that reads the READER'S material -- a Shelf, a Notebook, output/, internal/ or the
        Desk -- rather than the program. It skips, with the reason, when no workspace is attached.

        SKIP AND FAIL ARE DIFFERENT ANSWERS AND ONLY ONE OF THEM IS TRUE HERE. Before the split
        these three checks could not tell "this Shelf is inconsistent" from "there is no Shelf",
        because the program always had one beside it. The moment the reader's material moved out,
        the program's own pre-commit gate began reporting three failures about a Shelf that had
        not gone wrong -- it had gone somewhere else. A contributor who clones the program and
        never creates a Library would have seen exactly the same three.
    #>
    # A SUITE IS NOT A DOCTOR'S CHECK even when it reads the workspace, so -WorkspaceOnly drops it
    # without running it -- and without recording its name, so the report does not carry it either.
    if ($WorkspaceOnly -and $script:InSuiteBranch) { return }
    if ($Only -and $Name -cne $Only) { return }
    [void]$script:WorkspaceCheckNames.Add($Name)
    if ([string]::IsNullOrWhiteSpace($workspace)) {
        Add-Result $Name 'skipped' $script:WorkspaceAbsentReason
        return
    }
    $script:InWorkspaceCheck = $true
    try { Invoke-Check $Name $Body }
    finally { $script:InWorkspaceCheck = $false }
}

# --- Settings: parseable, and both guards plus the desk hook actually registered -----------------
# The tracked project file wins once 0.4 lands; until then the .local file is the live one.
Invoke-Check 'settings.parse' {
    # @(...) is load-bearing: a single match unrolls to a bare string, and .Count then fails
    # under StrictMode. The same defect class is recorded in docs/project-hub-design.md.
    $candidates = @(@('settings.json', 'settings.local.json') |
        ForEach-Object { Join-Path $program (Join-Path '.claude' $_) } |
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
        ForEach-Object { Join-Path $program (Join-Path '.claude' $_) } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if (-not $files.Count) { throw 'No .claude/settings.json or settings.local.json found.' }
    # BOTH files, not the first one that exists. The harness merges them, so a hook moved from the
    # tracked file to the local one is still registered, and failing on that would report a working
    # checkout as broken.
    $trees = @($files | ForEach-Object { [IO.File]::ReadAllText($_) | ConvertFrom-Json })
    $problems = @(Get-HookRegistrationProblems -Settings $trees)
    $blocking = @($problems | Where-Object { -not $_.optional })
    if ($blocking.Count) { throw (($blocking | ForEach-Object { $_.detail }) -join '; ') }

    # AND THE SHAPE OF THE PROGRAM'S OWN BLOCK, which nothing asked until 2026-09-22. Everything
    # above WALKS the block, and the walk coerces with @(), so a bare object reads exactly as a
    # one-element array does -- this check would report "all 9 hooks registered under the events
    # they act on" about a settings.json Claude Code refuses to load and therefore skips ENTIRELY.
    # That is the program's own boundary gone, in the tree every development session sits in.
    #
    # THE SAME JUDGE AS THE OTHER THREE. `workspace.guards-registered` asks this of the reader's
    # workspace, `library init` asks it before it writes, and the plugin packager asks it of what
    # it generates. This is the fourth consumer and the last settings document in the tree that
    # was still judged by a walk alone.
    #
    # A TREE WITH NO `hooks` KEY IS SKIPPED RATHER THAN FAULTED: settings.local.json may hold none,
    # and Test-ClaudeHookShape's "no top-level hooks key" fault is written for a hooks FILE.
    $shapeFaults = [Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt $files.Count; $i++) {
        $tree = $trees[$i]
        if ($null -eq $tree) { continue }
        $treeNames = @($tree.PSObject.Properties | ForEach-Object { $_.Name })
        if ($treeNames -cnotcontains 'hooks' -or $null -eq $tree.hooks) { continue }
        foreach ($fault in @(Test-ClaudeHookShape -Document $tree -Label (Split-Path -Leaf $files[$i]))) {
            [void]$shapeFaults.Add($fault)
        }
    }
    if ($shapeFaults.Count) {
        throw ((@($shapeFaults) -join '; ') + ' -- a settings file whose hooks block is malformed is skipped ' +
               'ENTIRELY by the harness, so every hook counted above would be silent in a session rooted here.')
    }
    $required = @(Get-RequiredHooks)
    if ($problems.Count) {
        return "WARN: $(($problems | ForEach-Object { $_.detail }) -join '; ')"
    }
    "all $($required.Count) hooks registered under the events they act on"
}

if (-not $WorkspaceOnly -and -not (Test-Path -LiteralPath (Join-Path $program '.codex/config.toml')) -and
    -not (Test-Path -LiteralPath (Join-Path $program '.codex/hooks.json'))) {
    Add-Result 'codex.project-access-config' 'skipped' 'both rendered Codex files are absent (a fresh clone or worktree); render them with powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/Initialize-CodexLibrary.ps1'
} else {
Invoke-Check 'codex.project-access-config' {
    $configTemplatePath = Join-Path $program (Join-Path '.codex' 'config.template.toml')
    $hooksTemplatePath = Join-Path $program (Join-Path '.codex' 'hooks.template.json')
    $configPath = Join-Path $program (Join-Path '.codex' 'config.toml')
    $hooksPath = Join-Path $program (Join-Path '.codex' 'hooks.json')
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

    # THE SHAPE, WHICH VALID JSON DOES NOT IMPLY, AND IT IS NOW ONE JUDGE RATHER THAN THIS CHECK'S
    # OWN COPY. Until 2026-09-06 this read $hooks.PreToolUse -- the events at the ROOT of the file --
    # and passed for months on a file Codex rejected outright:
    #   warning: failed to parse hooks config ...: unknown field `PreToolUse`,
    #                                             expected `description` or `hooks`
    # Every Library hook was therefore absent from every Codex session, and nothing said so: the file
    # existed, parsed as JSON, and named the right scripts. `Test-CodexHookShape` in
    # tools/HookRegistry.ps1 asks that question now, for this check, for the renderer that writes the
    # file and for `workspace.codex-guards-registered` -- and it adds the nested array shape, which
    # this check had never asked at all.
    . (Join-Path $PSScriptRoot 'HookRegistry.ps1')
    . (Join-Path $PSScriptRoot 'CodexBindings.ps1')
    $shapeFaults = @(Test-CodexHookShape -Document $hooks -Label '.codex/hooks.json')
    if ($shapeFaults.Count) { throw (@($shapeFaults) -join '; ') }

    # WHICH HOOKS, UNDER WHICH EVENT, BOUND TO WHICH MATCHER -- all three from the one table in
    # HookRegistry.ps1, including the two matchers that were each guessed wrong once: Codex normalises
    # its shell tool to `Bash` for hooks and does NOT normalise `apply_patch`, so a matcher naming
    # `exec`, `Write` or `Edit` is registered and unable to fire.
    $registrationProblems = @(Get-CodexRegistrationProblems -Document $hooks)
    if ($registrationProblems.Count) { throw (@($registrationProblems) -join ' ') }

    # AND THAT EVERY PATH IT NAMES IS STILL THERE, which nothing asked until 2026-09-22 and which was
    # FALSE on this machine the whole of the day before. The migration of 2026-09-21 retired
    # `D:\Library`, and these generated bindings -- gitignored, so no commit touched them -- went on
    # naming hooks and an adapter under the old root. Every assertion above stayed green: the sections
    # were present, the events nested correctly, the matchers named the right tools, and not one of
    # the five files existed. A registration naming a script that is not there is a hook that cannot
    # start, which in this harness is a boundary that is simply absent.
    $missing = [Collections.Generic.List[string]]::new()
    foreach ($eventProperty in @($hooks.hooks.PSObject.Properties)) {
        foreach ($matcherBlock in @($eventProperty.Value)) {
            if ($null -eq $matcherBlock) { continue }
            $blockNames = @($matcherBlock.PSObject.Properties | ForEach-Object { $_.Name })
            if ($blockNames -cnotcontains 'hooks') { continue }
            foreach ($entry in @($matcherBlock.hooks)) {
                if ($null -eq $entry) { continue }
                foreach ($token in @((Get-HookEntryText $entry) -split '\s+')) {
                    $candidate = ([string]$token).Trim('"')
                    if ($candidate -cnotlike '*.ps1') { continue }
                    if (-not [IO.Path]::IsPathRooted($candidate)) { continue }
                    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                        [void]$missing.Add("$($eventProperty.Name) -> $candidate")
                    }
                }
            }
        }
    }
    # The reader adapter is named in config.toml rather than in the hooks file, and it fails the same
    # way: Codex reports a server that will not start, and the session has no way to read a Book.
    $readerArguments = [regex]::Match($config, '(?m)^args\s*=\s*\[([^\r\n]+)\]\s*$')
    if ($readerArguments.Success) {
        foreach ($token in @($readerArguments.Groups[1].Value -split ',')) {
            $candidate = ([string]$token).Trim().Trim('"')
            if ($candidate -cnotlike '*.ps1') { continue }
            if (-not [IO.Path]::IsPathRooted($candidate)) { continue }
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                [void]$missing.Add("mcp_servers.validated-book-reader -> $candidate")
            }
        }
    }
    if ($missing.Count) {
        throw ('a generated Codex binding names a file that is not there, so it cannot start: ' +
               (@($missing) -join '; ') + '. These files are generated and gitignored, so a program that ' +
               'moved leaves them behind: re-run tools/Initialize-CodexLibrary.ps1.')
    }

    # Read the same enabled-table rule as init and the checkout renderer, never a PowerShell copy.
    $turnOffCheck = @'
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
(async () => {
  const {codexTurnedOn, codexUserConfig, readCodexConfigTables} = await import(pathToFileURL(path.join(process.argv[1], 'kernel/src/doctor.ts')).href);
  const user = codexUserConfig();
  if (user.state === 'unreadable') throw Error('Cannot read the user Codex config: ' + user.path);
  const template = readCodexConfigTables(fs.readFileSync(process.argv[2], 'utf8').replace(/^enabled\s*=.*$/gm, ''));
  const rendered = readCodexConfigTables(fs.readFileSync(process.argv[3], 'utf8'));
  if (!template || !rendered) throw Error('Cannot read the checkout Codex tables.');
  const on = user.tables ? codexTurnedOn(user.tables) : {servers: [], plugins: []};
  const missing = [...on.servers.filter(e => !template.servers.some(t => t.name === e.name) && !rendered.servers.some(t => t.name === e.name && t.enabled === false)).map(e => 'server ' + e.name), ...on.plugins.filter(e => !rendered.plugins.some(t => t.name === e.name && t.enabled === false)).map(e => 'plugin ' + e.name)];
  process.stdout.write(missing.join(', '));
})().catch(error => {console.error(error.message); process.exitCode = 1;});
'@
    try {
        $turnOffMissing = @(& node -e $turnOffCheck (Split-Path -Parent $PSScriptRoot) $configTemplatePath $configPath)
        if ($LASTEXITCODE -ne 0) { return 'WARN: could not check inherited Codex servers and plugins; re-run tools/Initialize-CodexLibrary.ps1.' }
        if ($turnOffMissing.Count) { return ('WARN: inherited Codex entries are still enabled: ' + ($turnOffMissing -join ' ') + '; re-run tools/Initialize-CodexLibrary.ps1.') }
    } catch { return ('WARN: could not check inherited Codex servers and plugins; re-run tools/Initialize-CodexLibrary.ps1. ' + $_.Exception.Message) }
    'both MCP servers required; events nested under hooks; Desk guard, shell guard, patch guard and context hook registered, and every path they name resolves'
}
}


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
    $hook = Join-Path $program '.claude/hooks/Get-SeatStartContext.ps1'
    if (-not (Test-Path -LiteralPath $hook -PathType Leaf)) { throw 'the SessionStart seat hook is missing; a seatless session is offered nothing.' }
    $doc = Join-Path $program 'docs/seats.md'
    if (-not (Test-Path -LiteralPath $doc -PathType Leaf)) { throw 'docs/seats.md is missing; the seat hook has no document to serve.' }
    # The REAL cutter, not a reimplementation of it: a check that parsed headings its own way would
    # pass on a document the hook cannot cut.
    . (Join-Path $program '.claude/hooks/HookContext.ps1')

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

    $claudeMd = Join-Path $program 'CLAUDE.md'
    if (-not (Test-Path -LiteralPath $claudeMd -PathType Leaf)) { throw 'CLAUDE.md is missing.' }
    $fileWords = Measure-InstructionWords (Get-Content -LiteralPath $claudeMd -Raw)
    [void]$parts.Add([pscustomobject]@{ name = 'CLAUDE.md'; words = $fileWords })

    # A Skill costs its name and description in every session; only the body is on demand.
    $skillsRoot = Join-Path $program '.claude/skills'
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

    $rulesRoot = Join-Path $program '.claude/rules'
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
                if (-not (Test-Path -LiteralPath (Join-Path $program $literal))) {
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
    $skillRoot = Join-Path $program '.claude/skills/library-help'
    $skillFile = Join-Path $skillRoot 'SKILL.md'
    if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) {
        throw 'the library-help Skill is missing its SKILL.md; nothing can load the reader help surface'
    }
    $skillText = Get-Content -LiteralPath $skillFile -Raw
    $problems = [Collections.Generic.List[string]]::new()
    $skillVersion = [string](Get-Content -LiteralPath (Join-Path $program '.codex-plugin/plugin.json') -Raw | ConvertFrom-Json).version

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
        # A LINK PINNED TO THE RELEASE'S TAG (PLAN-assistant-onboarding.md step 7): init copies the Skill into a
        # Library, where `../../../docs/` names nothing, so its design-record links name the repository at this
        # release's tag. Such a link resolves when it names THIS version and the doc is in the tree it is built from.
        foreach ($m in [regex]::Matches($text, '\]\(https://github\.com/eKioga/deskpost/blob/v([0-9A-Za-z.+-]+)/([^)#]+\.md)(?:#[^)]*)?\)')) {
            if ($m.Groups[1].Value -cne $skillVersion) {
                [void]$problems.Add("$($file.Name) links docs at v$($m.Groups[1].Value), not this release's v$skillVersion")
            }
            if (-not (Test-Path -LiteralPath (Join-Path $program $m.Groups[2].Value))) {
                [void]$problems.Add("$($file.Name) -> $($m.Groups[2].Value) (pinned) is not in this tree")
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
    $indexFile = Join-Path $program 'docs/_index.md'
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
    $skillGuides = @([regex]::Matches($skillGuidesSection.Groups[1].Value, '(?m)^[*-]\s+\[[^\]]*\]\((?:\.\./\.\./\.\./|https://github\.com/eKioga/deskpost/blob/v[0-9A-Za-z.+-]+/)docs/([A-Za-z0-9_./-]+\.md)\)') |
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

# --- Offline self-test suites ---------------------------------------------------------------------
if ($Fast) {
    foreach ($name in @('plugin.generated-files-match', 'workspace-init.selftest')) {
        # This roster is the -Fast summary's only record that these suites exist. A check absent from
        # it does not run in -Fast AND is not reported skipped, so the pre-commit hook's line silently
        # counts one fewer -- the same shape as a suite nothing runs, one step quieter. The three
        # token-efficiency suites were added here for that reason, not because they behave differently.
        Add-Result $name 'skipped' 'suite skipped in -Fast mode'
    }
}
else {
$script:InSuiteBranch = $true

# --- `library init` (PLAN-public-release.md step 20) ---------------------------------------------
#
# REGISTERED IN BOTH places: the roster string above and this call. A name in one and not the other
# neither runs in -Fast nor is reported skipped. Only by hand now: tools/gate.ts runs its TypeScript
# port, workspaceInitTemplates in tools/gate-checks.ts (kickoffs/s224).
#
# THE SUITE IS WHERE THE INVARIANTS LIVE, not the tool. Idempotence, an existing id that a re-run
# must not reissue, a reader's own CLAUDE.md surviving byte for byte above and below the managed
# block, a second run that must not append a second block, three shapes of malformed marker that
# refuse WITHOUT writing the workspace marker first, a settings merge that keeps unrelated entries
# and refuses a conflicting one, and an un-split checkout whose instruction files are the program's.
Invoke-Check 'workspace-init.selftest' {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Initialize-LibraryWorkspace.ps1') -SelfTest 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($out | Select-Object -Last 5) -join ' | ') }
    (@($out) | Select-Object -Last 1)
}

# --- The Claude plugin files are generated, and a drift is a gate failure ------------------------
#
# PLAN-public-release.md step 19. The Codex layout at the program root is canonical; Claude's
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

}

# --- Report ---------------------------------------------------------------------------------------
# The -Fast roster and the -IncludeShared stand-ins report through Add-Result directly, so a
# workspace-only report is filtered here as well as at Invoke-Check: what it keeps is exactly the
# set Invoke-WorkspaceCheck saw.
if ($WorkspaceOnly) {
    $kept = @($results | Where-Object { $script:WorkspaceCheckNames.Contains([string]$_.check) })
    $results = [Collections.Generic.List[object]]::new()
    foreach ($row in $kept) { [void]$results.Add($row) }
}
# -Only reports exactly one result. Add-Result has already dropped every other name, so none means no check
# is registered under it (or this mode does not reach it), and more than one means it is registered twice.
if ($Only -and $results.Count -ne 1) {
    $found = $results.Count
    $results = [Collections.Generic.List[object]]::new()
    if ($found -eq 0) {
        Add-Result $Only 'fail' "no check named '$Only' ran in this mode; -Only takes one registered check name"
    }
    else { Add-Result $Only 'fail' "'$Only' reported $found results; -Only expects exactly one" }
}
$failed =@($results | Where-Object { $_.status -eq 'fail' })
$summary = [pscustomobject]@{
    operation            = 'Library Checks'
    # BOTH ROOTS, because since step 22 they are two answers and a report naming one of them
    # cannot be read back. `workspace` is empty when no reader workspace is attached, which is the
    # state in which the workspace-reading checks report `skipped`.
    program              = $program
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
