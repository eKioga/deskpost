<#
.SYNOPSIS
    Copy the reviewed public allowlist into a staging tree, scan it, and only then make it a
    repository with one commit.

.DESCRIPTION
    PLAN-public-release.md step 14. The order of operations is the entire design:

        resolve the allowlist -> copy to staging -> SCAN -> git init -> git add -> SCAN -> commit

    and on any hit at either scan the whole staging folder is removed. Not the offending file: the
    folder. A partially-sanitised export is the thing most likely to be published by somebody who
    remembers that the tool "mostly worked", so there is no state between "clean tree" and "no
    tree" for anyone to reach for.

    WHY THE SECOND SCAN RUNS BEFORE THE COMMIT AND NOT AFTER IT. The plan says the commit's objects
    are scanned again, and the obvious reading -- commit, then scan -- is a scan that cannot work.
    Invoke-IdentityScan reads `git diff --cached`, so after a commit the index and HEAD agree, the
    staged set is empty, and it reports a confident pass over zero blobs. The objects in the index
    after `git add -A` are byte-identical to the objects the commit will create, so scanning there
    reads exactly what the plan means and has the additional property that a failure leaves no
    commit to have to unmake. `staged_blob_count` is asserted non-zero for the same reason: a
    vacuous pass and a real one must not look alike.

    THE DENYLIST COMES FROM THE WORKSPACE, NOT FROM THE STAGING TREE. `Get-DeploymentScanDenylist`
    reads this machine's generated state -- the endpoint, the collection id, the share root. Those
    values are exactly what must not appear in the staged copy, so the question asked of every
    staged file is "does this carry the deployment of the machine that produced it". Pointing the
    denylist at the staging tree would ask a tree with no generated state whether it matches its own
    absent configuration, which is an answer of yes, always clean.

    A RULE THAT MATCHES AN UNTRACKED FILE REFUSES THE RUN. tools/PublicTreeAllowlist.ps1 resolves
    against the filesystem, because that is what "would be exported" means. But a file git has never
    seen has been through no commit and no review, and this tree holds the reader's Notebook, raw
    material and Shelf. Those files are named and the run stops. The scan in DeploymentScan.ps1
    still READS them, which is the right division: the scan's job is to notice a leak wherever it
    is, and this tool's job is to refuse to carry one out.

    GITLEAKS RUNS IN BOTH PASSES AND IN TWO DIFFERENT MODES, because before `git init` there is no
    repository for `gitleaks protect --staged` to read. The first pass uses `detect --no-git` over
    the directory; the second uses the repository-aware mode the rest of the product already calls.
    Its ABSENCE is reported and never counted as clean -- "not installed" and "found nothing" are
    different answers.

    `-Preflight` and `plan_id` like every other helper: the id binds both roots, every relative path
    and every source hash, so a tree that changed since the preview refuses the approval.

.PARAMETER Destination
    The staging folder. Must be outside the workspace and must not already hold files.

.PARAMETER Preflight
    Read-only. Reports the file set, the byte count, missing rules, any untracked matches, and a
    `plan_id`. Copies nothing and creates no repository.

.PARAMETER UserConfirmed / .PARAMETER ApprovedPlanId
    Execution needs both, and the `plan_id` must be the one the preflight printed for this exact
    tree.
#>

[CmdletBinding()]
param(
    [string]$Workspace,
    [string]$Destination,
    [switch]$Preflight,
    [switch]$UserConfirmed,
    [string]$ApprovedPlanId,
    [string]$TermRoot,
    [string]$Mode = $env:LIBRARY_IDENTITY_SCAN,
    [switch]$DriftReport,
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'PublicTreeAllowlist.ps1')
. (Join-Path $PSScriptRoot 'DeploymentScan.ps1')

$script:PublicTreeExportVersion = 1

function Get-PublicTreeTextDigest {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
}

function Get-PublicTreeFileHash {
    param([Parameter(Mandatory)][string]$Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Invoke-PublicTreeGit {
    <#
        Every git call in this file goes through here, and the reason is a trap this session walked
        straight into.

        This script runs with $ErrorActionPreference = 'Stop', which is right for cmdlets. Under
        'Stop', Windows PowerShell turns ANY line a native command writes to stderr into a
        terminating NativeCommandError -- including a warning. `git add` saying "LF will be replaced
        by CRLF the next time Git touches it" killed the whole self-test while git itself exited 0.
        `2>$null` does not help: the ErrorRecord is manufactured on the PowerShell side of the pipe,
        after the redirection.

        So the preference is lowered for the duration of the call and restored afterwards, and the
        result is judged the way a native command should be judged -- by its exit code. Output comes
        back merged so a caller can report what git said; nothing here parses it for success.
    #>
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory
    )

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        Push-Location -LiteralPath $WorkingDirectory
        try { $output = & git @Arguments 2>&1 }
        finally { Pop-Location }
        [pscustomobject]@{ exit_code = $LASTEXITCODE; output = @($output | ForEach-Object { [string]$_ }) }
    }
    finally { $ErrorActionPreference = $previous }
}

function Get-PublicTreeCommitIdentity {
    <#
        The name and address git will actually stamp on the commit, for BOTH roles.

        `git var GIT_AUTHOR_IDENT` rather than `git config user.email`, and the difference is not
        academic. `git config` reports what a config file says; `git var` reports what git has
        RESOLVED, which is the config plus the GIT_AUTHOR_* and GIT_COMMITTER_* environment
        overrides plus its own fallbacks. Those are different answers, and the one that reaches
        public history is git's. Reading the config also asks the wrong repository: a staging tree
        created by `git init` a moment ago has no local config at all, so a local override in the
        workspace is invisible there while the global identity it will actually use is the thing
        nobody looked at.

        AUTHOR AND COMMITTER ARE SCANNED SEPARATELY because they can differ, and a rebase or a
        `--author` flag is exactly how they come to. Both are published.

        `git var` returns `Name <email> 1758300000 -0700`. The timestamp is cut off: it is not
        identity, and leaving it in would make two runs of the same tree produce different text.
    #>
    param([Parameter(Mandatory)][string]$RepositoryPath)

    $idents = [Collections.Generic.List[string]]::new()
    $authorName = ''
    $authorEmail = ''
    foreach ($variable in @('GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT')) {
        $run = Invoke-PublicTreeGit -Arguments @('var', $variable) -WorkingDirectory $RepositoryPath
        if ($run.exit_code -ne 0) {
            return [pscustomobject]@{ ok = $false; identities = @(); name = ''; email = ''; detail = ((@($run.output) | Select-Object -First 2) -join ' | ') }
        }
        $line = ((@($run.output) -join '')).Trim()
        $cut = $line.LastIndexOf('>')
        if ($cut -ge 0) { $line = $line.Substring(0, $cut + 1) }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        [void]$idents.Add($line)
        if ($variable -eq 'GIT_AUTHOR_IDENT' -and $line -match '^(.*?)\s*<([^>]*)>$') {
            $authorName = $Matches[1].Trim()
            $authorEmail = $Matches[2].Trim()
        }
    }
    if (-not $idents.Count -or [string]::IsNullOrWhiteSpace($authorEmail)) {
        return [pscustomobject]@{ ok = $false; identities = @(); name = ''; email = ''; detail = 'git var returned no usable identity' }
    }
    [pscustomobject]@{ ok = $true; identities = @($idents | Sort-Object -Unique); name = $authorName; email = $authorEmail; detail = '' }
}

function Get-PublicTreeTrackedSet {
    <#
        `git ls-files` as a case-insensitive lookup. Case-insensitive because NTFS is: a rule that
        resolved `Tools/Thing.ps1` and a git index holding `tools/Thing.ps1` name one file, and
        reporting that as untracked would be a refusal nobody could act on.
    #>
    param([Parameter(Mandatory)][string]$Workspace)

    $listed = Invoke-PublicTreeGit -Arguments @('ls-files') -WorkingDirectory $Workspace
    if ($listed.exit_code -ne 0) { throw "git ls-files failed in $Workspace, so nothing could be told tracked from untracked." }

    $set = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $listed.output) { if (-not [string]::IsNullOrWhiteSpace($path)) { [void]$set.Add([string]$path) } }
    $set
}

