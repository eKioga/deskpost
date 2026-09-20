<#
Regression suite for capture Books: Add-ShelfNote.ps1, Invoke-LibraryTriage.ps1, ShelfNoteCommon.ps1,
and the capture-Book reporting in Get-DeskOverview.ps1.

THIS FILE OWNS THE SPLIT GATE. Writing INTO a capture Book is ungated, because capture that costs
anything stops happening; any action whose SOURCE is a capture Book needs that Book open, because
naming an individual note is a read of it. That asymmetry used to live in two helpers -- one that
never gated and one that always did -- and when they merged on 2026-08-28 it became a single rule
that one careless branch could flatten. So it is asserted here in BOTH directions, once per
holding-sourced kind, and both directions are mutation-proven: remove the gate and only the
`refused while the Book is closed` cases fail; add a gate to capture and only the ungated case does.

Everything runs against a disposable fixture workspace under the system temp directory. The reader's
Shelf, Notebook, and Virtual Desk are never touched. Exit code 0 means every case passed.

    tools/Test-ShelfNoteBoundary.ps1
#>
[CmdletBinding()]
param([switch]$KeepFixture)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# The Desk path is resolved, never composed -- see BookRootSchema's SEATS section.
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
# Fixtures work at a seat named 'fixture'. Set in this process so CHILD helper processes
# inherit it: they default -Seat to LIBRARY_SEAT, and there is no default seat to fall back on.
$env:LIBRARY_SEAT = 'fixture'


$tools = $PSScriptRoot
$addNote = Join-Path $tools 'Add-ShelfNote.ps1'
$triage = Join-Path $tools 'Invoke-LibraryTriage.ps1'
$deskOverview = Join-Path $tools 'Get-DeskOverview.ps1'

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

function Assert-Refused([scriptblock]$Action, [string]$ExpectedFragment) {
    try { & $Action | Out-Null }
    catch {
        if ($_.Exception.Message.Contains($ExpectedFragment)) { return }
        throw "refused for the wrong reason: $($_.Exception.Message)"
    }
    throw "the call was allowed; it should have been refused"
}

function Assert-Equal([string]$Expected, [string]$Actual, [string]$What) {
    if ($Expected -cne $Actual) { throw "$What was '$Actual', expected '$Expected'" }
}

function Assert-True([bool]$Condition, [string]$What) {
    if (-not $Condition) { throw $What }
}

# --- fixture -----------------------------------------------------------------------------------

$fixture = Join-Path ([IO.Path]::GetTempPath()) "library-shelf-note-tests-$([guid]::NewGuid().ToString('n').Substring(0, 8))"
$holdingNotes = Join-Path $fixture 'shelf/holding/wiki/notes'
$openBooks = Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books'

function New-Fixture {
    # Let go of the previous fixture's claim before removing its directory: the claim is an open
    # handle, and a held one makes the removal fail.
    Exit-FixtureSeatClaim
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
    New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/holding/wiki') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/curated/wiki') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture '.claude') -Force | Out-Null
    New-Item -ItemType Directory -Path (Get-DeskStateDirectory -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture') -Force | Out-Null
    # THE FIXTURE HOLDS ITS SEAT: the helpers below write the Notebook, and a Notebook write is a
    # mutation (step 15b). Holding a claim is the faithful test rather than an exemption.
    Enter-FixtureSeatClaim -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' | Out-Null
    Set-Content -LiteralPath $openBooks -Value '' -Encoding utf8
    Set-Content -LiteralPath (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'projects') -Value '' -Encoding utf8
    $catalog = @'
# Local Shelf

## Fixture Holding
- **Summary:** fixture capture Book
- **Kind:** capture
- **Path:** shelf/holding

## Fixture Curated
- **Summary:** fixture curated Book, no Kind line
- **Path:** shelf/curated
'@
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/_catalog.md') -Value $catalog -Encoding utf8
}

function Open-FixtureHolding { Set-Content -LiteralPath $openBooks -Value 'shelf/holding' -Encoding utf8 }
function Close-FixtureHolding { Set-Content -LiteralPath $openBooks -Value '' -Encoding utf8 }

New-Fixture
Write-Host "Fixture: $fixture"
Write-Host ''
Write-Host 'Capture boundary'

