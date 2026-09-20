<#
Rung 4 of Plan item 2.2: the check that fails a writer which skips the manifest transaction.

Two halves, because neither one alone is enforcement.

  THE STATIC HALF catches a writer that never routes at all -- a helper added or edited later that
  takes a Book's lock, changes the Book, and never opens a mutation window. Nothing at runtime can
  see that absence, because the absent code is the thing that would have reported it.

  THE BEHAVIOURAL HALF catches routing that is present and broken. Each real writer is run against a
  disposable fixture Shelf and the store is read back: a committed generation whose source_digest
  matches a manifest generated fresh from the Book is the only evidence that the routing did what it
  says. A call to Enter-BookMutation proves nothing on its own.

No Claude-side hook runs in a delegate process, so this is where the invariant is enforced: in the
writers, and in a gate check that a delegate also runs.

Everything runs against a disposable fixture workspace under the system temp directory. The reader's
Shelf, Notebook, and Virtual Desk are never touched. Exit code 0 means every case passed.

    tools/Test-ShelfWriterRouting.ps1
#>
[CmdletBinding()]
param([switch]$KeepFixture)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'BookManifestTransaction.ps1')
# Initialize-ShelfCatalogForFixture: shelf/_catalog.md is rendered, so a fixture needs the tracked
# header and one entry file per Book before any writer runs in it.
. (Join-Path $PSScriptRoot 'ShelfCatalog.ps1')
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
# Fixtures work at a seat named 'fixture'. Set in this process so CHILD helper processes
# inherit it: they default -Seat to LIBRARY_SEAT, and there is no default seat to fall back on.
$env:LIBRARY_SEAT = 'fixture'


$tools = $PSScriptRoot
$addNote = Join-Path $tools 'Add-ShelfNote.ps1'
$triage = Join-Path $tools 'Invoke-LibraryTriage.ps1'
$addPage = Join-Path $tools 'Add-ShelfBookPage.ps1'
$addTopic = Join-Path $tools 'Add-ShelfBookTopic.ps1'
$rename = Join-Path $tools 'Rename-ShelfBook.ps1'
$stub = Join-Path $tools 'Set-ShelfBookPageStub.ps1'
$archiveBook = Join-Path $tools 'Archive-ShelfBook.ps1'

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

# The whole point of the behavioural half: not "was Enter-BookMutation called" but "does the stored
# manifest describe the Book as it now stands". A digest comparison against a fresh generation is
# what a stale manifest cannot survive.
function Assert-ManifestCurrent([string]$Workspace, [string]$Slug, [string]$What) {
    $read = Get-StoredBookManifest -Workspace $Workspace -Slug $Slug
    if ($read.status -cne 'ok') { throw "$What -- the store reads '$($read.status)', not 'ok'" }
    $fresh = New-BookManifest -Workspace $Workspace -Slug $Slug
    if ($read.source_digest -cne $fresh.source_digest) { throw "$What -- the committed manifest does not describe the Book as it now stands" }
    $read
}

# A call, not a mention. Every helper here documents its own routing in prose, so a plain substring
# search would be satisfied by the comment that explains the call it no longer makes -- which is
# exactly the state this suite exists to catch. Lines whose first non-space character is '#' do not
# count. (A '#' later on the same line still hides nothing; this is a lint, not a parser.)
# A <# #> block comment's body does not start with '#', so a line filter never saw it and a helper
# could satisfy every rule in the static half by NAMING Enter-BookMutation in its synopsis while
# calling nothing. Found 2026-08-19 by mutating Update-BookManifests.ps1 to bypass the window: its
# .DESCRIPTION mentions the function, so the census and the locks-without-a-window rule both stayed
# green over a helper that had stopped routing.
#
# A QUOTED STRING IS THE SAME FALSE POSITIVE, and stripping block comments never covered it. On
# 2026-09-06 a new gate check began comparing AST command names against 'Enter-BookMutation' as
# DATA, and the line scan promptly classified Invoke-LibraryChecks.ps1 -- which writes nothing --
# as a routed Shelf writer. So the question is answered from the parse tree: a call is a command in
# command position, and neither documentation nor a string literal is one.
# Every Enter-BookLock CALL in a helper, with the text of the -BookRoot it asks for. The Book root
# is what says whether a Shelf Book was locked: Set-TopicOverlap locks 'internal/overlap-records'
# and Invoke-LibraryTriage's batch lock is 'triage/<batch>', and neither names a Book.
function Get-BookLockCall([string]$Text) {
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput($Text, [ref]$null, [ref]$parseErrors)
    if ($null -ne $parseErrors -and @($parseErrors).Count) {
        throw "a helper under the routing scan does not parse: $($parseErrors[0].Message)"
    }
    @($ast.FindAll({
        $args[0] -is [Management.Automation.Language.CommandAst] -and
        [string]$args[0].GetCommandName() -ceq 'Enter-BookLock'
    }, $true) | ForEach-Object {
        $elements = @($_.CommandElements)
        $root = ''
        for ($i = 0; $i -lt $elements.Count; $i++) {
            if ($elements[$i] -is [Management.Automation.Language.CommandParameterAst] -and
                $elements[$i].ParameterName -ceq 'BookRoot' -and ($i + 1) -lt $elements.Count) {
                $root = [string]$elements[$i + 1].Extent.Text
                break
            }
        }
        [pscustomobject]@{ line = $_.Extent.StartLineNumber; book_root = $root }
    })
}

