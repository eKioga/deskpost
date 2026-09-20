<#
.SYNOPSIS
    Mirror a collection's Books, Projects and catalogs into an Obsidian vault, one generation at a
    time, one way, byte for byte.

.DESCRIPTION
    PLAN-public-release.md step 15. Replaces `D:\library-mirror`'s per-file exporter, whose careful
    per-note state machine solved a problem this one does not have: it wrote into a live folder, so
    every file needed its own decision about whether the reader had touched it. This writes a whole
    GENERATION beside the mirror and swaps it in, which turns thirteen per-file states into one
    question asked twice -- before the swap, and after it.

    WHAT IT COPIES. `books/` and `projects/` entire, which carries the two catalogs (`books/README.md`
    and `projects/README.md`) with them. Bodies are copied byte for byte and links are never
    rewritten: an export that edited a link would make the vault's copy a different document from
    the Book, and the Book is the record.

    THE CONTRACT, clause by clause, and where each one lives:

    (a) SOURCE CAPTURE UNDER WRITER EXCLUSION. `Enter-CollectionExportLock` in BookWriteGuard.ps1
        takes a collection-wide lock in the workspace's own lock namespace and refuses if any Book
        lock is held. `Enter-BookLock` and `Assert-SeatClaimHeld` refuse while it is held, which is
        every Shelf writer, Hub edit, manifest transaction, publication, refresh and archive. The
        capture completes before the lock is released, so no publication can start mid-capture.

    (b) A MANIFEST of every managed destination path with its exported hash, written with the
        generation it describes and copied to `current-manifest.json` when that generation goes live.

    (c) RECOVERABLE, JOURNALLED ACTIVATION THAT KEEPS THE PREVIOUS GENERATION. An Obsidian editor
        cannot be excluded from the destination, so the destination contract is not "nobody touches
        it" -- it is "anything that touched it is found and kept". Every managed file is re-hashed
        against the old manifest immediately before activation and a mismatch refuses the run. The
        swap is two renames with a journal entry between them (ADR-0034). After activation the
        RETAINED generation is re-hashed against the OLD manifest, so an edit that landed inside the
        activation window is found there, reported as `vault-edited-during-activation`, and copied
        to `40-Resources\Library-recovered\<run-id>\`. The retained generation is deleted only after
        that check passes.

    (d) A LATER RUN THAT FINDS A LEFTOVER staged or retained generation verifies it against its
        manifest and completes the step it was in. It never merges: the journal says which of the
        two renames happened, the filesystem is observed to agree, and a state no rename could have
        produced is a refusal naming both paths.

    (e) MANAGED PATHS WHOSE SOURCE HAS GONE are removed, because the new generation simply does not
        contain them. UNMANAGED files -- anything in the mirror that no manifest claims -- are never
        touched: they are carried into the new generation before activation. A new source path whose
        destination exists and is unmanaged refuses the run listing the collisions, because writing
        there would silently take ownership of something the reader made.

    (f) OVERLAPPING ROOTS AND LINK ESCAPES are refused: a source inside the mirror, a mirror inside
        the source, a state root inside the mirror, and any reparse point in the source tree.

    NOTHING HERE HAS A DEFAULT THAT NAMES A MACHINE. `-VaultRoot` has no fallback path in code; it
    comes from the argument or `LIBRARY_VAULT_ROOT`, and the refusal names both. `-SourceRoot`
    resolves through tools/LibraryDeployment.ps1 like every other helper. PLAN-public-release.md
    step 11 removed the last committed deployment value and `public.no-deployment-defaults` is what
    keeps it that way; a path put back here to make a run work would fail the commit.

.PARAMETER Preflight
    Read-only. Writes nothing -- not the manifest, not a journal, not a staged generation -- and
    reports what it would do plus a `plan_id`.

.PARAMETER UserConfirmed / .PARAMETER ApprovedPlanId
    Execution needs both. The `plan_id` binds the roots, every source hash, every managed
    destination hash and the unmanaged file list, so an approval cannot be replayed against a world
    that changed underneath it.

.PARAMETER AdoptExistingMirror
    For the first run only, against a mirror some earlier tool wrote. Without a manifest every
    destination file is unmanaged, so (e) would refuse on every path. This says "retain what is
    there as a generation and start managing this tree" -- the existing mirror is renamed aside and
    KEPT, never deleted, because no old manifest exists to verify it against.

.PARAMETER ResumeRunId
    Finish or undo an interrupted run. The journal names the stage; the filesystem is observed to
    agree with it; a disagreement refuses.
#>
[CmdletBinding()]
param(
    [string]$SourceRoot,
    # No default in code, deliberately -- see the description. The environment variable is the
    # machine-local route and the argument is the explicit one.
    [string]$VaultRoot = $env:LIBRARY_VAULT_ROOT,
    [string]$MirrorRelPath = '40-Resources\Library',
    [string]$StateRoot = '',
    [string]$WorkspacePath,

    [switch]$Preflight,
    [switch]$UserConfirmed,
    [string]$ApprovedPlanId,
    [switch]$AdoptExistingMirror,
    [string]$ResumeRunId,

    # The acceptance suite's only way in. A run carrying one says so on every surface it writes, so
    # a faulted run can never be mistaken for a real one.
    [string]$FaultAfterStage,
    [switch]$SelfTest,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:VaultExportVersion = '1.0.0'
$script:VaultExportManifestSchema = 1
$script:VaultExportSourceFolders = @('books', 'projects')

. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
. (Join-Path $PSScriptRoot 'AtomicFile.ps1')

# ==================================================================================================
# Paths and hashes
# ==================================================================================================

function Get-VaultExportSha256([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try { -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) }
        finally { $stream.Dispose() }
    }
    finally { $sha.Dispose() }
}

function Get-VaultExportTextDigest([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
}

function ConvertTo-VaultExportRelative([string]$Root, [string]$FullPath) {
    # One spelling for every relative path in a manifest, a journal and a plan_id: forward slashes,
    # no leading separator. A path spelled two ways is two entries in a manifest that describes one
    # file, and the hash comparison that is supposed to find an edit finds a missing file instead.
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $full = [IO.Path]::GetFullPath($FullPath)
    if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The path $FullPath is not under $Root, so it has no relative spelling there."
    }
    $full.Substring($rootFull.Length).TrimStart('\', '/') -replace '\\', '/'
}

function Test-VaultExportPathInside([string]$Outer, [string]$Inner) {
    $o = [IO.Path]::GetFullPath($Outer).TrimEnd('\', '/') + '\'
    $i = [IO.Path]::GetFullPath($Inner).TrimEnd('\', '/') + '\'
    $i.StartsWith($o, [StringComparison]::OrdinalIgnoreCase)
}

function Get-VaultExportVolume([string]$Path) {
    ([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Path))).TrimEnd('\', '/').ToLowerInvariant()
}

# ==================================================================================================
# Inventories
# ==================================================================================================

function Get-VaultExportSourceInventory {
    <#
        Every file under the source folders, with its hash. A reparse point anywhere in the tree
        refuses the whole run: a junction inside `books/` would make the export copy whatever it
        points at into the vault, which is the link escape clause (f) names.
    #>
    param([Parameter(Mandatory)][string]$SourceRoot)

    $files = [ordered]@{}
    foreach ($folder in $script:VaultExportSourceFolders) {
        $root = Join-Path $SourceRoot $folder
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            throw ("The source has no $folder/ directory at $root, so this run would mirror an " +
                   'incomplete collection. Nothing was written.')
        }
        foreach ($item in @(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw ("$($item.FullName) is a reparse point. A link in the source would copy its " +
                       'target into the vault, so the run is refused rather than followed.')
            }
            if ($item.PSIsContainer) { continue }
            $relative = ConvertTo-VaultExportRelative -Root $SourceRoot -FullPath $item.FullName
            $files[$relative] = [pscustomobject]@{ sha256 = (Get-VaultExportSha256 $item.FullName); bytes = [int64]$item.Length }
        }
    }
    if (-not $files.Count) {
        throw "The source at $SourceRoot holds no files under $($script:VaultExportSourceFolders -join ' or '), so this run read nothing rather than mirroring an empty collection."
    }
    $files
}

function Get-VaultExportDestinationInventory {
    <#
        Every file in the live mirror, with its hash. Returns an empty map when the mirror does not
        exist yet, which is a fresh export rather than an error.
    #>
    param([Parameter(Mandatory)][string]$MirrorPath)
    $files = [ordered]@{}
    if (-not (Test-Path -LiteralPath $MirrorPath -PathType Container)) { return $files }
    foreach ($item in @(Get-ChildItem -LiteralPath $MirrorPath -Recurse -Force -File -ErrorAction Stop)) {
        $relative = ConvertTo-VaultExportRelative -Root $MirrorPath -FullPath $item.FullName
        $files[$relative] = [pscustomobject]@{ sha256 = (Get-VaultExportSha256 $item.FullName); bytes = [int64]$item.Length }
    }
    $files
}

# ==================================================================================================
# Manifests
# ==================================================================================================

function New-VaultExportManifest {
    param([Parameter(Mandatory)][string]$GenerationId, [Parameter(Mandatory)][string]$SourceRoot,
          [Parameter(Mandatory)][string]$MirrorPath, [Parameter(Mandatory)]$Files)
    $entries = [ordered]@{}
    foreach ($key in $Files.Keys) { $entries[$key] = [pscustomobject]@{ sha256 = $Files[$key].sha256; bytes = $Files[$key].bytes } }
    [pscustomobject]@{
        schema        = $script:VaultExportManifestSchema
        tool_version  = $script:VaultExportVersion
        generation_id = $GenerationId
        exported_utc  = [DateTime]::UtcNow.ToString('o')
        source_root   = $SourceRoot
        mirror_path   = $MirrorPath
        files         = $entries
    }
}

function Write-VaultExportManifest([string]$Path, $Manifest) {
    # Out-Null in the same statement as the call. Write-AtomicText returns the path it wrote, and a
    # value returned here would join the output of every function that calls it -- so a caller
    # reading one property off "the result" would be reading a string.
    Write-AtomicText -Path $Path -Text (($Manifest | ConvertTo-Json -Depth 8) + "`n") | Out-Null
}

