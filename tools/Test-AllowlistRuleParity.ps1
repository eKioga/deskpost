<#
.SYNOPSIS
    One allowlist rule, two implementations, compared over one fixture.

.DESCRIPTION
    `tools/DeploymentScan.ps1` excuses a denied term only when an approved-attribution string
    covers the WHOLE match at that exact position. The mirror publishing job's server-side scanner
    (docs/mirror-publishing-job.md) approximates the same rule by DELETING every allowlisted string
    from the surface first and then grepping the residue. Those are two implementations of one rule
    and until this suite they had never been run against the same input.

    THE SHELL HALF IS EXTRACTED FROM THE DOCUMENT, NEVER RETYPED. A retyped copy tests the typing:
    it agrees with itself by construction and goes stale the moment the document is edited. The
    block is lifted between two markers that are asserted to occur exactly once each, and the
    extract is asserted to contain both halves of the rule, so a marker that moves fails loudly
    rather than silently yielding an empty scanner that flags nothing.

    WHAT IT PINS. Each case names the surface, the two term lists, and the answer BOTH
    implementations give. Where they disagree, the disagreement itself is the pinned value -- this
    suite exists to make the divergence visible and stable, not to hide it. A change to either
    implementation moves a pinned value and fails here.
#>
[CmdletBinding()]
param([switch]$SelfTest)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Failures = 0
function Assert([bool]$Condition, [string]$Message) {
    if ($Condition) { Write-Output "  ok   $Message" }
    else { Write-Output "  FAIL $Message"; $script:Failures++ }
}

# --- the shell half, lifted out of the design document -------------------------------------------
function Get-ServerScannerBlock {
    param([Parameter(Mandatory)][string]$DocPath)
    if (-not (Test-Path -LiteralPath $DocPath -PathType Leaf)) {
        throw "the mirror publishing job document is not at $DocPath; the server scanner cannot be extracted."
    }
    $lines = [IO.File]::ReadAllLines($DocPath, [Text.UTF8Encoding]::new($false))
    $startMarker = 'cp "$WORK/surface" "$WORK/residue"'
    $endMarker   = 'OBJECT_COUNT='
    $starts = @(0..($lines.Count - 1) | Where-Object { $lines[$_].TrimEnd() -ceq $startMarker })
    $ends   = @(0..($lines.Count - 1) | Where-Object { $lines[$_].StartsWith($endMarker) })
    if ($starts.Count -ne 1) { throw "the server scanner's start marker occurs $($starts.Count) time(s) in $DocPath; the extract would be ambiguous." }
    if ($ends.Count   -ne 1) { throw "the server scanner's end marker occurs $($ends.Count) time(s) in $DocPath; the extract would be ambiguous." }
    if ($ends[0] -le $starts[0]) { throw 'the server scanner markers are out of order in the document.' }

    $cr = [string][char]13
    # CR SURVIVES A CRLF DOCUMENT AND BREAKS bash WITH AN UNREADABLE ERROR, so it is stripped here
    # and the strip is asserted rather than assumed.
    $block = @($lines[$starts[0]..($ends[0] - 1)] | ForEach-Object { $_.Replace($cr, '') })
    if (@($block | Where-Object { $_.Contains($cr) }).Count) { throw 'the extracted scanner still carries CR; bash would reject it.' }
    # MATCHED LOOSELY ON PURPOSE. Pinning the exact flags here would make this structural guard fire
    # on any semantic change to the scanner and SHADOW the behavioural cases below, which are what
    # should catch it -- a guard that answers first reports "the extract is not the scanner" for what
    # is really a changed rule.
    if (-not @($block | Where-Object { $_ -match 'grep\s+-q' }).Count) {
        throw 'the extracted scanner contains no deny-grep; the extract is not the scanner.'
    }
    if (-not @($block | Where-Object { $_ -match 'sed' }).Count) {
        throw 'the extracted scanner contains no allowlist removal; the extract is not the scanner.'
    }
    # RETURNED BARE, because every caller wraps in @(). A `, $block` return here would nest the
    # array inside a one-element array, and binding that to [string[]] joins all ten lines into one
    # with $OFS -- which produced a bash syntax error pointing at line 2 of a file whose line 2 was
    # correct. The comma form and @() at the call site are mutually exclusive; this picks @().
    $block
}