function Test-CallsFunction([string]$Text, [string]$Name) {
    # $Name may be an alternation -- 'Complete-BookMutation|Remove-BookManifestStore' is how the
    # callers spell "any of these closes the window".
    $wanted = @($Name -split '\|' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput($Text, [ref]$null, [ref]$parseErrors)
    if ($null -ne $parseErrors -and @($parseErrors).Count) {
        throw "a helper under the routing scan does not parse: $($parseErrors[0].Message)"
    }
    foreach ($command in $ast.FindAll({ $args[0] -is [Management.Automation.Language.CommandAst] }, $true)) {
        # GetCommandName() is null for an invocation through a variable or a scriptblock, which is
        # not a named call and cannot be attributed to one.
        $called = [string]$command.GetCommandName()
        if ([string]::IsNullOrEmpty($called)) { continue }
        if ($wanted -ccontains $called) { return $true }
    }
    $false
}

function Get-Generation([string]$Workspace, [string]$Slug) {
    $read = Get-StoredBookManifest -Workspace $Workspace -Slug $Slug
    if ($read.status -cne 'ok') { return 0 }
    [int]$read.generation
}

# --- fixture ---------------------------------------------------------------------------------------

$fixture = Join-Path ([IO.Path]::GetTempPath()) "library-writer-routing-tests-$([guid]::NewGuid().ToString('n').Substring(0, 8))"
$openBooks = Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books'
$utf8 = [Text.UTF8Encoding]::new($false)

function Write-Fixture([string]$Relative, [string]$Text) {
    $path = Join-Path $fixture $Relative
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($path, $Text, $utf8)
}

try {

New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/holding/wiki/notes') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook') -Force | Out-Null
New-Item -ItemType Directory -Path (Get-DeskStateDirectory -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture') -Force | Out-Null
# THE FIXTURE HOLDS ITS SEAT: the helpers below write the Notebook, and a Notebook write is a
# mutation (step 15b). Holding a claim is the faithful test rather than an exemption.
Enter-FixtureSeatClaim -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' | Out-Null
Write-Fixture 'shelf/_catalog.md' @'
# Local Shelf

## Fixture Demo
- **Summary:** fixture curated Book
- **Topics:** demo, routing
- **Path:** shelf/demo

## Fixture Holding
- **Summary:** fixture capture Book
- **Kind:** capture
- **Path:** shelf/holding
'@
Write-Fixture 'shelf/demo/wiki/_book.md' "# Fixture Demo`n`n- **Type:** fixture`n"
Write-Fixture 'shelf/demo/wiki/_index.md' "# Fixture Demo`n"
Write-Fixture 'shelf/demo/wiki/existing.md' "# Existing page`n`nBody.`n"
Write-Fixture 'shelf/holding/wiki/_book.md' "# Fixture Holding`n`n- **Kind:** capture`n"
Write-Fixture 'shelf/holding/wiki/_index.md' "# Fixture Holding`n"
# A topic directory needs its _index.md: the master-index renderer derives the topic's label from
# that heading and refuses a topic it cannot label. This fixture used to have articles and no index,
# which is exactly the degenerate state PLAN-multi-desk.md step 2 removes.
Write-Fixture 'notebook/graphics/_index.md' "# Graphics`n`n## Articles`n"
Write-Fixture 'notebook/graphics/one.md' "# Graduated one`n`nBody one.`n"
Write-Fixture 'notebook/graphics/two.md' "# Graduated two`n`nBody two.`n"
Write-Fixture (Get-DeskFileRelativePath -Seat 'fixture' -Kind 'books') "shelf/demo`nshelf/holding`n"
Write-Fixture (Get-DeskFileRelativePath -Seat 'fixture' -Kind 'projects') ''

# shelf/_catalog.md is rendered from the tracked header plus one entry file per Book, so a fixture
# that only writes the catalog has no Shelf the renderer can reproduce. The header is COPIED from
# the repository rather than retyped -- a fixture with its own copy would pass while the real one
# was broken -- and the entry files come from the real migration.
Initialize-ShelfCatalogForFixture -FixtureRoot $fixture

Write-Host "Fixture: $fixture"
Write-Host ''
Write-Host 'The static half: a writer that takes a Book lock must open a mutation window'

# --- static: the rules, over the helpers as they actually stand -------------------------------------

# These two ARE the mechanism -- BookWriteGuard defines the lock and BookManifestTransaction defines
# the window -- so measuring them against it is circular. Test-*.ps1 files simulate contention and
# mutate nothing of their own.
$mechanism = @('BookWriteGuard.ps1', 'BookManifestTransaction.ps1')
$helpers = @(Get-ChildItem -LiteralPath $tools -File -Filter '*.ps1' |
    Where-Object { $_.Name -cnotin $mechanism -and -not $_.Name.StartsWith('Test-') })

Test-Case 'the static scan has helpers to scan' {
    Assert-True ($helpers.Count -gt 10) "only $($helpers.Count) helpers were scanned"
}

Test-Case 'a mutation window named only in a synopsis does not count as a call' {
    # The regression for a 2026-08-19 finding. Every rule below reads "does this helper call
    # Enter-BookMutation", and the line filter only skipped lines beginning with '#' -- so a <# #>
    # synopsis naming the function satisfied all of them. Update-BookManifests.ps1 documents the
    # window in its .DESCRIPTION, and a mutation that ripped both calls out of it left the census
    # and the locks-without-a-window rule green. Documentation must never answer this question.
    $documented = @'
<#
    This helper calls Enter-BookMutation and Complete-BookMutation and Restore-BookJournal.
#>
$lock = Enter-BookLock -Workspace $w -BookRoot "shelf/$slug"
'@
    Assert-True (-not (Test-CallsFunction $documented 'Enter-BookMutation')) 'a block comment counted as a call to Enter-BookMutation'
    Assert-True (-not (Test-CallsFunction $documented 'Complete-BookMutation')) 'a block comment counted as a call to Complete-BookMutation'
    Assert-True (Test-CallsFunction $documented 'Enter-BookLock') 'a real call outside the block comment was not seen'
    Assert-True (@(Get-BookLockCall $documented).Count -eq 1) 'the real Enter-BookLock call was not found by the lock scan'
    Assert-True (@(Get-BookLockCall $documented)[0].book_root -cmatch 'shelf/') 'the lock scan did not read the Book root from the call'
}

Test-Case 'a function name used as data does not count as a call' {
    # The 2026-09-06 sibling of the case above, and the same defect one layer in. A gate check that
    # compares AST command names against these functions holds their names as STRINGS, and the line
    # scan classified Invoke-LibraryChecks.ps1 -- which writes nothing and locks nothing -- as a
    # routed Shelf writer. A quoted name is not a call, and neither is one inside a throw message.
    $inspects = @'
$names = @('Enter-BookMutation', 'Enter-BookLock')
if ($names -ccontains 'Complete-BookMutation') {
    throw "Enter-BookLock and Enter-BookMutation are inside one try again, so book_root is unguarded"
}
'@
    Assert-True (-not (Test-CallsFunction $inspects 'Enter-BookMutation')) 'a quoted function name counted as a call to Enter-BookMutation'
    Assert-True (-not (Test-CallsFunction $inspects 'Complete-BookMutation')) 'a quoted function name counted as a call to Complete-BookMutation'
    Assert-True (-not (Test-CallsFunction $inspects 'Enter-BookLock')) 'a function name inside a throw message counted as a call'
    Assert-True (-not @(Get-BookLockCall $inspects).Count) 'a quoted Enter-BookLock counted as a Book lock'
}

Test-Case 'every helper that locks a Shelf Book opens a mutation window' {
    # The signal is the lock's Book root, not the mere presence of Enter-BookLock: Set-TopicOverlap
    # locks 'internal/overlap-records' and Invoke-LibraryTriage's BATCH lock is 'triage/<batch>', and
    # neither names a Book. The exemption is therefore visible in the call itself rather than in a
    # list here that a future writer could quietly join -- and Invoke-LibraryTriage is caught anyway,
    # because its in-place kinds take the source Book's own lock by book_root.
    $missing = @()
    foreach ($helper in $helpers) {
        $text = [IO.File]::ReadAllText($helper.FullName)
        # Read from the call's own -BookRoot argument, not from the source line. A line scan also
        # matched a prose mention or a quoted name anywhere on the line, so a file that merely
        # DISCUSSES Enter-BookLock beside the words 'book_root' was required to open a mutation
        # window it has no business opening. Same false positive as Test-CallsFunction's, one
        # argument further in.
        $bookLocks = @(Get-BookLockCall $text | Where-Object { $_.book_root -cmatch 'shelf/|book_root' })
        if (-not $bookLocks.Count) { continue }
        if (-not (Test-CallsFunction $text 'Enter-BookMutation')) { $missing += $helper.Name }
    }
    Assert-True (-not $missing.Count) "these helpers lock a Shelf Book and never open a mutation window: $($missing -join ', ')"
}

Test-Case 'every writer that can roll back can also clear its marker' {
    # A rollback that verified puts the Book back into the state the committed manifest already
    # describes. Leaving the marker down there would make the Book read unavailable forever with
    # nothing left for a rebuild to repair.
    $missing = @()
    foreach ($helper in $helpers) {
        $text = [IO.File]::ReadAllText($helper.FullName)
        if (-not (Test-CallsFunction $text 'Enter-BookMutation')) { continue }
        if (-not (Test-CallsFunction $text 'Restore-BookJournal')) { continue }
        if (-not (Test-CallsFunction $text 'Undo-BookMutation')) { $missing += $helper.Name }
    }
    Assert-True (-not $missing.Count) "these writers roll back without clearing the marker: $($missing -join ', ')"
}

Test-Case 'every mutation window that is opened is also closed or its removed Book store is retired' {
    $missing = @()
    foreach ($helper in $helpers) {
        $text = [IO.File]::ReadAllText($helper.FullName)
        if (-not (Test-CallsFunction $text 'Enter-BookMutation')) { continue }
        if (-not (Test-CallsFunction $text 'Complete-BookMutation|Complete-BookRenameMutation|Remove-BookManifestStore')) { $missing += $helper.Name }
    }
    Assert-True (-not $missing.Count) "these writers open a mutation window and never commit it: $($missing -join ', ')"
}

Test-Case 'the routed Shelf writers are the ones the scan found' {
    # Not the enforcement -- the rules above are. This records which helpers the scan classifies as
    # Shelf writers today, so a change in that set is visible in a diff instead of silent. The
    # fifth is not a writer in the same sense -- Update-BookManifests changes no Book, it
    # regenerates manifests -- but it takes the same lock and opens the same window, and the
    # census records what the scan classifies rather than defining it.
    $routed = @($helpers | Where-Object { Test-CallsFunction ([IO.File]::ReadAllText($_.FullName)) 'Enter-BookMutation' } |
        ForEach-Object { $_.Name } | Sort-Object)
    # Update-SharedBookManifests.ps1 is rung 7's and writes no Shelf Book, but it opens the same
    # mutation window for shared Books, so the scan finds it. It is listed here rather than filtered
    # out: the point of this census is that a writer appearing in the scan is a writer someone
    # decided about, and quietly excluding a whole collection would be the way to lose the next one.
    # Archive-ShelfBook.ps1 is a a special case worth knowing about: its RESTORE path closes its
    # window with Complete-BookMutation, which is what satisfies the static rule above, but its
    # ARCHIVE path closes its window by REMOVING the store outright -- there is no Book left at
    # shelf/<slug> to generate a manifest from. So for that path the static rule passes for the
    # wrong reason, and the behavioural case below is the one that actually covers it.
    $expected = @('Add-ShelfBookPage.ps1', 'Add-ShelfNote.ps1', 'Archive-ShelfBook.ps1', 'Invoke-LibraryTriage.ps1', 'Remove-ShelfBook.ps1', 'Rename-ShelfBook.ps1', 'Set-ShelfBookPageStub.ps1', 'Update-BookManifests.ps1', 'Update-SharedBookManifests.ps1')
    Assert-Equal ($expected -join ', ') ($routed -join ', ') 'the set of routed Shelf writers'
}

Write-Host ''
Write-Host 'The behavioural half: each writer leaves a manifest that describes the Book'

# --- Add-ShelfNote ----------------------------------------------------------------------------------

Test-Case 'capturing a note commits a manifest generation' {
    $r = & $addNote -Title 'First capture' -Content "Body of the first capture." -BookSlug 'holding' -WorkspacePath $fixture
    Assert-Equal 'captured' $r.status 'the capture status'
    Assert-True ($r.manifest -cmatch '^generation \d+ committed$') "the reported manifest state was '$($r.manifest)'"
    $read = Assert-ManifestCurrent $fixture 'holding' 'after a capture'
    Assert-Equal '1' ([string]$read.generation) 'the first committed generation'
    Assert-Equal 'capture' $read.manifest.kind 'the stored kind'
    Assert-Equal 'withheld' $read.manifest.page_metadata 'the stored page metadata'
    Assert-Equal '1' ([string]$read.manifest.pending_count) 'the stored pending count'
}

Test-Case 'a second capture advances the generation and the counts' {
    & $addNote -Title 'Second capture' -Content "Body of the second capture." -BookSlug 'holding' -WorkspacePath $fixture | Out-Null
    $read = Assert-ManifestCurrent $fixture 'holding' 'after a second capture'
    Assert-Equal '2' ([string]$read.generation) 'the second committed generation'
    Assert-Equal '2' ([string]$read.manifest.pending_count) 'the stored pending count'
}

Test-Case 'the capture leak canary holds through the real writer' {
    # Rung 1 asserted this against a generated object and rung 2 against a fixture file. This is the
    # first time it is asserted against a file the reader's own capture helper wrote.
    $store = Get-BookManifestStorePath -Workspace $fixture -Slug 'holding'
    $committed = [IO.File]::ReadAllText((Join-Path $store 'current.json'))
    $generation = [IO.File]::ReadAllText((Join-Path $store "generations/$(Get-Generation $fixture 'holding').json"))
    foreach ($text in @($committed, $generation)) {
        Assert-True ($text -cnotmatch 'First capture') 'a capture note title reached the stored manifest'
        Assert-True ($text -cnotmatch 'Body of the first capture') 'a capture note body reached the stored manifest'
        Assert-True ($text -cnotmatch 'first-capture') 'a capture note path reached the stored manifest'
    }
}

# --- Invoke-LibraryTriage, in-place kinds -----------------------------------------------------------
#
# These three used to be Move-ShelfNote's modes. They still write inside the source capture Book, so
# they still take that Book's lock and open its mutation window; what changed is that they now do it
# from inside the batch runner, which is the place a merge could most easily have dropped the window
# and left the manifest describing a Book that has moved on.

# One action's result. The single-note surface composes a one-action plan, so its report is a batch
# report of one.
function Get-Only($Report) {
    $outcomes = @($Report.outcomes)
    if ($outcomes.Count -ne 1) { throw "expected one outcome, got $($outcomes.Count)" }
    if ($outcomes[0].state -cne 'succeeded') { throw "the action did not succeed: $($outcomes[0].error)" }
    $outcomes[0].result
}

Test-Case 'marking a note reviewed commits a generation' {
    $before = Get-Generation $fixture 'holding'
    $r = Get-Only (& $triage -Source Holding -BookSlug 'holding' -MatchText 'First capture' -To Review -WorkspacePath $fixture)
    Assert-Equal 'updated' $r.status 'the review status'
    Assert-True ($r.manifest -cmatch '^generation \d+ committed$') "the reported manifest state was '$($r.manifest)'"
    $read = Assert-ManifestCurrent $fixture 'holding' 'after a review'
    Assert-True ([int]$read.generation -gt $before) 'the review did not advance the committed generation'
    Assert-Equal '1' ([string]$read.manifest.pending_count) 'the stored pending count after a review'
}

Test-Case 'a review that changes nothing opens no window' {
    # The note is already done. Nothing is written, so nothing may be marked dirty: a marker with no
    # mutation behind it is a Book that reads unavailable with nothing to repair.
    $before = Get-Generation $fixture 'holding'
    $r = Get-Only (& $triage -Source Holding -BookSlug 'holding' -MatchText 'First capture' -To Review -WorkspacePath $fixture)
    Assert-Equal 'unchanged' $r.status 'the second review status'
    Assert-Equal ([string]$before) ([string](Get-Generation $fixture 'holding')) 'an unchanged review moved the generation'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path (Get-BookManifestStorePath -Workspace $fixture -Slug 'holding') 'dirty.json'))) 'an unchanged review left a dirty marker'
}

