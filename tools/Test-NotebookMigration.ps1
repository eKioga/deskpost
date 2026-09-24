<#
.SYNOPSIS
    ADR-0029's migration, judged over every legacy state and interrupted at every step. Run by
    Invoke-LibraryChecks.ps1 as `notebook.migration`, and the suite the matrix's
    `recovery.migration-refuses-activation-until-every-legacy-state-is-accounted-for` row names.

.DESCRIPTION
    WHY THIS EXISTS. `library migrate` has no PowerShell counterpart -- ADR-0029 lands in the kernel
    only -- so its row cannot be compared against an oracle and is judged against the property
    instead: every legacy state enumerated with a recorded disposition, activation refused while any
    is unaccounted, nothing deleted, and a run killed at any step either resumed to the same end or
    rolled back to the same start. PLAN-public-release.md step 26, and S18's criterion: "migration
    fixture covers every state".

    THE INPUT IS BUILT BY THE LEGACY WRITERS, NEVER BY THIS FILE. `workspace-legacy-notebook` in
    tools/AcceptanceFixtures.ps1 produces each state through the writer that produces it -- the real
    reset, the real retirement, the real ownership writer -- so the migration is judged against the
    layout the PowerShell tools really leave, not against this suite's idea of it. Section 1 asserts
    that every state is really there before anything else is believed.

    THE KERNEL IS DRIVEN THROUGH ITS FRONT DOOR, `node kernel/src/cli.ts`, as a child process with
    LIBRARY_WORKSPACE, LIBRARY_SEAT, LIBRARY_SEAT_CLAIM and CLAUDE_PID cleared: a suite whose answer
    depended on who ran it would be measuring the runner (S27's lesson).

    WHAT EACH SECTION PINS.

      1  the fixture holds every legacy state, and the preflight names each with a disposition
      2  activation is refused while five items are undecided, and names all five
      3  a run with no plan, a wrong plan, or a typo in a disposition refuses and moves nothing
      4  a legacy workspace: compile, reset and render refuse naming the migration
      5  the reference run: where every item landed, what was archived, and that no byte was lost
      6  the migrated layout works: the reset takes the seat's own root, the set-aside restores with
         --adopt, `notebook own` refuses naming ADR-0029, and no writer recorded an owner
      7  every interruption point, both sides of each journal write: a reset refuses naming the
         resume, `--resume` reaches the reference tree, `--rollback` reaches the legacy tree
#>
[CmdletBinding()]
param(
    [switch]$KeepFixtures,
    # THE KERNEL UNDER TEST (S41), as a command line: an executable, or an interpreter and a script, split
    # on whitespace as the acceptance harness splits its -Kernel. Absent, the suite drives this checkout's
    # `node kernel/src/cli.ts`, as it always has. The matrix's judge passes the kernel the harness is
    # judging, so a migration row reads green against a release only when THAT release migrates.
    [string]$Kernel
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'AcceptanceFixtures.ps1')

$program = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Kernel)) {
    $node = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue
    if (-not $node) {
        [Console]::Error.WriteLine('notebook migration: node is not on PATH, so the kernel cannot be driven. Install Node 22+.')
        exit 1
    }
    $kernelFile = $node.Source
    $kernelPrefix = @(Join-Path $program 'kernel/src/cli.ts')
}
else {
    $parts = @(@($Kernel -split '\s+') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    # A part naming a file relative to this program is made absolute, as the harness does at its boundary.
    $parts = @($parts | ForEach-Object { $candidate = Join-Path $program $_; if (-not [IO.Path]::IsPathRooted($_) -and (Test-Path -LiteralPath $candidate)) { $candidate } else { $_ } })
    $resolved = Get-Command -Name $parts[0] -CommandType Application -ErrorAction SilentlyContinue
    $kernelFile = if ($resolved) { @($resolved)[0].Source } else { $parts[0] }
    $kernelPrefix = @(if ($parts.Count -gt 1) { $parts[1..($parts.Count - 1)] })
}

$script:cases = 0
function Assert-True([bool]$Condition, [string]$What) {
    $script:cases++
    if (-not $Condition) { throw $What }
}

# THE CHILD'S ENVIRONMENT, CLEARED OF EVERYTHING THAT NAMES A RUNNER. Restored in `finally`.
$saved = @{}
foreach ($name in @('LIBRARY_WORKSPACE', 'LIBRARY_SEAT', 'LIBRARY_SEAT_CLAIM', 'CLAUDE_PID')) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}

