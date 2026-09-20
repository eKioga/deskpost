<#
.SYNOPSIS
    The serialized renderer for shelf/_catalog.md, and the per-Book entry files it renders from.
    Dot-sourced; reachable directly only for -Migrate and -SelfTest.

.DESCRIPTION
    PLAN-multi-desk.md Release 1, steps 3 and 4. One file because they are one critical section:
    the rendered catalog and the entry it renders have to commit together, and the header it renders
    them under has to come from somewhere a checkout can recover.

    WHAT WAS WRONG. Five writers changed shelf/_catalog.md and no two agreed how. Publish-BookCopy
    and Import-ExternalWikiToShelf appended to it with Add-Content, unlocked -- two publishes could
    interleave into one line. Archive, Remove and Rename rewrote the whole file from a substring
    offset computed before their own directory work. Nothing serialized any of it, and the file was
    simultaneously the authority and the published view.

    THE FIX SPLITS THOSE TWO ROLES. Each Book's block is authoritative in its own
    shelf/<slug>/_catalog-entry.md, and shelf/_catalog.md is rendered from the tracked header plus
    those entries, sorted, under one lock. A writer touches its own Book's file and nothing else, so
    two publishes cannot collide at all -- there is no shared file for them to collide in.

    THE ENTRY AND THE CATALOG COMMIT IN ONE CRITICAL SECTION. A writer that committed its entry file
    and crashed before rendering would leave the authority and the published view disagreeing. So
    the entry write is the caller's -Commit, run inside the render lock, and the catalog is rendered
    and read back before the lock is released.

    THE ENTRY FILE LIVES OUTSIDE wiki/ ON PURPOSE. Page manifests, Discovery and every reader-map
    regeneration enumerate shelf/<slug>/wiki, so an entry file there would become a page of the
    Book: findable, publishable, and part of every plan_id bound to a page manifest.

    THE HEADER IS TRACKED, AND NOT EMBEDDED HERE. docs/templates/shelf-catalog-header.md is the
    authority. Not shelf/ -- that is gitignored, so a header living there is unrecoverable and
    drifts silently. And not a string constant in this file either: ADR-0014 says a mechanism
    delivers a document and never holds a rule of its own, and this header is reader-facing prose
    about what a capture Book is.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')

# Its own lock class, last in the order PLAN-multi-desk.md step 9a fixes: a holder acquires nothing
# else. Callers take the Book's lock first.
$script:ShelfRenderLockRoot = 'render/shelf-catalog'
$script:ShelfCatalogEntryName = '_catalog-entry.md'
$script:ShelfCatalogHeaderRelative = 'docs/templates/shelf-catalog-header.md'

function Get-ShelfRenderLockRoot { $script:ShelfRenderLockRoot }
function Get-ShelfCatalogEntryFileName { $script:ShelfCatalogEntryName }

function Get-ShelfCatalogPath([string]$Workspace) {
    Join-Path (Join-Path $Workspace 'shelf') '_catalog.md'
}

function Get-ShelfCatalogEntryPath([string]$Workspace, [string]$Slug) {
    if ([string]::IsNullOrWhiteSpace($Slug)) { throw 'A Shelf catalog entry needs a Book slug.' }
    Join-Path (Join-Path (Join-Path $Workspace 'shelf') $Slug) $script:ShelfCatalogEntryName
}

function Get-ShelfCatalogHeaderPath([string]$Workspace) {
    Join-Path $Workspace ($script:ShelfCatalogHeaderRelative -replace '/', [IO.Path]::DirectorySeparatorChar)
}

function ConvertTo-SingleTrailingNewline([string]$Text) {
    # One trailing newline, always, so the rendered file has exactly one possible byte sequence for a
    # given set of entries. A readback comparison against text is worth nothing otherwise.
    ($Text -replace "`r`n", "`n").TrimEnd("`n") + "`n"
}

function Get-ShelfCatalogHeader {
    <#
    .SYNOPSIS
        The authored header, from its tracked file, validated.

    .DESCRIPTION
        A header carrying a column-zero '##' would render as a phantom Book -- the catalog's readers
        find a Book by matching a '## ' section and a Path line inside it, so prose under a second
        heading is indistinguishable from an entry with a missing Path. Refused rather than rendered.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Workspace)

    $path = Get-ShelfCatalogHeaderPath -Workspace $Workspace
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "The Shelf catalog header template is missing: $script:ShelfCatalogHeaderRelative. It is tracked, so restore it from the repository rather than writing a new one."
    }
    $text = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $path))
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    $text = ConvertTo-SingleTrailingNewline $text
    if (-not $text.StartsWith('# ', [StringComparison]::Ordinal)) {
        throw "$script:ShelfCatalogHeaderRelative must begin with a column-zero H1."
    }
    if ([regex]::IsMatch($text, '(?m)^##')) {
        throw "$script:ShelfCatalogHeaderRelative contains a column-zero '##', which would render as a Book entry the Shelf does not have."
    }
    if (@([regex]::Matches($text, '(?m)^# ')).Count -ne 1) {
        throw "$script:ShelfCatalogHeaderRelative must carry exactly one column-zero H1."
    }
    $text
}