Test-Case 'a curated Book refuses notes' {
    Assert-Refused { & $addNote -Title 'probe' -Content 'body' -BookSlug 'curated' -WorkspacePath $fixture } 'is not capture-enabled'
}
Test-Case 'a slug absent from the catalog is refused' {
    Assert-Refused { & $addNote -Title 'probe' -Content 'body' -BookSlug 'not-listed' -WorkspacePath $fixture } 'is listed in shelf/_catalog.md'
}
Test-Case 'a non-lowercase slug is refused by the slug rule, not as an unlisted Book' {
    Assert-Refused { & $addNote -Title 'probe' -Content 'body' -BookSlug 'Holding' -WorkspacePath $fixture } 'lowercase letters, digits, and hyphens'
}
Test-Case 'a path-traversal slug is refused' {
    Assert-Refused { & $addNote -Title 'probe' -Content 'body' -BookSlug '../notebook' -WorkspacePath $fixture } 'lowercase letters, digits, and hyphens'
}
Test-Case 'an empty inline body is refused' {
    Assert-Refused { & $addNote -Title 'probe' -Content '   ' -WorkspacePath $fixture } 'A note needs a body'
}
Test-Case 'a whitespace-only file body is refused' {
    $empty = Join-Path $fixture 'empty-body.md'
    Set-Content -LiteralPath $empty -Value "  `r`n  " -Encoding utf8
    Assert-Refused { & $addNote -Title 'probe' -ContentPath $empty -WorkspacePath $fixture } 'note body is empty'
}
Test-Case 'a title with no letter or digit is refused' {
    Assert-Refused { & $addNote -Title '???' -Content 'body' -WorkspacePath $fixture } 'at least one letter or digit'
}
Test-Case 'capture needs the Book neither open nor confirmed' {
    $r = & $addNote -Title 'Plain note' -Content 'A body with no heading of its own.' -WorkspacePath $fixture
    Assert-Equal 'captured' $r.status 'status'
    Assert-Equal '-Title' $r.title_source 'title_source'
    Assert-Equal 'Plain note' $r.note_title 'note_title'
    Assert-True (-not $r.confirmation_required) 'capture asked for a confirmation'
    $page = [IO.File]::ReadAllText((Join-Path $holdingNotes '2026-01-01-plain-note.md'.Replace('2026-01-01', [DateTime]::UtcNow.ToString('yyyy-MM-dd'))))
    Assert-True ($page.Contains("`n# Plain note`n")) 'the -Title was not written as the page H1'
}
Test-Case 'a repeated title is suffixed, never overwritten' {
    $first = & $addNote -Title 'Repeated title' -Content 'First body.' -WorkspacePath $fixture
    $second = & $addNote -Title 'Repeated title' -Content 'Second body.' -WorkspacePath $fixture
    Assert-True ($first.note_page -cne $second.note_page) 'the second capture reused the first page path'
    Assert-True ($second.note_page.EndsWith('-2')) "the second page was '$($second.note_page)', expected a -2 suffix"
    Assert-True ([IO.File]::ReadAllText((Join-Path $fixture ($first.note_page + '.md'))).Contains('First body.')) 'the first note was overwritten'
}
# Regression, 2026-08-16: a body that keeps its own H1 used to be filed and reported under -Title,
# a title that appeared nowhere on the page, so -MatchText on it could never find the note.
Test-Case 'a body with its own H1 is filed and reported under that H1' {
    $r = & $addNote -Title 'Ignored title' -Content "# Real heading`n`nBody text." -WorkspacePath $fixture
    Assert-Equal 'body H1' $r.title_source 'title_source'
    Assert-Equal 'Real heading' $r.note_title 'note_title'
    Assert-True ($r.note_page.EndsWith('-real-heading')) "the page was '$($r.note_page)', expected a slug from the body H1"
    $page = [IO.File]::ReadAllText((Join-Path $fixture ($r.note_page + '.md')))
    Assert-True (-not $page.Contains('Ignored title')) 'the discarded -Title was written into the page'
    Assert-True (([regex]::Matches($page, '(?m)^#\s+\S')).Count -eq 1) 'the page has more than one H1'
}
Test-Case 'the reported title matches the reader-map entry' {
    $r = & $addNote -Title 'Map check title' -Content "# Map check heading`n`nBody." -WorkspacePath $fixture
    $map = [IO.File]::ReadAllText((Join-Path $fixture 'shelf/holding/wiki/_index.md'))
    Assert-True ($map.Contains("|$($r.note_title)]]")) "the reader map has no entry titled '$($r.note_title)'"
}
Test-Case 'a heading with no letter or digit falls back to -Title' {
    $r = & $addNote -Title 'Fallback title' -Content "# ???`n`nBody." -WorkspacePath $fixture
    Assert-Equal '-Title' $r.title_source 'title_source'
    Assert-Equal 'Fallback title' $r.note_title 'note_title'
}
Test-Case '-Preflight reports the plan and writes nothing' {
    $before = @(Get-ChildItem -LiteralPath $holdingNotes -File).Count
    $r = & $addNote -Title 'Preflight only' -Content 'Body.' -Preflight -WorkspacePath $fixture
    Assert-True (-not $r.confirmation_required) 'capture preflight claimed a confirmation is required'
    Assert-Equal $before ([string]@(Get-ChildItem -LiteralPath $holdingNotes -File).Count) 'note count after a preflight'
}

Write-Host ''
Write-Host 'Reader map append boundary'

. (Join-Path $tools 'ShelfNoteCommon.ps1')
$curated = Get-ShelfBook -Workspace $fixture -Slug 'curated'
$curatedMap = Join-Path $curated.wiki_path '_index.md'
$utf8NoBom = [Text.UTF8Encoding]::new($false)

