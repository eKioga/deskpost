<#
.SYNOPSIS
    Generate the private `ops` repository's tree from docs/mirror-publishing-job.md.

.DESCRIPTION
    PLAN-public-release.md step 12, server half. The mirror publishing job's workflow and scanner
    are DESIGNED in the document and DEPLOYED in a separate private repository. That is two places
    for one rule, and this repository already knows what that costs: `tools/PluginPackage.ps1`
    exists because a Codex manifest and a Claude manifest hand-maintained side by side are a shape
    nobody can change. So the document stays canonical and this generates the tree from it.

    WHY IT MATTERS MORE HERE THAN FOR THE PLUGIN. `tools/Test-AllowlistRuleParity.ps1` pins the
    allowlist rule by extracting the shell half FROM THIS DOCUMENT between asserted-unique markers,
    and comparing it against `tools/DeploymentScan.ps1` over one fixture. That suite is only
    meaningful if the text it tests is the text that gets deployed. Hand-copying the scanner into
    an ops repo would leave the suite testing a document while a divergent copy ran the gate --
    the suite would stay green through exactly the drift it exists to catch.

    THE EXTRACTION IS ASSERTED, NEVER TRUSTED. Each block is located by a marker asserted to occur
    exactly once, and the extract is then asserted to CONTAIN the thing it is supposed to be. A
    marker that moves fails loudly here rather than writing a plausible, wrong file: an empty or
    truncated scanner would otherwise deploy as a gate that passes everything.

    CRLF IS A CORRECTNESS ISSUE, NOT A TIDINESS ONE. These files run under `sh` on Linux. A
    PowerShell here-string and `Set-Content` both produce CRLF on Windows by default, and `sh`
    rejects `#!/bin/sh\r`. Every file is written as UTF-8 WITHOUT a BOM and with LF endings, and
    the writer asserts both afterwards rather than trusting the call.

.PARAMETER Destination
    Where to write the tree. Defaults to output/library-dev/deskpost-ops.

.PARAMETER Preflight
    Report what would be written -- block sizes, target paths, assertions -- and write nothing.

.PARAMETER SelfTest
    Run the generator's own assertions against the live document and report, writing nothing.
#>

[CmdletBinding()]
param(
    [string]$Workspace,
    [string]$Destination,
    [switch]$Preflight,
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Workspace) { $Workspace = Split-Path -Parent $PSScriptRoot }
$DocPath = Join-Path $Workspace 'docs/mirror-publishing-job.md'

function Get-FencedBlock {
    <#
        Lift one fenced code block from the document: the one whose body contains $Contains.
        The fence language must match $Language, and exactly one block may match -- two would
        make the choice silent and arbitrary.
    #>
    param(
        [string[]]$Lines,
        [Parameter(Mandatory)][string]$Language,
        [Parameter(Mandatory)][string]$Contains,
        [Parameter(Mandatory)][string]$What
    )

    $blocks = @()
    $open = $false
    $start = -1
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $line = $Lines[$i].TrimEnd()
        if (-not $open -and $line -ceq ('```' + $Language)) {
            $open = $true; $start = $i + 1; continue
        }
        if ($open -and $line -ceq '```') {
            $open = $false
            if ($i -gt $start) { $blocks += , @($Lines[$start..($i - 1)]) }
            continue
        }
    }
    if ($open) { throw "the $What block's fence is never closed in $DocPath." }

    $matching = @($blocks | Where-Object { ($_ -join "`n").Contains($Contains) })
    if ($matching.Count -ne 1) {
        throw ("the $What could not be identified in {0}: {1} fenced ``{2}`` block(s) contain '{3}', expected exactly 1." -f `
               $DocPath, $matching.Count, $Language, $Contains)
    }
    , $matching[0]
}

function Assert-Extract {
    param([string[]]$Block, [string]$What, [hashtable]$MustContain)
    $text = $Block -join "`n"
    foreach ($label in $MustContain.Keys) {
        if (-not $text.Contains($MustContain[$label])) {
            throw "the extracted $What is missing $label ('$($MustContain[$label])'); the extract is not the $What."
        }
    }
    $cr = [char]13
    if (@($Block | Where-Object { $_.Contains($cr) }).Count) {
        throw "the extracted $What still carries CR; sh would reject it."
    }
}

function Write-LfFile {
    <#
        UTF-8, no BOM, LF endings -- then read the bytes back and assert both, because this is the
        one property of these files that breaks them silently on the far side.
    #>
    param([string]$Path, [string[]]$Lines)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $text = ($Lines -join "`n") + "`n"
    [IO.File]::WriteAllText($Path, $text, [Text.UTF8Encoding]::new($false))

    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        throw "wrote a BOM into $Path; sh would reject the shebang."
    }
    if ($bytes -contains 13) { throw "wrote CR into $Path; sh would reject it." }
    [pscustomobject]@{ path = $Path; bytes = $bytes.Length; lines = $Lines.Count }
}

