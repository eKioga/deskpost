<#
.SYNOPSIS
    Materialize one source-attributed synthesis from a named raw batch as a Notebook article.

.DESCRIPTION
    This helper closes the mechanical gap between scoped raw reading and the existing Notebook
    triage tools. It does not summarize raw material. The Librarian supplies a finished Markdown
    synthesis and names the exact source files it used; the helper validates and hashes those files,
    appends a provenance section, and keeps the topic and master indexes linked.

    Creating a new article is additive and applies directly. Replacing a divergent article can lose
    text, so it requires a preflight, the exact content-bound plan_id, and one approval. All Notebook
    paths are journaled before mutation and restored on failure.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Batch,
    [Parameter(Mandatory = $true)][string]$Topic,
    [Parameter(Mandatory = $true)][string]$TopicTitle,
    [Parameter(Mandatory = $true)][string]$TopicOverview,
    [Parameter(Mandatory = $true)][string]$ArticleSlug,
    [Parameter(Mandatory = $true)][string]$ContentPath,
    [Parameter(Mandatory = $true)][string[]]$SourceFile,
    [string]$WorkspacePath,
    # Which seat owns the Notebook topic this writes. Defaults to LIBRARY_SEAT; there is no
    # default seat, so an unset one is refused rather than guessed at.
    [string]$Seat,
    # Host authorization for the capture-time remote verification. Grammar applies everywhere; the
    # allowlist applies only where a network call happens, and since verification became mandatory
    # this helper is one of those places. It arrives on the command line, never from article text.
    [string[]]$AllowHost,
    # Turn a withheld pin into a refusal. Off by default: an unpinnable batch still compiles, the
    # same as a converted wiki export always has.
    [switch]$RequirePin,
    [switch]$ReplaceExisting,
    [switch]$Preflight,
    [switch]$UserConfirmed,
    [string]$ApprovedPlanId,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'RawSearch.ps1')
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
. (Join-Path $PSScriptRoot 'SourcesBlock.ps1')
# The master index is derived and serialized rather than appended to, so this helper no longer
# composes it. PLAN-multi-desk.md Release 1, steps 1 and 2.
. (Join-Path $PSScriptRoot 'NotebookIndex.ps1')
. (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')

$script:PinTimeoutSeconds = 45

$script:Utf8NoBom = [Text.UTF8Encoding]::new($false)
$script:Utf8Strict = [Text.UTF8Encoding]::new($false, $true)

function ConvertTo-ForwardSlash([string]$Path) { $Path -replace '\\', '/' }

function Split-FirstLine([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    (($Text -split "`r?`n")[0]).Trim()
}

function Get-BytesHash([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
}

function Get-TextHash([string]$Text) {
    Get-BytesHash $script:Utf8NoBom.GetBytes($Text)
}

function Read-StrictUtf8([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    $text = $script:Utf8Strict.GetString($bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    $text
}

function Test-ReparsePath([string]$Root, [string]$RelativePath) {
    $cursor = $Root
    foreach ($segment in $RelativePath.Replace('\', '/').Split('/')) {
        $cursor = Join-Path $cursor $segment
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq [IO.FileAttributes]::ReparsePoint) {
            return $true
        }
    }
    $false
}

function Add-IndexLink([string]$Existing, [string]$Target, [string]$Label) {
    $escaped = [regex]::Escape($Target)
    if ($Existing -cmatch "\[\[$escaped(?:\||\]\])") { return $Existing }
    $line = "- [[$Target|$Label]]`n"
    if ([string]::IsNullOrEmpty($Existing)) { return $line }
    if ($Existing.EndsWith("`r`n`r`n", [StringComparison]::Ordinal) -or $Existing.EndsWith("`n`n", [StringComparison]::Ordinal)) {
        return $Existing + $line
    }
    if ($Existing.EndsWith("`r`n", [StringComparison]::Ordinal)) { return $Existing + "`r`n" + $line }
    if ($Existing.EndsWith("`n", [StringComparison]::Ordinal)) { return $Existing + "`n" + $line }
    $Existing + "`n`n" + $line
}

function Write-NewUtf8File([string]$Path, [string]$Text) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = $script:Utf8NoBom.GetBytes($Text)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    }
    finally { $stream.Dispose() }
}

# --- Upstream pin capture ------------------------------------------------------------------------
# PLAN-book-currency.md step 3. The pin says: these exact bytes came from this commit on this remote
# ref. Everything below exists to make that sentence true rather than plausible, and every path that
# cannot make it true WITHHOLDS the pin instead of weakening it -- the article still compiles and is
# simply `not anchored`, which is what an imported wiki export has always been.

# One repository's identity, sampled before the article's bytes are read. Returns $null when the
# file lies under no repository contained by the batch -- which is the ordinary case for a converted
# wiki export and is never an error.
function Get-BatchRepositoryContext {
    param([string]$BatchPath, [string]$FullPath, [int]$TimeoutSeconds)

    $resolved = Resolve-BatchRepository -BatchRoot $BatchPath -StartPath $FullPath
    if (-not $resolved.found) { return [pscustomobject]@{ ok = $false; reason = $resolved.reason; work_tree = '' } }

    $confirmed = Confirm-BatchRepository -Resolved $resolved -TimeoutSeconds $TimeoutSeconds
    if (-not $confirmed.confirmed) { return [pscustomobject]@{ ok = $false; reason = $confirmed.reason; work_tree = $resolved.work_tree } }

    $read = {
        param($GitArguments)
        $r = Invoke-GitSafe -GitArgument (@('-C', $resolved.work_tree) + $GitArguments) -TimeoutSeconds $TimeoutSeconds
        if (-not $r.ok) { return $null }
        ($r.stdout -split "`r?`n")[0].Trim()
    }

    $head = & $read @('rev-parse', 'HEAD')
    if ([string]::IsNullOrWhiteSpace($head)) { return [pscustomobject]@{ ok = $false; reason = 'the repository has no HEAD commit'; work_tree = $resolved.work_tree } }
    $format = & $read @('rev-parse', '--show-object-format')
    if ([string]::IsNullOrWhiteSpace($format)) { $format = 'sha1' }
    $symbolic = & $read @('symbolic-ref', '--quiet', 'HEAD')
    if ([string]::IsNullOrWhiteSpace($symbolic)) {
        return [pscustomobject]@{ ok = $false; reason = 'HEAD is detached, so there is no ref to record'; work_tree = $resolved.work_tree }
    }
    $upstream = & $read @('rev-parse', '--symbolic-full-name', '@{upstream}')
    if ([string]::IsNullOrWhiteSpace($upstream)) {
        return [pscustomobject]@{ ok = $false; reason = "branch '$symbolic' tracks no upstream, so there is no remote ref to compare against"; work_tree = $resolved.work_tree }
    }
    # refs/remotes/origin/master -> the remote name and the ref as the SERVER advertises it.
    $parts = @($upstream -split '/')
    if ($parts.Count -lt 4 -or $parts[0] -cne 'refs' -or $parts[1] -cne 'remotes') {
        return [pscustomobject]@{ ok = $false; reason = "the upstream ref '$upstream' is not a remote-tracking ref"; work_tree = $resolved.work_tree }
    }
    $remoteName = $parts[2]
    $remoteRef = 'refs/heads/' + (($parts[3..($parts.Count - 1)]) -join '/')
    $originUrl = & $read @('remote', 'get-url', $remoteName)
    if ([string]::IsNullOrWhiteSpace($originUrl)) {
        return [pscustomobject]@{ ok = $false; reason = "remote '$remoteName' has no URL"; work_tree = $resolved.work_tree }
    }

    [pscustomobject]@{
        ok            = $true
        reason        = ''
        work_tree     = $resolved.work_tree
        head          = $head
        object_format = $format
        remote_ref    = $remoteRef
        remote_url    = $originUrl
        status        = (Get-RepositoryStatusSample -WorkTree $resolved.work_tree -TimeoutSeconds $TimeoutSeconds)
    }
}

function Get-RepositoryStatusSample([string]$WorkTree, [int]$TimeoutSeconds) {
    $r = Invoke-GitSafe -GitArgument @('-C', $WorkTree, 'status', '--porcelain', '--untracked-files=no') -TimeoutSeconds $TimeoutSeconds -CarryCheckoutFiltersFor $WorkTree
    if (-not $r.ok) { return '<unreadable>' }
    Get-TextHash $r.stdout
}

# Every cited path must be TRACKED and UNMODIFIED relative to HEAD, asked of git rather than
# computed here.
#
# THE OBVIOUS OPTIMIZATION IS WRONG ON WINDOWS, AND THIS IS MEASURED. Hashing the bytes already in
# hand into a git blob OID and comparing it against ls-tree looks strictly better -- one read, no
# window between the bytes the article cites and the bytes the pin attests. It fails on the first
# real batch. `core.autocrlf` is true by default in Git for Windows, so a checked-out file is CRLF
# while its committed blob is LF: raw/obsidian-help's `en/Bases/Bases syntax.md` is 17,795 bytes on
# disk against 17,429 in the blob, and `git status` calls the tree clean because it applies the
# filter when it compares. A hand-rolled OID is `hash-object --no-filters`, which is a different
# question from the one being asked, and answering it would withhold the pin on essentially every
# Windows clone.
#
# So the claim the pin makes is stated exactly, and it is not byte identity with the commit:
# THESE BYTES ARE GIT'S OWN CHECKOUT OF THAT COMMIT UNDER THIS REPOSITORY'S FILTERS, AND GIT REPORTS
# THEM UNMODIFIED AT HEAD -- sampled before the read and again after, which is what closes the
# window rather than the hashing did. The Currency check compares tree OIDs between commits, never
# bytes, so it rests on exactly this and no more.
function Test-CitedFilesCommitted {
    param([string]$WorkTree, [object[]]$Entries, [int]$TimeoutSeconds)

    $paths = @(@($Entries) | ForEach-Object { $_.repo_relative } | Sort-Object -Unique)
    if (-not $paths.Count) { return [pscustomobject]@{ ok = $true; reason = '' } }

    for ($offset = 0; $offset -lt $paths.Count; $offset += 100) {
        $slice = @($paths[$offset..([Math]::Min($offset + 99, $paths.Count - 1))])

        $tracked = Invoke-GitSafe -GitArgument (@('-C', $WorkTree, 'ls-files', '--error-unmatch', '--') + $slice) -TimeoutSeconds $TimeoutSeconds -CarryCheckoutFiltersFor $WorkTree
        if (-not $tracked.ok) {
            $named = Split-FirstLine $tracked.stderr
            return [pscustomobject]@{ ok = $false; reason = "a cited file is not tracked in this repository ($named)" }
        }

        # exit 0 = no difference, 1 = differs, anything else = git could not answer.
        $unmodified = Invoke-GitSafe -GitArgument (@('-C', $WorkTree, 'diff', '--quiet', 'HEAD', '--') + $slice) -TimeoutSeconds $TimeoutSeconds -CarryCheckoutFiltersFor $WorkTree
        if ($unmodified.exit_code -eq 1) {
            $changed = Invoke-GitSafe -GitArgument (@('-C', $WorkTree, 'diff', '--name-only', 'HEAD', '--') + $slice) -TimeoutSeconds $TimeoutSeconds -CarryCheckoutFiltersFor $WorkTree
            $first = Split-FirstLine $changed.stdout
            return [pscustomobject]@{ ok = $false; reason = "cited file '$first' has uncommitted changes" }
        }
        if ($unmodified.exit_code -ne 0) {
            return [pscustomobject]@{ ok = $false; reason = 'the repository could not compare its working tree against HEAD' }
        }
    }
    [pscustomobject]@{ ok = $true; reason = '' }
}

# The pin's last claim, and the only one the local clone cannot make on its own: that this commit is
# really on that remote. raw/ is user-controlled, so a remote-tracking ref proves nothing by itself.
# A failure here withholds the pin; it never fails the compile, which is what keeps an offline
# compile working -- unanchored rather than refused.
function Test-PinnedCommitOnRemote {
    param([string]$Url, [string]$CommitOid, [string]$RemoteRef, [string[]]$AllowHost, [int]$TimeoutSeconds)

    $normalised = ConvertTo-NormalisedUpstreamUrl $Url
    if (-not $normalised.ok) { return [pscustomobject]@{ ok = $false; reason = $normalised.reason; url = '' } }
    if (-not (Test-UpstreamHostAllowed $normalised.host_name $AllowHost)) {
        return [pscustomobject]@{ ok = $false; reason = "host '$($normalised.host_name)' is not on the allowlist; pass -AllowHost to permit it"; url = '' }
    }

    $scratch = Join-Path ([IO.Path]::GetTempPath()) ('library-pin-' + [Guid]::NewGuid().ToString('n'))
    try {
        New-Item -ItemType Directory -Path $scratch -Force | Out-Null
        $init = Invoke-GitSafe -GitArgument @('init', '--bare', '--quiet', $scratch) -TimeoutSeconds $TimeoutSeconds
        if (-not $init.ok) { return [pscustomobject]@{ ok = $false; reason = 'a scratch object store could not be created'; url = '' } }
        $fetch = Invoke-BoundedFetch -MeasuredPath $scratch -TimeoutSeconds $TimeoutSeconds -RequireFilterAcknowledged `
            -GitArgument @('-C', $scratch, 'fetch', '--quiet', '--filter=blob:none', '--depth', '1', '--no-tags', $normalised.url, $CommitOid)
        if ($fetch.refusal) {
            $reason = switch ($fetch.refusal) {
                'transfer-ceiling'    { 'the remote sent more than the transfer ceiling allows' }
                'source-unreachable'  { 'the remote did not answer within the timeout' }
                'unsupported-filter'  { 'the remote ignored --filter, so a blobless verification is not possible' }
                default               { "the pinned commit is not fetchable from $($normalised.url) on $RemoteRef" }
            }
            return [pscustomobject]@{ ok = $false; reason = $reason; url = '' }
        }
        [pscustomobject]@{ ok = $true; reason = ''; url = $normalised.url }
    }
    finally { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
}

function Get-CompilationPlan {
    param(
        [string]$Workspace,
        [string]$NamedBatch,
        [string]$TopicSlug,
        [string]$TopicName,
        [string]$Overview,
        [string]$PageSlug,
        [string]$DraftPath,
        [string[]]$NamedSources,
        [bool]$AllowReplace,
        [string[]]$HostAllowList,
        [bool]$MustPin
    )

    if ($TopicSlug -cnotmatch '^[a-z0-9][a-z0-9-]*$') { throw 'Topic must be a lowercase slug using letters, digits, and hyphens.' }
    if ($PageSlug -cnotmatch '^[a-z0-9][a-z0-9-]*$') { throw 'ArticleSlug must be a lowercase slug using letters, digits, and hyphens.' }
    if ([string]::IsNullOrWhiteSpace($TopicName)) { throw 'TopicTitle cannot be blank.' }
    if ([string]::IsNullOrWhiteSpace($Overview)) { throw 'TopicOverview cannot be blank.' }
    if ($TopicName.IndexOfAny([char[]]"`r`n|[]") -ge 0) { throw 'TopicTitle must be one wikilink-safe line without brackets or a pipe.' }
    if ($Overview.IndexOf("`r", [StringComparison]::Ordinal) -ge 0 -or $Overview.IndexOf("`n", [StringComparison]::Ordinal) -ge 0) {
        throw 'TopicOverview must be one concise line.'
    }
    if (-not (Test-Path -LiteralPath $DraftPath -PathType Leaf)) { throw "ContentPath is not a file: $DraftPath" }
    if (-not @($NamedSources).Count) { throw 'At least one -SourceFile is required.' }

    $resolvedBatch = Resolve-RawBatch -Workspace $Workspace -Batch $NamedBatch
    if (-not $resolvedBatch.recognised) { throw "Raw batch '$NamedBatch' was refused: $($resolvedBatch.reason)" }

    $draft = Read-StrictUtf8 -Path $DraftPath
    $heading = [regex]::Match($draft, '\A# ([^\r\n]+)(?:\r?\n|\z)')
    if (-not $heading.Success) { throw 'The compiled article must begin with one H1 heading.' }
    if ($draft -cnotmatch '(?m)^## Key Takeaways\s*$') { throw 'The compiled article must contain a ## Key Takeaways section.' }
    if ($draft -cmatch '(?m)^## Sources\s*$') { throw 'Omit ## Sources from ContentPath; this helper generates it from the exact -SourceFile manifest.' }
    $articleTitle = $heading.Groups[1].Value.Trim()
    if ($articleTitle.IndexOfAny([char[]]'|[]') -ge 0) { throw 'The article H1 must not contain brackets or a pipe, because it becomes an index link label.' }

    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $sources = [Collections.Generic.List[object]]::new()
    $sourceFiles = [Collections.Generic.List[object]]::new()
    foreach ($named in @($NamedSources)) {
        $relative = ([string]$named).Replace('\', '/').Trim().Trim('/')
        if ([string]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative) -or $relative.Split('/') -contains '.' -or $relative.Split('/') -contains '..') {
            throw "SourceFile '$named' must be a plain path relative to the named raw batch."
        }
        if ($relative.Split('/') -contains '' -or $relative.IndexOf(':', [StringComparison]::Ordinal) -ge 0) {
            throw "SourceFile '$named' must not contain empty path segments, drive syntax, or alternate data streams."
        }
        if ($relative.IndexOf('`', [StringComparison]::Ordinal) -ge 0 -or $relative.IndexOf("`n", [StringComparison]::Ordinal) -ge 0 -or $relative.IndexOf("`r", [StringComparison]::Ordinal) -ge 0) {
            throw "SourceFile '$named' contains characters that cannot be rendered safely in the provenance block."
        }
        if (-not $seen.Add($relative)) { continue }
        $full = Join-Path $resolvedBatch.path ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $batchRoot = [IO.Path]::GetFullPath($resolvedBatch.path).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $full = [IO.Path]::GetFullPath($full)
        if (-not $full.StartsWith($batchRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw "SourceFile '$relative' does not resolve inside raw/$($resolvedBatch.batch)."
        }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "SourceFile '$relative' is not a file in raw/$($resolvedBatch.batch)." }
        if (Test-ReparsePath -Root $resolvedBatch.path -RelativePath $relative) { throw "SourceFile '$relative' crosses a reparse point; raw compilation never follows one." }
        $rawPath = "raw/$($resolvedBatch.batch)/$relative"
        [void]$sources.Add([pscustomobject][ordered]@{
            path = $rawPath
            sha256 = ''
            provenance = $resolvedBatch.provenance
        })
        [void]$sourceFiles.Add([pscustomobject]@{ raw_path = $rawPath; full = $full; work_tree = '' })
    }

    # --- Repository context, sampled BEFORE the bytes are read ------------------------------------
    # Order is the guard. git reads a repository's own config during setup, so discovery walks the
    # filesystem first and only then lets git confirm; and HEAD plus a working-tree status digest are
    # sampled before hashing and again after, so a checkout that moves mid-compile withholds the pin
    # rather than mis-attributing the bytes to a commit that no longer holds them.
    $contexts = @{}
    $withheld = [Collections.Generic.List[object]]::new()
    foreach ($entry in $sourceFiles) {
        $directory = Split-Path -Parent $entry.full
        if (-not $contexts.ContainsKey($directory)) {
            $contexts[$directory] = Get-BatchRepositoryContext -BatchPath $resolvedBatch.path -FullPath $entry.full -TimeoutSeconds $script:PinTimeoutSeconds
        }
        if ($contexts[$directory].ok) { $entry.work_tree = $contexts[$directory].work_tree }
    }

    # --- Read each file once --------------------------------------------------------------------
    # The read is bracketed by the HEAD and status samples above and below, which is what binds the
    # bytes to the commit; see Test-CitedFilesCommitted for why it is not a blob comparison.
    $byRawPath = @{}
    foreach ($record in $sources) { $byRawPath[$record.path] = $record }
    foreach ($entry in $sourceFiles) {
        $byRawPath[$entry.raw_path].sha256 = Get-BytesHash ([IO.File]::ReadAllBytes($entry.full))
    }

    # --- One pin per distinct repository ----------------------------------------------------------
    $upstreams = [Collections.Generic.List[object]]::new()
    $capturedOn = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
    foreach ($directory in @($contexts.Keys)) {
        if (-not $contexts[$directory].ok) {
            [void]$withheld.Add([pscustomobject]@{ scope = $directory; reason = $contexts[$directory].reason })
        }
    }
    $workspaceRoot = ([IO.Path]::GetFullPath($Workspace)).TrimEnd([IO.Path]::DirectorySeparatorChar)
    foreach ($context in @(@($contexts.Values) | Where-Object { $_.ok } | Sort-Object -Property work_tree -Unique)) {
        $entries = @($sourceFiles | Where-Object { $_.work_tree -ceq $context.work_tree })
        if (-not $entries.Count) { continue }
        $treeRoot = ([IO.Path]::GetFullPath($context.work_tree)).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $repoRoot = ConvertTo-ForwardSlash ($treeRoot.Substring($workspaceRoot.Length).TrimStart([IO.Path]::DirectorySeparatorChar))
        $mapped = @($entries | ForEach-Object {
            [pscustomobject]@{
                repo_relative = (ConvertTo-ForwardSlash ($_.full.Substring($treeRoot.Length).TrimStart([IO.Path]::DirectorySeparatorChar)))
            }
        })

        $committed = Test-CitedFilesCommitted -WorkTree $context.work_tree -Entries $mapped -TimeoutSeconds $script:PinTimeoutSeconds
        if (-not $committed.ok) { [void]$withheld.Add([pscustomobject]@{ scope = $repoRoot; reason = $committed.reason }); continue }

        $headAfter = Invoke-GitSafe -GitArgument @('-C', $context.work_tree, 'rev-parse', 'HEAD') -TimeoutSeconds $script:PinTimeoutSeconds
        $headAfterValue = if ($headAfter.ok) { (Split-FirstLine $headAfter.stdout) } else { '' }
        $statusAfter = Get-RepositoryStatusSample -WorkTree $context.work_tree -TimeoutSeconds $script:PinTimeoutSeconds
        if (($headAfterValue -cne $context.head) -or ($statusAfter -cne $context.status)) {
            [void]$withheld.Add([pscustomobject]@{ scope = $repoRoot; reason = 'the checkout changed while the article was being hashed' })
            continue
        }

        $remote = Test-PinnedCommitOnRemote -Url $context.remote_url -CommitOid $context.head -RemoteRef $context.remote_ref -AllowHost $HostAllowList -TimeoutSeconds $script:PinTimeoutSeconds
        if (-not $remote.ok) { [void]$withheld.Add([pscustomobject]@{ scope = $repoRoot; reason = $remote.reason }); continue }

        if (-not (Test-RecordableField $repoRoot)) {
            [void]$withheld.Add([pscustomobject]@{ scope = $repoRoot; reason = 'the repository root cannot be recorded in a Sources line' })
            continue
        }
        [void]$upstreams.Add([pscustomobject]@{
            url = $remote.url; ref = $context.remote_ref; commit_oid = $context.head
            repo_root = $repoRoot; captured = $capturedOn
        })
    }

    if ($MustPin -and @($withheld).Count) {
        throw ("RequirePin was set but a pin was withheld: " + ((@($withheld) | ForEach-Object { $_.scope + ': ' + $_.reason }) -join '; '))
    }

    $article = $draft.TrimEnd([char[]]"`r`n") + "`n`n" + (Format-SourcesBlock -Upstream @($upstreams) -File @($sources))

    $notebook = Join-Path $Workspace 'notebook'
    if (-not (Test-Path -LiteralPath $notebook -PathType Container)) { throw "Notebook directory not found: $notebook" }
    $masterPath = Join-Path $notebook '_master-index.md'
    $topicPath = Join-Path $notebook $TopicSlug
    $indexPath = Join-Path $topicPath '_index.md'
    $articlePath = Join-Path $topicPath "$PageSlug.md"
    # A topic directory that exists WITHOUT its index is the degenerate state this helper used to
    # create itself, and it is not something a compile may add to: the article would land beside no
    # index, and the render that follows would refuse the whole Notebook. Named here, before an
    # approval is issued, rather than discovered under the lock.
    $topicExists = Test-Path -LiteralPath $topicPath -PathType Container
    if ($topicExists -and -not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
        throw "notebook/$TopicSlug exists with no _index.md. Repair or remove that directory before compiling into it; a topic with no index cannot be rendered into the Notebook master index."
    }
    $indexBefore = if (Test-Path -LiteralPath $indexPath -PathType Leaf) { [IO.File]::ReadAllText($indexPath) } else { '' }
    $articleBefore = if (Test-Path -LiteralPath $articlePath -PathType Leaf) { [IO.File]::ReadAllText($articlePath) } else { $null }
    $indexBase = if ([string]::IsNullOrEmpty($indexBefore)) { "# $TopicName`n`n$($Overview.Trim())`n`n## Articles`n`n" } else { $indexBefore }
    $indexAfter = Add-IndexLink -Existing $indexBase -Target $PageSlug -Label $articleTitle
    # THE MASTER INDEX IS NOT COMPOSED HERE ANY MORE. It is derived from the topic directories and
    # their headings by NotebookIndex.ps1, under the render lock, so this helper's only question is
    # whether it is about to change either of those two things. A new topic changes visibility; a
    # rewritten H1 changes a label. Both take the render lock; neither is the ordinary case, which
    # is a new article inside an existing topic whose heading nobody touched.
    $headingBefore = if ([string]::IsNullOrEmpty($indexBefore)) { '' } else { Get-NotebookTopicHeadingFromText -Text $indexBefore }
    $headingAfter = Get-NotebookTopicHeadingFromText -Text $indexAfter
    $visibilityChanges = (-not $topicExists) -or ($headingBefore -cne $headingAfter)
    # Read outside every lock, and deliberately allowed to be stale: a stale 'no drift' costs one
    # skipped render that the next writer or the gate will report, while a stale 'drift' costs one
    # unnecessary render. Neither can lose a topic, because the render itself rescans under the lock.
    $masterDrift = @(Get-NotebookMasterIndexDrift -Workspace $Workspace)
    $articleHash = Get-TextHash $article
    $existingHash = if ($null -eq $articleBefore) { '' } else { Get-TextHash $articleBefore }
    $articleExists = $null -ne $articleBefore
    $articleUnchanged = $articleExists -and $existingHash -ceq $articleHash
    if ($articleExists -and -not $articleUnchanged -and -not $AllowReplace) {
        throw "Notebook article notebook/$TopicSlug/$PageSlug.md already exists with different content. Use -ReplaceExisting and preflight the replacement."
    }

    $bound = [pscustomobject][ordered]@{
        schema = 1
        operation = 'compile-raw-batch-to-notebook'
        batch = $resolvedBatch.batch
        batch_provenance = $resolvedBatch.provenance
        topic = $TopicSlug
        topic_title = $TopicName
        topic_overview = $Overview
        article_slug = $PageSlug
        article_sha256 = $articleHash
        prior_article_sha256 = $existingHash
        topic_exists = $topicExists
        topic_heading_after = $headingAfter
        index_before_sha256 = Get-TextHash $indexBefore
        index_after_sha256 = Get-TextHash $indexAfter
        sources = @($sources)
        upstreams = @($upstreams)
        allow_host = @(@($HostAllowList) | Sort-Object)
    }
    $digest = Get-TextHash ($bound | ConvertTo-Json -Depth 8 -Compress)
    [pscustomobject]@{
        operation = 'Compile raw batch to Notebook'
        # A compile that would change neither the article nor the topic index changes nothing the
        # master index derives from either, so it is genuinely a no-op. It is NOT reported unchanged
        # while the master index is drifted, though: a compile that leaves a wrong index behind and
        # calls itself a no-op is the kind of quiet lie this whole change exists to remove.
        status = if ($articleUnchanged -and $indexBefore -ceq $indexAfter -and -not $masterDrift.Count) { 'unchanged' } else { 'ready' }
        batch = $resolvedBatch.batch
        batch_provenance = $resolvedBatch.provenance
        source_count = $sources.Count
        sources = @($sources)
        upstreams = @($upstreams)
        pins_withheld = @($withheld)
        article_title = $articleTitle
        article_path = "notebook/$TopicSlug/$PageSlug.md"
        topic_index_path = "notebook/$TopicSlug/_index.md"
        master_index_path = 'notebook/_master-index.md'
        # Named on the plan because it decides which locks this run takes. A reader reading a
        # preflight can see whether the run will serialize against every other Notebook writer or
        # only against its own topic.
        topic_is_new = -not $topicExists
        takes_render_lock = $visibilityChanges -or [bool]$masterDrift.Count
        master_index_drift = @($masterDrift)
        article_exists = $articleExists
        article_unchanged = $articleUnchanged
        replacement = $articleExists -and -not $articleUnchanged
        confirmation_required = $articleExists -and -not $articleUnchanged
        plan_id = "compile-raw-$digest"
        shared_library_write = $false
        next = "Use this article path as source_path in Invoke-LibraryTriage.ps1, or pass its topic to Publish-BookCopy.ps1 / Copy-LocalPagesToProject.ps1."
        _article = $article
        _visibility_changes = $visibilityChanges
        _index_before = $indexBefore
        _index_after = $indexAfter
        _article_path = $articlePath
        _index_path = $indexPath
        _master_path = $masterPath
        _topic_path = $topicPath
        _digest = $digest
    }
}

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$draft = (Resolve-Path -LiteralPath $ContentPath).Path

try {
    $preview = Get-CompilationPlan -Workspace $workspace -NamedBatch $Batch -TopicSlug $Topic -TopicName $TopicTitle `
        -Overview $TopicOverview -PageSlug $ArticleSlug -DraftPath $draft -NamedSources $SourceFile -AllowReplace ([bool]$ReplaceExisting) -HostAllowList $AllowHost -MustPin ([bool]$RequirePin)
    if ($Preflight) {
        # THE TOPIC'S OWNER IS CHECKED BEFORE A PLAN IS ISSUED, not after the reader has approved it
        # -- Retire-Seat's rule, which the reset's own preflight had to learn twice. A compile into
        # another seat's topic is certain to be refused below, so planning it is worse than refusing.
        #
        # SKIPPED WHEN NO SEAT IS NAMED, deliberately: a preflight is a read and reads are
        # unaffected, so a seatless session still gets its preview and meets the claim refusal on the
        # apply path where it always did.
        $previewSeat = Resolve-SeatName -Seat $Seat -StateDirectory (Join-Path $workspace '.claude')
        if ($previewSeat.status -ceq 'named') {
            $ownership = Test-NotebookTopicWritable -Workspace $workspace -Topic $Topic -Seat $previewSeat.seat
            if (-not $ownership.writable) { throw [string]$ownership.reason }
        }
        $public = $preview | Select-Object * -ExcludeProperty _*
        Write-LibraryResult -Result $public -Json:$Json
        exit 0
    }
    # STEP 15b: A NOTEBOOK WRITE IS A MUTATION AND NEEDS THIS SEAT'S LIVE CLAIM. The rule's own
    # rationale is the reason it belongs here specifically: an agent launched directly, inheriting a
    # LIBRARY_SEAT, would carry no claim yet could still change its Notebook -- and reset would then
    # classify genuinely active work as dormant and quarantine it. Checked AFTER the preflight, because
    # a preflight is a read and reads are unaffected.
    $compileSeat = Resolve-SeatName -Seat $Seat -StateDirectory (Join-Path $workspace '.claude')
    if ($compileSeat.status -cne 'named') { throw $compileSeat.message }
    Assert-SeatClaimHeld -StateDirectory (Join-Path $workspace '.claude') -Seat $compileSeat.seat | Out-Null
    if ($preview.confirmation_required -and (-not $UserConfirmed -or [string]::IsNullOrWhiteSpace($ApprovedPlanId))) {
        throw 'Replacement requires -Preflight, one approval, then -UserConfirmed with the exact -ApprovedPlanId.'
    }

    $lock = $null
    $journal = $null
    $topicExisted = Test-Path -LiteralPath $preview._topic_path -PathType Container
    try {
        $lock = Enter-BookLock -Workspace $workspace -BookRoot "notebook/$Topic"
        # A VALID CLAIM AT THIS SEAT IS NOT ENTITLEMENT TO ANOTHER SEAT'S TOPIC (ADR-0019). Asserted
        # under the topic lock, so the answer cannot change under the write it authorises -- and
        # ownership may now change only under that same lock, which is what makes the window closed
        # rather than narrow. Before this, seat B could add material to seat A's topic and seat A's
        # ordinary reset would quarantine it, with B still claimed and still working.
        Assert-NotebookTopicWritable -Workspace $workspace -Topic $Topic -Seat $compileSeat.seat | Out-Null
        $current = Get-CompilationPlan -Workspace $workspace -NamedBatch $Batch -TopicSlug $Topic -TopicName $TopicTitle `
            -Overview $TopicOverview -PageSlug $ArticleSlug -DraftPath $draft -NamedSources $SourceFile -AllowReplace ([bool]$ReplaceExisting) -HostAllowList $AllowHost -MustPin ([bool]$RequirePin)
        if ($current.confirmation_required -and $ApprovedPlanId -cne $current.plan_id) {
            throw "Approved plan_id does not match current content. Re-run -Preflight and approve exactly $($current.plan_id)."
        }
        if ($current.status -ceq 'unchanged') {
            $result = $current | Select-Object * -ExcludeProperty _*
            Write-LibraryResult -Result $result -Json:$Json
            exit 0
        }

        # THE AUTHORITY ONLY: the article and this topic's own _index.md. The master index used to be
        # journaled here as a third path, and it was the one file in the list this operation does not
        # own -- a rollback wrote its pre-run snapshot back over whatever another seat had rendered
        # into it since, losing that seat's topic. It is re-derived in the catch instead, and
        # Write-BookJournal now refuses to record it at all.
        $journal = Write-BookJournal -Workspace $workspace -BookRoot "notebook/$Topic" -Operation 'compile-raw-batch-to-notebook' `
            -OperationDigest $current._digest -Paths @($current._article_path, $current._index_path)

        # TWO PROMOTION RULES, BECAUSE WINDOWS HAS TWO CASES. A directory move cannot replace a
        # non-empty directory, so whole-topic promotion is available for a NEW topic only; a topic
        # that already exists takes individual atomic file replacements instead. Both paths write
        # every file through Write-AtomicText, so a concurrent renderer can never read a half-file.
        $rendered = $null
        if ($current.topic_is_new) {
            # Staged outside notebook/ so a killed run cannot leave a topic directory the renderer
            # would meet with no index in it -- the exact degenerate state step 2 specifies. Same
            # staging root and the same reasoning as Restore-BookSource.ps1.
            $stagingRoot = Join-Path $workspace 'internal/notebook-staging'
            $staging = Join-Path $stagingRoot ([guid]::NewGuid().ToString('n'))
            New-Item -ItemType Directory -Path $staging -Force | Out-Null
            try {
                Write-AtomicText -Path (Join-Path $staging (Split-Path -Leaf $current._article_path)) -Text $current._article | Out-Null
                Write-AtomicText -Path (Join-Path $staging '_index.md') -Text $current._index_after | Out-Null
                # Readback in staging, before anything is visible: a page that did not land is a
                # refusal here rather than a promoted topic that has to be unwound.
                if ((Get-TextHash ([IO.File]::ReadAllText((Join-Path $staging (Split-Path -Leaf $current._article_path))))) -cne (Get-TextHash $current._article)) { throw 'Staged Notebook article failed readback verification; nothing was promoted.' }
                if ((Get-TextHash ([IO.File]::ReadAllText((Join-Path $staging '_index.md')))) -cne (Get-TextHash $current._index_after)) { throw 'Staged topic index failed readback verification; nothing was promoted.' }
                # THE CRITICAL SECTION. One directory move, the scan, the write, the readback.
                $rendered = Invoke-NotebookRender -Workspace $workspace -CommitArgument @($staging, $current._topic_path, $Topic) -Commit {
                    param($From, $To, $Slug)
                    if (Test-Path -LiteralPath $To) { throw "notebook/$Slug appeared while this compile was staging; nothing was promoted." }
                    [IO.Directory]::Move($From, $To)
                }
                # EVERY NOTEBOOK WRITER RECORDS OWNERSHIP (step 21), never just the first one found.
                # Naming only the compiler was caught as a defect twice in Release 1's review, and
                # Triage's Notebook route was the worse of the two -- so all three creators record,
                # and reset refuses a topic none of them claimed rather than guessing at it.
                #
                # AFTER the promotion, never before: a record naming a topic that failed to promote
                # is a record reset would act on.
                Set-NotebookTopicOwner -Workspace $workspace -Topic $Topic -Seat $compileSeat.seat
            }
            finally {
                if (Test-Path -LiteralPath $staging -PathType Container) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
                if ((Test-Path -LiteralPath $stagingRoot -PathType Container) -and -not @(Get-ChildItem -LiteralPath $stagingRoot -Force -ErrorAction SilentlyContinue).Count) {
                    Remove-Item -LiteralPath $stagingRoot -Force -ErrorAction SilentlyContinue
                }
            }
        }
        else {
            # Create-only for a NEW article, kept deliberately. Write-AtomicText would overwrite a
            # file that appeared since the plan was re-derived, and the topic lock excludes other
            # Library writers but not every process. CreateNew refuses instead.
            if (-not $current.article_exists) { Write-NewUtf8File -Path $current._article_path -Text $current._article }
            elseif (-not $current.article_unchanged) { Write-AtomicText -Path $current._article_path -Text $current._article | Out-Null }
            # UNCONDITIONALLY ATOMIC, EVEN WHEN THE RENDER LOCK IS SKIPPED. This is the write that
            # happens with no render lock held in the ordinary case, so truncating in place here is
            # precisely what would buy the narrow lock with a torn read.
            if ($current._index_before -cne $current._index_after) { Write-AtomicText -Path $current._index_path -Text $current._index_after | Out-Null }

            if ((Get-TextHash ([IO.File]::ReadAllText($current._article_path))) -cne (Get-TextHash $current._article)) { throw 'Notebook article failed readback verification.' }
            if ((Get-TextHash ([IO.File]::ReadAllText($current._index_path))) -cne (Get-TextHash $current._index_after)) { throw 'Topic index failed readback verification.' }

            # The render lock is taken ADDITIONALLY, and only when this run changed something the
            # master index derives from: the topic's heading, or a drifted index needing repair.
            if ($current.takes_render_lock) { $rendered = Invoke-NotebookRender -Workspace $workspace }
        }

        $result = $current | Select-Object * -ExcludeProperty _*
        $result.status = 'complete'
        $result | Add-Member -NotePropertyName journal_path -NotePropertyValue $journal.journal_path
        $result | Add-Member -NotePropertyName master_index_rendered -NotePropertyValue ($null -ne $rendered)
        Write-LibraryResult -Result $result -Json:$Json
    }
    catch {
        $failure = $_.Exception.Message
        if ($null -ne $journal) {
            try {
                Restore-BookJournal -JournalPath $journal.journal_path | Out-Null
                if (-not $topicExisted -and (Test-Path -LiteralPath $preview._topic_path -PathType Container) -and -not @(Get-ChildItem -LiteralPath $preview._topic_path -Force).Count) {
                    Remove-Item -LiteralPath $preview._topic_path -Force
                }
                # LAST, AND ONLY NOW. The topics on disk are the authority and they are back, so the
                # index is re-derived from them inside the render lock -- which is also the only way
                # a topic this run promoted and then had to withdraw leaves the index. The removal
                # above has to come first: a topic directory left standing with no _index.md is what
                # the render refuses.
                Invoke-NotebookRenderAfterRollback -Workspace $workspace | Out-Null
            }
            catch { throw "$failure Rollback also failed: $($_.Exception.Message)" }
        }
        throw $failure
    }
    finally { if ($null -ne $lock) { Exit-BookLock -Lock $lock } }
}
catch { throw }
