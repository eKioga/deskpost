<#
.SYNOPSIS
    Filesystem-side view of the shared collection, for the one defect the MCP surface cannot see.
    Dot-sourced; never invoked directly except with -SelfTest.

.DESCRIPTION
    WHY THIS EXISTS AT ALL. Archiving a Book or a Project Hub moves every note with one
    `move_note ... is_directory = $true`, and Basic Memory moves NOTES. The emptied source
    directory -- `books/<slug>/` or `projects/<slug>/` -- survives the move with zero files in it.
    The reader found six such husks in Explorer on 2026-08-29 while the Librarian, having checked
    five separate index-backed surfaces, was reporting the collection clean.

    WHY THE MCP TRANSPORT CANNOT DO THIS JOB. Probed against the live server on 2026-09-03:

      - It exports 21 tools. There is no directory-delete verb of any kind, so the removal
        genuinely cannot ride on the transport the archivers already use.
      - `list_directory` derives its directory nodes from the notes underneath. A probe directory
        created over SMB did not appear in a depth-1 listing of `books` that correctly listed every
        real Book beside it.
      - `list_directory` on the husk itself and on a name that never existed return byte-identical
        payloads: {"nodes":[],"page":1,"page_size":10,"total":0,"has_more":false}. So the transport
        cannot even distinguish "emptied" from "absent", which is why every index-based check the
        Library owns was blind to this and not one of them was at fault.

    (The Notebook's `basic-memory/mcp-tool-surface` article describes a 29-tool surface including a
    POSIX read family -- `ls`, `find`, `grep`, `cat`. Those are ABSENT from the deployed server.
    That article describes the package; this describes the deployment. Do not plan against `ls`.)

    THE ROOT IS RESOLVED, NOT ASSUMED. The repository has deliberately never held a filesystem path
    to the collection -- only the MCP URL -- so this file does not get to invent one and trust it. A
    candidate becomes the root only if it carries BOTH `books/README.md` and `projects/README.md`,
    which no unrelated directory does. A wrong path is therefore rejected rather than acted on, and
    an unreachable share resolves to $null rather than throwing: every caller degrades to
    "unavailable" and says so, because a cleanup that silently did nothing is the same invisible
    failure this file exists to end.

    REMOVAL CANNOT LOSE TEXT. Remove-SharedTreeHusk deletes only a directory that contains zero
    files at the moment it looks, re-checks immediately before the delete, and reports `not-empty`
    rather than removing anything it cannot prove is empty. That is what lets it run inside an
    already-approved archive without a second approval: it is not a destructive write, because
    there is provably nothing there to destroy.
#>

Set-StrictMode -Version Latest

# One resolver owns where a deployment value comes from, for the share root as for the endpoint.
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')

# THERE IS NO CANDIDATE LIST ANY MORE, and its removal is the point. Until 2026-09-19 this held a
# mapped drive and a UNC path -- "deployment facts about Eric's NAS, not Library policy", as the
# comment said, sitting in a tracked file about to be published. A clone would have probed one
# reader's drive letter and one reader's host on every gate run.
#
# The root is now supplied or it is absent: an explicit -Override, or LIBRARY_SHARED_COLLECTION_ROOT.
# Absent stays a $null return rather than a throw, which is the contract every caller already
# degrades through -- see the note on Get-SharedCollectionRoot. What changed is only that "absent"
# is now the default state of a fresh checkout instead of the state of a disconnected NAS.
$script:SharedCollectionRootCandidates = @()

# The two files that prove a directory is the collection rather than a lookalike.
$script:SharedCollectionMarkers = @('books\README.md', 'projects\README.md')

# Where a husk can appear. `archive` is included because an archive is a move destination too, and
# nothing guarantees the shape of what lands there.
$script:SharedCollectionHuskAreas = @('books', 'projects', 'archive')

function Test-SharedCollectionRoot {
    <# Does this path carry both collection markers? #>
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
        foreach ($marker in $script:SharedCollectionMarkers) {
            if (-not (Test-Path -LiteralPath (Join-Path $Path $marker) -PathType Leaf)) { return $false }
        }
        return $true
    }
    catch { return $false }
}

