<#
.SYNOPSIS
    Scan every product working file for a deployment fact that must not ship, and refuse on a hit.

.DESCRIPTION
    WHY A SCAN RATHER THAN A LIST. Step 11 of PLAN-public-release.md removed the Basic Memory
    endpoint from fourteen tracked files, the share roots from one, and the collection id from
    seventeen. An inventory of those thirty-two is worthless the moment the thirty-third appears,
    and it would have been wrong when it was written: the plan said nine files carried the
    collection id and the real figure on 2026-09-19 was seventeen. So nothing here counts
    anything. It asks one question of every product file -- does this say where Eric's collection
    lives? -- and fails on any answer.

    TWO DETECTORS, BECAUSE NEITHER ALONE IS ENOUGH.

    The first is exact and self-maintaining: whatever deployment THIS workspace is configured with
    must appear in no product file. The values come from the generated state under `.claude/`,
    which is gitignored, so the denylist is never itself a deployment default and never needs
    editing. This catches the case that actually happens -- someone pastes their working endpoint
    back into a helper to make it run.

    The second is structural, and it exists because the first goes vacuous on a fresh clone with
    nothing configured. It recognises the SHAPE of a deployment regardless of whose it is: an
    absolute MCP endpoint, and a collection path under a UNC root or a mapped drive. A reader who
    contributes their own NAS address is caught by it even though this workspace has never heard
    of that address.

    WHAT IS DELIBERATELY OUT OF SCOPE, and why each is not a hole:

      - Gitignored workspace state. The generated endpoint, collection id and share root ARE the
        deployment; they are where it is supposed to live. So is `.claude/hooks/.capture/`, which
        holds raw hook payloads carrying the reader's own paths while it exists, and so is every
        directory of reader material.
      - `PLAN*.md` and `PLAN-REVIEW-LOG-*.md`. Private design records that step 14's allowlist
        never exports; they quote the endpoint precisely because they are the record of removing
        it, and editing them would falsify the record.

    `output/` USED TO BE A CATEGORY HERE AND IS NOT ANY MORE. Step 13 untracked it on 2026-09-19,
    so `git ls-files` no longer returns it and the exclusion stopped doing anything -- except in
    the one case that matters, where somebody re-adds `output/` to the index and the dead line
    silently waves it through. An exclusion that only fires on the mistake it was never meant to
    cover is worse than no exclusion, so it was deleted in the same pass. The fixture proves the
    replacement: it gitignores `output/` and asserts the file set omits it, which tests the
    untracking rather than a list here.

    WHEN THE EXPORT TOOL LANDS, IT FEEDS THIS. The plan's scope is "tracked files plus anything
    step 14's allowlist would export". Today those are the same set, because the only untracked
    things are generated state and reader material and the allowlist exports neither. When
    tools/Export-PublicTree.ps1 arrives in S7 its allowlist becomes a second source for
    Get-DeploymentScanFiles, so a path it adds is scanned the day it is added rather than the day
    someone remembers this file.

    `.claude/hooks/payload-contract.json` is tracked and IS scanned. It is a captured sample of a
    boundary this tree does not control, which is exactly the kind of file that carries a real
    path by accident.

    DOCUMENTATION PLACEHOLDERS ARE NOT DEPLOYMENTS. `example.invalid`, `.example`, `localhost`,
    the RFC 5737 documentation address ranges and a `\\nas\share\...` style illustration are
    allowed by name, because a scan that flagged them would be answered by deleting the examples
    -- and the examples are how a refusal explains itself. Every allowance is a literal in one
    list below, so widening it is visible in a diff.

    Dot-sourced. Declared `internal` in tools/_helpers.json and deliberately not allowlisted.
#>

Set-StrictMode -Version Latest

# Step 14's export allowlist, which is the second source for the file set below. Dot-sourced at
# file scope so its lists land in this module rather than inside whichever function asked first.
# The dependency runs one way only: the allowlist knows nothing about the scans.
. (Join-Path $PSScriptRoot 'PublicTreeAllowlist.ps1')

# Hosts and address ranges that are reserved for documentation or are purely local, so naming one
# states nothing about anybody's network. RFC 2606 for the names, RFC 5737 for the addresses.
$script:DeploymentScanAllowedHostPatterns = @(
    '^localhost$',
    '^127\.0\.0\.1$',
    '^\[::1\]$',
    '\.invalid$',
    '\.example$',
    '\.example\.(com|net|org)$',
    '^192\.0\.2\.\d{1,3}$',
    '^198\.51\.100\.\d{1,3}$',
    '^203\.0\.113\.\d{1,3}$'
)

# The same idea for a path illustration: a share root spelled with a placeholder host or a
# placeholder first segment is teaching a reader the shape, not naming a machine.
$script:DeploymentScanAllowedPathSegments = @('nas', 'share', 'example', 'fixture', 'server', 'host')

# Product files this scan never reads. Each is a category the plan names, not an inventory of
# known hits -- an inventory would pass the day a new file appeared.
$script:DeploymentScanExcludedPathPatterns = @(
    '^PLAN[^/]*\.md$',
    '^codex-verdict\.txt$',
    '(^|/)settings\.local\.json$'
)

function Test-DeploymentScanHostAllowed([string]$HostName) {
    if ([string]::IsNullOrWhiteSpace($HostName)) { return $true }
    foreach ($pattern in $script:DeploymentScanAllowedHostPatterns) {
        if ($HostName -imatch $pattern) { return $true }
    }
    $false
}

function Test-DeploymentScanPathAllowed([string]$PathText) {
    # A UNC host or a drive-rooted path's first segment. Either one spelled as a placeholder makes
    # the whole path an illustration.
    $segments = @($PathText -split '[\\/]+' | Where-Object { $_ -ne '' -and $_ -cnotmatch '^[A-Za-z]:$' })
    if (-not $segments.Count) { return $true }
    $segments[0] -iin $script:DeploymentScanAllowedPathSegments
}

function Get-DeploymentScanFiles {
    <#
        Every product working file: what git tracks AND what step 14's allowlist would export, less
        the categories above. Derived from git and from the allowlist rather than from a list here,
        so a file added tomorrow is scanned tomorrow.

        TWO SOURCES, BECAUSE NEITHER IS THE WHOLE SET. `git ls-files` is what a commit publishes
        from THIS repository. The allowlist in tools/PublicTreeAllowlist.ps1 is what
        Export-PublicTree.ps1 copies into a brand new one, and it resolves against the FILESYSTEM --
        so a path a rule admits that git has never seen is scanned the day the rule is written
        rather than the day somebody remembers this file. That is the whole reason the union
        exists, and it is not hypothetical: an include root is a statement about a role, and files
        arrive under a role without passing through `git add` all the time.

        On 2026-09-19 the two sets were identical, because the only untracked things in this tree
        were generated state and reader material and the allowlist admits neither. The union is
        what keeps that a measured fact rather than an assumption that quietly expires.

        THE GIT HALF STILL THROWS ON AN EMPTY ANSWER, and the allowlist half cannot stand in for
        it. A resolver walking include roots returns a perfectly plausible file set inside a
        directory that is not a repository at all, which is exactly the shape of a scan that reads
        files and proves nothing.
    #>
    param([Parameter(Mandatory)][string]$Workspace)

    Push-Location -LiteralPath $Workspace
    try { $tracked = @(& git ls-files 2>$null) }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0 -or -not $tracked.Count) {
        throw 'git ls-files returned nothing, so this scan read no files rather than proving anything.'
    }

    # Assigned in a statement rather than built inside the pipeline below: an empty allowlist half
    # unrolls to $null in an expression, and `$tracked + $null` is a silently shorter list.
    $exportable = @(Get-PublicTreeFiles -Workspace $Workspace)
    $combined = @($tracked) + $exportable

    @($combined | Sort-Object -Unique | Where-Object {
        $relative = [string]$_
        $excluded = $false
        foreach ($pattern in $script:DeploymentScanExcludedPathPatterns) {
            if ($relative -imatch $pattern) { $excluded = $true; break }
        }
        -not $excluded
    })
}

