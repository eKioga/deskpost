[CmdletBinding()]
param([string]$WorkspacePath, [switch]$SelfTest)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# The capture-Book half reads the catalog, the note frontmatter, and the review state through the
# same primitives Add-ShelfNote and the Desk overview use. This helper stays READ-ONLY: it calls
# Get-CaptureBooks and Get-ShelfNotes and nothing that writes.
. (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')

function Get-Utf8Hash([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
function Get-PropertyValue($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    $property.Value
}
function Normalize-SourcePath([string]$Path) {
    if ($Path -match '^wiki/(.+)$') { return 'notebook/' + $Matches[1] }
    # A journal source naming a capture-Book note -- 'shelf/<slug>/wiki/notes/<file>.md', written
    # since triage let a note reach a Project or a shared Book directly -- falls through unchanged.
    # The rule above is anchored at 'wiki/', so it cannot reach inside one of these and rewrite it
    # into a Notebook path that was never involved.
    $Path
}
# --- What a page NAMES, and whether that thing is durable -------------------------------------------
#
# WHY THIS EXISTS. `copy_status` answers one question well: does a publication journal record this
# exact content reaching a Book or Project? It is evidence-based and hash-bound, and
# `no-known-copy-record` is a TRUE statement when it appears. What it cannot see is a page whose
# substance was written into a git-tracked design record rather than published as a page -- and that
# gap produced a real misreading: a frozen spec was proposed for rescue as "work that hasn't been
# built yet" while naming, in its own text, both the design record for that work and the helper that
# implements it.
#
# So the pages are asked what they point at. This is deliberately NOT a claim that a page is already
# safe -- a reference is a POINTER, not proof of coverage, and only a reader opening it can say
# whether it covers the page. It is the difference between deciding from memory and deciding from
# evidence.

# A workspace-relative path with at least one separator. Anchored on a known top-level directory so
# ordinary prose containing a slash does not become a reference.
$script:ReferenceRoots = 'docs|tools|shelf|books|archive|notebook|internal|output'
$script:ReferencePattern = '(?<![A-Za-z0-9._/-])(?:' + $script:ReferenceRoots + ')/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*'

function Get-TrackedPathSet([string]$Workspace) {
    <#
    .SYNOPSIS
        Every git-tracked path, or $null when that cannot be established.

    .DESCRIPTION
        ONE git call, not one per reference. Returns $null rather than an empty set when git is
        absent or the directory is not a repository, because "nothing is tracked" and "I could not
        tell" are different answers and only one of them is safe to render as `untracked`.

        -NoEnumerate IS LOAD-BEARING, and its absence was a real defect this file shipped with for
        exactly one mutation sweep. PowerShell enumerates a collection on output, so `$set` returned
        bare arrives at the caller as a String when it holds one item, an Object[] when it holds
        several, and $null when it is empty -- never as the HashSet, and never carrying the
        OrdinalIgnoreCase comparer built into it. Two consequences, both silent: a path differing
        only in case was misclassified, though these are Windows paths where case does not
        distinguish files; and with exactly ONE tracked file `.Contains()` became String.Contains,
        a SUBSTRING test that matches any path which is a prefix of it. This repository has enough
        tracked files to land on Object[], whose ordinal Contains happens to be right, which is
        precisely why it looked correct against real input.
    #>
    $set = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    try {
        $output = & git -C $Workspace ls-files 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
    }
    catch { return $null }
    foreach ($line in @($output)) {
        $path = ([string]$line).Trim().Replace('\', '/')
        if ($path) { [void]$set.Add($path) }
    }
    Write-Output $set -NoEnumerate
}

function Get-PageReferences([string]$Workspace, [string]$FullPath, $TrackedPaths) {
    <#
    .SYNOPSIS
        The workspace paths one page names, each classified for durability.

    .DESCRIPTION
        No cap. A Notebook page names a handful of paths -- the largest here names eleven -- and a cap
        that cannot bind is a flag nobody watches go red.

        `tracked` means git has the file, so it survives a Notebook reset AND a fresh clone. It does
        NOT mean the reference covers this page's substance.
    #>
    $text = ''
    try { $text = [IO.File]::ReadAllText($FullPath) } catch { return @() }

    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $references = [Collections.Generic.List[object]]::new()
    foreach ($match in @([regex]::Matches($text, $script:ReferencePattern))) {
        $path = $match.Value.Replace('\', '/').TrimEnd('.', ',', ';', ':')
        if (-not $seen.Add($path)) { continue }
        $durability =
            if ($null -eq $TrackedPaths) { 'unknown' }
            elseif ($TrackedPaths.Contains($path)) { 'tracked' }
            elseif (Test-Path -LiteralPath (Join-Path $Workspace $path)) { 'untracked' }
            else { 'missing' }
        [void]$references.Add([pscustomobject]@{ path = $path; durability = $durability })
    }
    @($references | Sort-Object -Property @{ Expression = { [string]$_.path } })
}

function Get-JournalEntries([string]$JournalPath) {
    $journal = [IO.File]::ReadAllText($JournalPath) | ConvertFrom-Json
    $state = [string](Get-PropertyValue $journal 'state')
    $errorText = [string](Get-PropertyValue $journal 'error')
    $bookSlug = [string](Get-PropertyValue $journal 'book_slug')
    $projectSlug = [string](Get-PropertyValue $journal 'project_slug')
    $destinationType = if (-not [string]::IsNullOrWhiteSpace($bookSlug)) { 'book' } elseif (-not [string]::IsNullOrWhiteSpace($projectSlug)) { 'project' } else { return @() }
    $destinationSlug = if ($destinationType -eq 'book') { $bookSlug } else { $projectSlug }
    $quality = if ($state -eq 'complete') { 'complete' } elseif ($destinationType -eq 'book' -and $state -eq 'candidate' -and [string]::IsNullOrWhiteSpace($errorText)) { 'legacy-complete' } else { 'incomplete' }
    if ($quality -eq 'incomplete') { return @() }
    $entries = [Collections.Generic.List[object]]::new()
    $planned = @((Get-PropertyValue $journal 'planned_records') | Where-Object { $null -ne $_ })
    if ($planned.Count) {
        foreach ($record in $planned) {
            if ($null -ne $record -and (Get-PropertyValue $record 'source')) {
                [void]$entries.Add([pscustomobject]@{ source = Normalize-SourcePath ([string](Get-PropertyValue $record 'source')); source_sha256 = [string](Get-PropertyValue $record 'sha256'); destination_type = $destinationType; destination_slug = $destinationSlug; journal = $JournalPath; quality = $quality })
            }
        }
        return @($entries | ForEach-Object { $_ })
    }
    if ($destinationType -ne 'book') { return @() }
    $legacy = @((Get-PropertyValue $journal 'attempted_records') | Where-Object { $null -ne $_ })
    foreach ($record in $legacy) {
        $path = [string]$record
        if ($path -match '^books/[^/]+/wiki/(.+\.md)$' -and $Matches[1] -notin @('_book.md', '_index.md')) {
            [void]$entries.Add([pscustomobject]@{ source = ('notebook/' + $Matches[1]); source_sha256 = ''; destination_type = $destinationType; destination_slug = $destinationSlug; journal = $JournalPath; quality = $quality })
        }
    }
    @($entries | ForEach-Object { $_ })
}

# ---------------------------------------------------------------------------------------------------
# Self-test. Fixture-only and offline; run by Invoke-LibraryChecks.ps1 as `handoff-inventory.selftest`.
# The classification is pure -- it takes the tracked-path set as an argument -- so every durability
# value including `unknown` is reachable without a git repository.
# ---------------------------------------------------------------------------------------------------
if ($SelfTest) {
    $script:failures = [Collections.Generic.List[string]]::new()
    $script:checks = 0
    function Assert([bool]$Condition, [string]$Message) {
        $script:checks++
        if (-not $Condition) { [void]$script:failures.Add($Message) }
    }
    function First($Items) {
        $all = @($Items)
        if ($all.Count) { return $all[0] }
        $null
    }
    function Get-Ref($References, [string]$Path) {
        First @(@($References) | Where-Object { [string]$_.path -ceq $Path })
    }
    # The assembled report over a real process boundary, and $null when the run did not produce one.
    #
    # stderr goes to $null and the verdict comes from $LASTEXITCODE, NOT from `2>&1`. Under
    # $ErrorActionPreference = 'Stop' -- which this file sets -- redirecting a native executable's
    # stderr into the success stream turns each line into a terminating NativeCommandError, so a
    # child that threw killed the suite with PowerShell's own message instead of letting the Assert
    # below report WHICH invariant broke. The mutation that proves the missing-source cases is
    # exactly a child that throws, so this is the difference between a suite that fails and a suite
    # that says why.
    function Get-SpawnedReport([string]$Root) {
        $raw = $null
        try { $raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& '$PSCommandPath' -WorkspacePath '$Root' | ConvertTo-Json -Depth 8" 2>$null }
        catch { return $null }
        if ($LASTEXITCODE -ne 0) { return $null }
        try { return (@($raw) -join "`n") | ConvertFrom-Json } catch { return $null }
    }

    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('triage-inv-selftest-' + [guid]::NewGuid().ToString('n'))
    try {
        $utf8 = [Text.UTF8Encoding]::new($false)
        New-Item -ItemType Directory -Path (Join-Path $fixture 'docs') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $fixture 'docs/kept.md'), 'tracked', $utf8)
        [IO.File]::WriteAllText((Join-Path $fixture 'docs/loose.md'), 'present but untracked', $utf8)

        # A page naming one of each class, plus prose that must NOT become a reference, plus a
        # duplicate and a trailing full stop. The accented character is here because an ASCII
        # fixture cannot catch an encoding defect.
        $body = @(
            '# Spec',
            'Read ' + [char]0x0060 + 'docs/kept.md' + [char]0x0060 + ' first, and see docs/kept.md again.',
            'Also docs/loose.md and tools/Never-Existed.ps1.',
            'It runs 24/7 and applies to this and/or that.',
            'Trailing punctuation: docs/kept.md.',
            'Caf' + [char]0x00E9 + ' notes live elsewhere.'
        ) -join "`n"
        $pagePath = Join-Path $fixture 'notebook/spec.md'
        [IO.File]::WriteAllText($pagePath, $body, $utf8)

        $tracked = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        [void]$tracked.Add('docs/kept.md')

        $refs = @(Get-PageReferences -Workspace $fixture -FullPath $pagePath -TrackedPaths $tracked)

        # --- The three classes ------------------------------------------------------------------
        $kept = Get-Ref $refs 'docs/kept.md'
        Assert ($null -ne $kept) 'a tracked reference was not found at all'
        if ($null -ne $kept) { Assert ([string]$kept.durability -ceq 'tracked') "a git-tracked file was classified '$($kept.durability)'" }

        $loose = Get-Ref $refs 'docs/loose.md'
        Assert ($null -ne $loose) 'an untracked but present reference was not found'
        if ($null -ne $loose) { Assert ([string]$loose.durability -ceq 'untracked') "a present, untracked file was classified '$($loose.durability)'" }

        $gone = Get-Ref $refs 'tools/Never-Existed.ps1'
        Assert ($null -ne $gone) 'a reference to a nonexistent path was not reported'
        if ($null -ne $gone) { Assert ([string]$gone.durability -ceq 'missing') "a nonexistent path was classified '$($gone.durability)'" }

        # --- THE FAIL-CLOSED ONE. With no tracked set there is no way to tell tracked from
        #     untracked, and answering `untracked` would be false confidence in the direction that
        #     makes a page look MORE at risk than it is -- which is the misreading this whole
        #     addition exists to prevent, pointed the other way.
        $blind = @(Get-PageReferences -Workspace $fixture -FullPath $pagePath -TrackedPaths $null)
        Assert (@($blind).Count -eq @($refs).Count) 'an unresolvable tracked set changed which references were found'
        $blindKept = Get-Ref $blind 'docs/kept.md'
        Assert ($null -ne $blindKept) 'the blind scan lost a reference'
        if ($null -ne $blindKept) { Assert ([string]$blindKept.durability -ceq 'unknown') "with no tracked set, durability read '$($blindKept.durability)' rather than unknown" }
        Assert (-not (@($blind) | Where-Object { [string]$_.durability -ceq 'tracked' -or [string]$_.durability -ceq 'untracked' })) `
            'a blind scan asserted tracked or untracked for a reference it could not classify'

        # --- Prose is not a reference -------------------------------------------------------------
        foreach ($noise in @('24/7', 'and/or')) {
            Assert ($null -eq (Get-Ref $refs $noise)) "prose '$noise' was treated as a path reference"
        }
        Assert (-not (@($refs) | Where-Object { ([string]$_.path).StartsWith('this', [StringComparison]::OrdinalIgnoreCase) })) `
            'a bare word before a slash was captured as a reference root'

        # --- Deduplication and trailing punctuation ------------------------------------------------
        Assert (@(@($refs) | Where-Object { [string]$_.path -ceq 'docs/kept.md' }).Count -eq 1) `
            'a reference named three times was reported more than once'
        Assert ($null -eq (Get-Ref $refs 'docs/kept.md.')) 'a trailing full stop was kept as part of the path'

        # --- A page naming nothing -----------------------------------------------------------------
        $bare = Join-Path $fixture 'notebook/bare.md'
        [IO.File]::WriteAllText($bare, 'No paths here at all.', $utf8)
        $none = @(Get-PageReferences -Workspace $fixture -FullPath $bare -TrackedPaths $tracked)
        Assert ($none.Count -eq 0) 'a page naming nothing produced references'
        # @() so an empty result is a list rather than $null -- .Count on $null throws under StrictMode.
        Assert ($null -ne $none) 'an empty reference set came back as null rather than an empty list'

        # An unreadable page must be an empty list, not a thrown run.
        $missingPage = Join-Path $fixture 'notebook/does-not-exist.md'
        Assert (@(Get-PageReferences -Workspace $fixture -FullPath $missingPage -TrackedPaths $tracked).Count -eq 0) `
            'an unreadable page threw instead of reporting no references'

        # --- Get-TrackedPathSet on something that is not a repository -------------------------------
        Assert ($null -eq (Get-TrackedPathSet $fixture)) `
            'a directory that is not a git repository returned a set rather than $null, which would render every reference untracked'

        # --- THE SET MUST SURVIVE THE RETURN AS A SET ------------------------------------------------
        # PowerShell enumerates a collection on output. Returned bare, this arrives as a String for
        # one item, an Object[] for several, and $null for none -- losing the OrdinalIgnoreCase
        # comparer every time, and turning `.Contains()` into a SUBSTRING test in the one-item case.
        $repoRoot = Split-Path -Parent $PSScriptRoot
        $realSet = Get-TrackedPathSet $repoRoot
        Assert ($null -ne $realSet) 'the workspace itself did not resolve as a git repository'
        if ($null -ne $realSet) {
            Assert ($realSet -is [Collections.Generic.HashSet[string]]) `
                "the tracked-path set came back as $($realSet.GetType().Name), not a HashSet; its comparer is gone"
            Assert ($realSet.Contains('tools/Get-LibraryTriageInventory.ps1')) 'the tracked set does not contain this very file'
            # Windows paths do not distinguish case, so the comparer must survive.
            Assert ($realSet.Contains('TOOLS/GET-LIBRARYTRIAGEINVENTORY.PS1')) `
                'the tracked set lost its OrdinalIgnoreCase comparer, so a case-differing path reads untracked'
            # And a prefix of a tracked path must NOT match, which String.Contains would allow.
            Assert (-not $realSet.Contains('tools/Get-LibraryTriage')) `
                'the tracked set matched a PREFIX of a tracked path; .Contains has become a substring test'
        }

        # --- THE ASSEMBLED REPORT, over a real process boundary ------------------------------------
        # The classification above is pure and testable in-process; the two fields that carry it to a
        # reader are wired into the report body, which only runs on invocation. Spawning the script
        # against the fixture is what makes a mutation in that wiring fire.
        $report = Get-SpawnedReport $fixture
        Assert ($null -ne $report) 'the inventory could not be run against the fixture workspace'
        if ($null -ne $report) {
            Assert (-not [string]::IsNullOrWhiteSpace([string]$report.reference_rule)) 'the assembled report dropped the reference rule'
            Assert (([string]$report.reference_rule).IndexOf('POINTER, not proof of coverage', [StringComparison]::Ordinal) -ge 0) `
                'the reference rule no longer says a reference is not proof of coverage'
            $specPage = First @(@($report.pages) | Where-Object { [string]$_.path -ceq 'notebook/spec.md' })
            Assert ($null -ne $specPage) 'the assembled report did not include the fixture page'
            if ($null -ne $specPage) {
                Assert (@($specPage.references).Count -ge 3) "the assembled page carried $(@($specPage.references).Count) reference(s), expected at least 3"
                # In the fixture workspace git tracks nothing, so the honest count is zero -- and the
                # field must still be PRESENT rather than absent.
                Assert ($null -ne $specPage.PSObject.Properties['tracked_reference_count']) 'the assembled page has no tracked_reference_count field'
                Assert ([int]$specPage.tracked_reference_count -eq 0) `
                    "an untracked fixture reported $($specPage.tracked_reference_count) tracked reference(s); the count is not counting durability"
            }
            Assert (-not $report.references_resolvable) 'a non-repository fixture reported its references as resolvable'
            # The fixture has no shelf/_catalog.md, so the capture-Book half must report absent
            # rather than throw on the missing catalog.
            Assert ($null -ne $report.PSObject.Properties['holding_present']) 'the assembled report has no holding_present field'
            Assert (-not $report.holding_present) 'a fixture with no Shelf catalog reported capture Books present'
            Assert ([int]$report.holding_note_count -eq 0) "a fixture with no Shelf reported $($report.holding_note_count) holding note(s)"
            Assert ($report.notebook_present) 'a fixture WITH a notebook/ reported it absent'
        }

        # --- NEITHER SOURCE IS REQUIRED. THIS IS THE ONE THE PREVIOUS HELPER GOT WRONG ------------
        #
        # Get-LibraryHandoffInventory.ps1 threw when notebook/ was absent, and Reset-LocalNotebook.ps1
        # calls this helper to build the advisory a reader reads at the reset approval. A Reset
        # DELETES notebook/, so the very state a second reset would meet -- a populated Holding Shelf
        # and no Notebook -- was the state that made the advisory read `unavailable`. Each of the
        # three shapes is spawned as a real process, because the throw was in the report body and no
        # in-process call to the pure functions above can reach it.
        # (a) A Holding Shelf and no Notebook -- the shape immediately after a Reset.
        $afterReset = Join-Path $fixture 'after-reset'
        New-Item -ItemType Directory -Path (Join-Path $afterReset 'shelf/holding/wiki/notes') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $afterReset 'shelf/_catalog.md'),
            "# Shelf`n`n## Holding Shelf`n- **Summary:** Unsorted captures.`n- **Kind:** capture`n- **Path:** shelf/holding`n", $utf8)
        [IO.File]::WriteAllText((Join-Path $afterReset 'shelf/holding/wiki/notes/2026-08-28-kept.md'),
            "---`ncaptured: 2026-08-28T10:00:00Z`nreview: pending`n---`n`n# Kept finding`n`nBody.`n", $utf8)
        $resetShape = Get-SpawnedReport $afterReset
        Assert ($null -ne $resetShape) 'the inventory THREW on a workspace with a Holding Shelf and no notebook/ -- the state a Reset leaves behind'
        if ($null -ne $resetShape) {
            Assert (-not $resetShape.notebook_present) 'a workspace with no notebook/ reported it present'
            Assert ([int]$resetShape.page_count -eq 0) "a workspace with no notebook/ reported $($resetShape.page_count) Notebook page(s)"
            Assert ($resetShape.holding_present) 'a populated Holding Shelf was reported absent'
            Assert ([int]$resetShape.holding_note_count -eq 1) "the Holding Shelf note count read $($resetShape.holding_note_count), expected 1"
            Assert ([int]$resetShape.holding_pending_count -eq 1) "the pending count read $($resetShape.holding_pending_count), expected 1"
            Assert ([string]$resetShape.holding_oldest_pending -ceq '2026-08-28T10:00:00Z') "the oldest pending date read '$($resetShape.holding_oldest_pending)'"
            $kept = First @(@($resetShape.holding_notes) | Where-Object { [string]$_.page -ceq 'notes/2026-08-28-kept' })
            Assert ($null -ne $kept) 'the report did not list the Holding Shelf note'
            if ($null -ne $kept) {
                Assert ([string]$kept.title -ceq 'Kept finding') "the note title read '$($kept.title)'"
                Assert ([string]$kept.copy_status -ceq 'no-known-copy-record') "an uncopied note read copy_status '$($kept.copy_status)'"
                # Counts, titles, and hashes are orientation; a body needs the Book open.
                Assert ($null -eq $kept.PSObject.Properties['content']) 'the inventory carried a note BODY into its report'
            }
        }

        # (b) A Notebook and no Shelf at all.
        $noShelf = Join-Path $fixture 'no-shelf'
        New-Item -ItemType Directory -Path (Join-Path $noShelf 'notebook') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $noShelf 'notebook/only.md'), "# Only`n`nBody.`n", $utf8)
        $shelfless = Get-SpawnedReport $noShelf
        Assert ($null -ne $shelfless) 'the inventory threw on a workspace with a Notebook and no Shelf'
        if ($null -ne $shelfless) {
            Assert ($shelfless.notebook_present) 'a workspace WITH a notebook/ reported it absent'
            Assert ([int]$shelfless.page_count -eq 1) "the Notebook page count read $($shelfless.page_count), expected 1"
            Assert (-not $shelfless.holding_present) 'a workspace with no Shelf reported capture Books present'
            Assert ([int]$shelfless.holding_note_count -eq 0) 'a workspace with no Shelf reported holding notes'
        }

        # --- (d) THE PER-TOPIC ROLL-UP (ADR-0022) ------------------------------------------------
        #
        # THE FIXTURE IS BUILT SO THAT A WRONG IMPLEMENTATION DIFFERS FROM A RIGHT ONE, rather than so
        # that a right one produces something. Each topic below is the decoy for one specific way of
        # getting this wrong, and every one of them is a list that must SURVIVE rather than a list that
        # must be empty:
        #
        #   alpha  -- copied to a BOOK only.        Its known_projects must stay empty.
        #   beta   -- copied to a PROJECT HUB only. Its known_projects must hold beta-project and its
        #             known_books must stay EMPTY. This is the D3 regression detector: an
        #             implementation that merges the two classes fails here and nowhere else.
        #   gamma  -- one page of each of the four copy states, so `pages_without_current_copy` is 3.
        #             An implementation that counts a legacy record or a drifted one as proof reads 2
        #             or 1 here, and every other assertion in this suite still passes.
        #
        # THREE TOPICS, NOT TWO, because with two a truncation puts one in the right bucket and loses
        # the other invisibly. The fourth row is the loose file, which has no topic and must not
        # vanish -- and the totals are asserted from OUTSIDE the grouping, because a filter that drops
        # an item from the numerator and the denominator alike makes a partial answer read complete.
        $grouped = Join-Path $fixture 'grouped'
        $groupedJournals = Join-Path $grouped 'internal/publication-journals'
        New-Item -ItemType Directory -Path $groupedJournals -Force | Out-Null
        foreach ($topicName in @('alpha', 'beta', 'gamma')) {
            New-Item -ItemType Directory -Path (Join-Path $grouped "notebook/$topicName") -Force | Out-Null
        }
        function Write-FixturePage([string]$Relative, [string]$Text) {
            $full = Join-Path $grouped $Relative
            [IO.File]::WriteAllText($full, $Text, $utf8)
            Get-Utf8Hash $full
        }
        function Write-FixtureJournal([string]$Name, $Body) {
            [IO.File]::WriteAllText((Join-Path $groupedJournals "$Name.json"), ($Body | ConvertTo-Json -Depth 6), $utf8)
        }
        function Write-CompleteJournal([string]$Name, [string]$SlugField, [string]$Slug, [string]$Source, [string]$Sha) {
            $body = [ordered]@{
                state = 'complete'
                planned_records = @(@{ path = "destination/$Name.md"; source = $Source; sha256 = $Sha })
            }
            $body[$SlugField] = $Slug
            Write-FixtureJournal $Name ([pscustomobject]$body)
        }
        # Names a topic that does not exist, so a roll-up keyed off the index would show it.
        [IO.File]::WriteAllText((Join-Path $grouped 'notebook/_master-index.md'), "# Index`n`n- delta`n", $utf8)
        $strayHash = Write-FixturePage 'notebook/stray.md' "# Stray`n`nA loose file belonging to no topic.`n"

        $alphaOne = Write-FixturePage 'notebook/alpha/one.md' "# Alpha one`n"
        $alphaTwo = Write-FixturePage 'notebook/alpha/two.md' "# Alpha two`n"
        Write-CompleteJournal 'alpha-one' 'book_slug' 'alpha-book' 'notebook/alpha/one.md' $alphaOne
        Write-CompleteJournal 'alpha-two' 'book_slug' 'alpha-book' 'notebook/alpha/two.md' $alphaTwo

        $betaOne = Write-FixturePage 'notebook/beta/one.md' "# Beta one`n"
        $betaTwo = Write-FixturePage 'notebook/beta/two.md' "# Beta two`n"
        Write-CompleteJournal 'beta-one' 'project_slug' 'beta-project' 'notebook/beta/one.md' $betaOne
        Write-CompleteJournal 'beta-two' 'project_slug' 'beta-project' 'notebook/beta/two.md' $betaTwo

        $gammaCurrent = Write-FixturePage 'notebook/gamma/current.md' "# Gamma current`n"
        Write-CompleteJournal 'gamma-current' 'book_slug' 'gamma-book' 'notebook/gamma/current.md' $gammaCurrent
        # A complete record whose hash is NOT this page's: the copy exists and is of another version.
        $null = Write-FixturePage 'notebook/gamma/drifted.md' "# Gamma drifted`n"
        Write-CompleteJournal 'gamma-drifted' 'book_slug' 'gamma-book' 'notebook/gamma/drifted.md' ('0' * 64)
        # The legacy shape: a `candidate` Book journal with no planned_records, whose attempted_records
        # are mapped back to notebook/ with an EMPTY source hash. It binds no content at all.
        $null = Write-FixturePage 'notebook/gamma/legacy.md' "# Gamma legacy`n"
        Write-FixtureJournal 'gamma-legacy' ([pscustomobject]@{
            state = 'candidate'
            book_slug = 'gamma-legacy-book'
            error = ''
            attempted_records = @('books/gamma-legacy-book/wiki/gamma/legacy.md')
        })
        $null = Write-FixturePage 'notebook/gamma/none.md' "# Gamma uncopied`n"

        # Returned behind a comma: a function emitting an EMPTY array emits nothing, which arrives
        # as $null, and .Count on $null throws under StrictMode. The comma survives the unroll.
        function Names($Value) { , @(@($Value) | Where-Object { $_ }) }
        function Get-TopicRow($Report, [string]$Name) {
            First @(@($Report.topics) | Where-Object { [string]$_.topic -ceq $Name })
        }

        $groupedReport = Get-SpawnedReport $grouped
        Assert ($null -ne $groupedReport) 'the inventory could not be run against the per-topic fixture'
        if ($null -ne $groupedReport) {
            Assert ($null -ne $groupedReport.PSObject.Properties['topics']) 'the assembled report has no topics field'

            # THE SET, IN ORDER. A truncation, a dropped loose file, or the master index leaking in as
            # a topic all change this one string.
            $names = @(@($groupedReport.topics) | ForEach-Object { [string]$_.topic })
            Assert (($names -join '|') -ceq '|alpha|beta|gamma') `
                "the topic rows read '$($names -join '|')', expected '|alpha|beta|gamma'"

            # THE TOTAL, ASSERTED FROM OUTSIDE THE GROUPING. page_count counts every Notebook page
            # including the master index; the rows account for all of them but that one.
            $rowTotal = 0
            foreach ($row in @($groupedReport.topics)) { $rowTotal += [int]$row.page_count }
            Assert ([int]$groupedReport.page_count -eq 10) `
                "the fixture reported $($groupedReport.page_count) page(s), expected 10"
            Assert ($rowTotal -eq ([int]$groupedReport.page_count - 1)) `
                "the topic rows account for $rowTotal of $($groupedReport.page_count) pages; exactly one -- the master index -- may be missing"

            # Every row's four states must partition its pages, so a status value silently dropped
            # from the roll-up cannot hide inside page_count.
            foreach ($row in @($groupedReport.topics)) {
                $partition = [int]$row.known_current_copy_count + [int]$row.known_copy_drifted_count +
                             [int]$row.legacy_copy_record_count + [int]$row.no_known_copy_record_count
                Assert ($partition -eq [int]$row.page_count) `
                    "topic '$($row.topic)': the four copy-state counts sum to $partition, not its $($row.page_count) page(s)"
            }

            # --- alpha: a Book copy is not a Project copy ----------------------------------------
            $alphaRow = Get-TopicRow $groupedReport 'alpha'
            Assert ($null -ne $alphaRow) 'the Book-copied topic produced no row'
            if ($null -ne $alphaRow) {
                Assert ([int]$alphaRow.page_count -eq 2) "alpha holds $($alphaRow.page_count) page(s), expected 2"
                Assert ([int]$alphaRow.known_current_copy_count -eq 2) "alpha reported $($alphaRow.known_current_copy_count) current copy record(s), expected 2"
                Assert ([int]$alphaRow.pages_without_current_copy -eq 0) "alpha reported $($alphaRow.pages_without_current_copy) page(s) without a current copy, expected 0"
                Assert (((Names $alphaRow.known_books) -join ',') -ceq 'alpha-book') `
                    "alpha's known_books read '$((Names $alphaRow.known_books) -join ',')', expected 'alpha-book'"
                Assert ((Names $alphaRow.known_projects).Count -eq 0) `
                    "alpha was copied to no Project Hub, but known_projects read '$((Names $alphaRow.known_projects) -join ',')'"
            }

            # --- beta: THE D3 REGRESSION DETECTOR -------------------------------------------------
            # A roll-up that merges the two destination classes reports beta as Book-copied, which is
            # exactly the live misreading this ADR was written against: 2nd-b-vault-dev is 0 of 11 in
            # Books and 10 of 11 in a Project Hub.
            $betaRow = Get-TopicRow $groupedReport 'beta'
            Assert ($null -ne $betaRow) 'the Project-copied topic produced no row'
            if ($null -ne $betaRow) {
                Assert ([int]$betaRow.known_current_copy_count -eq 2) "beta reported $($betaRow.known_current_copy_count) current copy record(s), expected 2"
                Assert (((Names $betaRow.known_projects) -join ',') -ceq 'beta-project') `
                    "beta's known_projects read '$((Names $betaRow.known_projects) -join ',')', expected 'beta-project'"
                Assert ((Names $betaRow.known_books).Count -eq 0) `
                    "beta reached a Project Hub and no Book, but known_books read '$((Names $betaRow.known_books) -join ',')' -- the two destination classes have been merged"
            }

            # --- gamma: only a CURRENT copy is proof ---------------------------------------------
            $gammaRow = Get-TopicRow $groupedReport 'gamma'
            Assert ($null -ne $gammaRow) 'the mixed-state topic produced no row'
            if ($null -ne $gammaRow) {
                Assert ([int]$gammaRow.page_count -eq 4) "gamma holds $($gammaRow.page_count) page(s), expected 4"
                Assert ([int]$gammaRow.known_current_copy_count -eq 1) "gamma reported $($gammaRow.known_current_copy_count) current copy record(s), expected 1"
                Assert ([int]$gammaRow.known_copy_drifted_count -eq 1) "gamma reported $($gammaRow.known_copy_drifted_count) drifted record(s), expected 1"
                Assert ([int]$gammaRow.legacy_copy_record_count -eq 1) "gamma reported $($gammaRow.legacy_copy_record_count) legacy record(s), expected 1"
                Assert ([int]$gammaRow.no_known_copy_record_count -eq 1) "gamma reported $($gammaRow.no_known_copy_record_count) page(s) with no record, expected 1"
                Assert ([int]$gammaRow.pages_without_current_copy -eq 3) `
                    "gamma reported $($gammaRow.pages_without_current_copy) page(s) without a current copy, expected 3 -- a drifted or legacy record is being counted as proof"
                # known_books is WHERE TO LOOK, not what is proven: the legacy record's destination is
                # carried, and the Book named by two of gamma's records appears once.
                Assert (((Names $gammaRow.known_books) -join ',') -ceq 'gamma-book,gamma-legacy-book') `
                    "gamma's known_books read '$((Names $gammaRow.known_books) -join ',')', expected 'gamma-book,gamma-legacy-book'"
            }

            # --- the loose file: no topic, and it must not disappear ------------------------------
            $looseRow = Get-TopicRow $groupedReport ''
            Assert ($null -ne $looseRow) 'a loose file under notebook/ produced no row at all, so a reset would quarantine material the report never named'
            if ($null -ne $looseRow) {
                Assert ([int]$looseRow.page_count -eq 1) `
                    "the empty-topic row holds $($looseRow.page_count) page(s), expected 1 -- notebook/_master-index.md must be excluded and notebook/stray.md must not"
                Assert ([int]$looseRow.no_known_copy_record_count -eq 1) "the loose file reported $($looseRow.no_known_copy_record_count) page(s) with no record, expected 1"
            }
            # And the index itself is not a page of any topic, under any spelling.
            Assert ($null -eq (Get-TopicRow $groupedReport '_master-index.md')) 'the master index was grouped as a topic of its own'
            Assert ($null -eq (Get-TopicRow $groupedReport 'notebook')) 'the rows were keyed off the wrong path segment'
            Assert ($null -eq (Get-TopicRow $groupedReport 'delta')) 'a topic named only by the master index text became a row'
            Assert ([string]$strayHash -cne '') 'the fixture stray page produced no hash'
        }

        # (c) Neither source. Still a report, and both flags say so.
        $empty = Join-Path $fixture 'empty'
        New-Item -ItemType Directory -Path $empty -Force | Out-Null
        $bare = Get-SpawnedReport $empty
        Assert ($null -ne $bare) 'the inventory threw on a workspace with neither source'
        if ($null -ne $bare) {
            Assert (-not $bare.notebook_present) 'an empty workspace reported a Notebook'
            Assert (-not $bare.holding_present) 'an empty workspace reported capture Books'
            Assert ([int]$bare.page_count -eq 0 -and [int]$bare.holding_note_count -eq 0) 'an empty workspace reported material'
            Assert ([string]$bare.operation -ceq 'Library Triage Inventory') "an empty workspace reported operation '$($bare.operation)'"
        }
    }
    finally {
        if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
    }

    if ($script:failures.Count) {
        [Console]::Error.WriteLine("triage-inventory selftest: $($script:failures.Count) of $($script:checks) check(s) FAILED")
        foreach ($failure in $script:failures) { [Console]::Error.WriteLine("  - $failure") }
        exit 1
    }
    Write-Output "triage-inventory selftest: $($script:checks) checks passed"
    exit 0
}
if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$notebookRoot = Join-Path $workspace 'notebook'
$journalRoot = Join-Path $workspace 'internal/publication-journals'

# NEITHER SOURCE HAS TO EXIST, and that is why this is a flag rather than the throw this helper
# shipped with. `notebook/` is gitignored and a Reset deletes it, so the state immediately after a
# Reset -- a populated Holding Shelf and no Notebook at all -- used to make the inventory raise, and
# the inventory is what the Reset preflight calls to build its advisory. Yesterday's exception is
# today's normal case. A workspace with neither source still gets a report, saying so in both flags.
$notebookPresent = [bool](Test-Path -LiteralPath $notebookRoot -PathType Container)

$coverage = @{}
$journalErrors = [Collections.Generic.List[string]]::new()
if (Test-Path -LiteralPath $journalRoot -PathType Container) {
    foreach ($journal in @(Get-ChildItem -LiteralPath $journalRoot -File -Filter '*.json')) {
        try {
            foreach ($entry in @(Get-JournalEntries -JournalPath $journal.FullName)) {
                if (-not $coverage.ContainsKey($entry.source)) { $null = $coverage.Add($entry.source, @()) }
                [void]($coverage[$entry.source] = @($coverage[$entry.source]) + $entry)
            }
        }
        catch { [void]$journalErrors.Add("$($journal.Name): $($_.Exception.Message)") }
    }
}

$trackedPaths = Get-TrackedPathSet $workspace

# Shared by both sources rather than written twice. The two halves ask the identical question of the
# identical journals -- does a publication journal record THIS content reaching a Book or Project --
# and a second copy of this logic is a second thing to keep in step with the journal format.
function Resolve-CopyRecords([string]$Relative, [string]$Sha256) {
    $matched = @($coverage[$Relative])
    $current = @($matched | Where-Object { $null -ne $_ -and (Get-PropertyValue $_ 'quality') -eq 'complete' -and (Get-PropertyValue $_ 'source_sha256') -eq $Sha256 })
    $drifted = @($matched | Where-Object { $null -ne $_ -and (Get-PropertyValue $_ 'quality') -eq 'complete' -and (Get-PropertyValue $_ 'source_sha256') -and (Get-PropertyValue $_ 'source_sha256') -ne $Sha256 })
    $legacy = @($matched | Where-Object { $null -ne $_ -and (Get-PropertyValue $_ 'quality') -eq 'legacy-complete' })
    [pscustomobject]@{
        copy_status    = if ($current.Count) { 'known-current-copy' } elseif ($drifted.Count) { 'known-copy-drifted' } elseif ($legacy.Count) { 'legacy-copy-record' } else { 'no-known-copy-record' }
        known_books    = @($matched | Where-Object { $null -ne $_ -and (Get-PropertyValue $_ 'destination_type') -eq 'book' } | ForEach-Object { Get-PropertyValue $_ 'destination_slug' } | Where-Object { $_ } | Sort-Object -Unique)
        known_projects = @($matched | Where-Object { $null -ne $_ -and (Get-PropertyValue $_ 'destination_type') -eq 'project' } | ForEach-Object { Get-PropertyValue $_ 'destination_slug' } | Where-Object { $_ } | Sort-Object -Unique)
        journals       = @($matched | Where-Object { $null -ne $_ } | ForEach-Object { Split-Path -Leaf (Get-PropertyValue $_ 'journal') } | Sort-Object -Unique)
    }
}

# --- Source one: the Notebook, whose topics a Reset quarantines -----------------------------------
$pages = @(
    if ($notebookPresent) {
        Get-ChildItem -LiteralPath $notebookRoot -Recurse -File -Filter '*.md' | Sort-Object FullName | ForEach-Object {
            $relative = 'notebook/' + $_.FullName.Substring($notebookRoot.Length).TrimStart('\', '/').Replace('\', '/')
            $hash = Get-Utf8Hash $_.FullName
            $references = @(Get-PageReferences -Workspace $workspace -FullPath $_.FullName -TrackedPaths $trackedPaths)
            $records = Resolve-CopyRecords $relative $hash
            [pscustomobject]@{
                path = $relative
                sha256 = $hash
                copy_status = $records.copy_status
                known_books = @($records.known_books)
                known_projects = @($records.known_projects)
                journals = @($records.journals)
                references = $references
                tracked_reference_count = @($references | Where-Object { [string]$_.durability -ceq 'tracked' }).Count
            }
        }
    }
)

# --- The per-topic roll-up (ADR-0022) -------------------------------------------------------------
#
# ONE GROUPING OVER THE PAGES ABOVE, NOT A SECOND READER OF THE JOURNALS. The evidence is already
# computed per page and hash-bound by Resolve-CopyRecords; what was missing was the grain the reader
# decides at. A reset takes TOPICS, so a whole-Notebook figure that is 94% reassuring says nothing
# about the one topic that is 0%.
#
# BOOKS AND PROJECT HUBS STAY APART. Both live in the shared collection and a reset reaches neither,
# so the safety verdict is the UNION of the two -- but what the reader does next differs by class
# (`-Kind Book` against `-Kind Project`, then read_open_book_page against read_open_project_page), so
# a merged count names no route. Measured 2026-09-15: a Books-only reading called all 11 pages of
# `2nd-b-vault-dev` Notebook-only while 10 of them were hash-bound copies in a Project Hub.
#
# ONLY `known-current-copy` IS PROOF, and `pages_without_current_copy` is what carries that ruling
# into the data. A `legacy-copy-record` is synthesised from a journal's attempted_records with an
# EMPTY source hash -- it names a path and binds no content -- and `known-copy-drifted` binds a
# different version of the page. Leaving the reader to add three of four counts would leave the rule
# in prose, where `legacy_copy_record_count: 3` reads as three safe pages.
#
# `known_books` AND `known_projects` ARE WHERE TO LOOK, NOT WHAT IS PROVEN. They carry every
# destination any record for this topic named, drifted and legacy records included, exactly as the
# per-page fields of the same name do. The counts carry the proof; these carry the route.
#
# THE MASTER INDEX IS EXCLUDED AND EVERY OTHER LOOSE FILE IS NOT. `_master-index.md` is rendered from
# the topics rather than written, and a reset rebuilds it instead of moving it -- Get-ResetLooseFiles
# excludes it by the same exact name. Any OTHER file directly under notebook/ belongs to no topic and
# IS quarantined, so it is grouped under an empty topic rather than dropped: a filter that removes an
# item from the numerator and the denominator alike makes a partial answer read as a complete one.
# The rows therefore account for every page but that one index, which the self-test asserts from
# outside the grouping rather than from its own arithmetic.
$topics = @(
    @(@($pages | Where-Object { [string]$_.path -cne 'notebook/_master-index.md' }) | ForEach-Object {
        $segments = ([string]$_.path) -split '/'
        # notebook/<topic>/... has at least three segments; notebook/<file>.md has two and no topic.
        [pscustomobject]@{ topic = if ($segments.Count -gt 2) { [string]$segments[1] } else { '' }; page = $_ }
    }) |
        Group-Object -Property topic |
        Sort-Object -Property Name -CaseSensitive |
        ForEach-Object {
            $topicPages = @(@($_.Group) | ForEach-Object { $_.page })
            [pscustomobject]@{
                topic = [string]$_.Name
                page_count = $topicPages.Count
                # The same four names, and the same four meanings, as the whole-Notebook counters
                # below. A counter that quietly means something else at a second scope is worse than
                # one that does not exist.
                known_current_copy_count = @($topicPages | Where-Object { $_.copy_status -eq 'known-current-copy' }).Count
                known_copy_drifted_count = @($topicPages | Where-Object { $_.copy_status -eq 'known-copy-drifted' }).Count
                legacy_copy_record_count = @($topicPages | Where-Object { $_.copy_status -eq 'legacy-copy-record' }).Count
                no_known_copy_record_count = @($topicPages | Where-Object { $_.copy_status -eq 'no-known-copy-record' }).Count
                pages_without_current_copy = @($topicPages | Where-Object { $_.copy_status -ne 'known-current-copy' }).Count
                known_books = @(@($topicPages | ForEach-Object { $_.known_books }) | Where-Object { $_ } | Sort-Object -Unique)
                known_projects = @(@($topicPages | ForEach-Object { $_.known_projects }) | Where-Object { $_ } | Sort-Object -Unique)
            }
        }
)

# --- Source two: the capture Books, which a Reset does NOT touch ----------------------------------
#
# Reported SEPARATELY from the Notebook counters above, never folded into them. Those counters are
# what Reset-LocalNotebook.ps1 renders as its Library-copy advisory, and they answer "what is about
# to be deleted". A Holding Shelf note is the opposite: it is what SURVIVES. Adding one to page_count
# would make the reset preflight overstate the loss, which is the direction that matters.
#
# Note bodies are never read into the report -- only frontmatter, title, and a hash -- matching the
# rule Get-DeskOverview follows: counts and titles are orientation, content needs the Book open.
$captureBooks = @(Get-CaptureBooks -Workspace $workspace)
$holdingNotes = @(
    foreach ($book in $captureBooks) {
        foreach ($note in @(Get-ShelfNotes -Book $book)) {
            $relative = "$($book.book_root)/wiki/$($note.page).md"
            $hash = Get-Utf8Hash $note.full_path
            $records = Resolve-CopyRecords $relative $hash
            [pscustomobject]@{
                path = $relative
                book = $book.slug
                page = $note.page
                title = $note.title
                review = $note.review
                captured = $note.captured
                sha256 = $hash
                copy_status = $records.copy_status
                known_books = @($records.known_books)
                known_projects = @($records.known_projects)
                journals = @($records.journals)
            }
        }
    }
)
$holdingPending = @($holdingNotes | Where-Object { [string]$_.review -cne 'done' })
# 'unknown' is what Get-ShelfNotes reports for a note carrying no captured field, and it must not
# sort as though it were the oldest date in the Book.
$holdingDates = @($holdingPending | ForEach-Object { [string]$_.captured } | Where-Object { $_ -cne 'unknown' } | Sort-Object)

[pscustomobject]@{
    operation = 'Library Triage Inventory'
    workspace = $workspace
    scope = 'Local Notebook, local capture Books, and internal publication journals only. No Basic Memory or NAS call was made.'
    reference_rule = 'A reference is a POINTER, not proof of coverage: `tracked` means git holds that file, never that it covers this page. Open it before treating a page as already safe.'
    references_resolvable = ($null -ne $trackedPaths)
    # The Notebook half. These five names and their meanings are unchanged from the handoff inventory
    # this replaced, because Reset-LocalNotebook.ps1 renders them as its Library-copy advisory and a
    # counter that quietly changed what it counts is worse than one that disappeared.
    notebook_present = $notebookPresent
    page_count = $pages.Count
    known_current_copy_count = @($pages | Where-Object { $_.copy_status -eq 'known-current-copy' }).Count
    known_copy_drifted_count = @($pages | Where-Object { $_.copy_status -eq 'known-copy-drifted' }).Count
    legacy_copy_record_count = @($pages | Where-Object { $_.copy_status -eq 'legacy-copy-record' }).Count
    no_known_copy_record_count = @($pages | Where-Object { $_.copy_status -eq 'no-known-copy-record' }).Count
    topics = @($topics)
    # The capture-Book half, under its own prefix for the same reason.
    holding_present = ($captureBooks.Count -gt 0)
    holding_books = @($captureBooks | ForEach-Object { $_.slug })
    holding_note_count = $holdingNotes.Count
    holding_pending_count = $holdingPending.Count
    holding_oldest_pending = if ($holdingDates.Count) { $holdingDates[0] } else { '' }
    holding_no_known_copy_record_count = @($holdingNotes | Where-Object { $_.copy_status -eq 'no-known-copy-record' }).Count
    unreadable_journals = @($journalErrors)
    pages = $pages
    holding_notes = $holdingNotes
    shared_library_write = $false
}