function Test-ShelfCatalogEntryText {
    <#
    .SYNOPSIS
        Validate one entry against the slug that owns it. Returns its title, or throws.

    .DESCRIPTION
        THE SLUG IS CHECKED AGAINST THE DIRECTORY IT WAS FOUND IN, which is the whole reason an
        entry file is safe to render unread. A copied Book directory would otherwise carry a Path
        line naming the Book it was copied from, and the catalog would list one Book twice under two
        titles -- and every reader that resolves a slug through the catalog would then pick whichever
        section it matched first.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string]$Slug,
        [string]$Label = 'the catalog entry'
    )

    $normalised = ($Text -replace "`r`n", "`n")
    $headings = @([regex]::Matches($normalised, '(?m)^##[ \t]+(.+)$'))
    if ($headings.Count -ne 1) { throw "$Label must carry exactly one column-zero '## ' heading; it carries $($headings.Count)." }
    if ([regex]::IsMatch($normalised, '(?m)^#[ \t]')) { throw "$Label carries a column-zero H1; an entry is a '## ' section of the catalog, not a document of its own." }
    if (-not $normalised.TrimStart("`n").StartsWith('## ', [StringComparison]::Ordinal)) { throw "$Label must begin with its '## ' heading." }

    $pathLines = @([regex]::Matches($normalised, '(?m)^\s*-\s+\*\*Path:\*\*\s+shelf/([a-z0-9][a-z0-9-]*)\s*$'))
    if ($pathLines.Count -ne 1) { throw "$Label must carry exactly one '- **Path:** shelf/<slug>' line; it carries $($pathLines.Count)." }
    $declared = $pathLines[0].Groups[1].Value
    if ($declared -cne $Slug) { throw "$Label declares Path shelf/$declared but lives under shelf/$Slug. An entry names the Book it belongs to." }

    $title = $headings[0].Groups[1].Value.Trim()
    if ([string]::IsNullOrWhiteSpace($title)) { throw "$Label has an empty title." }
    $title
}

function New-ShelfCatalogEntryText {
    <#
    .SYNOPSIS
        Compose one entry from a title and its detail lines, with the Path line added last.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Slug,
        [Parameter(Mandatory = $true)][string]$Title,
        [string[]]$Line = @()
    )

    $trimmedTitle = $Title.Trim()
    if ($trimmedTitle.Contains("`n") -or $trimmedTitle.Contains("`r")) { throw 'A catalog entry title must be a single line.' }
    $body = @(@($Line) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_.TrimEnd() })
    # The Path line is appended by the composer rather than passed in, so no caller can produce an
    # entry that names a different Book than the one it is written under.
    $body += "- **Path:** shelf/$Slug"
    $text = ConvertTo-SingleTrailingNewline ("## $trimmedTitle`n" + ($body -join "`n"))
    Test-ShelfCatalogEntryText -Text $text -Slug $Slug -Label "the composed entry for shelf/$Slug" | Out-Null
    $text
}

function Get-ShelfCatalogEntryInventory {
    <#
    .SYNOPSIS
        Every Book's entry file, validated, ordered by slug.

    .DESCRIPTION
        One level under shelf/ only, so shelf/_archive/<slug> is excluded by construction -- an
        archived Book is out of the active catalog by design (ADR-0012 keeps it in Discovery, not
        here). A directory with no entry file is reported rather than skipped: silently skipping is
        how a Book falls out of its own catalog.

        LEADING UNDERSCORE AND LEADING DOT ARE THE SHELF'S OWN NAMESPACE, and both had to be, which
        the first version got half right. It skipped `_archive` and then refused every other
        non-slug name -- and Import-ExternalWikiToShelf.ps1 stages inside shelf/ as
        `.migration-<slug>-<digest>`, so ANY render during an import would have thrown "not a Book
        slug" at a directory that is doing exactly what it should. A dot-prefixed name is transient
        Shelf machinery, never a Book. A name that is neither prefixed nor a slug is still refused,
        because the catalog cannot say what it is.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Workspace)

    $shelfRoot = Join-Path $Workspace 'shelf'
    if (-not (Test-Path -LiteralPath $shelfRoot -PathType Container)) { throw "the Shelf directory is missing: $shelfRoot" }

    $entries = [Collections.Generic.List[object]]::new()
    $unlisted = [Collections.Generic.List[string]]::new()
    foreach ($directory in @(Get-ChildItem -LiteralPath $shelfRoot -Directory -Force)) {
        # The Shelf's own namespace: `_archive` and anything else the lifecycle needs later, plus
        # the dot-prefixed staging directories a writer creates mid-operation. Never a Book.
        if ($directory.Name.StartsWith('_', [StringComparison]::Ordinal)) { continue }
        if ($directory.Name.StartsWith('.', [StringComparison]::Ordinal)) { continue }
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq [IO.FileAttributes]::ReparsePoint) {
            throw "shelf/$($directory.Name) is a reparse point; the Shelf catalog refuses to list material that lives outside the workspace."
        }
        if ($directory.Name -cnotmatch '^[a-z0-9][a-z0-9-]*$') {
            throw "shelf/$($directory.Name) is not a Book slug. Rename or remove it; the catalog cannot say what it is."
        }
        $entryPath = Join-Path $directory.FullName $script:ShelfCatalogEntryName
        if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
            [void]$unlisted.Add($directory.Name)
            continue
        }
        $text = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $entryPath))
        if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
        $text = ConvertTo-SingleTrailingNewline $text
        $title = Test-ShelfCatalogEntryText -Text $text -Slug $directory.Name -Label "shelf/$($directory.Name)/$script:ShelfCatalogEntryName"
        [void]$entries.Add([pscustomobject]@{ slug = $directory.Name; title = $title; text = $text; path = $entryPath })
    }

    [pscustomobject]@{
        entries  = @(@($entries) | Sort-Object -Property @{ Expression = { $_.slug }; Ascending = $true })
        unlisted = @(@($unlisted) | Sort-Object)
    }
}

