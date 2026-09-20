<#
.SYNOPSIS
    The single hardened boundary for every git invocation the Library makes, plus the grammar and
    containment rules that decide what a recordable upstream is. Dot-sourced; never invoked directly
    except with -SelfTest.

.DESCRIPTION
    Book currency anchoring (PLAN-book-currency.md, step 1). Three helpers reach a git executable --
    Sync-RawUpstream.ps1 clones, Compile-RawBatchToNotebook.ps1 verifies a pin at capture, and
    Get-BookCurrency.ps1 compares a pin against its upstream. They share this file so the hardening
    cannot drift apart between them, which is the failure the plan's review round 4 found when the
    clone path alone carried transfer ceilings.

    THE PROTOCOL FLAGS ARE NOT WHAT CLOSES THE TRANSPORT SURFACE. This is measured, not assumed.
    With `-c protocol.allow=never -c protocol.https.allow=always` on the command line, a global
    config carrying

        [url "ext::<command>"]
            insteadOf = https://github.com/evil/

    rewrites an allowlisted https:// URL into git's `ext` transport, which runs a shell command. The
    rewrite fires before the protocol policy is consulted. What actually closes it is CONFIG
    ISOLATION -- GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM pointed at `nul` and GIT_CONFIG_NOSYSTEM
    set -- so the rewrite is never read. The protocol flags stay as defence in depth, and so does the
    reduced PATH: in the probe that produced this comment, git got as far as reporting
    `error: cannot spawn cmd: No such file or directory`, because the child's PATH held only the git
    installation. Two independent layers stopped it; neither is load-bearing alone.

    Config isolation covers system and global config ONLY. A repository's own config is still read,
    and it can carry `include`, `includeIf`, `core.fsmonitor`, `diff.external` and the filter and
    textconv keys, every one of which executes. Worse, git reads it during repository setup -- so by
    the time `git rev-parse` has answered, an `include.path` pointing at a UNC share has already been
    contacted. That is why Resolve-BatchRepository walks the filesystem itself and
    Test-RepositoryConfigSafe reads the config AS A FILE, both BEFORE any repository-aware git
    command runs. Git is invoked last, and only to confirm what the filesystem already established;
    a disagreement is a refusal, never a correction.

    THE ENVIRONMENT IS AN ALLOWLIST, NOT A SCRUB. Naming variables to clear cannot be closed:
    GIT_CONFIG_COUNT with GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n injects arbitrary config,
    GIT_CONFIG_PARAMETERS does the same, GIT_OBJECT_DIRECTORY redirects object lookup, and
    HTTP_PROXY/HTTPS_PROXY are not GIT_* at all. The child environment is therefore built empty and
    populated with exactly what git needs.

    WINDOWS POWERSHELL 5.1 HAS NO ProcessStartInfo.ArgumentList. That is .NET Core only, so the
    quoting is ours and ConvertTo-GitArgumentString implements the CommandLineToArgvW rule. No shell
    is involved at any point -- UseShellExecute is false -- so this is about argument boundaries, not
    about shell metacharacters. A value that would need shell escaping is refused by grammar long
    before it reaches here.

    WHAT THE OUTPUT CAP IS AND IS NOT. Stdout and stderr are drained concurrently with
    ReadToEndAsync, which is what keeps a filled pipe from deadlocking the wait. The cap applied to
    them bounds what is RETAINED and rendered, not what a hostile server may send. What bounds the
    transfer itself is the timeout plus Invoke-BoundedFetch's on-disk ceiling, polled while the fetch
    runs -- because the threat is a large pack on disk, not a large string in memory.
#>

Set-StrictMode -Version Latest

$script:GitDefaultTimeoutSeconds = 60
$script:GitOutputCapChars = 262144
$script:GitFieldLengthCap = 512
$script:GitFetchCeilingBytes = 256MB
$script:GitFetchPollMilliseconds = 400
$script:TrustedGitPath = $null

# --- Argument quoting -------------------------------------------------------------------------

