<#
Rung 5 of Plan item 2.2: the suite for Update-BookManifests.ps1, the local Shelf manifest
backfill.

After rung 4, a Shelf Book gets a manifest the first time something mutates it, and nothing has
backfilled the Books nothing has touched. This suite proves the pass that fixes that, plus the
things that make it safe to run at all:

  - every Book commits at generation 1 with a digest a fresh generation matches, and a second
    run is idempotent;
  - -Rebuild advances one generation per Book and reports which Book was edited out of band;
  - the default mode is the repair rung 4 named ("dirty until rebuilt") but did not build;
  - a capture Book's note titles, note paths, and note bodies reach neither the stored
    generation nor this helper's own output;
  - a locked Book is skipped leaving no marker; a Book whose generation fails reads dirty and
    does not abort the run;
  - the journal resumes only what the store confirms, and a journal from another scope or an
    unreadable one is treated as absent;
  - prune removes an orphan store, keeps an unresolved one, and touches nothing catalogued;
  - a run whose scope holds a closed Book is refused without the exact approval, and a -Book
    run over the one open Book needs none.

Everything runs against a disposable fixture workspace under the system temp directory. The
reader's Shelf, Notebook, and Virtual Desk are never touched. The helper itself is always run as
a separate powershell.exe process, because its contract includes a non-zero exit code and that
cannot be observed from inside this process. Exit code 0 means every case passed.

    tools/Test-ManifestBackfill.ps1
#>
[CmdletBinding()]
param([switch]$KeepFixture)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'BookManifestTransaction.ps1')
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
# Fixtures work at a seat named 'fixture'. Set in this process so CHILD helper processes
# inherit it: they default -Seat to LIBRARY_SEAT, and there is no default seat to fall back on.
$env:LIBRARY_SEAT = 'fixture'

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

# The whole point of the behavioural half: not "was a call made" but "does the stored manifest
# describe the Book as it now stands". A digest comparison against a fresh generation is what a
# stale manifest cannot survive.
function Assert-ManifestCurrent([string]$Workspace, [string]$Slug, [string]$What) {
    $read = Get-StoredBookManifest -Workspace $Workspace -Slug $Slug
    if ($read.status -cne 'ok') { throw "$What -- the store reads '$($read.status)', not 'ok'" }
    $fresh = New-BookManifest -Workspace $Workspace -Slug $Slug
    if ($read.source_digest -cne $fresh.source_digest) { throw "$What -- the committed manifest does not describe the Book as it now stands" }
    $read
}

# The helper is a process, not a function: its contract includes a non-zero exit code for a run
# that left a Book dirty, and `exit` from an in-process & call would end this suite instead.
function Invoke-Backfill([string[]]$ArgumentList) {
    $lines = @()
    # Scoped Continue, not the suite's Stop: with Stop, a child that refuses writes to stderr and
    # the record arrives here as a terminating error -- losing the exit code this suite exists to
    # observe. Continue keeps the records as output and leaves LASTEXITCODE intact.
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $lines = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $backfill @ArgumentList 2>&1) }
    finally { $ErrorActionPreference = $old }
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = $lines }
}

function Get-ResultJson($Invocation) {
    $jsonLines = @($Invocation.Lines | Where-Object { $_ -and $_.ToString().Trim().StartsWith('{') })
    if (-not $jsonLines.Count) { throw "the helper produced no JSON result; output was: $(($Invocation.Lines -join ' | '))" }
    ($jsonLines[-1] | ConvertFrom-Json)
}

# Preflight, then run with that plan's exact approval. Every full-scope fixture run needs it,
# because the fixture deliberately keeps two of its three Books closed. ExtraArgs go to the
# preflight too: the plan_id covers the mode, so a -Rebuild run must be approved by a -Rebuild
# preflight's plan_id.
function Approve-And-Run([string[]]$ExtraArgs = @()) {
    $preArgs = @('-Preflight', '-Json', '-WorkspacePath', $fixture)
    if ($ExtraArgs.Count) { $preArgs += $ExtraArgs }
    $pre = Invoke-Backfill $preArgs
    Assert-True ($pre.ExitCode -eq 0) "the preflight failed: $($pre.Lines -join ' | ')"
    $prePlan = Get-ResultJson $pre
    $runArgs = @('-WorkspacePath', $fixture, '-Json', '-UserConfirmed', '-ApprovedPlanId', ([string]$prePlan.plan_id))
    if ($ExtraArgs.Count) { $runArgs += $ExtraArgs }
    $run = Invoke-Backfill $runArgs
    [pscustomobject]@{ Plan = (Get-ResultJson $run); ExitCode = $run.ExitCode; Lines = $run.Lines }
}