function Read-VaultExportManifest([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    # Named encoding at the boundary. A Book title with an accent in a manifest path read through
    # the default codepage stops matching the file it describes, and the mismatch reads as an edit.
    ([IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))) | ConvertFrom-Json
}

function Get-VaultExportManifestFiles($Manifest) {
    <#
        A manifest's `files` object as a plain map. ConvertFrom-Json hands back a PSCustomObject
        rather than a hashtable, and every comparison below wants key lookup.
    #>
    $map = [ordered]@{}
    if ($null -eq $Manifest) { return $map }
    if ($null -eq $Manifest.PSObject.Properties['files']) { return $map }
    foreach ($prop in $Manifest.files.PSObject.Properties) {
        $map[$prop.Name] = [pscustomobject]@{ sha256 = [string]$prop.Value.sha256; bytes = [int64]$prop.Value.bytes }
    }
    $map
}

# ==================================================================================================
# The journal. Load-bearing between the two renames -- see ADR-0034.
# ==================================================================================================

function Get-VaultExportJournalDirectory([string]$Workspace) {
    $dir = Join-Path $Workspace 'internal/vault-export-journals'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $dir
}

function Write-VaultExportJournalStage {
    <#
        Appends one stage and flushes. Called BEFORE the action it names, never after: between the
        two renames the journal is the only thing that knows how to finish, and a stage written
        afterwards is a stage that is missing exactly when it is needed.
    #>
    param([Parameter(Mandatory)][string]$JournalPath, [Parameter(Mandatory)]$Journal,
          [Parameter(Mandatory)][string]$Stage, [string]$Detail = '')
    $Journal.stages += ,([pscustomobject]@{ stage = $Stage; utc = [DateTime]::UtcNow.ToString('o'); detail = $Detail })
    $Journal.last_stage = $Stage
    Write-AtomicText -Path $JournalPath -Text (($Journal | ConvertTo-Json -Depth 10) + "`n") | Out-Null
}