Test-Case 'copying a note to the Notebook commits a generation' {
    $before = Get-Generation $fixture 'holding'
    # Its own topic, not 'graphics': a triaged note carries frontmatter rather than a leading H1, and
    # the graduation case below reads every article under notebook/graphics.
    $r = Get-Only (& $triage -Source Holding -BookSlug 'holding' -MatchText 'Second capture' -To Notebook -Topic 'triaged' -WorkspacePath $fixture)
    Assert-Equal 'copied' $r.status 'the notebook status'
    Assert-True ($r.manifest -cmatch '^generation \d+ committed$') "the reported manifest state was '$($r.manifest)'"
    $read = Assert-ManifestCurrent $fixture 'holding' 'after a notebook copy'
    Assert-True ([int]$read.generation -gt $before) 'a notebook copy did not advance the committed generation'
    Assert-Equal '0' ([string]$read.manifest.pending_count) 'the stored pending count after a notebook copy'
}

Test-Case 'discarding a note commits a generation' {
    $pre = & $triage -Source Holding -BookSlug 'holding' -MatchText 'Second capture' -To Discard -WorkspacePath $fixture -Preflight
    $before = Get-Generation $fixture 'holding'
    $r = Get-Only (& $triage -Source Holding -BookSlug 'holding' -MatchText 'Second capture' -To Discard -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $pre.plan_id)
    Assert-Equal 'discarded' $r.status 'the discard status'
    $read = Assert-ManifestCurrent $fixture 'holding' 'after a discard'
    Assert-True ([int]$read.generation -gt $before) 'a discard did not advance the committed generation'
    Assert-Equal '1' ([string]$read.manifest.page_count) 'the stored page count after a discard'
}

