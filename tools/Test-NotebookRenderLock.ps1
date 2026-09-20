<#
.SYNOPSIS
    PLAN-multi-desk.md step 28a. Prove the Notebook render lock is narrow, with real processes.

.DESCRIPTION
    D2 says the master index is derived under a serialized renderer, and the whole design rests on
    that renderer's critical section being TINY: two compiles into two different existing topics
    must overlap, while two changes to which topics exist must serialize. Without an executable
    form of that sentence, "narrow critical section" is a claim rather than a property -- and it is
    a claim that decays quietly, because a widened lock breaks no test and produces no wrong bytes.
    It only makes the Library slow in the exact case this project exists to make fast.

    WHY REAL PROCESSES. Enter-BookLock is a CreateNew file lock, so one process cannot contend with
    itself: an in-process test would prove the ordering of function calls and nothing about
    exclusion. Every case below launches powershell.exe.

    HOW THE TWO HALVES ARE PROVED, and why neither is a timing race. The negative half -- that the
    render lock is NOT taken on the ordinary path -- is proved by HOLDING the render lock in this
    process and requiring a child's existing-topic write to succeed anyway with a short timeout. A
    writer that took the render lock would block and time out; there is no window to lose. The
    positive half is proved the same way in reverse: with the lock held, a child's visibility commit
    must be refused. Only the overlap case (case 4) measures wall-clock, and it measures overlap
    rather than absence, which is the direction that cannot pass by accident.

    Reset is deliberately not asserted to be narrow. Step 28a exempts it: a reset is inherently a
    whole-scope operation and holds the render lock across its removal and rebuild.
#>
[CmdletBinding()]
param([switch]$Json)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
. (Join-Path $PSScriptRoot 'NotebookIndex.ps1')

$script:Failures = [Collections.Generic.List[string]]::new()
$script:Checks = 0
function Assert([bool]$Condition, [string]$Label) {
    $script:Checks++
    if (-not $Condition) { [void]$script:Failures.Add($Label) }
}