function Get-SharedCollectionRoot {
    <#
        Resolve the collection's filesystem root, or $null when it cannot be reached.
        Never throws: an unmapped share is an ordinary condition, not an error.
    #>
    param([string]$Override)

    # An explicit -Override is an INSTRUCTION, and a bad instruction fails loudly. The env var and
    # the built-in list are DISCOVERY, and discovery is allowed to move on to the next candidate.
    # The difference matters: a mistyped override that fell through would silently act on the real
    # NAS collection instead of the caller's fixture, which is how a test deletes production.
    if (-not [string]::IsNullOrWhiteSpace($Override)) {
        if (Test-SharedCollectionRoot $Override) { return $Override }
        throw "The shared-collection root '$Override' was given explicitly but does not carry $($script:SharedCollectionMarkers -join ' and '); refusing to fall back to a discovered root."
    }

    # LIBRARY_SHARED_COLLECTION_ROOT first, then the root the initializer generated for this
    # checkout. One resolver owns that order so the share root is configured the same way the
    # endpoint and the collection id are -- see tools/LibraryDeployment.ps1.
    $ordered = @()
    $configured = Resolve-LibrarySharedCollectionRoot
    if (-not [string]::IsNullOrWhiteSpace($configured)) { $ordered += $configured }
    $ordered += @($script:SharedCollectionRootCandidates)

    foreach ($candidate in $ordered) {
        if (Test-SharedCollectionRoot $candidate) { return $candidate }
    }
    return $null
}

function Test-SharedTreeIsHusk {
    <#
        True only for a directory that exists and holds zero files at any depth. -Force so a hidden
        file still counts as content: a husk is defined by having nothing to lose, and a directory
        holding one hidden file has something to lose.
    #>
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
        $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction Stop)
        return ($files.Count -eq 0)
    }
    catch {
        # An unreadable directory is not a proven husk. Report false so nothing removes it.
        return $false
    }
}

function Find-SharedCollectionHusks {
    <#
        Every emptied directory under the collection's move destinations, as paths relative to the
        root and with forward slashes, so a result reads like the `books/<slug>` the archivers use.

        Only the TOPMOST husk of a nest is reported. An emptied Book leaves `books/<slug>/wiki/notes`
        behind as well as `books/<slug>`, and three lines naming one problem trains the reader to
        skim the check.
    #>
    param([Parameter(Mandatory)][string]$Root)

    $found = [Collections.Generic.List[string]]::new()
    foreach ($area in $script:SharedCollectionHuskAreas) {
        $areaPath = Join-Path $Root $area
        if (-not (Test-Path -LiteralPath $areaPath -PathType Container)) { continue }
        $directories = @(Get-ChildItem -LiteralPath $areaPath -Recurse -Directory -Force -ErrorAction SilentlyContinue)
        foreach ($directory in $directories) {
            if ($directory.Name.StartsWith('.')) { continue }
            if (Test-SharedTreeIsHusk $directory.FullName) {
                $relative = $directory.FullName.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
                [void]$found.Add($relative)
            }
        }
    }

    # Drop any husk contained by another husk. Compared with a trailing slash so `books/ab` is not
    # read as a child of `books/a`.
    $all = @($found | Sort-Object)
    $topmost = @($all | Where-Object {
            $candidate = $_
            $parents = @($all | Where-Object { $_ -cne $candidate -and $candidate.StartsWith($_ + '/') })
            $parents.Count -eq 0
        })
    return $topmost
}

function Remove-SharedTreeHusk {
    <#
        Remove one emptied directory, and only if it is provably empty. Returns a status, never
        throws, because this runs after an archive has already succeeded: a cleanup failure must not
        turn a completed archive into a reported failure. The statuses are

          removed     -- it was empty and is now gone
          absent      -- nothing was there, which is the correct outcome of a repeat run
          not-empty   -- it holds files; left untouched and reported so the reader can look
          unavailable -- the collection filesystem could not be reached at all
          failed:<m>  -- the delete itself was refused, e.g. a lock or a permission
    #>
    param(
        # Deliberately NOT Mandatory: Mandatory rejects '' at binding, which would turn the
        # unavailable case into a parameter-binding exception thrown out of a completed archive.
        # The guard below is the contract, so the guard has to be reachable.
        [string]$Root,
        [Parameter(Mandatory)][string]$RelativePath
    )
    if ([string]::IsNullOrWhiteSpace($Root)) { return 'unavailable' }
    $full = Join-Path $Root ($RelativePath -replace '/', '\')
    try {
        if (-not (Test-Path -LiteralPath $full -PathType Container)) { return 'absent' }
        if (-not (Test-SharedTreeIsHusk $full)) { return 'not-empty' }
        # Re-checked immediately before the delete rather than trusting the check above: the gap is
        # small, but the whole claim this function makes is "there was nothing in it".
        $files = @(Get-ChildItem -LiteralPath $full -Recurse -File -Force -ErrorAction Stop)
        if ($files.Count -ne 0) { return 'not-empty' }
        Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $full) { return 'failed:the directory survived its own removal' }
        return 'removed'
    }
    catch { return ('failed:' + $_.Exception.Message) }
}