Test-Case 'a note that landed stays landed when its manifest cannot be committed' {
    # The promise that makes this routing safe to put in front of capture. Capture is deliberately
    # ungated because a note that costs anything stops being written down, so a manifest problem must
    # never unwind into the rollback and take the note with it. The commit pointer is held open by
    # another process here, so the commit fails after the note has already landed.
    Assert-ManifestCurrent $fixture 'holding' 'before the blocked commit' | Out-Null
    $pointer = Join-Path (Get-BookManifestStorePath -Workspace $fixture -Slug 'holding') 'current.json'
    $held = [IO.File]::Open($pointer, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $r = & $addNote -Title 'Survives a blocked commit' -Content "Body that must survive." -BookSlug 'holding' -WorkspacePath $fixture
        Assert-Equal 'captured' $r.status 'the capture status when the manifest could not be committed'
        Assert-True ($r.manifest -cmatch '^dirty until rebuilt: ') "the reported manifest state was '$($r.manifest)'"
    }
    finally { $held.Dispose() }
    $notes = @(Get-ChildItem -LiteralPath (Join-Path $fixture 'shelf/holding/wiki/notes') -File -Filter '*survives-a-blocked-commit*')
    Assert-Equal '1' ([string]$notes.Count) 'the note that survived a blocked commit'
    Assert-Equal 'dirty' (Get-StoredBookManifest -Workspace $fixture -Slug 'holding').status 'the store after a blocked commit'
}