function Read-VaultExportJournal([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    ([IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))) | ConvertFrom-Json
}

function Find-VaultExportUnfinishedRuns([string]$Workspace) {
    $dir = Get-VaultExportJournalDirectory -Workspace $Workspace
    @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
        $journal = Read-VaultExportJournal $_.FullName
        if ($null -eq $journal) { return }
        if ([string]$journal.last_stage -in @('complete', 'rolled-back')) { return }
        [pscustomobject]@{ run_id = [string]$journal.run_id; path = $_.FullName; last_stage = [string]$journal.last_stage }
    })
}

# ==================================================================================================
# Copying
# ==================================================================================================

function Copy-VaultExportFile {
    param([Parameter(Mandatory)][string]$From, [Parameter(Mandatory)][string]$To, [string]$ExpectedSha)
    $parent = Split-Path -Parent $To
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $From -Destination $To -Force
    # READBACK, not a trusted copy. Byte-exact is the promise; a copy that succeeded and wrote
    # different bytes is the failure this whole design is downstream of.
    if ($ExpectedSha) {
        $actual = Get-VaultExportSha256 $To
        if ($actual -cne $ExpectedSha) {
            throw "Copied $From to $To and read back $actual instead of $ExpectedSha. Nothing was activated."
        }
    }
}

# ==================================================================================================
# The plan
# ==================================================================================================

function New-VaultExportPlan {
    <#
        Everything the run would do, derived identically in the preflight and under the lock. The
        plan_id is a digest of the roots and of every hash on both sides, so an approval previewed
        against one world cannot authorise a write into another.
    #>
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$MirrorPath,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)]$SourceFiles,
        [Parameter(Mandatory)]$DestinationFiles,
        $CurrentManifest,
        [switch]$Adopt
    )

    $managed = Get-VaultExportManifestFiles $CurrentManifest
    $hasManifest = ($null -ne $CurrentManifest)

    # --- Every destination file, split by who owns it ---------------------------------------------
    $unmanaged = [ordered]@{}
    foreach ($key in $DestinationFiles.Keys) {
        if (-not $managed.Contains($key)) { $unmanaged[$key] = $DestinationFiles[$key] }
    }

    # --- (c) the pre-activation verification ------------------------------------------------------
    # A managed file that no longer hashes to what was exported is an edit in the vault, and the run
    # refuses rather than overwriting it. A managed file that is GONE is the same answer: the reader
    # deleted it, and replacing it silently would undo that.
    $edited = [Collections.Generic.List[string]]::new()
    foreach ($key in $managed.Keys) {
        if (-not $DestinationFiles.Contains($key)) { [void]$edited.Add("$key (removed in the vault)"); continue }
        if ($DestinationFiles[$key].sha256 -cne $managed[$key].sha256) { [void]$edited.Add("$key (edited in the vault)") }
    }

    # --- (e) a new managed path landing on an unmanaged file --------------------------------------
    $collisions = @($SourceFiles.Keys | Where-Object { $unmanaged.Contains($_) })

    # --- what changes ------------------------------------------------------------------------------
    $added = @($SourceFiles.Keys | Where-Object { -not $managed.Contains($_) })
    $removed = @($managed.Keys | Where-Object { -not $SourceFiles.Contains($_) })
    $changed = @($SourceFiles.Keys | Where-Object { $managed.Contains($_) -and $managed[$_].sha256 -cne $SourceFiles[$_].sha256 })

    $unchanged = ($hasManifest -and -not $added.Count -and -not $removed.Count -and -not $changed.Count -and -not $edited.Count)

    $digestSource = [Collections.Generic.List[string]]::new()
    [void]$digestSource.Add("tool=$($script:VaultExportVersion)")
    [void]$digestSource.Add("source=$([IO.Path]::GetFullPath($SourceRoot).ToLowerInvariant())")
    [void]$digestSource.Add("mirror=$([IO.Path]::GetFullPath($MirrorPath).ToLowerInvariant())")
    [void]$digestSource.Add("state=$([IO.Path]::GetFullPath($StateRoot).ToLowerInvariant())")
    [void]$digestSource.Add("adopt=$([bool]$Adopt)")
    foreach ($key in @($SourceFiles.Keys | Sort-Object)) { [void]$digestSource.Add("s|$key|$($SourceFiles[$key].sha256)") }
    foreach ($key in @($DestinationFiles.Keys | Sort-Object)) { [void]$digestSource.Add("d|$key|$($DestinationFiles[$key].sha256)") }
    foreach ($key in @($managed.Keys | Sort-Object)) { [void]$digestSource.Add("m|$key|$($managed[$key].sha256)") }

    # CARRIED AND UNMANAGED ARE NOT THE SAME LIST, and saying they were made the preflight's own
    # summary contradict the run it was describing: under adoption nothing is carried forward,
    # because the whole existing tree is retained as a generation instead. A report that says a file
    # will be carried when it will be retained is a wrong label on a correct artifact, and every
    # assertion about the artifact still passes.
    $carriedForward = @($unmanaged.Keys)
    $retainedNotCarried = 0
    if ($Adopt) {
        $carriedForward = @()
        $retainedNotCarried = $unmanaged.Count
    }

    [pscustomobject]@{
        plan_id            = 'export-collection-to-vault-' + (Get-VaultExportTextDigest ($digestSource -join "`n"))
        source_root        = $SourceRoot
        mirror_path        = $MirrorPath
        state_root         = $StateRoot
        has_manifest       = $hasManifest
        adopt              = [bool]$Adopt
        source_file_count  = $SourceFiles.Count
        managed_count      = $managed.Count
        unmanaged          = @($unmanaged.Keys)
        carried_forward    = $carriedForward
        retained_not_carried = $retainedNotCarried
        collisions         = @($collisions)
        vault_edited       = @($edited)
        added              = @($added)
        removed            = @($removed)
        changed            = @($changed)
        unchanged          = $unchanged
    }
}

