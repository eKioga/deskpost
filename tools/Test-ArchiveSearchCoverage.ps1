<#
The suite for ADR-0012: an archived Book is COVERED BY SEARCH AND LABELLED.

Archiving a Shelf Book used to RETIRE its Discovery manifest, which made archiving the act that
removed a Book from search -- and left Discovery still saying "all N Books searched" about an N that
had quietly shrunk with it. That is the failure this suite exists to hold shut, and it is a shape no
unit test can see: the archiver, the manifest store, the Book-root schema and Discovery each behaved
correctly on their own.

  - archiving MOVES the manifest from `shelf` to `shelf-archive`, and the active store is gone;
  - Discovery finds the archived Book afterwards, labels the hit `archive`, and names its root as
    shelf/_archive/<slug> so a reader is told where it actually is;
  - the coverage count INCLUDES the archived Book, so the answer cannot read complete while
    excluding it -- this is the assertion the original defect would fail;
  - restoring moves it back and leaves NO archive store behind, so Discovery never offers to open an
    archived Book whose pages have returned to the active Shelf;
  - the two stores never collide: an active and an archived Book of the SAME SLUG keep separate
    manifests, and each answers for its own pages;
  - and the one surface that does NOT cover the archives says so. `Get-BookCurrency.ps1 -All`
    deliberately asks only the active collections, so its Book total is smaller than Discovery's --
    which is fine, and was silent, which was not.

That last case is the one a fixture is most likely to pass for the wrong reason, so it is built
deliberately: the same trap `Set-VirtualDesk`'s archived-open defect fell into, where a fixture held
an active Book of the same name and a wrongly composed path found a real directory.

Everything runs against a disposable fixture workspace under the system temp directory. The reader's
Shelf, Notebook, and Virtual Desk are never touched. Exit code 0 means every case passed.

    tools/Test-ArchiveSearchCoverage.ps1
#>
[CmdletBinding()]
param([switch]$KeepFixture)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'BookManifestTransaction.ps1')
. (Join-Path $PSScriptRoot 'BookDiscovery.ps1')
# shelf/_catalog.md is rendered from the tracked header plus one entry file per Book, so a fixture
# needs both before any Shelf writer runs in it, and a Book arrives or leaves by its entry file
# rather than by an append to the catalog.
. (Join-Path $PSScriptRoot 'ShelfCatalog.ps1')
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
# Fixtures work at a seat named 'fixture'. Set in this process so CHILD helper processes
# inherit it: they default -Seat to LIBRARY_SEAT, and there is no default seat to fall back on.
$env:LIBRARY_SEAT = 'fixture'

$archiver = Join-Path $PSScriptRoot 'Archive-ShelfBook.ps1'
$backfill = Join-Path $PSScriptRoot 'Update-BookManifests.ps1'

$script:passed = 0
$script:failed = @()

function Test-Case([string]$Name, [scriptblock]$Body) {
    try {
        & $Body
        $script:passed++
        Write-Host "  pass  $Name"
    }
    catch {
        $script:failed += "$Name -- $($_.Exception.Message)"
        Write-Host "  FAIL  $Name -- $($_.Exception.Message)"
    }
}

function Assert-True([bool]$Condition, [string]$What) {
    if (-not $Condition) { throw $What }
}

function Assert-Equal([string]$Expected, [string]$Actual, [string]$What) {
    if ($Expected -cne $Actual) { throw "$What was '$Actual', expected '$Expected'" }
}

# Both helpers are run as processes rather than dot-sourced: each ends with `exit`, and an in-process
# call would end this suite instead of returning to it.
function Invoke-Helper([string]$Script, [string[]]$ArgumentList) {
    $lines = @()
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $lines = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Script @ArgumentList 2>&1) }
    finally { $ErrorActionPreference = $old }
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = $lines }
}