# CommandLineToArgvW's rule: a backslash is literal unless it precedes a quote, where runs double.
# Every argument is quoted unless it is non-empty and free of whitespace and quotes, so an empty
# string survives as an empty argument rather than vanishing.
function ConvertTo-GitArgumentString {
    [CmdletBinding()]
    param([string[]]$Arguments)

    $parts = foreach ($argument in @($Arguments)) {
        $value = [string]$argument
        if ($value.Length -gt 0 -and $value -notmatch '[\s"]') { $value; continue }
        $builder = [Text.StringBuilder]::new()
        [void]$builder.Append('"')
        $slashes = 0
        foreach ($character in $value.ToCharArray()) {
            if ($character -eq '\') { $slashes++; continue }
            if ($character -eq '"') {
                [void]$builder.Append('\' * (($slashes * 2) + 1))
                $slashes = 0
                [void]$builder.Append('"')
                continue
            }
            if ($slashes) { [void]$builder.Append('\' * $slashes); $slashes = 0 }
            [void]$builder.Append($character)
        }
        [void]$builder.Append('\' * ($slashes * 2))
        [void]$builder.Append('"')
        $builder.ToString()
    }
    (@($parts) -join ' ')
}

# --- The trusted executable -------------------------------------------------------------------

function Get-TrustedGitPath {
    [CmdletBinding()]
    param()

    if ($null -ne $script:TrustedGitPath) { return $script:TrustedGitPath }
    $command = Get-Command 'git.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $command) { throw 'git.exe was not found on PATH; the Library cannot reach a git source without it.' }
    $resolved = [IO.Path]::GetFullPath([string]$command.Source)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "git.exe resolved to a path that is not a file: $resolved" }
    $script:TrustedGitPath = $resolved
    $resolved
}

# The child environment, built empty. GIT_CONFIG_GLOBAL/SYSTEM point at `nul`, the Windows null
# device, which git opens as an empty config; /dev/null is the POSIX spelling and is not used here.
function New-GitEnvironment {
    [CmdletBinding()]
    param([string]$ScratchHome)

    $gitDirectory = Split-Path -Parent (Get-TrustedGitPath)
    $home_ = if ([string]::IsNullOrWhiteSpace($ScratchHome)) { [IO.Path]::GetTempPath() } else { $ScratchHome }
    [ordered]@{
        SystemRoot          = "$env:SystemRoot"
        PATH                = $gitDirectory
        TEMP                = $home_
        TMP                 = $home_
        HOME                = $home_
        GIT_CONFIG_GLOBAL   = 'nul'
        GIT_CONFIG_SYSTEM   = 'nul'
        GIT_CONFIG_NOSYSTEM = '1'
        GIT_TERMINAL_PROMPT = '0'
        # Pathspec magic off everywhere. Set here rather than as `--literal-pathspecs` because that
        # is a TOP-LEVEL git option: placed after a subcommand it is a usage error, exit 129, which
        # is exactly how the first live currency check failed. An environment variable cannot be in
        # the wrong position.
        GIT_LITERAL_PATHSPECS = '1'
    }
    # GIT_EXEC_PATH is deliberately ABSENT rather than pinned. The plan said pin it, but an
    # allowlisted environment makes absence the stronger option: git falls back to its compiled-in
    # helper directory, which no inherited variable can redirect. Setting it to an empty string --
    # the obvious reading of "pin it" -- would instead point git's helper lookup at nothing.
}

# Flags every invocation carries. Kept beside the environment so the two are read together.
function Get-GitPolicyArgument {
    [CmdletBinding()]
    param()
    @(
        '-c', 'protocol.allow=never'
        '-c', 'protocol.https.allow=always'
        '-c', 'http.followRedirects=false'
        '-c', 'credential.helper='
        '-c', 'core.askPass='
        '-c', 'core.fsmonitor=false'
        '-c', 'core.pager=cat'
        '-c', 'core.hooksPath=nul'
    )
}

# --- Checkout filter settings ---------------------------------------------------------------------

$script:CheckoutFilterCache = @{}

<#
.SYNOPSIS
    The `-c` arguments that make a LOCAL comparison answer the same question the checkout asked.

.DESCRIPTION
    CONFIG ISOLATION HAS A COST, AND THIS PAYS IT BACK WITHOUT REOPENING THE HOLE. Git for Windows
    ships `core.autocrlf=true` in SYSTEM config, so a checked-out file is CRLF while its blob is LF.
    GIT_CONFIG_NOSYSTEM drops that setting -- and an isolated `git diff --quiet HEAD` then calls a
    perfectly clean file MODIFIED, because it re-hashes CRLF bytes against an LF blob. Measured
    exactly that way in a repository with no .gitattributes: normal git says unmodified, the isolated
    wrapper says modified, and the isolated wrapper plus `-c core.autocrlf=true` says unmodified
    again. Two of the three batches on disk are saved only by carrying `* text=auto` in
    .gitattributes, which makes the answer config-independent; a batch without one is not.

    The values are read with a plain `git config --get`, which is NOT isolated. That is deliberate
    and narrow: reading a config value executes nothing -- no remote is contacted, no pager, diff
    driver, or credential helper runs -- and the threat isolation exists to close is a rewritten URL
    reaching a NETWORK operation. These arguments are therefore attached only to local inspection
    (status, diff, ls-files) and never to a fetch or ls-remote, which stay fully isolated.
#>
function Get-CheckoutFilterArgument {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$WorkTree)

    $key = $WorkTree.ToLowerInvariant()
    if ($script:CheckoutFilterCache.ContainsKey($key)) { return $script:CheckoutFilterCache[$key] }

    $arguments = [Collections.Generic.List[string]]::new()
    # $LASTEXITCODE is saved and restored around the native calls below. `git config --get` exits 1
    # for a setting that is simply unset, which core.eol usually is -- and leaking that to the caller
    # makes a successful helper look like a failed one to anything reading an exit code, the
    # pre-commit hook included. Observed exactly that way before this guard existed.
    # Read through Test-Path, not directly: under Set-StrictMode, $LASTEXITCODE is UNDEFINED until
    # the session's first native command, so a bare read throws in a fresh process. Restoring to 0
    # where there was nothing to restore is safe -- a caller cannot have been reading a variable that
    # did not exist -- and it is better than leaving a stray 1 behind.
    $hadExitCode = Test-Path -Path 'variable:global:LASTEXITCODE'
    $priorExitCode = if ($hadExitCode) { $global:LASTEXITCODE } else { 0 }
    try {
    foreach ($setting in @('core.autocrlf', 'core.eol')) {
        $value = ''
        try {
            $raw = & (Get-TrustedGitPath) '-C' $WorkTree 'config' '--get' $setting 2>$null
            if ($LASTEXITCODE -eq 0 -and $null -ne $raw) { $value = ([string]@($raw)[0]).Trim() }
        }
        catch { $value = '' }
        # Only a value git itself would accept is passed on, so a junk config cannot become an
        # argument. Anything else is simply left unset, which is git's own default.
        if ($setting -eq 'core.autocrlf' -and $value -imatch '^(true|false|input)$') {
            $arguments.Add('-c'); $arguments.Add("core.autocrlf=$($value.ToLowerInvariant())")
        }
        elseif ($setting -eq 'core.eol' -and $value -imatch '^(lf|crlf|native)$') {
            $arguments.Add('-c'); $arguments.Add("core.eol=$($value.ToLowerInvariant())")
        }
    }
    }
    finally { $global:LASTEXITCODE = $priorExitCode }
    $script:CheckoutFilterCache[$key] = @($arguments)
    @($arguments)
}

# --- The wrapper ---------------------------------------------------------------------------------

<#
.SYNOPSIS
    Run one git command under the hardened boundary. Never throws on a non-zero exit; the caller
    reads .exit_code and decides, because most git failures here are ordinary answers.
#>
function Invoke-GitSafe {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string[]]$GitArgument,
        [string]$WorkingDirectory,
        [int]$TimeoutSeconds = 0,
        [string]$ScratchHome,
        [scriptblock]$OnPoll,
        # Test seam only: lets the self-test drive the timeout and tree-kill paths with a process
        # that is guaranteed to hang, without needing a network or a wedged git.
        [string]$Executable,
        [switch]$RawArguments,
        # Local inspection only. Never set for a fetch or ls-remote -- see Get-CheckoutFilterArgument.
        [string]$CarryCheckoutFiltersFor
    )

    $timeout = if ($TimeoutSeconds -gt 0) { $TimeoutSeconds } else { $script:GitDefaultTimeoutSeconds }
    $exe = if ([string]::IsNullOrWhiteSpace($Executable)) { Get-TrustedGitPath } else { $Executable }
    $arguments = if ($RawArguments) { @($GitArgument) } else { @(Get-GitPolicyArgument) + @($GitArgument) }
    if (-not $RawArguments -and -not [string]::IsNullOrWhiteSpace($CarryCheckoutFiltersFor)) {
        # Placed after the policy flags and before the caller's, so a caller can still override.
        $arguments = @(Get-GitPolicyArgument) + @(Get-CheckoutFilterArgument -WorkTree $CarryCheckoutFiltersFor) + @($GitArgument)
    }

    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $exe
    $psi.Arguments = ConvertTo-GitArgumentString $arguments
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) { $psi.WorkingDirectory = $WorkingDirectory }
    $psi.EnvironmentVariables.Clear()
    foreach ($entry in (New-GitEnvironment -ScratchHome $ScratchHome).GetEnumerator()) {
        $psi.EnvironmentVariables[$entry.Key] = [string]$entry.Value
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $psi
    $timedOut = $false
    $aborted = ''
    try {
        [void]$process.Start()
        # Closed immediately: a git that decides to ask a question gets EOF instead of a hang, the
        # same failure mode GIT_TERMINAL_PROMPT closes from the other side.
        try { $process.StandardInput.Close() } catch { }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()

        $deadline = [DateTime]::UtcNow.AddSeconds($timeout)
        while ($true) {
            if ($process.WaitForExit($script:GitFetchPollMilliseconds)) { break }
            if ($null -ne $OnPoll) {
                $breach = & $OnPoll
                if (-not [string]::IsNullOrWhiteSpace([string]$breach)) { $aborted = [string]$breach; break }
            }
            if ([DateTime]::UtcNow -gt $deadline) { $timedOut = $true; break }
        }

        if ($timedOut -or $aborted) {
            # Kill the tree, not the process: git spawns git-remote-https, and orphaning it leaves a
            # transfer running against a ceiling that has already been breached.
            try { & taskkill.exe '/T' '/F' '/PID' $process.Id 2>&1 | Out-Null } catch { }
            try { if (-not $process.HasExited) { $process.Kill() } } catch { }
            [void]$process.WaitForExit(5000)
        }

        $stdout = ''
        $stderr = ''
        try { if ($stdoutTask.Wait(5000)) { $stdout = [string]$stdoutTask.Result } } catch { }
        try { if ($stderrTask.Wait(5000)) { $stderr = [string]$stderrTask.Result } } catch { }
        if ($stdout.Length -gt $script:GitOutputCapChars) { $stdout = $stdout.Substring(0, $script:GitOutputCapChars) }
        if ($stderr.Length -gt $script:GitOutputCapChars) { $stderr = $stderr.Substring(0, $script:GitOutputCapChars) }

        [pscustomobject]@{
            ok           = (-not $timedOut) -and (-not $aborted) -and ($process.ExitCode -eq 0)
            exit_code    = if ($timedOut -or $aborted) { -1 } else { $process.ExitCode }
            stdout       = $stdout
            stderr       = $stderr
            timed_out    = $timedOut
            aborted      = $aborted
            # Measured on this machine, 2026-09-04: git ls-remote against GitHub resolves in ~0.33 s
            # and a 401 with prompts disabled fails in ~0.23 s, so a timeout here is a real stall.
            filter_ignored = ($stderr -match 'filtering not recognized by server')
        }
    }
    finally {
        try { $process.Dispose() } catch { }
    }
}

# --- The bounded fetch ---------------------------------------------------------------------------

<#
.SYNOPSIS
    The one primitive for every git call that touches the network: the clone in Sync-RawUpstream,
    the capture verification in the compiler, and both Currency fetches. Enforces the timeout, the
    filter acknowledgement, and an on-disk ceiling polled while the transfer runs.
#>
function Invoke-BoundedFetch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string[]]$GitArgument,
        [Parameter(Mandatory = $true)][string]$MeasuredPath,
        [string]$WorkingDirectory,
        [int]$TimeoutSeconds = 0,
        [long]$CeilingBytes = 0,
        [switch]$RequireFilterAcknowledged
    )

    $ceiling = if ($CeilingBytes -gt 0) { $CeilingBytes } else { $script:GitFetchCeilingBytes }
    $measured = $MeasuredPath
    $poll = {
        if (-not (Test-Path -LiteralPath $measured -PathType Container)) { return '' }
        $size = 0L
        try {
            foreach ($file in (Get-ChildItem -LiteralPath $measured -Recurse -File -Force -ErrorAction SilentlyContinue)) {
                $size += [long]$file.Length
                if ($size -gt $ceiling) { break }
            }
        }
        catch { return '' }
        if ($size -gt $ceiling) { return 'transfer-ceiling' }
        ''
    }.GetNewClosure()

    $result = Invoke-GitSafe -GitArgument $GitArgument -WorkingDirectory $WorkingDirectory `
        -TimeoutSeconds $TimeoutSeconds -ScratchHome $MeasuredPath -OnPoll $poll

    $reason = ''
    if ($result.aborted -eq 'transfer-ceiling') { $reason = 'transfer-ceiling' }
    elseif ($result.timed_out) { $reason = 'source-unreachable' }
    elseif ($RequireFilterAcknowledged -and $result.filter_ignored) { $reason = 'unsupported-filter' }
    elseif (-not $result.ok) { $reason = 'fetch-failed' }

    $result | Add-Member -NotePropertyName 'refusal' -NotePropertyValue $reason -PassThru
}

# --- Recordable fields ---------------------------------------------------------------------------

<#
.SYNOPSIS
    True when a value can be interpolated into a ## Sources line without making it ambiguous.
    Applies to the URL, the ref AND the repo root -- git accepts refs containing backticks and
    semicolons (verified with git check-ref-format), and a Windows path may contain either, so
    protecting only the URL leaves two of three fields open.
#>
function Test-RecordableField {
    [CmdletBinding()]
    param([string]$Value)

    if ($null -eq $Value) { return $false }
    if ($Value.Length -eq 0 -or $Value.Length -gt $script:GitFieldLengthCap) { return $false }
    if ($Value.IndexOf('`', [StringComparison]::Ordinal) -ge 0) { return $false }
    if ($Value.IndexOf(';', [StringComparison]::Ordinal) -ge 0) { return $false }
    foreach ($character in $Value.ToCharArray()) {
        if ([char]::IsControl($character)) { return $false }
    }
    $true
}