Test-Case 'a reader map ending in prose gets exactly one blank line before the appended bullet' {
    [IO.File]::WriteAllText($curatedMap, "# Curated map`n`nIntroductory prose.`n", $utf8NoBom)
    $r = Add-ShelfBookIndexLink -Book $curated -Page 'prose-page'
    Assert-True $r.appended 'the prose-map link was not reported appended'
    Assert-Equal "# Curated map`n`nIntroductory prose.`n`n- [[prose-page|prose-page]]`n" ([IO.File]::ReadAllText($curatedMap)) 'the prose-map separator'
}
Test-Case 'a reader map ending in a bullet continues the list without a blank line' {
    [IO.File]::WriteAllText($curatedMap, "# Curated map`n`n- [[existing|existing.md]]`n", $utf8NoBom)
    Add-ShelfBookIndexLink -Book $curated -Page 'list-page' | Out-Null
    Assert-Equal "# Curated map`n`n- [[existing|existing.md]]`n- [[list-page|list-page]]`n" ([IO.File]::ReadAllText($curatedMap)) 'the existing-list separator'
}
Test-Case 'a heading-only reader map gets exactly one blank line before the appended bullet' {
    [IO.File]::WriteAllText($curatedMap, "# Curated map`n", $utf8NoBom)
    Add-ShelfBookIndexLink -Book $curated -Page 'heading-page' | Out-Null
    Assert-Equal "# Curated map`n`n- [[heading-page|heading-page]]`n" ([IO.File]::ReadAllText($curatedMap)) 'the heading-only separator'
}
Test-Case 'trailing blank lines are normalized to exactly one before the appended bullet' {
    [IO.File]::WriteAllText($curatedMap, "# Curated map`n`nIntroductory prose.`n`n`n", $utf8NoBom)
    Add-ShelfBookIndexLink -Book $curated -Page 'blank-lines-page' | Out-Null
    Assert-Equal "# Curated map`n`nIntroductory prose.`n`n- [[blank-lines-page|blank-lines-page]]`n" ([IO.File]::ReadAllText($curatedMap)) 'the trailing-blank-lines separator'
}
Test-Case 'a CRLF reader map keeps CRLF line endings when a bullet is appended' {
    [IO.File]::WriteAllText($curatedMap, "# Curated map`r`n`r`nIntroductory prose.`r`n", $utf8NoBom)
    Add-ShelfBookIndexLink -Book $curated -Page 'crlf-page' | Out-Null
    Assert-Equal "# Curated map`r`n`r`nIntroductory prose.`r`n`r`n- [[crlf-page|crlf-page]]`r`n" ([IO.File]::ReadAllText($curatedMap)) 'the CRLF reader map'
}
Test-Case 'a page appended with a label is listed by its title, not its path' {
    [IO.File]::WriteAllText($curatedMap, "# Curated map`n", $utf8NoBom)
    Add-ShelfBookIndexLink -Book $curated -Page 'hosts-and-roles' -Label 'Hosts and Roles' | Out-Null
    Assert-Equal "# Curated map`n`n- [[hosts-and-roles|Hosts and Roles]]`n" ([IO.File]::ReadAllText($curatedMap)) 'the labelled reader-map bullet'
}
# THIS CASE IS THIS CHANGE'S DAY-ONE DATA, and its fixture was already written that way. Every
# curated map on disk predates titled labels and carries `- [[<page>|<page>.md]]`, so an idempotency
# check comparing the whole rendered line would no longer recognise a page that IS listed and would
# append a second link to it. Matching the target is what keeps this green against a legacy map.
Test-Case 'a duplicate reader-map link reports not appended and writes nothing' {
    $before = "# Curated map`n`n- [[duplicate|duplicate.md]]`n"
    [IO.File]::WriteAllText($curatedMap, $before, $utf8NoBom)
    $beforeHash = (Get-FileHash -LiteralPath $curatedMap -Algorithm SHA256).Hash
    $r = Add-ShelfBookIndexLink -Book $curated -Page 'duplicate'
    Assert-True (-not $r.appended) 'the duplicate reader-map link was reported appended'
    Assert-Equal $beforeHash ((Get-FileHash -LiteralPath $curatedMap -Algorithm SHA256).Hash) 'the duplicate reader-map write changed the file bytes'
    Assert-Equal $before ([IO.File]::ReadAllText($curatedMap)) 'the duplicate reader-map write changed the text'
}

Write-Host ''
Write-Host 'Triage boundary'

# One action's result, unwrapped. The single-note surface composes a one-action plan, so its report
# is a batch report of one -- deliberately, because that is what makes one note and twenty share a
# write-set digest.
function Get-Only($Report) {
    $outcomes = @($Report.outcomes)
    if ($outcomes.Count -ne 1) { throw "expected one outcome, got $($outcomes.Count)" }
    if ($outcomes[0].state -cne 'succeeded') { throw "the action did not succeed: $($outcomes[0].error)" }
    $outcomes[0].result
}

