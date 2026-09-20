<#
.SYNOPSIS
    Fetch a git upstream into a new raw/ source batch, thinly. The front door of the URL route:
    after this, the ordinary compiler runs unchanged.

.DESCRIPTION
    Book currency anchoring (PLAN-book-currency.md, step 4). The reader had been compiling Books
    straight from a GitHub URL, which bypassed Compile-RawBatchToNotebook.ps1 entirely -- so those
    articles carried no ## Sources block, no source hashes and no index link. This helper closes that
    by making the URL produce a REAL raw/ batch, which the compiler already knows how to read. No
    second source-resolution path, and one authority still owns what a batch is.

    IT IS CREATE-ONLY, AND THAT IS WHAT MAKES IT UNGATED. Everything adjacent in tools/ takes a
    preflight, an exact plan_id and one approval, so the asymmetry needs saying out loud. The gate
    protects writes that lose text or leave this machine. This one cannot lose text: it refuses a
    batch name that already exists rather than updating it, and git objects are immutable, so there
    is nothing here to overwrite. An in-place update WOULD lose text -- it would move the checkout
    and silently invalidate every SHA-256 that every article compiled from that batch cites -- which
    is exactly why that operation does not exist. Newer material is a NEW batch, leaving the old
    one's bytes intact so the old articles still verify. Disk is the price; verifiable provenance is
    what it buys.

    THIN, BECAUSE THE MEASUREMENT WAS EMBARRASSING. Cloning obsidianmd/obsidian-help in full is
    710 MB and minutes, for 741 KB of material actually cited. With --depth 1 --filter=blob:none
    --sparse it is 37 MB in cone mode, 20 MB restricted to en/**/*.md, in 1.2 seconds.

    WHAT IT DELIBERATELY DOES NOT DO is declare who owns the batch. Ownership is declared by the
    reader and never guessed -- docs/raw-batch-ownership.md is explicit that deriving an owner from a
    directory name would be a guess dressed as a rule -- so the result names the Set-RawBatchOwner
    command instead of running it.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Batch,
    # Cone mode: plain directory paths, which is what cone mode accepts. Wildcards belong in
    # -IncludePattern; the two modes are separate parameters rather than one guessed from the value,
    # because a glob silently treated as a directory name matches nothing and looks like an empty
    # upstream.
    [string[]]$Include,
    [string[]]$IncludePattern,
    [string[]]$AllowHost,
    [int]$TimeoutSeconds = 300,
    [long]$CeilingBytes = 0,
    [switch]$Preflight,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'RawSearch.ps1')
. (Join-Path $PSScriptRoot 'GitSource.ps1')

$workspace = Split-Path -Parent $PSScriptRoot

function Test-SparseValue([string]$Value, [bool]$ConeMode) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return 'a sparse entry cannot be blank' }
    # A leading dash makes the value an OPTION to git rather than a path, whatever the -- separator
    # says about the ones after it.
    if ($Value.StartsWith('-')) { return "'$Value' begins with '-', which git would read as an option" }
    if (-not (Test-RecordableField $Value)) { return "'$Value' carries a character that cannot be passed safely" }
    if ($Value.Split('/') -contains '..') { return "'$Value' escapes the repository" }
    if ($ConeMode -and $Value -match '[*?\[\]]') { return "'$Value' looks like a pattern; cone mode takes directories, so pass it with -IncludePattern" }
    ''
}

$normalised = ConvertTo-NormalisedUpstreamUrl $Url
if (-not $normalised.ok) { throw "The upstream URL was refused: $($normalised.reason)" }
if (-not (Test-UpstreamHostAllowed $normalised.host_name $AllowHost)) {
    throw "Host '$($normalised.host_name)' is not on the allowlist. Pass -AllowHost '$($normalised.host_name)' to permit it."
}