function Invoke-Kernel([string[]]$Arguments, [hashtable]$Environment = @{}) {
    $info = [Diagnostics.ProcessStartInfo]::new($kernelFile)
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $quoted = @($kernelPrefix) + @($Arguments) | ForEach-Object { '"' + ([string]$_ -replace '"', '\"') + '"' }
    $info.Arguments = $quoted -join ' '
    foreach ($key in $Environment.Keys) { $info.EnvironmentVariables[$key] = [string]$Environment[$key] }
    $process = [Diagnostics.Process]::Start($info)
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $stdout = $process.StandardOutput.ReadToEnd()
    $process.WaitForExit()
    $result = [pscustomobject]@{ exit = $process.ExitCode; stdout = $stdout; stderr = $stderrTask.Result; json = $null }
    if ($process.ExitCode -eq 0 -and $stdout.Trim().StartsWith('{')) { $result.json = $stdout | ConvertFrom-Json }
    $result
}

# One migration's disposition choices, the same at the preflight and at the run.
$choices = @('--assign', 'drafts=fixture,orphan-notes=beta,scratch.md=fixture', '--set-aside', 'house-style,reference-copy')

function Get-Plan([string]$Workspace, [string[]]$With = $choices) {
    $answer = Invoke-Kernel (@('migrate', '--workspace', $Workspace) + $With + @('--preflight', '--json'))
    Assert-True ($answer.exit -eq 0 -and $null -ne $answer.json) "the migration preflight failed: $($answer.stderr)"
    $answer.json
}

# THE TREE, as relative path -> SHA-256. The set-aside quarantine's stamp and the records whose
# content is a timestamp are normalised or reduced to presence, and NOTHING else is.
function Get-Tree([string]$Workspace, [switch]$Raw) {
    $tree = [ordered]@{}
    $root = (Resolve-Path -LiteralPath $Workspace).Path
    foreach ($file in @(Get-ChildItem -LiteralPath $root -Recurse -File -Force | Sort-Object FullName)) {
        $relative = $file.FullName.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/'
        if ($relative -like 'internal/book-locks/*') { continue }
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        if (-not $Raw) {
            $relative = $relative -replace 'migration-\d{8}-\d{6}', 'migration-<stamp>'
            if ($relative -like 'internal/notebook-migration/journal*.json' -or $relative -ceq 'internal/notebook-layout.json' -or
                $relative -like 'internal/notebook-reset-quarantine/migration-<stamp>/reset-journal.json') { $hash = 'present' }
        }
        $tree[$relative] = $hash
    }
    $tree
}