function Get-StoreStatus([string]$Slug) { (Get-StoredBookManifest -Workspace $fixture -Slug $Slug).status }

# --- fixture ---------------------------------------------------------------------------------------

$fixture = Join-Path ([IO.Path]::GetTempPath()) "library-manifest-backfill-$([guid]::NewGuid().ToString('n').Substring(0, 8))"
$utf8 = [Text.UTF8Encoding]::new($false)

function Write-Fixture([string]$Relative, [string]$Text) {
    $path = Join-Path $fixture $Relative
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($path, $Text, $utf8)
}

try {

New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/demo/wiki/topic') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/plain/wiki') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/inbox/wiki/notes') -Force | Out-Null
Write-Fixture 'shelf/_catalog.md' @'
# Local Shelf

## Fixture Demo
- **Summary:** fixture curated Book with a reader map
- **Topics:** demo, backfill
- **Path:** shelf/demo

## Fixture Plain
- **Summary:** fixture curated Book without a reader map
- **Topics:** plain, backfill
- **Path:** shelf/plain

## Fixture Inbox
- **Summary:** fixture capture Book
- **Topics:** capture, backfill
- **Kind:** capture
- **Path:** shelf/inbox
'@
Write-Fixture 'shelf/demo/wiki/_book.md' "# Fixture Demo`n`n- **Type:** fixture`n"
Write-Fixture 'shelf/demo/wiki/_index.md' "# Fixture Demo - Reader Map`n`n- [[_book|Book metadata]]`n- [[topic/plain|Plain topic]]`n"
# A compiled article carrying an upstream pin, so the schema-2 roll-up has something real to
# collect through the backfill's own path rather than only through the generator's self-test.
$fixtureOid = '0123456789abcdef0123456789abcdef01234567'
$fixtureHash = 'a' * 64
Write-Fixture 'shelf/demo/wiki/topic/plain.md' ("# Real Title`n`nBody text.`n`n## A Real Section`n`n## Sources`n`n" +
    "- Upstream ``https://github.com/obsidianmd/obsidian-help`` ref ``refs/heads/master`` at ``$fixtureOid``; repo root ``raw/obsidian-help``; captured ``2026-09-04```n" +
    "- ``raw/obsidian-help/en/a.md`` - SHA-256 ``$fixtureHash``; provenance: ``external```n")
Write-Fixture 'shelf/plain/wiki/_book.md' "# Fixture Plain`n`n- **Type:** fixture`n"
Write-Fixture 'shelf/inbox/wiki/_book.md' "# Fixture Inbox`n`n- **Kind:** capture`n"
Write-Fixture 'shelf/inbox/wiki/_index.md' "# Fixture Inbox - Reader Map`n`n- [[notes/secret-note|Sekrit Capture Title]]`n- [[notes/second-note|Confidential Note Two]]`n"
# The capture canary needs anchor data to leak, not merely an absence of it.
Write-Fixture 'shelf/inbox/wiki/notes/secret-note.md' ("---`ncaptured: 2026-08-18T00:00:00Z`nreview: pending`n---`n`n# Sekrit Capture Title`n`nUnvetted body.`n`n## Sources`n`n" +
    "- Upstream ``https://github.com/private-org/secret-repo`` ref ``refs/heads/main`` at ``$fixtureOid``; repo root ``raw/secret``; captured ``2026-09-04```n" +
    "- ``raw/secret/x.md`` - SHA-256 ``$fixtureHash``; provenance: ``external```n")
Write-Fixture 'shelf/inbox/wiki/notes/second-note.md' "---`ncaptured: 2026-08-18T00:00:00Z`nreview: done`n---`n`n# Confidential Note Two`n`nSecond body text.`n"
Write-Fixture (Get-DeskFileRelativePath -Seat 'fixture' -Kind 'books') "shelf/demo`n"
Write-Fixture (Get-DeskFileRelativePath -Seat 'fixture' -Kind 'projects') ''

Write-Host "Fixture: $fixture"
Write-Host ''

# --- 1. the first backfill --------------------------------------------------------------------------

