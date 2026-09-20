<#
.SYNOPSIS
    The maintenance barrier and the folder cutover, driven against their own fixtures. Run by
    Invoke-LibraryChecks.ps1 as `maintenance.folder-move`.

.DESCRIPTION
    WHY THIS EXISTS. `maintenance.barrier-coverage` in the gate proves the barrier is WIRED -- that
    Assert-SeatClaimHeld calls it, that both launchers call it, and that only the mover raises one.
    A static read cannot prove any of it BEHAVES, and the two faults are different: a guard can be
    present and reached and still refuse the wrong thing, or refuse nothing because the record it
    reads is not the record the writer writes. So this suite runs the real helpers.

    SEPARATE WORKSPACES, because a live seat claim and a cutover are mutually exclusive by design.
    Sections 2 to 4b need a HELD claim to prove the guards refuse; sections 6 to 12 need a quiet
    workspace to let the mover run at all. One workspace could not hold both states, and a suite
    that reused it would be asserting against whichever order the sections happened to be in.

    WHAT EACH SECTION PINS.

      1  the three barrier states, and the fail-closed reading of a damaged record
      2  a real claim-gated mutator refused under a barrier, with the same call succeeding
         without one as the positive control
      3  both seat entry routes refused, including their preflights
      4  the mover refuses to engage while a seat is held, and while one is ORPHANED
     4b  the OPERATOR's own seat, excused only when proven by token or by binding, with a
         held bystander that must still block and a named-but-unproven seat that must too
      5  a fresh Book lock blocks; a stale one does not, and is reported instead
      6  the preflight: hashes, the plan_id, and the four refusals that precede one
      7  pointer rewriting, ONE FIXTURE PER SPELLING, with the sibling-path negative and the
         ambiguous-boundary case that must be reported rather than rewritten
      8  the confirmed move end to end: copy, verify, aside, pointers, final verification,
         checkpoint, journal, barrier down
      9  a wrong plan_id refuses, asserted at the MATERIAL rather than at the exit code
     10  the rollback: source back, pointers byte-exact, destination gone
     11  a rollback refused against a destination somebody has written to
     12  an unfinished run blocks the next cutover, and Status reports it

    THREE SPELLINGS AND FOUR POINTER FILES WHEREVER A SET IS REWRITTEN. With two, a truncation puts
    one in the right bucket and loses the other invisibly; three is the smallest number at which a
    dropped file is distinguishable from a reordering, and the fourth is the negative that must not
    be touched at all.
#>
[CmdletBinding()]
param([switch]$Json)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'MaintenanceBarrier.ps1')

$script:cases = 0
function Assert-True([bool]$Condition, [string]$What) {
    $script:cases++
    if (-not $Condition) { throw $What }
}
function Assert-Equal([string]$Expected, [string]$Actual, [string]$What) {
    $script:cases++
    if ($Expected -cne $Actual) { throw "$What -- was '$Actual', expected '$Expected'" }
}
# ASSERT SHAPE BEFORE VALUES. Under Set-StrictMode, reading a property an object does not carry
# throws PropertyNotFound -- a red naming this file's line rather than the field the helper failed
# to emit.
function Get-Field([object]$Object, [string]$Name, [string]$What) {
    $script:cases++
    $names = @($Object.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -cnotcontains $Name) { throw "$What -- the result carries no '$Name' property; it has: $($names -join ', ')" }
    $Object.$Name
}
# A REFUSAL IS ASSERTED ON ITS OWN WORDS, never merely on "it threw". Every guard here has a
# neighbour that also throws, and a test that accepts any throw passes when the wrong one fires.
function Assert-Refused([scriptblock]$Action, [string]$Fragment, [string]$What) {
    $script:cases++
    $message = ''
    try { & $Action | Out-Null }
    catch { $message = [string]$_.Exception.Message }
    if ([string]::IsNullOrWhiteSpace($message)) { throw "$What -- nothing was refused at all" }
    if (-not $message.Contains($Fragment)) { throw "$What -- refused with '$message', which does not name '$Fragment'" }
    $message
}

$mover = Join-Path $PSScriptRoot 'Move-LibraryFolder.ps1'
$utf8 = [Text.UTF8Encoding]::new($false)
$root = Join-Path ([IO.Path]::GetTempPath()) ('folder-move-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$savedSeat = $env:LIBRARY_SEAT
$savedClaim = $env:LIBRARY_SEAT_CLAIM

function New-FixtureWorkspace([string]$Name) {
    $path = Join-Path $root $Name
    foreach ($relative in @('.claude', 'internal', 'notebook')) {
        New-Item -ItemType Directory -Path (Join-Path $path $relative) -Force | Out-Null
    }
    # Set-VirtualDesk refuses a workspace with no project pin, and a malformed one is a DIFFERENT
    # refusal from the barrier's -- which is exactly the confusion section 2 exists to rule out.
    [IO.File]::WriteAllText((Join-Path $path '.claude/.library-project'), [guid]::NewGuid().ToString() + "`n", $utf8)
    $path
}
function Write-FixtureFile([string]$Path, [string]$Text) {
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Text, $utf8)
    $Path
}
function New-FixtureBarrier([string]$Workspace, [string]$RunName) {
    New-MaintenanceBarrier -Workspace $Workspace -Operation 'Move-LibraryFolder' -Reason 'a fixture cutover' -RunId $RunName
}
function Get-PointerRow([object[]]$Rows, [string]$Path) {
    @(@($Rows) | Where-Object { [string]$_.path -ceq $Path }) | Select-Object -First 1
}