# --- read the document ------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $DocPath)) {
    throw "the mirror publishing job document is not at $DocPath; the ops repository cannot be generated."
}
$lines = [IO.File]::ReadAllLines($DocPath)

$workflow = Get-FencedBlock -Lines $lines -Language 'yaml' -Contains 'name: publish-mirror' -What 'workflow'
$scanner  = Get-FencedBlock -Lines $lines -Language 'sh'   -Contains 'cp "$WORK/surface" "$WORK/residue"' -What 'scanner'

# The workflow must carry the MEASURED runner form. `self-hosted` matches no runner on this
# instance and an unmatched job queues forever, so shipping it is worse than failing here.
Assert-Extract -Block $workflow -What 'workflow' -MustContain @{
    'its name'            = 'name: publish-mirror'
    'the runner label'    = 'runs-on: docker'
    'the container image' = 'catthehacker/ubuntu:act-latest'
    'the concurrency group' = 'group: publish-mirror'
    'the scanner call'    = './scan-and-publish.sh'
}
if (($workflow -join "`n").Contains('runs-on: self-hosted')) {
    throw 'the workflow still declares `runs-on: self-hosted`, which matches no runner on this instance; the job would queue forever.'
}

# NO REPOSITORY URL MAY BE A LITERAL IN THE WORKFLOW, and this refuses both ways it goes wrong.
#
# A REAL hostname here would ship the instance's name in the public tree, which the identity scan
# exists to prevent. A PLACEHOLDER hostname is what actually happened: `SOURCE_REPO` and
# `TARGET_REPO` carried `forgejo.example.invalid` as literals, so the deployed job would have cloned
# a host that does not resolve and died on its first command. Both are the same defect -- a URL
# written where a reference belongs -- and a dry run of the SCANNER cannot catch either, because the
# scanner reads these from the environment and the environment is the broken half.
foreach ($line in $workflow) {
    if ($line -match '^\s*(SOURCE_REPO|TARGET_REPO)\s*:\s*(\S.*)$') {
        $key, $value = $Matches[1], $Matches[2].Trim()
        if ($value -notmatch '^\$\{\{\s*secrets\.') {
            throw ("the workflow sets $key to a literal ('$value') rather than a secret reference. " +
                   'A real hostname would ship the instance name in the public tree; a placeholder ' +
                   'one makes the deployed job clone a host that does not resolve. Use ${{ secrets.' + $key + ' }}.')
        }
    }
}

# THE SCANNER IS INVOKED THROUGH `sh`, AND A BARE `./` CALL IS REFUSED.
#
# This generator runs on Windows, which has no executable bit to set, so every push of the scanner
# records git mode 100644 -- confirmed by reading the deployed tree, not inferred. A bare
# `./scan-and-publish.sh` then dies with "Permission denied" and exit code 126, which is exactly how
# all three scheduled runs failed on 2026-09-20, AFTER checkout and the tool assertion had both
# passed. Chmod-ing the deployed blob would fix one push and regress silently on the next
# regeneration, so the dependency on the bit is removed rather than patched. The scanner's own
# shebang is `#!/bin/sh`, and it is POSIX-clean, so `sh` is what it asks for.
$scannerCall = @($workflow | Where-Object { $_ -match 'scan-and-publish\.sh' -and $_ -match '^\s*run\s*:' })
if ($scannerCall.Count -ne 1) {
    throw ('the workflow invokes the scanner on ' + $scannerCall.Count + ' run: line(s), expected exactly 1.')
}
if ($scannerCall[0] -notmatch '^\s*run\s*:\s*sh\s+\./scan-and-publish\.sh\s*$') {
    throw ("the workflow invokes the scanner as '" + $scannerCall[0].Trim() + "' rather than 'run: sh ./scan-and-publish.sh'. " +
           'This generator cannot set an executable bit on Windows, so the pushed blob is mode 100644 and a bare ./ call ' +
           'fails with exit code 126 before the scanner runs at all.')
}

