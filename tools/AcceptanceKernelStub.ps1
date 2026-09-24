<#
.SYNOPSIS
    A stand-in for the TypeScript kernel, so the acceptance harness's comparison can be falsified
    before the kernel exists. Invoked only by tools/Invoke-AcceptanceMatrix.ps1 -SelfTest.

.DESCRIPTION
    WHY THIS EXISTS. `tools/Invoke-AcceptanceMatrix.ps1` compares two arms, and until Phase D's
    port lands there is only one. A harness whose comparison has never executed is a harness whose
    most important half is unproven -- and it would stay unproven for as many sessions as the port
    takes, which is exactly the shape `.claude/rules/library-development.md` names: a suite can be
    green and unreached.

    SO THE STUB IS DRIVEN FOUR WAYS, and the interesting one is `-Divergent`. A comparator that
    never reports a difference agrees with everything, so the case that gives the other three
    meaning is the one where the stub is WRONG and the harness must say so.

      (default)      do what the real helper does, in this arm's own fixture. Different directory,
                     different workspace id, different created stamp -- so the row is green only if
                     normalisation is really removing those.
      -Divergent     do that, and then write one extra file. The row must report a difference.
      -NotebookOnly  do that, and then write one extra Notebook topic UNDER notebook/. Until S18
                     the approved delta `notebook-is-seat-owned` absorbed ANY difference there, content
                     included, and this mode proved the row stayed green. The delta is a rebase now,
                     keyed by the acting seat and compared on content, so an unasked-for topic must
                     MISMATCH -- on this row and on every other.
      -Refuse        refuse, on stderr, with a non-zero exit. The row must report a difference,
                     and `exit` must be among the fields it names.

    IT DELEGATES TO THE REAL POWERSHELL HELPER ON PURPOSE. The stub is not a second implementation
    of `library init` -- it is a second PROCESS producing an outcome in a second workspace. What is
    under test here is the harness: its fixture isolation, its normalisation and its comparison.
    Nothing about the Library is proven by this file, and nothing about it should be claimed.

    THIS IS A TEST DOUBLE AND IT IS DECLARED `test` IN tools/_helpers.json. It must never be
    allowlisted, and no helper may call it.
#>
[CmdletBinding()]
param(
    [switch]$Divergent,
    [switch]$NotebookOnly,
    [switch]$Refuse,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Command = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Refuse) {
    [Console]::Error.WriteLine('the stub kernel refused, on purpose')
    exit 3
}

$arguments = @($Command)
if (-not $arguments.Count) {
    [Console]::Error.WriteLine('the stub kernel was given no command')
    exit 2
}

$verb = [string]$arguments[0]
if ($verb -cne 'init') {
    # NAMED RATHER THAN IGNORED. A stub that silently exited 0 on a command it does not implement
    # would make every row it was pointed at compare green against nothing.
    [Console]::Error.WriteLine("the stub kernel implements only 'init'; it was asked for '$verb'")
    exit 2
}

# The kernel's command line is `init <workspace> --registry-root <path> [--collection-id <id>]
# [--force] --json`, which is the shape tools/acceptance-matrix.json declares for this row.
$workspace = ''
$registryRoot = ''
$collectionId = ''
$force = $false
for ($i = 1; $i -lt $arguments.Count; $i++) {
    $argument = [string]$arguments[$i]
    switch -CaseSensitive ($argument) {
        '--registry-root' { $i++; if ($i -lt $arguments.Count) { $registryRoot = [string]$arguments[$i] }; continue }
        '--collection-id' { $i++; if ($i -lt $arguments.Count) { $collectionId = [string]$arguments[$i] }; continue }
        '--force' { $force = $true; continue }
        '--json' { continue }
        default {
            if ($argument.StartsWith('--')) { continue }
            if ([string]::IsNullOrWhiteSpace($workspace)) { $workspace = $argument }
        }
    }
}

if ([string]::IsNullOrWhiteSpace($workspace)) {
    [Console]::Error.WriteLine('the stub kernel was given no workspace')
    exit 2
}

$initialiser = Join-Path $PSScriptRoot 'Initialize-LibraryWorkspace.ps1'
$initArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $initialiser, '-Path', $workspace)
if (-not [string]::IsNullOrWhiteSpace($registryRoot)) { $initArguments += @('-RegistryRoot', $registryRoot) }
if (-not [string]::IsNullOrWhiteSpace($collectionId)) { $initArguments += @('-CollectionId', $collectionId) }
if ($force) { $initArguments += '-Force' }
$initArguments += '-Json'

$output = & powershell.exe @initArguments 2>&1
$code = $LASTEXITCODE

if ($Divergent -and $code -eq 0) {
    # One extra file the PowerShell arm does not write, in a place no delta covers.
    [IO.File]::WriteAllText((Join-Path $workspace 'KERNEL-ONLY.md'), "# Written by the stub kernel`n", [Text.UTF8Encoding]::new($false))
}
if ($NotebookOnly -and $code -eq 0) {
    # One extra topic UNDER notebook/. No delta covers a topic the oracle did not write.
    $topic = Join-Path $workspace 'notebook/kernel-owned'
    New-Item -ItemType Directory -Path $topic -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $topic '_index.md'), "# Kernel-owned topic`n", [Text.UTF8Encoding]::new($false))
}

# STDOUT VERBATIM, not re-serialised. Re-rendering the helper's JSON here would compare this
# file's idea of the document against the helper's, which is a test of the stub.
$output | ForEach-Object { [Console]::Out.WriteLine([string]$_) }
exit $code