function New-PublicTreeExportPlan {
    <#
        Everything the run needs, decided before anything is written, and a plan_id that binds it.
    #>
    param(
        [Parameter(Mandatory)][string]$Workspace,
        [Parameter(Mandatory)][string]$Destination
    )

    $files = @(Get-PublicTreeFiles -Workspace $Workspace)
    if (-not $files.Count) {
        throw "The allowlist resolved to no files under $Workspace, so this export would publish an empty tree rather than the product."
    }

    $tracked = Get-PublicTreeTrackedSet -Workspace $Workspace
    $untracked = @($files | Where-Object { -not $tracked.Contains($_) })

    $entries = [Collections.Generic.List[object]]::new()
    $bytes = [long]0
    $digestLines = [Collections.Generic.List[string]]::new()
    [void]$digestLines.Add('workspace=' + ([IO.Path]::GetFullPath($Workspace).TrimEnd('\', '/')))
    [void]$digestLines.Add('destination=' + ([IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')))
    [void]$digestLines.Add('version=' + $script:PublicTreeExportVersion)
    foreach ($relative in $files) {
        $full = Join-Path $Workspace $relative
        $hash = Get-PublicTreeFileHash -Path $full
        $length = (Get-Item -LiteralPath $full -Force).Length
        $bytes += $length
        [void]$entries.Add([pscustomobject]@{ path = $relative; sha256 = $hash; bytes = $length })
        [void]$digestLines.Add($relative + ' ' + $hash)
    }

    [pscustomobject]@{
        files       = @($entries)
        file_count  = $entries.Count
        byte_count  = $bytes
        untracked   = @($untracked)
        missing     = @(Get-PublicTreeMissingRules -Workspace $Workspace)
        plan_id     = 'export-public-tree-' + (Get-PublicTreeTextDigest ($digestLines -join "`n"))
    }
}

# ==================================================================================================
# THE SEED RECORD
# ==================================================================================================
#
# PLAN-public-release.md step 14, ruled 2026-09-20: THIS TOOL SEEDS A PUBLIC REPOSITORY ONCE AND
# NEVER UPDATES ONE. Every run is a `git init`, so every export is an UNRELATED history, and pushing
# a second one over a published repository is a forced replacement that breaks every clone and fork.
# ADR-0031 already routes change through ordinary commits -- reviewed on GitHub, merged at Forgejo --
# and this tool is not on that route.
#
# THE GUARD IS WHAT THE TOOL CAN ACTUALLY SEE. The obvious phrasing, "refuse a destination whose
# repository it did not create", cannot be implemented here: this tool never touches a remote at all.
# It stops at a staging tree with one commit and no remote, and the destructive act happens later, in
# somebody's hand-typed push. What it CAN know is whether it has already seeded from this workspace,
# so that is what it records and that is what it refuses.
#
# AND THE REFUSAL IS THE DRIFT REPORT. Somebody re-running the export is asking "how do I get my
# changes out". The useful answer is the list of allowlisted files that have changed since the seed,
# delivered at the moment they are about to do the destructive thing rather than in a document.
#
# THE RECORD LIVES UNDER internal/, WHICH IS GITIGNORED AND NOT ALLOWLISTED. It is machine-local
# state about what this machine did, so it is neither committed nor exported -- and a contributor who
# clones the repository has no record and can seed their own public repository, which is correct.

function Get-PublicTreeSeedPath {
    param([Parameter(Mandatory)][string]$Workspace)
    Join-Path $Workspace 'internal\public-tree-seed.json'
}

function Read-PublicTreeSeed {
    <#
        The record, or $null if this workspace has never seeded. A record that exists but cannot be
        read is NOT treated as absence: a guard that fails open is not a guard.
    #>
    param([Parameter(Mandatory)][string]$Workspace)

    $path = Get-PublicTreeSeedPath -Workspace $Workspace
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }

    $text = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false))
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw "The seed record at $path is empty, so this workspace cannot say whether it has already seeded a public repository. Nothing was written."
    }
    $record = $null
    try { $record = $text | ConvertFrom-Json }
    catch {
        throw "The seed record at $path is not readable JSON ($([string]$_.Exception.Message)), so this workspace cannot say whether it has already seeded a public repository. Nothing was written."
    }
    foreach ($required in @('destination', 'commit', 'seeded_utc', 'files')) {
        if ($record.PSObject.Properties.Name -notcontains $required) {
            throw "The seed record at $path has no '$required' field, so it cannot describe what was seeded. Nothing was written."
        }
    }
    $record
}

function Get-PublicTreeSeedDrift {
    <#
        What the allowlisted tree has done since the seed. Both sides are path + sha256, so this
        compares CONTENT: a touched file with the same bytes is not drift, and a file whose bytes
        changed is, whatever its timestamp says.
    #>
    param(
        [Parameter(Mandatory)][AllowNull()]$Seed,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Files
    )

    $seeded = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
    if ($Seed -and ($Seed.PSObject.Properties.Name -contains 'files')) {
        foreach ($entry in @($Seed.files)) {
            if (-not $entry) { continue }
            $names = $entry.PSObject.Properties.Name
            if (($names -contains 'path') -and ($names -contains 'sha256')) { $seeded[[string]$entry.path] = [string]$entry.sha256 }
        }
    }

    $changed = [Collections.Generic.List[string]]::new()
    $added = [Collections.Generic.List[string]]::new()
    $removed = [Collections.Generic.List[string]]::new()
    $unchanged = 0
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

    foreach ($entry in @($Files)) {
        $relative = [string]$entry.path
        [void]$seen.Add($relative)
        $was = ''
        if ($seeded.TryGetValue($relative, [ref]$was)) {
            if ($was -cne [string]$entry.sha256) { [void]$changed.Add($relative) } else { $unchanged++ }
        }
        else { [void]$added.Add($relative) }
    }
    foreach ($relative in $seeded.Keys) { if (-not $seen.Contains($relative)) { [void]$removed.Add($relative) } }

    [pscustomobject]@{
        changed         = @($changed | Sort-Object)
        added           = @($added | Sort-Object)
        removed         = @($removed | Sort-Object)
        unchanged_count = $unchanged
        total_count     = $changed.Count + $added.Count + $removed.Count
    }
}

function Format-PublicTreeSeedDrift {
    param([Parameter(Mandatory)]$Drift)
    $lines = [Collections.Generic.List[string]]::new()
    foreach ($relative in @($Drift.changed)) { [void]$lines.Add('changed ' + $relative) }
    foreach ($relative in @($Drift.added))   { [void]$lines.Add('added ' + $relative) }
    foreach ($relative in @($Drift.removed)) { [void]$lines.Add('removed ' + $relative) }
    if (-not $lines.Count) { return 'nothing -- the allowlisted tree is byte-identical to the seed' }
    $lines -join '; '
}

function Write-PublicTreeSeed {
    <#
        Written only after the commit exists, and read back before the caller is told the export
        succeeded. A record that cannot be read back is a guard that will not fire next time, which
        is the one failure here that must not be quiet.
    #>
    param(
        [Parameter(Mandatory)][string]$Workspace,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$PlanId,
        [Parameter(Mandatory)][string]$Commit,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Files,
        # A seed that happened before this guard existed knows its own date better than the clock
        # does, and where its file list came from. Both default to the ordinary case: now, and no
        # provenance, which is what every export written by this tool records.
        [string]$SeededUtc,
        [string]$Provenance
    )

    if ([string]::IsNullOrWhiteSpace($SeededUtc)) { $SeededUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ') }

    $path = Get-PublicTreeSeedPath -Workspace $Workspace
    $parent = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

    $record = [pscustomobject]@{
        note        = ('Written by tools/Export-PublicTree.ps1. Its presence REFUSES a second export from this workspace: ' +
                       'the tool seeds a public repository once (PLAN-public-release.md step 14, ADR-0031) and change after ' +
                       'the seed travels as ordinary commits in a clone of the seeded repository. Delete this file only to ' +
                       'seed a DIFFERENT public repository.')
        seeded_utc  = $SeededUtc
        provenance  = $Provenance
        workspace   = $Workspace
        destination = $Destination
        plan_id     = $PlanId
        commit      = $Commit
        file_count  = @($Files).Count
        files       = @($Files | ForEach-Object { [pscustomobject]@{ path = [string]$_.path; sha256 = [string]$_.sha256 } })
    }
    [IO.File]::WriteAllText($path, ($record | ConvertTo-Json -Depth 5) + "`n", [Text.UTF8Encoding]::new($false))

    $back = Read-PublicTreeSeed -Workspace $Workspace
    if ((-not $back) -or ($back.commit -cne $Commit) -or (@($back.files).Count -ne @($Files).Count)) {
        throw ("The export SUCCEEDED and its staging tree is at $Destination, but the seed record at $path did not read back as " +
               'written -- so a second export from this workspace would not be refused. Fix the record before pushing anything.')
    }
    $path
}

function Invoke-PublicTreeGitleaksDirectory {
    <#
        The first pass's gitleaks, over a directory that is not a repository yet. `protect --staged`
        cannot read one, so this is `detect --no-git`. Absence is reported, never assumed clean.
    #>
    param([Parameter(Mandatory)][string]$Path)

    $tool = Get-Command gitleaks -ErrorAction SilentlyContinue
    if (-not $tool) { return [pscustomobject]@{ ran = $false; clean = $false; detail = 'gitleaks is not installed, so nothing scanned the staged tree on this machine' } }
    # Same native-stderr rule as Invoke-PublicTreeGit: gitleaks writes its progress to stderr, and
    # under 'Stop' that would terminate the export on a clean scan.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $tool.Source 'detect' '--no-git' '--source' $Path '--no-banner' '--redact' 2>&1
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previous }
    if ($code -eq 0) { return [pscustomobject]@{ ran = $true; clean = $true; detail = 'gitleaks found nothing in the staged tree' } }
    [pscustomobject]@{ ran = $true; clean = $false; detail = ('gitleaks reported a finding in the staged tree: ' + ((@($out | ForEach-Object { [string]$_ }) | Select-Object -Last 6) -join ' | ')) }
}

function Get-PublicTreeStagedSources {
    <#
        Every staged file as a scannable source. Binary files are skipped for the same reason the
        rest of the product skips them: a file with no lines has no line to name in a refusal.
    #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string[]]$Relatives)

    $sources = [Collections.Generic.List[object]]::new()
    foreach ($relative in $Relatives) {
        $full = Join-Path $Path $relative
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        $text = ''
        try { $text = [IO.File]::ReadAllText($full, [Text.UTF8Encoding]::new($false)) } catch { continue }
        if ($text.IndexOf([char]0) -ge 0) { continue }
        [void]$sources.Add([pscustomobject]@{ source = $relative; text = $text })
    }
    @($sources)
}

function Remove-PublicTreeStaging {
    <#
        The whole folder, and then PROOF that it is gone.

        This is the one function in the file whose failure would be worse than the leak it is
        cleaning up after, and it failed the first time it was asked to do real work. Once `git
        init` has run, the staging tree holds git's object and pack files, which git marks
        READ-ONLY on Windows. `Remove-Item -Recurse -Force` does not reliably clear that attribute
        on every item it walks, and the original call swallowed the failure with
        `-ErrorAction SilentlyContinue` -- so a refusal would announce that the whole staging folder
        had been discarded while the folder, with a committed repository in it, sat on disk.

        So: clear the attribute on every item first, remove, and then verify. A discard that cannot
        prove itself throws, because the alternative is a refusal message that lies.
    #>
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }

    # A DIRECTORY CANNOT BE DELETED WHILE IT IS SOMEBODY'S CURRENT DIRECTORY, and on Windows that
    # is a whole process's worth of state, not this function's. Every git call in the export runs
    # under Push-Location inside the staging tree, and PowerShell's location stack is not the same
    # thing as the process working directory that the filesystem actually enforces: .NET keeps its
    # own, and Push-Location does not always move it back. So the process is walked out of the tree
    # before anything is removed. Without this, the first refusal that happens AFTER `git init`
    # leaves the folder standing and reports a deletion error in place of the refusal that mattered.
    $parent = Split-Path -Parent $Path
    if ([string]::IsNullOrWhiteSpace($parent)) { $parent = [IO.Path]::GetTempPath() }
    try { [IO.Directory]::SetCurrentDirectory($parent) } catch { }
    try { Set-Location -LiteralPath $parent -ErrorAction SilentlyContinue } catch { }

    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue)) {
        try { if ($item.Attributes -band [IO.FileAttributes]::ReadOnly) { $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly) } }
        catch { }
    }

    $removalError = $null
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable removalError

    if (Test-Path -LiteralPath $Path) {
        # One retry: a scanner or an indexer holding a handle for a moment is common on Windows and
        # is not the same failure as a permission that will never change.
        Start-Sleep -Milliseconds 400
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable removalError
    }
    if (Test-Path -LiteralPath $Path) {
        # The underlying error is carried into the message. A refusal that cannot say WHY it could
        # not clean up leaves the reader with a folder and no idea what is holding it.
        $why = ''
        if ($removalError) { $why = ' The last error was: ' + (@($removalError | ForEach-Object { [string]$_ }) | Select-Object -First 2) -join ' | ' }
        throw ("The staging folder $Path could not be removed, so it is still on disk and may hold material that failed a scan. " +
               'Delete it by hand before anything is published from it.' + $why)
    }
}