# --- THE SPLIT GATE, closed direction ---------------------------------------------------------
# Every kind whose SOURCE is the capture Book, each asserted separately. One case per kind rather
# than one representative case, because the gate is now applied in one place for all of them and a
# single representative would pass while a branch that skipped it went unnoticed.
Close-FixtureHolding
Test-Case 'review is refused while the source Book is closed' {
    Assert-Refused { & $triage -Source Holding -MatchText 'Plain' -To Review -WorkspacePath $fixture } "Shelf Book 'holding' is closed"
}
Test-Case 'notebook is refused while the source Book is closed' {
    Assert-Refused { & $triage -Source Holding -MatchText 'Plain' -To Notebook -Topic 'graphics' -WorkspacePath $fixture } "Shelf Book 'holding' is closed"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'notebook/graphics'))) 'a refused notebook triage created the topic folder anyway'
}
Test-Case 'discard is refused while the source Book is closed, even at preflight' {
    Assert-Refused { & $triage -Source Holding -MatchText 'Plain' -To Discard -WorkspacePath $fixture -Preflight } "Shelf Book 'holding' is closed"
}
# A shelf-book action sourced from the Holding Shelf needs BOTH Books open, which is why
# required_desk_state is a list. Each half is asserted with the other satisfied, so neither case can
# pass on the wrong refusal.
Test-Case 'shelf-book from holding is refused while only the SOURCE Book is closed' {
    Set-Content -LiteralPath $openBooks -Value 'shelf/curated' -Encoding utf8
    try { Assert-Refused { & $triage -Source Holding -MatchText 'Plain' -To ShelfBook -Slug 'curated' -PagePath 'notes/probe' -WorkspacePath $fixture } "Shelf Book 'holding' is closed" }
    finally { Close-FixtureHolding }
}
Test-Case 'shelf-book from holding is refused while only the DESTINATION Book is closed' {
    Set-Content -LiteralPath $openBooks -Value 'shelf/holding' -Encoding utf8
    try { Assert-Refused { & $triage -Source Holding -MatchText 'Plain' -To ShelfBook -Slug 'curated' -PagePath 'notes/probe' -WorkspacePath $fixture } "Shelf Book 'curated' is closed" }
    finally { Close-FixtureHolding }
}
# The gate fires BEFORE the notes are listed. Resolution has to read every note's title to honour
# -MatchText, so a gate checked only after resolution would let a closed Book answer 'that matches
# two notes' and name them -- leaking exactly what the Desk exists to withhold.
Test-Case 'a closed Book does not answer an ambiguous match with its note titles' {
    Assert-Refused { & $triage -Source Holding -MatchText 'Repeated title' -To Review -WorkspacePath $fixture } "Shelf Book 'holding' is closed"
}

# --- THE SPLIT GATE, ungated direction --------------------------------------------------------
# Still closed. Capture is the one write into a capture Book that asks for nothing, and a triage
# action whose DESTINATION is the Holding Shelf is the same write by another name.
Test-Case 'capture into a closed capture Book still needs nothing' {
    $r = & $addNote -Title 'Ungated probe' -Content 'Captured with every Book closed.' -WorkspacePath $fixture
    Assert-Equal 'captured' $r.status 'status'
}
Test-Case 'triage INTO the Holding Shelf needs no open Book either' {
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/inbound.md') -Value "# Inbound article`n`nBody.`n" -Encoding utf8
    $r = & $triage -Source Notebook -SourcePath 'notebook/inbound.md' -To Holding -Title 'Inbound article' -WorkspacePath $fixture
    Assert-Equal 'complete' $r.status 'status'
    Assert-Equal 'captured' (Get-Only $r).status 'the capture status'
}