function Get-ShelfCatalogText {
    <#
    .SYNOPSIS
        The catalog the header and the entry files imply. Pure: it reads, and writes nothing.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Workspace)

    $header = Get-ShelfCatalogHeader -Workspace $Workspace
    $inventory = Get-ShelfCatalogEntryInventory -Workspace $Workspace
    if (@($inventory.unlisted).Count) {
        throw ("$(@($inventory.unlisted).Count) Book directory(ies) under shelf/ carry no $script:ShelfCatalogEntryName and so cannot be listed: " +
            "$(@($inventory.unlisted) -join ', '). Run tools/ShelfCatalog.ps1 -Migrate -WorkspacePath . to split an old shelf/_catalog.md into entry files.")
    }
    # Explicit concatenation. `$a + $array -join ''` happens to produce the same string because
    # -join binds looser than +, but a reader has to work that out, and a later edit would not.
    $body = -join @(@($inventory.entries) | ForEach-Object { "`n" + $_.text })
    $header + $body
}

function Invoke-ShelfCatalogRender {
    <#
    .SYNOPSIS
        THE CRITICAL SECTION. Commit one entry-file change and re-render the catalog.

    .DESCRIPTION
        Pass the entries this operation changes and the renderer commits them: -WriteEntry replaces
        each one atomically, -RemoveEntry deletes each one, and the catalog is rendered from what is
        left. Stage the content, compute the hashes, verify the Book on disk -- all of that happens
        before this is called. Inside the lock there is only the entry commit, the header-and-entry
        scan, the atomic catalog write, and its readback.

        A caller with nothing to change may call this with neither, which re-renders the catalog and
        is what repairs one that drifted.

        THE RENDERER DOES THE WRITE; A CALLER NEVER HANDS OVER A SCRIPTBLOCK THAT DOES IT. The first
        version took a -Commit scriptblock, and it left the one thing that must stay atomic in the
        one place no check could see it: the write line inside a caller's commit mentions that
        block's own parameter, not the entry path, so derived-indexes.written-atomically -- which
        follows the path variable -- could not reach it. A caller that passes an entry rather than a
        procedure cannot get the write wrong, and the check's scope becomes exactly right.

        (A closure was the first answer to passing values in, and it is a trap here for a second
        reason worth recording: GetNewClosure() copies every variable in scope into the closure,
        INCLUDING the caller's script parameters, and re-applying a [ValidateSet] attribute to a
        copied empty value throws "the attribute cannot be added because variable <name> ... would
        no longer be valid". Publish-BookCopy.ps1 has such a parameter, so the failure appeared in
        exactly one of five callers.)
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        # Each entry is @{ path = <entry file path>; text = <entry text> }. Typed as hashtables
        # rather than objects because a hashtable's keys are NOT PSObject properties -- checking for
        # them with PSObject.Properties finds Count, Keys and Values and refuses every valid entry.
        [hashtable[]]$WriteEntry = @(),
        [string[]]$RemoveEntry = @(),
        [int]$TimeoutSeconds = 20
    )

    # Validated BEFORE the lock is taken, so a malformed request costs nobody the render lock.
    foreach ($entry in @($WriteEntry)) {
        if (-not $entry.ContainsKey('path') -or -not $entry.ContainsKey('text')) { throw 'Each -WriteEntry needs a path and a text.' }
        if ([string]::IsNullOrWhiteSpace([string]$entry.path)) { throw 'A -WriteEntry path is empty.' }
    }

    $catalogPath = Get-ShelfCatalogPath -Workspace $Workspace
    $lock = Enter-BookLock -Workspace $Workspace -BookRoot $script:ShelfRenderLockRoot -TimeoutSeconds $TimeoutSeconds
    $enteredUtc = [DateTime]::UtcNow
    try {
        $committed = [Collections.Generic.List[string]]::new()
        foreach ($entry in @($WriteEntry)) {
            Write-AtomicText -Path ([string]$entry.path) -Text ([string]$entry.text) | Out-Null
            [void]$committed.Add([string]$entry.path)
        }
        foreach ($path in @($RemoveEntry)) {
            if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
            [void]$committed.Add($path)
        }

        # The scan throws before anything is written, so a malformed entry leaves the previous
        # catalog exactly as it was rather than replacing it with a partial list.
        try { $text = Get-ShelfCatalogText -Workspace $Workspace }
        catch {
            throw ("shelf/_catalog.md was NOT changed, because the Shelf cannot be rendered: $($_.Exception.Message)")
        }
        Write-AtomicText -Path $catalogPath -Text $text | Out-Null

        $readback = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $catalogPath))
        if ($readback -cne $text) { throw 'The rendered Shelf catalog failed readback verification.' }

        $exitUtc = [DateTime]::UtcNow
        [pscustomobject]@{
            catalog_path     = 'shelf/_catalog.md'
            entry_count      = @([regex]::Matches($text, '(?m)^## ')).Count
            rendered         = $true
            entries_committed = @($committed)
            lock_entered_utc = $enteredUtc.ToString('o')
            lock_exit_utc    = $exitUtc.ToString('o')
            lock_held_ms     = [int]($exitUtc - $enteredUtc).TotalMilliseconds
        }
    }
    finally { Exit-BookLock -Lock $lock }
}