function Invoke-PublicTreeExport {
    param(
        [Parameter(Mandatory)][string]$Workspace,
        [Parameter(Mandatory)][string]$Destination,
        [switch]$Preflight,
        [switch]$UserConfirmed,
        [string]$ApprovedPlanId,
        [string]$TermRoot,
        [string]$Mode
    )

    $workspaceFull = [IO.Path]::GetFullPath($Workspace).TrimEnd('\', '/')
    $destinationFull = [IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')

    # --- the refusals that come before a plan_id is worth anything -------------------------------
    if ($destinationFull -eq $workspaceFull) { throw 'The destination is the workspace itself. Nothing was written.' }
    if ($destinationFull.StartsWith($workspaceFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The destination $destinationFull is inside the workspace, so the export would copy itself and the allowlist would start matching the staging tree. Nothing was written."
    }
    if ($workspaceFull.StartsWith($destinationFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The workspace is inside the destination $destinationFull. Nothing was written."
    }
    if ((Test-Path -LiteralPath $destinationFull -PathType Container) -and
        @(Get-ChildItem -LiteralPath $destinationFull -Force -ErrorAction SilentlyContinue).Count) {
        throw "The destination $destinationFull already holds files. This tool only ever writes a fresh tree, because a merge into an existing one is how a file nobody reviewed gets published. Nothing was written."
    }

    $plan = New-PublicTreeExportPlan -Workspace $workspaceFull -Destination $destinationFull
    $seed = Read-PublicTreeSeed -Workspace $workspaceFull

    if ($Preflight) {
        # A preflight against a seeded workspace is still worth running -- it copies nothing, and
        # "what would this rule export today" is a legitimate question after the seed. It says so
        # plainly rather than printing a next step that will be refused.
        $nextStep = "Rerun with -UserConfirmed -ApprovedPlanId $($plan.plan_id)."
        if ($seed) {
            $driftNow = Get-PublicTreeSeedDrift -Seed $seed -Files @($plan.files)
            $nextStep = ("This workspace already seeded $($seed.destination) on $($seed.seeded_utc), so there is no next step here: " +
                         "an execution would be refused. $($driftNow.total_count) allowlisted file(s) have changed since the seed -- " +
                         'run -DriftReport to list them, and carry them over as ordinary commits in a clone of the seeded repository.')
        }
        return [pscustomobject]@{
            operation       = 'Export the public tree'
            status          = 'preflight'
            workspace       = $workspaceFull
            destination     = $destinationFull
            file_count      = $plan.file_count
            byte_count      = $plan.byte_count
            untracked_count = $plan.untracked.Count
            untracked       = @($plan.untracked)
            missing_rules   = @($plan.missing)
            plan_id         = $plan.plan_id
            already_seeded  = [bool]$seed
            scope           = ('Copies ' + $plan.file_count + ' allowlisted file(s) to the destination, scans the staged tree with this ' +
                               'workspace''s deployment denylist, the identity denylist and gitleaks, discards the whole staging folder ' +
                               'on any hit, and only then runs git init, git add and one commit -- scanning the index before the commit.')
            next            = $nextStep
        }
    }

    # --- THE SEED GUARD ---------------------------------------------------------------------------
    #
    # Ahead of every other execution refusal, including the plan_id check, because a second export is
    # not a stale approval to be corrected -- it is the wrong operation, and the reader should be told
    # what the right one is rather than nudged toward a fresh plan_id.
    if ($seed) {
        $drift = Get-PublicTreeSeedDrift -Seed $seed -Files @($plan.files)
        throw ("This workspace already seeded a public repository: $($seed.destination), commit $($seed.commit), on $($seed.seeded_utc). " +
               'Every export is a fresh `git init`, so pushing another one over that repository is a FORCED REPLACEMENT that breaks ' +
               'every clone and fork. Change after the seed travels as ordinary commits in a clone of the seeded repository, reviewed ' +
               "on GitHub and merged at Forgejo (ADR-0031). Changed since the seed ($($drift.total_count)): $(Format-PublicTreeSeedDrift -Drift $drift). " +
               "Nothing was written. -Preflight and -DriftReport still work; to seed a DIFFERENT repository, delete $(Get-PublicTreeSeedPath -Workspace $workspaceFull).")
    }

    if (-not $UserConfirmed) { throw "Nothing was written: rerun with -Preflight, read what it reports, then rerun with -UserConfirmed -ApprovedPlanId $($plan.plan_id)." }
    if ([string]::IsNullOrWhiteSpace($ApprovedPlanId)) { throw "Nothing was written: pass the preflight's exact plan_id as -ApprovedPlanId ($($plan.plan_id))." }
    if ($ApprovedPlanId -cne $plan.plan_id) {
        throw ("The workspace changed since that preflight, so the approved plan_id no longer describes it. " +
               "Rerun the preflight and approve the current plan_id ($($plan.plan_id)). Nothing was written.")
    }
    if ($plan.untracked.Count) {
        throw ("$($plan.untracked.Count) allowlisted path(s) are not tracked by git, so they have been through no commit and no review: " +
               (@($plan.untracked) -join ', ') +
               '. Track them or exclude them in tools/PublicTreeAllowlist.ps1. Nothing was written.')
    }

    # --- copy ------------------------------------------------------------------------------------
    New-Item -ItemType Directory -Path $destinationFull -Force | Out-Null
    $relatives = @($plan.files | ForEach-Object { $_.path })
    foreach ($entry in $plan.files) {
        $from = Join-Path $workspaceFull $entry.path
        $to = Join-Path $destinationFull $entry.path
        $parent = Split-Path -Parent $to
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Copy-Item -LiteralPath $from -Destination $to -Force
        $copiedHash = Get-PublicTreeFileHash -Path $to
        if ($copiedHash -cne $entry.sha256) {
            Remove-PublicTreeStaging -Path $destinationFull
            throw "The copy of $($entry.path) did not hash back to its source. The staging folder was discarded and nothing was published."
        }
    }

    # --- PASS ONE: the staged tree, before it is a repository ------------------------------------
    $denylist = @(Get-DeploymentScanDenylist -Workspace $workspaceFull)
    $deploymentHits = @(Find-DeploymentScanHits -Workspace $destinationFull -Files $relatives -Denylist $denylist)

    $terms = Get-IdentityScanTerms -TermRoot $TermRoot
    $contributor = ($Mode -and $Mode.Trim().ToLowerInvariant() -eq 'contributor')
    $sources = @(Get-PublicTreeStagedSources -Path $destinationFull -Relatives $relatives)
    $identityHits = @()
    if ($terms.deny_present) {
        $identityHits = @(Find-IdentityScanHits -Sources $sources -DenyTerms $terms.deny -AllowTerms $terms.allow)
    }
    elseif (-not $contributor) {
        Remove-PublicTreeStaging -Path $destinationFull
        throw ("No identity denylist at $($terms.deny_path), so nothing scanned the staged tree for the reader's own identity. " +
               'The staging folder was discarded. Create the denylist, or set LIBRARY_IDENTITY_SCAN=contributor to fall back to gitleaks alone.')
    }

    $gitleaksOne = Invoke-PublicTreeGitleaksDirectory -Path $destinationFull

    $refusals = [Collections.Generic.List[string]]::new()
    foreach ($hit in $deploymentHits) { [void]$refusals.Add("deployment $($hit.file):$($hit.line) [$($hit.kind)] $($hit.match)") }
    foreach ($hit in $identityHits) { [void]$refusals.Add("identity $($hit.source):$($hit.line) $($hit.match)") }
    if ($gitleaksOne.ran -and -not $gitleaksOne.clean) { [void]$refusals.Add($gitleaksOne.detail) }
    if ($refusals.Count) {
        Remove-PublicTreeStaging -Path $destinationFull
        throw ("$($refusals.Count) finding(s) in the staged tree, so the WHOLE staging folder was discarded and no repository was created: " +
               (@($refusals | Sort-Object -Unique) -join '; '))
    }

    # --- the repository, and PASS TWO over the objects the commit will create ---------------------
    #
    # Pop-Location lives in `finally` and the failure is carried out in a variable rather than
    # thrown from inside the try. A throw from inside a Push-Location block that also pops in its
    # catch pops twice, which moves the caller's location somewhere neither of them chose.
    $gitError = ''
    $initRun = Invoke-PublicTreeGit -Arguments @('init', '--quiet') -WorkingDirectory $destinationFull
    if ($initRun.exit_code -ne 0) { $gitError = 'git init failed in the staging tree: ' + ($initRun.output -join ' | ') }
    else {
        $addRun = Invoke-PublicTreeGit -Arguments @('add', '-A') -WorkingDirectory $destinationFull
        if ($addRun.exit_code -ne 0) { $gitError = 'git add failed in the staging tree: ' + ($addRun.output -join ' | ') }
    }
    if ($gitError) { Remove-PublicTreeStaging -Path $destinationFull; throw $gitError }

    # DeploymentScan.ps1's identity functions shell out to git themselves, and they run in this
    # script's preference scope because they were dot-sourced into it. The same native-stderr rule
    # applies, so the preference is lowered around them rather than inside a file that never had
    # this problem on its own.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $stagedPaths = @(Get-IdentityScanStagedPaths -Workspace $destinationFull)
        $secondPass = Invoke-IdentityScan -Workspace $destinationFull -TermRoot $TermRoot -Mode $Mode
    }
    finally { $ErrorActionPreference = $previousPreference }

    if (-not $stagedPaths.Count) {
        Remove-PublicTreeStaging -Path $destinationFull
        throw 'The staged index held no paths, so the second scan would have passed over nothing. The staging folder was discarded.'
    }
    if ($secondPass.status -eq 'fail') {
        Remove-PublicTreeStaging -Path $destinationFull
        throw "The staged objects failed the identity scan, so the whole staging folder was discarded: $($secondPass.detail)"
    }

    # --- THE AUTHOR IS PUBLISHED TOO, AND NO BLOB SCAN CAN SEE IT --------------------------------
    #
    # Every scan above reads file contents. The name and email git is about to stamp on the commit
    # are in neither the tree nor the index -- they come from the ambient configuration -- and they
    # end up in public history just as permanently as a blob does. An address that is merely
    # unwanted rather than denied passes here and is step 18's question; this catches the one that
    # is on the denylist, which is the case that cannot be fixed later without rewriting history.
    # READ FROM THE WORKSPACE, PIN ONTO THE STAGING TREE.
    #
    # A staging repository `git init` made seconds ago has no configuration of its own, so it
    # resolves identity from the maintainer's GLOBAL config -- which is a different answer from the
    # one the workspace is set up with the moment anyone sets a per-repository override, and it is
    # the answer nobody looked at. So the identity is taken from the workspace, scanned there, and
    # then written onto the staging repository explicitly, which makes what ships a property of the
    # tree being exported rather than of whatever machine state happened to be in effect.
    $identity = Get-PublicTreeCommitIdentity -RepositoryPath $workspaceFull
    if (-not $identity.ok) {
        Remove-PublicTreeStaging -Path $destinationFull
        throw ('git could not resolve the identity it would stamp on this commit, so the commit would carry one nobody chose: ' +
               $identity.detail + '. Set user.name and user.email. The staging folder was discarded.')
    }
    $authorIdentity = (@($identity.identities) -join '; ')
    if ($terms.deny_present) {
        $identitySources = @($identity.identities | ForEach-Object { [pscustomobject]@{ source = '<commit identity>'; text = $_ } })
        $authorHits = @(Find-IdentityScanHits -Sources $identitySources -DenyTerms $terms.deny -AllowTerms $terms.allow)
        if ($authorHits.Count) {
            Remove-PublicTreeStaging -Path $destinationFull
            throw ("The identity git would stamp on this commit is on the denylist and is not approved attribution: " +
                   (@($authorHits | ForEach-Object { $_.match }) -join ', ') +
                   '. Set the address you want in public history with `git config user.email`, or add it to the approved-attribution allowlist. The staging folder was discarded.')
        }
    }

    $pinName = Invoke-PublicTreeGit -Arguments @('config', 'user.name', $identity.name) -WorkingDirectory $destinationFull
    $pinEmail = Invoke-PublicTreeGit -Arguments @('config', 'user.email', $identity.email) -WorkingDirectory $destinationFull
    if ($pinName.exit_code -ne 0 -or $pinEmail.exit_code -ne 0) {
        Remove-PublicTreeStaging -Path $destinationFull
        throw 'The approved identity could not be written onto the staging repository, so the commit would have carried an unscanned one. The staging folder was discarded.'
    }

    $head = ''
    $commitRun = Invoke-PublicTreeGit -Arguments @('commit', '--quiet', '-m', 'Initial public tree') -WorkingDirectory $destinationFull
    if ($commitRun.exit_code -ne 0) { $gitError = 'git commit failed in the staging tree: ' + ($commitRun.output -join ' | ') }
    else {
        $headRun = Invoke-PublicTreeGit -Arguments @('rev-parse', 'HEAD') -WorkingDirectory $destinationFull
        $head = (@($headRun.output) -join '').Trim()
    }
    if ($gitError) { Remove-PublicTreeStaging -Path $destinationFull; throw $gitError }

    # The seed is recorded only now, against the commit that actually exists. Assigned rather than
    # left on the pipeline: this function returns one object and a stray path would join it.
    $seedPath = Write-PublicTreeSeed -Workspace $workspaceFull -Destination $destinationFull `
                                     -PlanId $plan.plan_id -Commit $head -Files @($plan.files)

    [pscustomobject]@{
        operation          = 'Export the public tree'
        status             = 'exported'
        workspace          = $workspaceFull
        destination        = $destinationFull
        file_count         = $plan.file_count
        byte_count         = $plan.byte_count
        plan_id            = $plan.plan_id
        commit             = $head
        commit_author      = $authorIdentity
        staged_blob_count  = $stagedPaths.Count
        denylist_values    = $denylist.Count
        identity_scan      = $secondPass.status
        identity_detail    = $secondPass.detail
        gitleaks_tree      = $gitleaksOne.detail
        seed_record        = $seedPath
        next               = ("The staging tree is a repository with one commit and has passed both scans. " +
                              "Add the private Forgejo remote and push; nothing here has a remote yet. " +
                              "THIS WAS THE SEED: the record at $seedPath refuses a second export from this workspace, " +
                              "because a second export is an unrelated history and pushing it over the seeded repository " +
                              "would replace it. Later change travels as ordinary commits in a clone (ADR-0031).")
    }
}

function Get-PublicTreeDriftReport {
    <#
        Read-only, and the one thing a seeded workspace can usefully ask this tool: which allowlisted
        files have changed since the seed, so they can be carried over as ordinary commits. Needs no
        destination, because it writes nothing anywhere.
    #>
    param([Parameter(Mandatory)][string]$Workspace)

    $workspaceFull = [IO.Path]::GetFullPath($Workspace).TrimEnd('\', '/')
    $seed = Read-PublicTreeSeed -Workspace $workspaceFull
    $files = @(Get-PublicTreeFiles -Workspace $workspaceFull)
    $entries = @($files | ForEach-Object {
        [pscustomobject]@{ path = $_; sha256 = (Get-PublicTreeFileHash -Path (Join-Path $workspaceFull $_)) }
    })

    if (-not $seed) {
        return [pscustomobject]@{
            operation      = 'Public tree drift against the seed'
            status         = 'never-seeded'
            workspace      = $workspaceFull
            allowlist_size = $entries.Count
            detail         = ('This workspace has no seed record at ' + (Get-PublicTreeSeedPath -Workspace $workspaceFull) +
                              ', so it has never seeded a public repository from here and there is nothing to compare against.')
        }
    }

    $drift = Get-PublicTreeSeedDrift -Seed $seed -Files $entries
    [pscustomobject]@{
        operation       = 'Public tree drift against the seed'
        status          = $(if ($drift.total_count) { 'drifted' } else { 'identical' })
        workspace       = $workspaceFull
        destination     = $seed.destination
        seeded_utc      = $seed.seeded_utc
        seed_commit     = $seed.commit
        allowlist_size  = $entries.Count
        unchanged_count = $drift.unchanged_count
        changed         = @($drift.changed)
        added           = @($drift.added)
        removed         = @($drift.removed)
        total_count     = $drift.total_count
        detail          = (Format-PublicTreeSeedDrift -Drift $drift)
        next            = ('Carry these over as ordinary commits in a clone of ' + [string]$seed.destination +
                           ', reviewed on GitHub and merged at Forgejo (ADR-0031). Re-exporting would replace that history.')
    }
}

# ==================================================================================================
# THE SELF-TEST
# ==================================================================================================
#
# THE FIXTURE COMPOSES ITS PLANTED VALUES RATHER THAN SPELLING THEM, and the reason is the same one
# S6 paid for on 2026-09-19: this file is product source, it is on the allowlist above, and it
# ships. A fixture that spelled an endpoint in full would be indistinguishable from a real one to
# the scanner that reads this tree -- and the first thing that scanner would refuse is the export
# tool itself. 10.42.x and Q:\ are in no documentation range on purpose, so that every "must be
# caught" case below is a real positive rather than an allowance.

function New-PublicTreeExportFixture {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('public-tree-' + [guid]::NewGuid().ToString('N'))
    $utf8 = [Text.UTF8Encoding]::new($false)
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    # A CLOSURE, not a bare scriptblock. `& $write` from another function runs in THAT function's
    # scope, where `$root` and `$utf8` do not exist -- so a writer that works perfectly inside this
    # function fails the moment a later case calls it. GetNewClosure binds them here, once.
    $write = {
        param([string]$Relative, [string]$Body)
        $path = Join-Path $root $Relative
        $parent = Split-Path -Parent $path
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        [IO.File]::WriteAllText($path, $Body, $utf8)
    }.GetNewClosure()

    $fxHost       = '10.42.7.3'
    $fxEndpoint   = 'http://' + $fxHost + ':8000' + '/mcp'
    $fxShareDrive = 'Q:' + '\collection-store' + '\basic-memory\knowledge\ai-library'
    $fxCollection = 'feedface-0000-4000-8000-feedfacefeed'

    # --- product, and clean ----------------------------------------------------------------------
    & $write 'README.md'   "# Fixture product`n"
    & $write 'LICENSE'     "MIT`n"
    & $write 'AGENTS.md'   "Working instructions.`n"
    & $write 'CLAUDE.md'   "Working instructions.`n"
    & $write 'CONTEXT.md'  "Glossary.`n"
    & $write '.mcp.json'   "{}`n"
    & $write 'tools/Good.ps1'              "Write-Host 'ok'`n"
    & $write 'docs/guide.md'               "A guide with no deployment in it.`n"
    & $write '.claude/hooks/Hook.ps1'      "exit 0`n"
    & $write '.claude/rules/rule.md'       "A rule.`n"
    & $write '.claude/settings.json'       "{}`n"
    & $write '.codex/config.template.toml' "url = `"__BASIC_MEMORY_URL__`"`n"
    & $write '.codex/hooks.template.json'  "{}`n"
    & $write '.githooks/pre-commit'        "#!/bin/sh`nexit 0`n"

    # --- must never be copied, each for a different reason ----------------------------------------
    & $write 'PLAN-public-release.md'        ("The fallback was " + $fxEndpoint + " in fourteen files.`n")
    & $write '.claude/settings.local.json'   ("{ `"url`": `"" + $fxEndpoint + "`" }`n")
    & $write '.claude/hooks/.capture/p.json' ("{ `"cwd`": `"" + $fxShareDrive + "`" }`n")
    & $write '.codex/config.toml'            ("url = `"" + $fxEndpoint + "`"`n")
    & $write 'notebook/reader-note.md'       "Working knowledge that belongs to the reader.`n"
    & $write 'raw/batch/source.md'           "Unvetted source material.`n"

    # Generated state: the denylist's own source, never tracked and never exported.
    & $write '.claude/.library-mcp-url'      ($fxEndpoint + "`n")
    & $write '.claude/.library-project'      ($fxCollection + "`n")
    & $write '.claude/.library-shared-root'  ($fxShareDrive + "`n")
    & $write '.gitignore' (".claude/.library-mcp-url`n.claude/.library-project`n.claude/.library-shared-root`n.claude/settings.local.json`n.claude/hooks/.capture/`n.codex/config.toml`nnotebook/`nraw/`n")

    [void](Invoke-PublicTreeGit -Arguments @('init', '--quiet') -WorkingDirectory $root)
    [void](Invoke-PublicTreeGit -Arguments @('config', 'user.name', 'Fixture Author') -WorkingDirectory $root)
    [void](Invoke-PublicTreeGit -Arguments @('config', 'user.email', 'fixture@example.invalid') -WorkingDirectory $root)
    # The fixture writes LF and this machine's git may be configured to convert. The conversion is
    # irrelevant to every assertion here and its WARNING is not: it lands on stderr, which is the
    # thing Invoke-PublicTreeGit exists to keep from terminating the run.
    [void](Invoke-PublicTreeGit -Arguments @('config', 'core.autocrlf', 'false') -WorkingDirectory $root)
    [void](Invoke-PublicTreeGit -Arguments @('add', '-A') -WorkingDirectory $root)
    [void](Invoke-PublicTreeGit -Arguments @('commit', '--quiet', '-m', 'base') -WorkingDirectory $root)

    # The identity terms, never inside the repository -- the rule the whole scan exists to keep.
    $termRoot = Join-Path ([IO.Path]::GetTempPath()) ('public-tree-terms-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $termRoot -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $termRoot 'identity-denylist.txt'),
        "# fixture denylist`nTestuser`nC:\Users\Testuser`ntestuser@private.invalid`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $termRoot 'identity-allowlist.txt'),
        "# fixture approved attribution`nFixture Author`nfixture@example.invalid`n", $utf8)

    [pscustomobject]@{ root = $root; term_root = $termRoot; endpoint = $fxEndpoint; write = $write }
}

function Set-PublicTreeFixtureFile {
    <#
        Write one fixture file and commit it, so the tree stays fully tracked between cases. An
        uncommitted edit would trip the untracked refusal and every case after it would be
        answering the wrong question.
    #>
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)]$Writer,
        [Parameter(Mandatory)][string]$Relative,
        [Parameter(Mandatory)][string]$Body,
        [Parameter(Mandatory)][string]$Message
    )
    & $Writer $Relative $Body
    [void](Invoke-PublicTreeGit -Arguments @('add', '-A') -WorkingDirectory $Root)
    [void](Invoke-PublicTreeGit -Arguments @('commit', '--quiet', '-m', $Message) -WorkingDirectory $Root)
}