function Invoke-SharedHuskCleanup {
    <#
        The whole post-archive step as one call, so both archivers carry the same three lines and
        neither has to know how the root is found. Returns an object the caller can put straight on
        its result: the status, and the path it acted on for the record.
    #>
    param(
        [Parameter(Mandatory)][string]$RelativePath,
        [string]$RootOverride
    )
    # Wrapped because this runs AFTER a shared archive has already committed. A cleanup that threw
    # would report a completed archive as a failure and send the reader looking for damage that is
    # not there; a status the caller prints is the honest shape.
    try { $root = Get-SharedCollectionRoot -Override $RootOverride }
    catch { return [pscustomobject]@{ source_tree = $RelativePath; status = ('failed:' + $_.Exception.Message); root = $null } }

    if ($null -eq $root) {
        return [pscustomobject]@{ source_tree = $RelativePath; status = 'unavailable'; root = $null }
    }
    $status = Remove-SharedTreeHusk -Root $root -RelativePath $RelativePath
    [pscustomobject]@{ source_tree = $RelativePath; status = $status; root = $root }
}

# --- Self-test ------------------------------------------------------------------------------------
# Offline and complete: every branch is exercised against a local fixture shaped like the collection.
# It deliberately does NOT touch the NAS -- the gate's shared.archive-leaves-no-husk is what looks at
# the real thing, and a self-test that needed the share would be skipped exactly when it mattered.
if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') {
    $ErrorActionPreference = 'Stop'
    $failures = [Collections.Generic.List[string]]::new()
    $checks = 0
    function Assert([bool]$Condition, [string]$Label) {
        $script:checks++
        if (-not $Condition) { [void]$failures.Add($Label) }
    }

    $fixture = Join-Path ([IO.Path]::GetTempPath()) ("shared-collection-selftest-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $utf8 = [Text.UTF8Encoding]::new($false)
    try {
        New-Item -ItemType Directory -Path (Join-Path $fixture 'books') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $fixture 'projects') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $fixture 'archive') -Force | Out-Null

        # 1. A directory without both markers is not the collection.
        Assert (-not (Test-SharedCollectionRoot $fixture)) 'a directory with no markers passed as the collection root'
        [IO.File]::WriteAllText((Join-Path $fixture 'books\README.md'), "# Books`n", $utf8)
        Assert (-not (Test-SharedCollectionRoot $fixture)) 'one marker was enough to pass as the collection root'
        [IO.File]::WriteAllText((Join-Path $fixture 'projects\README.md'), "# Projects`n", $utf8)
        Assert (Test-SharedCollectionRoot $fixture) 'the fixture with both markers was rejected'
        Assert (-not (Test-SharedCollectionRoot (Join-Path $fixture 'no-such-child'))) 'a missing path passed as the collection root'

        # 2. Resolution order, and the honest $null.
        Assert ((Get-SharedCollectionRoot -Override $fixture) -ceq $fixture) 'an explicit override did not win'
        # The load-bearing one: on a machine where a real candidate resolves, a bad override must
        # NOT quietly become that candidate. This asserted the opposite at first and caught it.
        $overrideRefused = $false
        try { Get-SharedCollectionRoot -Override (Join-Path $fixture 'nope') | Out-Null }
        catch { $overrideRefused = $true }
        Assert $overrideRefused 'an invalid override fell through to a discovered root instead of failing'

        # 3. Husk versus populated, which is the whole safety boundary.
        $husk = Join-Path $fixture 'books\emptied-book'
        New-Item -ItemType Directory -Path (Join-Path $husk 'wiki\notes') -Force | Out-Null
        Assert (Test-SharedTreeIsHusk $husk) 'a directory tree with no files was not recognised as a husk'

        $live = Join-Path $fixture 'books\real-book'
        New-Item -ItemType Directory -Path (Join-Path $live 'wiki') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $live 'wiki\_book.md'), "# Real`n", $utf8)
        Assert (-not (Test-SharedTreeIsHusk $live)) 'a directory holding a page was called a husk'
        Assert (-not (Test-SharedTreeIsHusk (Join-Path $fixture 'books\never-existed'))) 'a missing directory was called a husk'

        # A hidden file is still content. This is the case that would quietly delete something.
        $hiddenHolder = Join-Path $fixture 'books\hidden-only'
        New-Item -ItemType Directory -Path $hiddenHolder -Force | Out-Null
        $hiddenFile = Join-Path $hiddenHolder '.keep'
        [IO.File]::WriteAllText($hiddenFile, "x`n", $utf8)
        (Get-Item -LiteralPath $hiddenFile -Force).Attributes = 'Hidden'
        Assert (-not (Test-SharedTreeIsHusk $hiddenHolder)) 'a directory holding only a hidden file was called a husk'

        # 4. Finding husks: reports the topmost only, and never a populated tree.
        $projectHusk = Join-Path $fixture 'projects\emptied-hub'
        New-Item -ItemType Directory -Path (Join-Path $projectHusk 'notes') -Force | Out-Null
        $husks = @(Find-SharedCollectionHusks -Root $fixture)
        Assert ($husks -ccontains 'books/emptied-book') 'the emptied Book was not found'
        Assert ($husks -ccontains 'projects/emptied-hub') 'the emptied Project Hub was not found'
        Assert (-not ($husks -ccontains 'books/emptied-book/wiki')) 'a nested husk was reported beside its parent'
        Assert (-not ($husks -ccontains 'books/emptied-book/wiki/notes')) 'a deeply nested husk was reported beside its parent'
        Assert (-not ($husks -ccontains 'books/real-book')) 'a populated Book was reported as a husk'
        Assert (-not ($husks -ccontains 'books/hidden-only')) 'a directory holding a hidden file was reported as a husk'
        # `books/ab` must not be swallowed as a child of `books/a`.
        New-Item -ItemType Directory -Path (Join-Path $fixture 'books\a') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $fixture 'books\ab') -Force | Out-Null
        $prefixHusks = @(Find-SharedCollectionHusks -Root $fixture)
        Assert ($prefixHusks -ccontains 'books/a') 'the prefix husk books/a was lost'
        Assert ($prefixHusks -ccontains 'books/ab') 'books/ab was wrongly treated as a child of books/a'
        Remove-Item -LiteralPath (Join-Path $fixture 'books\a') -Recurse -Force
        Remove-Item -LiteralPath (Join-Path $fixture 'books\ab') -Recurse -Force

        # 5. Removal: every status, and above all that it refuses a populated tree.
        Assert ((Remove-SharedTreeHusk -Root $fixture -RelativePath 'books/never-existed') -ceq 'absent') 'a missing directory did not report absent'
        Assert ((Remove-SharedTreeHusk -Root $fixture -RelativePath 'books/real-book') -ceq 'not-empty') 'a populated Book did not report not-empty'
        Assert (Test-Path -LiteralPath (Join-Path $live 'wiki\_book.md')) 'the populated Book lost a page to the cleanup'
        Assert ((Remove-SharedTreeHusk -Root $fixture -RelativePath 'books/hidden-only') -ceq 'not-empty') 'a hidden-file directory did not report not-empty'
        Assert (Test-Path -LiteralPath $hiddenFile) 'the hidden file was deleted'
        Assert ((Remove-SharedTreeHusk -Root $fixture -RelativePath 'books/emptied-book') -ceq 'removed') 'the husk was not removed'
        Assert (-not (Test-Path -LiteralPath $husk)) 'the husk survived removal'
        Assert ((Remove-SharedTreeHusk -Root $fixture -RelativePath 'books/emptied-book') -ceq 'absent') 'a repeat removal did not report absent'
        Assert ((Remove-SharedTreeHusk -Root '' -RelativePath 'books/x') -ceq 'unavailable') 'an empty root did not report unavailable'

        # 6. The one-call form both archivers use.
        $cleanup = Invoke-SharedHuskCleanup -RelativePath 'projects/emptied-hub' -RootOverride $fixture
        Assert ($cleanup.status -ceq 'removed') 'the cleanup call did not remove the Project husk'
        Assert ($cleanup.source_tree -ceq 'projects/emptied-hub') 'the cleanup result lost the path it acted on'
        Assert (-not (Test-Path -LiteralPath $projectHusk)) 'the Project husk survived the cleanup call'
        # A bad override reaches the caller as a reported status, never as an exception out of a
        # completed archive, and never as a silent success against the real collection.
        $unreachable = Invoke-SharedHuskCleanup -RelativePath 'books/x' -RootOverride (Join-Path $fixture 'not-the-collection')
        Assert ($unreachable.status.StartsWith('failed:')) 'a bad override did not surface as a failed status'
        Assert ($null -eq $unreachable.root) 'a bad override still reported a resolved root'

        # 7. A clean collection reports nothing, which is what the gate must see almost always.
        Assert ((@(Find-SharedCollectionHusks -Root $fixture)).Count -eq 0) 'a cleaned fixture still reported husks'
    }
    finally {
        if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
    }

    $result = [pscustomobject]@{
        operation = 'SharedCollectionFiles self-test'
        checks    = $checks
        failures  = @($failures)
        passed    = (@($failures).Count -eq 0)
        scope     = 'Offline only: root validation, husk detection, topmost-only reporting, and refusal to remove anything holding a file. No NAS access.'
    }
    $result
    if (-not $result.passed) { throw 'SharedCollectionFiles self-test failed.' }
}