function Invoke-ShelfCatalogRenderAfterRollback {
    <#
    .SYNOPSIS
        Re-derive the catalog once a rollback has put the Books back. The rollback's renderer.

    .DESCRIPTION
        THE ROLLBACK'S LAST STEP, AND IT IS A RENDER RATHER THAN A RESTORE. A failed Shelf write
        unwinds its own directory move and restores its own entry file from the journal, and those
        are the AUTHORITY the catalog is derived from -- so the catalog is put right by re-deriving
        it, never by writing back a snapshot the journal took before the run started. A snapshot
        would drop whatever Book another seat published in the meantime. Write-BookJournal refuses
        to carry one; this is the other half of that refusal.

        CALL IT AFTER the directory has been moved back and the journal restored, because the
        catalog is rendered from the entry files those two steps put back in place.

        IT REPORTS ITS OWN FAILURE SEPARATELY, so a Shelf that cannot render does not make a
        rollback that did restore its files read as one that restored nothing.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [int]$TimeoutSeconds = 20
    )

    try { Invoke-ShelfCatalogRender -Workspace $Workspace -TimeoutSeconds $TimeoutSeconds }
    catch {
        throw ("the Book and its journaled files were restored, but shelf/_catalog.md could not be re-derived " +
            "afterwards: $($_.Exception.Message) Run tools/ShelfCatalog.ps1 -Render -WorkspacePath . once that is " +
            'repaired; until then the catalog still describes the Shelf as it was mid-operation.')
    }
}

function Get-ShelfCatalogDrift {
    <#
    .SYNOPSIS
        What is wrong with shelf/_catalog.md, or an empty list. Read-only; takes no lock.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Workspace)

    $problems = [Collections.Generic.List[string]]::new()
    $catalogPath = Get-ShelfCatalogPath -Workspace $Workspace
    if (-not (Test-Path -LiteralPath (Join-Path $Workspace 'shelf') -PathType Container)) {
        [void]$problems.Add('shelf/ is missing')
        return @($problems)
    }
    if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) {
        [void]$problems.Add('shelf/_catalog.md is missing')
        return @($problems)
    }
    $expected = $null
    try { $expected = Get-ShelfCatalogText -Workspace $Workspace }
    catch {
        [void]$problems.Add("the Shelf cannot be rendered: $($_.Exception.Message)")
        return @($problems)
    }
    $actual = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $catalogPath))
    if ($actual.Length -gt 0 -and $actual[0] -eq [char]0xFEFF) { $actual = $actual.Substring(1) }
    if ($actual -cne $expected) {
        [void]$problems.Add('shelf/_catalog.md does not match the tracked header plus the validated entry files; re-render it with tools/ShelfCatalog.ps1 -Render -WorkspacePath .')
    }
    @($problems)
}

function Initialize-ShelfCatalogForFixture {
    <#
    .SYNOPSIS
        Give a test fixture the tracked header and the entry files a render needs.

    .DESCRIPTION
        A fixture that writes only shelf/_catalog.md describes a Shelf no renderer can reproduce, so
        the first writer to run in it fails naming a missing template. That is the correct refusal
        and a useless fixture, and four suites hit it at once.

        THE HEADER IS COPIED FROM THE REPOSITORY, NEVER RETYPED. A fixture carrying its own copy of
        the header would keep passing while the tracked one was broken or gone -- the fixture would
        be testing itself. The entry files come from Convert-ShelfCatalogToEntries, the same
        migration a real Shelf runs once, so a fixture Book is split exactly as a reader's Book is.

        It lives here rather than in the suites because it is a statement about this module's
        contract: this is what a Shelf has to look like before a catalog can be rendered.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FixtureRoot,
        [string]$RepositoryRoot
    )

    if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
    $templateDirectory = Join-Path $FixtureRoot 'docs/templates'
    New-Item -ItemType Directory -Path $templateDirectory -Force | Out-Null
    [IO.File]::Copy(
        (Join-Path $RepositoryRoot ($script:ShelfCatalogHeaderRelative -replace '/', [IO.Path]::DirectorySeparatorChar)),
        (Join-Path $templateDirectory 'shelf-catalog-header.md'), $true)
    Convert-ShelfCatalogToEntries -Workspace $FixtureRoot | Out-Null
}

function Set-ShelfCatalogEntryForFixture {
    <#
    .SYNOPSIS
        Add or remove one fixture Book's catalog entry, through the real renderer.

    .DESCRIPTION
        Fixtures used to append a '## ' block to shelf/_catalog.md, or trim one off it, to model a
        Book arriving or leaving. Neither is how a Book is listed any more, and a hand-edited
        catalog is drift the next writer silently re-renders away. This does what a writer does:
        writes or deletes the Book's own entry file inside the render lock.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FixtureRoot,
        [Parameter(Mandatory = $true)][string]$Slug,
        [string]$Title,
        [string[]]$Line = @(),
        [switch]$Remove
    )

    $entryPath = Get-ShelfCatalogEntryPath -Workspace $FixtureRoot -Slug $Slug
    if ($Remove) {
        Invoke-ShelfCatalogRender -Workspace $FixtureRoot -RemoveEntry @($entryPath) | Out-Null
        return
    }
    if ([string]::IsNullOrWhiteSpace($Title)) { throw 'Set-ShelfCatalogEntryForFixture needs a Title unless -Remove is given.' }
    Invoke-ShelfCatalogRender -Workspace $FixtureRoot -WriteEntry @(
        @{ path = $entryPath; text = (New-ShelfCatalogEntryText -Slug $Slug -Title $Title -Line $Line) }
    ) | Out-Null
}