function Get-DeploymentScanDenylist {
    <#
        The exact values this workspace is configured with. Read straight from the generated state
        rather than through the resolver, because the resolver also consults the environment and a
        value that lives only in a shell variable is not what a product file could be leaking.

        Returns an empty list on an unconfigured workspace, which is correct and is precisely why
        the structural detector exists beside this one.
    #>
    param([Parameter(Mandatory)][string]$Workspace)

    $values = [Collections.Generic.List[string]]::new()
    foreach ($name in @('.library-mcp-url', '.library-project', '.library-shared-root')) {
        $path = Join-Path $Workspace (Join-Path '.claude' $name)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $value = ''
        try { $value = ([IO.File]::ReadAllText($path)).Trim() } catch { $value = '' }
        if ([string]::IsNullOrWhiteSpace($value)) { continue }
        [void]$values.Add($value)
        # The endpoint's bare host is the half that gets pasted into a comment, and the share
        # root's parent is what a second helper would reach for. Both are the same deployment.
        if ($value -cmatch '^https?://([^/:\s]+)') { [void]$values.Add($Matches[1]) }
    }
    @($values | Sort-Object -Unique)
}

function Get-DeploymentScanStructuralHits {
    <#
        The shape of a deployment, whoever owns it. Returns one record per match.
    #>
    param([Parameter(Mandatory)][string]$Text, [Parameter(Mandatory)][string]$Relative)

    $hits = [Collections.Generic.List[object]]::new()
    $lines = $Text -split "`r?`n"
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]

        # An absolute MCP endpoint. Narrowed to /mcp rather than any URL, because this tree is full
        # of documentation links and a scan that flagged those would be turned off within a day.
        foreach ($match in [regex]::Matches($line, '(?i)\bhttps?://([^/:\s"''`]+)(?::\d+)?/mcp\b')) {
            $endpointHost = $match.Groups[1].Value
            if (-not (Test-DeploymentScanHostAllowed $endpointHost)) {
                [void]$hits.Add([pscustomobject]@{ file = $Relative; line = $i + 1; kind = 'endpoint'; match = $match.Value })
            }
        }

        # A collection path under a UNC root or a mapped drive. Keyed on `basic-memory`, which is
        # the backend's own directory name and is what makes the path a COLLECTION path rather
        # than any old absolute path -- of which this tree legitimately has many.
        foreach ($match in [regex]::Matches($line, '(?i)(\\\\[^\s"''`]+|\b[A-Za-z]:[\\/][^\s"''`]*)basic-memory[^\s"''`]*')) {
            if (-not (Test-DeploymentScanPathAllowed $match.Value)) {
                [void]$hits.Add([pscustomobject]@{ file = $Relative; line = $i + 1; kind = 'share-root'; match = $match.Value })
            }
        }
    }
    @($hits)
}

function Find-DeploymentScanHits {
    <#
        Every hit across every product working file.

        -Denylist is taken rather than read so a caller can pass an EMPTY one: emptying the exact
        detector's match set is how the fixture proves the structural detector still matches
        something, and emptying both is how it proves the positives were real.
    #>
    param(
        [Parameter(Mandatory)][string]$Workspace,
        [string[]]$Files,
        [AllowEmptyCollection()][string[]]$Denylist,
        [switch]$SkipStructural
    )
    if ($null -eq $Files) { $Files = @(Get-DeploymentScanFiles -Workspace $Workspace) }
    $list = @($Denylist | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

    $hits = [Collections.Generic.List[object]]::new()
    foreach ($relative in $Files) {
        $full = Join-Path $Workspace $relative
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        $text = ''
        try { $text = [IO.File]::ReadAllText($full) }
        catch { continue }
        # A NUL byte means binary, and a binary file has no line to report. Skipped rather than
        # scanned so the result stays something a reader can open and check.
        if ($text.IndexOf([char]0) -ge 0) { continue }

        foreach ($value in $list) {
            $index = $text.IndexOf($value, [StringComparison]::OrdinalIgnoreCase)
            if ($index -lt 0) { continue }
            $line = 1 + @([regex]::Matches($text.Substring(0, $index), "`n")).Count
            [void]$hits.Add([pscustomobject]@{ file = $relative; line = $line; kind = 'configured'; match = $value })
        }
        if (-not $SkipStructural) {
            foreach ($hit in (Get-DeploymentScanStructuralHits -Text $text -Relative $relative)) { [void]$hits.Add($hit) }
        }
    }
    @($hits)
}

# ==================================================================================================
# THE IDENTITY SCAN -- the second scan in this file, and the reason its name is now half the story.
# ==================================================================================================
#
# PLAN-public-release.md step 12, local half. The scan above asks "does this file say where Eric's
# COLLECTION lives". This one asks "does this file say who Eric IS, or what his machines are
# called". They share everything that was worth sharing -- the exclusion categories, the
# documentation allowances, the hit record's shape -- and differ in the one thing that is the whole
# point of having two of them:
#
#     THE DEPLOYMENT SCAN READS THE WORKING TREE. THE IDENTITY SCAN READS THE INDEX.
#
# Every function below is named `...IdentityScan...` and reads through `git diff --cached` and
# `git cat-file blob :<path>`, never through the filesystem. That is not fussiness. A commit
# publishes the blobs in the index, and the working tree is a different set of bytes whenever
# someone stages a hunk, edits after staging, or stages a file and then reverts it. A scan of the
# working tree would have passed on the edit and published the blob. So the file set here is the
# paths this commit CHANGES (added, copied, modified, renamed) against HEAD -- the objects this
# commit creates. Everything else is already in history, which is the server-side gate's subject in
# step 12's other half, not this one's.
#
# THE DENYLIST IS NEVER IN A REPOSITORY. It lives at %USERPROFILE%\.library\identity-denylist.txt,
# because a file listing a reader's hostnames, addresses, share paths and private email is itself
# the leak it is meant to prevent -- and because it is per machine, which the plan states as a risk
# rather than papering over. gitleaks is the generic backstop for a machine that has no denylist,
# and the server-side scan is what depends on no client having either.
#
# THE ALLOWLIST IS THE ONLY EXCEPTION, and it exists because the author's name is supposed to ship.
# %USERPROFILE%\.library\identity-allowlist.txt holds the approved attribution -- the name and the
# email that will stand in the public commit history. A denylist hit is suppressed only when an
# allowlisted string covers it WHOLE at that exact position, which is what keeps `Eric` as approved
# attribution from also excusing `C:\Users\<you>\...`: the path match is longer than the name, so no
# occurrence of the name contains it.

# Git's empty tree. `git diff --cached HEAD` has no HEAD to name before the first commit, which is
# not an edge case here -- step 14 builds the public repository with `git init` and one commit, and
# that commit is exactly the one this scan most needs to read.
$script:IdentityScanEmptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

$script:IdentityScanDenylistFileName = 'identity-denylist.txt'
$script:IdentityScanAllowlistFileName = 'identity-allowlist.txt'

function Get-IdentityScanTermRoot {
    <#
        %USERPROFILE%\.library, resolved once here rather than at four call sites. $HOME is the
        fallback so the same code answers on a non-Windows checkout in Phase D instead of silently
        reading an empty path and reporting "no denylist" on a machine that has one.
    #>
    $base = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($base)) { $base = $HOME }
    if ([string]::IsNullOrWhiteSpace($base)) { return $null }
    Join-Path $base '.library'
}