function Clear-PublicTreeFixtureSeed {
    <#
        Between cases. The guard is deliberately STICKY in a real workspace -- one seed, one refusal,
        for as long as the record exists -- so a suite that exercises the scans has to put the fixture
        back to never-seeded. Without this, every case after the first successful export would be
        refused by the seed guard before it reached the thing it was written to test, and its
        assertion would fail against a refusal about seeding rather than pass for the wrong reason.
    #>
    param([Parameter(Mandatory)][string]$Root)
    $path = Join-Path $Root 'internal\public-tree-seed.json'
    if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
}

function Invoke-PublicTreeExportSelfTest {
    $failures = [Collections.Generic.List[string]]::new()
    # Counted, never typed.
    $script:publicTreeChecks = 0
    function Assert([bool]$Condition, [string]$Message) {
        $script:publicTreeChecks++
        if (-not $Condition) { [void]$failures.Add($Message) }
    }

    $built = New-PublicTreeExportFixture
    $fixture = $built.root
    $termRoot = $built.term_root
    $write = $built.write
    $cleanGuide = "A guide with no deployment in it.`n"
    $staging = Join-Path ([IO.Path]::GetTempPath()) ('public-tree-out-' + [guid]::NewGuid().ToString('N'))

    try {
        # --- PREFLIGHT writes nothing ------------------------------------------------------------
        $pre = Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -Preflight -TermRoot $termRoot -Mode ''
        Assert ($pre.status -eq 'preflight') "the preflight reported status '$($pre.status)'"
        Assert (-not (Test-Path -LiteralPath $staging)) 'the preflight created the destination; it is meant to be read-only'
        Assert ($pre.file_count -gt 0) 'the preflight resolved no files'
        Assert ($pre.plan_id -like 'export-public-tree-*') 'the preflight produced no usable plan_id'
        Assert ($pre.untracked_count -eq 0) "the clean fixture reported $($pre.untracked_count) untracked allowlisted path(s)"

        # --- a plan_id from a different tree is refused -------------------------------------------
        $rejected = ''
        try { Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -UserConfirmed -ApprovedPlanId 'export-public-tree-not-this-one' -TermRoot $termRoot -Mode '' | Out-Null }
        catch { $rejected = [string]$_.Exception.Message }
        Assert ($rejected -match 'no longer describes') "a wrong plan_id was not refused; got '$rejected'"
        Assert (-not (Test-Path -LiteralPath $staging)) 'a refused plan_id still left a staging folder behind'

        # --- THE CLEAN EXPORT ---------------------------------------------------------------------
        $result = Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -UserConfirmed -ApprovedPlanId $pre.plan_id -TermRoot $termRoot -Mode ''
        Assert ($result.status -eq 'exported') "the clean export reported '$($result.status)'"
        Assert ($result.commit -match '^[0-9a-f]{40}$') "the export produced no commit sha; got '$($result.commit)'"
        Assert ($result.staged_blob_count -gt 0) 'the second scan ran over zero staged blobs, which is a vacuous pass'
        Assert ($result.denylist_values -gt 0) 'the fixture denylist was empty, so the deployment half proved nothing'

        # What shipped, and what did not. The negatives are the product promise.
        foreach ($shipped in @('README.md', 'LICENSE', 'tools/Good.ps1', 'docs/guide.md',
                               '.claude/hooks/Hook.ps1', '.codex/config.template.toml', '.githooks/pre-commit')) {
            Assert (Test-Path -LiteralPath (Join-Path $staging $shipped)) "$shipped is product and did not reach the staging tree"
        }
        foreach ($withheld in @('PLAN-public-release.md', '.claude/settings.local.json',
                                '.claude/hooks/.capture/p.json', '.codex/config.toml',
                                'notebook/reader-note.md', 'raw/batch/source.md',
                                '.claude/.library-mcp-url', '.claude/.library-project')) {
            Assert (-not (Test-Path -LiteralPath (Join-Path $staging $withheld))) "$withheld reached the staging tree and must never be exported"
        }
        Assert (Test-Path -LiteralPath (Join-Path $staging '.git')) 'the clean export created no repository'

        # THE COMMIT ITSELF, not the result object's claim about it. The fixture sets its identity
        # as a LOCAL config, which a freshly-initialised staging repository does not inherit -- so
        # if the export ever goes back to reading identity in the staging tree, this commit is
        # authored by whoever the real machine's global config names, and this assertion is the only
        # thing in the suite that would notice.
        $loggedAuthor = Invoke-PublicTreeGit -Arguments @('log', '-1', '--format=%ae') -WorkingDirectory $staging
        $loggedAuthorEmail = (@($loggedAuthor.output) -join '').Trim()
        Assert ($loggedAuthorEmail -ceq 'fixture@example.invalid') "the commit was authored by '$loggedAuthorEmail' rather than the workspace identity that was scanned"
        Assert ($result.commit_author -match 'fixture@example\.invalid') "the result reported an identity ('$($result.commit_author)') that is not the one the commit carries"

        # --- THE SEED RECORD ----------------------------------------------------------------------
        # The record is read off the disk rather than off the result object, because the result
        # object is this function's claim and the record is what the next run will actually see.
        $seedPath = Join-Path $fixture 'internal\public-tree-seed.json'
        Assert (Test-Path -LiteralPath $seedPath -PathType Leaf) 'the clean export recorded no seed, so a second export would not be refused'
        Assert ($result.seed_record -eq $seedPath) "the result named seed record '$($result.seed_record)' rather than $seedPath"
        $seedRecord = (Get-Content -LiteralPath $seedPath -Raw) | ConvertFrom-Json
        Assert ($seedRecord.commit -ceq $result.commit) "the seed record names commit '$($seedRecord.commit)' rather than the commit the export made"
        Assert ($seedRecord.destination -eq $staging) "the seed record names destination '$($seedRecord.destination)' rather than $staging"
        Assert ($seedRecord.file_count -eq $result.file_count) "the seed recorded $($seedRecord.file_count) file(s) against an export of $($result.file_count)"
        # And it is not exportable: internal/ is neither allowlisted nor tracked, so the record of
        # what this machine published never travels with what it published.
        Assert (-not (Test-Path -LiteralPath (Join-Path $staging 'internal'))) 'the seed record reached the staging tree'

        # An UNTOUCHED tree is not drift. Asserted before anything is planted, so "identical" means it.
        $driftClean = Get-PublicTreeDriftReport -Workspace $fixture
        Assert ($driftClean.status -eq 'identical') "an untouched tree reported drift status '$($driftClean.status)'"
        Assert ($driftClean.total_count -eq 0) "an untouched tree reported $($driftClean.total_count) drifted file(s)"
        Assert ($driftClean.unchanged_count -eq $result.file_count) "the drift report accounted for $($driftClean.unchanged_count) of $($result.file_count) file(s)"

        Remove-PublicTreeStaging -Path $staging

        # --- A SECOND EXPORT IS REFUSED, AND THE REFUSAL IS THE DRIFT REPORT -----------------------
        # A second destination on purpose: the interesting assertion is that the refused run created
        # NOTHING, and reusing the first staging path could not tell "never created" from "cleaned up".
        Set-PublicTreeFixtureFile -Root $fixture -Writer $write -Relative 'docs/guide.md' -Message 'drift' `
            -Body "A guide with no deployment in it, edited after the seed.`n"
        $secondStaging = Join-Path ([IO.Path]::GetTempPath()) ('public-tree-second-' + [guid]::NewGuid().ToString('N'))

        $preSecond = Invoke-PublicTreeExport -Workspace $fixture -Destination $secondStaging -Preflight -TermRoot $termRoot -Mode ''
        Assert ($preSecond.already_seeded) 'a preflight against a seeded workspace did not report the seed'
        Assert ($preSecond.next -match 'already seeded') "the seeded preflight offered a next step that would be refused; got '$($preSecond.next)'"

        $seedRefusal = ''
        try { Invoke-PublicTreeExport -Workspace $fixture -Destination $secondStaging -UserConfirmed -ApprovedPlanId $preSecond.plan_id -TermRoot $termRoot -Mode '' | Out-Null }
        catch { $seedRefusal = [string]$_.Exception.Message }
        Assert ($seedRefusal -match 'already seeded a public repository') "a second export was not refused; got '$seedRefusal'"
        Assert ($seedRefusal -match 'docs/guide\.md') "the refusal did not name the file that changed since the seed; got '$seedRefusal'"
        Assert ($seedRefusal -match 'FORCED REPLACEMENT') "the refusal did not say what pushing a second export would do; got '$seedRefusal'"
        Assert (-not (Test-Path -LiteralPath $secondStaging)) 'the refused second export created a staging folder anyway'

        $driftAfter = Get-PublicTreeDriftReport -Workspace $fixture
        Assert ($driftAfter.status -eq 'drifted') "the drift report after one edit reported '$($driftAfter.status)'"
        Assert (@($driftAfter.changed) -contains 'docs/guide.md') "the drift report did not list the edited file; got '$(@($driftAfter.changed) -join ',')'"
        Assert ($driftAfter.total_count -eq 1) "the drift report counted $($driftAfter.total_count) change(s) after one edit"

        # --- A SEED RECORD THAT CANNOT BE READ FAILS CLOSED ----------------------------------------
        # Unreadable and absent must not look alike: the first is a guard that cannot answer, the
        # second is a workspace that has never seeded, and only one of them may proceed.
        [IO.File]::WriteAllText($seedPath, '{ not json', [Text.UTF8Encoding]::new($false))
        $corruptRefusal = ''
        try { Invoke-PublicTreeExport -Workspace $fixture -Destination $secondStaging -Preflight -TermRoot $termRoot -Mode '' | Out-Null }
        catch { $corruptRefusal = [string]$_.Exception.Message }
        Assert ($corruptRefusal -match 'not readable JSON') "an unreadable seed record was treated as no seed at all; got '$corruptRefusal'"

        # Shape before values: a record missing the field the drift report reads is the same failure.
        [IO.File]::WriteAllText($seedPath, '{ "destination": "d", "commit": "c", "seeded_utc": "u" }', [Text.UTF8Encoding]::new($false))
        $shapeRefusal = ''
        try { Invoke-PublicTreeExport -Workspace $fixture -Destination $secondStaging -Preflight -TermRoot $termRoot -Mode '' | Out-Null }
        catch { $shapeRefusal = [string]$_.Exception.Message }
        Assert ($shapeRefusal -match "no 'files' field") "a seed record with no file list was accepted; got '$shapeRefusal'"

        # Every case below exercises the SCANS, which a standing seed would refuse before they ran.
        Clear-PublicTreeFixtureSeed -Root $fixture

        # --- A PLANTED DEPLOYMENT DISCARDS THE WHOLE FOLDER ---------------------------------------
        # The assertion that matters is not that it refused: it is that NOTHING IS LEFT. A
        # half-sanitised staging tree is what gets published by somebody who remembers that the
        # tool mostly worked.
        Set-PublicTreeFixtureFile -Root $fixture -Writer $write -Relative 'docs/guide.md' -Message 'plant' `
            -Body ("Point the helper at " + $built.endpoint + " to run it.`n")
        $pre2 = Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -Preflight -TermRoot $termRoot -Mode ''
        $deployRefusal = ''
        try { Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -UserConfirmed -ApprovedPlanId $pre2.plan_id -TermRoot $termRoot -Mode '' | Out-Null }
        catch { $deployRefusal = [string]$_.Exception.Message }
        Assert ($deployRefusal -match 'WHOLE staging folder was discarded') "a planted endpoint did not refuse the export; got '$deployRefusal'"
        Assert ($deployRefusal -match 'docs/guide\.md') 'the refusal did not name the file carrying the planted endpoint'
        Assert (-not (Test-Path -LiteralPath $staging)) 'a planted endpoint refused the export but left the staging folder on disk'

        # Put it back and prove the same tree exports cleanly: without this, "it refuses everything"
        # and "it refuses this" are the same green.
        Set-PublicTreeFixtureFile -Root $fixture -Writer $write -Relative 'docs/guide.md' -Body $cleanGuide -Message 'unplant'
        $pre3 = Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -Preflight -TermRoot $termRoot -Mode ''
        $recovered = Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -UserConfirmed -ApprovedPlanId $pre3.plan_id -TermRoot $termRoot -Mode ''
        Assert ($recovered.status -eq 'exported') 'the tree that exported cleanly before the plant did not export once it was removed'
        Remove-PublicTreeStaging -Path $staging
        Clear-PublicTreeFixtureSeed -Root $fixture

        # --- A PLANTED IDENTITY, which no deployment pattern has a shape for -----------------------
        Set-PublicTreeFixtureFile -Root $fixture -Writer $write -Relative 'docs/guide.md' -Message 'identity' `
            -Body "Measured in C:\Users\Testuser\.codex on 2026-09-19.`n"
        $pre4 = Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -Preflight -TermRoot $termRoot -Mode ''
        $idRefusal = ''
        try { Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -UserConfirmed -ApprovedPlanId $pre4.plan_id -TermRoot $termRoot -Mode '' | Out-Null }
        catch { $idRefusal = [string]$_.Exception.Message }
        Assert ($idRefusal -match 'identity') "a planted home directory did not refuse the export; got '$idRefusal'"
        Assert (-not (Test-Path -LiteralPath $staging)) 'a planted identity refused the export but left the staging folder on disk'
        Set-PublicTreeFixtureFile -Root $fixture -Writer $write -Relative 'docs/guide.md' -Body $cleanGuide -Message 'clean'

        # --- AN UNTRACKED ALLOWLISTED FILE REFUSES ------------------------------------------------
        & $write 'docs/never-committed.md' "A note nobody reviewed.`n"
        $pre5 = Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -Preflight -TermRoot $termRoot -Mode ''
        Assert ($pre5.untracked_count -eq 1) "the preflight saw $($pre5.untracked_count) untracked allowlisted path(s), expected 1"
        Assert (@($pre5.untracked) -ccontains 'docs/never-committed.md') 'the preflight did not name the untracked file'
        $untrackedRefusal = ''
        try { Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -UserConfirmed -ApprovedPlanId $pre5.plan_id -TermRoot $termRoot -Mode '' | Out-Null }
        catch { $untrackedRefusal = [string]$_.Exception.Message }
        Assert ($untrackedRefusal -match 'not tracked by git') "an untracked allowlisted file was exported anyway; got '$untrackedRefusal'"
        Assert (-not (Test-Path -LiteralPath $staging)) 'the untracked refusal left a staging folder behind'
        Remove-Item -LiteralPath (Join-Path $fixture 'docs/never-committed.md') -Force -ErrorAction SilentlyContinue

        # --- THE DESTINATION REFUSALS -------------------------------------------------------------
        $insideRefusal = ''
        try { Invoke-PublicTreeExport -Workspace $fixture -Destination (Join-Path $fixture 'staging') -Preflight -TermRoot $termRoot -Mode '' | Out-Null }
        catch { $insideRefusal = [string]$_.Exception.Message }
        Assert ($insideRefusal -match 'inside the workspace') "a destination inside the workspace was allowed; got '$insideRefusal'"

        $occupied = Join-Path ([IO.Path]::GetTempPath()) ('public-tree-busy-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $occupied -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $occupied 'existing.txt'), "already here`n", [Text.UTF8Encoding]::new($false))
        try {
            $busyRefusal = ''
            try { Invoke-PublicTreeExport -Workspace $fixture -Destination $occupied -Preflight -TermRoot $termRoot -Mode '' | Out-Null }
            catch { $busyRefusal = [string]$_.Exception.Message }
            Assert ($busyRefusal -match 'already holds files') "a non-empty destination was allowed; got '$busyRefusal'"
            Assert (Test-Path -LiteralPath (Join-Path $occupied 'existing.txt')) 'the refusal deleted a file in a destination it had declined to use'
        }
        finally { Remove-Item -LiteralPath $occupied -Recurse -Force -ErrorAction SilentlyContinue }

        # --- A DENIED AUTHOR IDENTITY -------------------------------------------------------------
        # The one publishable identity no blob scan can see, because it is not in the tree at all.
        # Driven through GIT_AUTHOR_EMAIL rather than `git config`, for two reasons. The staging
        # tree is a repository git init created seconds earlier, so setting user.email on the
        # FIXTURE changes nothing there -- the first version of this case did exactly that, the
        # export succeeded, and the suite only noticed three cases later when the leftover staging
        # folder tripped an unrelated destination check. And the alternative, writing the reader's
        # real global config, is not something a self-test is allowed to do.
        $savedAuthorEmail = $env:GIT_AUTHOR_EMAIL
        $env:GIT_AUTHOR_EMAIL = 'testuser@private.invalid'
        try {
            $pre6 = Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -Preflight -TermRoot $termRoot -Mode ''
            $authorRefusal = ''
            try { Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -UserConfirmed -ApprovedPlanId $pre6.plan_id -TermRoot $termRoot -Mode '' | Out-Null }
            catch { $authorRefusal = [string]$_.Exception.Message }
            Assert ($authorRefusal -match 'stamp on this commit') "a denylisted commit author was published; got '$authorRefusal'"
            Assert ($authorRefusal -match 'testuser@private\.invalid') 'the author refusal did not name the address it refused'
            Assert (-not (Test-Path -LiteralPath $staging)) 'the author refusal left a staging folder behind'
        }
        finally {
            if ($null -eq $savedAuthorEmail) { Remove-Item Env:GIT_AUTHOR_EMAIL -ErrorAction SilentlyContinue }
            else { $env:GIT_AUTHOR_EMAIL = $savedAuthorEmail }
        }

        # --- CONTRIBUTOR MODE with no denylist ----------------------------------------------------
        # A contributor cannot hold the maintainer's list, and the export must still work for them.
        $emptyTerms = Join-Path ([IO.Path]::GetTempPath()) ('public-tree-noterms-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $emptyTerms -Force | Out-Null
        try {
            $pre7 = Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -Preflight -TermRoot $emptyTerms -Mode 'contributor'
            $contributorResult = Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -UserConfirmed -ApprovedPlanId $pre7.plan_id -TermRoot $emptyTerms -Mode 'contributor'
            Assert ($contributorResult.status -eq 'exported') "contributor mode with no denylist reported '$($contributorResult.status)'"
            Remove-PublicTreeStaging -Path $staging
            Clear-PublicTreeFixtureSeed -Root $fixture

            # And the same absence on a MAINTAINER machine refuses, because a scan whose denylist
            # nobody created has never matched anything and would read green forever.
            $pre8 = Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -Preflight -TermRoot $emptyTerms -Mode ''
            $maintainerRefusal = ''
            try { Invoke-PublicTreeExport -Workspace $fixture -Destination $staging -UserConfirmed -ApprovedPlanId $pre8.plan_id -TermRoot $emptyTerms -Mode '' | Out-Null }
            catch { $maintainerRefusal = [string]$_.Exception.Message }
            Assert ($maintainerRefusal -match 'No identity denylist') "a missing denylist on a maintainer machine exported anyway; got '$maintainerRefusal'"
            Assert (-not (Test-Path -LiteralPath $staging)) 'the missing-denylist refusal left a staging folder behind'
        }
        finally { Remove-Item -LiteralPath $emptyTerms -Recurse -Force -ErrorAction SilentlyContinue }
    }
    finally {
        # Tolerant on purpose, and it is the one place in this file that swallows a failure from
        # Remove-PublicTreeStaging. A throw here would replace whatever the suite actually found
        # with a message about a temp directory. Both fixtures are git repositories, so they get
        # the same read-only clearing the product path needs.
        foreach ($leftover in @($staging, $fixture, $termRoot)) {
            try { Remove-PublicTreeStaging -Path $leftover } catch { }
        }
    }

    if ($failures.Count) {
        [Console]::Error.WriteLine("Export-PublicTree self-test FAILED: $($failures -join '; ')")
        exit 1
    }
    Write-Host "Export-PublicTree self-test passed ($script:publicTreeChecks checks)."
    exit 0
}

# --- Entry point ----------------------------------------------------------------------------------
if ($SelfTest) { Invoke-PublicTreeExportSelfTest }

if ([string]::IsNullOrWhiteSpace($Workspace)) { $Workspace = Split-Path -Parent $PSScriptRoot }

# -DriftReport is answered before the destination is demanded, because it HAS no destination: it
# reads the allowlist and the seed record and writes nothing. Written as if/else rather than an early
# `return` so that the export below is visibly unreachable from this branch.
if ($DriftReport) {
    Get-PublicTreeDriftReport -Workspace $Workspace
}
else {
    if ([string]::IsNullOrWhiteSpace($Destination)) {
        throw 'Pass -Destination <staging folder>, outside the workspace. Nothing was written.'
    }
    Invoke-PublicTreeExport -Workspace $Workspace -Destination $Destination -Preflight:$Preflight -UserConfirmed:$UserConfirmed -ApprovedPlanId $ApprovedPlanId -TermRoot $TermRoot -Mode $Mode
}