$utf8 = [Text.UTF8Encoding]::new($false)
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('notebook-render-lock-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$workerPath = Join-Path $fixture 'worker.ps1'
$reportRoot = Join-Path $fixture 'reports'

# The worker is the REAL consumer of the render module, driven exactly as the migrated writers drive
# it: an existing-topic write goes through Write-AtomicText under the topic lock and never touches
# the render lock, and a visibility commit stages outside the lock and promotes inside it.
$worker = @'
param(
    [Parameter(Mandatory = $true)][string]$Action,
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string]$Topic,
    [Parameter(Mandatory = $true)][string]$ReportPath,
    [int]$LockTimeoutSeconds = 3,
    [int]$HoldMilliseconds = 0,
    [int]$StagePauseMilliseconds = 0
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$toolsRoot = Split-Path -Parent $PSCommandPath
. (Join-Path $toolsRoot 'BookWriteGuard.ps1')
. (Join-Path $toolsRoot 'NotebookIndex.ps1')

$report = [ordered]@{ action = $Action; topic = $Topic; ok = $false; error = ''; enter_utc = ''; exit_utc = ''; held_ms = -1 }
try {
    switch ($Action) {
        'existing-write' {
            # The ordinary case: a new article in a topic that already exists, whose H1 nobody
            # edited. Topic lock only. If this path ever takes the render lock, case 1 deadlocks.
            $topicPath = Join-Path (Join-Path $Workspace 'notebook') $Topic
            $indexPath = Join-Path $topicPath '_index.md'
            $heading = Get-NotebookTopicHeading -IndexPath $indexPath
            $lock = Enter-BookLock -Workspace $Workspace -BookRoot (Get-NotebookTopicLockRoot $Topic) -TimeoutSeconds $LockTimeoutSeconds
            try {
                $report.enter_utc = [DateTime]::UtcNow.ToString('o')
                Write-AtomicText -Path (Join-Path $topicPath 'added.md') -Text "# Added`n`nBody from $PID.`n" | Out-Null
                # Rewritten with the SAME heading, so nothing the master index derives from moves.
                Write-AtomicText -Path $indexPath -Text "# $heading`n`n## Articles`n`n- [[added|Added]]`n" | Out-Null
                if ($HoldMilliseconds -gt 0) { Start-Sleep -Milliseconds $HoldMilliseconds }
                $report.exit_utc = [DateTime]::UtcNow.ToString('o')
            }
            finally { Exit-BookLock -Lock $lock }
        }
        'visibility-commit' {
            # A NEW topic: staged whole outside every lock, promoted by one directory move inside
            # the render lock, exactly as Compile, Triage and Restore now do it.
            $topicPath = Join-Path (Join-Path $Workspace 'notebook') $Topic
            $stagingRoot = Join-Path $Workspace 'internal/notebook-staging'
            $staging = Join-Path $stagingRoot ([guid]::NewGuid().ToString('n'))
            New-Item -ItemType Directory -Path $staging -Force | Out-Null
            try {
                Write-AtomicText -Path (Join-Path $staging '_index.md') -Text "# Topic $Topic`n" | Out-Null
                Write-AtomicText -Path (Join-Path $staging 'note.md') -Text "# Note`n`nFrom $PID.`n" | Out-Null
                # Outside the lock on purpose: it widens the window in which two workers are both
                # trying to commit, without making the critical section itself any longer.
                if ($StagePauseMilliseconds -gt 0) { Start-Sleep -Milliseconds $StagePauseMilliseconds }
                # The window the render REPORTS, not the window this worker measures around the
                # call: the call includes waiting for the lock, and two serialized renders have
                # overlapping call windows by definition. Only the held window can say whether the
                # critical section serialized them.
                $render = Invoke-NotebookRender -Workspace $Workspace -TimeoutSeconds $LockTimeoutSeconds -CommitArgument @($staging, $topicPath) -Commit {
                    param($From, $To)
                    [IO.Directory]::Move($From, $To)
                }
                $report.enter_utc = $render.lock_entered_utc
                $report.exit_utc = $render.lock_exit_utc
                $report.held_ms = $render.lock_held_ms
            }
            finally {
                if (Test-Path -LiteralPath $staging -PathType Container) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
            }
        }
        'rewrite-index-loop' {
            # Atomic replacement under load, so the reader in case 5 has something to catch.
            $indexPath = Join-Path (Join-Path (Join-Path $Workspace 'notebook') $Topic) '_index.md'
            $heading = Get-NotebookTopicHeading -IndexPath $indexPath
            $report.enter_utc = [DateTime]::UtcNow.ToString('o')
            for ($i = 0; $i -lt 400; $i++) {
                $filler = ('- [[article-' + $i + '|Article ' + $i + ']]') * 40
                Write-AtomicText -Path $indexPath -Text "# $heading`n`n## Articles`n`n$filler`n" | Out-Null
            }
            $report.exit_utc = [DateTime]::UtcNow.ToString('o')
        }
        default { throw "unknown action '$Action'" }
    }
    $report.ok = $true
}
catch { $report.error = $_.Exception.Message }
[IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
if (-not $report.ok) { exit 1 }
exit 0
'@

function Start-Worker([string]$Action, [string]$Topic, [string]$Report, [int]$TimeoutSeconds = 3, [int]$Hold = 0, [int]$StagePause = 0) {
    Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $workerPath,
        '-Action', $Action, '-Workspace', $fixture, '-Topic', $Topic,
        '-ReportPath', (Join-Path $reportRoot $Report),
        '-LockTimeoutSeconds', $TimeoutSeconds, '-HoldMilliseconds', $Hold,
        '-StagePauseMilliseconds', $StagePause
    )
}

function Get-Report([string]$Report) {
    $path = Join-Path $reportRoot $Report
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    [IO.File]::ReadAllText($path) | ConvertFrom-Json
}

function New-Topic([string]$Slug, [string]$Heading) {
    New-Item -ItemType Directory -Path (Join-Path $fixture "notebook/$Slug") -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture "notebook/$Slug/_index.md"), "# $Heading`n`n## Articles`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $fixture "notebook/$Slug/first.md"), "# First`n`nBody.`n", $utf8)
}

