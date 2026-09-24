<#
.SYNOPSIS
    `library` -- the command a reader runs. Resolves the workspace, dispatches the verb.

.DESCRIPTION
    WHY THIS FILE EXISTS, AND IT IS A MEASUREMENT RATHER THAN A DESIGN. The workspace instructions
    `library init` writes name `library desk` as the way to answer "what's on my desk?", and on
    2026-09-21 the first seated session in a split workspace looked for that command and there was
    no `library` on this machine at all. It found `D:\deskpost\app\tools\Get-DeskOverview.ps1` by
    itself and ran that, which is the right answer and is not one a reader should have to reach.
    Rooting the seat in the workspace (ADR-0037) made it visible rather than causing it: before the
    split, `tools/` was a relative path from where the reader sat, and after it the program is
    somewhere else entirely.

    WHAT IT IS NOT. It is not the Bun single binary of PLAN-public-release.md's packaging row, and
    it does not pretend to be. It is the entry point that row needs FIRST -- the dispatch and the
    workspace resolution, in the language the rest of the program is already written in, at the
    address the binary will eventually occupy. When the binary lands it replaces this file, and the
    verbs it answers to do not change.

    WHY THE REPOSITORY ROOT AND NOT `tools/`. `tools/` holds helpers, which `tools/_helpers.json`
    declares and the permission allowlist grants one by one. This is the command that RUNS them, and
    an install puts it on PATH. The plugin root is already the repository root (S13), so the program
    root is the one directory every packaging story here has in common.

    THE WORKSPACE IS RESOLVED ONCE, HERE, and every verb below is handed the answer. That is the
    whole of what this adds over typing the helper's path: `Resolve-ToolWorkspace` is the program's
    own chain -- explicit, then LIBRARY_WORKSPACE, then a walk up from the cwd -- and its refusal is
    already worded for a reader. It is passed on verbatim rather than re-worded, because a refusal
    naming three routes beats a second opinion about which one to take.

    `init` IS THE ONE VERB THAT MUST NOT RESOLVE ONE. It is how a workspace comes to exist, so
    requiring one would make the first command a reader ever runs refuse. Its folder argument is its
    own, and `Initialize-LibraryWorkspace.ps1` defaults it to the current directory exactly as
    `library init` with no argument means.

.EXAMPLE
    library desk
.EXAMPLE
    library --workspace D:\deskpost\workspaces\eric desk -Json
.EXAMPLE
    library init D:\deskpost\workspaces\eric
#>

# NO param() BLOCK, AND THAT IS DELIBERATE TWICE OVER. A dispatcher that declared typed parameters
# would have PowerShell's binder eat the verb's own arguments before the verb ever saw them, and
# `$args` carries them through untouched. It also keeps this file safe to dot-source, which is the
# hazard S19 walked into on 2026-09-21: dot-sourcing a file that declares param() REBINDS the
# caller's variables to that block's defaults, and `tools/PluginPackage.ps1` silently turned a
# caller's -SelfTest into $false and let the real run proceed. Nothing dot-sources this file today;
# the point is that nothing is punished for trying.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ProgramRoot = $PSScriptRoot
. (Join-Path $script:ProgramRoot (Join-Path 'tools' 'WorkspaceRegistry.ps1'))

# THE TABLE IS THE HELP AND THE HELP IS THE TABLE. A second list of verbs in a here-string is a
# second chance to be wrong, and this program has paid for that shape more than once.
#
# `workspace` says what this verb wants done about a Library before it runs:
#   required  resolve one and hand it over as -WorkspacePath; refuse, in the resolver's words, if
#             there is none
#   creates   resolve nothing; this verb is how one comes to exist
$script:Verbs = [ordered]@{
    'desk' = [ordered]@{
        helper    = 'Get-DeskOverview.ps1'
        workspace = 'required'
        usage     = 'library desk [-Seat <name>] [-Json]'
        summary   = "What is on this seat's Desk, and one line per other seat."
    }
    'init' = [ordered]@{
        helper    = 'Initialize-LibraryWorkspace.ps1'
        workspace = 'creates'
        usage     = 'library init [<folder>] [-Force] [-Json]'
        summary   = 'Make a folder a Library workspace, and tell this machine about it.'
    }
}