Test-Case 'a failure mid-mutation leaves the Book dirty, which is what proves the marker came first' {
    # The ordering canary, and the only case here that can tell the two designs apart. A writer that
    # committed its manifest only AFTER its writes would leave this Book reading `ok` with a note it
    # has already deleted -- a stale manifest that answers. Triage's in-place kinds journal nothing
    # per note and roll nothing back, so the marker stays down and the store refuses, which is the
    # truthful state.
    & $addNote -Title 'Doomed capture' -Content "Body of the doomed capture." -BookSlug 'holding' -WorkspacePath $fixture | Out-Null
    Assert-ManifestCurrent $fixture 'holding' 'before the mid-mutation failure' | Out-Null
    $notes = Join-Path $fixture 'shelf/holding/wiki/notes'
    $noteFile = @(Get-ChildItem -LiteralPath $notes -File -Filter '*doomed-capture*')[0]
    $pre = & $triage -Source Holding -BookSlug 'holding' -MatchText 'Doomed capture' -To Discard -WorkspacePath $fixture -Preflight
    $map = Join-Path $fixture 'shelf/holding/wiki/_index.md'
    (Get-Item -LiteralPath $map -Force).IsReadOnly = $true
    $threw = $false
    try { & $triage -Source Holding -BookSlug 'holding' -MatchText 'Doomed capture' -To Discard -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $pre.plan_id | Out-Null }
    catch { $threw = $true }
    finally { (Get-Item -LiteralPath $map -Force).IsReadOnly = $false }
    Assert-True $threw 'the discard succeeded despite an unwritable reader map'
    Assert-True (-not (Test-Path -LiteralPath $noteFile.FullName)) 'the note survived, so this case proved nothing about a half-done mutation'
    Assert-Equal 'dirty' (Get-StoredBookManifest -Workspace $fixture -Slug 'holding').status 'the store after a half-done mutation'
}