Test-Case 'backfill commits every Book at generation 1 with a matching digest' {
    $run = Approve-And-Run
    Assert-True ($run.ExitCode -eq 0) "the backfill exited $($run.ExitCode): $($run.Lines -join ' | ')"
    $plan = $run.Plan
    Assert-Equal 'complete' $plan.status 'the run status'
    Assert-Equal 'backfill' $plan.mode 'the run mode'
    Assert-Equal '3' ([string]$plan.books_total) 'the books total'
    Assert-Equal '3' ([string]$plan.books_to_write) 'the books to write'
    Assert-Equal '2' ([string]$plan.books_closed) 'the closed Books in scope'
    Assert-True $plan.confirmation_required 'the fixture run did not require approval'
    foreach ($slug in @('demo', 'plain', 'inbox')) {
        $book = @($plan.books | Where-Object { $_.slug -ceq $slug })[0]
        Assert-Equal 'committed' $book.status "the $slug status after backfill"
        Assert-Equal 'backfill' $book.action "the $slug action"
        $read = Assert-ManifestCurrent $fixture $slug 'after the first backfill'
        Assert-Equal '1' ([string]$read.generation) "the $slug committed generation"
    }
}

Test-Case 'the schema-2 upstream roll-up lands through the backfill, not only through the generator' {
    $read = Get-StoredBookManifest -Workspace $fixture -Slug 'demo'
    Assert-Equal 'ok' $read.status 'the demo store is not committed'
    Assert-Equal '2' ([string]$read.manifest.schema) 'the committed manifest body schema'
    Assert-Equal '1' ([string]@($read.manifest.anchored_upstreams).Count) 'the rolled-up upstream count'
    Assert-Equal 'https://github.com/obsidianmd/obsidian-help' ([string]$read.manifest.anchored_upstreams[0].url) 'the rolled-up upstream URL'
    Assert-Equal 'refs/heads/master' ([string]$read.manifest.anchored_upstreams[0].ref) 'the rolled-up upstream ref'
    Assert-Equal '0' ([string]$read.manifest.anchor_unreadable) 'a well-formed Sources block was counted as unreadable'
    # repo root is producer-local and must not cross into a closed-readable record.
    $generation = [IO.File]::ReadAllText((Join-Path (Get-BookManifestStorePath -Workspace $fixture -Slug 'demo') "generations/$($read.generation).json"))
    Assert-True ($generation -cnotmatch 'raw/obsidian-help') 'the producer-local repo root reached the committed generation file'
    # A Book with no pinned page reports an empty set, which is not the same state as no field.
    $plainRead = Get-StoredBookManifest -Workspace $fixture -Slug 'plain'
    Assert-Equal '0' ([string]@($plainRead.manifest.anchored_upstreams).Count) 'an unpinned Book invented an upstream'
}

Test-Case 'a second backfill is idempotent' {
    $pre = Get-ResultJson (Invoke-Backfill @('-Preflight', '-Json', '-WorkspacePath', $fixture))
    $run = Invoke-Backfill @('-WorkspacePath', $fixture, '-Json', '-UserConfirmed', '-ApprovedPlanId', ([string]$pre.plan_id))
    $plan = Get-ResultJson $run
    Assert-True ($run.ExitCode -eq 0) "the second backfill exited $($run.ExitCode)"
    Assert-Equal '0' ([string]$plan.books_to_write) 'a second backfill had work to do'
    foreach ($slug in @('demo', 'plain', 'inbox')) {
        $book = @($plan.books | Where-Object { $_.slug -ceq $slug })[0]
        Assert-Equal 'already current' $book.status "the $slug status on the second run"
        Assert-Equal '1' ([string]$book.generation) "the $slug generation advanced on a no-op run"
        Assert-Equal 'ok' (Get-StoreStatus $slug) "the $slug store after a no-op run"
    }
}

# --- -Rebuild ---------------------------------------------------------------------------------------

Test-Case '-Rebuild advances every Book by exactly one generation' {
    $run = Approve-And-Run @('-Rebuild')
    Assert-True ($run.ExitCode -eq 0) "the rebuild exited $($run.ExitCode)"
    $plan = $run.Plan
    Assert-Equal 'rebuild' $plan.mode 'the run mode'
    foreach ($slug in @('demo', 'plain', 'inbox')) {
        $book = @($plan.books | Where-Object { $_.slug -ceq $slug })[0]
        Assert-Equal 'committed' $book.status "the $slug status after rebuild"
        Assert-Equal '2' ([string]$book.generation) "the $slug generation after rebuild"
        Assert-ManifestCurrent $fixture $slug 'after rebuild' | Out-Null
    }
}