$batchName = ([string]$Batch).Replace('\', '/').Trim().Trim('/')
if ($batchName -cnotmatch '^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$') {
    throw 'Batch must be a lowercase name under raw/, using letters, digits, dot, hyphen and underscore.'
}
if ($batchName.Split('/') -contains '..' -or $batchName.Split('/') -contains '.') {
    throw 'Batch must not contain relative segments.'
}

$rawRoot = Join-Path $workspace 'raw'
$destination = Join-Path $rawRoot ($batchName.Replace('/', [IO.Path]::DirectorySeparatorChar))
$destinationFull = [IO.Path]::GetFullPath($destination)
if (-not $destinationFull.StartsWith(([IO.Path]::GetFullPath($rawRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Batch does not resolve inside raw/.'
}

# @($null).Count is 1, not 0 -- an unbound [string[]] parameter is $null, and wrapping it yields an
# array holding one $null. Both lists are compacted before anything counts them.
$includeValues = @(@($Include) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$patternValues = @(@($IncludePattern) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($includeValues.Count -and $patternValues.Count) {
    throw 'Pass either -Include (cone mode directories) or -IncludePattern (gitignore-style patterns), not both.'
}
$coneMode = -not $patternValues.Count
$sparseValues = if ($coneMode) { $includeValues } else { $patternValues }
foreach ($value in @($sparseValues)) {
    $refusal = Test-SparseValue $value $coneMode
    if ($refusal) { throw "Sparse entry refused: $refusal" }
}

$collides = Test-Path -LiteralPath $destinationFull
$plan = [ordered]@{
    operation            = 'Sync raw upstream'
    url                  = $normalised.url
    host                 = $normalised.host_name
    batch                = $batchName
    batch_path           = "raw/$batchName"
    sparse_mode          = if (-not @($sparseValues).Count) { 'whole repository' } elseif ($coneMode) { 'cone' } else { 'pattern' }
    sparse_entries       = @($sparseValues)
    destination_exists   = $collides
    create_only          = $true
    shared_library_write = $false
}

if ($collides) {
    $plan['status'] = 'refused'
    $plan['reason'] = "raw/$batchName already exists. This helper is create-only, because updating a batch in place would move its checkout and invalidate every source hash already cited from it. Fetch newer material into a new batch name instead."
    if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json; exit 0 }
    throw $plan['reason']
}

if ($Preflight) {
    $plan['status'] = 'ready'
    $plan['next'] = 'Re-run without -Preflight to fetch. No network call was made.'
    Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
    exit 0
}

# Staging lives outside raw/ so a killed run cannot leave a half-finished directory that the batch
# roster would enumerate as a real source batch. Same volume, so the promotion is a rename.
$stagingRoot = Join-Path $workspace 'internal/raw-staging'
$staging = Join-Path $stagingRoot ([Guid]::NewGuid().ToString('n'))
$promoted = $false
try {
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    $cloneArguments = @('clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-tags')
    if (@($sparseValues).Count) { $cloneArguments += '--sparse' }
    $cloneArguments += @('--', $normalised.url, $staging)
    $clone = Invoke-BoundedFetch -GitArgument $cloneArguments -MeasuredPath $staging `
        -TimeoutSeconds $TimeoutSeconds -CeilingBytes $CeilingBytes -RequireFilterAcknowledged
    if ($clone.refusal) {
        $detail = switch ($clone.refusal) {
            'unsupported-filter' { 'the server ignored --filter=blob:none, so a thin clone is not possible against it. Nothing was kept.' }
            'transfer-ceiling'   { 'the transfer exceeded the ceiling and was stopped. Raise -CeilingBytes if the repository really is that large.' }
            'source-unreachable' { 'the server did not answer within the timeout.' }
            default              { "git could not clone it: $(($clone.stderr -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1))" }
        }
        throw "The upstream was not fetched: $detail"
    }

    if (@($sparseValues).Count) {
        $sparseArguments = @('-C', $staging, 'sparse-checkout', 'set')
        if (-not $coneMode) { $sparseArguments += '--no-cone' }
        $sparseArguments += @('--') + @($sparseValues)
        $sparse = Invoke-GitSafe -GitArgument $sparseArguments -TimeoutSeconds $TimeoutSeconds
        if (-not $sparse.ok) {
            throw "The sparse selection was refused by git: $(($sparse.stderr -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1))"
        }
    }

    # Prove the clone is anchorable before it becomes a batch, so a batch that can never be pinned is
    # reported here rather than discovered later by a compile that quietly withholds its pin.
    $resolved = Resolve-BatchRepository -BatchRoot $staging -StartPath $staging
    if (-not $resolved.found) { throw "The fetched clone is not usable as a source batch: $($resolved.reason)" }
    $head = Invoke-GitSafe -GitArgument @('-C', $staging, 'rev-parse', 'HEAD') -TimeoutSeconds $TimeoutSeconds
    if (-not $head.ok) { throw 'The fetched clone has no HEAD commit.' }
    $commit = (($head.stdout -split "`r?`n")[0]).Trim()
    $branch = Invoke-GitSafe -GitArgument @('-C', $staging, 'symbolic-ref', '--quiet', 'HEAD') -TimeoutSeconds $TimeoutSeconds
    $branchName = if ($branch.ok) { (($branch.stdout -split "`r?`n")[0]).Trim() } else { '' }
    $upstream = Invoke-GitSafe -GitArgument @('-C', $staging, 'rev-parse', '--symbolic-full-name', '@{upstream}') -TimeoutSeconds $TimeoutSeconds
    $upstreamRef = if ($upstream.ok) { (($upstream.stdout -split "`r?`n")[0]).Trim() } else { '' }

    $files = @(Get-ChildItem -LiteralPath $staging -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName.IndexOf([IO.Path]::DirectorySeparatorChar + '.git' + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -lt 0 })
    $bytes = 0L
    foreach ($file in $files) { $bytes += [long]$file.Length }

    # Re-check the collision under the same breath as the promotion. A check made before a network
    # call that took seconds is not a check.
    if (Test-Path -LiteralPath $destinationFull) {
        throw "raw/$batchName appeared while the upstream was being fetched; nothing was promoted."
    }
    $parent = Split-Path -Parent $destinationFull
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.Directory]::Move($staging, $destinationFull)
    $promoted = $true

    $plan['status'] = 'complete'
    $plan['commit'] = $commit
    $plan['branch'] = $branchName
    $plan['upstream_ref'] = $upstreamRef
    $plan['file_count'] = $files.Count
    $plan['size_bytes'] = $bytes
    $plan['next'] = "Declare who owns it: tools/Set-RawBatchOwner.ps1 -Batch '$batchName' -Project '<project-slug>' -Note '<why it is here>'. Then compile with tools/Compile-RawBatchToNotebook.ps1 -Batch '$batchName' ..."
    Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
}
finally {
    if (-not $promoted -and (Test-Path -LiteralPath $staging)) {
        # git leaves read-only objects under .git, which a plain Remove-Item refuses.
        try { Get-ChildItem -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Attributes = 'Normal' } } catch { }
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ((Test-Path -LiteralPath $stagingRoot -PathType Container) -and -not @(Get-ChildItem -LiteralPath $stagingRoot -Force -ErrorAction SilentlyContinue).Count) {
        Remove-Item -LiteralPath $stagingRoot -Force -ErrorAction SilentlyContinue
    }
}
