<#
.SYNOPSIS
    The currency check's per-Book tier, on its SHELF path. Fixture-only and fully offline.

.DESCRIPTION
    `Get-BookCurrency.ps1 -Book <slug>` has two article sources and they are not equivalent. It
    reads `notebook/<slug>/` when that holds articles -- the refresh source, and the ordinary case
    while a Book is being worked on -- and OTHERWISE an OPEN Shelf Book's own pages under
    `shelf/<slug>/wiki`. Everything downstream of the source is shared between them.

    WHY THIS SUITE EXISTS. The `-Book` tier was proved live on 2026-09-08 against the shared
    collection in both directions -- `current` at the tip, `refresh due` from a moved tip, whose
    tree diff agreed exactly with `git diff --name-status` over the same range -- and the Shelf
    branch was verified once, by hand, against the `holding` Shelf Book. Nothing covered it: no
    fixture, and `library-helpers.boundary-suite` does not reach this helper. A fixture that
    exercised the pin comparison would prove the SHARED branch again; the pin comparison is not
    where the Shelf branch differs.

    WHAT IS ACTUALLY DIFFERENT ABOUT THE SHELF BRANCH, which is the whole scope here:

      - It is the ONLY place the `-Book` tier consults the Virtual Desk. A closed Shelf Book is
        unavailable, so its pages must not be read at all -- and that guard once failed open in the
        other direction: an earlier version looked for `internal/virtual-desk.json`, a file this
        workspace does not have, so an OPEN Shelf Book was refused as closed and the whole branch
        was unreachable. Both directions are asserted here.
      - The Desk it reads belongs to a SEAT (ADR-0015). One Book on one disk answers differently at
        two seats, and that is correct rather than incidental.
      - It excludes `_book.md` AND `_index.md`; the Notebook branch excludes only `_index.md`.
        Those two files are a published Book's front matter, not articles, and reading them as
        articles would put their content into a currency answer.
      - It reports `read_from` as `shelf/<slug>/wiki`, and the Notebook branch wins whenever both
        sources exist.

    EVERY WRONG ANSWER HERE IS A WRONG VALUE, NOT A MISSING FILE. A check whose failure mode is
    "the fixture is absent" is satisfied by code that reads nothing. So every Book that must be
    REFUSED carries a decoy article that would answer plausibly if the refusal were dropped, and
    the two excluded front-matter pages carry a MALFORMED `## Sources` block -- which outranks
    every other verdict in the roll-up, so reading them flips a `not anchored` Book to
    `cannot verify` rather than merely lengthening a list. The Book whose Notebook source must win
    disagrees with its own Shelf pages, so a swapped branch order reports the wrong verdict from
    the wrong origin.

    OFFLINE BY CONSTRUCTION, NOT BY MOCKING. No transport is shadowed and no `git` runs: the real
    script is driven as the real process, and every fixture article resolves before the network
    boundary. `refused source` is how the deepest case stops -- a well-formed pin on a host the
    allowlist does not carry -- which proves Shelf-read article text reaches the pin mapping and the
    host allowlist with the network down. What happens PAST that boundary is the shared half of the
    tier, proved live and covered by `book-currency.roll-up-is-worst-row`.

    Everything runs against a disposable fixture workspace under the system temp directory. The
    reader's Shelf, Notebook, and Virtual Desk are never touched. Exit code 0 means every case
    passed.

        tools/Test-BookCurrencyShelfPath.ps1
#>
[CmdletBinding()]
param([switch]$KeepFixture)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Initialize-FixtureDesk and New-BookRoot: a fixture that spells the Desk layout itself defends the
# stale shape rather than catching the drift, and `desk.seat-paths-resolve` refuses the literals.
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')

$script:currency = Join-Path $PSScriptRoot 'Get-BookCurrency.ps1'
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

function Assert-Contains([string]$Haystack, [string]$Needle, [string]$What) {
    if ([string]$Haystack -cnotmatch [regex]::Escape($Needle)) { throw "$What did not contain '$Needle'; it read '$Haystack'" }
}

# A refusal object carries no `read_from`, so asking for the property under strict mode throws.
function Test-HasProperty([object]$Object, [string]$Name) {
    @($Object.PSObject.Properties.Name) -ccontains $Name
}

# --- The fixture ----------------------------------------------------------------------------------