$failure = $null
try {

# === 1. The three barrier states, and the fail-closed reading =====================================
$states = New-FixtureWorkspace 'states'
Assert-Equal 'absent' ([string](Get-Field (Get-MaintenanceBarrierState -Workspace $states) 'state' 'the barrier state')) 'a workspace with no marker did not read as absent'
Assert-True (-not (Test-MaintenanceBarrierEngaged -Workspace $states)) 'an absent barrier read as engaged'
Assert-True ($null -eq (Get-MaintenanceBarrierRefusal -Workspace $states -Operation 'anything')) 'an absent barrier produced a refusal sentence'

$raised = New-FixtureBarrier $states 'run-states'
Assert-Equal 'engaged' ([string](Get-MaintenanceBarrierState -Workspace $states).state) 'a raised barrier did not read as engaged'
$engagedRefusal = Get-MaintenanceBarrierRefusal -Workspace $states -Operation 'a fixture operation'
Assert-True ($engagedRefusal.Contains('maintenance barrier')) 'the refusal does not say what is in the way'
Assert-True ($engagedRefusal.Contains('run-states')) 'the refusal does not name the command that lifts it, so a reader is stopped with no route out'
Assert-True ($engagedRefusal.Contains('Reading is unaffected')) 'the refusal does not say that reads still work, which is what stops a reader concluding the Library is down'

# A SECOND BARRIER IS REFUSED, so two cutovers cannot both believe they hold the tree.
Assert-Refused { New-FixtureBarrier $states 'run-second' } 'already up' 'a second barrier was raised over the first' | Out-Null

# THE DAMAGED RECORD IS THE HALF THAT DECIDES WHETHER THIS IS A BARRIER AT ALL.
$markerPath = Get-MaintenanceBarrierPath -Workspace $states
[IO.File]::WriteAllText($markerPath, '{ not json at all', $utf8)
Assert-Equal 'unreadable' ([string](Get-MaintenanceBarrierState -Workspace $states).state) 'a corrupt marker did not report as unreadable'
Assert-True (Test-MaintenanceBarrierEngaged -Workspace $states) 'A CORRUPT MARKER READ AS ABSENT; corruption would re-open every mutator in the middle of a cutover'
Assert-True ((Get-MaintenanceBarrierRefusal -Workspace $states -Operation 'x').Contains('not valid JSON')) 'the unreadable refusal does not say what is wrong with the record'
# A record that parses but is missing a field is the same fault one layer in.
[IO.File]::WriteAllText($markerPath, '{"schema":1,"barrier_id":"abc"}', $utf8)
Assert-Equal 'unreadable' ([string](Get-MaintenanceBarrierState -Workspace $states).state) 'a record missing operation/reason/engaged_utc read as a valid barrier'
Assert-Refused { Remove-MaintenanceBarrier -Workspace $states -BarrierId 'abc' } 'cannot be read' 'an unreadable barrier was lowered by id' | Out-Null
Assert-Equal 'removed' ([string](Remove-MaintenanceBarrier -Workspace $states -Force)) '-Force did not clear a damaged marker'
Assert-Equal 'absent' ([string](Get-MaintenanceBarrierState -Workspace $states).state) 'the damaged marker survived -Force'

# AND A LIVE BARRIER IS NOT LOWERED BY SOMEBODY ELSE'S ID.
$raised = New-FixtureBarrier $states 'run-owner'
Assert-Refused { Remove-MaintenanceBarrier -Workspace $states -BarrierId ([guid]::NewGuid().ToString('N')) } 'different id' 'one run lowered another run''s barrier' | Out-Null
Assert-Equal 'removed' ([string](Remove-MaintenanceBarrier -Workspace $states -BarrierId ([string]$raised.barrier_id))) 'the owning run could not lower its own barrier'

# === 2. A real claim-gated mutator, refused under a barrier =======================================
$guards = New-FixtureWorkspace 'guards'
$guardState = Join-Path $guards '.claude'
Initialize-SeatForFixture -StateDirectory $guardState -Seat 'alpha' -Project 'alpha-project' | Out-Null
Enter-FixtureSeatClaim -StateDirectory $guardState -Seat 'alpha' | Out-Null
$claimToken = [string]$env:LIBRARY_SEAT_CLAIM

$desk = Join-Path $PSScriptRoot 'Set-VirtualDesk.ps1'
# THE POSITIVE CONTROL FIRST. Without it, a red below could mean the fixture never worked at all --
# and a guard asserted only by what it blocks passes just as well when it blocks everything.
& $desk -Action Clear -Seat 'alpha' -WorkspacePath $guards -ClaimToken $claimToken | Out-Null
Assert-True (Test-Path -LiteralPath (Get-DeskFilePath -StateDirectory $guardState -Seat 'alpha' -Kind 'books') -PathType Leaf) 'the claim-gated mutator could not run in this fixture even with no barrier, so its refusal below would prove nothing'

$guardBarrier = New-FixtureBarrier $guards 'run-guards'
$deskRefusal = Assert-Refused { & $desk -Action Clear -Seat 'alpha' -WorkspacePath $guards -ClaimToken $claimToken } 'maintenance barrier' 'a claim-gated mutator ran under a maintenance barrier'
Assert-True ($deskRefusal.Contains("seat 'alpha'")) 'the mutator''s refusal does not name the seat it was acting at'
Assert-True (-not $deskRefusal.Contains('no live session')) 'THE WRONG GUARD SPOKE: the claim check answered before the barrier, and it sends the reader to a launcher the barrier also refuses'

# The assertion itself, directly, so the derivation the gate check relies on is exercised here too.
Assert-Refused { Assert-SeatClaimHeld -StateDirectory $guardState -Seat 'alpha' -Token $claimToken } 'maintenance barrier' 'Assert-SeatClaimHeld admitted a session under a barrier' | Out-Null
# AND IT REFUSES A STATE DIRECTORY IT CANNOT DERIVE A WORKSPACE FROM, rather than quietly guarding
# the wrong tree.
Assert-Refused { Assert-SeatClaimHeld -StateDirectory $guards -Seat 'alpha' -Token $claimToken } 'cannot be derived' 'a state directory that is not a .claude folder was guarded against the wrong tree' | Out-Null

# === 3. Both seat entry routes, including their preflights ========================================
$starter = Join-Path $PSScriptRoot 'Start-LibrarySeat.ps1'
$enter = Join-Path $PSScriptRoot 'Enter-LibrarySeat.ps1'
Assert-Refused { & $starter -Seat 'alpha' -WorkspacePath $guards -Preflight } 'maintenance barrier' 'the launcher planned a seat start under a barrier' | Out-Null
Assert-Refused { & $starter -Seat 'alpha' -WorkspacePath $guards -NoLaunch } 'maintenance barrier' 'the launcher entered a seat under a barrier' | Out-Null
Assert-Refused { & $enter -Seat 'alpha' -WorkspacePath $guards -Preflight } 'maintenance barrier' 'the bind route planned a seat entry under a barrier' | Out-Null
Assert-Refused { & $enter -Seat 'alpha' -WorkspacePath $guards -AgentProcessId $PID } 'maintenance barrier' 'the bind route bound an agent under a barrier' | Out-Null
Remove-MaintenanceBarrier -Workspace $guards -BarrierId ([string]$guardBarrier.barrier_id) | Out-Null

# === 4. The mover refuses to engage while work is live ============================================
$liveSource = Join-Path $root 'live-source'
Write-FixtureFile (Join-Path $liveSource 'a.txt') "alpha`n" | Out-Null
$liveDestination = Join-Path $root 'live-destination'
$liveArgs = @{ SourcePath = $liveSource; DestinationPath = $liveDestination; WorkspacePath = $guards; Preflight = $true }
$heldRefusal = Assert-Refused { & $mover @liveArgs } 'cannot start while work is live' 'the mover planned a cutover while a seat was held'
Assert-True ($heldRefusal.Contains("seat 'alpha' is held")) 'the refusal does not name the seat that is in the way'

# THE ORPHANED CASE, which is the one a plain "is anybody claiming it" check gets wrong: the holder
# is gone and the AGENT IS STILL RUNNING, which is a live session with dead bookkeeping.
Exit-FixtureSeatClaim
$agent = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 120' -PassThru -WindowStyle Hidden
try {
    # THROUGH THE REAL WRITER, under the registry lock it asserts, so the binding this fixture
    # presents is the shape production writes rather than one retyped here.
    $registryLock = Enter-SeatRegistryLock -Workspace $guards
    try {
        Write-SeatBinding -Workspace $guards -StateDirectory $guardState -Seat 'alpha' -AgentProcessId $agent.Id `
            -AgentStartUtc (Get-AgentProcessIdentity -ProcessId $agent.Id) -State 'committed' | Out-Null
    }
    finally { Exit-BookLock -Lock $registryLock }
    Assert-Equal 'orphaned' ([string](Get-SeatClaimState -StateDirectory $guardState -Seat 'alpha' -AgentProcessId 0).state) 'the fixture did not reach the orphaned state, so nothing below is refused for the right reason'
    $orphanRefusal = Assert-Refused { & $mover @liveArgs } 'cannot start while work is live' 'AN ORPHANED SEAT DID NOT BLOCK A CUTOVER; a live agent would have its material moved out from under it'
    Assert-True ($orphanRefusal.Contains('orphaned')) 'the refusal does not distinguish an orphaned seat from a held one, so the reader is given the wrong remedy'
}
finally { Stop-Process -Id $agent.Id -Force -ErrorAction SilentlyContinue }

# === 4b. The operator's own seat, excused only when it is PROVEN ==================================
#
# THE GAP S2 SHIPPED, WHICH THIS SUITE COULD NOT SEE. Every fixture above runs against a workspace
# whose seats are free, so section 4 proved that a held seat blocks and never asked whether the seat
# the cutover is being DRIVEN from should count. It did -- so `-Preflight` from the library-dev seat
# was refused with "seat 'library-dev' is held by a live session", and the Librarian could run only
# -Action Status, contradicting the playbook that tells it to run the preflight and show the reader
# what it reports. Ruled by Eric 2026-09-19; ADR-0033.
#
# TWO HELD SEATS, BECAUSE ONE CANNOT TELL THE TWO FIXES APART. With a single held seat, an exemption
# that excuses exactly one seat and an exemption that quietly disables the whole scan both go green.
# The bystander is the only thing that separates them, so it is not scenery.
$two = New-FixtureWorkspace 'operator-seat'
$twoState = Join-Path $two '.claude'
Initialize-SeatForFixture -StateDirectory $twoState -Seat 'operator' -Project 'operator-project' | Out-Null
Initialize-SeatForFixture -StateDirectory $twoState -Seat 'bystander' -Project 'bystander-project' | Out-Null
# HELD DIRECTLY, not through Enter-FixtureSeatClaim, which is single-slot by design: it releases the
# previous claim before taking the next, so it cannot express "two live seats at once" at all.
$operatorClaim = Enter-SeatClaim -StateDirectory $twoState -Seat 'operator'
$bystanderClaim = Enter-SeatClaim -StateDirectory $twoState -Seat 'bystander'
$bystanderHeld = $true
try {
    Assert-Equal 'held' ([string](Get-SeatClaimState -StateDirectory $twoState -Seat 'operator' -AgentProcessId 0).state) 'the operator seat is not held, so nothing below is asserted against the state that matters'
    Assert-Equal 'held' ([string](Get-SeatClaimState -StateDirectory $twoState -Seat 'bystander' -AgentProcessId 0).state) 'the bystander seat is not held, so a green below could be an empty registry rather than a working exemption'

    $opSource = Join-Path $root 'operator-source'
    Write-FixtureFile (Join-Path $opSource 'a.txt') "alpha`n" | Out-Null
    $opArgs = @{ SourcePath = $opSource; DestinationPath = (Join-Path $root 'operator-destination'); WorkspacePath = $two; Preflight = $true }

    # (1) THE BYSTANDER STILL BLOCKS, asserted in BOTH directions. A refusal naming both seats would
    #     mean the exemption never applied; one naming neither would mean the scan stopped looking.
    $mixed = Assert-Refused { & $mover @opArgs -OperatorSeat 'operator' -OperatorClaimToken $operatorClaim.token -OperatorAgentProcessId 0 } `
        'cannot start while work is live' 'a held BYSTANDER seat did not block a cutover, so the exemption excused more than the one seat it was given'
    Assert-True ($mixed.Contains("seat 'bystander' is held")) 'the refusal does not name the bystander, so the scan skipped a seat nobody proved anything about'
    Assert-True (-not $mixed.Contains("seat 'operator' is held")) 'THE OPERATOR WAS COUNTED AGAINST ITSELF: its proven seat is still listed as a reason not to start, which is the whole defect'

    # (2) THE NEGATIVE, AND IT IS THE ONE THAT FALSIFIES THIS CHANGE. A seat NAMED without a matching
    #     claim proves nothing and must still block. Delete the token comparison in
    #     Resolve-OperatorSeatExemption and this is the assertion that goes green while every other
    #     one here stays green -- which is exactly what "never by name alone" has to mean.
    $unproven = Assert-Refused { & $mover @opArgs -OperatorSeat 'operator' -OperatorClaimToken 'not-the-held-token' -OperatorAgentProcessId 0 } `
        'cannot start while work is live' 'a cutover started after naming a seat it held no claim for'
    Assert-True ($unproven.Contains("seat 'operator' is held")) 'A NAME ALONE BOUGHT THE EXEMPTION: the operator seat was excused without proving it holds the claim'

    # (3) A SEAT NAME NO REGISTRY KNOWS buys nothing either, and must not throw on the way.
    $unknown = Assert-Refused { & $mover @opArgs -OperatorSeat 'no-such-seat' -OperatorClaimToken $operatorClaim.token -OperatorAgentProcessId 0 } `
        'cannot start while work is live' 'an unregistered operator seat was not handled as "nothing is exempt"'
    Assert-True ($unknown.Contains("seat 'operator' is held")) 'naming an unknown seat somehow excused a different one'

    # (4) THE POSITIVE. With the bystander gone, the operator's own held seat is the ONLY thing left,
    #     and the preflight must now produce a plan rather than a refusal.
    Exit-SeatClaim -Claim $bystanderClaim
    $bystanderHeld = $false
    Assert-Equal 'free' ([string](Get-SeatClaimState -StateDirectory $twoState -Seat 'bystander' -AgentProcessId 0).state) 'the bystander claim did not release, so a green below would be for the wrong reason'
    $opPlan = & $mover @opArgs -OperatorSeat 'operator' -OperatorClaimToken $operatorClaim.token -OperatorAgentProcessId 0
    Assert-Equal 'operator' ([string](Get-Field $opPlan 'exempt_seat' 'the operator-seat plan')) 'the plan does not name the seat it excused, so an exemption would relax the guard where no reader could see it'
    Assert-Equal '1' ([string](Get-Field $opPlan 'file_count' 'the operator-seat plan')) 'the preflight did not reach the inventory'

    # (5) THE OTHER HALF OF THE PROOF. Assert-SeatClaimHeld admits EITHER a matching token OR a
    #     committed binding naming this process's agent, and an exemption asserted through only one
    #     of them leaves the other route unasserted. This case supplies a DELIBERATELY WRONG token so
    #     the binding is the only thing that can grant it.
    $registryLock = Enter-SeatRegistryLock -Workspace $two
    try {
        Write-SeatBinding -Workspace $two -StateDirectory $twoState -Seat 'operator' -AgentProcessId $PID `
            -AgentStartUtc (Get-AgentProcessIdentity -ProcessId $PID) -State 'committed' | Out-Null
    }
    finally { Exit-BookLock -Lock $registryLock }
    Assert-True ([bool](Get-SeatClaimState -StateDirectory $twoState -Seat 'operator' -AgentProcessId $PID).this_agent) 'the binding fixture did not reach this_agent, so the case below proves nothing about the binding route'
    $boundPlan = & $mover @opArgs -OperatorSeat 'operator' -OperatorClaimToken 'not-the-held-token' -OperatorAgentProcessId $PID
    Assert-Equal 'operator' ([string](Get-Field $boundPlan 'exempt_seat' 'the bound-operator plan')) 'THE BINDING ROUTE IS UNWIRED: a committed binding naming this agent did not excuse the operator seat, so only the token half works'
}
finally {
    if ($bystanderHeld) { Exit-SeatClaim -Claim $bystanderClaim }
    Exit-SeatClaim -Claim $operatorClaim
}

# === 5. A fresh Book lock blocks; a stale one is reported instead ==================================
$locks = New-FixtureWorkspace 'locks'
$lockDirectory = Join-Path $locks 'internal/book-locks'
New-Item -ItemType Directory -Path $lockDirectory -Force | Out-Null
$freshLock = Join-Path $lockDirectory 'shelf-demo.lock'
[IO.File]::WriteAllText($freshLock, "pid=$PID`n", $utf8)
$lockArgs = @{ SourcePath = $liveSource; DestinationPath = $liveDestination; WorkspacePath = $locks; Preflight = $true }
$lockRefusal = Assert-Refused { & $mover @lockArgs } 'Book lock is held' 'a cutover started while a writer held a Book lock'
Assert-True ($lockRefusal.Contains('shelf-demo')) 'the refusal does not name the lock that is in the way'

# STALE IS A DIFFERENT ANSWER, and the threshold is the code's own rather than a number retyped
# here: Enter-BookLock steals a lock older than it, so a lock nothing waits on is not a writer.
(Get-Item -LiteralPath $freshLock).LastWriteTime = (Get-Date).AddMinutes(-1 * ($script:StaleLockMinutes + 5))
$stalePlan = & $mover @lockArgs
$staleRows = @(Get-Field $stalePlan 'stale_locks' 'the plan')
Assert-Equal '1' ([string]$staleRows.Count) 'a stale lock was neither blocking nor reported, so a tree full of them is invisible before a cutover'
Assert-True (([string]$staleRows[0]).Contains('shelf-demo')) 'the stale-lock line does not name the lock'
Remove-Item -LiteralPath $freshLock -Force

# === 6. The preflight: hashes, plan_id, and the refusals that precede one ==========================
$work = New-FixtureWorkspace 'work'
$tree = Join-Path $root 'tree'
$source = Join-Path $tree 'source'
$destination = Join-Path $tree 'destination'
Write-FixtureFile (Join-Path $source 'root.md') "the root page`n" | Out-Null
Write-FixtureFile (Join-Path $source 'notes/one.md') "note one`n" | Out-Null
Write-FixtureFile (Join-Path $source 'notes/deep/two.md') "note two, with a non-ASCII byte: e-acute is here`n" | Out-Null
New-Item -ItemType Directory -Path (Join-Path $source 'empty-on-purpose') -Force | Out-Null

$baseArgs = @{ SourcePath = $source; DestinationPath = $destination; WorkspacePath = $work }
$plan = & $mover @baseArgs -Preflight
Assert-Equal '3' ([string](Get-Field $plan 'file_count' 'the plan')) 'the inventory did not find every file'
Assert-True ([int](Get-Field $plan 'directory_count' 'the plan') -ge 3) 'the inventory lost a directory; an empty one would not be recreated'
Assert-True (([string](Get-Field $plan 'plan_id' 'the plan')).StartsWith('move-library-folder-')) 'the plan_id is not spelled the way the confirmed run compares it'
# THE NORMALISED SPELLINGS THE HELPER ITSELF REPORTS, so every assertion below compares the strings
# the rewrite actually used rather than the ones this fixture happened to type.
$normalisedSource = [string](Get-Field $plan 'source' 'the plan')
$normalisedDestination = [string](Get-Field $plan 'destination' 'the plan')
$firstPlanId = [string]$plan.plan_id
Assert-Equal $firstPlanId ([string](& $mover @baseArgs -Preflight).plan_id) 'two preflights over an unchanged tree produced different plan_ids, so no approval could ever match'

# THE PLAN_ID IS BOUND TO THE BYTES. A source edited after the reader approved must turn it.
Write-FixtureFile (Join-Path $source 'notes/one.md') "note one, edited`n" | Out-Null
Assert-True (([string](& $mover @baseArgs -Preflight).plan_id) -cne $firstPlanId) 'A SOURCE EDIT DID NOT CHANGE THE PLAN_ID; an approval would then cover bytes the reader never saw'
Write-FixtureFile (Join-Path $source 'notes/one.md') "note one`n" | Out-Null
Assert-Equal $firstPlanId ([string](& $mover @baseArgs -Preflight).plan_id) 'the plan_id did not return to its original value when the edit was undone'

# THE REFUSALS THAT COME BEFORE A PLAN_ID IS ISSUED.
Assert-Refused { & $mover -SourcePath (Join-Path $tree 'nothing-here') -DestinationPath $destination -WorkspacePath $work -Preflight } 'is not a folder' 'a missing source was planned rather than refused' | Out-Null
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Assert-Refused { & $mover @baseArgs -Preflight } 'already exists' 'a colliding destination was given a plan_id, so an approval was requested for a run certain to fail' | Out-Null
Remove-Item -LiteralPath $destination -Recurse -Force
Assert-Refused { & $mover -SourcePath $source -DestinationPath (Join-Path $source 'inside') -WorkspacePath $work -Preflight } 'inside' 'a destination inside the source was accepted' | Out-Null
Assert-Refused { & $mover -SourcePath (Join-Path $source 'notes') -DestinationPath $destination -WorkspacePath $work -AsidePath (Join-Path $source 'notes/aside') -Preflight } 'inside' 'an aside path inside the source was accepted' | Out-Null

# === 7. Pointer rewriting: one fixture per spelling, plus the negatives ============================
$pointers = Join-Path $tree 'pointers'
$nativePointer = Write-FixtureFile (Join-Path $pointers 'native.md') @"
The workspace lives at "$normalisedSource".
Its notes are at $normalisedSource\notes.
A sibling folder called ${normalisedSource}-DSH is a DIFFERENT folder and must not move.
"@
$forwardPointer = Write-FixtureFile (Join-Path $pointers 'forward.md') @"
repo: $($normalisedSource.Replace('\', '/'))
deep: $($normalisedSource.Replace('\', '/'))/notes/deep
"@
$jsonPointer = Write-FixtureFile (Join-Path $pointers 'settings.json') ('{"workspace":"' + $normalisedSource.Replace('\', '\\') + '","notes":"' + $normalisedSource.Replace('\', '\\') + '\\notes"}' + "`n")
# THE AMBIGUOUS CASE: a space can legally be part of a folder name, so `<source> Backup` might be a
# different folder. It is reported and left, never guessed at.
$prosePointer = Write-FixtureFile (Join-Path $pointers 'prose.md') @"
The folder $normalisedSource Backup is not the same thing.
"@
$proseBefore = [IO.File]::ReadAllText($prosePointer, $utf8)

$pointerArgs = @{ SourcePath = $source; DestinationPath = $destination; WorkspacePath = $work
                  PointerPath = @($nativePointer, $forwardPointer, $jsonPointer, $prosePointer) }
$pointerPlan = & $mover @pointerArgs -Preflight
$rows = @(Get-Field $pointerPlan 'pointers' 'the plan')
Assert-Equal '4' ([string]$rows.Count) 'the plan lost a pointer file'
Assert-Equal '2' ([string](Get-PointerRow $rows $nativePointer).rewritable_count) 'the native spelling was not matched twice, or the sibling folder was swept up with it'
Assert-Equal '2' ([string](Get-PointerRow $rows $forwardPointer).rewritable_count) 'the forward-slash spelling was not matched'
Assert-Equal '2' ([string](Get-PointerRow $rows $jsonPointer).rewritable_count) 'the JSON-escaped spelling was not matched'
Assert-Equal '0' ([string](Get-PointerRow $rows $prosePointer).rewritable_count) 'A PATH FOLLOWED BY A SPACE WAS REWRITTEN; the folder named after it would become one nobody asked for'
Assert-Equal '1' ([string]@((Get-PointerRow $rows $prosePointer).ambiguous_occurrences).Count) 'the ambiguous occurrence was neither rewritten nor reported, so a stale pointer would be invisible'
Assert-Equal '1' ([string]@((Get-PointerRow $rows $nativePointer).ambiguous_occurrences).Count) 'the sibling folder was not reported as an occurrence this run leaves alone'
Assert-Equal '2' ([string](Get-Field $pointerPlan 'ambiguous_total' 'the plan')) 'the plan did not total the ambiguous occurrences across files'
Assert-Refused { & $mover @baseArgs -PointerPath (Join-Path $source 'root.md') -Preflight } 'inside the folder being moved' 'a pointer inside the source was accepted, so the aside copy and the destination would disagree' | Out-Null

# === 8. The confirmed move, end to end ============================================================
$confirmedPlan = & $mover @pointerArgs -Preflight
$planId = [string]$confirmedPlan.plan_id
$aside = [string](Get-Field $confirmedPlan 'aside' 'the plan')
$sourceHashes = @{}
foreach ($file in @([IO.Directory]::GetFiles($normalisedSource, '*', 'AllDirectories'))) {
    $sourceHashes[$file.Substring($normalisedSource.Length + 1)] = (Get-FileSha256 $file)
}
$priorJsonBytes = [IO.File]::ReadAllBytes($jsonPointer)

# NO -AsidePath HERE, DELIBERATELY. The default is derived rather than stamped, so the preflight's
# plan_id still describes this run -- the property every approval depends on, asserted by this call
# succeeding with the id the preflight issued a moment ago.
$moved = & $mover @pointerArgs -UserConfirmed -ApprovedPlanId $planId
$runId = [string](Get-Field $moved 'run_id' 'the result')
Assert-True (Test-Path -LiteralPath $normalisedDestination -PathType Container) 'the destination was not created'
Assert-True (-not (Test-Path -LiteralPath $normalisedSource)) 'the source is still at its old path, so two live copies exist'
Assert-True (Test-Path -LiteralPath $aside -PathType Container) 'THE SOURCE WAS DELETED RATHER THAN RENAMED ASIDE; the cutover has no copy to roll back to'
Assert-True (Test-Path -LiteralPath (Join-Path $normalisedDestination 'empty-on-purpose') -PathType Container) 'an empty directory was not carried to the destination'
foreach ($relative in @($sourceHashes.Keys)) {
    Assert-Equal $sourceHashes[$relative] (Get-FileSha256 (Join-Path $normalisedDestination $relative)) "$relative does not hash the same at the destination"
}
Assert-Equal 'absent' ([string](Get-MaintenanceBarrierState -Workspace $work).state) 'the cutover left the Library stopped'

# THE POINTERS NAME THE NEW PATH AND NOTHING ELSE CHANGED.
$nativeAfter = [IO.File]::ReadAllText($nativePointer, $utf8)
Assert-True ($nativeAfter.Contains('"' + $normalisedDestination + '"')) 'the quoted native occurrence was not rewritten'
Assert-True ($nativeAfter.Contains($normalisedDestination + '\notes')) 'the separator-terminated native occurrence was not rewritten'
Assert-True ($nativeAfter.Contains($normalisedSource + '-DSH')) 'THE SIBLING FOLDER WAS REWRITTEN; a boundary-blind replace renames folders nobody asked about'
Assert-True (-not $nativeAfter.Contains('"' + $normalisedSource + '"')) 'the native pointer still names the old path'
$forwardAfter = [IO.File]::ReadAllText($forwardPointer, $utf8)
Assert-True ($forwardAfter.Contains($normalisedDestination.Replace('\', '/'))) 'the forward-slash pointer was not rewritten in its own spelling'
Assert-True (-not $forwardAfter.Contains($normalisedSource.Replace('\', '/'))) 'the forward-slash pointer still names the old path'
$jsonAfter = [IO.File]::ReadAllText($jsonPointer, $utf8)
Assert-True ($jsonAfter.Contains($normalisedDestination.Replace('\', '\\'))) 'the JSON pointer was not rewritten in its own escaped spelling'
Assert-True (-not $jsonAfter.Contains('\\\\')) 'the JSON rewrite doubled the escaping, so the file no longer names a real path'
Assert-Equal $proseBefore ([IO.File]::ReadAllText($prosePointer, $utf8)) 'the ambiguous pointer file was changed after all'

# THE JOURNAL RECORDS EVERY STAGE, AND THE CHECKPOINT IS A COMMAND.
$journalPath = Join-Path $work ('internal/move-journals/' + $runId + '.json')
Assert-True (Test-Path -LiteralPath $journalPath -PathType Leaf) 'the run left no journal under internal/'
$journal = [IO.File]::ReadAllText($journalPath, $utf8) | ConvertFrom-Json
Assert-Equal 'complete' ([string](Get-Field $journal 'state' 'the journal')) 'the journal does not record the run as complete'
$stages = @(@($journal.stages) | ForEach-Object { [string]$_.stage })
foreach ($stage in @('planned', 'copied', 'copy-verified', 'source-aside', 'pointers-updated', 'verified', 'checkpointed', 'complete')) {
    Assert-True ($stages -ccontains $stage) "the journal has no '$stage' stage, so an interrupted run could not be read back to where it stopped"
}
Assert-Equal 'absent' ([string](Get-Field $journal 'destination_prior_state' 'the journal')) 'the journal did not record the destination''s prior ABSENCE, so a rollback would resurrect rather than delete'
Assert-True (([string](Get-Field $journal 'rollback' 'the journal').command).Contains($runId)) 'the rollback checkpoint does not name the run it undoes'

# === 9. A wrong plan_id refuses, asserted at the material ==========================================
$second = Join-Path $tree 'second-source'
Write-FixtureFile (Join-Path $second 'x.md') "x`n" | Out-Null
$secondDestination = Join-Path $tree 'second-destination'
$secondArgs = @{ SourcePath = $second; DestinationPath = $secondDestination; WorkspacePath = $work }
Assert-Refused { & $mover @secondArgs -UserConfirmed -ApprovedPlanId 'move-library-folder-0000' } 'no longer describes them' 'a stale plan_id was accepted' | Out-Null
Assert-True (-not (Test-Path -LiteralPath $secondDestination)) 'a refused run still created the destination'
Assert-True (Test-Path -LiteralPath (Join-Path $second 'x.md') -PathType Leaf) 'a refused run moved the source anyway'
Assert-Equal 'absent' ([string](Get-MaintenanceBarrierState -Workspace $work).state) 'a refused run left the barrier up'
$secondPlanId = [string](& $mover @secondArgs -Preflight).plan_id
Assert-Refused { & $mover @secondArgs -ApprovedPlanId $secondPlanId } 'rerun with -UserConfirmed' 'a run with a valid plan_id and no confirmation went ahead' | Out-Null

# THE MOVE PATH REALLY RAISES A BARRIER, proved by what happens when one is already standing. The
# confirmed run has no barrier pre-check of its own -- the refusal can only come from the exclusive
# create inside New-MaintenanceBarrier -- so a move that stopped raising one would copy straight
# past this and nothing would stop a writer mid-copy. That is the regression a static check cannot
# see: the helper still calls New-MaintenanceBarrier on its OTHER path.
$standing = New-FixtureBarrier $work 'run-standing'
Assert-Refused { & $mover @secondArgs -UserConfirmed -ApprovedPlanId $secondPlanId } 'already up' 'A CONFIRMED MOVE RAN WITH A BARRIER ALREADY STANDING, so the move path raises none of its own' | Out-Null
Assert-True (-not (Test-Path -LiteralPath $secondDestination)) 'the run refused by a standing barrier copied anyway'
Remove-MaintenanceBarrier -Workspace $work -BarrierId ([string]$standing.barrier_id) | Out-Null

# === 10. The rollback ==============================================================================
$rollbackPlan = & $mover -Action Rollback -RunId $runId -WorkspacePath $work -Preflight
Assert-Equal $aside ([string](Get-Field $rollbackPlan 'aside' 'the rollback plan')) 'the rollback plan does not name the aside copy'
# AND THE ROLLBACK RAISES ONE TOO, by the same proof: it moves the same material a cutover does.
$standingForRollback = New-FixtureBarrier $work 'run-standing-rollback'
Assert-Refused { & $mover -Action Rollback -RunId $runId -WorkspacePath $work -UserConfirmed -ApprovedPlanId ([string]$rollbackPlan.plan_id) } 'already up' 'A ROLLBACK RAN WITH A BARRIER ALREADY STANDING, so it raises none of its own' | Out-Null
Remove-MaintenanceBarrier -Workspace $work -BarrierId ([string]$standingForRollback.barrier_id) | Out-Null
& $mover -Action Rollback -RunId $runId -WorkspacePath $work -UserConfirmed -ApprovedPlanId ([string]$rollbackPlan.plan_id) | Out-Null
Assert-True (Test-Path -LiteralPath $normalisedSource -PathType Container) 'the rollback did not put the source back'
Assert-True (-not (Test-Path -LiteralPath $normalisedDestination)) 'the rollback left the destination copy in place'
Assert-True (-not (Test-Path -LiteralPath $aside)) 'the rollback left the aside copy behind as well as the source'
foreach ($relative in @($sourceHashes.Keys)) {
    Assert-Equal $sourceHashes[$relative] (Get-FileSha256 (Join-Path $normalisedSource $relative)) "$relative does not hash the same after the rollback"
}
Assert-Equal ([Convert]::ToBase64String($priorJsonBytes)) ([Convert]::ToBase64String([IO.File]::ReadAllBytes($jsonPointer))) 'the JSON pointer was not restored byte for byte'
Assert-Equal 'absent' ([string](Get-MaintenanceBarrierState -Workspace $work).state) 'the rollback left the barrier up'
Assert-Refused { & $mover -Action Rollback -RunId $runId -WorkspacePath $work -UserConfirmed -ApprovedPlanId 'x' } 'already been rolled back' 'a run was rolled back twice' | Out-Null

# === 11. A rollback refuses a destination somebody has written to ==================================
$third = Join-Path $tree 'third-source'
Write-FixtureFile (Join-Path $third 'y.md') "y`n" | Out-Null
$thirdDestination = Join-Path $tree 'third-destination'
$thirdArgs = @{ SourcePath = $third; DestinationPath = $thirdDestination; WorkspacePath = $work }
$thirdPlan = & $mover @thirdArgs -Preflight
$thirdAside = [string]$thirdPlan.aside
$thirdMoved = & $mover @thirdArgs -UserConfirmed -ApprovedPlanId ([string]$thirdPlan.plan_id)
$thirdRun = [string]$thirdMoved.run_id
Write-FixtureFile (Join-Path $thirdDestination 'written-since.md') "work done at the new path`n" | Out-Null
$thirdRollback = & $mover -Action Rollback -RunId $thirdRun -WorkspacePath $work -Preflight
Assert-Refused { & $mover -Action Rollback -RunId $thirdRun -WorkspacePath $work -UserConfirmed -ApprovedPlanId ([string]$thirdRollback.plan_id) } 'no longer holds exactly' 'A ROLLBACK DELETED A DESTINATION SOMEBODY HAD WRITTEN TO; that work exists in no journal' | Out-Null
Assert-True (Test-Path -LiteralPath (Join-Path $thirdDestination 'written-since.md') -PathType Leaf) 'the refused rollback destroyed the new work anyway'
Assert-True (Test-Path -LiteralPath $thirdAside -PathType Container) 'the refused rollback moved the aside copy back and left the destination, which is neither state'
Assert-Equal 'absent' ([string](Get-MaintenanceBarrierState -Workspace $work).state) 'the refused rollback left the barrier up'

# === 12. An unfinished run blocks the next cutover, and Status reports it ==========================
$status = & $mover -Action Status -WorkspacePath $work
$incomplete = @(Get-Field $status 'incomplete_runs' 'the status')
Assert-Equal '1' ([string]@(@($incomplete) | Where-Object { [string]$_.run_id -ceq $thirdRun }).Count) 'Status does not report the run whose rollback failed'
$fourth = Join-Path $tree 'fourth-source'
Write-FixtureFile (Join-Path $fourth 'z.md') "z`n" | Out-Null
Assert-Refused { & $mover -SourcePath $fourth -DestinationPath (Join-Path $tree 'fourth-destination') -WorkspacePath $work -Preflight } 'have not completed' 'a new cutover started on top of a run that had not finished' | Out-Null

}
catch { $failure = $_ }
finally {
    Exit-FixtureSeatClaim
    $env:LIBRARY_SEAT = $savedSeat
    $env:LIBRARY_SEAT_CLAIM = $savedClaim
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($null -ne $failure) {
    [Console]::Error.WriteLine("folder move: FAILED at assertion $($script:cases) -- $($failure.Exception.Message)")
    exit 1
}

"folder move: $($script:cases) assertion(s) over the barrier's three states, the claim-gated and launcher refusals, the live-seat and orphaned-seat and Book-lock engage refusals, the operator seat excused by token and by binding with a bystander still blocking and a named-but-unproven seat refused, the hashed preflight and its four earlier refusals, three pointer spellings with the sibling-path and trailing-space negatives, a confirmed cutover with its journal and checkpoint, a refused plan_id asserted at the material, the rollback, and a rollback refused against an edited destination"