$scannerMustContain = @{
    'its shebang'              = '#!/bin/sh'
    'the allowlist removal'    = 'cp "$WORK/surface" "$WORK/residue"'
    'the deny-grep'            = 'grep -qiF --'
    'the empty-denylist guard' = 'FATAL: the denylist is empty'
    'the snapshot clone'       = 'git clone --mirror'
    'the per-ref push'         = 'git push --force'
    # Added 2026-09-20 after run #4. The job creates git objects of its own -- a published-state note
    # and an attestation commit -- and the container has no git identity, so without these two the
    # notes ref is never created and the run dies pushing a refspec that does not exist.
    'the mirror identity'      = 'GIT_COMMITTER_EMAIL'
    # The attestation was computed on both paths and uploaded on neither, so "publishes a sanitised
    # attestation" was contract text with no implementation behind it.
    'the attestation publish'  = 'publish_attestation'
}
Assert-Extract -Block $scanner -What 'scanner' -MustContain $scannerMustContain

$targets = @(
    @{ path = '.forgejo/workflows/publish.yml'; block = $workflow; what = 'workflow' }
    @{ path = 'scan-and-publish.sh';            block = $scanner;  what = 'scanner'  }
)

if (-not $Destination) { $Destination = Join-Path $Workspace 'output/library-dev/deskpost-ops' }

# WHETHER THIS JOB RUNS ON A TIMER IS REPORTED, NEVER ASSERTED. A cron makes the
# first run automatic, and the first successful run of this job is the first
# public release. That is a decision the reader makes, so this refuses nothing --
# but it must never change silently, because the difference between "publishes
# when someone clicks" and "publishes within ten minutes" is invisible in a diff
# of a generated file nobody reads.
$scheduled = @($workflow | Where-Object { $_ -match '^\s*schedule\s*:' -and $_ -notmatch '^\s*#' }).Count -gt 0
$triggerNote = if ($scheduled) {
    'SCHEDULED -- a cron is present, so the mirror publishes automatically'
} else {
    'manual only (workflow_dispatch) -- nothing publishes until someone runs it'
}

if ($SelfTest) {
    Write-Output "self-test: docs/mirror-publishing-job.md"
    Write-Output ("  workflow block : {0} line(s), runs-on measured, no 'self-hosted'" -f $workflow.Count)
    # DERIVED, NEVER TYPED. This line read "all six assertions hold" as a literal, which went wrong
    # the first time an assertion was added -- a count that describes a list has to come from the
    # list, or it becomes a confident statement about something else.
    Write-Output ("  scanner block  : {0} line(s), all {1} assertion(s) hold" -f $scanner.Count, $scannerMustContain.Count)
    Write-Output ("  trigger        : {0}" -f $triggerNote)
    Write-Output "PASS -- both blocks extract unambiguously and contain what they claim."
    return
}

if ($Preflight) {
    [pscustomobject]@{
        operation   = 'Export mirror ops repository (preflight)'
        source      = $DocPath
        destination = $Destination
        files       = @($targets | ForEach-Object {
            [pscustomobject]@{ path = $_.path; lines = $_.block.Count }
        })
        note        = 'Nothing written. Re-run without -Preflight to generate.'
    }
    return
}

$written = foreach ($t in $targets) {
    Write-LfFile -Path (Join-Path $Destination $t.path) -Lines $t.block
}

[pscustomobject]@{
    operation   = 'Export mirror ops repository'
    source      = $DocPath
    destination = $Destination
    trigger     = $triggerNote
    files       = @($written)
}