Open-FixtureHolding
Test-Case 'an ambiguous -MatchText is refused and lists what it hit' {
    Assert-Refused { & $triage -Source Holding -MatchText 'Repeated title' -To Review -WorkspacePath $fixture } 'matches 2 notes'
}
Test-Case '-Page and -MatchText together are refused' {
    Assert-Refused { & $triage -Source Holding -Page 'notes/x' -MatchText 'y' -To Review -WorkspacePath $fixture } 'not both'
}
Test-Case 'a -Page outside notes/ is refused' {
    Assert-Refused { & $triage -Source Holding -Page 'notes/../../notebook/x' -To Review -WorkspacePath $fixture } 'canonical note path'
}
Test-Case 'triage against a curated Book is refused' {
    Assert-Refused { & $triage -Source Holding -BookSlug 'curated' -MatchText 'x' -To Review -WorkspacePath $fixture } 'is not capture-enabled'
}
Test-Case 'naming two surfaces at once is refused' {
    Assert-Refused { & $triage -ActionJson '[]' -To Review -WorkspacePath $fixture } 'exactly one surface'
}
# Regression, 2026-08-16: -notmatch is case-insensitive, so this lowercase-only rule used to accept
# 'Graphics' and create a Notebook topic folder the rest of the Library does not recognise.
Test-Case 'a non-lowercase topic is refused' {
    Assert-Refused { & $triage -Source Holding -MatchText 'Plain note' -To Notebook -Topic 'Graphics' -WorkspacePath $fixture } 'lowercase letters, digits, and hyphens'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'notebook/Graphics'))) 'a non-lowercase topic folder was created anyway'
}
Test-Case 'notebook copies, keeps the Shelf note, and marks it reviewed' {
    $report = & $triage -Source Holding -MatchText 'Plain note' -To Notebook -Topic 'graphics' -WorkspacePath $fixture
    $r = Get-Only $report
    Assert-Equal 'copied' $r.status 'status'
    Assert-Equal 'done' $r.new_review 'new_review'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture $r.destination)) 'the Notebook copy is missing'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture $r.note_page)) 'the Shelf note was moved rather than copied'
    # The one kind that is honestly true in two write columns at once.
    Assert-Equal 'True' ([string]$report.notebook_write) 'a notebook copy did not report a Notebook write'
    Assert-Equal 'True' ([string]$report.shelf_write) 'a notebook copy did not report the Shelf write that marks the original reviewed'
    Assert-Equal 'False' ([string]$report.shared_library_write) 'a local copy claimed a shared write'
}
Test-Case 'a second notebook copy into the same destination is refused' {
    Assert-Refused { & $triage -Source Holding -MatchText 'Plain note' -To Notebook -Topic 'graphics' -WorkspacePath $fixture } 'already exists'
}
Test-Case 'a repeated review reports unchanged' {
    Assert-Equal 'unchanged' (Get-Only (& $triage -Source Holding -MatchText 'Plain note' -To Review -WorkspacePath $fixture)).status 'status'
}
Test-Case '-Reopen puts a reviewed note back to pending' {
    Assert-Equal 'pending' (Get-Only (& $triage -Source Holding -MatchText 'Plain note' -To Review -Reopen -WorkspacePath $fixture)).new_review 'new_review'
}
# Locked on 2026-08-28; its REASON re-derived 2026-09-10 and the rule upheld. notebook/ is volatile,
# but a Reset quarantines it rather than deleting it (ADR-0016), so a notebook discard is not
# deleting it sooner -- it destroys what the reset would have kept recoverable, in the one helper
# whose purpose is losing nothing. Refused with that reason rather than silently missing from the
# set, and this assertion pins the reason: a revert to "the Reset already deletes all of it" goes
# red here. See docs/library-triage-design.md:440-448.
Test-Case 'discard from the Notebook is refused, and says why' {
    Assert-Refused { & $triage -Source Notebook -SourcePath 'notebook/inbound.md' -To Discard -WorkspacePath $fixture } 'quarantines notebook/'
}
Test-Case 'discard without -UserConfirmed is refused' {
    Assert-Refused { & $triage -Source Holding -MatchText 'Fallback title' -To Discard -WorkspacePath $fixture } 'rerun with -UserConfirmed'
}
Test-Case 'discard with a wrong plan_id is refused' {
    Assert-Refused { & $triage -Source Holding -MatchText 'Fallback title' -To Discard -UserConfirmed -ApprovedPlanId 'triage-0000' -WorkspacePath $fixture } 'exact plan_id'
}
Test-Case 'a discard preflight binds what it destroys, and says it is not recoverable' {
    $plan = & $triage -Source Holding -MatchText 'Fallback title' -To Discard -Preflight -WorkspacePath $fixture
    Assert-True ($plan.plan_id -cmatch '^triage-[0-9a-f]{64}$') "the plan_id read '$($plan.plan_id)'"
    Assert-Equal 'False' ([string]$plan.recoverable) 'a discard preflight claimed to be recoverable'
    $action = @($plan.actions)[0]
    Assert-Equal '1' ([string]@($action.delete_set).Count) 'the discard bound no delete_set'
    Assert-Equal '0' ([string]@($action.write_set).Count) 'a discard declared a write set'
    Assert-True (@($action.delete_set)[0].StartsWith('shelf/holding/wiki/notes/')) "the delete_set named '$(@($action.delete_set)[0])'"
}
Test-Case 'a plan_id goes stale when the note changes' {
    $plan = & $triage -Source Holding -MatchText 'Fallback title' -To Discard -Preflight -WorkspacePath $fixture
    $notePath = Join-Path $fixture @($plan.actions)[0].delete_set[0]
    Add-Content -LiteralPath $notePath -Value 'Edited after approval.' -Encoding utf8
    Assert-Refused { & $triage -Source Holding -MatchText 'Fallback title' -To Discard -UserConfirmed -ApprovedPlanId $plan.plan_id -WorkspacePath $fixture } 'exact plan_id'
    Assert-True (Test-Path -LiteralPath $notePath) 'the note was deleted despite a stale plan_id'
}
Test-Case 'discard with the current plan_id removes exactly that note' {
    $before = @(Get-ChildItem -LiteralPath $holdingNotes -File).Count
    $plan = & $triage -Source Holding -MatchText 'Fallback title' -To Discard -Preflight -WorkspacePath $fixture
    $r = Get-Only (& $triage -Source Holding -MatchText 'Fallback title' -To Discard -UserConfirmed -ApprovedPlanId $plan.plan_id -WorkspacePath $fixture)
    Assert-Equal 'discarded' $r.status 'status'
    Assert-Equal ([string]($before - 1)) ([string]@(Get-ChildItem -LiteralPath $holdingNotes -File).Count) 'note count after a discard'
}
# A note that has gone cannot be named, so the refusal arrives at resolution rather than at a gate.
# This is what stands in for a delete-set existence check, and it is why the runner has none.
Test-Case 'a discard target that has already gone is refused at resolution' {
    $plan = & $triage -Source Holding -MatchText 'Ungated probe' -To Discard -Preflight -WorkspacePath $fixture
    $notePath = Join-Path $fixture @($plan.actions)[0].delete_set[0]
    Remove-Item -LiteralPath $notePath -Force
    Assert-Refused { & $triage -Source Holding -MatchText 'Ungated probe' -To Discard -UserConfirmed -ApprovedPlanId $plan.plan_id -WorkspacePath $fixture } "contains 'Ungated probe'"
}
# A single note writes no plan record and no journal. Those are the batch's durable state; a note
# that produced one on every review would turn tidying into filing.
Test-Case 'a single note leaves no plan record and no journal' {
    foreach ($relative in @('internal/triage-plans', 'internal/triage-journals', 'internal/handoff-plans', 'internal/handoff-journals')) {
        $full = Join-Path $fixture $relative
        if (-not (Test-Path -LiteralPath $full)) { continue }
        Assert-Equal '0' ([string]@(Get-ChildItem -LiteralPath $full -File -Recurse).Count) "$relative after single-note runs"
    }
}