Test-Case '-Rebuild reports exactly the Book edited out of band' {
    Write-Fixture 'shelf/demo/wiki/topic/plain.md' "# Real Title`n`nEdited out of band.`n"
    $run = Approve-And-Run @('-Rebuild')
    Assert-True ($run.ExitCode -eq 0) "the rebuild exited $($run.ExitCode)"
    $plan = $run.Plan
    foreach ($slug in @('demo', 'plain', 'inbox')) {
        $book = @($plan.books | Where-Object { $_.slug -ceq $slug })[0]
        # Every Book must actually have been re-read before `changed` means anything. Asserted
        # first because a rebuild that RESUMED instead of regenerating reports changed = $null,
        # and Assert-True would then fail on the cast rather than on the property at issue --
        # a red canary that points at the wrong thing is only half a canary.
        Assert-Equal 'committed' $book.status "the $slug status after the edited rebuild"
        if ($slug -ceq 'demo') {
            Assert-True $book.changed "the edited Book was not reported changed"
            Assert-ManifestCurrent $fixture $slug 'after the edited rebuild' | Out-Null
        }
        else {
            Assert-True (-not $book.changed) "the untouched Book $slug was reported changed"
        }
    }
}

# --- repair, without -Rebuild -----------------------------------------------------------------------

Test-Case 'the default mode repairs a Book the writer left dirty' {
    # demo is the one open Book, so this run needs no approval, and it must NOT be a -Rebuild run:
    # the repair rung 4 named ("dirty until rebuilt") is the default mode's job.
    Set-BookManifestDirty -Workspace $fixture -Slug 'demo' -Reason 'planted by the suite' | Out-Null
    Assert-Equal 'dirty' (Get-StoreStatus 'demo') 'the planted marker did not take'
    $run = Invoke-Backfill @('-WorkspacePath', $fixture, '-Json', '-Book', 'demo')
    Assert-True ($run.ExitCode -eq 0) "the repair exited $($run.ExitCode)"
    $plan = Get-ResultJson $run
    Assert-True (-not $plan.confirmation_required) 'a run over the one open Book demanded approval'
    $book = @($plan.books | Where-Object { $_.slug -ceq 'demo' })[0]
    Assert-Equal 'repair' $book.action "the dirty Book's action"
    Assert-Equal 'committed' $book.status "the dirty Book's status"
    Assert-Equal 'ok' (Get-StoreStatus 'demo') 'the repaired Book still reads dirty'
    Assert-ManifestCurrent $fixture 'demo' 'after the repair' | Out-Null
}

# --- the leak canaries ------------------------------------------------------------------------------

Test-Case 'the capture leak canary holds against the committed generation file' {
    $store = Get-BookManifestStorePath -Workspace $fixture -Slug 'inbox'
    $read = Get-StoredBookManifest -Workspace $fixture -Slug 'inbox'
    Assert-Equal 'ok' $read.status 'the inbox store is not committed'
    $text = [IO.File]::ReadAllText((Join-Path $store "generations/$($read.generation).json"))
    Assert-True ($text -cnotmatch 'Sekrit Capture Title') 'a capture note title reached the committed generation file'
    Assert-True ($text -cnotmatch 'Confidential Note Two') 'a second capture note title reached the committed generation file'
    Assert-True ($text -cnotmatch 'secret-note') 'a capture note path reached the committed generation file'
    Assert-True ($text -cnotmatch 'second-note') 'a second capture note path reached the committed generation file'
    Assert-True ($text -cnotmatch 'Unvetted body') 'capture note body text reached the committed generation file'
    Assert-True ($text -cnotmatch 'Second body text') 'a second capture note body reached the committed generation file'
    Assert-True ($text -cnotmatch 'private-org') 'a capture note''s upstream URL reached the committed generation file'
    Assert-True ($text -cnotmatch 'secret-repo') 'a capture note''s repository name reached the committed generation file'
    Assert-Equal 'withheld' $read.manifest.page_metadata 'the capture manifest did not withhold page metadata'
    Assert-Equal 'capture' $read.manifest.kind 'the capture manifest kind'
    Assert-Equal '0' ([string]@($read.manifest.anchored_upstreams).Count) 'the capture manifest carried anchor data'
}