# --- URL grammar and host policy -----------------------------------------------------------------

# Percent escapes are refused outright rather than canonicalised. No forge needs them in an
# owner/repository path, and refusing removes a whole class of "two spellings of one URL" ambiguity
# from the distinct-pin roll-up, which compares recorded URLs as strings.
$script:UpstreamUrlPattern = '^https://(?<host>[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)+)(?<path>(/[A-Za-z0-9._~\-]+)+)/?$'

<#
.SYNOPSIS
    Host-independent URL grammar. Applied at fetch, at capture and at check, because it asks only
    whether a value is well formed and safely recordable -- never whether it may be contacted.
    Returns the normalised URL, or the reason it was refused.
#>
function ConvertTo-NormalisedUpstreamUrl {
    [CmdletBinding()]
    param([string]$Url)

    $refusal = { param($Reason) [pscustomobject]@{ ok = $false; url = ''; host_name = ''; reason = $Reason } }

    if ([string]::IsNullOrWhiteSpace($Url)) { return (& $refusal 'no URL was supplied') }
    $value = ([string]$Url).Trim()
    if (-not (Test-RecordableField $value)) { return (& $refusal 'the URL carries a character that cannot be recorded safely') }
    if ($value.IndexOf('@', [StringComparison]::Ordinal) -ge 0) { return (& $refusal 'a URL carrying userinfo is refused') }
    if ($value.IndexOf('?', [StringComparison]::Ordinal) -ge 0) { return (& $refusal 'a URL carrying a query is refused') }
    if ($value.IndexOf('#', [StringComparison]::Ordinal) -ge 0) { return (& $refusal 'a URL carrying a fragment is refused') }
    if ($value.IndexOf('%', [StringComparison]::Ordinal) -ge 0) { return (& $refusal 'a URL carrying a percent escape is refused') }
    if ($value -cnotmatch '^https://') {
        if ($value -match '^(?i)https://') { $value = 'https://' + $value.Substring(8) }
        else { return (& $refusal 'only https:// upstreams are accepted') }
    }

    # Lowercase the host only. A repository path is case-sensitive on most forges.
    $rest = $value.Substring(8)
    $firstSlash = $rest.IndexOf('/')
    if ($firstSlash -lt 1) { return (& $refusal 'the URL has no repository path') }
    $hostPart = $rest.Substring(0, $firstSlash).ToLowerInvariant()
    $value = 'https://' + $hostPart + $rest.Substring($firstSlash)

    if ($hostPart.IndexOf(':', [StringComparison]::Ordinal) -ge 0) { return (& $refusal 'a URL carrying an explicit port is refused') }
    if ($hostPart -match '^\d+(\.\d+)*$') { return (& $refusal 'an IP-literal host is refused') }
    if ($hostPart -eq 'localhost' -or $hostPart -like 'localhost.*') { return (& $refusal 'a localhost upstream is refused') }

    $match = [regex]::Match($value, $script:UpstreamUrlPattern)
    if (-not $match.Success) { return (& $refusal 'the URL is not a plain https host-and-path upstream') }

    $normalised = $value.TrimEnd('/')
    if ($normalised.EndsWith('.git', [StringComparison]::OrdinalIgnoreCase)) {
        $normalised = $normalised.Substring(0, $normalised.Length - 4).TrimEnd('/')
    }
    if ($normalised -cnotmatch $script:UpstreamUrlPattern) { return (& $refusal 'the URL has no repository path once normalised') }
    if (-not (Test-RecordableField $normalised)) { return (& $refusal 'the normalised URL cannot be recorded safely') }

    [pscustomobject]@{ ok = $true; url = $normalised; host_name = $match.Groups['host'].Value; reason = '' }
}