function Convert-ShelfCatalogToEntries {
    <#
    .SYNOPSIS
        Day-one migration: split an existing shelf/_catalog.md into per-Book entry files.

    .DESCRIPTION
        DAY-ONE DATA IS THE HARD PART OF EVERY WHOLE-COLLECTION INVARIANT, so this exists rather
        than a rule that simply refuses every Shelf that predates it. It reads the live catalog,
        writes each '## ' section whose Path line names a Book on disk into that Book's entry file,
        and renders. Idempotent: an entry file whose content already matches is left alone, and one
        that differs is reported rather than overwritten, because the file on disk is the authority
        the moment it exists.

        It never invents an entry for a Book the catalog does not list, and never removes a Book the
        catalog lists but disk does not have -- both are reported for a person to resolve.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [switch]$WhatIfOnly
    )

    $catalogPath = Get-ShelfCatalogPath -Workspace $Workspace
    if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw 'shelf/_catalog.md was not found; there is nothing to migrate.' }
    $catalog = ([Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $catalogPath)) -replace "`r`n", "`n")

    $planned = [Collections.Generic.List[object]]::new()
    $conflicts = [Collections.Generic.List[string]]::new()
    $orphans = [Collections.Generic.List[string]]::new()
    foreach ($section in @([regex]::Matches($catalog, '(?ms)^(##[ \t]+.+?)$(.*?)(?=^##[ \t]|\z)'))) {
        $sectionText = ConvertTo-SingleTrailingNewline ($section.Groups[1].Value + $section.Groups[2].Value)
        $pathLine = [regex]::Match($sectionText, '(?m)^\s*-\s+\*\*Path:\*\*\s+shelf/([a-z0-9][a-z0-9-]*)\s*$')
        if (-not $pathLine.Success) { continue }
        $slug = $pathLine.Groups[1].Value
        $bookRoot = Join-Path (Join-Path $Workspace 'shelf') $slug
        if (-not (Test-Path -LiteralPath $bookRoot -PathType Container)) {
            [void]$orphans.Add($slug)
            continue
        }
        Test-ShelfCatalogEntryText -Text $sectionText -Slug $slug -Label "the shelf/_catalog.md section for shelf/$slug" | Out-Null
        $entryPath = Get-ShelfCatalogEntryPath -Workspace $Workspace -Slug $slug
        if (Test-Path -LiteralPath $entryPath -PathType Leaf) {
            $existing = ConvertTo-SingleTrailingNewline ([Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $entryPath)))
            if ($existing -cne $sectionText) { [void]$conflicts.Add($slug) }
            continue
        }
        [void]$planned.Add([pscustomobject]@{ slug = $slug; entry_path = $entryPath; text = $sectionText })
    }

    if ($conflicts.Count) {
        throw ("$($conflicts.Count) Book(s) already have a $script:ShelfCatalogEntryName that differs from their shelf/_catalog.md section: " +
            "$(@($conflicts) -join ', '). The entry file is the authority once it exists, so nothing was overwritten. " +
            'Reconcile by hand, or delete the entry file to re-derive it from the catalog.')
    }

    # Assigned before it is read. `@($obj).entries` on a pscustomobject throws under
    # Set-StrictMode -Version Latest -- the @() wraps the object, and member enumeration over the
    # wrapper does not find the property. Defect family 4, in .claude/rules/library-development.md.
    $inventory = Get-ShelfCatalogEntryInventory -Workspace $Workspace
    $result = [ordered]@{
        operation            = 'Split shelf/_catalog.md into per-Book entry files'
        planned_entries      = @(@($planned) | ForEach-Object { "shelf/$($_.slug)/$script:ShelfCatalogEntryName" })
        already_migrated     = @(@($inventory.entries) | ForEach-Object { $_.slug })
        catalog_lists_absent = @($orphans)
        shared_library_write = $false
    }
    if ($WhatIfOnly) {
        $result['status'] = 'preflight'
        return [pscustomobject]$result
    }

    # Written inside the render, so the entry files and the catalog they produce commit together --
    # a half-migrated Shelf is never a state anything else can observe.
    $render = Invoke-ShelfCatalogRender -Workspace $Workspace -WriteEntry @(
        @($planned) | ForEach-Object { @{ path = $_.entry_path; text = $_.text } }
    )
    $result['status'] = 'complete'
    $result['entry_count'] = $render.entry_count
    [pscustomobject]$result
}