function Read-IdentityScanTermFile {
    <#
        One term per line; `#` starts a comment; blank lines are skipped. Returns $null when the
        file is absent, which is a different answer from an empty list and is treated differently
        by the caller -- an absent denylist is a machine that never configured one, an empty
        denylist is a machine that decided it needs none.
    #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    # Named encoding at the boundary: a denylist may carry a non-ASCII hostname or surname, and the
    # default codepage would mangle it into a term that matches nothing.
    $lines = [IO.File]::ReadAllLines($Path, [Text.UTF8Encoding]::new($false))
    # Assigned in a statement rather than returned through a pipeline: an empty result unrolls to
    # $null on the way out, and $null is this function's "no such file" answer.
    $terms = @($lines | ForEach-Object {
        $line = [string]$_
        $hash = $line.IndexOf('#')
        if ($hash -ge 0) { $line = $line.Substring(0, $hash) }
        $line.Trim()
    } | Where-Object { $_ -ne '' })
    @($terms)
}

function Get-IdentityScanTerms {
    <#
        The denylist and the approved-attribution allowlist, with the paths they were read from so
        a refusal can name them.

        -TermRoot is taken rather than resolved so the fixture can point it at a temp directory. A
        suite that had to write into the reader's real %USERPROFILE%\.library to test the scan
        would be a suite nobody dares run.
    #>
    param([string]$TermRoot)
    if ([string]::IsNullOrWhiteSpace($TermRoot)) { $TermRoot = Get-IdentityScanTermRoot }
    $denyPath = ''
    $allowPath = ''
    if ($TermRoot) {
        $denyPath = Join-Path $TermRoot $script:IdentityScanDenylistFileName
        $allowPath = Join-Path $TermRoot $script:IdentityScanAllowlistFileName
    }
    $deny = Read-IdentityScanTermFile -Path $denyPath
    $allow = Read-IdentityScanTermFile -Path $allowPath
    [pscustomobject]@{
        root         = $TermRoot
        deny_path    = $denyPath
        allow_path   = $allowPath
        deny_present = ($null -ne $deny)
        deny         = @($deny)
        allow        = @($allow)
    }
}

function Invoke-IdentityScanGit {
    <#
        Run git and hand back its stdout as RAW BYTES.

        PowerShell 5.1 decodes a native command's stdout with the console output encoding, which
        turns a UTF-8 blob into mojibake and a NUL byte into something that is no longer a NUL --
        destroying both the terms this scan matches and the binary test that decides whether to
        match at all. So stdout is copied off the base stream and decoded here, by name.

        stderr is drained asynchronously because a synchronous read after stdout can deadlock: git
        blocks writing into a full stderr pipe while this end is still draining stdout.
    #>
    param([Parameter(Mandatory)][string]$Workspace, [Parameter(Mandatory)][string]$Arguments)

    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'git'
    $psi.Arguments = $Arguments
    $psi.WorkingDirectory = $Workspace
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $proc = [Diagnostics.Process]::Start($psi)
    try {
        $errTask = $proc.StandardError.ReadToEndAsync()
        $buffer = [IO.MemoryStream]::new()
        $proc.StandardOutput.BaseStream.CopyTo($buffer)
        $proc.WaitForExit()
        [pscustomobject]@{ exit_code = $proc.ExitCode; bytes = $buffer.ToArray(); stderr = [string]$errTask.Result }
    }
    finally { $proc.Dispose() }
}

function ConvertFrom-IdentityScanBytes {
    <#
        Bytes to text, UTF-8 first and ISO 8859-1 as the fallback. Both preserve ASCII exactly, and
        every term a denylist realistically carries is ASCII -- so a file in neither encoding still
        gets a faithful scan rather than a throw or a run of replacement characters.
    #>
    param([byte[]]$Bytes)
    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return '' }
    try { [Text.UTF8Encoding]::new($false, $true).GetString($Bytes) }
    catch { [Text.Encoding]::GetEncoding('iso-8859-1').GetString($Bytes) }
}

function Get-IdentityScanStagedPaths {
    <#
        The paths this commit changes, from the index, less the same categories the deployment scan
        excludes. `-z` because a path with a space or a non-ASCII character is quoted and escaped in
        git's default output and would arrive here as a path that does not exist.
    #>
    param([Parameter(Mandatory)][string]$Workspace)

    $head = Invoke-IdentityScanGit -Workspace $Workspace -Arguments 'rev-parse --verify --quiet HEAD'
    $base = $script:IdentityScanEmptyTree
    if ($head.exit_code -eq 0 -and $head.bytes.Length) { $base = 'HEAD' }

    $result = Invoke-IdentityScanGit -Workspace $Workspace -Arguments "diff --cached --name-only --diff-filter=ACMR -z $base"
    if ($result.exit_code -ne 0) {
        throw "git diff --cached failed, so this scan read no staged blobs rather than proving anything: $($result.stderr.Trim())"
    }
    $text = ConvertFrom-IdentityScanBytes $result.bytes
    $paths = @($text -split "`0" | Where-Object { $_ -ne '' } | Where-Object {
        $relative = [string]$_
        $excluded = $false
        foreach ($pattern in $script:DeploymentScanExcludedPathPatterns) {
            if ($relative -imatch $pattern) { $excluded = $true; break }
        }
        -not $excluded
    })
    @($paths)
}

function Get-IdentityScanStagedBlobs {
    <#
        The exact bytes of each staged path, read out of the index with `git cat-file blob :<path>`.
        `:<path>` is the index entry, which is what the commit will carry -- not the working tree
        file of the same name, which may differ.
    #>
    param([Parameter(Mandatory)][string]$Workspace, [string[]]$Paths)
    if ($null -eq $Paths) { $Paths = @(Get-IdentityScanStagedPaths -Workspace $Workspace) }

    $sources = [Collections.Generic.List[object]]::new()
    foreach ($relative in $Paths) {
        $result = Invoke-IdentityScanGit -Workspace $Workspace -Arguments ('cat-file blob ":{0}"' -f $relative)
        if ($result.exit_code -ne 0) {
            throw "git cat-file could not read the staged blob for $relative, so it was neither scanned nor reported clean: $($result.stderr.Trim())"
        }
        # A NUL byte means binary. Skipped rather than scanned, for the same reason the deployment
        # scan skips one: there is no line to name in a refusal.
        if ([Array]::IndexOf($result.bytes, [byte]0) -ge 0) { continue }
        [void]$sources.Add([pscustomobject]@{ source = $relative; text = (ConvertFrom-IdentityScanBytes $result.bytes) })
    }
    @($sources)
}