function Compare-Tree($Expected, $Actual, [string]$What) {
    $problems = [Collections.Generic.List[string]]::new()
    foreach ($key in $Expected.Keys) {
        if (-not $Actual.Contains($key)) { [void]$problems.Add("missing $key") }
        elseif ([string]$Actual[$key] -cne [string]$Expected[$key]) { [void]$problems.Add("differs $key") }
    }
    foreach ($key in $Actual.Keys) { if (-not $Expected.Contains($key)) { [void]$problems.Add("extra $key") } }
    Assert-True ($problems.Count -eq 0) ("$What -- " + (($problems | Select-Object -First 6) -join '; '))
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('notebook-migration-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$failure = $null
try {
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $pristine = New-AcceptanceFixture -Id 'workspace-legacy-notebook' -Root (Join-Path $root 'pristine')
    $pristineWorkspace = [string]$pristine.workspace
    $pristineTree = Get-Tree $pristineWorkspace -Raw
    $copies = 0
    function New-Copy {
        $script:copies++
        $target = Join-Path $root ('run-' + $script:copies)
        Copy-Item -LiteralPath (Split-Path -Parent $pristineWorkspace) -Destination $target -Recurse
        Join-Path $target 'workspace'
    }

    # --- 1. EVERY LEGACY STATE IS THERE, AND THE PREFLIGHT NAMES EACH ONE ------------------------
    $bare = Get-Plan $pristineWorkspace @()
    $expectedStates = @('owned', 'owned-retired', 'owned-unaccounted', 'shared', 'excluded', 'unmapped', 'loose', 'stale-row', 'record', 'derived', 'quarantine')
    $found = @(@($bare.items) | ForEach-Object { [string]$_.state } | Sort-Object -Unique)
    foreach ($state in $expectedStates) { Assert-True ($found -ccontains $state) "the legacy fixture holds no '$state' item, so the migration is not judged over it" }
    foreach ($state in $found) { Assert-True ($expectedStates -ccontains $state) "the preflight reported a state '$state' this suite does not know" }
    $byName = @{}
    foreach ($item in @($bare.items)) { $byName[[string]$item.item] = $item }
    Assert-True ([string]$byName['old-notes'].legacy_owner -ceq 'gamma' -and [string]$byName['old-notes'].disposition -ceq 'set-aside') 'a retired seat''s topic was not set aside automatically'
    Assert-True ([string]$byName['beta'].disposition -ceq 'seat' -and [string]$byName['beta'].seat -ceq 'beta') 'the topic named like its seat was not given to that seat'
    Assert-True ([string]$byName['beta-scratch'].state -ceq 'stale-row') 'the row the real reset left behind was not reported as a stale row'
    Assert-True (@(@($bare.items) | Where-Object { $_.state -ceq 'quarantine' -and $_.disposition -ceq 'keep' }).Count -eq 1) 'the reset quarantine was not kept'

    # --- 2. ACTIVATION IS REFUSED WHILE ANYTHING IS UNDECIDED ------------------------------------
    Assert-True ([string]$bare.activation -ceq 'refused' -and [string]$bare.plan_id -ceq '') 'an undecided migration issued a plan'
    $undecided = @(@($bare.unaccounted) | Sort-Object)
    Assert-True (($undecided -join ',') -ceq 'drafts,house-style,orphan-notes,reference-copy,scratch.md') ("the unaccounted items were not exactly the five undecided ones: " + ($undecided -join ','))

    # --- 3. NO PLAN, A WRONG PLAN, A TYPO: REFUSED, AND NOTHING MOVED ----------------------------
    $work = New-Copy
    $before = Get-Tree $work -Raw
    $noPlan = Invoke-Kernel (@('migrate', '--workspace', $work) + $choices + @('--json'))
    Assert-True ($noPlan.exit -ne 0 -and $noPlan.stderr.Contains('nothing was moved')) "a run with no plan id did not refuse: $($noPlan.stderr)"
    $wrong = Invoke-Kernel (@('migrate', '--workspace', $work) + $choices + @('--plan-id', 'migrate-notebook-0000', '--json'))
    Assert-True ($wrong.exit -ne 0 -and $wrong.stderr.Contains('not what that plan described')) "a wrong plan id did not refuse: $($wrong.stderr)"
    $typo = Get-Plan $work @('--assign', 'draft=fixture')
    Assert-True (@(@($typo.refusals) | Where-Object { ([string]$_).Contains("'draft' names no topic") }).Count -eq 1) 'a disposition naming nothing was not refused'
    Compare-Tree $before (Get-Tree $work -Raw) 'a refused migration changed the workspace'

    # --- 4. A LEGACY WORKSPACE: EVERY NOTEBOOK WRITE REFUSES, NAMING THE MIGRATION ---------------
    foreach ($attempt in @(
            @('reset', '--workspace', $work, '--seat', 'fixture', '--preflight', '--json'),
            @('notebook', 'render', '--workspace', $work, '--seat', 'fixture', '--json'))) {
        $answer = Invoke-Kernel $attempt
        Assert-True ($answer.exit -ne 0 -and $answer.stderr.Contains("library migrate --preflight")) ("$($attempt[0]) on a legacy workspace did not refuse naming the migration: " + $answer.stderr)
    }
    $own = Invoke-Kernel @('notebook', 'own', 'acceptance', '--workspace', $work)
    Assert-True ($own.exit -ne 0 -and $own.stderr.Contains('ADR-0029')) "notebook own did not refuse naming ADR-0029: $($own.stderr)"

    # --- 5. THE REFERENCE RUN --------------------------------------------------------------------
    $reference = New-Copy
    $plan = Get-Plan $reference
    Assert-True ([string]$plan.activation -ceq 'ready' -and -not [string]::IsNullOrEmpty([string]$plan.plan_id)) ("a fully decided migration did not issue a plan: " + (@($plan.refusals) -join ' '))
    $run = Invoke-Kernel (@('migrate', '--workspace', $reference) + $choices + @('--plan-id', [string]$plan.plan_id, '--json'))
    Assert-True ($run.exit -eq 0 -and [string]$run.json.status -ceq 'complete') "the reference migration did not complete: $($run.stderr)"
    $referenceTree = Get-Tree $reference
    foreach ($expected in @(
            'notebook/fixture/_master-index.md', 'notebook/fixture/acceptance/_index.md', 'notebook/fixture/portability/_index.md',
            'notebook/fixture/drafts/_index.md', 'notebook/fixture/scratch.md',
            'notebook/beta/_master-index.md', 'notebook/beta/beta/_index.md', 'notebook/beta/orphan-notes/_index.md',
            'internal/notebook-reset-quarantine/migration-<stamp>/old-notes/_index.md',
            'internal/notebook-reset-quarantine/migration-<stamp>/house-style/_index.md',
            'internal/notebook-reset-quarantine/migration-<stamp>/reference-copy/_index.md',
            'internal/notebook-migration/legacy/notebook-topic-owners.json', 'internal/notebook-migration/legacy/_master-index.md',
            'internal/notebook-layout.json', 'internal/notebook-migration/journal.json')) {
        Assert-True ($referenceTree.Contains($expected)) "after the migration $expected is missing"
    }
    foreach ($gone in @('internal/notebook-topic-owners.json', 'notebook/_master-index.md', 'notebook/acceptance/_index.md', 'notebook/scratch.md')) {
        Assert-True (-not $referenceTree.Contains($gone)) "after the migration $gone is still in the shared layout"
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $reference 'internal/notebook-migration/staging'))) 'the staging directory outlived a completed migration'
    # NOTHING DELETED: every file the legacy tree held is somewhere in the migrated one, byte for byte.
    $after = @((Get-Tree $reference -Raw).Values)
    foreach ($key in $pristineTree.Keys) {
        if ($key -notlike 'notebook/*' -and $key -cne 'internal/notebook-topic-owners.json' -and $key -notlike 'internal/notebook-reset-quarantine/*') { continue }
        Assert-True ($after -ccontains [string]$pristineTree[$key]) "the migration lost the bytes of $key"
    }
    $seatIndex = [IO.File]::ReadAllText((Join-Path $reference 'notebook/beta/_master-index.md'))
    Assert-True ($seatIndex.Contains('[[beta/_index|') -and $seatIndex.Contains('[[orphan-notes/_index|')) "beta's own index does not list its two topics: $seatIndex"
    $setAsideJournal = Get-Content -Raw -LiteralPath (@(Get-ChildItem -LiteralPath (Join-Path $reference 'internal/notebook-reset-quarantine') -Directory -Filter 'migration-*')[0].FullName + '/reset-journal.json') | ConvertFrom-Json
    $oldNotes = @(@($setAsideJournal.targets) | Where-Object { [string]$_.topic -ceq 'old-notes' })
    Assert-True ($oldNotes.Count -eq 1 -and [string]$oldNotes[0].seat -ceq 'gamma' -and [string]$oldNotes[0].seat_id -ceq '33333333-3333-3333-3333-333333333333') 'the set-aside journal does not record whose the retired topic was'
    $again = Get-Plan $reference @()
    Assert-True ([string]$again.status -ceq 'already-seat-owned') 'a second preflight over a migrated workspace did not say it is already seat-owned'

    # --- 6. THE MIGRATED LAYOUT WORKS, AND NOTHING RECORDS AN OWNER ------------------------------
    $held = Enter-FixtureSeatClaim -StateDirectory (Join-Path $reference '.claude') -Seat 'fixture'
    try {
        $seatEnv = @{ LIBRARY_SEAT = 'fixture'; LIBRARY_SEAT_CLAIM = [string]$held.token }
        $resetPlan = Invoke-Kernel @('reset', '--workspace', $reference, '--preflight', '--json') $seatEnv
        Assert-True ($resetPlan.exit -eq 0) "the reset preflight refused on the migrated layout: $($resetPlan.stderr)"
        Assert-True ((@($resetPlan.json.topics_to_quarantine) -join ',') -ceq 'acceptance,drafts,portability') ("the reset did not take exactly the seat's own root: " + (@($resetPlan.json.topics_to_quarantine) -join ','))
        Assert-True ((@($resetPlan.json.loose_files_to_quarantine) -join ',') -ceq 'scratch.md') 'the reset did not take the loose file the migration gave this seat'
        $resetRun = Invoke-Kernel @('reset', '--workspace', $reference, '--plan-id', [string]$resetPlan.json.plan_id, '--json') $seatEnv
        Assert-True ($resetRun.exit -eq 0) "the reset did not run on the migrated layout: $($resetRun.stderr)"
        Assert-True (Test-Path -LiteralPath (Join-Path $reference 'notebook/beta/beta/_index.md')) 'a reset at one seat touched another seat''s Notebook'
        $setAside = @(Get-ChildItem -LiteralPath (Join-Path $reference 'internal/notebook-reset-quarantine') -Directory -Filter 'migration-*')[0].Name
        $restorePlan = Invoke-Kernel @('reset', 'restore', '--quarantine', $setAside, '--topic', 'house-style', '--adopt', '--workspace', $reference, '--preflight', '--json') $seatEnv
        Assert-True ($restorePlan.exit -eq 0 -and [string]$restorePlan.json.plan_id) "the set-aside topic could not be planned back with --adopt: $($restorePlan.stderr)"
        $restoreRun = Invoke-Kernel @('reset', 'restore', '--quarantine', $setAside, '--topic', 'house-style', '--adopt', '--workspace', $reference, '--plan-id', [string]$restorePlan.json.plan_id, '--json') $seatEnv
        Assert-True ($restoreRun.exit -eq 0 -and (Test-Path -LiteralPath (Join-Path $reference 'notebook/fixture/house-style/_index.md'))) "the set-aside topic did not come back into the seat's Notebook: $($restoreRun.stderr)"
        $retired = Invoke-Kernel @('notebook', 'own', 'house-style', '--workspace', $reference) $seatEnv
        Assert-True ($retired.exit -ne 0 -and $retired.stderr.Contains('ADR-0029')) 'notebook own answered on the seat-owned layout'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $reference 'internal/notebook-topic-owners.json'))) 'a kernel writer recorded an owner after the migration retired the record'
    }
    finally { Exit-FixtureSeatClaim }

    # --- 7. EVERY INTERRUPTION POINT, RESUMED AND ROLLED BACK ------------------------------------
    $journal = Get-Content -Raw -LiteralPath (Join-Path $reference 'internal/notebook-migration/journal.json') | ConvertFrom-Json
    $points = @('journal-created') + @(@($journal.steps) | ForEach-Object { [string]$_.id; ([string]$_.id + ':recorded') })
    Assert-True ($points.Count -ge 20) "the reference run had only $($points.Count) interruption points, so the migration's steps were not all journalled"
    foreach ($point in $points) {
        foreach ($ending in @('resume', 'rollback')) {
            $copy = New-Copy
            $interruptedPlan = Get-Plan $copy
            $killed = Invoke-Kernel (@('migrate', '--workspace', $copy) + $choices + @('--plan-id', [string]$interruptedPlan.plan_id, '--fault-after', $point, '--json'))
            Assert-True ($killed.exit -ne 0 -and $killed.stderr.Contains('FAULT INJECTED')) "the fault at $point was not injected: $($killed.stderr)"
            # WHAT AN INTERRUPTED MIGRATION LOOKS LIKE TO A RESET (the reader's ruling, S18).
            $reset = Invoke-Kernel @('reset', '--workspace', $copy, '--seat', 'fixture', '--preflight', '--json')
            Assert-True ($reset.exit -ne 0 -and $reset.stderr.Contains('library migrate --resume')) "at $point a reset did not refuse naming the resume: $($reset.stderr)"
            $status = Get-Plan $copy @()
            Assert-True ([string]$status.status -ceq 'interrupted') "at $point the preflight did not report an interrupted migration"
            if ($ending -ceq 'resume') {
                $resumed = Invoke-Kernel @('migrate', '--workspace', $copy, '--resume', '--json')
                Assert-True ($resumed.exit -eq 0 -and [string]$resumed.json.status -ceq 'complete') "resuming from $point failed: $($resumed.stderr)"
                Compare-Tree $referenceTree (Get-Tree $copy) "resuming from $point did not reach the reference tree"
            }
            else {
                $rolled = Invoke-Kernel @('migrate', '--workspace', $copy, '--rollback', '--json')
                Assert-True ($rolled.exit -eq 0 -and [string]$rolled.json.status -ceq 'rolled-back') "rolling back from $point failed: $($rolled.stderr)"
                $back = Get-Tree $copy -Raw
                $kept = @($back.Keys | Where-Object { $_ -like 'internal/notebook-migration/journal-rolled-back-*' })
                Assert-True ($kept.Count -eq 1) "rolling back from $point kept no journal of the attempt"
                $back.Remove($kept[0])
                Compare-Tree $pristineTree $back "rolling back from $point did not reach the legacy tree"
            }
            if (-not $KeepFixtures) { Remove-Item -LiteralPath (Split-Path -Parent $copy) -Recurse -Force }
        }
    }
}
catch { $failure = $_ }
finally {
    Exit-FixtureSeatClaim
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    if (-not $KeepFixtures -and (Test-Path -LiteralPath $root)) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($null -ne $failure) {
    [Console]::Error.WriteLine("notebook migration: FAILED at assertion $($script:cases) -- $($failure.Exception.Message)")
    exit 1
}

"notebook migration: $($script:cases) assertion(s) over every legacy state, the refusals before and during a run, the reference run and the layout it leaves, and every interruption point resumed and rolled back"