$utf8 = [Text.UTF8Encoding]::new($false)
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('library-currency-shelf-' + [Guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $fixture -Force | Out-Null

function Write-FixtureFile([string]$Relative, [string]$Text) {
    $full = Join-Path $fixture $Relative
    $directory = Split-Path -Parent $full
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    [IO.File]::WriteAllText($full, $Text, $utf8)
}

# Article bodies. Single-quoted here-strings, so a backtick is a backtick: the ## Sources grammar is
# made of them, and a double-quoted here-string would eat every one. The two placeholders stand in
# for a 64-hex digest and a 40-hex commit, neither of which is ever dereferenced here.
$digest = ('a' * 64)
$commit = ('b' * 40)

# A block with a cited file and no Upstream line: `not anchored`, and it never reaches the network.
$notAnchored = (@'
# Fixture article

Body text.

## Sources

- `raw/fixture/batch/thing.md` - SHA-256 `{DIGEST}`; provenance: `fixture batch`
'@).Replace('{DIGEST}', $digest)

# Two ## Sources headings: `cannot verify / malformed anchor`, which OUTRANKS every other verdict
# in the roll-up. This is the decoy planted in the two excluded front-matter pages, so reading one
# changes the Book's ANSWER rather than only its article count.
$malformed = (@'
# Front matter, not an article

## Sources

- `raw/fixture/batch/one.md` - SHA-256 `{DIGEST}`; provenance: `fixture batch`

## Sources

- `raw/fixture/batch/two.md` - SHA-256 `{DIGEST}`; provenance: `fixture batch`
'@).Replace('{DIGEST}', $digest)

# No block at all: `skipped`, an imported page rather than a compiled article.
$noBlock = @'
# Imported page

Prose only; this page was never compiled.
'@

# A well-formed pin whose host the allowlist does not carry. Resolves to `refused source` INSIDE
# Resolve-UpstreamTip, before any git process starts -- so this case proves Shelf-read text reaches
# the pin mapping and the host allowlist with the network down.
$anchoredOffHost = (@'
# Anchored article

Body text.

## Sources

- Upstream `https://fixture.example.com/owner/repo` ref `refs/heads/main` at `{COMMIT}`; repo root `raw/fixture/batch`; captured `2026-09-08`
- `raw/fixture/batch/docs/thing.md` - SHA-256 `{DIGEST}`; provenance: `fixture batch`
'@).Replace('{DIGEST}', $digest).Replace('{COMMIT}', $commit)

# shelf-closed: on disk, NOT on any Desk. The decoy would answer `not anchored` if read.
Write-FixtureFile 'shelf/shelf-closed/wiki/guide.md' $notAnchored

# shelf-open: open. Two real articles one directory down, and the two excluded names beside them
# carrying the malformed decoy.
Write-FixtureFile 'shelf/shelf-open/wiki/_book.md' $malformed
Write-FixtureFile 'shelf/shelf-open/wiki/_index.md' $malformed
Write-FixtureFile 'shelf/shelf-open/wiki/topic/page-a.md' $notAnchored
Write-FixtureFile 'shelf/shelf-open/wiki/topic/page-b.md' $noBlock

# shelf-bare: open, but its wiki holds ONLY the two excluded names. There is no article source, and
# saying so is a different refusal from saying the Book is closed.
Write-FixtureFile 'shelf/shelf-bare/wiki/_book.md' $malformed
Write-FixtureFile 'shelf/shelf-bare/wiki/_index.md' $malformed

# shelf-anchored: open, one article nested two directories deep, pinned off the allowlist.
Write-FixtureFile 'shelf/shelf-anchored/wiki/deep/nested/article.md' $anchoredOffHost

# both-sources: open, and its two sources DISAGREE. The Notebook must win.
Write-FixtureFile 'notebook/both-sources/article.md' $notAnchored
Write-FixtureFile 'shelf/both-sources/wiki/article.md' $malformed

# empty-notebook: a Notebook directory holding only an index is not an article source, so the Shelf
# branch must still be reached.
Write-FixtureFile 'notebook/empty-notebook/_index.md' "# Index`n"
Write-FixtureFile 'shelf/empty-notebook/wiki/page.md' $notAnchored

# wrong-location: the SHELF Book is on disk, and only the SHARED root of the same slug is open. A
# slug is not a Book (ADR-0012), so this must be refused -- and the decoy makes a slug-blind
# comparison answer with a verdict instead of an error.
Write-FixtureFile 'shelf/wrong-location/wiki/page.md' $notAnchored

$state = Join-Path $fixture '.claude'
$openBooks = @(
    (New-BookRoot -Location Shelf -Slug 'shelf-open')
    (New-BookRoot -Location Shelf -Slug 'shelf-bare')
    (New-BookRoot -Location Shelf -Slug 'shelf-anchored')
    (New-BookRoot -Location Shelf -Slug 'both-sources')
    (New-BookRoot -Location Shelf -Slug 'empty-notebook')
    (New-BookRoot -Location Shared -Slug 'wrong-location')
) -join "`n"
$null = Initialize-FixtureDesk -StateDirectory $state -Seat 'fixture' -Books "$openBooks`n"
# A second seat, with nothing open. Same Library, same disk, different answer.
$null = Initialize-FixtureDesk -StateDirectory $state -Seat 'other' -Books ''
# A third seat whose Desk FILE is then removed: a missing .open-books reads as every Book closed,
# which is the fail-safe direction and the one a decoy can hide.
$noDesk = Initialize-FixtureDesk -StateDirectory $state -Seat 'no-desk' -Books "$openBooks`n"
Remove-Item -LiteralPath (Get-DeskFileInDirectory -DeskDirectory $noDesk -Kind 'books') -Force

# --- Driving the real helper ----------------------------------------------------------------------
# The consumer, not a lookalike: the shipped script, as the process a reader runs, over -Json. A
# re-implementation of Get-ArticleSource here would agree with itself no matter what the file said.

function Invoke-Currency([string]$Slug, [string]$Seat) {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:currency, '-Book', $Slug, '-WorkspacePath', $fixture, '-Json')
    if ($Seat) { $arguments += @('-Seat', $Seat) }

    # A NATIVE COMMAND'S STDERR, REDIRECTED INSIDE POWERSHELL 5.1, IS NOT TEXT. Each line arrives as
    # an ErrorRecord, and under `Stop` the first one terminates THIS process carrying the CHILD's
    # message -- which reads exactly like the assertion failing for the reason it was testing. The
    # seatless case is the one that writes to stderr, and it cost a green-looking red until the two
    # streams were separated BY TYPE rather than by parsing.
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $captured = & powershell.exe @arguments 2>&1 }
    finally { $ErrorActionPreference = $saved }
    $code = $LASTEXITCODE

    $out = @($captured | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })
    $err = @($captured | Where-Object { $_ -is [Management.Automation.ErrorRecord] })
    $text = (($out | Out-String)).Trim()
    $parsed = $null
    if ($code -eq 0 -and $text) { $parsed = $text | ConvertFrom-Json }
    [pscustomobject]@{
        exit_code = $code
        text      = $text
        stderr    = ((($err | ForEach-Object { [string]$_ }) -join ' ')).Trim()
        result    = $parsed
    }
}

function Assert-Refused([object]$Run, [string]$Slug, [string]$Expected, [string]$What) {
    Assert-Equal '0' ([string]$Run.exit_code) "$What did not run"
    $result = $Run.result

    # SHAPE BEFORE VALUES, and that order was earned. A refusal carries `reason` and no `read_from`;
    # an answer carries `read_from` and no `reason`. Reading `.reason` first on an answer object
    # raises a strict-mode PropertyNotFound, which is a red for the right reason wearing a message
    # that names nothing -- and the FIRST fail is the one anybody reads. So the shape is asserted in
    # sentences that say what went wrong.
    Assert-True (-not (Test-HasProperty $result 'read_from')) `
        "$What answered from a source instead of refusing: it read '$(if (Test-HasProperty $result 'read_from') { [string]$result.read_from })' and reported '$([string]$result.status)'"
    Assert-True (Test-HasProperty $result 'reason') `
        "$What returned a full answer rather than a refusal, so it carries no reason; it reported '$([string]$result.status)' over $(@($result.articles).Count) article(s)"

    Assert-Equal 'cannot verify' ([string]$result.status) "$What status"
    Assert-Contains ([string]$result.reason) $Expected "$What reason"
    Assert-Equal '0' ([string]@($result.articles).Count) "$What read pages it must not have read"
}

function Get-ArticlePath([object]$Result) {
    @(@($Result.articles) | ForEach-Object { [string]$_.article } | Sort-Object)
}

Write-Host "Currency -Book, Shelf path: $fixture"
Write-Host ''

try {

# --- The Desk guard, both directions --------------------------------------------------------------

Test-Case 'a closed Shelf Book is refused and its pages are not read' {
    $run = Invoke-Currency 'shelf-closed' 'fixture'
    Assert-Refused $run 'shelf-closed' "the Shelf Book 'shelf-closed' is closed" 'a closed Shelf Book'
    # The decoy, named so the failure says what happened rather than only that a value differed.
    Assert-True ([string]$run.result.status -cne 'not anchored') `
        'a closed Shelf Book answered from its pages: the decoy article reported not anchored'
}

Test-Case 'an open Shelf Book is read from its wiki, recursively' {
    $run = Invoke-Currency 'shelf-open' 'fixture'
    Assert-Equal '0' ([string]$run.exit_code) 'an open Shelf Book did not run'
    $result = $run.result
    Assert-Equal 'shelf/shelf-open/wiki' ([string]$result.read_from) 'the origin of an open Shelf Book'
    Assert-Equal 'not anchored' ([string]$result.status) 'the status of an open Shelf Book'
    # One directory down, so a non-recursive read finds nothing at all.
    Assert-Equal 'shelf/shelf-open/wiki/topic/page-a.md, shelf/shelf-open/wiki/topic/page-b.md' `
        ((Get-ArticlePath $result) -join ', ') 'the articles read from an open Shelf Book'
    Assert-Equal '1' ([string]$result.counts.'not anchored') 'the not-anchored count'
    Assert-Equal '1' ([string]$result.counts.skipped) 'the skipped count'
}

Test-Case 'the seat that asked is the seat whose Desk is read' {
    # Same Book, same disk, same moment. Only the seat differs (ADR-0015).
    $run = Invoke-Currency 'shelf-open' 'other'
    Assert-Refused $run 'shelf-open' "the Shelf Book 'shelf-open' is closed" 'a Book open at another seat'
}

Test-Case 'a missing Desk file reads as every Book closed' {
    $run = Invoke-Currency 'shelf-open' 'no-desk'
    Assert-Refused $run 'shelf-open' "the Shelf Book 'shelf-open' is closed" 'a seat with no Desk file'
}

Test-Case 'a shared root of the same slug does not open the Shelf Book' {
    # books/wrong-location is open; shelf/wrong-location is not. A comparison made on the slug
    # rather than the Book ROOT would read Shelf pages on a shared Book's authority.
    $run = Invoke-Currency 'wrong-location' 'fixture'
    Assert-Refused $run 'wrong-location' "the Shelf Book 'wrong-location' is closed" 'a Book open only as a shared Book'
}

Test-Case 'a seatless run is refused before any page is read' {
    # The workspace is the same one every case above reads; only the seat is absent. There is no
    # default seat, so this is a refusal rather than a fallback.
    $saved = [string]$env:LIBRARY_SEAT
    try {
        $env:LIBRARY_SEAT = ''
        $run = Invoke-Currency 'shelf-open' ''
        Assert-True ($run.exit_code -ne 0) "a seatless run exited $($run.exit_code), so it was not refused"
        # No result at all, not a result saying it could not tell. A currency answer on stdout here
        # would be an answer given without knowing whose Desk it read.
        Assert-Equal '' ([string]$run.text) 'a seatless run wrote a result to stdout'
        Assert-Contains ([string]$run.stderr) 'No seat is named' 'the seatless refusal'
        Assert-Contains ([string]$run.stderr) 'no default seat' 'the seatless refusal'
    }
    finally { $env:LIBRARY_SEAT = $saved }
}

# --- What counts as an article on the Shelf -------------------------------------------------------

Test-Case 'the _book and _index pages are excluded from the Shelf read' {
    $run = Invoke-Currency 'shelf-open' 'fixture'
    $result = $run.result
    $frontMatter = @((Get-ArticlePath $result) | Where-Object { $_ -cmatch '/_(?:book|index)\.md$' })
    Assert-Equal '0' ([string]$frontMatter.Count) "a Book's front matter was read as an article: $($frontMatter -join ', ')"
    # The decoy's own verdict. Both front-matter pages carry a malformed anchor, which outranks
    # every other verdict -- so reading either one moves the Book's ANSWER, not just this list.
    Assert-Equal '0' ([string]$result.counts.'cannot verify') 'the malformed front-matter decoy reached the verdict counts'
    Assert-Equal '2' ([string]@($result.articles).Count) 'the article count'
}

Test-Case 'a wiki holding only front matter has no article source' {
    # Open, and still refused -- for a DIFFERENT reason, which is the part worth asserting. A
    # refusal that said "closed" here would send the reader to the Desk instead of to a Refresh.
    $run = Invoke-Currency 'shelf-bare' 'fixture'
    Assert-Refused $run 'shelf-bare' "no local source for 'shelf-bare'" 'an open Shelf Book with no articles'
    Assert-Contains ([string]$run.result.reason) 'tools/Restore-BookSource.ps1' 'the no-source refusal'
    Assert-True ([string]$run.result.reason -cnotmatch 'is closed') `
        'an OPEN Shelf Book with no articles was reported closed'
}

# --- Which source wins ----------------------------------------------------------------------------

Test-Case 'the Notebook source wins when both sources exist' {
    # The Shelf copy of this Book carries the malformed decoy, so a swapped branch order reports
    # `cannot verify` from `shelf/both-sources/wiki` instead of `not anchored` from the Notebook.
    $run = Invoke-Currency 'both-sources' 'fixture'
    Assert-Equal '0' ([string]$run.exit_code) 'a Book with both sources did not run'
    $result = $run.result
    Assert-Equal 'notebook/both-sources' ([string]$result.read_from) 'the origin when both sources exist'
    Assert-Equal 'not anchored' ([string]$result.status) 'the status when both sources exist'
    Assert-Equal 'notebook/both-sources/article.md' ((Get-ArticlePath $result) -join ', ') 'the articles read'
}

Test-Case 'a Notebook holding only an index falls through to the Shelf' {
    # `notebook/empty-notebook/` EXISTS; it just holds no article. Testing the directory rather than
    # its contents would refuse this Book while its pages sat open on the Desk.
    $run = Invoke-Currency 'empty-notebook' 'fixture'
    Assert-Equal '0' ([string]$run.exit_code) 'a Book with an empty Notebook did not run'
    $result = $run.result
    Assert-Equal 'shelf/empty-notebook/wiki' ([string]$result.read_from) 'the origin when the Notebook holds no article'
    Assert-Equal 'not anchored' ([string]$result.status) 'the status when the Notebook holds no article'
}

# --- The Shelf pages reach the rest of the tier ---------------------------------------------------

Test-Case 'Shelf pages reach the pin mapping and the host allowlist' {
    # The deepest offline case: a well-formed pin, mapped onto its cited path, refused at the
    # allowlist rather than at the grammar. Reaching `refused source` is the proof that Shelf-read
    # TEXT -- not just a file listing -- got as far as the network boundary.
    $run = Invoke-Currency 'shelf-anchored' 'fixture'
    Assert-Equal '0' ([string]$run.exit_code) 'an anchored Shelf Book did not run'
    $result = $run.result
    Assert-Equal 'shelf/shelf-anchored/wiki' ([string]$result.read_from) 'the origin of an anchored Shelf Book'
    Assert-Equal 'shelf/shelf-anchored/wiki/deep/nested/article.md' ((Get-ArticlePath $result) -join ', ') 'the nested article'
    $article = @($result.articles)[0]
    Assert-Equal 'cannot verify' ([string]$article.verdict) "the nested article's verdict"
    Assert-Contains ([string]$article.detail) 'refused source' 'the refusal of an off-allowlist host'
    Assert-Contains ([string]$article.detail) 'fixture.example.com' 'the refused host'
    Assert-Equal '1' ([string]$article.cited) 'the cited count of a mapped article'
    Assert-Equal 'cannot verify' ([string]$result.status) 'the roll-up of one unverifiable article'
}

Test-Case 'no Shelf answer is ever worded as verifying a Book' {
    foreach ($slug in @('shelf-open', 'shelf-anchored', 'empty-notebook')) {
        $result = (Invoke-Currency $slug 'fixture').result
        Assert-Contains ([string]$result.limits) 'It never proves an article reflects it' "$slug's limits"
        Assert-Equal 'False' ([string]$result.shared_library_write) "$slug claimed a shared write"
    }
}

}
catch {
    # A strict-mode error outside a case body would otherwise unwind past every remaining case and
    # let this suite exit green having run a fraction of itself.
    $script:failed += "the suite did not run to completion -- $($_.Exception.Message)"
    Write-Host "  FAIL  the suite did not run to completion -- $($_.Exception.Message)"
}
finally {
    if (-not $KeepFixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
if ($script:failed.Count) {
    Write-Host "FAILED: $($script:failed.Count) of $($script:passed + $script:failed.Count)"
    foreach ($failure in $script:failed) { Write-Host "  - $failure" }
    exit 1
}
Write-Host "All $($script:passed) cases passed."