# ==================================================================================================
# Activation and recovery
# ==================================================================================================

function Invoke-VaultExportActivation {
    <#
        The two renames of ADR-0034, with the journal entry between them. Nothing else moves a
        directory in this file.
    #>
    param(
        [Parameter(Mandatory)][string]$MirrorPath,
        [Parameter(Mandatory)][string]$StagedPath,
        [Parameter(Mandatory)][string]$RetainedPath,
        [Parameter(Mandatory)][string]$JournalPath,
        [Parameter(Mandatory)]$Journal,
        [string]$FaultAfterStage
    )

    Write-VaultExportJournalStage -JournalPath $JournalPath -Journal $Journal -Stage 'activation-begin' `
        -Detail "live=$MirrorPath retained=$RetainedPath staged=$StagedPath"
    if ($FaultAfterStage -ceq 'activation-begin') { throw "FAULT INJECTED after activation-begin (a real run never reaches this)." }

    $liveExists = Test-Path -LiteralPath $MirrorPath -PathType Container
    if ($liveExists) {
        $retainedParent = Split-Path -Parent $RetainedPath
        if (-not (Test-Path -LiteralPath $retainedParent -PathType Container)) { New-Item -ItemType Directory -Path $retainedParent -Force | Out-Null }
        [IO.Directory]::Move($MirrorPath, $RetainedPath)
    }
    Write-VaultExportJournalStage -JournalPath $JournalPath -Journal $Journal -Stage 'live-moved-aside' `
        -Detail $(if ($liveExists) { "retained at $RetainedPath" } else { 'there was no live mirror to retain' })
    if ($FaultAfterStage -ceq 'live-moved-aside') { throw "FAULT INJECTED after live-moved-aside (a real run never reaches this)." }

    $mirrorParent = Split-Path -Parent $MirrorPath
    if (-not (Test-Path -LiteralPath $mirrorParent -PathType Container)) { New-Item -ItemType Directory -Path $mirrorParent -Force | Out-Null }
    [IO.Directory]::Move($StagedPath, $MirrorPath)
    Write-VaultExportJournalStage -JournalPath $JournalPath -Journal $Journal -Stage 'activation-complete' -Detail "live=$MirrorPath"
}

