<#
.SYNOPSIS
    The reviewed allowlist of product paths that may reach a public repository, and the resolver
    that turns it into a file set.

.DESCRIPTION
    PLAN-public-release.md step 14. This file exists apart from tools/Export-PublicTree.ps1 for one
    reason: two different consumers need the same answer, and if either owned the list the other
    would have to reach across a boundary to get it.

      - tools/Export-PublicTree.ps1 asks "what do I copy into the staging tree".
      - tools/DeploymentScan.ps1 asks "what must I scan", and the plan's scope for that scan is
        "tracked files AND anything the allowlist would export". A scan that read only `git
        ls-files` would go blind the day a rule here admitted a path git has never seen.

    So the list lives here, both dot-source it, and nothing dot-sources them back. The import graph
    is a line, not a cycle.

    AN ALLOWLIST, NOT A DENYLIST, AND THAT IS THE WHOLE SECURITY ARGUMENT. A denylist ships every
    file nobody thought to name. This tree holds the reader's Notebook, their raw source material,
    their Shelf and their seat state; a public export driven by "everything except the bad bits" is
    one forgotten pattern away from publishing a reading history. So nothing ships unless a rule
    below names it or names a directory above it, and the deny patterns that follow are a second
    pass over an already-small set, never the primary filter.

    THE DENY PATTERNS ARE NOT REDUNDANT EVEN SO. `.claude/hooks/` is an include root and
    `.claude/hooks/.capture/` holds raw hook payloads carrying the reader's own paths. One is inside
    the other. An include root is a statement about a role, not a promise that everything that ever
    lands under it is product, and the deny list is where that gap is closed.

    `.codex/` IS TWO FILES, NOT A DIRECTORY, AND THAT WAS MEASURED. On 2026-09-19 the directory held
    `config.template.toml` and `hooks.template.json`, which are product, beside `config.toml`,
    `hooks.json` and two `.bak` copies, which are this machine's generated Codex configuration and
    carry the live Basic Memory endpoint. A directory rule would have swept all six into staging.
    The scan would then have refused the export -- correctly, and with a message about a leaked
    endpoint rather than about a rule that was too wide. Naming the two files says the true thing at
    the point where it is easy to fix.

    A RULE THAT MATCHES AN UNTRACKED FILE REFUSES THE EXPORT RATHER THAN SHIPPING IT. Resolution
    runs over the FILESYSTEM, because "what would this rule export" is a question about what is on
    disk. But a file git has never seen has been through no review and no commit, and the one thing
    this export must never do is carry the reader's own material out. Export-PublicTree.ps1 names
    those files and stops. The scan, by contrast, reads them: a leak should fail loudly at the scan
    even if somebody copies the tree by hand.

    Dot-sourced. Declared `internal` in tools/_helpers.json and deliberately not allowlisted.
#>

Set-StrictMode -Version Latest

# Directories whose entire contents are product, subject to the deny patterns below. Recursive.
$script:PublicTreeIncludeDirectories = @(
    '.claude/adapters',
    '.claude/hooks',
    '.claude/rules',
    '.claude/skills',
    '.githooks',
    'docs',
    # The Claude files generated from the canonical manifests, plus the repo-scoped marketplace
    # (PLAN-public-release.md step 19). It is the thing being published, so an export that omitted
    # it would ship a repository whose own plugin is missing.
    #
    # `plugin/` USED TO BE THIS LINE, until 2026-09-20 measured what a plugin install actually
    # copies: only the directory the marketplace entry names as its source, so a package rooted in a
    # subdirectory would have had to carry the whole program. The plugin root is now the repository
    # root -- which is why `hooks` appears below and `plugin.json` and `mcp.json` appear among the
    # files. Removing an include root is as much an edit as adding one, and this list is the only
    # place that says so.
    '.claude-plugin',
    # The canonical Codex manifest, at the address Codex actually reads -- measured from the two
    # Codex plugins installed on this machine, both of which carry `.codex-plugin/plugin.json` and
    # neither of which has one at the plugin root.
    '.codex-plugin',
    # Codex's repo-scoped marketplace, which is a DIFFERENT file in a different place from Claude's
    # `.claude-plugin/marketplace.json` and carries a different entry shape.
    '.agents',
    # The workspace instruction templates `library init` writes into a new workspace's CLAUDE.md and
    # AGENTS.md (PLAN-public-release.md step 20). Product by the same argument as `plugin/`: a
    # published tree whose initialiser cannot find its own template refuses on the reader's first
    # command, and it would refuse having already been installed.
    'templates',
    'tools',
    # The TypeScript kernel (PLAN-public-release.md steps 23-28, added 2026-09-22 by S13). It is the
    # implementation the PowerShell tools are being ported into and the thing step 28 compiles into
    # the single binary a reader installs, so a public tree without it ships a program whose own
    # future is missing. `node_modules/` and `dist/` are denied below rather than here: an include
    # root is a statement about a role, and a build output is not product even when it lives inside
    # one.
    'kernel'
)