Test-Case 'the helper itself leaks no note title or note path' {
    $run = Approve-And-Run
    Assert-True ($run.ExitCode -eq 0) "the run exited $($run.ExitCode)"
    $json = @($run.Lines | Where-Object { $_ -and $_.ToString().Trim().StartsWith('{') })[0]
    foreach ($needle in @('Sekrit Capture Title', 'Confidential Note Two', 'secret-note', 'second-note', 'Unvetted body', 'Second body text', 'private-org', 'secret-repo')) {
        Assert-True ($json -cnotmatch [regex]::Escape($needle)) "the -Json result leaks '$needle'"
    }
    $pre = Get-ResultJson (Invoke-Backfill @('-Preflight', '-Json', '-WorkspacePath', $fixture))
    $preJson = $pre | ConvertTo-Json -Depth 12
    foreach ($needle in @('Sekrit Capture Title', 'Confidential Note Two', 'secret-note', 'second-note', 'private-org', 'secret-repo')) {
        Assert-True ($preJson -cnotmatch [regex]::Escape($needle)) "the preflight leaks '$needle'"
    }
}

# --- faults that must not abort the run -------------------------------------------------------------

Test-Case 'a Book locked by another writer is skipped, leaving no marker' {
    # Every store is reset so the other Books have real work: the point of the case is that the
    # locked Book is skipped while the run still commits the rest.
    foreach ($slug in @('demo', 'plain', 'inbox')) { Remove-BookManifestStore -Workspace $fixture -Slug $slug | Out-Null }
    Assert-Equal 'missing' (Get-StoreStatus 'inbox') 'the inbox store was not reset'
    $holder = Enter-BookLock -Workspace $fixture -BookRoot 'shelf/inbox' -TimeoutSeconds 5
    try {
        $run = Approve-And-Run @('-LockTimeoutSeconds', '1')
        Assert-True ($run.ExitCode -eq 0) "the run exited $($run.ExitCode)"
        $plan = $run.Plan
        $inbox = @($plan.books | Where-Object { $_.slug -ceq 'inbox' })[0]
        Assert-Equal 'skipped' $inbox.status "the locked Book's status"
        Assert-Equal 'missing' (Get-StoreStatus 'inbox') 'the locked Book gained a store'
        $inboxStore = Get-BookManifestStorePath -Workspace $fixture -Slug 'inbox'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $inboxStore 'dirty.json'))) 'the locked Book gained a dirty marker'
        foreach ($slug in @('demo', 'plain')) {
            $book = @($plan.books | Where-Object { $_.slug -ceq $slug })[0]
            Assert-Equal 'committed' $book.status "the $slug status alongside the skip"
        }
    }
    finally { Exit-BookLock -Lock $holder }
}

Test-Case 'a Book whose generation fails reads dirty, and the run continues' {
    # The catalog still lists the Book; its pages directory is gone. Generation fails after the
    # marker is down, so the Book must read dirty, the run must exit non-zero, and the Books that
    # still had work must commit anyway.
    Remove-BookManifestStore -Workspace $fixture -Slug 'plain' | Out-Null
    $wiki = Join-Path $fixture 'shelf/plain/wiki'
    Rename-Item -LiteralPath $wiki -NewName 'wiki-removed'
    try {
        $run = Approve-And-Run
        Assert-True ($run.ExitCode -ne 0) 'a run with a failed Book exited zero'
        $plan = $run.Plan
        Assert-Equal 'incomplete' $plan.status 'the run did not report itself incomplete'
        Assert-Equal '1' ([string]$plan.dirty_books) "the dirty count was $($plan.dirty_books)"
        $plain = @($plan.books | Where-Object { $_.slug -ceq 'plain' })[0]
        Assert-Equal 'dirty' $plain.status "the failed Book's status"
        Assert-Equal 'dirty' (Get-StoreStatus 'plain') 'the failed Book does not read dirty'
        $inbox = @($plan.books | Where-Object { $_.slug -ceq 'inbox' })[0]
        Assert-Equal 'committed' $inbox.status 'a failure aborted the run before the remaining Books'
        Assert-Equal 'ok' (Get-StoreStatus 'inbox') 'the remaining Book did not commit'
    }
    finally { Rename-Item -LiteralPath (Join-Path $fixture 'shelf/plain/wiki-removed') -NewName 'wiki' }
}

# --- the journal ------------------------------------------------------------------------------------