<#
.SYNOPSIS
    Host authorization, applied wherever a network call happens -- the fetch helper, the Currency
    check, and (since capture verification became mandatory) the compiler. The allowlist arrives on
    a command line, never from Book or article text, so no stored text can widen it.
#>
function Test-UpstreamHostAllowed {
    [CmdletBinding()]
    param([string]$HostName, [string[]]$AllowHost)

    if ([string]::IsNullOrWhiteSpace($HostName)) { return $false }
    $allowed = @(@($AllowHost) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if (-not $allowed.Count) { $allowed = @('github.com') }
    foreach ($candidate in $allowed) {
        if ($HostName -eq ([string]$candidate).Trim().ToLowerInvariant()) { return $true }
    }
    $false
}

# --- Repository config safety ---------------------------------------------------------------------

# Keys git will EXECUTE, or that redirect where it reads from. The test is against the normalised
# "section.key" or "section.subsection.key", lowercased, so a subsection spelling cannot slip past.
$script:UnsafeConfigPattern = @(
    '^include\.'
    '^includeif\.'
    '^core\.(fsmonitor|pager|sshcommand|hookspath|editor|askpass|gitproxy|alternaterefscommand|externaldiff)$'
    '^diff\.external$'
    '^diff\..+\.(textconv|command)$'
    '^filter\..+\.(clean|smudge|process)$'
    '^credential(\..+)?\.helper$'
    '^url\..+\.(insteadof|pushinsteadof)$'
    '^protocol(\..+)?\.allow$'
    '^alias\..+$'
    '^uploadpack\.(packobjectshook|uploadpackfilter.*)$'
    '^remote\..+\.(uploadpack|receivepack|vcs|proxy)$'
    '^http(\..+)?\.proxy$'
    '^gpg(\..+)?\.program$'
    '^init\.templatedir$'
    '^safe\.directory$'
)
# extensions.worktreeConfig is deliberately ABSENT from that list, and the omission is load-bearing.
# `git sparse-checkout set` SETS it -- so refusing it refuses every thin clone Sync-RawUpstream.ps1
# makes, which is the whole URL route. Caught on the first live fetch. The setting carries no
# execution of its own; all it does is make git read $GIT_DIR/config.worktree, and the protection
# that matters is validating THAT FILE, which Test-RepositoryConfigSafe does unconditionally rather
# than only when the flag is set.

<#
.SYNOPSIS
    True when a git config file's TEXT carries nothing that executes or redirects. Parsed here and
    never through `git config`, because asking git to read it is what resolves an include -- and an
    include pointing at a UNC share is contacted the moment it is resolved.
    Anything that cannot be parsed confidently is refused, not skipped.
#>
function Test-GitConfigTextSafe {
    [CmdletBinding()]
    param([string]$Text)

    $refusal = { param($Reason) [pscustomobject]@{ safe = $false; reason = $Reason } }
    if ([string]::IsNullOrEmpty($Text)) { return [pscustomobject]@{ safe = $true; reason = '' } }

    $section = ''
    $subsection = ''
    $pending = ''
    foreach ($rawLine in ($Text -split "`r?`n")) {
        $line = $pending + $rawLine
        $pending = ''
        # A trailing backslash continues a value onto the next line; joining first is what stops a
        # continuation from being read as a fresh key. Defect family 3: parse the item, not the line.
        if ($line -match '\\$') { $pending = $line.Substring(0, $line.Length - 1); continue }
        $line = $line.Trim()
        if ($line.Length -eq 0) { continue }
        if ($line.StartsWith('#') -or $line.StartsWith(';')) { continue }

        if ($line.StartsWith('[')) {
            $header = [regex]::Match($line, '^\[\s*([A-Za-z0-9.\-]+)\s*(?:"((?:[^"\\]|\\.)*)")?\s*\]')
            if (-not $header.Success) { return (& $refusal "a config section header could not be parsed: $line") }
            $section = $header.Groups[1].Value.ToLowerInvariant()
            $subsection = if ($header.Groups[2].Success) { $header.Groups[2].Value.ToLowerInvariant() } else { '' }
            # `[include]` and `[includeIf "..."]` carry their danger in the section, and a bare
            # section line with no key still means the following keys are includes.
            if ($section -eq 'include' -or $section -eq 'includeif') {
                return (& $refusal "the repository config carries an $section directive")
            }
            continue
        }

        $pair = [regex]::Match($line, '^([A-Za-z][A-Za-z0-9\-]*)\s*(?:=|$)')
        if (-not $pair.Success) { return (& $refusal "a config line could not be parsed: $line") }
        if ([string]::IsNullOrEmpty($section)) { return (& $refusal 'a config key appeared before any section header') }
        $key = $pair.Groups[1].Value.ToLowerInvariant()
        $full = if ($subsection) { "$section.$subsection.$key" } else { "$section.$key" }
        foreach ($pattern in $script:UnsafeConfigPattern) {
            if ($full -match $pattern) { return (& $refusal "the repository config sets '$full', which git executes or redirects") }
        }
    }
    if ($pending) { return (& $refusal 'the config file ends inside a continued value') }
    [pscustomobject]@{ safe = $true; reason = '' }
}

<#
.SYNOPSIS
    Apply Test-GitConfigTextSafe to every config file git would read for this repository: the
    common-dir `config`, and `config.worktree` when it exists. Reading only .git/config misses the
    per-worktree file entirely.
#>
function Test-RepositoryConfigSafe {
    [CmdletBinding()]
    param([string]$GitDir, [string]$CommonDir)

    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($CommonDir)) { $candidates += (Join-Path $CommonDir 'config') }
    if (-not [string]::IsNullOrWhiteSpace($GitDir)) {
        $candidates += (Join-Path $GitDir 'config')
        $candidates += (Join-Path $GitDir 'config.worktree')
    }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in $candidates) {
        if (-not $seen.Add($candidate)) { continue }
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $text = ''
        try { $text = [Text.UTF8Encoding]::new($false, $false).GetString([IO.File]::ReadAllBytes($candidate)) }
        catch { return [pscustomobject]@{ safe = $false; reason = "a git config file could not be read: $candidate" } }
        $verdict = Test-GitConfigTextSafe -Text $text
        if (-not $verdict.safe) {
            return [pscustomobject]@{ safe = $false; reason = "$($verdict.reason) ($candidate)" }
        }
    }
    [pscustomobject]@{ safe = $true; reason = '' }
}