Write-Host ''
Write-Host 'Desk overview'

Test-Case 'the overview reports counts and no note content' {
    Close-FixtureHolding
    & $addNote -Title 'ZEBRAFISHTITLE' -Content 'QUOKKABODY text' -Tags 'TAGCANARY' -SourcePaths 'raw/PATHCANARY/x.md' -SourceProject 'PROJECTCANARY' -WorkspacePath $fixture | Out-Null
    $json = & $deskOverview -WorkspacePath $fixture | ConvertTo-Json -Depth 12
    foreach ($canary in @('ZEBRAFISHTITLE', 'QUOKKABODY', 'TAGCANARY', 'PATHCANARY', 'PROJECTCANARY')) {
        Assert-True (-not $json.Contains($canary)) "the Desk overview leaked '$canary' from a closed capture Book"
    }
    $overview = & $deskOverview -WorkspacePath $fixture
    $holding = @($overview.capture_books | Where-Object { $_.slug -ceq 'holding' })[0]
    Assert-True (-not $holding.is_open) 'a closed capture Book was reported open'
    Assert-True ($holding.pending_count -ge 1) 'the pending count did not include the new note'
}

Write-Host ''
Write-Host 'Concurrency'

# The two defects 1.2 had to close, since a second writer makes them reachable: filename selection
# was a check-then-write race, and the reader map was rewritten with nobody excluded.
. (Join-Path $tools 'BookWriteGuard.ps1')

Test-Case 'capture waits for the Book lock, then refuses rather than racing' {
    $held = Enter-BookLock -Workspace $fixture -BookRoot 'shelf/holding' -TimeoutSeconds 5
    try {
        Assert-Refused { & $addNote -Title 'Locked out' -Content 'Body.' -WorkspacePath $fixture -LockTimeoutSeconds 1 } 'holds the lock'
    }
    finally { Exit-BookLock -Lock $held }
}
Test-Case 'triage takes the same Book lock as capture' {
    Open-FixtureHolding
    $held = Enter-BookLock -Workspace $fixture -BookRoot 'shelf/holding' -TimeoutSeconds 5
    try {
        Assert-Refused { & $triage -Source Holding -MatchText 'Plain note' -To Review -Reopen -WorkspacePath $fixture -LockTimeoutSeconds 1 } 'holds the lock'
    }
    finally { Exit-BookLock -Lock $held }
}
Test-Case 'a failed reader-map rewrite leaves no half-captured note' {
    $map = Join-Path $fixture 'shelf/holding/wiki/_index.md'
    $mapBefore = [IO.File]::ReadAllText($map)
    $before = @(Get-ChildItem -LiteralPath $holdingNotes -File).Count
    (Get-Item -LiteralPath $map -Force).IsReadOnly = $true
    try { Assert-Refused { & $addNote -Title 'Rollback probe' -Content 'Body.' -WorkspacePath $fixture } 'Rollback: complete and verified' }
    finally { (Get-Item -LiteralPath $map -Force).IsReadOnly = $false }
    Assert-Equal ([string]$before) ([string]@(Get-ChildItem -LiteralPath $holdingNotes -File).Count) 'note count after a failed capture'
    Assert-Equal $mapBefore ([IO.File]::ReadAllText($map)) 'the reader map after a failed capture'
}


# --- Provenance: from_seat and session_id ---------------------------------------------------------
#
# THE INVARIANT THAT MATTERS MOST HERE IS THE UNGATED ONE. Capture works with no seat at all, and
# these fields must never change that: a note that started requiring a seat would be a note that
# stops being written, which is the whole defect capture exists to prevent.

Write-Host ''
Write-Host 'Provenance'