# --- Self-invocation ------------------------------------------------------------------------------
# Dot-sourced in ordinary use. Reachable directly for the three things a module has to be able to do
# on its own: prove itself, perform the day-one split, and re-render when the gate reports drift.
if ($MyInvocation.InvocationName -ne '.' -and @(@($args) | Where-Object { $_ -cin @('-Render', '-Migrate', '-SelfTest') }).Count) {
    $ErrorActionPreference = 'Stop'
    $argumentList = @($args)
    $workspaceArgument = ''
    for ($i = 0; $i -lt $argumentList.Count - 1; $i++) {
        if ([string]$argumentList[$i] -ceq '-WorkspacePath') { $workspaceArgument = [string]$argumentList[$i + 1] }
    }
    if ([string]::IsNullOrWhiteSpace($workspaceArgument)) { $workspaceArgument = Split-Path -Parent $PSScriptRoot }

    if ($argumentList -contains '-SelfTest') {
        $failures = [Collections.Generic.List[string]]::new()
        $checks = 0
        function Assert([bool]$Condition, [string]$Label) {
            $script:checks++
            if (-not $Condition) { [void]$failures.Add($Label) }
        }
        $utf8 = [Text.UTF8Encoding]::new($false)
        $fixture = Join-Path ([IO.Path]::GetTempPath()) ('shelf-catalog-selftest-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        try {
            New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf') -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $fixture 'docs/templates') -Force | Out-Null
            $headerPath = Join-Path $fixture 'docs/templates/shelf-catalog-header.md'
            [IO.File]::WriteAllText($headerPath, "# Local Shelf`n`nAuthored prose about the Shelf.`n", $utf8)
            $catalogPath = Join-Path $fixture 'shelf/_catalog.md'
            function New-Book([string]$Slug, [string]$Title, [string[]]$Line) {
                New-Item -ItemType Directory -Path (Join-Path $fixture "shelf/$Slug/wiki") -Force | Out-Null
                [IO.File]::WriteAllText((Join-Path $fixture "shelf/$Slug/wiki/_index.md"), "# $Title`n", $utf8)
                if ($null -ne $Line) {
                    [IO.File]::WriteAllText((Join-Path $fixture "shelf/$Slug/_catalog-entry.md"), (New-ShelfCatalogEntryText -Slug $Slug -Title $Title -Line $Line), $utf8)
                }
            }

            # 1. The rendered catalog is the header plus the entries, ordered by slug rather than by
            #    whatever order the filesystem hands back.
            New-Book 'zeta' 'Zeta Book' @('- **Summary:** Last by slug.')
            New-Book 'alpha' 'Alpha Book' @('- **Summary:** First by slug.', '- **Kind:** capture')
            $render = Invoke-ShelfCatalogRender -Workspace $fixture
            Assert ($render.entry_count -eq 2) "the render counted $($render.entry_count) entries rather than 2"
            $rendered = [IO.File]::ReadAllText($catalogPath)
            Assert ($rendered.StartsWith("# Local Shelf`n`nAuthored prose about the Shelf.`n`n## Alpha Book`n", [StringComparison]::Ordinal)) 'the catalog did not render the tracked header followed by the first entry'
            Assert ($rendered.IndexOf('## Alpha Book', [StringComparison]::Ordinal) -lt $rendered.IndexOf('## Zeta Book', [StringComparison]::Ordinal)) 'the entries did not render in slug order'
            Assert ($rendered.EndsWith("- **Path:** shelf/zeta`n", [StringComparison]::Ordinal)) 'the catalog did not end with the last entry'
            Assert ([IO.File]::ReadAllBytes($catalogPath)[0] -ne 0xEF) 'the renderer wrote a UTF-8 BOM'
            Assert (-not @(Get-ShelfCatalogDrift -Workspace $fixture).Count) 'a freshly rendered catalog reported drift'

            # 2. The existing readers still find their Books. This is the compatibility that let the
            #    entry files become the authority without touching a single reader: the rendered file
            #    keeps the exact shape Get-ShelfCatalogEntry and shelf.references-resolve match on.
            $sections = @([regex]::Matches($rendered, '(?ms)^##\s+(.+?)\s*\r?\n(.*?)(?=^##\s+|\z)'))
            Assert ($sections.Count -eq 2) "the rendered catalog parsed as $($sections.Count) sections under the readers' own pattern"
            Assert ([regex]::IsMatch($sections[0].Groups[2].Value, '(?m)^\s*-\s+\*\*Path:\*\*\s+shelf/alpha\s*$')) 'the first section carries no matchable Path line'
            Assert ([regex]::IsMatch($sections[0].Groups[2].Value, '(?m)^\s*-\s+\*\*Kind:\*\*\s+capture\s*$')) 'a capture marker did not survive the render'

            # 2b. A ROLLBACK RE-DERIVES THE CATALOG AND MUST NOT RESTORE ONE. The interleaving is the
            #     test: seat A journals the entry file it is about to rewrite, rewrites it and
            #     renders; seat B publishes a Book of its own and renders; seat A fails and rolls
            #     back. Undoing seat A's own rewrite is what any rollback does. KEEPING SEAT B'S
            #     BOOK is what separates re-deriving from restoring -- a journal carrying
            #     shelf/_catalog.md would put back a snapshot taken before that Book existed, and
            #     the Book would drop out of its own catalog with its directory still on the Shelf.
            #     Unreachable from a single-seat test, which is how it survived until 2026-09-18.
            $alphaEntry = Join-Path $fixture 'shelf/alpha/_catalog-entry.md'
            $entryBefore = [IO.File]::ReadAllText($alphaEntry)
            $rollbackJournal = Write-BookJournal -Workspace $fixture -BookRoot 'shelf/alpha' -Operation 'selftest-rollback' -Paths @($alphaEntry)
            Invoke-ShelfCatalogRender -Workspace $fixture -WriteEntry @(
                @{ path = $alphaEntry; text = (New-ShelfCatalogEntryText -Slug 'alpha' -Title 'Alpha Mid-Write' -Line @('- **Summary:** Half renamed.')) }
            ) | Out-Null
            New-Book 'gamma' 'Gamma Book' @('- **Summary:** Published by the other seat.')
            Invoke-ShelfCatalogRender -Workspace $fixture | Out-Null
            Assert (([IO.File]::ReadAllText($catalogPath)).Contains('## Gamma Book')) 'the second seat did not get its Book into the catalog'
            Restore-BookJournal -JournalPath $rollbackJournal.journal_path | Out-Null
            Invoke-ShelfCatalogRenderAfterRollback -Workspace $fixture | Out-Null
            $afterRollback = [IO.File]::ReadAllText($catalogPath)
            Assert ([IO.File]::ReadAllText($alphaEntry) -ceq $entryBefore) 'the rollback did not restore the entry file it journaled'
            Assert ($afterRollback.Contains('## Alpha Book')) 'the re-derived catalog does not show the restored title'
            Assert (-not $afterRollback.Contains('Alpha Mid-Write')) 'the re-derived catalog kept the mid-write title'
            Assert ($afterRollback.Contains('## Gamma Book')) "a rollback lost another seat's Book from the catalog"
            # And when the Shelf cannot be rendered, the message says what DID land plus the one
            # command that finishes the job -- the reader's only signal that the rollback was half
            # complete rather than failed.
            New-Book 'entryless' 'Entryless Book' $null
            $wrapperMessage = ''
            try { Invoke-ShelfCatalogRenderAfterRollback -Workspace $fixture | Out-Null } catch { $wrapperMessage = $_.Exception.Message }
            Assert ($wrapperMessage -cmatch 'were restored') 'the rollback render failure does not say the journaled files are back'
            Assert ($wrapperMessage -cmatch [regex]::Escape('ShelfCatalog.ps1 -Render')) 'the rollback render failure does not name the repair command'
            # Handed back as case 2 left it, so no later case inherits these two Books.
            Remove-Item -LiteralPath (Join-Path $fixture 'shelf/entryless') -Recurse -Force
            Remove-Item -LiteralPath (Join-Path $fixture 'shelf/gamma') -Recurse -Force
            Invoke-ShelfCatalogRender -Workspace $fixture | Out-Null
            $rendered = [IO.File]::ReadAllText($catalogPath)

            # 3. AN ENTRY MUST NAME THE BOOK IT LIVES UNDER. A copied Book directory carrying the
            #    original's Path line would list one Book twice, and every reader resolving a slug
            #    through the catalog would take whichever section it matched first.
            New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/copied/wiki') -Force | Out-Null
            [IO.File]::Copy((Join-Path $fixture 'shelf/alpha/_catalog-entry.md'), (Join-Path $fixture 'shelf/copied/_catalog-entry.md'))
            $before = [IO.File]::ReadAllText($catalogPath)
            $refused = $false
            try { Invoke-ShelfCatalogRender -Workspace $fixture | Out-Null } catch { $refused = $true }
            Assert $refused 'an entry declaring another Book''s Path was rendered'
            Assert ([IO.File]::ReadAllText($catalogPath) -ceq $before) 'a refused render changed the previous catalog'
            Remove-Item -LiteralPath (Join-Path $fixture 'shelf/copied') -Recurse -Force

            # 4. A Book directory with no entry file is REPORTED, never quietly left out. Silently
            #    skipping it is how a Book disappears from its own catalog while everything passes.
            New-Book 'unlisted' 'Unlisted Book' $null
            $refused = $false
            $message = ''
            try { Invoke-ShelfCatalogRender -Workspace $fixture | Out-Null } catch { $refused = $true; $message = $_.Exception.Message }
            Assert $refused 'a Book with no entry file was rendered as an absent Book'
            Assert ($message -cmatch 'unlisted') 'the refusal did not name the Book it could not list'
            Assert (@(Get-ShelfCatalogDrift -Workspace $fixture).Count -eq 1) 'the drift detector missed an unlistable Book'

            # 5. The day-one split reads the live catalog and writes the entry files it implies.
            $catalogBefore = [IO.File]::ReadAllText($catalogPath)
            [IO.File]::WriteAllText($catalogPath, ($catalogBefore.TrimEnd("`n") + "`n`n## Unlisted Book`n- **Summary:** Listed only in the old catalog.`n- **Path:** shelf/unlisted`n"), $utf8)
            $preflight = Convert-ShelfCatalogToEntries -Workspace $fixture -WhatIfOnly
            Assert (@($preflight.planned_entries) -ccontains 'shelf/unlisted/_catalog-entry.md') 'the migration preflight did not plan the unmigrated Book'
            Assert (-not (Test-Path -LiteralPath (Join-Path $fixture 'shelf/unlisted/_catalog-entry.md'))) 'the migration preflight wrote an entry file'
            $migrated = Convert-ShelfCatalogToEntries -Workspace $fixture
            Assert ($migrated.status -ceq 'complete') 'the migration did not complete'
            Assert (Test-Path -LiteralPath (Join-Path $fixture 'shelf/unlisted/_catalog-entry.md') -PathType Leaf) 'the migration wrote no entry file'
            Assert (-not @(Get-ShelfCatalogDrift -Workspace $fixture).Count) 'the migration left the catalog drifted'
            Assert (([IO.File]::ReadAllText($catalogPath)).Contains('- **Summary:** Listed only in the old catalog.')) 'the migrated entry lost the prose the reader had written'

            # 6. Migration is idempotent, and it refuses rather than overwrites when an entry file
            #    already exists and differs -- the file is the authority the moment it exists.
            $again = Convert-ShelfCatalogToEntries -Workspace $fixture
            Assert (-not @($again.planned_entries).Count) 'a second migration planned work again'
            [IO.File]::WriteAllText((Join-Path $fixture 'shelf/unlisted/_catalog-entry.md'), (New-ShelfCatalogEntryText -Slug 'unlisted' -Title 'Unlisted Book' -Line @('- **Summary:** Edited on disk.')), $utf8)
            Invoke-ShelfCatalogRender -Workspace $fixture | Out-Null
            [IO.File]::WriteAllText($catalogPath, ($catalogBefore.TrimEnd("`n") + "`n`n## Unlisted Book`n- **Summary:** Listed only in the old catalog.`n- **Path:** shelf/unlisted`n"), $utf8)
            $conflicted = $false
            try { Convert-ShelfCatalogToEntries -Workspace $fixture | Out-Null } catch { $conflicted = $true }
            Assert $conflicted 'the migration overwrote an entry file that disagreed with the catalog'
            Assert (([IO.File]::ReadAllText((Join-Path $fixture 'shelf/unlisted/_catalog-entry.md'))).Contains('Edited on disk.')) 'the refused migration changed the entry file anyway'
            Invoke-ShelfCatalogRender -Workspace $fixture | Out-Null

            # 7. shelf/_archive is the Shelf's own namespace, not a Book. An archived Book is out of
            #    the active catalog by design; ADR-0012 keeps it in Discovery instead.
            New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/_archive/retired/wiki') -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $fixture 'shelf/_archive/retired/_catalog-entry.md'), "## Retired Book`n- **Path:** shelf/retired`n", $utf8)
            $render = Invoke-ShelfCatalogRender -Workspace $fixture
            Assert ($render.entry_count -eq 3) "an archived Book changed the entry count to $($render.entry_count)"
            Assert (-not ([IO.File]::ReadAllText($catalogPath)).Contains('Retired Book')) 'an archived Book was listed in the active catalog'

            # 7b. A WRITER'S STAGING DIRECTORY IS NOT A BOOK EITHER, and this one is not
            #     hypothetical: Import-ExternalWikiToShelf stages inside shelf/ as
            #     `.migration-<slug>-<digest>`, so a render during any import would have refused it
            #     as "not a Book slug" -- a guaranteed failure, not a race.
            New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/.migration-incoming-abc123/wiki') -Force | Out-Null
            $render = Invoke-ShelfCatalogRender -Workspace $fixture
            Assert ($render.entry_count -eq 3) "a writer's staging directory changed the entry count to $($render.entry_count)"
            Assert (-not @(Get-ShelfCatalogDrift -Workspace $fixture).Count) 'a staging directory under shelf/ was reported as drift'
            Remove-Item -LiteralPath (Join-Path $fixture 'shelf/.migration-incoming-abc123') -Recurse -Force

            # 7c. A name that is NEITHER prefixed nor a slug is still refused: the catalog cannot say
            #     what it is, and guessing is how a directory of unknown provenance gets listed.
            New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/Not A Slug') -Force | Out-Null
            $refused = $false
            try { Invoke-ShelfCatalogRender -Workspace $fixture | Out-Null } catch { $refused = $true }
            Assert $refused 'a directory under shelf/ whose name is not a Book slug was rendered around'
            Remove-Item -LiteralPath (Join-Path $fixture 'shelf/Not A Slug') -Recurse -Force

            # 8. THE HEADER IS THE TRACKED FILE'S, and a header that would render as a Book entry is
            #    refused rather than published.
            [IO.File]::WriteAllText($headerPath, "# Local Shelf`n`n## Not A Book`n`nProse under a second heading.`n", $utf8)
            $refused = $false
            try { Invoke-ShelfCatalogRender -Workspace $fixture | Out-Null } catch { $refused = $true }
            Assert $refused 'a header carrying a column-zero subheading was rendered as a phantom Book'
            [IO.File]::Delete($headerPath)
            $refused = $false
            $message = ''
            try { Invoke-ShelfCatalogRender -Workspace $fixture | Out-Null } catch { $refused = $true; $message = $_.Exception.Message }
            Assert $refused 'a missing header template was rendered around'
            Assert ($message -cmatch 'shelf-catalog-header') 'the refusal did not name the tracked header it needs'

            # 9. The composer appends the Path line itself, so no caller can mislabel an entry, and
            #    non-ASCII prose survives as UTF-8.
            $eAcute = [string][char]0x00E9
            $composed = New-ShelfCatalogEntryText -Slug 'alpha' -Title "Caf$eAcute Book" -Line @('- **Summary:** Accented.')
            Assert ($composed.Contains("- **Path:** shelf/alpha")) 'the composer did not append the Path line'
            Assert ($composed.Contains("Caf$eAcute Book")) 'the composer mangled a non-ASCII title'
            $mislabelled = $false
            try { New-ShelfCatalogEntryText -Slug 'alpha' -Title 'Alpha' -Line @('- **Path:** shelf/zeta') | Out-Null } catch { $mislabelled = $true }
            Assert $mislabelled 'a caller supplied a second Path line and it was accepted'
        }
        finally { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }

        if ($failures.Count) {
            [Console]::Error.WriteLine("ShelfCatalog self-test FAILED: $($failures -join '; ')")
            exit 1
        }
        Write-Host "ShelfCatalog self-test passed ($script:checks checks)."
        exit 0
    }

    $resolvedWorkspace = (Resolve-Path -LiteralPath $workspaceArgument).Path
    if ($argumentList -contains '-Migrate') {
        Convert-ShelfCatalogToEntries -Workspace $resolvedWorkspace -WhatIfOnly:($argumentList -contains '-Preflight') | Format-List
        exit 0
    }

    $render = Invoke-ShelfCatalogRender -Workspace $resolvedWorkspace
    [pscustomobject]@{
        operation            = 'Render the Shelf catalog'
        workspace            = $resolvedWorkspace
        catalog_path         = $render.catalog_path
        entry_count          = $render.entry_count
        shared_library_write = $false
    } | Format-List
    exit 0
}