# --- Repository discovery --------------------------------------------------------------------------

function Test-PathInside([string]$Root, [string]$Candidate) {
    if ([string]::IsNullOrWhiteSpace($Root) -or [string]::IsNullOrWhiteSpace($Candidate)) { return $false }
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ($candidateFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    $candidateFull.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Test-ReparseAncestry([string]$Root, [string]$Leaf) {
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $cursor = [IO.Path]::GetFullPath($Leaf).TrimEnd([IO.Path]::DirectorySeparatorChar)
    while ($true) {
        $item = $null
        try { $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop } catch { return $true }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq [IO.FileAttributes]::ReparsePoint) { return $true }
        if ($cursor.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) { return $false }
        $cursor = $parent
    }
}

<#
.SYNOPSIS
    Find the repository containing one file, using filesystem APIs only, and refuse anything whose
    metadata leaves the batch.

.DESCRIPTION
    THE WALK STOPS AT THE BATCH ROOT, AND THAT IS THE WHOLE POINT. Git's own discovery walks upward
    until it finds a repository or hits a filesystem root, and `raw/` is gitignored inside a
    repository -- so `git -C raw/basic-memory rev-parse --show-toplevel` answers D:/Library and
    HEAD answers the Library's own commit. Measured: two of the three batches on disk behave that
    way. A pin generated from that would name the Library's own remote on an article about something
    else and look entirely plausible. Bounding the walk makes containment structural rather than a
    check applied afterwards.

    Git is not invoked here at all. Confirming with git happens in the caller, AFTER the config has
    been cleared, because `git rev-parse` reads repository config during setup.
#>
function Resolve-BatchRepository {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BatchRoot,
        [Parameter(Mandatory = $true)][string]$StartPath
    )

    $failure = { param($Reason) [pscustomobject]@{ found = $false; work_tree = ''; git_dir = ''; common_dir = ''; reason = $Reason } }

    if (-not (Test-Path -LiteralPath $BatchRoot -PathType Container)) { return (& $failure 'the batch directory does not exist') }
    $root = [IO.Path]::GetFullPath($BatchRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)

    $start = [IO.Path]::GetFullPath($StartPath)
    if (Test-Path -LiteralPath $start -PathType Leaf) { $start = Split-Path -Parent $start }
    if (-not (Test-PathInside $root $start)) { return (& $failure 'the source file does not resolve inside the batch') }

    $cursor = $start.TrimEnd([IO.Path]::DirectorySeparatorChar)
    while ($true) {
        $marker = Join-Path $cursor '.git'
        if (Test-Path -LiteralPath $marker) {
            $gitDir = ''
            if (Test-Path -LiteralPath $marker -PathType Container) {
                $gitDir = [IO.Path]::GetFullPath($marker)
            }
            else {
                $text = ''
                try { $text = [Text.UTF8Encoding]::new($false, $false).GetString([IO.File]::ReadAllBytes($marker)) }
                catch { return (& $failure 'the .git file could not be read') }
                $redirect = [regex]::Match($text, '(?m)^\s*gitdir:\s*(.+?)\s*$')
                if (-not $redirect.Success) { return (& $failure 'the .git file carries no gitdir: redirect') }
                $target = $redirect.Groups[1].Value.Trim().Replace('/', [IO.Path]::DirectorySeparatorChar)
                $gitDir = if ([IO.Path]::IsPathRooted($target)) { [IO.Path]::GetFullPath($target) }
                          else { [IO.Path]::GetFullPath((Join-Path $cursor $target)) }
                if (-not (Test-Path -LiteralPath $gitDir -PathType Container)) { return (& $failure 'the .git file redirects to a directory that does not exist') }
                if (-not (Test-PathInside $root $gitDir)) { return (& $failure 'the .git file redirects outside the batch') }
            }

            $commonDir = $gitDir
            $commonMarker = Join-Path $gitDir 'commondir'
            if (Test-Path -LiteralPath $commonMarker -PathType Leaf) {
                $commonText = ''
                try { $commonText = [Text.UTF8Encoding]::new($false, $false).GetString([IO.File]::ReadAllBytes($commonMarker)) }
                catch { return (& $failure 'the commondir file could not be read') }
                $relative = ($commonText -split "`r?`n")[0].Trim().Replace('/', [IO.Path]::DirectorySeparatorChar)
                if ([string]::IsNullOrWhiteSpace($relative)) { return (& $failure 'the commondir file is empty') }
                $commonDir = if ([IO.Path]::IsPathRooted($relative)) { [IO.Path]::GetFullPath($relative) }
                             else { [IO.Path]::GetFullPath((Join-Path $gitDir $relative)) }
                if (-not (Test-Path -LiteralPath $commonDir -PathType Container)) { return (& $failure 'commondir names a directory that does not exist') }
                if (-not (Test-PathInside $root $commonDir)) { return (& $failure 'commondir resolves outside the batch') }
            }

            if (Test-ReparseAncestry $root $cursor) { return (& $failure 'the repository is reached through a reparse point') }

            $safety = Test-RepositoryConfigSafe -GitDir $gitDir -CommonDir $commonDir
            if (-not $safety.safe) { return (& $failure $safety.reason) }

            return [pscustomobject]@{
                found      = $true
                work_tree  = $cursor
                git_dir    = $gitDir
                common_dir = $commonDir
                reason     = ''
            }
        }

        if ($cursor.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) { break }
        if (-not (Test-PathInside $root $parent)) { break }
        $cursor = $parent
    }

    (& $failure 'no git repository lies between the source file and the batch root')
}

<#
.SYNOPSIS
    Ask git to confirm what the filesystem walk already established. A disagreement is a refusal --
    never a correction -- because the filesystem answer is the one that was reached without letting
    git read a repository config first.