Test-Case 'resume trusts only the journal entries the store confirms' {
    foreach ($slug in @('demo', 'plain', 'inbox')) { Remove-BookManifestStore -Workspace $fixture -Slug $slug | Out-Null }
    $run = Approve-And-Run
    Assert-True ($run.ExitCode -eq 0) "the fresh backfill exited $($run.ExitCode)"
    $plan = $run.Plan
    Assert-Equal '3' ([string]$plan.books_to_write) 'the fresh backfill had no work'
    $journalPath = Join-Path $fixture ($plan.journal_path -replace '/', [IO.Path]::DirectorySeparatorChar)
    Assert-True (Test-Path -LiteralPath $journalPath -PathType Leaf) 'the journal was not written'
    $journal = [IO.File]::ReadAllText($journalPath) | ConvertFrom-Json
    $recorded = @($journal.entries.PSObject.Properties | ForEach-Object { $_.Name })
    # Keyed on the Book ROOT since the archives entered search: shelf/x and shelf/_archive/x are two
    # Books sharing one slug, and a slug key would let one overwrite the other's entry.
    Assert-Equal 'shelf/demo, shelf/inbox, shelf/plain' (($recorded | Sort-Object) -join ', ') 'the journal does not record every Book'
    foreach ($bookRoot in $recorded) {
        Assert-Equal 'committed' ([string]$journal.entries.$bookRoot.status) "the journal entry for $bookRoot"
    }
    # Delete the commit pointer of one Book: its journal entry now describes a store that does not
    # confirm it, so it must be regenerated while the others are skipped without regenerating.
    Remove-Item -LiteralPath (Join-Path (Get-BookManifestStorePath -Workspace $fixture -Slug 'demo') 'current.json') -Force
    Assert-Equal 'missing' (Get-StoreStatus 'demo') 'deleting the pointer did not read missing'
    $rerun = Approve-And-Run
    Assert-True ($rerun.ExitCode -eq 0) "the resumed run exited $($rerun.ExitCode)"
    $plan2 = $rerun.Plan
    Assert-True $plan2.resuming 'the re-run did not resume'
    $demo = @($plan2.books | Where-Object { $_.slug -ceq 'demo' })[0]
    Assert-Equal 'committed' $demo.status "the corrupted Book's status"
    Assert-Equal '2' ([string]$demo.generation) "the corrupted Book's generation"
    foreach ($slug in @('plain', 'inbox')) {
        # Store-as-authority: a Book the store alone reads ok is skipped with no window, so the
        # journal is what says the run resumed -- never a substitute for the store's own answer.
        $book = @($plan2.books | Where-Object { $_.slug -ceq $slug })[0]
        Assert-Equal 'already current' $book.status "the $slug status on resume"
        Assert-Equal '1' ([string]$book.generation) "the $slug generation advanced on resume"
    }
}