function Invoke-VaultExportWindowCheck {
    <#
        (c), the half that runs AFTER the swap. Re-hashes the retained generation against the OLD
        manifest: anything that differs was written into the vault between the pre-activation
        verification and the first rename, which is a window a reader with Obsidian open really can
        hit. Whatever is found is copied out, never deleted, and named in the result.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$RetainedPath,
        [Parameter(Mandatory)]$OldManagedFiles,
        [Parameter(Mandatory)]$CarriedUnmanaged,
        [Parameter(Mandatory)][string]$RecoveryRoot
    )
    $found = [Collections.Generic.List[object]]::new()
    if ([string]::IsNullOrWhiteSpace($RetainedPath) -or -not (Test-Path -LiteralPath $RetainedPath -PathType Container)) {
        return [pscustomobject]@{ recovered = @(); recovery_path = ''; checked = 0 }
    }
    $retained = Get-VaultExportDestinationInventory -MirrorPath $RetainedPath
    foreach ($key in $retained.Keys) {
        if ($OldManagedFiles.Contains($key)) {
            if ($retained[$key].sha256 -cne $OldManagedFiles[$key].sha256) { [void]$found.Add([pscustomobject]@{ path = $key; why = 'edited in the activation window' }) }
            continue
        }
        # Not managed and not one of the unmanaged files this run carried forward: it appeared in
        # the window. A file the reader created during the swap is exactly as lose-able as an edit.
        if (-not $CarriedUnmanaged.Contains($key)) { [void]$found.Add([pscustomobject]@{ path = $key; why = 'created in the activation window' }) }
    }
    $recoveryPath = ''
    if ($found.Count) {
        $recoveryPath = $RecoveryRoot
        foreach ($entry in $found) {
            $from = Join-Path $RetainedPath ($entry.path -replace '/', '\')
            $to = Join-Path $recoveryPath ($entry.path -replace '/', '\')
            Copy-VaultExportFile -From $from -To $to -ExpectedSha (Get-VaultExportSha256 $from)
        }
    }
    [pscustomobject]@{ recovered = @($found); recovery_path = $recoveryPath; checked = $retained.Count }
}

# ==================================================================================================
# Entry point
# ==================================================================================================

function Invoke-VaultExportRun {
    param(
        [Parameter(Mandatory)][string]$Workspace,
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$VaultRoot,
        [Parameter(Mandatory)][string]$MirrorRelPath,
        [string]$StateRoot,
        [switch]$Preflight,
        [switch]$UserConfirmed,
        [string]$ApprovedPlanId,
        [switch]$AdoptExistingMirror,
        [string]$ResumeRunId,
        [string]$FaultAfterStage
    )

    # --- (f) roots, overlaps and volumes -----------------------------------------------------------
    if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) { throw "The source collection is not readable at $SourceRoot. Nothing was written." }
    if (-not (Test-Path -LiteralPath $VaultRoot -PathType Container)) { throw "The vault is not readable at $VaultRoot. Nothing was written." }
    $mirrorPath = [IO.Path]::GetFullPath((Join-Path $VaultRoot $MirrorRelPath))
    if ([string]::IsNullOrWhiteSpace($StateRoot)) { $StateRoot = Join-Path (Split-Path -Parent $mirrorPath) '.library-export' }
    $StateRoot = [IO.Path]::GetFullPath($StateRoot)
    $SourceRoot = [IO.Path]::GetFullPath($SourceRoot)

    if (Test-VaultExportPathInside -Outer $mirrorPath -Inner $SourceRoot) { throw "The source $SourceRoot is inside the mirror $mirrorPath, so the export would copy its own output. Refused." }
    if (Test-VaultExportPathInside -Outer $SourceRoot -Inner $mirrorPath) { throw "The mirror $mirrorPath is inside the source $SourceRoot, so the export would write into the collection it is reading. Refused." }
    if (Test-VaultExportPathInside -Outer $mirrorPath -Inner $StateRoot) { throw "The state root $StateRoot is inside the mirror $mirrorPath, so activation would rename the staging area away with the generation. Refused." }
    if ((Get-VaultExportVolume $StateRoot) -cne (Get-VaultExportVolume $mirrorPath)) {
        throw ("The state root $StateRoot and the mirror $mirrorPath are on different volumes. Activation is two renames " +
               'and a rename across volumes is a copy, so the swap would stop being instant without anything saying so (ADR-0034). Refused.')
    }

    foreach ($dir in @($StateRoot, (Join-Path $StateRoot 'staging'), (Join-Path $StateRoot 'generations'))) {
        if (-not $Preflight -and -not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    }
    $currentManifestPath = Join-Path $StateRoot 'current-manifest.json'

    # --- (d) an unfinished run owns the tree until it is finished ----------------------------------
    $unfinished = @(Find-VaultExportUnfinishedRuns -Workspace $Workspace)
    if ($ResumeRunId) { return (Resume-VaultExportRun -Workspace $Workspace -RunId $ResumeRunId -MirrorPath $mirrorPath -StateRoot $StateRoot -CurrentManifestPath $currentManifestPath -Preflight:$Preflight -UserConfirmed:$UserConfirmed) }
    if ($unfinished.Count) {
        throw ("$($unfinished.Count) export run(s) did not finish and must be resolved before another starts, because a " +
               "second generation staged over an unfinished swap is how two generations get merged: " +
               ($unfinished | ForEach-Object { "$($_.run_id) (last stage: $($_.last_stage))" }) -join '; ' +
               ". Run with -ResumeRunId <id> -Preflight.")
    }

    # --- (a) the capture, under writer exclusion ----------------------------------------------------
    $runId = 'vault-export-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $lock = $null
    try {
        $lock = Enter-CollectionExportLock -Workspace $Workspace -RunId $runId

        $sourceFiles = Get-VaultExportSourceInventory -SourceRoot $SourceRoot
        $destinationFiles = Get-VaultExportDestinationInventory -MirrorPath $mirrorPath
        $currentManifest = Read-VaultExportManifest $currentManifestPath

        $plan = New-VaultExportPlan -SourceRoot $SourceRoot -MirrorPath $mirrorPath -StateRoot $StateRoot `
            -SourceFiles $sourceFiles -DestinationFiles $destinationFiles -CurrentManifest $currentManifest -Adopt:$AdoptExistingMirror

        # --- the refusals, before a plan_id is worth anything --------------------------------------
        if ($plan.vault_edited.Count) {
            throw ("$($plan.vault_edited.Count) managed file(s) in the vault no longer match what was exported, so this run " +
                   'would overwrite work that exists in no source: ' + (@($plan.vault_edited) -join '; ') +
                   '. Copy what you want to keep out of the mirror, or let the edit stand and it will be replaced on the ' +
                   'next run once you have. Nothing was written.')
        }
        if (-not $plan.has_manifest -and $destinationFiles.Count -and -not $AdoptExistingMirror) {
            throw ("$($destinationFiles.Count) file(s) already sit at $mirrorPath and no manifest claims any of them, so this " +
                   'export cannot tell its own output from the reader''s. Rerun with -AdoptExistingMirror to retain that tree ' +
                   'as a generation and start managing this one; it is renamed aside and kept, never deleted.')
        }
        if ($plan.collisions.Count -and -not $AdoptExistingMirror) {
            throw ("$($plan.collisions.Count) source path(s) would land on an unmanaged file in the vault, and writing there " +
                   'would take silent ownership of something this export did not create: ' + (@($plan.collisions) -join '; ') +
                   '. Move or delete those files in the vault, then rerun. Nothing was written.')
        }
        if ($plan.unchanged) {
            return [pscustomobject]@{
                status = 'unchanged'; run_id = ''; plan_id = $plan.plan_id; mirror_path = $mirrorPath
                source_file_count = $plan.source_file_count; wrote_nothing = $true
                summary = "The vault already holds this generation: $($plan.source_file_count) source file(s), all present and matching. Nothing was staged, activated or written."
            }
        }

        if ($Preflight) {
            return [pscustomobject]@{
                status = 'preflight'; plan_id = $plan.plan_id; mirror_path = $mirrorPath; state_root = $StateRoot
                source_root = $SourceRoot; source_file_count = $plan.source_file_count
                added = $plan.added; removed = $plan.removed; changed = $plan.changed
                unmanaged_carried = $plan.carried_forward; retained_not_carried = $plan.retained_not_carried
                adopt = $plan.adopt; wrote_nothing = $true
                summary = ("$($plan.source_file_count) source file(s): $(@($plan.added).Count) new, $(@($plan.changed).Count) changed, " +
                           "$(@($plan.removed).Count) removed; " +
                           $(if ($plan.adopt) {
                                 "the $($plan.retained_not_carried) file(s) already at the mirror are RETAINED as a generation and kept, not carried into the new one and not deleted -- no manifest describes them, so nothing here can verify removing them is safe"
                             } else {
                                 "$(@($plan.carried_forward).Count) unmanaged vault file(s) carried into the new generation"
                             }) +
                           ". Rerun with -UserConfirmed -ApprovedPlanId $($plan.plan_id).")
            }
        }

        if (-not $UserConfirmed) { throw "Nothing was written: rerun with -Preflight, read what it reports, then rerun with -UserConfirmed -ApprovedPlanId $($plan.plan_id)." }
        if ([string]::IsNullOrWhiteSpace($ApprovedPlanId)) { throw "Nothing was written: pass the preflight's exact plan_id as -ApprovedPlanId ($($plan.plan_id))." }
        if ($ApprovedPlanId -cne $plan.plan_id) {
            throw ("The source or the vault changed since that preflight, so the approved plan_id no longer describes them. " +
                   "Rerun the preflight and approve the current plan_id ($($plan.plan_id)). Nothing was written.")
        }

        # --- the journal, and the generation ------------------------------------------------------
        $generationId = 'gen-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
        $stagedPath = Join-Path (Join-Path $StateRoot 'staging') $runId
        $retainedPath = Join-Path (Join-Path $StateRoot 'generations') $generationId
        $journalPath = Join-Path (Get-VaultExportJournalDirectory -Workspace $Workspace) "$runId.json"
        $journal = [pscustomobject]@{
            schema = 1; run_id = $runId; plan_id = $plan.plan_id; tool_version = $script:VaultExportVersion
            started_utc = [DateTime]::UtcNow.ToString('o'); generation_id = $generationId
            source_root = $SourceRoot; mirror_path = $mirrorPath; state_root = $StateRoot
            staged_path = $stagedPath; retained_path = $retainedPath
            adopt = [bool]$AdoptExistingMirror
            fault_injected = [string]$FaultAfterStage
            carried_unmanaged = @($plan.carried_forward)
            # THE MANIFEST THAT DESCRIBES THE TREE THIS RUN IS ABOUT TO REPLACE, carried in the
            # journal rather than looked up later. After `manifest-written` the current manifest on
            # disk describes the NEW generation, so a resume that reached for it would verify the
            # retained generation against the wrong tree and call every file an edit.
            prior_manifest = $currentManifest
            last_stage = ''
            stages = @()
        }
        Write-VaultExportJournalStage -JournalPath $journalPath -Journal $journal -Stage 'planned' -Detail "plan_id=$($plan.plan_id)"

        if (Test-Path -LiteralPath $stagedPath) { Remove-Item -LiteralPath $stagedPath -Recurse -Force }
        New-Item -ItemType Directory -Path $stagedPath -Force | Out-Null
        foreach ($key in $sourceFiles.Keys) {
            Copy-VaultExportFile -From (Join-Path $SourceRoot ($key -replace '/', '\')) -To (Join-Path $stagedPath ($key -replace '/', '\')) -ExpectedSha $sourceFiles[$key].sha256
        }
        # (e) unmanaged files are carried forward, BEFORE activation. A file the reader put in the
        # mirror survives a generation swap it never asked for.
        $carried = [ordered]@{}
        # carried_forward, not unmanaged: under adoption the two differ, and this is the loop the
        # preflight's summary is supposed to be describing.
        if (-not $AdoptExistingMirror) {
            foreach ($key in $plan.carried_forward) {
                Copy-VaultExportFile -From (Join-Path $mirrorPath ($key -replace '/', '\')) -To (Join-Path $stagedPath ($key -replace '/', '\')) -ExpectedSha $destinationFiles[$key].sha256
                $carried[$key] = $destinationFiles[$key]
            }
        }
        $stagedManifest = New-VaultExportManifest -GenerationId $generationId -SourceRoot $SourceRoot -MirrorPath $mirrorPath -Files $sourceFiles
        Write-VaultExportManifest (Join-Path $StateRoot "staging\$runId.manifest.json") $stagedManifest
        Write-VaultExportJournalStage -JournalPath $journalPath -Journal $journal -Stage 'staged' -Detail "$($sourceFiles.Count) source file(s), $($carried.Count) unmanaged carried"
        if ($FaultAfterStage -ceq 'staged') { throw 'FAULT INJECTED after staged (a real run never reaches this).' }

        # --- (c) the pre-activation verification, immediately before the swap ----------------------
        $oldManaged = Get-VaultExportManifestFiles $currentManifest
        $recheck = Get-VaultExportDestinationInventory -MirrorPath $mirrorPath
        $late = [Collections.Generic.List[string]]::new()
        foreach ($key in $oldManaged.Keys) {
            if (-not $recheck.Contains($key)) { [void]$late.Add("$key (removed)"); continue }
            if ($recheck[$key].sha256 -cne $oldManaged[$key].sha256) { [void]$late.Add("$key (edited)") }
        }
        if ($late.Count) {
            Write-VaultExportJournalStage -JournalPath $journalPath -Journal $journal -Stage 'rolled-back' -Detail "vault changed during staging: $($late -join '; ')"
            Remove-Item -LiteralPath $stagedPath -Recurse -Force -ErrorAction SilentlyContinue
            throw ("$($late.Count) managed file(s) changed in the vault while this run was staging, so the swap was not " +
                   'attempted and the staged generation was discarded: ' + ($late -join '; ') + '. Nothing was activated.')
        }
        Write-VaultExportJournalStage -JournalPath $journalPath -Journal $journal -Stage 'preactivation-verified' -Detail "$($oldManaged.Count) managed file(s) still match the old manifest"

        Invoke-VaultExportActivation -MirrorPath $mirrorPath -StagedPath $stagedPath -RetainedPath $retainedPath `
            -JournalPath $journalPath -Journal $journal -FaultAfterStage $FaultAfterStage

        Write-VaultExportManifest $currentManifestPath $stagedManifest
        Remove-Item -LiteralPath (Join-Path $StateRoot "staging\$runId.manifest.json") -Force -ErrorAction SilentlyContinue
        Write-VaultExportJournalStage -JournalPath $journalPath -Journal $journal -Stage 'manifest-written' -Detail $currentManifestPath

        $recovery = Complete-VaultExportRun -JournalPath $journalPath -Journal $journal -OldManaged $oldManaged `
            -Carried $carried -Adopt:$AdoptExistingMirror

        [pscustomobject]@{
            status = 'exported'; run_id = $runId; plan_id = $plan.plan_id; generation_id = $generationId
            mirror_path = $mirrorPath; state_root = $StateRoot; journal = $journalPath
            source_file_count = $sourceFiles.Count; added = $plan.added; removed = $plan.removed; changed = $plan.changed
            unmanaged_carried = @($carried.Keys)
            vault_edited_during_activation = $recovery.recovered
            recovery_path = $recovery.recovery_path
            retained_generation = $recovery.retained
            fault_injected = [string]$FaultAfterStage
            summary = ("$($sourceFiles.Count) file(s) mirrored: $(@($plan.added).Count) new, $(@($plan.changed).Count) changed, " +
                       "$(@($plan.removed).Count) removed. " + $recovery.summary)
        }
    }
    finally { if ($null -ne $lock) { Exit-BookLock -Lock $lock } }
}

function Complete-VaultExportRun {
    <#
        The window check and the retained generation's fate, shared by a first run and a resume so
        an interrupted run finishes exactly the way an uninterrupted one would.
    #>
    param(
        [Parameter(Mandatory)][string]$JournalPath, [Parameter(Mandatory)]$Journal,
        [Parameter(Mandatory)]$OldManaged, [Parameter(Mandatory)]$Carried, [switch]$Adopt
    )
    $retainedPath = [string]$Journal.retained_path
    $recoveryRoot = Join-Path (Split-Path -Parent ([string]$Journal.mirror_path)) ("Library-recovered\" + [string]$Journal.run_id)

    if ($Adopt) {
        # No old manifest, so the window check has nothing to compare against and the retained tree
        # cannot be cleared for deletion. Kept, and said out loud -- an unverifiable generation that
        # was quietly deleted is the one outcome this design must never produce.
        Write-VaultExportJournalStage -JournalPath $JournalPath -Journal $Journal -Stage 'window-check' -Detail 'skipped: an adopted generation has no manifest to verify against'
        Write-VaultExportJournalStage -JournalPath $JournalPath -Journal $Journal -Stage 'complete' -Detail "retained (adopted) at $retainedPath"
        return [pscustomobject]@{
            recovered = @(); recovery_path = ''; retained = $retainedPath
            summary = "The mirror that was already there is retained at $retainedPath and was NOT deleted: no manifest describes it, so nothing here can verify it is safe to remove. Read it, then delete it by hand."
        }
    }

    $check = Invoke-VaultExportWindowCheck -RetainedPath $retainedPath -OldManagedFiles $OldManaged -CarriedUnmanaged $Carried -RecoveryRoot $recoveryRoot
    Write-VaultExportJournalStage -JournalPath $JournalPath -Journal $Journal -Stage 'window-check' `
        -Detail "$($check.checked) retained file(s) checked, $(@($check.recovered).Count) recovered"

    if (Test-Path -LiteralPath $retainedPath -PathType Container) {
        Remove-Item -LiteralPath $retainedPath -Recurse -Force
    }
    Write-VaultExportJournalStage -JournalPath $JournalPath -Journal $Journal -Stage 'retained-deleted' -Detail $retainedPath
    Write-VaultExportJournalStage -JournalPath $JournalPath -Journal $Journal -Stage 'complete' -Detail ''

    $summary = 'The previous generation was verified against its own manifest and removed.'
    if (@($check.recovered).Count) {
        $summary = ("$(@($check.recovered).Count) file(s) were written into the vault during the activation window and were " +
                    "copied to $($check.recovery_path) before the previous generation was removed: " +
                    ((@($check.recovered) | ForEach-Object { "$($_.path) ($($_.why))" }) -join '; '))
    }
    [pscustomobject]@{ recovered = @($check.recovered); recovery_path = $check.recovery_path; retained = ''; summary = $summary }
}

function Resume-VaultExportRun {
    <#
        (d). The journal says which stage the run reached; the filesystem is observed; the two must
        agree. A state no rename could have produced is a refusal naming both paths, because the one
        thing worse than an unfinished export is a merged one.
    #>
    param(
        [Parameter(Mandatory)][string]$Workspace, [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$MirrorPath, [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$CurrentManifestPath,
        [switch]$Preflight, [switch]$UserConfirmed
    )
    $journalPath = Join-Path (Get-VaultExportJournalDirectory -Workspace $Workspace) "$RunId.json"
    $journal = Read-VaultExportJournal $journalPath
    if ($null -eq $journal) { throw "No export journal at $journalPath, so run $RunId cannot be resumed. Nothing was written." }
    if ([string]$journal.last_stage -in @('complete', 'rolled-back')) { throw "Run $RunId already finished at stage '$($journal.last_stage)'. Nothing to resume." }

    $stage = [string]$journal.last_stage
    $staged = [string]$journal.staged_path
    $retained = [string]$journal.retained_path
    $liveExists = Test-Path -LiteralPath $MirrorPath -PathType Container
    $stagedExists = Test-Path -LiteralPath $staged -PathType Container
    $retainedExists = Test-Path -LiteralPath $retained -PathType Container

    if ($liveExists -and $retainedExists) {
        throw ("Run $RunId cannot be resumed: both the live mirror ($MirrorPath) and its retained generation ($retained) exist, " +
               'and no rename produces that. Something outside this tool created a directory at the mirror path during the ' +
               'activation window. Resolve it by hand -- merging the two is the one thing this refuses to do.')
    }

    $action = ''
    if ($stage -cin @('planned', 'staged')) { $action = 'discard' }
    elseif ($stage -ceq 'preactivation-verified' -or $stage -ceq 'activation-begin') { $action = if ($liveExists) { 'discard' } else { 'complete-second-rename' } }
    elseif ($stage -ceq 'live-moved-aside') { $action = if ($liveExists) { 'finish-window-check' } else { 'complete-second-rename' } }
    elseif ($stage -cin @('activation-complete', 'manifest-written', 'window-check', 'retained-deleted')) { $action = 'finish-window-check' }
    else { throw "Run $RunId is at an unknown stage '$stage'; nothing here knows how to finish it. Resolve it by hand." }

    if ($Preflight) {
        return [pscustomobject]@{
            status = 'resume-preflight'; run_id = $RunId; last_stage = $stage; action = $action; wrote_nothing = $true
            live_present = $liveExists; staged_present = $stagedExists; retained_present = $retainedExists
            summary = ("Run $RunId stopped after '$stage'. Live mirror present: $liveExists. Staged generation present: $stagedExists. " +
                       "Retained generation present: $retainedExists. Resuming would $action. Rerun with -ResumeRunId $RunId -UserConfirmed.")
        }
    }
    if (-not $UserConfirmed) { throw "Nothing was written: rerun with -ResumeRunId $RunId -Preflight, read what it reports, then rerun with -ResumeRunId $RunId -UserConfirmed." }

    $lock = $null
    try {
        $lock = Enter-CollectionExportLock -Workspace $Workspace -RunId "resume-$RunId"
        switch ($action) {
            'discard' {
                if ($stagedExists) { Remove-Item -LiteralPath $staged -Recurse -Force }
                Remove-Item -LiteralPath (Join-Path $StateRoot "staging\$RunId.manifest.json") -Force -ErrorAction SilentlyContinue
                Write-VaultExportJournalStage -JournalPath $journalPath -Journal $journal -Stage 'rolled-back' -Detail 'the staged generation was discarded; the live mirror was never touched'
                return [pscustomobject]@{ status = 'rolled-back'; run_id = $RunId; mirror_path = $MirrorPath
                    summary = "Run $RunId never reached the swap, so its staged generation was discarded and the vault is exactly as it was." }
            }
            'complete-second-rename' {
                if (-not $stagedExists) {
                    throw ("Run $RunId moved the live mirror aside but its staged generation is gone from $staged, so there is nothing to " +
                           "put at $MirrorPath. The previous generation is at ${retained}: rename it back by hand, then run a fresh export.")
                }
                $stagedManifest = Read-VaultExportManifest (Join-Path $StateRoot "staging\$RunId.manifest.json")
                if ($null -eq $stagedManifest) { throw "Run $RunId has a staged generation at $staged but no manifest beside it, so it cannot be verified before activation. Resolve by hand." }
                # (d) VERIFY IT AGAINST ITS MANIFEST BEFORE COMPLETING THE STEP. A staged generation
                # that was interrupted mid-copy has the right shape and the wrong bytes.
                $stagedFiles = Get-VaultExportDestinationInventory -MirrorPath $staged
                $expected = Get-VaultExportManifestFiles $stagedManifest
                $bad = @($expected.Keys | Where-Object { -not $stagedFiles.Contains($_) -or $stagedFiles[$_].sha256 -cne $expected[$_].sha256 })
                if ($bad.Count) { throw "The staged generation at $staged does not match its manifest in $($bad.Count) file(s): $(@($bad | Select-Object -First 8) -join ', '). It was not activated. The previous generation is at ${retained}." }

                [IO.Directory]::Move($staged, $MirrorPath)
                Write-VaultExportJournalStage -JournalPath $journalPath -Journal $journal -Stage 'activation-complete' -Detail "resumed: live=$MirrorPath"
                Write-VaultExportManifest $CurrentManifestPath $stagedManifest
                Remove-Item -LiteralPath (Join-Path $StateRoot "staging\$RunId.manifest.json") -Force -ErrorAction SilentlyContinue
                Write-VaultExportJournalStage -JournalPath $journalPath -Journal $journal -Stage 'manifest-written' -Detail $CurrentManifestPath
            }
        }

        # Both 'complete-second-rename' and 'finish-window-check' end here.
        # Verified against the manifest the journal recorded at planning time, not the one on disk:
        # after `manifest-written` the current manifest describes the NEW generation.
        $oldManaged = [ordered]@{}
        if ($null -ne $journal.PSObject.Properties['prior_manifest']) { $oldManaged = Get-VaultExportManifestFiles $journal.prior_manifest }
        $carried = [ordered]@{}
        foreach ($key in @($journal.carried_unmanaged)) { if ($key) { $carried[[string]$key] = $true } }

        $recovery = Complete-VaultExportRun -JournalPath $journalPath -Journal $journal -OldManaged $oldManaged -Carried $carried -Adopt:([bool]$journal.adopt)
        [pscustomobject]@{
            status = 'resumed'; run_id = $RunId; mirror_path = $MirrorPath; action = $action
            vault_edited_during_activation = $recovery.recovered; recovery_path = $recovery.recovery_path
            retained_generation = $recovery.retained
            summary = "Run $RunId was resumed from stage '$stage' and completed. " + $recovery.summary
        }
    }
    finally { if ($null -ne $lock) { Exit-BookLock -Lock $lock } }
}

# ==================================================================================================
# Script entry
# ==================================================================================================

if ($MyInvocation.InvocationName -ne '.') {
    if ($SelfTest) {
        . (Join-Path $PSScriptRoot 'Test-VaultExport.ps1')
        exit (Invoke-VaultExportSelfTest)
    }

    if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
    $workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

    if ([string]::IsNullOrWhiteSpace($VaultRoot)) {
        throw ('No vault. Pass -VaultRoot <path>, or set $env:LIBRARY_VAULT_ROOT. There is deliberately no default: a vault ' +
               'path committed here would be one reader''s folder layout travelling in everyone else''s clone, and ' +
               'public.no-deployment-defaults would fail the commit that put it back.')
    }
    if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
        . (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')
        # Resolve-LibrarySharedCollectionRoot returns '' rather than throwing, because an
        # unreachable share is an ordinary disconnected morning for every other caller. Here it is
        # not: there is nothing to mirror without it, so the empty answer becomes this refusal, and
        # the refusal names all three routes rather than the one that happened to be missing.
        $SourceRoot = Resolve-LibrarySharedCollectionRoot -WorkspacePath $workspace
        if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
            throw ('No source collection. Pass -SourceRoot <path>, or set $env:LIBRARY_SHARED_COLLECTION_ROOT, or ' +
                   'configure this workspace with tools/Initialize-CodexLibrary.ps1 -SharedCollectionRoot <path>.')
        }
    }

    $result = Invoke-VaultExportRun -Workspace $workspace -SourceRoot $SourceRoot -VaultRoot $VaultRoot `
        -MirrorRelPath $MirrorRelPath -StateRoot $StateRoot -Preflight:$Preflight -UserConfirmed:$UserConfirmed `
        -ApprovedPlanId $ApprovedPlanId -AdoptExistingMirror:$AdoptExistingMirror -ResumeRunId $ResumeRunId `
        -FaultAfterStage $FaultAfterStage

    if ($Json) { $result | ConvertTo-Json -Depth 8 } else { $result }
}