#>
function Confirm-BatchRepository {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$Resolved, [int]$TimeoutSeconds = 0)

    $result = Invoke-GitSafe -GitArgument @('-C', $Resolved.work_tree, 'rev-parse', '--show-toplevel', '--absolute-git-dir') -TimeoutSeconds $TimeoutSeconds
    if (-not $result.ok) { return [pscustomobject]@{ confirmed = $false; reason = 'git did not resolve the repository' } }
    $lines = @(($result.stdout -split "`r?`n") | Where-Object { $_.Trim() })
    if ($lines.Count -lt 2) { return [pscustomobject]@{ confirmed = $false; reason = 'git returned an incomplete repository answer' } }

    $sameTree = ([IO.Path]::GetFullPath($lines[0].Trim().Replace('/', [IO.Path]::DirectorySeparatorChar)).TrimEnd([IO.Path]::DirectorySeparatorChar)) -ieq $Resolved.work_tree
    $sameGitDir = ([IO.Path]::GetFullPath($lines[1].Trim().Replace('/', [IO.Path]::DirectorySeparatorChar)).TrimEnd([IO.Path]::DirectorySeparatorChar)) -ieq ($Resolved.git_dir.TrimEnd([IO.Path]::DirectorySeparatorChar))
    if (-not $sameTree) { return [pscustomobject]@{ confirmed = $false; reason = 'git names a different work tree than the filesystem walk did' } }
    if (-not $sameGitDir) { return [pscustomobject]@{ confirmed = $false; reason = 'git names a different git directory than the filesystem walk did' } }
    [pscustomobject]@{ confirmed = $true; reason = '' }
}