# --- Add-ShelfBookPage ------------------------------------------------------------------------------

Test-Case 'adding a page commits a manifest that lists it' {
    $r = & $addPage -BookSlug 'demo' -PagePath 'graduated/one' -Content "# Graduated one`n`nBody.`n`n## A section`n" -WorkspacePath $fixture
    Assert-Equal 'added' $r.status 'the page status'
    Assert-True ($r.manifest -cmatch '^generation \d+ committed$') "the reported manifest state was '$($r.manifest)'"
    $read = Assert-ManifestCurrent $fixture 'demo' 'after a page add'
    $paths = @($read.manifest.pages | ForEach-Object { $_.path })
    Assert-True ('graduated/one' -cin $paths) "the new page is not in the committed manifest: $($paths -join ', ')"
    Assert-Equal 'full' $read.manifest.page_metadata 'a curated Book withheld its page metadata'
}

Test-Case 'a rolled-back page add leaves no dirty marker' {
    # The map is made read-only so the write after the page lands throws. The page is rolled back and
    # verified, so the Book is back to the state the committed manifest describes -- and the marker
    # must come up with it, or the Book refuses forever over a write that did not happen.
    $store = Get-BookManifestStorePath -Workspace $fixture -Slug 'demo'
    $before = Get-Generation $fixture 'demo'
    $map = Join-Path $fixture 'shelf/demo/wiki/_index.md'
    (Get-Item -LiteralPath $map -Force).IsReadOnly = $true
    $refused = $false
    try { & $addPage -BookSlug 'demo' -PagePath 'graduated/doomed' -Content "# Doomed`n`nBody.`n" -WorkspacePath $fixture | Out-Null }
    catch { $refused = $true }
    finally { (Get-Item -LiteralPath $map -Force).IsReadOnly = $false }
    Assert-True $refused 'the page add succeeded despite an unwritable reader map'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $store 'dirty.json'))) 'a verified rollback left the Book marked dirty'
    Assert-Equal ([string]$before) ([string](Get-Generation $fixture 'demo')) 'a rolled-back add moved the committed generation'
    Assert-ManifestCurrent $fixture 'demo' 'after a rolled-back page add' | Out-Null
}

