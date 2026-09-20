[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$SourceWikiPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Hash-File([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Test-IsWithin([string]$Child, [string]$Parent) {
    $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    [IO.Path]::GetFullPath($Child).StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)
}
function Get-LocalTarget([string]$SourceFile, [string]$RawTarget, [string]$WikiRoot) {
    $target = $RawTarget.Trim().Split('|')[0].Split('#')[0].Trim()
    if ([string]::IsNullOrWhiteSpace($target) -or $target -match ':' -or $target.StartsWith('#')) { return $null }
    try {
        $candidates = @(Join-Path (Split-Path -Parent $SourceFile) $target; Join-Path $WikiRoot $target)
        foreach ($candidate in $candidates) {
            $withExtension = if ([IO.Path]::GetExtension($candidate)) { $candidate } else { "$candidate.md" }
            $full = [IO.Path]::GetFullPath($withExtension)
            if ((Test-IsWithin $full $WikiRoot) -and (Test-Path -LiteralPath $full -PathType Leaf)) { return $full }
        }
    } catch { return $null }
    return $null
}

$wikiRoot = (Resolve-Path -LiteralPath $SourceWikiPath).Path
if (-not (Test-Path -LiteralPath $wikiRoot -PathType Container)) { throw "SourceWikiPath is not a folder: $SourceWikiPath" }
$files = @(Get-ChildItem -LiteralPath $wikiRoot -File -Recurse | Where-Object { $_.Extension -eq '.md' } | Sort-Object FullName)
if ($files.Count -eq 0) { throw "No Markdown files were found in $wikiRoot" }

$links = [Collections.Generic.List[object]]::new()
$pages = foreach ($file in $files) {
    $relative = $file.FullName.Substring($wikiRoot.Length).TrimStart('\', '/').Replace('\', '/')
    $text = [IO.File]::ReadAllText($file.FullName, [Text.UTF8Encoding]::new($false, $true))
    $heading = [regex]::Match($text, '(?m)^#\s+(.+?)\s*$')
    $targets = @([regex]::Matches($text, '\[\[([^\]]+)\]\]') | ForEach-Object { $_.Groups[1].Value }) + @([regex]::Matches($text, '(?<!\!)\[[^\]]+\]\(([^)]+)\)') | ForEach-Object { $_.Groups[1].Value })
    foreach ($rawTarget in $targets) {
        $resolved = Get-LocalTarget $file.FullName $rawTarget $wikiRoot
        if ($null -ne $resolved) {
            [void]$links.Add([pscustomobject]@{ from = $relative; to = $resolved.Substring($wikiRoot.Length).TrimStart('\', '/').Replace('\', '/'); status = 'internal' })
        } elseif ($rawTarget -notmatch '(:|^#)') {
            [void]$links.Add([pscustomobject]@{ from = $relative; to = $rawTarget; status = 'unresolved-or-external' })
        }
    }
    [pscustomobject]@{
        path = $relative
        title = if ($heading.Success) { $heading.Groups[1].Value.Trim() } else { $null }
        sha256 = Hash-File $file.FullName
        top_level_group = if ($relative.Contains('/')) { $relative.Split('/')[0] } else { '(root)' }
    }
}

$digestInput = ($pages | ForEach-Object { "$($_.path)|$($_.sha256)" }) -join "`n"
$digestBytes = [Text.Encoding]::UTF8.GetBytes($digestInput)
$sha = [Security.Cryptography.SHA256]::Create()
try { $sourceDigest = ([BitConverter]::ToString($sha.ComputeHash($digestBytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }

[pscustomobject]@{
    operation = 'Workspace wiki migration inventory'
    source_wiki = $wikiRoot
    page_count = $pages.Count
    source_digest_sha256 = $sourceDigest
    index_candidates = @($pages | Where-Object { $_.path -match '(^|/)(_master-index|_index|index)\.md$' } | Select-Object -ExpandProperty path)
    top_level_groups = @($pages | Group-Object top_level_group | ForEach-Object { [pscustomobject]@{ name = $_.Name; page_count = $_.Count; pages = @($_.Group | Select-Object -ExpandProperty path) } })
    pages = @($pages)
    links = @($links)
    split_guidance = 'Use folders, page titles, and link relationships to propose a project Book, a reusable reference Book, or one combined Book. A split must include every linked local page needed by each destination; copying a shared dependency into both Books is allowed.'
    shared_library_write = $false
}
