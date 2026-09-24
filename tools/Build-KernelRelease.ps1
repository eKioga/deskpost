<#
.SYNOPSIS
    Build the release artefacts install.ps1 and install.sh install: one archive per platform, each the
    public program tree with the compiled kernel at bin/, and a SHA256SUMS over all of them.

.DESCRIPTION
    PLAN-public-release.md step 28, S19's row. `bun build --compile` turns kernel/src/cli.ts into one
    executable per platform; this helper puts each one where the executable can find the rest of the
    program.

    WHY THE ARCHIVE CARRIES THE PROGRAM TREE AND NOT THE BINARY ALONE. The kernel reads its own files
    -- the templates `library init` renders, the plugin manifest whose version it records, the hook
    and adapter scripts it registers, the Shelf catalog header -- and the hooks and the reader
    adapter are still PowerShell. Measured 2026-09-22 (S29): inside a compiled binary
    `import.meta.url` is `B:\~BUN\root\<name>.exe`, so the source-tree rule "two directories up" gives
    `B:\`, and all three `init` rows that write a workspace mismatched, 33 of 33 fields on the first.
    kernel/src/programroot.ts therefore finds a compiled kernel's program root one directory above
    its own, and a release is laid out to make that true:

        deskpost-<version>-<platform>/
          bin/library[.exe]      the compiled kernel
          release.json           the tuple: plugin, binary and workspace schema versions
          ...                    every file tools/PublicTreeAllowlist.ps1 admits

    The plugin root is the program root (tools/PluginPackage.ps1), so the same tree is what a
    harness installs as the plugin.

    THE FILE SET IS THE PUBLIC ALLOWLIST, AND AN UNTRACKED MATCH REFUSES THE BUILD, exactly as
    Export-PublicTree.ps1 refuses it: a file git has never seen has been through no review. The
    publishing job of step 12 builds from the EXPORTED public tree (-SourceRoot); built from this
    checkout, the archive is for installing on this machine and is not scanned for a release.

    THE BINARY'S VERSION IS BAKED IN (`--define LIBRARY_KERNEL_VERSION`), and the host platform's
    archive is smoke-run before it is zipped: `bin/library --version` must report that version,
    `compiled: true`, and the staged tree as its program root. A binary that cannot find its own
    program is refused here rather than on a reader's machine.

.PARAMETER Destination
    Where the archives and SHA256SUMS are written. Must be outside -SourceRoot and must not already
    hold files.

.PARAMETER Target
    Platforms to build: win-x64 (the default), win-arm64, macos-arm64, macos-x64, linux-x64,
    linux-arm64, or `all`. A cross-target build downloads that platform's Bun runtime.

.PARAMETER Bun
    The bun executable. Defaults to `bun` on PATH.

.PARAMETER SourceRoot
    The program tree to package. Defaults to this program's root.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Destination,
    [string[]]$Target = @('win-x64'),
    [string]$Bun,
    [string]$SourceRoot,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent $PSScriptRoot }
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\', '/')
. (Join-Path $SourceRoot 'tools/PublicTreeAllowlist.ps1')

# Step 28's six platforms, and the Bun target that builds each.
$script:Platforms = [ordered]@{
    'win-x64'     = @{ bun = 'bun-windows-x64'; exe = 'library.exe' }
    'win-arm64'   = @{ bun = 'bun-windows-arm64'; exe = 'library.exe' }
    'macos-arm64' = @{ bun = 'bun-darwin-arm64'; exe = 'library' }
    'macos-x64'   = @{ bun = 'bun-darwin-x64'; exe = 'library' }
    'linux-x64'   = @{ bun = 'bun-linux-x64'; exe = 'library' }
    'linux-arm64' = @{ bun = 'bun-linux-arm64'; exe = 'library' }
}

function Get-HostPlatform {
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { return 'win-arm64' }
    'win-x64'
}

function Read-ManifestVersion([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "the release needs $Path, and it does not exist." }
    $version = [string](Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json).version
    if (-not $version.Trim()) { throw "$Path has no version; a release pins one." }
    $version.Trim()
}

function Write-LfFile([string]$Path, [string]$Text) {
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Text.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
}

function New-ReleaseArchive {
    <#
        A zip written entry by entry, because Windows PowerShell 5.1's Compress-Archive writes
        backslash separators that unzip on macOS and Linux reads as part of the file name. The POSIX
        executables are marked 0755 in the entry's external attributes, which unzip honours; the
        installer sets the bit again rather than trusting that it survived.
    #>
    param([string]$StageRoot, [string]$RootName, [string]$ArchivePath, [string[]]$Executables)

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::Open($ArchivePath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in @(Get-ChildItem -LiteralPath $StageRoot -Recurse -File -Force | Sort-Object FullName)) {
            $relative = $file.FullName.Substring($StageRoot.Length).TrimStart('\', '/').Replace('\', '/')
            $entry = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $file.FullName, "$RootName/$relative", [IO.Compression.CompressionLevel]::Optimal)
            $mode = if ($Executables -contains $relative) { 0x81ED } else { 0x81A4 }   # 0100755 / 0100644
            $entry.ExternalAttributes = $mode -shl 16
        }
    } finally {
        $archive.Dispose()
    }
}

# --- preconditions -----------------------------------------------------------------------------

if (-not $Bun) {
    $found = Get-Command bun -ErrorAction SilentlyContinue
    if (-not $found) { throw 'bun is not on PATH, and -Bun names no executable. A release is compiled with `bun build --compile`; install Bun or pass -Bun.' }
    $Bun = $found.Source
}
if (-not (Test-Path -LiteralPath $Bun -PathType Leaf)) { throw "-Bun names $Bun, which does not exist." }

$targets = if ($Target -contains 'all') { @($script:Platforms.Keys) } else { @($Target) }
foreach ($name in $targets) {
    if (-not $script:Platforms.Contains($name)) {
        throw "unknown target '$name'. The targets are: $(@($script:Platforms.Keys) -join ', '), or all."
    }
}

$Destination = [IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')
if (($Destination + '\').StartsWith($SourceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "-Destination $Destination is inside the program tree it packages; the next build would package its own output."
}
if ((Test-Path -LiteralPath $Destination) -and @(Get-ChildItem -LiteralPath $Destination -Force).Count) {
    throw "-Destination $Destination already holds files; a release is written into an empty folder so SHA256SUMS names only this build."
}

$pluginVersion = Read-ManifestVersion (Join-Path $SourceRoot '.codex-plugin/plugin.json')
$binaryVersion = Read-ManifestVersion (Join-Path $SourceRoot 'kernel/package.json')
if ($binaryVersion -notmatch '^[0-9A-Za-z.+-]+$') { throw "kernel/package.json's version '$binaryVersion' is not one a build can define." }
$workspaceSchema = 1

$files = @(Get-PublicTreeFiles -Workspace $SourceRoot)
if (-not $files.Count) { throw "the public allowlist admits no file under $SourceRoot." }
if (@($files | Where-Object { $_ -like 'bin/*' -or $_ -eq 'release.json' }).Count) {
    throw 'the public tree already holds bin/ or release.json, which a release writes; the two would collide.'
}

$commit = $null
if (Test-Path -LiteralPath (Join-Path $SourceRoot '.git')) {
    $tracked = @(& git -C $SourceRoot ls-files)
    if ($LASTEXITCODE -ne 0) { throw "git ls-files failed in $SourceRoot." }
    $trackedSet = [Collections.Generic.HashSet[string]]::new([string[]]$tracked, [StringComparer]::Ordinal)
    $untracked = @($files | Where-Object { -not $trackedSet.Contains($_) })
    if ($untracked.Count) {
        throw ("the public allowlist admits {0} file(s) git does not track, and a release carries only reviewed files: {1}" -f
               $untracked.Count, (($untracked | Select-Object -First 10) -join ', '))
    }
    $commit = (& git -C $SourceRoot rev-parse HEAD).Trim()
    $dirty = @(& git -C $SourceRoot status --porcelain -- @($files))
}

# --- build -------------------------------------------------------------------------------------

New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$stageParent = Join-Path $Destination '.stage'
$hostPlatform = Get-HostPlatform
$built = [Collections.Generic.List[object]]::new()

try {
    foreach ($platform in $targets) {
        $spec = $script:Platforms[$platform]
        $rootName = "deskpost-$pluginVersion-$platform"
        $stage = Join-Path $stageParent $rootName
        foreach ($relative in $files) {
            $to = Join-Path $stage $relative
            $toDirectory = Split-Path -Parent $to
            if (-not (Test-Path -LiteralPath $toDirectory)) { New-Item -ItemType Directory -Path $toDirectory -Force | Out-Null }
            Copy-Item -LiteralPath (Join-Path $SourceRoot $relative) -Destination $to
        }

        # THE ONE PLACE A RELEASE'S PLUGIN FILES DIFFER FROM THE COMMITTED ONES (S37): a Windows archive
        # carries the Codex hooks rendered with `& `, because Codex runs a hook through powershell.exe
        # there. tools/PluginPackage.ps1 owns the rule and its self-test; this only asks for it.
        $render = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $SourceRoot 'tools/PluginPackage.ps1') `
            -RenderReleaseStage $stage -Platform $platform 2>&1
        if ($LASTEXITCODE -ne 0) { throw "rendering the $platform plugin files failed: $(($render | Out-String).Trim())" }
        $pluginRender = (($render | Out-String).Trim())

        $binary = Join-Path $stage "bin/$($spec.exe)"
        # A SINGLE-QUOTED JS STRING, because Windows PowerShell 5.1 drops the double quotes embedded in a
        # native argument and bun then reads `0.1.0` as an expression (measured). And bun's progress on
        # stderr must not become a terminating error under -ErrorAction Stop, so the exit code judges.
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $output = & $Bun build --compile "--target=$($spec.bun)" --define "LIBRARY_KERNEL_VERSION='$binaryVersion'" `
                (Join-Path $SourceRoot 'kernel/src/cli.ts') --outfile $binary 2>&1
        } finally {
            $ErrorActionPreference = $previousPreference
        }
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $binary -PathType Leaf)) {
            throw "bun build --compile for $platform failed (exit $LASTEXITCODE): $(($output | Out-String).Trim())"
        }

        $tuple = [ordered]@{
            schema           = 1
            name             = 'deskpost'
            platform         = $platform
            plugin_version   = $pluginVersion
            binary_version   = $binaryVersion
            workspace_schema = $workspaceSchema
            source_commit    = $commit
        }
        Write-LfFile (Join-Path $stage 'release.json') (($tuple | ConvertTo-Json) + "`n")

        # THE HOST'S BINARY IS RUN BEFORE IT IS SHIPPED. A cross-built one cannot be run here, and the
        # result says so rather than reporting it verified.
        $smoke = 'not run: built for another platform'
        if ($platform -eq $hostPlatform) {
            $reported = (& $binary --version | Out-String) | ConvertFrom-Json
            if ($LASTEXITCODE -ne 0) { throw "the built $platform binary exited $LASTEXITCODE on --version." }
            if ($reported.binary_version -ne $binaryVersion -or $reported.compiled -ne $true -or
                [IO.Path]::GetFullPath([string]$reported.program_root).TrimEnd('\') -ne [IO.Path]::GetFullPath($stage).TrimEnd('\') -or
                $reported.plugin_version -ne $pluginVersion) {
                throw "the built $platform binary reports $($reported | ConvertTo-Json -Compress), not version $binaryVersion compiled with $stage as its program root."
            }
            $smoke = 'passed'
        }

        $archivePath = Join-Path $Destination "$rootName.zip"
        $executables = @("bin/$($spec.exe)")
        if ($spec.exe -eq 'library') { $executables += 'library' }
        $binaryBytes = (Get-Item -LiteralPath $binary).Length
        New-ReleaseArchive -StageRoot $stage -RootName $rootName -ArchivePath $archivePath -Executables $executables
        Remove-Item -LiteralPath $stage -Recurse -Force

        $built.Add([pscustomobject]@{
            platform     = $platform
            archive      = Split-Path -Leaf $archivePath
            sha256       = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
            bytes        = (Get-Item -LiteralPath $archivePath).Length
            binary_bytes = $binaryBytes
            smoke        = $smoke
            plugin       = $pluginRender
        })
    }
} finally {
    if (Test-Path -LiteralPath $stageParent) { Remove-Item -LiteralPath $stageParent -Recurse -Force }
}

# THE INSTALLERS SHIP BESIDE THE ARCHIVES, because the one-line install fetches them from the same
# release URL it then reads SHA256SUMS from. They are not in SHA256SUMS: they are what reads it.
foreach ($installer in 'install.ps1', 'install.sh') {
    Copy-Item -LiteralPath (Join-Path $SourceRoot $installer) -Destination (Join-Path $Destination $installer)
}

# sha256sum's own format, so `sha256sum -c` and install.sh read the same file install.ps1 does.
$sums = ($built | ForEach-Object { "$($_.sha256)  $($_.archive)" }) -join "`n"
Write-LfFile (Join-Path $Destination 'SHA256SUMS') ($sums + "`n")

$result = [pscustomobject]@{
    destination      = $Destination
    plugin_version   = $pluginVersion
    binary_version   = $binaryVersion
    workspace_schema = $workspaceSchema
    source_commit    = $commit
    uncommitted      = if ($null -eq $commit) { $null } else { $dirty.Count }
    file_count       = $files.Count
    archives         = @($built)
}
if ($Json) { $result | ConvertTo-Json -Depth 5 } else { $result }