function Invoke-ServerScanner {
    param(
        # AllowEmptyString: the extracted scanner has blank lines in it, and Mandatory rejects an
        # empty element without it.
        [Parameter(Mandatory)][AllowEmptyString()][string[]]$Block,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Surface,
        [AllowEmptyCollection()][string[]]$DenyTerms = @(),
        [AllowEmptyCollection()][string[]]$AllowTerms = @(),
        [Parameter(Mandatory)][string]$BashPath
    )
    $work = Join-Path ([IO.Path]::GetTempPath()) ('allowparity-' + [Guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $work -Force)
    try {
        $lf = [string][char]10
        $utf8 = [Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText((Join-Path $work 'surface'), $Surface, $utf8)
        [IO.File]::WriteAllText((Join-Path $work 'allow'), (@($AllowTerms) -join $lf) + $lf, $utf8)
        [IO.File]::WriteAllText((Join-Path $work 'deny'),  (@($DenyTerms)  -join $lf) + $lf, $utf8)

        # C:\foo\bar -> /c/foo/bar, which is what this machine's bash understands.
        $posix = $work.Replace('\', '/')
        if ($posix -match '^([A-Za-z]):(.*)$') { $posix = '/' + $Matches[1].ToLower() + $Matches[2] }

        $script = @("WORK='$posix'") + $Block + @('echo "PARITY_HITS=$HITS"')
        $scriptPath = Join-Path $work 'run.sh'
        [IO.File]::WriteAllText($scriptPath, (@($script) -join $lf) + $lf, $utf8)

        # bash IS HANDED THE POSIX PATH, not the Windows one: a backslash path reaches bash as an
        # escape sequence and arrives with every separator eaten.
        $out = & $BashPath "$posix/run.sh" 2>&1
        $line = @($out | Where-Object { "$_" -match '^PARITY_HITS=' }) | Select-Object -Last 1
        if (-not $line) { throw "the server scanner produced no PARITY_HITS line. Output: $(@($out) -join ' | ')" }
        [int](("$line" -split '=')[1])
    }
    finally { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

# --- which bash, and PROVING it can see the disk ---------------------------------------------------
#
# `Get-Command bash` on this machine answers the WindowsApps WSL launcher, whose filesystem view is
# not this one: it reports "No such file or directory" for a script that demonstrably exists. A
# suite that took the first bash on PATH would have reported a broken extract rather than a wrong
# interpreter. So a candidate is not accepted for being present -- it is accepted for round-tripping
# a file this function just wrote, which is the only property the scanner actually needs.
function Resolve-ParityBash {
    $candidates = [Collections.Generic.List[string]]::new()
    foreach ($p in @(
            (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
            (Join-Path $env:ProgramFiles 'Git\usr\bin\bash.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'))) {
        if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) { [void]$candidates.Add($p) }
    }
    foreach ($c in @(Get-Command bash -All -ErrorAction SilentlyContinue)) {
        if ($c.Source -and $candidates -notcontains $c.Source) { [void]$candidates.Add([string]$c.Source) }
    }
    if (-not $candidates.Count) {
        throw 'no bash was found, so the document''s scanner cannot be run. This suite compares two real implementations and will not substitute a lookalike for either.'
    }

    $probeDir = Join-Path ([IO.Path]::GetTempPath()) ('allowparity-probe-' + [Guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $probeDir -Force)
    try {
        $token = [Guid]::NewGuid().ToString('N')
        [IO.File]::WriteAllText((Join-Path $probeDir 'probe.txt'), $token, [Text.UTF8Encoding]::new($false))
        $posix = $probeDir.Replace('\', '/')
        if ($posix -match '^([A-Za-z]):(.*)$') { $posix = '/' + $Matches[1].ToLower() + $Matches[2] }
        $rejected = [Collections.Generic.List[string]]::new()
        foreach ($candidate in $candidates) {
            $seen = & $candidate -c "cat '$posix/probe.txt' 2>/dev/null" 2>&1
            if ("$seen".Trim() -ceq $token) { return $candidate }
            [void]$rejected.Add((Split-Path -Leaf $candidate) + ' at ' + $candidate)
        }
        throw ('no bash on this machine can read a file written by this process, so the scanner cannot be run against a fixture. Tried: ' +
            ($rejected -join '; '))
    }
    finally { Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue }
}

# --- the cases ------------------------------------------------------------------------------------
# Each names what the rule is supposed to do, then both answers. `local` is the number of hits
# tools/DeploymentScan.ps1 raises; `server` is the HITS the document's scanner raises, which counts
# ONCE PER DENIED TERM rather than once per occurrence -- itself a divergence, and pinned as one.
#
# THE FIXTURE IDENTITY IS INVENTED, AND THAT IS NOT FASTIDIOUSNESS. This file is a tracked product
# file, so it is one of the blobs `public.identity-scan` reads out of the index. An earlier draft
# used the reader's real name and home path as fixture data and the scan refused the commit, quite
# correctly: what a suite writes ABOUT the guard still passes THROUGH the guard. The rule under test
# is about attribution in general, so a made-up name exercises it exactly as well, and the fix is a
# placeholder rather than an allowlist exemption -- an exemption would have taught the scan to
# ignore the very string it exists to catch.
$script:Cases = @(
    @{ name = 'approved attribution is excused by both'
       surface = 'Written by Ashby Vale, 2026.'; deny = @('Ashby'); allow = @('Ashby Vale')
       local = 0; server = 0; agree = $true }

    @{ name = 'a bare name in a home directory is caught by both'
       surface = 'path D:\home\Ashby\AppData\Roaming'; deny = @('Ashby'); allow = @('Ashby Vale')
       local = 1; server = 1; agree = $true }

    @{ name = 'DECOY: a denied term that is a strict substring of an allowlisted string, occurring independently'
       surface = 'Ashby Vale wrote it. The Vale office is elsewhere.'; deny = @('Vale'); allow = @('Ashby Vale')
       local = 1; server = 1; agree = $true }

    @{ name = 'DIVERGENCE 1: the allowlist removal is case-sensitive, the local containment is not'
       surface = 'written by ashby vale'; deny = @('Ashby'); allow = @('Ashby Vale')
       local = 0; server = 1; agree = $false }

    @{ name = 'DIVERGENCE 2: deleting an allowlisted string SPLICES a denied term that was never there'
       surface = 'AsXXhby'; deny = @('Ashby'); allow = @('XX')
       local = 0; server = 1; agree = $false }

    @{ name = 'the local scan counts occurrences where the server counts terms (same verdict, different value)'
       surface = 'Ashby here and Ashby there and Ashby again'; deny = @('Ashby'); allow = @()
       local = 3; server = 1; agree = $true }

    @{ name = 'an empty allowlist excuses nothing in either'
       surface = 'Written by Ashby Vale, 2026.'; deny = @('Ashby'); allow = @()
       local = 1; server = 1; agree = $true }

    # A SHARED BLIND SPOT, pinned so that fixing one implementation does not quietly leave it in the
    # other. An allowlisted string that occurs as a SUBSTRING of ordinary text takes the denied term
    # inside it out of scope in both implementations: the server deletes it, and the local scan finds
    # a covering span at the exact position. Both answer clean on text that is not attribution at all.
    @{ name = 'SHARED GAP: an allowlisted string occurring inside an unrelated word excuses the denied term in BOTH'
       surface = 'the Ashby Valeting Service depot'; deny = @('Vale'); allow = @('Ashby Vale')
       local = 0; server = 0; agree = $true }
)

function Invoke-AllowlistRuleParity {
    $root = Split-Path -Parent $PSScriptRoot
    . (Join-Path $PSScriptRoot 'DeploymentScan.ps1')

    $bash = Resolve-ParityBash

    $doc = Join-Path $root 'docs/mirror-publishing-job.md'
    $block = @(Get-ServerScannerBlock -DocPath $doc)
    Write-Output "extracted $($block.Count) line(s) of server scanner from docs/mirror-publishing-job.md"
    Write-Output ''

    $divergences = 0
    foreach ($case in $script:Cases) {
        Write-Output ([string]$case.name)
        $sources = @([pscustomobject]@{ source = 'fixture'; text = [string]$case.surface })
        $localHits = @(Find-IdentityScanHits -Sources $sources -DenyTerms @($case.deny) -AllowTerms @($case.allow))
        $serverHits = Invoke-ServerScanner -Block $block -Surface ([string]$case.surface) `
            -DenyTerms @($case.deny) -AllowTerms @($case.allow) -BashPath $bash

        Assert ($localHits.Count -eq [int]$case.local)  "local  raises $([int]$case.local) hit(s) (got $($localHits.Count))"
        Assert ($serverHits      -eq [int]$case.server) "server raises $([int]$case.server) hit(s) (got $serverHits)"

        $flaggedLocal  = $localHits.Count -gt 0
        $flaggedServer = $serverHits -gt 0
        $actuallyAgree = ($flaggedLocal -eq $flaggedServer)
        Assert ($actuallyAgree -eq [bool]$case.agree) ("the two implementations " +
            $(if ([bool]$case.agree) { 'agree' } else { 'DISAGREE' }) + ' on whether to flag')
        if (-not $actuallyAgree) { $divergences++ }
        Write-Output ''
    }

    # THE TOTALS ARE ASSERTED FROM OUTSIDE THE LOOP, because a case silently dropped from the table
    # would take its own divergence out of the numerator and the denominator together and still
    # read clean.
    Assert ($script:Cases.Count -eq 8) "the fixture table still holds 8 cases (got $($script:Cases.Count))"
    Assert ($divergences -eq 2) "exactly 2 cases disagree on WHETHER to flag (got $divergences)"

    if ($script:Failures) { throw "$($script:Failures) parity assertion(s) failed" }
    Write-Output "passed: $($script:Cases.Count) cases, $divergences flag-level divergence(s) pinned between tools/DeploymentScan.ps1 and docs/mirror-publishing-job.md"
}

# Dot-sourcing this file must not run the suite: the functions above are what a diagnosis needs to
# call one at a time, and a file that runs itself on import cannot be inspected.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        # NOT CAPTURED INTO A VARIABLE. `$summary = Invoke-...` collects the whole success stream,
        # so a throw discarded every per-case line and left the operator with a bare count -- the
        # failing run hid exactly the detail it exists to produce.
        Invoke-AllowlistRuleParity
        exit 0
    }
    catch {
        Write-Output "FAILED: $($_.Exception.Message)"
        exit 1
    }
}