function Get-ResultJson($Invocation) {
    $jsonLines = @($Invocation.Lines | Where-Object { $_ -and $_.ToString().Trim().StartsWith('{') })
    if (-not $jsonLines.Count) { throw "the helper produced no JSON result; output was: $(($Invocation.Lines -join ' | '))" }
    ($jsonLines[-1] | ConvertFrom-Json)
}

# Preflight, read the plan_id it issued, then run under that exact approval -- the helper's own
# contract, exercised rather than bypassed.
function Invoke-Archiver([string]$Action, [string]$Slug) {
    $pre = Invoke-Helper $archiver @('-Action', $Action, '-BookSlug', $Slug, '-Preflight', '-Json', '-WorkspacePath', $fixture)
    Assert-True ($pre.ExitCode -eq 0) "the $Action preflight failed: $($pre.Lines -join ' | ')"
    $plan = Get-ResultJson $pre
    $run = Invoke-Helper $archiver @('-Action', $Action, '-BookSlug', $Slug, '-Json', '-WorkspacePath', $fixture,
        '-UserConfirmed', '-ApprovedPlanId', ([string]$plan.plan_id))
    Assert-True ($run.ExitCode -eq 0) "the $Action run failed: $($run.Lines -join ' | ')"
    [pscustomobject]@{ Preflight = $plan; Result = (Get-ResultJson $run) }
}

function Invoke-Backfill([string[]]$ExtraArgs) {
    $preArgs = @('-Preflight', '-Json', '-WorkspacePath', $fixture) + $ExtraArgs
    $pre = Invoke-Helper $backfill $preArgs
    Assert-True ($pre.ExitCode -eq 0) "the backfill preflight failed: $($pre.Lines -join ' | ')"
    $plan = Get-ResultJson $pre
    $runArgs = @('-WorkspacePath', $fixture, '-Json', '-UserConfirmed', '-ApprovedPlanId', ([string]$plan.plan_id)) + $ExtraArgs
    $run = Invoke-Helper $backfill $runArgs
    Assert-True ($run.ExitCode -eq 0) "the backfill run failed: $($run.Lines -join ' | ')"
    Get-ResultJson $run
}

function Get-Hits($Result, [string]$BookRoot) {
    @(@($Result.results) | Where-Object { $_.book_root -ceq $BookRoot })
}

# --- fixture ----------------------------------------------------------------------------------

$fixture = Join-Path ([IO.Path]::GetTempPath()) "library-archive-search-$([guid]::NewGuid().ToString('n').Substring(0, 8))"
$utf8 = [Text.UTF8Encoding]::new($false)

function Write-Fixture([string]$Relative, [string]$Text) {
    $path = Join-Path $fixture $Relative
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($path, $Text, $utf8)
}