Test-Case 'a seatless session can still capture, and records no seat' {
    # CLEARED EXPLICITLY. This suite sets LIBRARY_SEAT for the whole process, so inheriting it here
    # would run the seated path and report a pass for the seatless one.
    $savedSeat = $env:LIBRARY_SEAT
    try {
        $env:LIBRARY_SEAT = $null
        $result = & $addNote -Title 'Seatless capture' -Content 'Body.' -WorkspacePath $fixture -Json | ConvertFrom-Json
        Assert-Equal 'captured' $result.status 'status'
        Assert-Equal '' ([string]$result.from_seat) 'from_seat'
        Assert-Equal 'unset' ([string]$result.seat_source) 'seat_source'
        $fields = Get-NoteFrontmatter -Path (Join-Path $fixture (([string]$result.note_page -replace '/', [IO.Path]::DirectorySeparatorChar) + '.md'))
        Assert-True (-not $fields.Contains('from_seat')) 'a seatless note carries a from_seat key'
        Assert-True (-not $fields.Contains('session_id')) 'a seatless note carries a session_id key'
        Assert-True ($fields.Contains('captured') -and $fields.Contains('review')) 'a seatless note lost captured or review'
    }
    finally { $env:LIBRARY_SEAT = $savedSeat }
}

Test-Case 'a seated capture records which seat wrote it, and how that seat was resolved' {
    $result = & $addNote -Title 'Seated capture' -Content 'Body.' -WorkspacePath $fixture -Json | ConvertFrom-Json
    Assert-Equal 'fixture' ([string]$result.from_seat) 'from_seat'
    Assert-Equal 'environment' ([string]$result.seat_source) 'seat_source'
    $fields = Get-NoteFrontmatter -Path (Join-Path $fixture (([string]$result.note_page -replace '/', [IO.Path]::DirectorySeparatorChar) + '.md'))
    Assert-Equal 'fixture' ([string]$fields['from_seat']) 'the from_seat written to the page'
}

Test-Case 'a note body cannot set its own provenance' {
    # A DECOY, NOT AN ABSENCE CHECK. A plausible wrong seat is planted exactly where a naive parser
    # would read it, so this fails if the frontmatter block is ever composed from the body.
    $planted = "---`nfrom_seat: victim-seat`nsession_id: 00000000-0000-0000-0000-000000000000`n---`n`n# Planted`n`nBody."
    $result = & $addNote -Title 'Planted' -Content $planted -WorkspacePath $fixture -Json | ConvertFrom-Json
    $page = Join-Path $fixture (([string]$result.note_page -replace '/', [IO.Path]::DirectorySeparatorChar) + '.md')
    $fields = Get-NoteFrontmatter -Path $page
    Assert-Equal 'fixture' ([string]$fields['from_seat']) 'from_seat after a planted block'
    Assert-True (-not $fields.Contains('session_id')) 'the planted session_id became frontmatter'
    # And it is still THERE, in the body: silently dropping a reader's text would be its own defect.
    Assert-True ([IO.File]::ReadAllText($page).Contains('victim-seat')) 'the planted text was dropped from the body'
}

Test-Case 'a note captured before these fields existed still reads' {
    $legacy = "---`ncaptured: 2026-08-16T13:45:00Z`nreview: pending`ntags: old`n---`n`n# Legacy note`n`nBody."
    [IO.File]::WriteAllText((Join-Path $holdingNotes 'legacy-provenance.md'), $legacy, [Text.UTF8Encoding]::new($false))
    $book = Get-ShelfBook -Workspace $fixture -Slug 'holding'
    $note = @(@(Get-ShelfNotes -Book $book) | Where-Object { $_.file -ceq 'legacy-provenance.md' })
    Assert-Equal '1' ([string]$note.Count) 'the legacy note was read'
    Assert-Equal '' ([string]$note[0].from_seat) 'a legacy note reports an empty from_seat'
    Assert-Equal 'old' ([string]$note[0].tags) 'a legacy note still reports its other fields'
}

Test-Case 'there is no parameter that could set the seat' {
    $settable = @((Get-Command $addNote).Parameters.Keys | Where-Object { $_ -cmatch '^(FromSeat|SessionId)$' })
    Assert-Equal '0' ([string]$settable.Count) 'a caller-settable provenance parameter exists'
}

# --- New-ShelfBook --------------------------------------------------------------------------------
#
# ITS OWN FIXTURE, deliberately. The shared one above carries a hand-authored shelf/_catalog.md with
# no entry files, and New-ShelfBook renders through them -- so it needs the tracked header and the
# migration a real Shelf ran once. Building that here rather than mutating the fixture every case
# above depends on.

Write-Host ''
Write-Host 'New-ShelfBook'

$newShelfBook = Join-Path $tools 'New-ShelfBook.ps1'
$bookFixture = Join-Path ([IO.Path]::GetTempPath()) "library-new-shelf-book-$([guid]::NewGuid().ToString('n').Substring(0, 8))"
. (Join-Path $PSScriptRoot 'ShelfCatalog.ps1')
New-Item -ItemType Directory -Path (Join-Path $bookFixture 'shelf/holding/wiki/notes') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bookFixture 'internal') -Force | Out-Null
[IO.File]::WriteAllText(
    (Join-Path $bookFixture 'shelf/_catalog.md'),
    "# Local Shelf`n`n## Fixture Holding`n- **Summary:** fixture capture Book`n- **Kind:** capture`n- **Path:** shelf/holding`n",
    [Text.UTF8Encoding]::new($false))