# --- Set-ShelfBookPageStub --------------------------------------------------------------------------

Test-Case 'stubbing a page commits a manifest that describes the stub, not the page it replaced' {
    # The one writer here whose page SURVIVES with different content. The path is unchanged, so a
    # manifest that merely lists the page would look correct while describing a heading that no
    # longer exists -- which is the whole failure mode Discovery would then answer from.
    & $addPage -BookSlug 'demo' -PagePath 'graduated/dupe' -Content "# Duplicated topic`n`nBody.`n`n## A heading only the original has`n" -WorkspacePath $fixture | Out-Null
    $before = Get-Generation $fixture 'demo'
    $pre = & $stub -BookSlug 'demo' -PagePath 'graduated/dupe' -CanonicalBook 'Canonical Demo' -CanonicalPage 'topic/page' -SupersededOn '2026-08-20' -WorkspacePath $fixture -Preflight
    $r = & $stub -BookSlug 'demo' -PagePath 'graduated/dupe' -CanonicalBook 'Canonical Demo' -CanonicalPage 'topic/page' -SupersededOn '2026-08-20' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $pre.plan_id
    Assert-Equal 'stubbed' $r.status 'the stub status'
    Assert-True ($r.manifest -cmatch '^generation \d+ committed$') "the reported manifest state was '$($r.manifest)'"
    Assert-True ((Get-Generation $fixture 'demo') -gt $before) 'stubbing a page did not advance the committed generation'
    $read = Assert-ManifestCurrent $fixture 'demo' 'after a page stub'
    $paths = @($read.manifest.pages | ForEach-Object { $_.path })
    Assert-True ('graduated/dupe' -cin $paths) "the stubbed page left the manifest entirely: $($paths -join ', ')"
    $headings = @($read.manifest.pages | Where-Object { $_.path -ceq 'graduated/dupe' } | ForEach-Object { @($_.headings) } )
    Assert-True (-not (@($headings) -ccontains 'A heading only the original has')) 'the manifest still describes the replaced body'
}

Test-Case 'an identical stub opens no mutation window at all' {
    # Idempotence has to reach the manifest too: a retry that writes nothing must not burn a
    # generation, or a resumed run would look like a change to everything downstream.
    $before = Get-Generation $fixture 'demo'
    $r = & $stub -BookSlug 'demo' -PagePath 'graduated/dupe' -CanonicalBook 'Canonical Demo' -CanonicalPage 'topic/page' -SupersededOn '2026-08-20' -WorkspacePath $fixture
    Assert-Equal 'already-stubbed' $r.status 'the repeat status'
    Assert-Equal ([string]$before) ([string](Get-Generation $fixture 'demo')) 'a no-op stub advanced the committed generation'
    Assert-ManifestCurrent $fixture 'demo' 'after a no-op stub' | Out-Null
}

# --- Archive-ShelfBook ------------------------------------------------------------------------------

Test-Case 'archiving a Book removes its manifest store rather than leaving it dirty' {
    # The one writer that closes its window by REMOVING the store: there is no Book left at
    # shelf/<slug> to generate a manifest from. The static rule above cannot see that, so this is
    # what actually covers it -- and what would catch a marker left down, which would make the slug
    # refuse forever with nothing left for a rebuild to repair.
    $store = Get-BookManifestStorePath -Workspace $fixture 'demo'
    Assert-True (Test-Path -LiteralPath $store -PathType Container) 'the fixture Book has no manifest store to retire'
    Write-Fixture (Get-DeskFileRelativePath -Seat 'fixture' -Kind 'books') "shelf/holding`n"
    $pre = & $archiveBook -Action Archive -BookSlug 'demo' -WorkspacePath $fixture -Preflight
    $r = & $archiveBook -Action Archive -BookSlug 'demo' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $pre.plan_id
    Assert-Equal 'archived' $r.status 'the archive status'
    Assert-True (-not (Test-Path -LiteralPath $store)) 'the archived Book kept its manifest store'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $store 'dirty.json'))) 'the archived Book was left marked dirty'
}

Test-Case 'restoring a Book generates it a fresh manifest' {
    $restorePre = & $archiveBook -Action Restore -BookSlug 'demo' -WorkspacePath $fixture -Preflight
    $r = & $archiveBook -Action Restore -BookSlug 'demo' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $restorePre.plan_id
    Assert-Equal 'restored' $r.status 'the restore status'
    Assert-True ($r.manifest -cmatch '^generation \d+ committed$') "the reported manifest state was '$($r.manifest)'"
    $read = Assert-ManifestCurrent $fixture 'demo' 'after a restore'
    $paths = @($read.manifest.pages | ForEach-Object { $_.path })
    Assert-True ('existing' -cin $paths) "the restored Book's manifest does not list its pages: $($paths -join ', ')"
    Write-Fixture (Get-DeskFileRelativePath -Seat 'fixture' -Kind 'books') "shelf/demo`nshelf/holding`n"
}