# Individual product files. Named one by one because each sits beside something that is not
# product: `.codex/` holds this machine's generated Codex configuration, and the repository root
# holds every PLAN record.
$script:PublicTreeIncludeFiles = @(
    '.claude/settings.json',
    '.codex/config.template.toml',
    '.codex/hooks.template.json',
    # The third Codex template, added 2026-09-22: library init renders it into a reader's workspace,
    # so a public tree without it ships an initialiser whose Codex half degrades in silence.
    '.codex/workspace-config.template.toml',
    '.gitignore',
    '.mcp.json',
    'AGENTS.md',
    'CLAUDE.md',
    'CONTEXT.md',
    'CONTRIBUTING.md',
    # The installers of step 28 (S19). A release ships them BESIDE its archives, since the one-line
    # install fetches them from the release URL; they are in the tree because tools/Build-KernelRelease.ps1
    # copies them from here, and a reader who cloned instead of downloading should find them too.
    'install.ps1',
    'install.sh',
    'LICENSE',
    # THE ENTRY POINT, and it is product before anything else here is. library desk is what the
    # workspace instructions this tree ships tell a reader to type, so a published program without
    # it is one whose own first instruction refuses. The .cmd shim travels with the .ps1 it names:
    # %~dp0 is what keeps the pair together, and one without the other is a command that resolves
    # and then cannot run.
    # Three names for one command, and each is the only one its shell will resolve: library.cmd"
  
    # for the dispatcher both of them exec.
    'library',
    'library.cmd',
    'library.ps1',
    'README.md'
)

# The second pass. Each pattern names a category that can appear UNDER an include root, which is
# the only reason a deny list is needed at all beside an allowlist.
$script:PublicTreeDenyPatterns = @(
    # Raw hook payloads: the reader's own paths, captured from a boundary this tree does not own.
    '(^|/)\.capture(/|$)',
    # Machine-local harness settings. Never product, and the one file most likely to carry a token.
    '(^|/)settings\.local\.json$',
    # Editor and tooling debris that a directory rule would otherwise pick up.
    '(^|/)[^/]*\.bak$',
    '(^|/)\.git(/|$)',
    # Private design records. They cannot reach an include root today, and they are named anyway:
    # a future rule that admits the repository root must not quietly start exporting them.
    '^PLAN[^/]*\.md$',
    '^codex-verdict\.txt$',
    # Dependency and build trees under `kernel/`. Never product, always re-fetchable or re-derivable,
    # and a directory rule over the kernel would otherwise sweep tens of thousands of files into
    # staging -- where the scan would then read every one of them.
    '(^|/)node_modules(/|$)',
    '^kernel/dist(/|$)'
)

function Get-PublicTreeAllowlistRules {
    <#
        The rules themselves, for a caller that wants to report or assert on them rather than
        resolve them. Copies are returned so a caller cannot edit the module's own lists.
    #>
    [pscustomobject]@{
        directories = @($script:PublicTreeIncludeDirectories)
        files       = @($script:PublicTreeIncludeFiles)
        deny        = @($script:PublicTreeDenyPatterns)
    }
}

function Test-PublicTreePathDenied {
    <#
        True when a relative path matches any deny pattern. Relative paths are spelled with forward
        slashes everywhere in this file, so the patterns need only one separator.
    #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Relative)

    foreach ($pattern in $script:PublicTreeDenyPatterns) {
        if ($Relative -imatch $pattern) { return $true }
    }
    $false
}

function ConvertTo-PublicTreeRelativePath {
    <#
        A full path, as a workspace-relative path with forward slashes. Case is preserved: NTFS
        compares case-insensitively but the export writes these names into a repository that a
        Linux checkout will read literally.
    #>
    param(
        [Parameter(Mandatory)][string]$Workspace,
        [Parameter(Mandatory)][string]$FullName
    )

    $root = [IO.Path]::GetFullPath($Workspace).TrimEnd('\', '/')
    $full = [IO.Path]::GetFullPath($FullName)
    if ($full.Length -le $root.Length) { return '' }
    $full.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
}

function Get-PublicTreeFiles {
    <#
        Every file the allowlist would export, as workspace-relative paths with forward slashes.

        -Force on the directory walk is deliberate. A hidden file under an include root is still a
        file the export would copy, and a resolver that could not see it would report a clean tree
        and ship it anyway. Hidden is a display attribute, not a scope rule.
    #>
    param([Parameter(Mandatory)][string]$Workspace)

    $found = [Collections.Generic.List[string]]::new()

    foreach ($directory in $script:PublicTreeIncludeDirectories) {
        $full = Join-Path $Workspace $directory
        if (-not (Test-Path -LiteralPath $full -PathType Container)) { continue }
        foreach ($item in @(Get-ChildItem -LiteralPath $full -Recurse -File -Force -ErrorAction SilentlyContinue)) {
            $relative = ConvertTo-PublicTreeRelativePath -Workspace $Workspace -FullName $item.FullName
            if ([string]::IsNullOrWhiteSpace($relative)) { continue }
            if (Test-PublicTreePathDenied -Relative $relative) { continue }
            [void]$found.Add($relative)
        }
    }

    foreach ($file in $script:PublicTreeIncludeFiles) {
        $full = Join-Path $Workspace $file
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        if (Test-PublicTreePathDenied -Relative $file) { continue }
        [void]$found.Add($file)
    }

    # Sorted and de-duplicated: a file named by a rule and also sitting under an include root is one
    # file, and a stable order makes two runs comparable.
    @($found | Sort-Object -Unique)
}

function Get-PublicTreeMissingRules {
    <#
        Include-file rules that name nothing on disk.

        Reported, never refused. CONTRIBUTING.md is written by step 17 in the same session that
        this list first names it, and a resolver that refused on its absence would make the two
        steps impossible to do in either order. A typo'd rule shows up here just the same, which is
        the case worth seeing.
    #>
    param([Parameter(Mandatory)][string]$Workspace)

    $missing = [Collections.Generic.List[string]]::new()
    foreach ($file in $script:PublicTreeIncludeFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $Workspace $file) -PathType Leaf)) { [void]$missing.Add($file) }
    }
    foreach ($directory in $script:PublicTreeIncludeDirectories) {
        if (-not (Test-Path -LiteralPath (Join-Path $Workspace $directory) -PathType Container)) { [void]$missing.Add($directory + '/') }
    }
    @($missing | Sort-Object -Unique)
}