Test-Case 'a journal from a different Book set is not resumed' {
    $fullPre = Get-ResultJson (Invoke-Backfill @('-Preflight', '-Json', '-WorkspacePath', $fixture))
    $scopedPre = Get-ResultJson (Invoke-Backfill @('-Preflight', '-Json', '-WorkspacePath', $fixture, '-Book', 'demo'))
    Assert-True ($scopedPre.journal_path -cne $fullPre.journal_path) 'a scoped run shares the full run journal'
    # The earlier -Book demo repair case wrote a journal at this scope; clear it so the run must
    # start fresh. The full-set journal exists on disk, so a resuming run here would mean the
    # digest did not bind the journal to its Book set.
    $scopedJournalPath = Join-Path $fixture ($scopedPre.journal_path -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (Test-Path -LiteralPath $scopedJournalPath -PathType Leaf) { Remove-Item -LiteralPath $scopedJournalPath -Force }
    $run = Invoke-Backfill @('-WorkspacePath', $fixture, '-Json', '-Book', 'demo')
    $plan = Get-ResultJson $run
    Assert-True ($run.ExitCode -eq 0) "the scoped run exited $($run.ExitCode)"
    Assert-True (-not $plan.resuming) 'a run with no journal for its own scope reported resuming'
    Assert-True ($plan.journal_path -cne $fullPre.journal_path) 'the scoped run used the full-set journal path'
    Assert-Equal '0' ([string]$plan.books_to_write) 'the scoped run had work to do'
}

Test-Case 'an unreadable journal is treated as absent, not fatal' {
    $fullPre = Get-ResultJson (Invoke-Backfill @('-Preflight', '-Json', '-WorkspacePath', $fixture))
    $journalPath = Join-Path $fixture ($fullPre.journal_path -replace '/', [IO.Path]::DirectorySeparatorChar)
    [IO.File]::WriteAllText($journalPath, 'this is not json{{', $utf8)
    $run = Approve-And-Run
    Assert-True ($run.ExitCode -eq 0) "a run over an unreadable journal exited $($run.ExitCode)"
    $plan = $run.Plan
    Assert-True (-not $plan.resuming) 'an unreadable journal was treated as resumable'
    foreach ($slug in @('demo', 'plain', 'inbox')) {
        Assert-Equal 'already current' (@($plan.books | Where-Object { $_.slug -ceq $slug })[0]).status "the $slug status"
    }
}

# --- prune ------------------------------------------------------------------------------------------

Test-Case 'prune removes an orphan store, keeps an unresolved one, touches catalogued Books' {
    # No Book under either signal: an orphan, removed.
    New-Item -ItemType Directory -Path (Join-Path $fixture 'internal/book-manifests/shelf/orphan') -Force | Out-Null
    # A Book on disk but absent from the catalog: a catalog problem, not a reason to delete
    # derived state. The store is kept and reported unresolved.
    New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/ghost/wiki') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'internal/book-manifests/shelf/ghost') -Force | Out-Null
    $run = Approve-And-Run
    Assert-True ($run.ExitCode -eq 0) "the prune run exited $($run.ExitCode)"
    $plan = $run.Plan
    Assert-True (@($plan.pruned) -ccontains 'orphan') 'the orphan store was not reported pruned'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'internal/book-manifests/shelf/orphan'))) 'the orphan store survived'
    $kept = @($plan.stores_kept_unresolved | Where-Object { $_.slug -ceq 'ghost' })
    Assert-True ($kept.Count -eq 1) 'the unresolved store was not reported'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'internal/book-manifests/shelf/ghost')) 'the unresolved store was removed'
    Assert-True (Test-Path -LiteralPath (Get-BookManifestStorePath -Workspace $fixture -Slug 'demo')) 'a catalogued Book''s store was pruned'
}

Test-Case 'a -Book scoped run measures prune against the whole catalog, not the scoped Book' {
    # The regression for a 2026-08-19 defect found on the first real run. -Book narrows the per-Book
    # pass, and the prune sweep was reading the same narrowed list -- so every OTHER catalogued Book
    # read "absent from the catalog", and only the second fail-closed signal (shelf/<slug> on disk)
    # kept their stores. On a Shelf whose directories were not where this run expected them, that
    # scoping would have deleted every store but one.
    # 'ghost' is still on disk from the case above and stays the one legitimately unresolved store.
    $run = Invoke-Backfill @('-WorkspacePath', $fixture, '-Json', '-Book', 'demo')
    Assert-True ($run.ExitCode -eq 0) "the scoped run exited $($run.ExitCode)"
    $plan = Get-ResultJson $run
    Assert-Equal '1' ([string]@($plan.books).Count) 'the scoped run covered more than one Book'
    $unresolved = @($plan.stores_kept_unresolved | ForEach-Object { $_.slug } | Sort-Object)
    Assert-Equal 'ghost' ($unresolved -join ', ') 'the scoped run reported catalogued Books as unresolved'
    Assert-True (-not @($plan.pruned).Count) "the scoped run pruned $(@($plan.pruned) -join ', ')"
    foreach ($slug in @('demo', 'plain', 'inbox')) {
        Assert-True (Test-Path -LiteralPath (Get-BookManifestStorePath -Workspace $fixture -Slug $slug)) "the scoped run removed the $slug store"
    }
}

# --- the preflight ----------------------------------------------------------------------------------