# --- Self-test -------------------------------------------------------------------------------------
# Gate check: git-source.selftest. Entirely offline and deterministic -- no network and no clock
# sensitivity beyond one deliberate timeout. The config-isolation case and the walk-up case are the
# two that would otherwise let a wrong pin be generated, so both are proved against real git
# repositories rather than against fixtures of them.
if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') {
    $script:failures = [Collections.Generic.List[string]]::new()
    $script:checks = 0
    function Assert([bool]$Condition, [string]$Message) {
        $script:checks++
        if (-not $Condition) { [void]$script:failures.Add($Message) }
    }

    $utf8 = [Text.UTF8Encoding]::new($false)
    function Write-Fixture([string]$Path, [string]$Text) {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [IO.File]::WriteAllText($Path, $Text, $utf8)
    }
    function New-Repo([string]$Path) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
        [void](Invoke-GitSafe -GitArgument @('-C', $Path, 'init', '--quiet', '-b', 'main'))
        Write-Fixture (Join-Path $Path 'seed.md') "# seed`n"
        [void](Invoke-GitSafe -GitArgument @('-C', $Path, 'add', '--', 'seed.md'))
        [void](Invoke-GitSafe -GitArgument @('-C', $Path, '-c', 'user.name=Library Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'seed'))
    }

    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('git-source-selftest-' + [Guid]::NewGuid().ToString('n'))
    try {
        New-Item -ItemType Directory -Path $fixture -Force | Out-Null

        # --- Argument encoding. Asserted directly against the CommandLineToArgvW rule, because the
        # obvious oracle is contaminated: `git config` parses backslash escapes inside a value, so a
        # round trip through it would report our quoting wrong when it is right.
        Assert ((ConvertTo-GitArgumentString @('plain')) -ceq 'plain') 'a plain argument was needlessly quoted'
        Assert ((ConvertTo-GitArgumentString @('with space')) -ceq '"with space"') 'an argument with a space was not quoted'
        Assert ((ConvertTo-GitArgumentString @('a"b')) -ceq '"a\"b"') 'an embedded quote was not escaped'
        # A trailing backslash only doubles INSIDE quotes; unquoted it is already literal, so the
        # bare form is correct and the quoted form is what has to double.
        Assert ((ConvertTo-GitArgumentString @('trail\')) -ceq 'trail\') 'an unquoted trailing backslash was needlessly altered'
        Assert ((ConvertTo-GitArgumentString @('a b\')) -ceq '"a b\\"') 'a trailing backslash was not doubled inside quotes'
        Assert ((ConvertTo-GitArgumentString @('a\b')) -ceq 'a\b') 'an interior backslash was altered where it is literal'
        Assert ((ConvertTo-GitArgumentString @('a\"b')) -ceq '"a\\\"b"') 'a backslash before a quote was not doubled'
        Assert ((ConvertTo-GitArgumentString @('')) -ceq '""') 'an empty argument did not survive as an empty argument'
        Assert ((ConvertTo-GitArgumentString @('a', 'b c')) -ceq 'a "b c"') 'arguments were not joined correctly'

        # And one real round trip through the process boundary, on a value git will not re-parse.
        $probe = Invoke-GitSafe -GitArgument @('-c', 'librarytest.value=round trip value', 'config', '--get', 'librarytest.value')
        Assert ((($probe.stdout -split "`r?`n")[0]) -ceq 'round trip value') 'an argument containing spaces did not survive the process boundary'

        # --- Config isolation. This, not the protocol flags, is what closes the ext:: rewrite.
        $hostile = Join-Path $fixture 'hostile.gitconfig'
        Write-Fixture $hostile "[url `"ext::cmd /c echo pwned`"]`n`tinsteadOf = https://github.com/evil/`n[protocol `"ext`"]`n`tallow = always`n"
        $priorGlobal = $env:GIT_CONFIG_GLOBAL
        try {
            $env:GIT_CONFIG_GLOBAL = $hostile
            $leak = Invoke-GitSafe -GitArgument @('config', '--get-regexp', '^url\.')
            Assert ([string]::IsNullOrWhiteSpace($leak.stdout)) 'the hostile global config leaked through the isolated environment'
            $ext = Invoke-GitSafe -GitArgument @('config', '--get', 'protocol.ext.allow')
            Assert ([string]::IsNullOrWhiteSpace($ext.stdout)) 'protocol.ext.allow leaked through the isolated environment'
        }
        finally { $env:GIT_CONFIG_GLOBAL = $priorGlobal }

        # --- Recordable fields. git accepts refs carrying both delimiters -- verified with
        # check-ref-format -- so all three interpolated fields need the rule, not just the URL.
        Assert (Test-RecordableField 'refs/heads/master') 'an ordinary ref was refused'
        Assert (-not (Test-RecordableField 'refs/heads/foo`bar')) 'a ref carrying a backtick was accepted'
        Assert (-not (Test-RecordableField 'refs/heads/foo;bar')) 'a ref carrying a semicolon was accepted'
        Assert (-not (Test-RecordableField "refs/heads/foo`nbar")) 'a ref carrying a newline was accepted'
        Assert (-not (Test-RecordableField 'raw/batch/re`po')) 'a repo root carrying a backtick was accepted'
        Assert (-not (Test-RecordableField ('a' * 4096))) 'an over-long field was accepted'
        Assert (-not (Test-RecordableField '')) 'an empty field was accepted'

        # --- URL grammar.
        $accepted = ConvertTo-NormalisedUpstreamUrl 'https://GitHub.com/obsidianmd/obsidian-help.git/'
        Assert ($accepted.ok) "a plain GitHub URL was refused: $($accepted.reason)"
        Assert ($accepted.url -ceq 'https://github.com/obsidianmd/obsidian-help') "URL normalisation produced '$($accepted.url)'"
        Assert ($accepted.host_name -ceq 'github.com') 'the host was not lowercased'
        $caseKept = ConvertTo-NormalisedUpstreamUrl 'https://github.com/ObsidianMD/Obsidian-Help'
        Assert ($caseKept.ok -and $caseKept.url -ceq 'https://github.com/ObsidianMD/Obsidian-Help') 'the repository path was case-folded, but only the host may be'
        foreach ($bad in @(
            'http://github.com/a/b', 'https://user:pw@github.com/a/b', 'https://github.com:443/a/b',
            'https://127.0.0.1/a/b', 'https://localhost/a/b', 'https://github.com/a/b?x=1',
            'https://github.com/a/b#f', 'https://github.com/a%2fb', 'https://github.com',
            'https://github.com/', 'ext::sh -c whoami', 'D:/Library', 'https://gith`ub.com/a/b',
            'https://nodot/a/b', ''
        )) {
            $verdict = ConvertTo-NormalisedUpstreamUrl $bad
            Assert (-not $verdict.ok) "the URL grammar accepted '$bad'"
        }
        $selfHosted = ConvertTo-NormalisedUpstreamUrl 'https://forgejo.example.invalid/Kioga/library.git'
        Assert ($selfHosted.ok) 'a self-hosted forge URL was refused by grammar; that is host policy, not grammar'

        # --- Host policy is a separate gate from grammar.
        Assert (Test-UpstreamHostAllowed 'github.com' @()) 'the default host allowlist rejected github.com'
        Assert (-not (Test-UpstreamHostAllowed 'forgejo.example.invalid' @())) 'the default host allowlist accepted a host it should not'
        Assert (Test-UpstreamHostAllowed 'forgejo.example.invalid' @('forgejo.example.invalid')) 'an explicitly allowed host was rejected'
        Assert (-not (Test-UpstreamHostAllowed 'evil.github.com' @('github.com'))) 'host matching was a suffix match rather than an exact one'

        # --- Config text safety.
        Assert ((Test-GitConfigTextSafe "[core]`n`trepositoryformatversion = 0`n[remote `"origin`"]`n`turl = https://github.com/a/b`n").safe) 'an ordinary repository config was refused'
        foreach ($unsafe in @(
            "[include]`n`tpath = //server/share/evil",
            "[includeIf `"gitdir:/x/`"]`n`tpath = evil",
            "[core]`n`tfsmonitor = cmd /c calc",
            "[core]`n`tpager = evil",
            "[core]`n`thooksPath = //server/share",
            "[diff]`n`texternal = evil",
            "[diff `"x`"]`n`ttextconv = evil",
            "[filter `"lfs`"]`n`tclean = evil",
            "[url `"ext::sh -c x`"]`n`tinsteadOf = https://github.com/",
            "[alias]`n`tst = !evil",
            "[remote `"origin`"]`n`tuploadpack = evil",
            "[credential]`n`thelper = evil"
        )) {
            Assert (-not (Test-GitConfigTextSafe $unsafe).safe) "an unsafe config was accepted: $(($unsafe -split "`n")[0])"
        }
        Assert (-not (Test-GitConfigTextSafe "[core]`n`tfsmoni\`ntor = evil").safe) 'a continued config line was parsed as two separate keys'
        Assert (-not (Test-GitConfigTextSafe 'key = value').safe) 'a key before any section header was accepted'

        # --- Repository discovery. The walk-up guard is the case that matters: a batch with no
        # repository of its own, sitting inside a parent repository, must find NOTHING rather than
        # the parent. That is exactly raw/basic-memory inside D:\Library on this machine, where
        # `git -C` answers the Library's own commit.
        $outer = Join-Path $fixture 'outer'
        New-Repo $outer
        $batchNoRepo = Join-Path $outer 'batch-without-repo'
        New-Item -ItemType Directory -Path $batchNoRepo -Force | Out-Null
        Write-Fixture (Join-Path $batchNoRepo 'doc.md') "# doc`n"
        $walkUp = Resolve-BatchRepository -BatchRoot $batchNoRepo -StartPath (Join-Path $batchNoRepo 'doc.md')
        Assert (-not $walkUp.found) 'discovery walked up out of the batch and found the enclosing repository'

        $atRoot = Join-Path $fixture 'batch-at-root'
        New-Repo $atRoot
        $rootHit = Resolve-BatchRepository -BatchRoot $atRoot -StartPath (Join-Path $atRoot 'seed.md')
        Assert ($rootHit.found) "a repository at the batch root was not found: $($rootHit.reason)"
        Assert ($rootHit.work_tree -ieq ([IO.Path]::GetFullPath($atRoot).TrimEnd([IO.Path]::DirectorySeparatorChar))) 'the work tree was not the batch root'

        # Nested below the batch root, which is how raw/obsidian-pika is actually shaped.
        $nestedBatch = Join-Path $fixture 'batch-nested'
        $nestedRepo = Join-Path $nestedBatch 'batch1/repo'
        New-Repo $nestedRepo
        $nestedHit = Resolve-BatchRepository -BatchRoot $nestedBatch -StartPath (Join-Path $nestedRepo 'seed.md')
        Assert ($nestedHit.found) "a nested repository was not found: $($nestedHit.reason)"
        Assert ($nestedHit.work_tree -ieq ([IO.Path]::GetFullPath($nestedRepo).TrimEnd([IO.Path]::DirectorySeparatorChar))) 'the nested work tree was resolved to the wrong directory'

        $confirmed = Confirm-BatchRepository -Resolved $nestedHit
        Assert ($confirmed.confirmed) "git disagreed with the filesystem walk: $($confirmed.reason)"

        # A .git FILE redirecting inside the batch is honoured; one redirecting outside is refused.
        $redirectBatch = Join-Path $fixture 'batch-redirect'
        $redirectWork = Join-Path $redirectBatch 'work'
        $redirectStore = Join-Path $redirectBatch 'store.git'
        New-Repo $redirectWork
        Move-Item -LiteralPath (Join-Path $redirectWork '.git') -Destination $redirectStore
        Write-Fixture (Join-Path $redirectWork '.git') "gitdir: ../store.git`n"
        $inside = Resolve-BatchRepository -BatchRoot $redirectBatch -StartPath (Join-Path $redirectWork 'seed.md')
        Assert ($inside.found) "a .git file redirecting inside the batch was refused: $($inside.reason)"
        Assert ($inside.git_dir -ieq ([IO.Path]::GetFullPath($redirectStore).TrimEnd([IO.Path]::DirectorySeparatorChar))) 'the gitdir redirect resolved to the wrong directory'

        $escapeBatch = Join-Path $fixture 'batch-escape'
        $escapeWork = Join-Path $escapeBatch 'work'
        New-Item -ItemType Directory -Path $escapeWork -Force | Out-Null
        Write-Fixture (Join-Path $escapeWork 'seed.md') "# seed`n"
        Write-Fixture (Join-Path $escapeWork '.git') ("gitdir: " + $outer.Replace('\', '/') + "/.git`n")
        $escaped = Resolve-BatchRepository -BatchRoot $escapeBatch -StartPath (Join-Path $escapeWork 'seed.md')
        Assert (-not $escaped.found) 'a .git file redirecting outside the batch was honoured'

        # An unsafe repository config refuses the repository outright.
        $unsafeBatch = Join-Path $fixture 'batch-unsafe'
        New-Repo $unsafeBatch
        Add-Content -LiteralPath (Join-Path $unsafeBatch '.git/config') -Value "[core]`n`tfsmonitor = cmd /c calc"
        $unsafeHit = Resolve-BatchRepository -BatchRoot $unsafeBatch -StartPath (Join-Path $unsafeBatch 'seed.md')
        Assert (-not $unsafeHit.found) 'a repository whose own config executes was accepted'

        # config.worktree is read too. Reading only .git/config misses it entirely.
        $worktreeBatch = Join-Path $fixture 'batch-worktree'
        New-Repo $worktreeBatch
        Write-Fixture (Join-Path $worktreeBatch '.git/config.worktree') "[core]`n`tpager = evil`n"
        $worktreeHit = Resolve-BatchRepository -BatchRoot $worktreeBatch -StartPath (Join-Path $worktreeBatch 'seed.md')
        Assert (-not $worktreeHit.found) 'config.worktree was not inspected'

        # extensions.worktreeConfig must be ACCEPTED. `git sparse-checkout set` sets it, so refusing
        # it refuses every thin clone the URL route makes -- caught on the first live fetch, when the
        # guard rejected a clone it had just created. Validating config.worktree is the protection;
        # the flag itself executes nothing.
        Assert ((Test-GitConfigTextSafe "[extensions]`n`tworktreeConfig = true`n").safe) `
            'extensions.worktreeConfig was refused, which refuses every sparse clone this route makes'
        $sparseLike = Join-Path $fixture 'batch-sparse-like'
        New-Repo $sparseLike
        Add-Content -LiteralPath (Join-Path $sparseLike '.git/config') -Value "[extensions]`n`tworktreeConfig = true"
        Write-Fixture (Join-Path $sparseLike '.git/config.worktree') "[core]`n`tsparseCheckout = true`n"
        $sparseHit = Resolve-BatchRepository -BatchRoot $sparseLike -StartPath (Join-Path $sparseLike 'seed.md')
        Assert ($sparseHit.found) "a repository shaped like a sparse checkout was refused: $($sparseHit.reason)"

        # --- Checkout filters must survive config isolation. Regression for a real defect: Git for
        # Windows sets core.autocrlf=true in SYSTEM config, GIT_CONFIG_NOSYSTEM drops it, and an
        # isolated `diff --quiet HEAD` then calls a clean CRLF working file MODIFIED because it
        # re-hashes it against an LF blob. The repository below deliberately does NOT set autocrlf
        # locally, because a local value survives isolation and would hide the bug -- which is
        # exactly how the first version of this test passed while the code was wrong.
        $crlfRepo = Join-Path $fixture 'batch-crlf'
        New-Item -ItemType Directory -Path $crlfRepo -Force | Out-Null
        [void](Invoke-GitSafe -GitArgument @('-C', $crlfRepo, 'init', '--quiet', '-b', 'main'))
        [IO.File]::WriteAllText((Join-Path $crlfRepo 'doc.md'), "line one`nline two`nline three`n", $utf8)
        [void](Invoke-GitSafe -GitArgument @('-C', $crlfRepo, 'add', '--', 'doc.md'))
        [void](Invoke-GitSafe -GitArgument @('-C', $crlfRepo, '-c', 'user.name=T', '-c', 'user.email=t@e.com', 'commit', '--quiet', '-m', 'seed'))
        Remove-Item -LiteralPath (Join-Path $crlfRepo 'doc.md') -Force
        # Checked out by NORMAL git, so the system core.autocrlf applies and the file lands CRLF.
        & (Get-TrustedGitPath) '-C' $crlfRepo 'checkout' '--' 'doc.md' 2>&1 | Out-Null
        $checkedOut = [IO.File]::ReadAllBytes((Join-Path $crlfRepo 'doc.md'))
        if ($checkedOut -contains 13) {
            # Only meaningful where the machine actually converts; on a machine with autocrlf off the
            # premise does not hold and the assertion would be vacuous, so it is skipped honestly.
            $carried = Invoke-GitSafe -GitArgument @('-C', $crlfRepo, 'diff', '--quiet', 'HEAD', '--', 'doc.md') -CarryCheckoutFiltersFor $crlfRepo
            Assert ($carried.exit_code -eq 0) 'a clean CRLF checkout was reported modified even with the checkout filters carried'
            $notCarried = Invoke-GitSafe -GitArgument @('-C', $crlfRepo, 'diff', '--quiet', 'HEAD', '--', 'doc.md')
            Assert ($notCarried.exit_code -eq 1) 'the carry-over is no longer load-bearing here, so this regression no longer proves anything -- re-derive it before deleting'
        }

        # --- Timeout and tree kill, through the test seam, so neither a network nor a wedged git is
        # needed. Thread::Sleep rather than Start-Sleep: the minimal environment carries no
        # PSModulePath, so a cmdlet that needs autoloading is not a reliable way to hang.
        $sleeper = (Get-Command powershell.exe).Source
        $started = [Diagnostics.Stopwatch]::StartNew()
        $hung = Invoke-GitSafe -Executable $sleeper -RawArguments `
            -GitArgument @('-NoProfile', '-Command', '[Threading.Thread]::Sleep(45000)') -TimeoutSeconds 3
        $started.Stop()
        Assert ($hung.timed_out) 'a hung child was not reported as timed out'
        Assert (-not $hung.ok) 'a timed-out call reported ok'
        Assert ($started.Elapsed.TotalSeconds -lt 25) "the timeout did not terminate the child promptly ($([int]$started.Elapsed.TotalSeconds)s)"

        # --- The poll abort path, which is what the transfer ceiling rides on.
        $aborted = Invoke-GitSafe -Executable $sleeper -RawArguments `
            -GitArgument @('-NoProfile', '-Command', '[Threading.Thread]::Sleep(45000)') -TimeoutSeconds 30 `
            -OnPoll { 'transfer-ceiling' }
        Assert ($aborted.aborted -ceq 'transfer-ceiling') 'the poll abort path did not fire'
        Assert (-not $aborted.timed_out) 'a poll abort was misreported as a timeout'
    }
    catch {
        # Without this a strict-mode error unwinds past every remaining assertion and the suite
        # exits green having run a fraction of itself.
        [void]$script:failures.Add("the suite did not run to completion: $($_.Exception.Message)")
    }
    finally {
        Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($script:failures.Count) {
        [Console]::Error.WriteLine("GitSource self-test FAILED: $($script:failures -join '; ')")
        exit 1
    }
    Write-Host "GitSource self-test passed ($($script:checks) checks)."
    exit 0
}