function Find-IdentityScanHits {
    <#
        Every denylisted term in every source, less the ones an approved-attribution string covers.

        -DenyTerms and -AllowTerms are taken rather than read, so the fixture can empty either set
        and watch the positives disappear -- the same falsification the deployment scan uses, and
        the only thing that proves a hit was the detector matching rather than the fixture agreeing
        with itself.
    #>
    param(
        [AllowEmptyCollection()][object[]]$Sources,
        [AllowEmptyCollection()][string[]]$DenyTerms,
        [AllowEmptyCollection()][string[]]$AllowTerms
    )
    $deny = @($DenyTerms | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $allow = @($AllowTerms | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $hits = [Collections.Generic.List[object]]::new()

    foreach ($entry in @($Sources)) {
        $text = [string]$entry.text
        if ([string]::IsNullOrEmpty($text)) { continue }

        # Where an approved-attribution string sits in this text, as spans. Computed once per
        # source rather than per hit: the allowlist is short and the text is not.
        $allowSpans = [Collections.Generic.List[object]]::new()
        foreach ($term in $allow) {
            $from = 0
            while ($true) {
                $at = $text.IndexOf($term, $from, [StringComparison]::OrdinalIgnoreCase)
                if ($at -lt 0) { break }
                [void]$allowSpans.Add([pscustomobject]@{ start = $at; end = $at + $term.Length })
                $from = $at + 1
            }
        }

        foreach ($term in $deny) {
            $from = 0
            while ($true) {
                $at = $text.IndexOf($term, $from, [StringComparison]::OrdinalIgnoreCase)
                if ($at -lt 0) { break }
                $from = $at + 1
                $end = $at + $term.Length
                # WHOLE containment, not overlap. An approved name that merely touches the match
                # excuses nothing: a bare name overlaps `C:\Users\<name>` and must not excuse it,
                # which is the difference between an allowlist and a hole.
                $covered = $false
                foreach ($span in $allowSpans) {
                    if ($span.start -le $at -and $span.end -ge $end) { $covered = $true; break }
                }
                if ($covered) { continue }
                $line = 1 + @([regex]::Matches($text.Substring(0, $at), "`n")).Count
                [void]$hits.Add([pscustomobject]@{ source = [string]$entry.source; line = $line; kind = 'identity'; match = $term })
            }
        }
    }
    @($hits)
}

function Invoke-IdentityScanGitleaks {
    <#
        The generic backstop for a machine with no denylist. Absence is reported, never assumed
        clean: "gitleaks is not installed" and "gitleaks found nothing" are different answers and a
        contributor deserves to know which one they got.
    #>
    param([Parameter(Mandatory)][string]$Workspace)
    $tool = Get-Command gitleaks -ErrorAction SilentlyContinue
    if (-not $tool) { return [pscustomobject]@{ ran = $false; clean = $false; detail = 'gitleaks is not installed, so nothing scanned the staged blobs on this machine' } }
    Push-Location -LiteralPath $Workspace
    try { $out = & $tool.Source 'protect' '--staged' '--no-banner' '--redact' 2>&1 }
    finally { Pop-Location }
    if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ran = $true; clean = $true; detail = 'gitleaks found nothing in the staged blobs' } }
    [pscustomobject]@{ ran = $true; clean = $false; detail = ('gitleaks reported a finding: ' + ((@($out) | Select-Object -Last 6) -join ' | ')) }
}

function Invoke-IdentityScan {
    <#
    .SYNOPSIS
        Scan the staged blobs, and optionally a commit message, for the reader's own identity.

    .DESCRIPTION
        Returns `status` of pass, warn or fail with a `detail` line, rather than throwing, so both
        callers can report it in their own idiom: `public.identity-scan` turns warn into the checks
        runner's WARN prefix, and the commit-msg hook turns fail into a non-zero exit.

        MODES. A maintainer machine keeps a denylist and its absence is a FAIL -- a check whose
        denylist nobody created has never matched anything, and would read green forever.
        LIBRARY_IDENTITY_SCAN=contributor downgrades that absence to a WARN and reaches for
        gitleaks instead, because a contributor cannot be expected to hold the maintainer's list,
        and the server-side gate in step 12's other half is what actually guarantees the boundary.
        A gitleaks FINDING still fails in either mode: that is evidence, not a missing list.
    #>
    param(
        [Parameter(Mandatory)][string]$Workspace,
        [string]$CommitMessageFile,
        [string]$TermRoot,
        [string]$Mode = $env:LIBRARY_IDENTITY_SCAN
    )

    $contributor = ($Mode -and $Mode.Trim().ToLowerInvariant() -eq 'contributor')
    $terms = Get-IdentityScanTerms -TermRoot $TermRoot

    $sources = [Collections.Generic.List[object]]::new()
    foreach ($blob in @(Get-IdentityScanStagedBlobs -Workspace $Workspace)) { [void]$sources.Add($blob) }
    $blobCount = $sources.Count
    if (-not [string]::IsNullOrWhiteSpace($CommitMessageFile)) {
        if (-not (Test-Path -LiteralPath $CommitMessageFile -PathType Leaf)) {
            return [pscustomobject]@{ status = 'fail'; detail = "The commit message file $CommitMessageFile does not exist, so the message was never scanned." }
        }
        [void]$sources.Add([pscustomobject]@{
            source = '<commit message>'
            text   = (ConvertFrom-IdentityScanBytes ([IO.File]::ReadAllBytes($CommitMessageFile)))
        })
    }
    $scope = "$blobCount staged blob(s)"
    if (-not [string]::IsNullOrWhiteSpace($CommitMessageFile)) { $scope += ' and the commit message' }

    if (-not $terms.deny_present) {
        $where = $terms.deny_path
        if ([string]::IsNullOrWhiteSpace($where)) { $where = '%USERPROFILE%\.library\identity-denylist.txt' }
        if (-not $contributor) {
            return [pscustomobject]@{ status = 'fail'; detail = (
                "No identity denylist at $where, so nothing scanned $scope. Create it -- one term per line, " +
                "a '#' starts a comment -- carrying this machine's hostnames, addresses, share paths, usernames " +
                "and private email, and put the approved attribution in $($terms.allow_path). On a machine that " +
                'is not the maintainer''s, set LIBRARY_IDENTITY_SCAN=contributor instead, which downgrades this ' +
                'to a warning and reaches for gitleaks.') }
        }
        $leaks = Invoke-IdentityScanGitleaks -Workspace $Workspace
        if ($leaks.ran -and -not $leaks.clean) {
            return [pscustomobject]@{ status = 'fail'; detail = "$($leaks.detail). Contributor mode has no denylist to fall back on, so this finding stands." }
        }
        return [pscustomobject]@{ status = 'warn'; detail = (
            "contributor mode, no denylist at $where; $($leaks.detail). $scope went unscanned against any " +
            'maintainer list; the server-side gate is what covers this boundary.') }
    }

    $hits = @(Find-IdentityScanHits -Sources @($sources) -DenyTerms $terms.deny -AllowTerms $terms.allow)
    if ($hits.Count) {
        $named = @($hits | ForEach-Object { "$($_.source):$($_.line) [$($_.match)]" } | Sort-Object -Unique)
        return [pscustomobject]@{ status = 'fail'; detail = (
            "$($hits.Count) identity hit(s) in the blobs this commit would publish: " + ($named -join '; ') +
            ". Remove the value or generalise it; if it is approved attribution, add it to $($terms.allow_path).") }
    }
    [pscustomobject]@{ status = 'pass'; detail = "$scope clean against $(@($terms.deny).Count) denylisted term(s) and $(@($terms.allow).Count) approved attribution(s)" }
}