Test-Case 'the preflight names no page path and no note title, and demands approval for closed Books' {
    $pre = Get-ResultJson (Invoke-Backfill @('-Preflight', '-Json', '-WorkspacePath', $fixture))
    Assert-True $pre.confirmation_required 'a fixture with closed Books did not require confirmation'
    $json = $pre | ConvertTo-Json -Depth 12
    foreach ($needle in @('Sekrit Capture Title', 'Confidential Note Two', 'secret-note', 'second-note', 'topic/plain', 'Real Title', 'Unvetted body')) {
        Assert-True ($json -cnotmatch [regex]::Escape($needle)) "the preflight leaks '$needle'"
    }
    $demo = @($pre.books | Where-Object { $_.slug -ceq 'demo' })[0]
    Assert-True $demo.open 'the open Book was not reported open'
    Assert-Equal 'curated' $demo.kind 'the open Book kind'
    Assert-Equal '3' ([string]$demo.page_count) 'the curated Book page count'
    $plain = @($pre.books | Where-Object { $_.slug -ceq 'plain' })[0]
    Assert-True (-not $plain.open) 'the closed curated Book was reported open'
    Assert-Equal 'already current' $plain.action 'the plain Book action'
    $inbox = @($pre.books | Where-Object { $_.slug -ceq 'inbox' })[0]
    Assert-True (-not $inbox.open) 'the closed capture Book was reported open'
    Assert-Equal 'capture' $inbox.kind 'the capture Book kind'
    Assert-Equal '2' ([string]$inbox.page_count) 'the capture Book page count'
}

# --- approval ---------------------------------------------------------------------------------------

Test-Case 'a run with a closed Book in scope and no approval is refused with nothing written' {
    foreach ($slug in @('demo', 'plain', 'inbox')) { Remove-BookManifestStore -Workspace $fixture -Slug $slug | Out-Null }
    $refused = Invoke-Backfill @('-WorkspacePath', $fixture)
    Assert-True ($refused.ExitCode -ne 0) 'a run without approval was not refused'
    foreach ($slug in @('demo', 'plain', 'inbox')) {
        Assert-True (-not (Test-Path -LiteralPath (Get-BookManifestStorePath -Workspace $fixture -Slug $slug))) "a refused run wrote a store for $slug"
    }
    $lockDir = Join-Path $fixture 'internal/book-locks'
    $locks = @()
    if (Test-Path -LiteralPath $lockDir -PathType Container) { $locks = @(Get-ChildItem -LiteralPath $lockDir -File) }
    Assert-True ($locks.Count -eq 0) 'a refused run left a lock behind'
}

Test-Case 'a -Book run over the one open Book needs no approval' {
    Assert-Equal 'missing' (Get-StoreStatus 'demo') 'demo was not missing'
    $run = Invoke-Backfill @('-WorkspacePath', $fixture, '-Json', '-Book', 'demo')
    Assert-True ($run.ExitCode -eq 0) "the scoped run exited $($run.ExitCode)"
    $plan = Get-ResultJson $run
    Assert-True (-not $plan.confirmation_required) 'a scoped open Book run demanded approval'
    $demo = @($plan.books | Where-Object { $_.slug -ceq 'demo' })[0]
    Assert-Equal 'committed' $demo.status "the scoped run's status"
    Assert-Equal 'ok' (Get-StoreStatus 'demo') 'the scoped run did not commit'
}

Test-Case 'a wrong or stale plan_id is refused, and so is approval without -UserConfirmed' {
    $fullPre = Get-ResultJson (Invoke-Backfill @('-Preflight', '-Json', '-WorkspacePath', $fixture))
    $scopedPre = Get-ResultJson (Invoke-Backfill @('-Preflight', '-Json', '-WorkspacePath', $fixture, '-Book', 'demo'))
    # Full scope approved with the demo-scope plan_id: an approval for one Book list replayed
    # against another.
    $wrong = Invoke-Backfill @('-WorkspacePath', $fixture, '-UserConfirmed', '-ApprovedPlanId', ([string]$scopedPre.plan_id))
    Assert-True ($wrong.ExitCode -ne 0) 'a wrong plan_id was accepted'
    Assert-True (($wrong.Lines -join ' ') -cmatch 'plan_id') 'the refusal did not name the plan_id'
    # The right plan_id, but the human confirmation it exists for is missing.
    $noConfirm = Invoke-Backfill @('-WorkspacePath', $fixture, '-ApprovedPlanId', ([string]$fullPre.plan_id))
    Assert-True ($noConfirm.ExitCode -ne 0) 'approval without -UserConfirmed was accepted'
    foreach ($slug in @('plain', 'inbox')) {
        Assert-True (-not (Test-Path -LiteralPath (Get-BookManifestStorePath -Workspace $fixture -Slug $slug))) "a refused run wrote a store for $slug"
    }
}

}
catch {
    # A strict-mode error outside a case body would otherwise unwind past every remaining case and
    # let this suite exit green having run a fraction of itself -- the exact failure the spec makes
    # mandatory to guard, and the one that already announced "passed (1 checks)" once in this
    # codebase. A suite that can do that is worse than no suite.
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