try {
    New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook') -Force | Out-Null
    New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
    # The worker sits beside the modules it dot-sources, so it resolves them the way a real helper
    # in tools/ does rather than through a path this test composes.
    New-Item -ItemType Directory -Path (Join-Path $fixture 'tools') -Force | Out-Null
    $workerPath = Join-Path $fixture 'tools/worker.ps1'
    [IO.File]::WriteAllText($workerPath, $worker, $utf8)
    # THE MODULES THE WORKER NEEDS ARE DERIVED, NEVER LISTED. This was a two-name list until
    # 2026-09-09, when BookWriteGuard.ps1 gained a dot-source of AtomicFile.ps1 and every case in this
    # suite failed at once with an empty message -- the worker died before it could write a report, so
    # fifteen assertions reported on a child that never ran. A hardcoded copy list stands for the
    # dependency graph, and a list that stands for something derivable falls behind it. So the closure
    # is walked: each staged module's own `. (Join-Path $PSScriptRoot '<name>')` imports are staged too.
    $staged = @{}
    $pending = [Collections.Generic.Queue[string]]::new()
    foreach ($seed in @('BookWriteGuard.ps1', 'NotebookIndex.ps1')) { $pending.Enqueue($seed) }
    while ($pending.Count) {
        $module = $pending.Dequeue()
        if ($staged.ContainsKey($module)) { continue }
        $source = Join-Path $PSScriptRoot $module
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "the render-lock fixture cannot stage $module; it is not in tools/." }
        [IO.File]::Copy($source, (Join-Path $fixture "tools/$module"), $true)
        $staged[$module] = $true
        foreach ($match in [regex]::Matches([IO.File]::ReadAllText($source), "(?m)^\s*\.\s+\(Join-Path \`$PSScriptRoot '([^']+\.ps1)'\)")) {
            $pending.Enqueue($match.Groups[1].Value)
        }
    }
    if ($staged.Count -lt 3) { throw "the render-lock fixture staged only $($staged.Count) module(s); the import scan stopped reading dot-sources." }
    New-Topic 'alpha' 'Alpha Topic'
    New-Topic 'beta' 'Beta Topic'
    Invoke-NotebookRender -Workspace $fixture | Out-Null

    # --- 1. The render lock is NOT taken when the H1 is unchanged ---------------------------------
    # This process holds the render lock throughout. An existing-topic write must complete anyway.
    $held = Enter-BookLock -Workspace $fixture -BookRoot (Get-NotebookRenderLockRoot) -TimeoutSeconds 5
    try {
        $child = Start-Worker 'existing-write' 'alpha' 'case1.json' 3
        $child.WaitForExit()
        $report = Get-Report 'case1.json'
        Assert ($null -ne $report) 'case 1: the worker wrote no report at all'
        Assert ($null -ne $report -and [bool]$report.ok) "case 1: an existing-topic write blocked on the render lock: $(if ($null -ne $report) { $report.error })"
        Assert (Test-Path -LiteralPath (Join-Path $fixture 'notebook/alpha/added.md') -PathType Leaf) 'case 1: the article was not written'

        # --- 2. A visibility commit DOES serialize on that same lock ------------------------------
        $child = Start-Worker 'visibility-commit' 'gamma' 'case2.json' 2
        $child.WaitForExit()
        $report = Get-Report 'case2.json'
        Assert ($null -ne $report -and -not [bool]$report.ok) 'case 2: a new topic was promoted while the render lock was held elsewhere'
        Assert ($null -ne $report -and $report.error -cmatch 'holds the lock') "case 2: the refusal did not name lock contention: $(if ($null -ne $report) { $report.error })"
        Assert (-not (Test-Path -LiteralPath (Join-Path $fixture 'notebook/gamma'))) 'case 2: a refused promotion left the topic directory behind'
    }
    finally { Exit-BookLock -Lock $held }

    # --- 3. Two concurrent visibility commits keep BOTH topics ------------------------------------
    # The defect this closes: two renderers that both scan, then both write, lose whichever topic
    # the loser did not see. Both workers pause after staging so their commits genuinely contend.
    $first = Start-Worker 'visibility-commit' 'delta' 'case3a.json' 20 0 400
    $second = Start-Worker 'visibility-commit' 'epsilon' 'case3b.json' 20 0 400
    $first.WaitForExit()
    $second.WaitForExit()
    $reportA = Get-Report 'case3a.json'
    $reportB = Get-Report 'case3b.json'
    Assert ($null -ne $reportA -and [bool]$reportA.ok) "case 3: the first concurrent commit failed: $(if ($null -ne $reportA) { $reportA.error })"
    Assert ($null -ne $reportB -and [bool]$reportB.ok) "case 3: the second concurrent commit failed: $(if ($null -ne $reportB) { $reportB.error })"
    $master = [IO.File]::ReadAllText((Join-Path $fixture 'notebook/_master-index.md'))
    foreach ($slug in @('alpha', 'beta', 'delta', 'epsilon')) {
        Assert ($master.Contains("[[$slug/_index|")) "case 3: the master index lost the topic '$slug' after two concurrent commits"
    }
    Assert (-not @(Get-NotebookMasterIndexDrift -Workspace $fixture).Count) 'case 3: two concurrent commits left the master index disagreeing with the topics on disk'
    # The commit windows must not overlap: that is the serialization, and it is the reason no topic
    # was lost above.
    if ($null -ne $reportA -and $null -ne $reportB -and $reportA.ok -and $reportB.ok) {
        $aEnter = [DateTime]::Parse($reportA.enter_utc, $null, [Globalization.DateTimeStyles]::RoundtripKind)
        $aExit = [DateTime]::Parse($reportA.exit_utc, $null, [Globalization.DateTimeStyles]::RoundtripKind)
        $bEnter = [DateTime]::Parse($reportB.enter_utc, $null, [Globalization.DateTimeStyles]::RoundtripKind)
        $bExit = [DateTime]::Parse($reportB.exit_utc, $null, [Globalization.DateTimeStyles]::RoundtripKind)
        Assert (($aExit -le $bEnter) -or ($bExit -le $aEnter)) 'case 3: the two render windows overlapped, so the render lock did not serialize them'
    }
    else { Assert $false 'case 3: the overlap comparison did not run because a commit failed' }

    # --- 4. Two writes into two EXISTING topics overlap -------------------------------------------
    # D2's positive half. Each worker holds only its own topic lock, across a window wide enough to
    # observe. If any shared lock had crept into this path the windows would be disjoint instead.
    $first = Start-Worker 'existing-write' 'alpha' 'case4a.json' 20 1200
    $second = Start-Worker 'existing-write' 'beta' 'case4b.json' 20 1200
    $first.WaitForExit()
    $second.WaitForExit()
    $reportA = Get-Report 'case4a.json'
    $reportB = Get-Report 'case4b.json'
    Assert ($null -ne $reportA -and [bool]$reportA.ok) "case 4: the write into alpha failed: $(if ($null -ne $reportA) { $reportA.error })"
    Assert ($null -ne $reportB -and [bool]$reportB.ok) "case 4: the write into beta failed: $(if ($null -ne $reportB) { $reportB.error })"
    if ($null -ne $reportA -and $null -ne $reportB -and $reportA.ok -and $reportB.ok) {
        $aEnter = [DateTime]::Parse($reportA.enter_utc, $null, [Globalization.DateTimeStyles]::RoundtripKind)
        $aExit = [DateTime]::Parse($reportA.exit_utc, $null, [Globalization.DateTimeStyles]::RoundtripKind)
        $bEnter = [DateTime]::Parse($reportB.enter_utc, $null, [Globalization.DateTimeStyles]::RoundtripKind)
        $bExit = [DateTime]::Parse($reportB.exit_utc, $null, [Globalization.DateTimeStyles]::RoundtripKind)
        Assert (($aEnter -lt $bExit) -and ($bEnter -lt $aExit)) 'case 4: two writes into different existing topics did not overlap, so something is serialising the ordinary path'
    }
    else { Assert $false 'case 4: the overlap comparison did not run because a write failed' }

    # --- 5. A concurrent reader never sees a torn or absent topic index ---------------------------
    # THE PROPERTY THAT PAYS FOR THE NARROW LOCK. These rewrites hold no render lock, so a renderer
    # really can be reading the file mid-rewrite. What must never happen is a PARTIAL or EMPTY read
    # -- that is the one a reader believes.
    #
    # A REFUSAL IS A DIFFERENT THING FROM A TEAR, and separating them is what picked the primitive.
    # A rename-over holds the destination for an instant, so a raw reader is occasionally refused,
    # and on the rare occasions the File.Replace fallback runs the path is briefly absent as well.
    # Neither is a tear. Zero partial reads is the guarantee callers depend on and it is asserted
    # strictly here; the two refusal counts are reported because they are worth seeing, and which
    # primitive publishes first is pinned deterministically by BookWriteGuard's own case 6f rather
    # than by a rate this test would have to pick a threshold for.
    $writer = Start-Worker 'rewrite-index-loop' 'alpha' 'case5.json' 20
    $rawReads = 0
    $partial = 0
    $missing = 0
    $sharing = 0
    $alphaIndex = Join-Path $fixture 'notebook/alpha/_index.md'
    while (-not $writer.HasExited) {
        try {
            $text = [Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($alphaIndex))
            $rawReads++
            if ([string]::IsNullOrWhiteSpace($text) -or -not $text.StartsWith('# Alpha Topic', [StringComparison]::Ordinal) -or -not $text.EndsWith("`n", [StringComparison]::Ordinal)) { $partial++ }
        }
        catch {
            $rawReads++
            $inner = $_.Exception
            while ($null -ne $inner.InnerException) { $inner = $inner.InnerException }
            if ($inner -is [IO.FileNotFoundException]) { $missing++ } else { $sharing++ }
        }
    }
    $writer.WaitForExit()
    $report = Get-Report 'case5.json'
    Assert ($null -ne $report -and [bool]$report.ok) "case 5: the rewrite loop failed: $(if ($null -ne $report) { $report.error })"
    Assert ($rawReads -gt 20) "case 5: only $rawReads raw reads landed during the rewrite loop, which is too few to prove anything"
    Assert ($partial -eq 0) "case 5: $partial of $rawReads concurrent reads saw a torn or empty topic index"
    Assert (-not @(Get-ChildItem -LiteralPath (Join-Path $fixture 'notebook/alpha') -Force -Filter '.atomic-*').Count) 'case 5: the rewrite loop left staging files in the topic directory'

    # --- 6. The Library's own reader is never refused at all --------------------------------------
    # Read-AtomicBytes is what Get-NotebookTopicHeading and the drift detector use, and its whole
    # job is that the instant of a rename-over never surfaces as an unexplained refusal in the
    # middle of an unrelated operation.
    $writer = Start-Worker 'rewrite-index-loop' 'alpha' 'case6.json' 20
    $guardedReads = 0
    $guardedFailures = 0
    while (-not $writer.HasExited) {
        try { Get-NotebookTopicHeading -IndexPath $alphaIndex | Out-Null; $guardedReads++ }
        catch { $guardedReads++; $guardedFailures++ }
    }
    $writer.WaitForExit()
    $report = Get-Report 'case6.json'
    Assert ($null -ne $report -and [bool]$report.ok) "case 6: the rewrite loop failed: $(if ($null -ne $report) { $report.error })"
    Assert ($guardedReads -gt 20) "case 6: only $guardedReads guarded reads landed, which is too few to prove anything"
    Assert ($guardedFailures -eq 0) "case 6: $guardedFailures of $guardedReads reads through the Library's own retrying reader still failed"
}
finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}

$result = [pscustomobject]@{
    operation            = 'Notebook render-lock concurrency suite'
    checks               = $script:Checks
    raw_reads            = $rawReads
    raw_partial_reads    = $partial
    raw_sharing_refusals = $sharing
    raw_not_found_reads  = $missing
    guarded_reads        = $guardedReads
    guarded_failures     = $guardedFailures
    failures             = @($script:Failures)
    passed               = (@($script:Failures).Count -eq 0)
    scope                = 'Real processes against a disposable fixture. No NAS access, no shared write, and it never touches this workspace notebook/.'
    shared_library_write = $false
}
if ($Json) { $result | ConvertTo-Json -Depth 5 } else { $result | Format-List }
if (-not $result.passed) {
    [Console]::Error.WriteLine("Test-NotebookRenderLock FAILED: $(@($script:Failures) -join '; ')")
    exit 1
}
exit 0