function New-DeploymentScanFixture {
    <#
        A throwaway git repository carrying one file per case. A real repository, because
        Get-DeploymentScanFiles derives its file set from `git ls-files` and a fixture that fed it
        a list instead would prove the scanner works on input it never receives.
    #>
    $root = Join-Path ([IO.Path]::GetTempPath()) ('deployment-scan-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $root '.claude') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $root 'output') -Force | Out-Null
    $utf8 = [Text.UTF8Encoding]::new($false)
    $write = {
        param([string]$Relative, [string]$Body)
        $path = Join-Path $root $Relative
        $parent = Split-Path -Parent $path
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        [IO.File]::WriteAllText($path, $Body, $utf8)
    }

    # --- THE PLANTED DEPLOYMENT, COMPOSED RATHER THAN SPELLED -------------------------------------
    #
    # Two lessons are built into these lines, and both were paid for on 2026-09-19.
    #
    # FIRST, IT IS A FICTION. Until that day the fixture carried this workspace's real endpoint,
    # share root and subnet, because S5 wrote it out of the values it was scrubbing -- and step 12's
    # identity scan found them here on its first run, inside the one product file that exists to
    # stop exactly that. A fixture is product source. It ships. 10.42.x and Q:\ are in no
    # documentation range on purpose: a range the deployment scan allows by name would turn every
    # "must be caught" case below into a negative.
    #
    # SECOND, IT IS BUILT FROM PIECES. This file was untracked while S5 wrote it, so `git ls-files`
    # never offered it and the scanner had never read itself. The moment it was staged, the scan
    # failed on its own fixture -- correctly, because a planted endpoint spelled in full is
    # indistinguishable from a real one to a detector that reads source text. Concatenation is the
    # honest fix: the fixture FILES still receive contiguous literals, which is what the scan reads,
    # while this file carries none. A self-exemption was the other way to get a green run, and it
    # would have hidden a real default pasted in here forever.
    $fxHost        = '10.42.7.3'
    $fxEndpoint    = 'http://' + $fxHost + ':8000' + '/mcp'
    $fxEndpointDns = 'https://' + 'nas.lan' + ':8000' + '/mcp'
    $fxShareUnc    = '\\' + $fxHost + '\Backups' + '\basic-memory\knowledge\ai-library'
    $fxShareDrive  = 'Q:' + '\collection-store' + '\basic-memory\knowledge\ai-library'
    $fxCollection  = 'feedface-0000-4000-8000-feedfacefeed'

    # --- MUST BE CAUGHT -------------------------------------------------------------------------
    & $write 'tools/Bad-Endpoint.ps1'    ("if (`$null -eq `$McpUrl) { `$McpUrl = '" + $fxEndpoint + "' }`n")
    & $write 'tools/Bad-EndpointDns.ps1' ("`$url = '" + $fxEndpointDns + "'`n")
    & $write 'tools/Bad-ShareUnc.ps1'    ("`$root = '" + $fxShareUnc + "'`n")
    & $write 'tools/Bad-ShareDrive.ps1'  ("`$root = '" + $fxShareDrive + "'`n")
    & $write 'docs/bad-collection.md'    ("Always use project ID ``" + $fxCollection + "``.`n")

    # --- THE ALLOWLIST HALF OF THE FILE SET, which `git ls-files` cannot supply -------------------
    #
    # Untracked and gitignored, under an include root. git never offers it, so it reaches the
    # scanned set only if step 14's allowlist put it there. Without this one case the union in
    # Get-DeploymentScanFiles is indistinguishable from `git ls-files` alone on every other file in
    # this fixture -- a union that had silently stopped contributing would read green on all 46
    # checks that were here before it.
    & $write 'tools/Untracked-Endpoint.ps1' ("`$url = '" + $fxEndpoint + "'`n")

    # Under an include root and DENIED: a captured hook payload carrying the share root. The deny
    # patterns are the only thing standing between `.claude/hooks/` being product and
    # `.claude/hooks/.capture/` being the reader's own paths.
    & $write '.claude/hooks/.capture/payload.json' ("{ `"cwd`": `"" + $fxShareDrive + "`" }`n")

    # The generated Codex configuration beside its template. The template is product and ships; this
    # file is this machine's deployment and must not, which is why `.codex/` is two file rules
    # rather than one directory rule.
    & $write '.codex/config.toml' ("url = `"" + $fxEndpoint + "`"`n")

    # --- MUST NOT BE CAUGHT ---------------------------------------------------------------------
    # Documentation placeholders, local addresses, and the template token that replaced the URL.
    & $write 'tools/Good-Placeholders.ps1' @"
`$example = 'https://memory.example.invalid/mcp'
`$doc = 'http://192.0.2.10:8000/mcp'
`$local = 'http://localhost:8000/mcp'
`$illustration = '\\nas\share\basic-memory\...'
`$fixtureRoot = 'C:\fixture\collection'
"@
    & $write '.codex/config.template.toml' "url = `"__BASIC_MEMORY_URL__`"`n"
    # An ordinary absolute path with no collection in it, and an ordinary documentation link.
    & $write 'docs/good-ordinary.md' "The workspace is ``D:\Library`` and the spec is at https://example.invalid/docs/mcp-spec.`n"

    # --- MUST BE OUT OF SCOPE --------------------------------------------------------------------
    & $write 'PLAN-public-release.md'  ("The fallback was ``" + $fxEndpoint + "`` in fourteen files.`n")
    & $write '.claude/settings.local.json' ("{ `"url`": `"" + $fxEndpoint + "`" }`n")
    # `output/` is out of scope because it is UNTRACKED, not because a pattern names it -- step 13
    # untracked it and deleted the pattern in the same pass. Written and gitignored here so the
    # assertion below fails if the exclusion is ever restored as a way of getting a green run.
    & $write 'output/brief.md'         ("Endpoint: " + $fxEndpoint + "`n")

    # Generated state: the denylist's own source, and never tracked.
    [IO.File]::WriteAllText((Join-Path $root '.claude/.library-mcp-url'), ($fxEndpoint + "`n"), $utf8)
    [IO.File]::WriteAllText((Join-Path $root '.claude/.library-project'), ($fxCollection + "`n"), $utf8)
    [IO.File]::WriteAllText((Join-Path $root '.claude/.library-shared-root'), ($fxShareDrive + "`n"), $utf8)
    # The three untracked cases above are ignored here rather than merely left unstaged, because
    # `git add -A` in the base commit below would otherwise track them and the git half of the file
    # set would supply what the allowlist half is supposed to prove.
    [IO.File]::WriteAllText((Join-Path $root '.gitignore'), ".claude/.library-mcp-url`n.claude/.library-project`n.claude/.library-shared-root`noutput/`ntools/Untracked-Endpoint.ps1`n.claude/hooks/.capture/`n.codex/config.toml`n", $utf8)

    # --- A BASE COMMIT, so the identity scan has a HEAD to diff against ---------------------------
    # Without one, `git diff --cached` compares against the empty tree and EVERY tracked file reads
    # as added -- which is a real case (step 14's `git init` and one commit) and is covered by the
    # commit-message assertion below, but it cannot show that an unchanged file is left alone. So
    # the deployment cases are committed here, and the identity cases are staged on top of them.
    Push-Location -LiteralPath $root
    try {
        & git init --quiet 2>$null | Out-Null
        & git add -A 2>$null | Out-Null
        & git -c user.name='Fixture' -c user.email='fixture@example.invalid' commit --quiet -m 'base' 2>$null | Out-Null
    }
    finally { Pop-Location }

    # --- IDENTITY CASES, staged on top of that commit ---------------------------------------------
    # The terms live in $termRoot, never in the repository, which is the rule this scan exists to
    # keep. `Testuser` is on the denylist as a bare username and `Testuser Example` is on the
    # allowlist as approved attribution, because that pair is the whole allowlist rule in one line:
    # the same eight characters must ship in a byline and must not ship in a home directory.
    $termRoot = Join-Path ([IO.Path]::GetTempPath()) ('identity-scan-terms-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $termRoot -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $termRoot 'identity-denylist.txt'),
        "# fixture denylist`nTestuser`nC:\Users\Testuser`n10.42.7.3`n\\vault-host\collections`ntestuser@private.invalid`n", $utf8)
    # `Testuser` is on BOTH lists, which is not a mistake -- it is the real shape. The maintainer's
    # bare name is approved attribution and ships in a byline; the same eight characters inside
    # `C:\Users\Testuser` or `testuser@private.invalid` are a leak. That pair is the only thing that
    # distinguishes an allowlist span CONTAINING a hit from one merely OVERLAPPING it, and without
    # it both rules produce identical results on every case in this fixture -- which is how a scan
    # whose allowlist excuses anything it touches reads green.
    [IO.File]::WriteAllText((Join-Path $termRoot 'identity-allowlist.txt'),
        "# fixture approved attribution`nTestuser`nTestuser Example`ntestuser@public.example`n", $utf8)

    # MUST BE CAUGHT.
    & $write 'docs/identity-home.md'    "Measured in ``C:\Users\Testuser\.codex\config.toml`` on 2026-09-19.`n"
    & $write 'docs/identity-host.md'    "The runner answers at 10.42.7.3:8080 and the share is \\vault-host\collections.`n"
    # MUST NOT BE CAUGHT: approved attribution, and only approved attribution.
    & $write 'docs/identity-byline.md'  "Maintained by Testuser Example <testuser@public.example>.`n"
    # OUT OF SCOPE by the same exclusion the deployment scan uses -- the identity scan shares the
    # categories, not the file set.
    & $write 'PLAN-public-release.md'   ("The fallback was ``" + $fxEndpoint + "``, measured from C:\Users\Testuser.`n")
    # BINARY: the term is in there, and a file with no lines has no line to name in a refusal.
    [IO.File]::WriteAllBytes((Join-Path $root 'docs/identity-blob.bin'),
        ([byte[]]@(0, 1, 2) + $utf8.GetBytes('testuser@private.invalid')))
    # THE PAIR THAT PROVES WHICH BYTES ARE READ. Both are written, staged, and then overwritten in
    # the WORKING TREE only -- so the index and the file on disk disagree in both directions.
    & $write 'tools/Staged-Dirty.ps1'   "`$contact = 'testuser@private.invalid'`n"
    & $write 'tools/Worktree-Dirty.ps1' "`$contact = 'support@example.invalid'`n"

    Push-Location -LiteralPath $root
    try { & git add -A 2>$null | Out-Null }
    finally { Pop-Location }

    # AFTER staging: the working tree now says the opposite of the index in both files.
    & $write 'tools/Staged-Dirty.ps1'   "`$contact = 'support@example.invalid'`n"
    & $write 'tools/Worktree-Dirty.ps1' "`$contact = 'testuser@private.invalid'`n"

    [pscustomobject]@{ root = $root; term_root = $termRoot }
}

function Invoke-DeploymentScanSelfTest {
    $failures = [Collections.Generic.List[string]]::new()
    # The fixture owns one of these too. Declared here as well because the message cases below are
    # written by the suite rather than by the fixture, and an undefined $utf8 under StrictMode is a
    # non-terminating error that leaves the assertions after it silently unrun -- which is how a
    # suite reports a smaller number of checks and still says "passed".
    $utf8 = [Text.UTF8Encoding]::new($false)
    # Counted, never typed.
    $script:deploymentScanChecks = 0
    function Assert([bool]$Condition, [string]$Message) {
        $script:deploymentScanChecks++
        if (-not $Condition) { [void]$failures.Add($Message) }
    }

    $built = New-DeploymentScanFixture
    $fixture = $built.root
    $termRoot = $built.term_root
    try {
        $files = @(Get-DeploymentScanFiles -Workspace $fixture)
        $denylist = @(Get-DeploymentScanDenylist -Workspace $fixture)

        # The denylist is built from generated state, and that state is never in the scanned set.
        # Composed here for the same reason the fixture composes it: this file is scanned too.
        Assert ($denylist -ccontains ('http://' + '10.42.7.3' + ':8000' + '/mcp')) 'the denylist did not pick up the configured endpoint'
        Assert ($denylist -ccontains '10.42.7.3') 'the denylist did not derive the endpoint host'
        Assert ($denylist -ccontains 'feedface-0000-4000-8000-feedfacefeed') 'the denylist did not pick up the configured collection id'
        foreach ($state in @('.claude/.library-mcp-url', '.claude/.library-project', '.claude/.library-shared-root')) {
            Assert ($files -cnotcontains $state) "generated state $state was scanned; the denylist would flag its own source"
        }

        $hits = @(Find-DeploymentScanHits -Workspace $fixture -Files $files -Denylist $denylist)
        $hitFiles = @($hits | ForEach-Object { $_.file } | Sort-Object -Unique)

        # --- the positives, each named so a missing one is legible --------------------------------
        foreach ($expected in @('tools/Bad-Endpoint.ps1', 'tools/Bad-EndpointDns.ps1', 'tools/Bad-ShareUnc.ps1',
                                'tools/Bad-ShareDrive.ps1', 'docs/bad-collection.md')) {
            Assert ($hitFiles -ccontains $expected) "the scan missed the planted default in $expected"
        }
        # --- the negatives, which are what stop it firing on correct code -------------------------
        foreach ($clean in @('tools/Good-Placeholders.ps1', '.codex/config.template.toml', 'docs/good-ordinary.md')) {
            Assert ($hitFiles -cnotcontains $clean) "the scan flagged $clean, which carries only documentation placeholders"
        }
        # --- and the out-of-scope categories ------------------------------------------------------
        foreach ($outOfScope in @('PLAN-public-release.md', '.claude/settings.local.json')) {
            Assert ($hitFiles -cnotcontains $outOfScope) "$outOfScope is deliberately out of scope but was scanned"
        }
        # `output/` is out of scope by being untracked, which is a different mechanism and needs its
        # own assertion: the file set must omit it because git never offered it, not because a
        # pattern filtered it out. This fails the day someone restores the deleted exclusion and
        # tracks `output/` again -- the exact pair that would read green with the old line present.
        Assert ($files -cnotcontains 'output/brief.md') 'output/brief.md reached the scanned file set; it is gitignored, so git should never have offered it'
        Assert ($hitFiles -cnotcontains 'output/brief.md') 'the scan read output/brief.md, which is reader material and untracked'

        # --- THE TWO HALVES OF THE FILE SET, told apart ------------------------------------------
        #
        # Every other file in this fixture is both tracked AND under an include root, so the union
        # returns the same answer as `git ls-files` alone on all of them. These assertions are the
        # only ones that can see the allowlist half at all.
        Push-Location -LiteralPath $fixture
        try { $fixtureTracked = @(& git ls-files 2>$null) }
        finally { Pop-Location }
        Assert ($fixtureTracked -cnotcontains 'tools/Untracked-Endpoint.ps1') 'the fixture tracked the untracked case; the allowlist half is untested if git supplies it'
        Assert ($files -ccontains 'tools/Untracked-Endpoint.ps1') 'an untracked file under an include root never reached the scanned set; the allowlist is not a source for Get-DeploymentScanFiles'
        Assert ($hitFiles -ccontains 'tools/Untracked-Endpoint.ps1') 'the scan listed an untracked exportable file and then did not read it'

        # The allowlist resolved on its own, where a wrong answer cannot be masked by git.
        $exportable = @(Get-PublicTreeFiles -Workspace $fixture)
        Assert ($exportable -ccontains 'tools/Untracked-Endpoint.ps1') 'the allowlist resolver missed a file under an include root'
        Assert ($exportable -ccontains '.codex/config.template.toml') 'the allowlist resolver dropped a named product file'
        # A deny pattern beating an include root, which is the only reason deny patterns exist here.
        Assert ($exportable -cnotcontains '.claude/hooks/.capture/payload.json') 'a captured hook payload was exportable; .claude/hooks is an include root and .capture must not be'
        Assert ($files -cnotcontains '.claude/hooks/.capture/payload.json') 'a captured hook payload reached the scanned set through the allowlist half'
        # A file rule rather than a directory rule, which is why the generated Codex config stays home.
        Assert ($exportable -cnotcontains '.codex/config.toml') 'the generated Codex config was exportable; .codex must be named file by file, not as a directory'
        # And the allowlist must not reach reader material that the git half already refuses.
        Assert ($exportable -cnotcontains 'output/brief.md') 'reader material under output/ was exportable'
        Assert ($exportable -cnotcontains 'PLAN-public-release.md') 'a PLAN record was exportable'

        # FALSIFICATION of the deny list: empty it and the two suppressed files must appear. Without
        # this, "the rules never matched them" and "the deny patterns suppressed them" are the same
        # green, and a deny list that had stopped being consulted would read as a working one.
        $savedDeny = @($script:PublicTreeDenyPatterns)
        try {
            $script:PublicTreeDenyPatterns = @()
            $undenied = @(Get-PublicTreeFiles -Workspace $fixture)
            Assert ($undenied -ccontains '.claude/hooks/.capture/payload.json') 'with no deny patterns the captured payload was still absent, so a deny pattern was never what suppressed it'
        }
        finally { $script:PublicTreeDenyPatterns = $savedDeny }

        # Missing rules are reported, never thrown on: step 17 writes CONTRIBUTING.md after step 14
        # first names it, and a resolver that refused on its absence would deadlock the two steps.
        $missing = @(Get-PublicTreeMissingRules -Workspace $fixture)
        Assert ($missing -ccontains 'LICENSE') 'a rule naming a file that does not exist was not reported missing'
        Assert ($exportable.Count -gt 0) 'the allowlist resolved to nothing on a fixture that holds product files'

        # --- FALSIFICATION: empty the match set and watch the positives go green ------------------
        # A count cannot prove a detector still matches, because zero is legitimate somewhere. This
        # can: with no denylist and no structural patterns there is nothing left to match, so every
        # positive above MUST disappear. If any survived, it was never the detector finding them.
        $none = @(Find-DeploymentScanHits -Workspace $fixture -Files $files -Denylist @() -SkipStructural)
        Assert ($none.Count -eq 0) "emptying both detectors still produced $($none.Count) hit(s); the positives above were not the detectors matching"

        # Each detector alone, so neither is carried by the other. The exact detector cannot see a
        # DNS endpoint this workspace has never been configured with; the structural one cannot see
        # a bare collection id, which has no shape of its own.
        $exactOnly = @(Find-DeploymentScanHits -Workspace $fixture -Files $files -Denylist $denylist -SkipStructural)
        $exactFiles = @($exactOnly | ForEach-Object { $_.file } | Sort-Object -Unique)
        Assert ($exactFiles -ccontains 'docs/bad-collection.md') 'the exact detector missed the collection id, which nothing else can catch'
        Assert ($exactFiles -cnotcontains 'tools/Bad-EndpointDns.ps1') 'the exact detector claimed an endpoint this workspace was never configured with'
        $structuralOnly = @(Find-DeploymentScanHits -Workspace $fixture -Files $files -Denylist @())
        $structuralFiles = @($structuralOnly | ForEach-Object { $_.file } | Sort-Object -Unique)
        Assert ($structuralFiles -ccontains 'tools/Bad-EndpointDns.ps1') 'the structural detector missed an endpoint shape'
        Assert ($structuralFiles -cnotcontains 'docs/bad-collection.md') 'the structural detector claimed a bare GUID, which has no deployment shape'

        # ==========================================================================================
        # THE IDENTITY SCAN. Same fixture repository, different bytes: the index, not the tree.
        # ==========================================================================================
        $terms = Get-IdentityScanTerms -TermRoot $termRoot
        Assert ($terms.deny_present) 'the fixture denylist was not read; every identity assertion below would be vacuous'
        Assert ($terms.deny -ccontains 'Testuser') 'the fixture denylist lost its username term'
        Assert ($terms.allow -ccontains 'Testuser Example') 'the fixture allowlist lost its approved attribution'
        # The overlap pair, asserted rather than assumed: the same term on both lists is what makes
        # the containment rule testable, and a fixture that lost it would go green on an allowlist
        # that suppressed every hit it merely touched.
        Assert (($terms.deny -ccontains 'Testuser') -and ($terms.allow -ccontains 'Testuser')) 'the fixture lost the term that is on both lists; the containment rule is untested without it'
        Assert ($terms.deny -ccontains 'C:\Users\Testuser') 'the fixture denylist lost the path that an approved name overlaps'
        # The comment and blank lines in both files are stripped rather than matched as terms. A
        # `#` term would match every comment in the tree and turn the scan off within a day.
        Assert ($terms.deny -cnotcontains '# fixture denylist') 'a comment line survived into the denylist as a term'

        $staged = @(Get-IdentityScanStagedPaths -Workspace $fixture)
        # WHAT THIS COMMIT CHANGES, not what the repository holds. The deployment cases were
        # committed in the fixture's base commit and are untouched, so they are not this commit's
        # objects -- and a scan that returned them would be reading `git ls-files` by another name.
        Assert ($staged -ccontains 'docs/identity-home.md') 'the staged set missed a file this commit adds'
        Assert ($staged -cnotcontains 'tools/Bad-Endpoint.ps1') 'the staged set returned a file this commit does not change; it is reading the tree, not the index'
        Assert ($staged -cnotcontains 'PLAN-public-release.md') 'PLAN records are excluded from both scans and one of them scanned it anyway'

        $blobs = @(Get-IdentityScanStagedBlobs -Workspace $fixture -Paths $staged)
        $blobNames = @($blobs | ForEach-Object { $_.source } | Sort-Object -Unique)
        Assert ($blobNames -cnotcontains 'docs/identity-blob.bin') 'a binary blob was decoded and scanned; there is no line in it to name in a refusal'

        $idHits = @(Find-IdentityScanHits -Sources $blobs -DenyTerms $terms.deny -AllowTerms $terms.allow)
        $idFiles = @($idHits | ForEach-Object { $_.source } | Sort-Object -Unique)
        foreach ($expected in @('docs/identity-home.md', 'docs/identity-host.md')) {
            Assert ($idFiles -ccontains $expected) "the identity scan missed the planted identity in $expected"
        }
        Assert ($idFiles -cnotcontains 'docs/identity-byline.md') 'the identity scan flagged approved attribution, which is the one exception the allowlist exists for'

        # THE PAIR. This is the assertion the whole "index, not tree" design is for: the file whose
        # identity survives only in the staged blob must be caught, and the file that carries one
        # only in the working tree must not -- because only one of them is being committed.
        Assert ($idFiles -ccontains 'tools/Staged-Dirty.ps1') 'the identity scan missed a staged blob whose working-tree copy had been cleaned; it is reading the tree'
        Assert ($idFiles -cnotcontains 'tools/Worktree-Dirty.ps1') 'the identity scan flagged a working-tree edit that is not staged; it is reading the tree'

        # FALSIFICATION, both directions.
        # Empty the denylist: every positive above must disappear, or they were never the detector.
        $idNone = @(Find-IdentityScanHits -Sources $blobs -DenyTerms @() -AllowTerms $terms.allow)
        Assert ($idNone.Count -eq 0) "emptying the denylist still produced $($idNone.Count) identity hit(s); the positives above were not the detector matching"
        # Empty the ALLOWLIST: the byline must now be flagged. Without this, "the byline was clean"
        # and "the allowlist suppressed it" are the same green, and a broken allowlist reads as a
        # working one.
        $idNoAllow = @(Find-IdentityScanHits -Sources $blobs -DenyTerms $terms.deny -AllowTerms @())
        $idNoAllowFiles = @($idNoAllow | ForEach-Object { $_.source } | Sort-Object -Unique)
        Assert ($idNoAllowFiles -ccontains 'docs/identity-byline.md') 'with no allowlist the byline was still clean, so the allowlist was never what suppressed it'

        # THE MODES, over a term root that holds nothing.
        $emptyTerms = Join-Path ([IO.Path]::GetTempPath()) ('identity-scan-none-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $emptyTerms -Force | Out-Null
        try {
            $absent = Invoke-IdentityScan -Workspace $fixture -TermRoot $emptyTerms -Mode ''
            Assert ($absent.status -eq 'fail') "a missing denylist on a maintainer machine reported '$($absent.status)'; a check whose denylist nobody created has never matched anything"
            $contributor = Invoke-IdentityScan -Workspace $fixture -TermRoot $emptyTerms -Mode 'contributor'
            Assert ($contributor.status -eq 'warn') "a missing denylist in contributor mode reported '$($contributor.status)' rather than warn"
        }
        finally { Remove-Item -LiteralPath $emptyTerms -Recurse -Force -ErrorAction SilentlyContinue }

        # END TO END, including the commit message -- the second boundary, and the one no file scan
        # can reach, because the message is not a blob until after the hook has passed it.
        $whole = Invoke-IdentityScan -Workspace $fixture -TermRoot $termRoot -Mode ''
        Assert ($whole.status -eq 'fail') "the end-to-end scan reported '$($whole.status)' on a fixture carrying three planted identities"

        $msgFile = Join-Path ([IO.Path]::GetTempPath()) ('identity-scan-msg-' + [guid]::NewGuid().ToString('N') + '.txt')
        try {
            [IO.File]::WriteAllText($msgFile, "Fix the path`n`nMeasured from C:\Users\Testuser\.codex.`n", $utf8)
            $msgHits = @(Find-IdentityScanHits -Sources @([pscustomobject]@{ source = '<commit message>'; text = [IO.File]::ReadAllText($msgFile) }) -DenyTerms $terms.deny -AllowTerms $terms.allow)
            Assert ($msgHits.Count -ge 1) 'the identity scan read a commit message carrying a home directory and called it clean'
            Assert (@($msgHits)[0].source -eq '<commit message>') 'a commit-message hit was attributed to a file'
            $cleanMsg = Join-Path ([IO.Path]::GetTempPath()) ('identity-scan-msg-ok-' + [guid]::NewGuid().ToString('N') + '.txt')
            try {
                [IO.File]::WriteAllText($cleanMsg, "Fix the path`n`nCo-Authored-By: Testuser Example <testuser@public.example>`n", $utf8)
                $okHits = @(Find-IdentityScanHits -Sources @([pscustomobject]@{ source = '<commit message>'; text = [IO.File]::ReadAllText($cleanMsg) }) -DenyTerms $terms.deny -AllowTerms $terms.allow)
                Assert ($okHits.Count -eq 0) 'the identity scan refused an ordinary trailer carrying the approved attribution'
            }
            finally { Remove-Item -LiteralPath $cleanMsg -Force -ErrorAction SilentlyContinue }
        }
        finally { Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue }
    }
    finally {
        Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $termRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($failures.Count) {
        [Console]::Error.WriteLine("DeploymentScan self-test FAILED: $($failures -join '; ')")
        exit 1
    }
    Write-Host "DeploymentScan self-test passed ($script:deploymentScanChecks checks)."
    exit 0
}

# --- The two ways this file is run directly -------------------------------------------------------
#
# Dot-sourced everywhere else. These two entry points exist because a git hook is a shell script and
# cannot dot-source a PowerShell file, so each hook needs something to launch.
#
#   powershell.exe -File tools/DeploymentScan.ps1 -SelfTest
#   powershell.exe -File tools/DeploymentScan.ps1 -IdentityScan -CommitMessageFile <path>
#
# $args is read rather than a param() block because a param() block would run on every dot-source
# too, and every consumer of the scan functions dot-sources this file without arguments.
if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') {
    Invoke-DeploymentScanSelfTest
}

if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-IdentityScan') {
    $messageFile = ''
    for ($i = 0; $i -lt $args.Count; $i++) {
        if ([string]$args[$i] -eq '-CommitMessageFile' -and $i + 1 -lt $args.Count) { $messageFile = [string]$args[$i + 1] }
    }
    # The workspace is this file's parent's parent, not the current directory: a git hook runs with
    # the cwd at the top of the working tree today, and that is a fact about git rather than a
    # promise to this script.
    $scanWorkspace = Split-Path -Parent $PSScriptRoot
    $scanResult = Invoke-IdentityScan -Workspace $scanWorkspace -CommitMessageFile $messageFile
    switch ($scanResult.status) {
        'fail' { [Console]::Error.WriteLine("identity scan FAILED: $($scanResult.detail)"); exit 1 }
        'warn' { Write-Host "identity scan WARNING: $($scanResult.detail)"; exit 0 }
        default { Write-Host "identity scan: $($scanResult.detail)"; exit 0 }
    }
}