Initialize-ShelfCatalogForFixture -FixtureRoot $bookFixture -RepositoryRoot (Split-Path -Parent $PSScriptRoot)

Test-Case 'preflight reports the Book it would create and writes nothing' {
    $plan = & $newShelfBook -Slug 'reports' -Title 'Report Inbox' -Summary 'Probe.' -Capture -WorkspacePath $bookFixture -Preflight -Json | ConvertFrom-Json
    Assert-Equal 'capture' ([string]$plan.kind) 'the planned kind'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $bookFixture 'shelf/reports'))) 'preflight created the Book'
}

Test-Case 'a created capture Book is one every consumer agrees about' {
    $made = & $newShelfBook -Slug 'reports' -Title 'Report Inbox' -Summary 'Probe.' -Topics 'capture, reports' -Capture -WorkspacePath $bookFixture -Json | ConvertFrom-Json
    Assert-Equal 'created' ([string]$made.status) 'status'
    # THE CONSUMERS, not the bytes just written: Get-ShelfBook is what every capture and guard
    # resolves a Book with, and Get-CaptureBooks is what puts it on the Desk overview.
    Assert-True ((Get-ShelfBook -Workspace $bookFixture -Slug 'reports').is_capture) 'Get-ShelfBook does not see a capture Book'
    Assert-Equal '2' ([string]@(Get-CaptureBooks -Workspace $bookFixture).Count) 'the capture Book count'
    Assert-Equal '0' ([string]@(Get-ShelfCatalogDrift -Workspace $bookFixture).Count) 'the catalog drifted from its entries'
    # And it actually accepts a note, which is the only thing it was created to do.
    # Named apart from the $note used for a COLLECTION above: powershell.defect-families tracks the
    # variable name, so one name standing for both an array and a scalar reads as an unwrapped count.
    $captured = & $addNote -Title 'First report' -Content 'Body.' -BookSlug 'reports' -WorkspacePath $bookFixture -Json | ConvertFrom-Json
    Assert-Equal 'captured' ([string]$captured.status) 'capture into the new Book'
}

Test-Case 'a husk is refused as a husk, not as an existing Book' {
    # The two refusals must be DISTINGUISHABLE. The existing-Book guard fires on the same path, so
    # asserting only "it was refused" would pass with the husk branch deleted.
    New-Item -ItemType Directory -Path (Join-Path $bookFixture 'shelf/husk') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $bookFixture 'shelf/husk/_catalog-entry.md'),
        "## Husk`n- **Path:** shelf/husk`n", [Text.UTF8Encoding]::new($false))
    try {
        Assert-Refused { & $newShelfBook -Slug 'husk' -Title 'Husk' -Summary 'Probe.' -WorkspacePath $bookFixture } 'husk rather than a Book'
    }
    finally { Remove-Item -LiteralPath (Join-Path $bookFixture 'shelf/husk') -Recurse -Force }
}

Test-Case 'a malformed slug and an empty summary are each refused by name' {
    Assert-Refused { & $newShelfBook -Slug 'Reports' -Title 'T' -Summary 'S' -WorkspacePath $bookFixture } 'is malformed'
    Assert-Refused { & $newShelfBook -Slug 'has_underscore' -Title 'T' -Summary 'S' -WorkspacePath $bookFixture } 'is malformed'
    Assert-Refused { & $newShelfBook -Slug 'nosummary' -Title 'T' -Summary '   ' -WorkspacePath $bookFixture } 'Summary is required'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $bookFixture 'shelf/nosummary'))) 'a refused create left a directory behind'
}

Test-Case 'a curated Book is created without a notes directory and refuses captures' {
    $made = & $newShelfBook -Slug 'curated-new' -Title 'Curated New' -Summary 'Probe.' -WorkspacePath $bookFixture -Json | ConvertFrom-Json
    Assert-True (-not [bool]$made.is_capture) 'a Book created without -Capture reports is_capture'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $bookFixture 'shelf/curated-new/wiki/notes'))) 'a curated Book got a notes directory'
    Assert-Refused { & $addNote -Title 'Nope' -Content 'Body.' -BookSlug 'curated-new' -WorkspacePath $bookFixture } 'is not capture-enabled'
}

Write-Host ''
Exit-FixtureSeatClaim
if (-not $KeepFixture) {
    Remove-Item -LiteralPath $fixture -Recurse -Force
    Remove-Item -LiteralPath $bookFixture -Recurse -Force -ErrorAction SilentlyContinue
}
if ($script:failed.Count) {
    Write-Host "FAILED: $($script:failed.Count) of $($script:passed + $script:failed.Count)"
    foreach ($failure in $script:failed) { Write-Host "  - $failure" }
    exit 1
}
Write-Host "All $($script:passed) cases passed."