try {

New-Item -ItemType Directory -Path (Join-Path $fixture '.claude') -Force | Out-Null
New-Item -ItemType Directory -Path (Get-DeskStateDirectory -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture') -Force | Out-Null
Write-Fixture (Get-DeskFileRelativePath -Seat 'fixture' -Kind 'books') ''
Write-Fixture (Get-DeskFileRelativePath -Seat 'fixture' -Kind 'projects') ''
Write-Fixture '.claude/.library-project' '00000000-0000-0000-0000-000000000000'

Write-Fixture 'shelf/_catalog.md' @'
# Local Shelf

## Retiring Book
- **Summary:** a fixture Book about pelagic navigation, destined for the archive
- **Topics:** retiring, pelagic
- **Path:** shelf/retiring

## Staying Book
- **Summary:** a fixture Book that stays on the active Shelf
- **Topics:** staying, pelagic
- **Path:** shelf/staying
'@

Write-Fixture 'shelf/retiring/wiki/_book.md' "# Retiring Book`n`n- **Type:** fixture`n"
Write-Fixture 'shelf/retiring/wiki/_index.md' "# Retiring Book - Reader Map`n`n- [[_book|Book metadata]]`n- [[topic/pelagic]]`n"
Write-Fixture 'shelf/retiring/wiki/topic/pelagic.md' "# Pelagic Navigation`n`nBody text about pelagic navigation.`n`n## Wayfinding`n"
Write-Fixture 'shelf/staying/wiki/_book.md' "# Staying Book`n`n- **Type:** fixture`n"
Write-Fixture 'shelf/staying/wiki/topic/pelagic.md' "# Pelagic Notes`n`nMore about pelagic navigation.`n"

# The tracked header, and one entry file per Book, split out of the catalog written above by the
# same migration a real Shelf runs once.
Initialize-ShelfCatalogForFixture -FixtureRoot $fixture

# Both Books get a manifest before anything is archived, which is the state the defect needed: a
# Book that WAS in Discovery and silently left it.
Invoke-Backfill @() | Out-Null

Test-Case 'both Books are in Discovery before the archive' {
    $result = Find-BookPages -Workspace $fixture -Query 'pelagic' -DeskStateDirectory (Join-Path $fixture '.claude')
    Assert-Equal '2' ([string]$result.shelf_books_searched) 'the Shelf Books searched before archiving'
    Assert-True (@(Get-Hits $result 'shelf/retiring').Count -gt 0) 'the Book that is about to be archived was not found while active'
}

Test-Case 'archiving MOVES the manifest into the archive store rather than retiring it' {
    $archived = Invoke-Archiver 'Archive' 'retiring'
    Assert-True ([string]$archived.Preflight.manifest_action -clike '*archive store*') 'the preflight still promises to retire the manifest'
    Assert-Equal 'archived' ([string]$archived.Result.status) 'the archive did not report success'

    Assert-Equal 'missing' ((Get-StoredBookManifest -Workspace $fixture -Slug 'retiring' -Collection 'shelf').status) 'the ACTIVE store survived the archive'
    $moved = Get-StoredBookManifest -Workspace $fixture -Slug 'retiring' -Collection 'shelf-archive'
    Assert-Equal 'ok' ([string]$moved.status) 'the archive store does not hold a committed manifest'
    # Not merely present: it must describe the pages where they NOW are. A manifest carried across
    # unchanged would describe a Book at a path that no longer exists.
    $fresh = New-BookManifestForShelfBook -Book (Get-ArchivedShelfBook -Workspace $fixture -Slug 'retiring')
    Assert-Equal $fresh.source_digest ([string]$moved.source_digest) 'the archived manifest does not describe the Book as it now stands'
}

Test-Case 'Discovery covers the archived Book, labels it, and names its archive root' {
    $result = Find-BookPages -Workspace $fixture -Query 'pelagic' -DeskStateDirectory (Join-Path $fixture '.claude')
    $hits = Get-Hits $result 'shelf/_archive/retiring'
    Assert-True ($hits.Count -gt 0) 'the archived Book contributed no hit, so archiving still removes a Book from search'
    Assert-Equal 'archive' ([string]$hits[0].book_shelf) 'the archived hit is not labelled archived'
    Assert-Equal 'shelf' ([string]$hits[0].collection) 'the archived hit lost its collection'
    Assert-True ((Format-DiscoveryResult $result) -clike '*ARCHIVED*') 'the rendered answer does not label the archived Book'
}

Test-Case 'the coverage count includes the archived Book, so no answer reads complete while excluding it' {
    $result = Find-BookPages -Workspace $fixture -Query 'pelagic' -DeskStateDirectory (Join-Path $fixture '.claude')
    # THE ASSERTION THE ORIGINAL DEFECT FAILS. Before this item the totals counted only the active
    # Shelf, so archiving a Book took it out of the numerator AND the denominator at once and the
    # answer went on reading "all Books searched".
    Assert-Equal '1' ([string]$result.shelf_archive_books_total) 'the archived Book is not counted in the total'
    Assert-Equal '1' ([string]$result.shelf_archive_books_searched) 'the archived Book is not counted as searched'
    Assert-Equal '2' ([string]$result.books_searched) 'the grand total dropped the archived Book'
    Assert-True ([string]$result.archive_note -clike '*Shelf archive: all 1*') "the archive coverage sentence is wrong: $($result.archive_note)"
}

Test-Case 'the currency tier omits the archive ON PURPOSE, and its answer says so' {
    # THE OTHER HALF OF A COVERAGE CLAIM: what a surface does NOT cover. Get-BookCurrency.ps1 -All
    # asks only the active collections, because currency measures whether a Book's cited upstream has
    # moved and a retired Book's answer is not actionable. That is a decision -- but the answer used
    # to state a Book total and a scope of "local Shelf and shared collection" and say nothing about
    # the archives, so it read complete while omitting them. The divergence from Discovery's Book
    # list was one Book from 2026-09-06 and fourteen from 2026-09-08, and the file's own comment
    # claimed the two lists could not disagree.
    #
    # The assertion is the PAIR OF TOTALS from one fixture, so the wrong answer is a wrong value: if
    # currency ever silently swept an archive store its total would be 2, and if it stopped naming
    # the omission the second assertion fires. -ShelfOnly keeps it offline; the shared half is
    # already reported out of scope by the same mechanism when the Catalog cannot be read.
    $currency = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Get-BookCurrency.ps1') `
        -All -ShelfOnly -Json -WorkspacePath $fixture 2>&1
    $jsonLines = @($currency | Where-Object { $_ -and $_.ToString().Trim().StartsWith('{') })
    Assert-True ($jsonLines.Count -gt 0) "the currency tier produced no JSON: $($currency -join ' | ')"
    $answer = $jsonLines[-1] | ConvertFrom-Json

    $discovery = Find-BookPages -Workspace $fixture -Query 'pelagic' -DeskStateDirectory (Join-Path $fixture '.claude')
    Assert-Equal '2' ([string]$discovery.books_total) 'Discovery no longer counts the archived Book, so this case cannot show the divergence'
    Assert-Equal '1' ([string]$answer.books_total) "the currency tier counted $($answer.books_total) Book(s); it covers the ACTIVE Shelf only, so an archive store reaching its total is the defect"
    Assert-True ([string]$answer.archive_note -clike '*OUT OF SCOPE*') "the currency answer does not say the archives are out of scope, so its smaller total reads as complete: $($answer.archive_note)"
    # Named from the schema, so a fifth collection reaches the sentence by being added there.
    foreach ($collection in @(Get-BookManifestCollections | Where-Object { (Split-BookManifestCollection $_).shelf -ceq 'archive' })) {
        Assert-True ([string]$answer.archive_note -clike "*$collection*") "the currency answer does not name the '$collection' collection it omits: $($answer.archive_note)"
    }
    Assert-True ([string]$answer.scope -clike '*ACTIVE*') "the currency scope does not say it is the active collections only: $($answer.scope)"
}

Test-Case 'an active and an archived Book of the same slug keep separate manifests' {
    # The trap, built on purpose: a second Book called `retiring` on the ACTIVE Shelf, beside the
    # archived one. A composed path or a slug-only store key finds a real directory and a real
    # manifest here, and passes for the wrong reason.
    Write-Fixture 'shelf/retiring/wiki/_book.md' "# Retiring Book (new)`n`n- **Type:** fixture`n"
    Write-Fixture 'shelf/retiring/wiki/topic/benthic.md' "# Benthic Notes`n`nA different Book entirely, about benthic pelagic contrast.`n"
    # Listed the way a writer lists a Book -- its own entry file, then the render. Appending to the
    # catalog would be drift the next writer silently renders away, and the archived twin's entry
    # travelled into shelf/_archive/retiring/ with its directory, so this slug's entry file is free.
    Set-ShelfCatalogEntryForFixture -FixtureRoot $fixture -Slug 'retiring' -Title 'Retiring Book (new)' -Line @(
        '- **Summary:** a NEW Book that reuses the archived slug',
        '- **Topics:** benthic, pelagic'
    )
    Invoke-Backfill @() | Out-Null

    $active = Get-StoredBookManifest -Workspace $fixture -Slug 'retiring' -Collection 'shelf'
    $archived = Get-StoredBookManifest -Workspace $fixture -Slug 'retiring' -Collection 'shelf-archive'
    Assert-Equal 'ok' ([string]$active.status) 'the new active Book has no manifest'
    Assert-Equal 'ok' ([string]$archived.status) 'the archived Book of the same slug lost its manifest'
    Assert-True ($active.source_digest -cne $archived.source_digest) 'the two Books of one slug share a manifest, so one is answering for the other'

    $result = Find-BookPages -Workspace $fixture -Query 'pelagic' -DeskStateDirectory (Join-Path $fixture '.claude')
    Assert-True (@(Get-Hits $result 'shelf/retiring').Count -gt 0) 'the active Book of the shared slug was not found'
    Assert-True (@(Get-Hits $result 'shelf/_archive/retiring').Count -gt 0) 'the archived Book of the shared slug was not found'
    # Each must answer for ITS OWN pages: benthic exists only in the active Book.
    $benthic = Find-BookPages -Workspace $fixture -Query 'benthic' -DeskStateDirectory (Join-Path $fixture '.claude')
    # @() around the call and the count taken from the variable: `[string](...).Count` binds the cast
    # to the call, not to the count -- family 2, in the suite that was written to catch family-2-shaped
    # damage elsewhere.
    $benthicArchived = @(Get-Hits $benthic 'shelf/_archive/retiring')
    Assert-Equal '0' ([string]$benthicArchived.Count) 'the archived Book answered with the active Book''s pages'
}

Test-Case 'restoring moves the manifest back and leaves no archive store behind' {
    # The active twin has to go first: Restore refuses a slug already on the active Shelf, which is
    # the correct refusal and is not what this case is testing.
    # The directory goes first and takes its entry file with it, exactly as a Shelf deletion does;
    # the render then reports the Shelf that is left. Trimming the catalog by substring is what the
    # per-Book entry files replaced.
    Remove-Item -LiteralPath (Join-Path $fixture 'shelf/retiring') -Recurse -Force
    Set-ShelfCatalogEntryForFixture -FixtureRoot $fixture -Slug 'retiring' -Remove
    Remove-BookManifestStore -Workspace $fixture -Slug 'retiring' -Collection 'shelf' | Out-Null

    $restored = Invoke-Archiver 'Restore' 'retiring'
    Assert-Equal 'restored' ([string]$restored.Result.status) 'the restore did not report success'
    Assert-Equal 'missing' ((Get-StoredBookManifest -Workspace $fixture -Slug 'retiring' -Collection 'shelf-archive').status) 'the archive store survived the restore, so Discovery still offers an archived Book that has moved'
    Assert-Equal 'ok' ((Get-StoredBookManifest -Workspace $fixture -Slug 'retiring' -Collection 'shelf').status) 'the restored Book has no active manifest'

    $result = Find-BookPages -Workspace $fixture -Query 'pelagic' -DeskStateDirectory (Join-Path $fixture '.claude')
    Assert-Equal '0' ([string]$result.shelf_archive_books_total) 'the archive still reports a Book after the restore'
    Assert-True (@(Get-Hits $result 'shelf/retiring').Count -gt 0) 'the restored Book is not back in Discovery under its active root'
}

}
finally {
    if (-not $KeepFixture -and (Test-Path -LiteralPath $fixture)) {
        Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
if ($script:failed.Count) {
    Write-Host "FAILED: $($script:failed.Count) of $($script:passed + $script:failed.Count)"
    foreach ($failure in $script:failed) { Write-Host "  - $failure" }
    exit 1
}
Write-Host "All $($script:passed) cases passed."