function Write-LibraryCommandUsage {
    $lines = [Collections.Generic.List[string]]::new()
    [void]$lines.Add('library -- the Library, from the command line.')
    [void]$lines.Add('')
    [void]$lines.Add('Usage: library [--workspace <path>] <command> [arguments]')
    [void]$lines.Add('')
    [void]$lines.Add('Commands:')
    foreach ($name in @($script:Verbs.Keys)) {
        $verb = $script:Verbs[$name]
        [void]$lines.Add(('  {0,-6} {1}' -f $name, [string]$verb.summary))
        [void]$lines.Add(('         {0}' -f [string]$verb.usage))
    }
    [void]$lines.Add('')
    [void]$lines.Add('Every command but `init` runs against one workspace, chosen in this order:')
    [void]$lines.Add('  --workspace <path>, then $env:LIBRARY_WORKSPACE, then a walk up from the current directory.')
    [void]$lines.Add('')
    [void]$lines.Add('Arguments after the command are passed to its helper unchanged, so anything that helper')
    [void]$lines.Add('accepts works here. The helpers live in ' + (Join-Path $script:ProgramRoot 'tools') + '.')
    ($lines -join [Environment]::NewLine)
}

function Write-LibraryCommandRefusal([string]$Message) {
    # REFUSALS GO TO STDERR AND THE EXIT CODE IS NON-ZERO. A dispatcher that printed a refusal on
    # stdout and exited 0 would be indistinguishable from a result to everything that runs it.
    [Console]::Error.WriteLine($Message)
    exit 1
}

# --- The global options, read off the front ---------------------------------------------------
# ONLY BEFORE THE VERB. `--workspace` after the verb belongs to the helper, which has its own
# -WorkspacePath and its own opinion about it; swallowing it here would make one spelling mean two
# different things depending on where it appeared.
$argv = [Collections.Generic.List[string]]::new()
foreach ($item in @($args)) { [void]$argv.Add([string]$item) }

$explicitWorkspace = ''
while ($argv.Count -gt 0 -and ([string]$argv[0]) -cin @('--workspace', '-WorkspacePath', '-workspace')) {
    if ($argv.Count -lt 2) {
        Write-LibraryCommandRefusal "$($argv[0]) needs a path after it."
    }
    $explicitWorkspace = [string]$argv[1]
    $argv.RemoveRange(0, 2)
}

if ($argv.Count -eq 0 -or ([string]$argv[0]) -cin @('help', '--help', '-h', '-?', '/?')) {
    Write-Output (Write-LibraryCommandUsage)
    exit 0
}

$verbName = [string]$argv[0]
$argv.RemoveAt(0)

if (-not $script:Verbs.Contains($verbName)) {
    # NAMES WHAT EXISTS. A bare "unknown command" leaves the reader guessing at a list this file is
    # holding in its hand.
    Write-LibraryCommandRefusal ("library has no command '$verbName'. It has: " +
        ((@($script:Verbs.Keys) | Sort-Object) -join ', ') + ". Run ``library help`` for what each one does.")
}

$verb = $script:Verbs[$verbName]
$helperPath = Join-Path $script:ProgramRoot (Join-Path 'tools' ([string]$verb.helper))
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    Write-LibraryCommandRefusal ("library $verbName needs $helperPath, which is not there. This copy of the " +
        'program is incomplete; re-install it rather than working around this.')
}

$forwarded = [Collections.Generic.List[string]]::new()
foreach ($item in @($argv)) { [void]$forwarded.Add([string]$item) }