# --- Add-ShelfBookTopic -----------------------------------------------------------------------------

Test-Case 'graduating a topic inherits the routing, one generation per page' {
    $before = Get-Generation $fixture 'demo'
    $r = & $addTopic -BookSlug 'demo' -SourcePath 'notebook/graphics' -PagePrefix 'topic' -WorkspacePath $fixture
    Assert-Equal 'complete' $r.status 'the graduation status'
    Assert-Equal '2' ([string]$r.pages_succeeded) 'the pages graduated'
    $read = Assert-ManifestCurrent $fixture 'demo' 'after a topic graduation'
    Assert-Equal ([string]($before + 2)) ([string]$read.generation) 'one committed generation per graduated page'
    $paths = @($read.manifest.pages | ForEach-Object { $_.path })
    foreach ($page in @('topic/one', 'topic/two')) {
        Assert-True ($page -cin $paths) "$page is not in the committed manifest"
    }
}

# --- Rename-ShelfBook -------------------------------------------------------------------------------

Test-Case 'a title-only rename keeps the identity and commits the next generation' {
    $before = Get-Generation $fixture 'demo'
    $pre = & $rename -Slug 'demo' -NewSlug 'demo' -NewTitle 'Fixture Demo Retitled' -WorkspacePath $fixture -Preflight
    $r = & $rename -Slug 'demo' -NewSlug 'demo' -NewTitle 'Fixture Demo Retitled' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $pre.plan_id
    Assert-Equal 'renamed' $r.status 'the rename status'
    $read = Assert-ManifestCurrent $fixture 'demo' 'after a title-only rename'
    Assert-Equal ([string]($before + 1)) ([string]$read.generation) 'a title-only rename did not advance the generation'
    Assert-Equal 'Fixture Demo Retitled' $read.manifest.title 'the committed manifest title'
}

Test-Case 'a slug change retires the old store rather than orphaning it' {
    # The limit rung 2 recorded and rung 4 owns: Rename-ShelfBook knew nothing about
    # internal/book-manifests/, so the old slug's directory survived as a manifest describing a Book
    # at a path that no longer exists.
    $oldStore = Get-BookManifestStorePath -Workspace $fixture -Slug 'demo'
    Assert-True (Test-Path -LiteralPath $oldStore) 'the fixture has no store to retire'
    $pre = & $rename -Slug 'demo' -NewSlug 'renamed' -WorkspacePath $fixture -Preflight
    $r = & $rename -Slug 'demo' -NewSlug 'renamed' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $pre.plan_id
    Assert-Equal 'renamed' $r.status 'the rename status'
    Assert-True ($r.manifest -cmatch 'was retired') "the rename did not report retiring the old store: '$($r.manifest)'"
    Assert-True (-not (Test-Path -LiteralPath $oldStore)) 'the renamed Book left its old store behind as an orphan'
    $read = Assert-ManifestCurrent $fixture 'renamed' 'after a slug change'
    Assert-Equal '1' ([string]$read.generation) 'the new identity did not start at generation 1'
    Assert-Equal 'renamed' $read.manifest.slug 'the committed manifest slug'
}

Test-Case 'a refused rename leaves the Book available' {
    # Nothing was written, so nothing may be left marked dirty.
    $before = Get-Generation $fixture 'renamed'
    $refused = $false
    try { & $rename -Slug 'renamed' -NewSlug 'holding' -WorkspacePath $fixture -Preflight | Out-Null }
    catch { $refused = $true }
    Assert-True $refused 'a rename onto an existing Book was allowed'
    Assert-Equal ([string]$before) ([string](Get-Generation $fixture 'renamed')) 'a refused rename moved the generation'
    Assert-ManifestCurrent $fixture 'renamed' 'after a refused rename' | Out-Null
}

}
catch {
    # A strict-mode error outside a case body would otherwise unwind past every remaining case and
    # let this suite exit green having run a fraction of itself.
    $script:failed += "the suite did not run to completion -- $($_.Exception.Message)"
    Write-Host "  FAIL  the suite did not run to completion -- $($_.Exception.Message)"
}
finally {
    # The claim is an open handle; let go before removing the directory that holds it.
    Exit-FixtureSeatClaim
    if (-not $KeepFixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
if ($script:failed.Count) {
    Write-Host "FAILED: $($script:failed.Count) of $($script:passed + $script:failed.Count)"
    foreach ($failure in $script:failed) { Write-Host "  - $failure" }
    exit 1
}
Write-Host "All $($script:passed) cases passed."