if ([string]$verb.workspace -ceq 'required') {
    # A CALLER WHO SPELLED IT OUT AFTER THE VERB KEEPS IT. Passing a second -WorkspacePath would be
    # a binder error rather than a refusal, and the reader's own spelling is the one that should win.
    $alreadyNamed = $false
    foreach ($item in @($forwarded)) {
        if (([string]$item) -clike '-WorkspacePath*') { $alreadyNamed = $true }
    }
    if (-not $alreadyNamed) {
        # THE RESOLVER'S REFUSAL IS PASSED ON, NOT RESTATED. It already names the three routes and
        # the command that creates a workspace, and a second wording of that would drift from it.
        $workspace = ''
        try {
            $workspace = Resolve-ToolWorkspace -Explicit $explicitWorkspace -Anchor $script:ProgramRoot
        }
        catch {
            Write-LibraryCommandRefusal ("library $verbName : $($_.Exception.Message)")
        }
        [void]$forwarded.Insert(0, '-WorkspacePath')
        [void]$forwarded.Insert(1, [string]$workspace)
    }
}
elseif ([string]$verb.workspace -ceq 'creates') {
    # `library init <folder>` -- the folder is positional here and named -Path there. Only a leading
    # bare word is translated: everything after it is the helper's own switches.
    if ($forwarded.Count -gt 0 -and -not (([string]$forwarded[0]).StartsWith('-'))) {
        [void]$forwarded.Insert(0, '-Path')
    }
    if (-not [string]::IsNullOrWhiteSpace($explicitWorkspace)) {
        $alreadyNamed = $false
        foreach ($item in @($forwarded)) {
            if (([string]$item) -clike '-Path*') { $alreadyNamed = $true }
        }
        if (-not $alreadyNamed) {
            [void]$forwarded.Insert(0, '-Path')
            [void]$forwarded.Insert(1, $explicitWorkspace)
        }
    }
}

# --- The call, and why it is a child process -----------------------------------------------------
#
# SPLATTING WAS THE OBVIOUS ANSWER AND IT IS THE WRONG ONE. Measured here on the first real run:
# `& $helper @array` binds every element POSITIONALLY, so `-WorkspacePath` arrived at
# Get-DeskOverview.ps1 as the VALUE of its first positional parameter and it went looking for a
# directory called `-WorkspacePath`. Re-measured against a three-parameter probe script with
# [string[]], [object[]] and a List's .ToArray() -- all three bound `WorkspacePath=[-WorkspacePath]`
# and `Seat=[D:\x]`. Array splatting does not bind by name, in any of its spellings, and a hashtable
# splat would require this file to know each helper's parameter set, which is the copy this program
# keeps refusing to make.
#
# `powershell.exe -File` HANDS THE ARGUMENTS TO A REAL BINDER instead. The child parses them exactly
# as a reader typing them would, so "passed to its helper unchanged" is true rather than nearly
# true, and this is the same invocation shape the permission allowlist already grants each helper
# and the same one a packaged binary will spawn.
#
# THE COST IS NAMED: a process and its start-up, and text on stdout rather than a live object. For a
# command a reader runs, text IS the output; a caller that wants structure passes -Json, which every
# helper here already answers.
$childArguments = [Collections.Generic.List[string]]::new()
[void]$childArguments.Add('-NoProfile')
[void]$childArguments.Add('-ExecutionPolicy')
[void]$childArguments.Add('Bypass')
[void]$childArguments.Add('-File')
[void]$childArguments.Add($helperPath)
foreach ($item in @($forwarded)) { [void]$childArguments.Add([string]$item) }

# SET BEFORE THE CALL, NOT READ AFTER IT. $LASTEXITCODE keeps whatever the last native command left
# in it, so a run that set nothing would otherwise be judged by a number from somewhere else.
$global:LASTEXITCODE = 0
& powershell.exe @($childArguments.ToArray())
exit $LASTEXITCODE
