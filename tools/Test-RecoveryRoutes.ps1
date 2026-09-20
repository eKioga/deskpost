<#
.SYNOPSIS
    The four recovery routes, driven against their own fixtures: the quarantine restore and purge,
    the Desk restore from a seat archive, and the seat-archive purge's stranding refusal. Run by
    Invoke-LibraryChecks.ps1 as `recovery.routes`.

.DESCRIPTION
    WHY THIS EXISTS. Both stores this model sets material aside in were write-only until 2026-09-10:
    the reset called quarantined topics "recoverable" and retirement archived a Desk "rather than
    discarding it", and nothing read either back. These are the routes that close that, and two of
    the four DESTROY rather than move -- which is what decides the shape of this suite.

    FOUR WORKSPACES, NOT ONE. A purge really deletes; a case that ran it in a shared fixture would
    leave every later case reading state this one destroyed, and the red would then name an
    unrelated crash rather than the defect. Each section builds its own workspace and the
    destructive ones are alone in theirs.

    THE SEATS ARE REAL ENTRIES WITH REAL INCARNATIONS. `Initialize-SeatForFixture -SeatId` writes the
    registry entry, and every ownership row after that is written by the real
    `Set-NotebookTopicOwner`, which reads the incarnation off that entry -- so a row's id comes from
    the production path rather than from this file. Retirement, the reset, the restore and both
    purges are the real helpers: the reset in-process because it emits an object rather than JSON,
    the rest as child processes over `-Json`, which is how the Librarian reaches them.

    WHAT EACH SECTION PINS.

      1  the roster read, which must answer a session with no seat at all
      2  the restore's plan: three topics, their dispositions, and the loose file
      3  a wrong plan_id refuses, asserted at the MATERIAL rather than at the exit code
      4  the restore itself, with the bystander's topic and row as the decoy
      5  the collision refusal, asserted once at the move, with a positive control beside it
      6  adoption across incarnations: a retired seat's topic, refused, then taken over
     6b  the completed reset reports what REMAINS, re-derived after the moves, against a prediction
         that disagrees with it -- with a protected topic as the decoy that must survive the run
     6c  the same read from the other side: a topic left in place by a refused move, now foreign
      7  a LIVE seat's row refused, and -Adopt deliberately failing to lift it
      8  the purge: rows and material both gone, a live topic's row kept, a foreign row refused
      9  the seat-archive purge: the stranding refusal, the duplicate record, and the way out
     10  the Desk restore: additive, the history onto its own slug only, and refused onto another

    THREE TOPICS WHEREVER A SET IS CLASSIFIED. With two, a truncation puts one in the right bucket
    and loses the other invisibly; three is the smallest number at which a dropped row is
    distinguishable from a reordering. The same rule gives section 10 three conversations.
#>
[CmdletBinding()]
param([switch]$Json)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')

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
# throws PropertyNotFound -- a red that names this file's own line rather than the field the helper
# failed to emit. The names are ENUMERATED rather than read off the aggregate .Name, which on a
# single-property object is a bare string and answers the wrong question.
function Get-Field([object]$Object, [string]$Name, [string]$What) {
    $script:cases++
    $names = @($Object.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -cnotcontains $Name) { throw "$What -- the result carries no '$Name' property; it has: $($names -join ', ')" }
    $Object.$Name
}

$utf8 = [Text.UTF8Encoding]::new($false)
$root = Join-Path ([IO.Path]::GetTempPath()) ('recovery-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$savedSeat = $env:LIBRARY_SEAT
$savedClaim = $env:LIBRARY_SEAT_CLAIM

function New-RecoveryWorkspace([string]$Name) {
    $path = Join-Path $root $Name
    foreach ($relative in @('.claude', 'internal', 'notebook')) {
        New-Item -ItemType Directory -Path (Join-Path $path $relative) -Force | Out-Null
    }
    $path
}
function Add-FixtureSeat([string]$Workspace, [string]$Seat, [string]$Project, [string]$SeatId) {
    Initialize-SeatForFixture -StateDirectory (Join-Path $Workspace '.claude') -Seat $Seat -Project $Project -SeatId $SeatId | Out-Null
}
function Add-Topic([string]$Workspace, [string]$Topic, [string]$Seat) {
    New-Item -ItemType Directory -Path (Join-Path $Workspace "notebook/$Topic") -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $Workspace "notebook/$Topic/_index.md"), "# $Topic`n", $utf8)
    Set-NotebookTopicOwner -Workspace $Workspace -Topic $Topic -Seat $Seat -ActingSeat $Seat
}
function Add-Article([string]$Workspace, [string]$Topic, [string]$Name) {
    [IO.File]::WriteAllText((Join-Path $Workspace "notebook/$Topic/$Name"), "# $Name`n`nbody`n", $utf8)
}
function Use-Seat([string]$Workspace, [string]$Seat) {
    $env:LIBRARY_SEAT = $Seat
    Enter-FixtureSeatClaim -StateDirectory (Join-Path $Workspace '.claude') -Seat $Seat | Out-Null
}
function Get-SeatId([string]$Workspace, [string]$Seat) {
    Get-SeatEntryIncarnation -Entry (Get-SeatEntry -Registry (Read-SeatRegistry -StateDirectory (Join-Path $Workspace '.claude')) -Seat $Seat)
}
function Get-Row([string]$Workspace, [string]$Topic) {
    Get-NotebookTopicOwner -Owners (Read-NotebookTopicOwners -Workspace $Workspace) -Topic $Topic
}
function Get-RowOwner([string]$Workspace, [string]$Topic) {
    $row = Get-Row $Workspace $Topic
    if ($null -eq $row) { return '<no row>' }
    if ([string]$row.scope -cne 'owned') { return "<$([string]$row.scope)>" }
    $id = ''
    if (@($row.PSObject.Properties | ForEach-Object { $_.Name }) -ccontains 'seat_id') { $id = [string]$row.seat_id }
    "$([string]$row.seat):$id"
}
function Test-Topic([string]$Workspace, [string]$Topic) {
    Test-Path -LiteralPath (Join-Path $Workspace "notebook/$Topic") -PathType Container
}
function Get-NotebookTopicNames([string]$Workspace) {
    (@(@(Get-ChildItem -LiteralPath (Join-Path $Workspace 'notebook') -Directory -Force -ErrorAction SilentlyContinue) |
        ForEach-Object { $_.Name } | Sort-Object -CaseSensitive) -join ',')
}

# THE HELPERS AS CHILD PROCESSES, which is how the Librarian reaches them -- and the only way to
# observe that a refused operation printed NO plan at all, because a plan only counts as issued if
# it lands on stdout.
function Invoke-Helper([string]$Helper, [string[]]$ArgumentList) {
    $helperPath = Join-Path $PSScriptRoot $Helper
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $lines = @()
    try { $lines = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helperPath @ArgumentList 2>&1) }
    finally { $ErrorActionPreference = $old }
    $code = $LASTEXITCODE
    # SPLIT BY TYPE, NOT BY PARSING. A native child's stderr arrives as ErrorRecord objects in a
    # merged stream, and telling them apart by their text is how a message that happens to look like
    # output gets counted as one.
    $out = @($lines | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
    $err = @($lines | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
    [pscustomobject]@{
        ExitCode = $code
        Stdout   = $out
        Stderr   = $err
        Text     = (((@($out) + @($err)) -join ' ') -replace '\s+', ' ')
    }
}
function Get-Json($Invocation, [string]$What) {
    $lines = @($Invocation.Stdout | Where-Object { $_.Trim().StartsWith('{') })
    if (-not $lines.Count) { throw "$What -- the helper produced no JSON result; output was: $($Invocation.Text)" }
    ($lines[-1] | ConvertFrom-Json)
}
function Test-NoPlan($Invocation) {
    -not @($Invocation.Stdout | Where-Object { $_.Trim().StartsWith('{') }).Count
}

# THE RESET IN-PROCESS, because it emits an object rather than JSON and a -File child would hand
# back formatted text with no plan_id in it. It is still the real helper on the real path.
function Invoke-Reset([string]$Workspace, [string]$Seat, [switch]$WholeTree) {
    $reset = Join-Path $PSScriptRoot 'Reset-LocalNotebook.ps1'
    $plan = & $reset -WorkspacePath $Workspace -Seat $Seat -WholeTree:$WholeTree -Preflight
    if (@($plan.refusals).Count) { throw "the fixture's own reset refused, so nothing below has a quarantine to work on: $(@($plan.refusals) -join ' ')" }
    & $reset -WorkspacePath $Workspace -Seat $Seat -WholeTree:$WholeTree -UserConfirmed -ApprovedPlanId ([string]$plan.plan_id)
}
function Get-QuarantineName($ResetResult) { Split-Path -Leaf ([string]$ResetResult.quarantine_directory) }

$failure = $null
try {

# =================================================================================================
# 1-7. THE QUARANTINE RESTORE
# =================================================================================================
$restoreWorkspace = New-RecoveryWorkspace 'restore'
Add-FixtureSeat $restoreWorkspace 'owner' 'owner-proj' 'owner-one'
Add-FixtureSeat $restoreWorkspace 'bystand' 'bystand-proj' 'bystand-one'
Use-Seat $restoreWorkspace 'owner'

# THREE OWNED TOPICS AND A BYSTANDER'S. The bystander is the decoy: a restore that put back whatever
# it found, or a purge that dropped every row it read, touches it -- and it is owned by a seat that
# is still registered, so nothing in this file is entitled to it.
foreach ($topic in @('alpha', 'beta', 'gamma')) { Add-Topic $restoreWorkspace $topic 'owner' }
Add-Topic $restoreWorkspace 'bystand-topic' 'bystand'
[IO.File]::WriteAllText((Join-Path $restoreWorkspace 'notebook/stray.md'), "# stray`n", $utf8)

$ownerId = Get-SeatId $restoreWorkspace 'owner'
Assert-Equal 'owner-one' $ownerId 'the fixture seat was created without the incarnation this suite needs to tell seats apart'
Assert-Equal "owner:$ownerId" (Get-RowOwner $restoreWorkspace 'alpha') 'the real Set-NotebookTopicOwner did not stamp the row with the registry''s incarnation'
Assert-Equal 'bystand:bystand-one' (Get-RowOwner $restoreWorkspace 'bystand-topic') 'the bystander topic was stamped with something other than its own seat''s incarnation'

$reset = Invoke-Reset $restoreWorkspace 'owner'
$quarantine = Get-QuarantineName $reset
Assert-Equal 'alpha,beta,gamma' ((@($reset.quarantined) | Sort-Object -CaseSensitive) -join ',') 'the fixture reset did not quarantine the three topics the sections below are about'
Assert-Equal 'bystand-topic' (Get-NotebookTopicNames $restoreWorkspace) 'the reset took a topic it does not own, so the decoy is gone before it was used'
Assert-Equal "owner:$ownerId" (Get-RowOwner $restoreWorkspace 'alpha') 'THE RESET REMOVED THE OWNERSHIP ROW WHEN IT QUARANTINED THE TOPIC; the restore has nothing to read'

# --- 1. THE ROSTER ANSWERS A SESSION WITH NO SEAT ------------------------------------------------
#
# Listing what survived is a READ, and a reader whose session has lost its seat is exactly the
# reader asking. If this needed a seat, the refusal would send them to look up a directory name they
# cannot then obtain.
$env:LIBRARY_SEAT = ''
$listRun = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $restoreWorkspace, '-List', '-Json')
$env:LIBRARY_SEAT = 'owner'
Assert-True ($listRun.ExitCode -eq 0) "the quarantine roster was refused to a seatless session: $($listRun.Text)"
$listed = Get-Json $listRun 'the quarantine roster'
$listedRows = @(Get-Field $listed 'quarantines' 'the roster')
Assert-Equal '1' ([string]@($listedRows).Count) 'the roster did not report exactly the one quarantine this fixture has'
Assert-Equal 'owner' ([string](Get-Field $listedRows[0] 'quarantined_by' 'the roster row')) 'the roster did not name the seat that made the quarantine'
Assert-Equal 'alpha,beta,gamma' ((@(Get-Field $listedRows[0] 'topics' 'the roster row') | Sort-Object -CaseSensitive) -join ',') 'the roster did not report the three topics the quarantine holds'
Assert-Equal 'stray.md' ((@(Get-Field $listedRows[0] 'loose_files' 'the roster row')) -join ',') 'the roster did not report the loose file, or counted a journal as one'

# --- 2. THE PLAN: THREE TOPICS, THEIR DISPOSITIONS, AND THE LOOSE FILE ---------------------------
$planRun = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $restoreWorkspace, '-Seat', 'owner', '-Quarantine', $quarantine, '-Preflight', '-Json')
Assert-True ($planRun.ExitCode -eq 0) "the restore preflight failed on a quarantine it had just made: $($planRun.Text)"
$plan = Get-Json $planRun 'the restore plan'
Assert-Equal '0' ([string]@(Get-Field $plan 'refusals' 'the restore plan').Count) "the restore refused its own seat's material: $(@($plan.refusals) -join ' ')"
Assert-True (-not [string]::IsNullOrWhiteSpace([string](Get-Field $plan 'plan_id' 'the restore plan'))) 'a restore with nothing to refuse issued no plan_id'
$dispositions = @(Get-Field $plan 'topics_to_restore' 'the restore plan')
Assert-Equal '3' ([string]@($dispositions).Count) 'the plan did not list all three topics; a truncation is invisible at two'
foreach ($topic in @('alpha', 'beta', 'gamma')) {
    Assert-True (@($dispositions | Where-Object { $_ -clike "$topic (ownership: keep*" }).Count -eq 1) "the plan did not say $topic's row would be KEPT: $(@($dispositions) -join ' | ')"
}
Assert-Equal 'stray.md' ((@(Get-Field $plan 'loose_files_to_restore' 'the restore plan')) -join ',') 'the plan did not carry the loose file'
Assert-Equal 'owner' ([string](Get-Field $plan 'quarantined_by_seat' 'the restore plan')) 'the plan did not report which seat made the quarantine'

# --- 3. A WRONG plan_id REFUSES, AND NOTHING MOVES ------------------------------------------------
#
# ASSERTED AT THE MATERIAL, not at the exit code. A helper that threw after moving two of the three
# would fail an exit-code assertion and a restore-count assertion in exactly the same way as one
# that moved nothing.
$staleRun = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $restoreWorkspace, '-Seat', 'owner',
    '-Quarantine', $quarantine, '-UserConfirmed', '-ApprovedPlanId', 'restore-notebook-quarantine-not-the-one', '-Json')
Assert-True ($staleRun.ExitCode -ne 0) 'a restore ran on a plan_id nothing issued'
Assert-Equal 'bystand-topic' (Get-NotebookTopicNames $restoreWorkspace) 'A REFUSED RESTORE MOVED MATERIAL ANYWAY'
Assert-True ($staleRun.Text.Contains('nothing was moved')) "the refusal did not say that nothing moved: $($staleRun.Text)"

# --- 4. THE RESTORE ITSELF ------------------------------------------------------------------------
$run = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $restoreWorkspace, '-Seat', 'owner',
    '-Quarantine', $quarantine, '-UserConfirmed', '-ApprovedPlanId', ([string]$plan.plan_id), '-Json')
Assert-True ($run.ExitCode -eq 0) "the restore failed on the plan it had just issued: $($run.Text)"
$done = Get-Json $run 'the restore result'
Assert-Equal 'alpha,beta,gamma' ((@(Get-Field $done 'restored' 'the restore result') | Sort-Object -CaseSensitive) -join ',') 'the restore did not report all three topics back'
Assert-Equal 'alpha,beta,bystand-topic,gamma' (Get-NotebookTopicNames $restoreWorkspace) 'the Notebook does not hold what the restore says it restored'
Assert-True (Test-Path -LiteralPath (Join-Path $restoreWorkspace 'notebook/stray.md') -PathType Leaf) 'the loose file was not restored'
# READ FROM THE RENDER, and compared with what is on disk rather than with a typed number: an index
# that did not gain the topics is a restore the reader cannot see.
Assert-Equal '4' ([string](Get-Field $done 'master_index_topic_count' 'the restore result')) 'the rendered master index does not list the restored topics'
# THE DECOY, UNTOUCHED, and asserted as a VALUE: a restore that re-homed everything it saw would
# leave this row naming owner.
Assert-Equal 'bystand:bystand-one' (Get-RowOwner $restoreWorkspace 'bystand-topic') 'THE RESTORE REWROTE A BYSTANDER SEAT''S OWNERSHIP ROW'
foreach ($topic in @('alpha', 'beta', 'gamma')) {
    Assert-Equal "owner:$ownerId" (Get-RowOwner $restoreWorkspace $topic) "the restored topic $topic no longer names the incarnation the registry gives its seat"
}
Assert-Equal '0' ([string]@(Get-Field $done 'quarantine_topics_remaining' 'the restore result').Count) 'the emptied quarantine still reports topics'

# --- 5. THE COLLISION, REFUSED IN THE PLAN AND AGAIN AT THE MOVE ---------------------------------
#
# TWO PLACES BECAUSE THE ANSWER CAN CHANGE BETWEEN THEM: the preflight is a snapshot, and a compile
# at another seat can create the name before the approval is used. The assertion that matters is at
# the move, under the topic lock; the plan's is what stops a reader being handed an approval for it.
$reset = Invoke-Reset $restoreWorkspace 'owner'
$quarantine = Get-QuarantineName $reset
New-Item -ItemType Directory -Path (Join-Path $restoreWorkspace 'notebook/alpha') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $restoreWorkspace 'notebook/alpha/_index.md'), "# alpha rebuilt`n", $utf8)
$collisionRun = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $restoreWorkspace, '-Seat', 'owner', '-Quarantine', $quarantine, '-Preflight', '-Json')
$collisionPlan = Get-Json $collisionRun 'the colliding restore plan'
Assert-True ((@(Get-Field $collisionPlan 'refusals' 'the colliding plan') -join ' ').Contains('alpha')) "the plan did not refuse the topic that exists again: $(@($collisionPlan.refusals) -join ' ')"
Assert-Equal '' ([string](Get-Field $collisionPlan 'plan_id' 'the colliding plan')) 'A PLAN_ID WAS ISSUED FOR A RESTORE ALREADY CERTAIN TO BE REFUSED'
Assert-Equal 'False' ([string](Get-Field $collisionPlan 'confirmation_required' 'the colliding plan')) 'a plan with refusals still asked for a confirmation'

$quarantineDirectory = Join-Path $restoreWorkspace "internal/notebook-reset-quarantine/$quarantine"
$alphaLock = Enter-BookLock -Workspace $restoreWorkspace -BookRoot (Get-NotebookTopicLockRoot 'alpha')
try {
    $blockedMove = Restore-NotebookTopicFromQuarantine -Workspace $restoreWorkspace -Topic 'alpha' -QuarantineDirectory $quarantineDirectory
    Assert-Equal 'False' ([string]$blockedMove.restored) 'A RESTORE WROTE OVER A TOPIC THAT HAD BEEN REBUILT SINCE THE RESET'
    Assert-True ([string]$blockedMove.reason -clike '*exists in notebook/ again*') "the refused move gave the wrong reason: $([string]$blockedMove.reason)"
    Assert-True (Test-Path -LiteralPath (Join-Path $quarantineDirectory 'alpha') -PathType Container) 'the refused move consumed the quarantined copy anyway'
    Assert-Equal '# alpha rebuilt' ([IO.File]::ReadAllText((Join-Path $restoreWorkspace 'notebook/alpha/_index.md')).Trim()) 'the rebuilt topic was overwritten by the quarantined one'
}
finally { Exit-BookLock -Lock $alphaLock }
# THE POSITIVE CONTROL, or every assertion above passes against a mover that refuses everything.
$betaLock = Enter-BookLock -Workspace $restoreWorkspace -BookRoot (Get-NotebookTopicLockRoot 'beta')
try {
    $goodMove = Restore-NotebookTopicFromQuarantine -Workspace $restoreWorkspace -Topic 'beta' -QuarantineDirectory $quarantineDirectory
    Assert-Equal 'True' ([string]$goodMove.restored) 'the move refused a topic whose name is free'
}
finally { Exit-BookLock -Lock $betaLock }

# --- 6. ADOPTION ACROSS INCARNATIONS -------------------------------------------------------------
#
# A whole-tree reset reaches a RETIRED incarnation's topics, so a restore meets a row that names a
# seat this one is not. Refused by default, because bringing that material back here is taking it
# over; allowed with -Adopt, and the row must then name THIS incarnation -- compared against the
# registry entry, which is a different subject from the row being asserted.
Add-FixtureSeat $restoreWorkspace 'ghost' 'ghost-proj' 'ghost-one'
Add-Topic $restoreWorkspace 'ghost-topic' 'ghost'
$ghostId = Get-SeatId $restoreWorkspace 'ghost'
$ghostPlanRun = Invoke-Helper 'Retire-Seat.ps1' @('-Seat', 'ghost', '-WorkspacePath', $restoreWorkspace, '-Preflight', '-Json')
Assert-True ($ghostPlanRun.ExitCode -eq 0) "the fixture could not retire the seat section 6 is about: $($ghostPlanRun.Text)"
$ghostPlan = Get-Json $ghostPlanRun 'the retirement plan'
$ghostRetired = Invoke-Helper 'Retire-Seat.ps1' @('-Seat', 'ghost', '-WorkspacePath', $restoreWorkspace,
    '-UserConfirmed', '-ApprovedPlanId', ([string]$ghostPlan.plan_id), '-Json')
Assert-True ($ghostRetired.ExitCode -eq 0) "retiring the fixture's seat failed: $($ghostRetired.Text)"

# THE BYSTANDER'S TOPIC IS MOVED OUT OF THE WAY BY THE BYSTANDER'S OWN RESET, because a whole-tree
# reset REFUSES a live seat's material -- which is the rule sections 4 and 7 rest on, so working
# around it here would be testing a Library this one is not.
Use-Seat $restoreWorkspace 'bystand'
Invoke-Reset $restoreWorkspace 'bystand' | Out-Null
Use-Seat $restoreWorkspace 'owner'

# A PROTECTED TOPIC, PLANTED BEFORE THE RUN so the report below has something that must SURVIVE it.
# Without it, every assertion about what remains is satisfied by a helper that returns empty lists.
New-Item -ItemType Directory -Path (Join-Path $restoreWorkspace 'notebook/common-ground') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $restoreWorkspace 'notebook/common-ground/_index.md'), "# Common ground`n", $utf8)
Set-NotebookTopicOwner -Workspace $restoreWorkspace -Topic 'common-ground' -Scope 'shared' -ActingSeat 'owner' | Out-Null

$reset = Invoke-Reset $restoreWorkspace 'owner' -WholeTree
$quarantine = Get-QuarantineName $reset
Assert-True (@($reset.quarantined) -ccontains 'ghost-topic') "the whole-tree reset did not reach the retired seat's topic: $(@($reset.quarantined) -join ',')"

# --- 6b. THE COMPLETED RUN REPORTS WHAT IS LEFT, NOT WHAT IT PREDICTED (2026-09-15) --------------
#
# THE TWO ANSWERS GENUINELY DIFFER HERE, which is the whole requirement: the five `topics_*` fields
# were computed from the selection taken BEFORE the lock and never read again, so on a completed
# whole-tree run `topics_owned_by_retired_seats` still named a topic this same run had just
# quarantined. Not merely stale -- FALSE, and false about the one question a reader asks after a
# reset. `remaining_in_notebook` is re-derived inside the registry lock after the moves.
#
# NO RACE IS NEEDED TO REACH IT. A retired seat's topic is a whole-tree TARGET, so it moves, and the
# prediction that named it is left describing a directory that is gone. Both halves are asserted --
# the old field still says what the reader approved, the new one says what happened -- because a
# change that simply overwrote the first would destroy the record of the approved set.
$predicted = @($reset.topics_owned_by_retired_seats) -join ' | '
$remaining = Get-Field $reset 'remaining_in_notebook' 'the completed whole-tree reset'
Assert-True ($predicted.Contains('ghost-topic')) "the preflight fields no longer record the approved set: $predicted"
Assert-True (-not (@(Get-Field $remaining 'owned_by_retired_seats' 'the remaining block') -join ' | ').Contains('ghost-topic')) `
    "THE COMPLETED RESET STILL REPORTS A RETIRED SEAT'S TOPIC AS PRESENT AFTER QUARANTINING IT: $(@($remaining.owned_by_retired_seats) -join ' | ')"
Assert-True (-not (Test-Topic $restoreWorkspace 'ghost-topic')) 'the fixture did not actually move the topic these two fields disagree about'
# THE DECOY, and it is what stops every assertion above passing against empty lists. `common-ground`
# is declared shared, no seat's reset takes it, and it is still on disk -- so the re-read must still
# name it, with its scope.
$remainingProtected = @(Get-Field $remaining 'protected' 'the remaining block') -join ' | '
Assert-True ($remainingProtected.Contains('common-ground')) "the re-read lost a topic that is still in the Notebook: $remainingProtected"
Assert-True ($remainingProtected.Contains('shared')) "the re-read did not say WHY the surviving topic was left: $remainingProtected"
Assert-True (Test-Topic $restoreWorkspace 'common-ground') 'the whole-tree reset moved a topic declared shared'
# AND THE SEAT'S OWN SET IS EMPTY, which is the field that says the moves actually happened: a topic
# this seat owns that is STILL in notebook/ after its own reset is a move that did not run.
Assert-Equal '0' ([string]@(Get-Field $remaining 'owned_by_this_seat' 'the remaining block').Count) `
    "the reset left topics this seat owns in the Notebook: $(@($remaining.owned_by_this_seat) -join ',')"

# --- 6c. THE OTHER DIRECTION: A TOPIC THAT WAS PREDICTED TO GO AND STAYED ------------------------
#
# 6b covers a target that MOVED and so left the report. This is the reverse, and it is the case the
# re-read exists for: Move-NotebookTopicToQuarantine refuses a topic whose ownership changed since
# the preflight and LEAVES IT IN notebook/, so the pre-lock field says it went and the truth is that
# it stayed -- now under another seat's name, which is the fact a reader most needs and the one the
# old fields could never carry.
#
# AT THE FUNCTION LEVEL, DELIBERATELY, and not because it is easier. Driving it through the helper is
# impossible by construction: the plan digest binds each target as `topic:seat:seat_id`, so any
# ownership change that would make the move refuse ALSO changes the digest, and the run aborts at the
# plan_id with nothing moved. Reaching the branch end to end needs an ownership write landing inside
# the registry lock this process holds -- the same unreachability the reset's own loose-file
# enumeration documents rather than pretends to cover. So the real move and the real selection are
# called in the real lock order, and the sequence is built by hand.
Add-Topic $restoreWorkspace 'shifty' 'owner'
$beforeLock = Enter-SeatRegistryLock -Workspace $restoreWorkspace
try { $shiftyBefore = Get-NotebookResetTargets -Workspace $restoreWorkspace -Seat 'owner' }
finally { Exit-BookLock -Lock $beforeLock }
Assert-True ((@($shiftyBefore.targets | ForEach-Object { $_.topic }) -ccontains 'shifty')) 'the fixture did not put the topic into the target set, so nothing below is about a changed prediction'
Assert-True (-not (@($shiftyBefore.foreign | ForEach-Object { $_.topic }) -ccontains 'shifty')) 'the topic was already foreign before the handover, so the comparison below would prove nothing'

# THE HANDOVER, through the real writer: the acting seat IS the current owner, which is the one
# reassignment that is allowed, and `bystand` is live and registered -- so the topic lands in
# `foreign` rather than in `unaccounted`.
Set-NotebookTopicOwner -Workspace $restoreWorkspace -Topic 'shifty' -Seat 'bystand' -ActingSeat 'owner' | Out-Null

$shiftyQuarantine = Join-Path $restoreWorkspace 'internal/shifty-quarantine'
New-Item -ItemType Directory -Path $shiftyQuarantine -Force | Out-Null
$shiftyRegistryLock = Enter-SeatRegistryLock -Workspace $restoreWorkspace
try {
    $shiftyTopicLock = Enter-BookLock -Workspace $restoreWorkspace -BookRoot (Get-NotebookTopicLockRoot 'shifty')
    try {
        $refusedMove = Move-NotebookTopicToQuarantine -Workspace $restoreWorkspace -Topic 'shifty' `
            -ExpectedSeat 'owner' -ExpectedSeatId $ownerId -QuarantineDirectory $shiftyQuarantine
        Assert-Equal 'False' ([string]$refusedMove.moved) 'the move took a topic whose ownership had changed since the preflight'
        Assert-True ([string]$refusedMove.reason -clike '*ownership changed*') "the refused move did not say why: $([string]$refusedMove.reason)"
    }
    finally { Exit-BookLock -Lock $shiftyTopicLock }
    # RE-DERIVED WHERE THE RESET RE-DERIVES IT: after the moves, still inside the registry lock.
    $shiftyAfter = Get-NotebookResetTargets -Workspace $restoreWorkspace -Seat 'owner'
}
finally { Exit-BookLock -Lock $shiftyRegistryLock }

Assert-True (Test-Topic $restoreWorkspace 'shifty') 'the refused move removed the topic anyway, so there is nothing left for the report to be about'
$shiftyForeign = @($shiftyAfter.foreign | ForEach-Object { "$($_.topic) (seat $($_.seat))" }) -join ' | '
Assert-True ($shiftyForeign.Contains('shifty')) "THE POST-MOVE READ STILL DOES NOT SEE A TOPIC THAT WAS LEFT IN PLACE: $shiftyForeign"
Assert-True ($shiftyForeign.Contains('bystand')) "the post-move read did not name the seat the topic now belongs to: $shiftyForeign"
Assert-True (-not (@($shiftyAfter.targets | ForEach-Object { $_.topic }) -ccontains 'shifty')) 'the post-move read still calls a topic that changed hands this seat''s own'
# Out of the way of every later case in this workspace, which asserts exact target sets.
Remove-Item -LiteralPath (Join-Path $restoreWorkspace 'notebook/shifty') -Recurse -Force -ErrorAction SilentlyContinue

$strictRun = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $restoreWorkspace, '-Seat', 'owner',
    '-Quarantine', $quarantine, '-Topic', 'ghost-topic', '-Preflight', '-Json')
$strictPlan = Get-Json $strictRun 'the un-adopted restore plan'
$strictRefusals = (@(Get-Field $strictPlan 'refusals' 'the un-adopted plan') -join ' ')
Assert-True ($strictRefusals.Contains('ghost-topic')) "a retired incarnation's topic was restored without being adopted: $strictRefusals"
Assert-True ($strictRefusals.Contains('-Adopt')) "the refusal did not name the route out of it: $strictRefusals"
Assert-True ($strictRefusals.Contains("incarnation $ghostId")) "the refusal did not say WHICH incarnation owns it: $strictRefusals"

$adoptRun = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $restoreWorkspace, '-Seat', 'owner',
    '-Quarantine', $quarantine, '-Topic', 'ghost-topic', '-Adopt', '-Preflight', '-Json')
$adoptPlan = Get-Json $adoptRun 'the adopting restore plan'
Assert-Equal '0' ([string]@(Get-Field $adoptPlan 'refusals' 'the adopting plan').Count) "-Adopt did not clear the refusal it exists for: $(@($adoptPlan.refusals) -join ' ')"
Assert-True ((@(Get-Field $adoptPlan 'topics_to_restore' 'the adopting plan') -join ' ').Contains('ownership: adopt')) 'the adopting plan did not say the row would be taken over'
Assert-Equal '0' ([string]@(Get-Field $adoptPlan 'loose_files_to_restore' 'the adopting plan').Count) 'a NARROWED restore carried the loose files, which belong to no topic'
$adopted = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $restoreWorkspace, '-Seat', 'owner',
    '-Quarantine', $quarantine, '-Topic', 'ghost-topic', '-Adopt', '-UserConfirmed', '-ApprovedPlanId', ([string]$adoptPlan.plan_id), '-Json')
Assert-True ($adopted.ExitCode -eq 0) "the adopting restore failed: $($adopted.Text)"
Assert-True (Test-Topic $restoreWorkspace 'ghost-topic') 'the adopted topic is not in the Notebook'
Assert-Equal "owner:$ownerId" (Get-RowOwner $restoreWorkspace 'ghost-topic') 'the adopted topic''s row does not name the adopting seat''s incarnation'
Assert-True ((Get-RowOwner $restoreWorkspace 'ghost-topic') -cne "ghost:$ghostId") 'the adopted row still names the retired incarnation'

# --- 7. A LIVE SEAT'S ROW IS REFUSED, AND -Adopt DOES NOT LIFT IT --------------------------------
#
# The one refusal in this family that is not about ceremony: that seat's reset is still covering the
# topic, and handing it here would stop it covering material that seat is writing. -Adopt is asked
# for in the same run, so a helper that treated the switch as a blanket override fails here.
#
# TWO OF THIS SEAT'S TOPICS IN ONE QUARANTINE: one to hand to the live seat, and one that stays this
# seat's own -- without the second, a classifier that refused everything would pass every assertion.
foreach ($topic in @('alpha', 'gamma')) { Add-Topic $restoreWorkspace $topic 'owner' }
$reset = Invoke-Reset $restoreWorkspace 'owner'
$quarantine = Get-QuarantineName $reset
Set-NotebookTopicOwner -Workspace $restoreWorkspace -Topic 'alpha' -Seat 'bystand' -ActingSeat 'owner'
$foreignRun = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $restoreWorkspace, '-Seat', 'owner',
    '-Quarantine', $quarantine, '-Adopt', '-Preflight', '-Json')
$foreignPlan = Get-Json $foreignRun 'the live-owner restore plan'
$foreignRefusals = (@(Get-Field $foreignPlan 'refusals' 'the live-owner plan') -join ' ')
Assert-True ($foreignRefusals.Contains('alpha')) "-Adopt LIFTED THE REFUSAL THAT PROTECTS A LIVE SEAT'S MATERIAL: $foreignRefusals"
Assert-True ($foreignRefusals.Contains("seat 'bystand'")) "the refusal did not name the seat that owns it: $foreignRefusals"
Assert-True ($foreignRefusals.Contains('still registered')) "the refusal did not say why that seat's claim on it stands: $foreignRefusals"
# AND IT IS NOT REFUSING EVERYTHING, which is the other way to pass every assertion above. The
# topics in the same quarantine whose rows are this seat's own are still listed as restorable.
$stillOffered = @(Get-Field $foreignPlan 'topics_to_restore' 'the live-owner plan')
Assert-True (@($stillOffered | Where-Object { $_ -clike 'gamma*' }).Count -eq 1) "the plan refused a topic this seat owns outright: $(@($stillOffered) -join ' | ')"

# --- 7b. THE ROW THAT IS NOT THERE, AND WHAT THE QUARANTINE'S JOURNAL SAYS ABOUT IT --------------
#
# A row can be gone -- hand-edited, or removed by a purge that did not finish -- and the restore then
# has only the reset journal to say whose the material was. That is the field the reset started
# recording on 2026-09-10: `moves` says what happened to each directory and `seat` says who RAN the
# reset, which under -WholeTree is not the owner of most of what moved.
function Remove-RowByHand([string]$Workspace, [string]$Topic) {
    $lock = Enter-BookLock -Workspace $Workspace -BookRoot (Get-NotebookTopicLockRoot $Topic)
    try {
        $owners = Read-NotebookTopicOwners -Workspace $Workspace
        $kept = @(@($owners.topics) | Where-Object { [string]$_.topic -cne $Topic })
        $ownersLock = Enter-NotebookOwnersLock -Workspace $Workspace
        try { Write-NotebookTopicOwners -Workspace $Workspace -Owners ([pscustomobject]@{ schema = 1; topics = @($kept) }) }
        finally { Exit-BookLock -Lock $ownersLock }
    }
    finally { Exit-BookLock -Lock $lock }
}
Add-Topic $restoreWorkspace 'delta' 'owner'
$reset = Invoke-Reset $restoreWorkspace 'owner'
$quarantine = Get-QuarantineName $reset
Remove-RowByHand $restoreWorkspace 'delta'
Assert-Equal '<no row>' (Get-RowOwner $restoreWorkspace 'delta') 'the fixture did not remove the row this case is about'
$recordPlanRun = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $restoreWorkspace, '-Seat', 'owner',
    '-Quarantine', $quarantine, '-Topic', 'delta', '-Preflight', '-Json')
$recordPlan = Get-Json $recordPlanRun 'the record-the-row restore plan'
Assert-Equal '0' ([string]@(Get-Field $recordPlan 'refusals' 'the record-the-row plan').Count) "the restore refused material the quarantine records as this incarnation's: $(@($recordPlan.refusals) -join ' ')"
Assert-True ((@(Get-Field $recordPlan 'topics_to_restore' 'the record-the-row plan') -join ' ').Contains('ownership: record')) 'the plan did not say the missing row would be written back'
$recorded = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $restoreWorkspace, '-Seat', 'owner',
    '-Quarantine', $quarantine, '-Topic', 'delta', '-UserConfirmed', '-ApprovedPlanId', ([string]$recordPlan.plan_id), '-Json')
Assert-True ($recorded.ExitCode -eq 0) "the record-the-row restore failed: $($recorded.Text)"
Assert-Equal "owner:$ownerId" (Get-RowOwner $restoreWorkspace 'delta') 'A RESTORE PUT A TOPIC BACK AND LEFT IT OWNED BY NOBODY, which no reset can then reach'

# AND WHEN THE JOURNAL SAYS IT WAS SOMEBODY ELSE'S, the same missing row is a refusal. This is what
# makes the recorded owner load-bearing rather than decorative: both branches end with no row, and
# only the journal tells them apart.
Add-Topic $restoreWorkspace 'epsilon' 'owner'
$reset = Invoke-Reset $restoreWorkspace 'owner'
$quarantine = Get-QuarantineName $reset
Remove-RowByHand $restoreWorkspace 'epsilon'
$journalPath = Join-Path $restoreWorkspace "internal/notebook-reset-quarantine/$quarantine/reset-journal.json"
$journal = [Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($journalPath)) | ConvertFrom-Json
$rewritten = @(@($journal.targets) | ForEach-Object {
    if ([string]$_.topic -ceq 'epsilon') { [pscustomobject]@{ topic = 'epsilon'; seat = 'ghost'; seat_id = $ghostId } } else { $_ } })
[IO.File]::WriteAllText($journalPath, ((([pscustomobject]@{
    operation = [string]$journal.operation; seat = [string]$journal.seat; whole_tree = [bool]$journal.whole_tree
    clear_desk = [bool]$journal.clear_desk; plan_id = [string]$journal.plan_id
    quarantined_utc = [string]$journal.quarantined_utc; moves = @($journal.moves); targets = @($rewritten)
    loose_files = @($journal.loose_files) }) | ConvertTo-Json -Depth 6) + "`n"), $utf8)
$journalledRun = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $restoreWorkspace, '-Seat', 'owner',
    '-Quarantine', $quarantine, '-Topic', 'epsilon', '-Preflight', '-Json')
$journalledRefusals = (@(Get-Field (Get-Json $journalledRun 'the journalled restore plan') 'refusals' 'the journalled plan') -join ' ')
Assert-True ($journalledRefusals.Contains("seat 'ghost'")) "THE RESTORE IGNORED WHAT THE QUARANTINE RECORDS ABOUT WHO OWNED THE MATERIAL: $journalledRefusals"
Assert-True ($journalledRefusals.Contains('-Adopt')) "the refusal named no route out of it: $journalledRefusals"

# --- 7c. A LOOSE FILE NAMED LIKE A JOURNAL IS LEFT, NOT CARRIED IN AND OVERWRITTEN ---------------
#
# The commit moves loose files into the quarantine and THEN writes reset-journal.json beside them, so
# a notebook/reset-journal.json was carried in and immediately destroyed -- the one path in the reset
# that deleted a reader's file rather than quarantining it. Found while building the restore that
# reads those journals.
[IO.File]::WriteAllText((Join-Path $restoreWorkspace 'notebook/reset-journal.json'), "{`"mine`":true}`n", $utf8)
Add-Topic $restoreWorkspace 'zeta' 'owner'
$reset = Invoke-Reset $restoreWorkspace 'owner'
Assert-True (Test-Path -LiteralPath (Join-Path $restoreWorkspace 'notebook/reset-journal.json') -PathType Leaf) 'A RESET CARRIED A FILE NAMED LIKE ITS OWN JOURNAL INTO THE QUARANTINE, WHERE THE JOURNAL OVERWROTE IT'
Assert-Equal '{"mine":true}' ([IO.File]::ReadAllText((Join-Path $restoreWorkspace 'notebook/reset-journal.json')).Trim()) 'the reader''s file was replaced by a reset journal'
Assert-Equal 'reset-journal.json' ((@(Get-Field $reset 'loose_files_left_reserved_name' 'the reset result')) -join ',') 'the reset left the file without saying so, which is the silent half of the same defect'
Assert-Equal '0' ([string]@(Get-Field $reset 'loose_files_quarantined' 'the reset result').Count) 'the reset moved the reserved-name file anyway'

# =================================================================================================
# 8. THE QUARANTINE PURGE -- ITS OWN WORKSPACE, BECAUSE IT REALLY DESTROYS
# =================================================================================================
$purgeWorkspace = New-RecoveryWorkspace 'purge'
Add-FixtureSeat $purgeWorkspace 'owner' 'owner-proj' 'owner-one'
Add-FixtureSeat $purgeWorkspace 'bystand' 'bystand-proj' 'bystand-one'
Use-Seat $purgeWorkspace 'owner'
foreach ($topic in @('alpha', 'beta', 'gamma')) { Add-Topic $purgeWorkspace $topic 'owner' }
Add-Topic $purgeWorkspace 'bystand-topic' 'bystand'
$purgeOwnerId = Get-SeatId $purgeWorkspace 'owner'

$reset = Invoke-Reset $purgeWorkspace 'owner'
$quarantine = Get-QuarantineName $reset
$quarantineDirectory = Join-Path $purgeWorkspace "internal/notebook-reset-quarantine/$quarantine"
# A TOPIC THAT COMES BACK BY ANOTHER ROUTE, which is the sequence the row guard exists for: the
# purge must destroy the quarantined `alpha` and LEAVE the row, because that row now describes the
# live copy. Both are spelled the same; only the directory tells them apart.
Add-Topic $purgeWorkspace 'alpha' 'owner'

$purgePlanRun = Invoke-Helper 'Remove-NotebookQuarantine.ps1' @('-WorkspacePath', $purgeWorkspace, '-Seat', 'owner', '-Quarantine', $quarantine, '-Preflight', '-Json')
Assert-True ($purgePlanRun.ExitCode -eq 0) "the purge preflight failed: $($purgePlanRun.Text)"
$purgePlan = Get-Json $purgePlanRun 'the purge plan'
Assert-Equal 'False' ([string](Get-Field $purgePlan 'recoverable' 'the purge plan')) 'the purge plan told the reader its material could be got back'
$toRemove = @(Get-Field $purgePlan 'ownership_rows_to_remove' 'the purge plan')
Assert-Equal '2' ([string]@($toRemove).Count) "the plan did not remove exactly beta's and gamma's rows: $(@($toRemove) -join ' | ')"
Assert-True ((@(Get-Field $purgePlan 'ownership_rows_kept' 'the purge plan') -join ' ').Contains('alpha')) 'the plan did not keep the row of the topic that exists live'

$purged = Invoke-Helper 'Remove-NotebookQuarantine.ps1' @('-WorkspacePath', $purgeWorkspace, '-Seat', 'owner',
    '-Quarantine', $quarantine, '-UserConfirmed', '-ApprovedPlanId', ([string]$purgePlan.plan_id), '-Json')
Assert-True ($purged.ExitCode -eq 0) "the purge failed on the plan it had just issued: $($purged.Text)"
$purgeResult = Get-Json $purged 'the purge result'
Assert-Equal 'False' ([string](Get-Field $purgeResult 'quarantine_directory_exists' 'the purge result')) 'the purge reported success over a directory that is still there'
Assert-True (-not (Test-Path -LiteralPath $quarantineDirectory)) 'the quarantine directory survived its own purge'
# THE ROWS, WHICH ARE THE HALF A FILE DELETE WOULD LEAVE BEHIND. A row citing material that exists
# nowhere blocks that seat's slug forever and no reset can ever reach it.
Assert-Equal '<no row>' (Get-RowOwner $purgeWorkspace 'beta') 'THE PURGE DESTROYED THE MATERIAL AND LEFT THE OWNERSHIP ROW CITING IT'
Assert-Equal '<no row>' (Get-RowOwner $purgeWorkspace 'gamma') 'the purge removed one row and not the other; two rows hide what three reveal'
Assert-Equal "owner:$purgeOwnerId" (Get-RowOwner $purgeWorkspace 'alpha') 'THE PURGE REMOVED THE ROW OF A TOPIC THAT EXISTS IN THE NOTEBOOK'
Assert-True (Test-Topic $purgeWorkspace 'alpha') 'the purge deleted a live Notebook topic'
Assert-Equal 'bystand:bystand-one' (Get-RowOwner $purgeWorkspace 'bystand-topic') 'the purge dropped a bystander seat''s row'

# AND THE SAME QUESTION ASKED AT THE WRITE, which is the one that has to hold. The plan's answer is a
# snapshot taken before the topic locks are acquired, so a compile at another seat can create the
# name in between -- and only the guard inside Remove-NotebookTopicOwner, under that topic's lock,
# is in a position to refuse then. Driven directly for that reason: end to end, the plan's
# classification would shadow it and deleting it would leave this suite green.
$liveRowLock = Enter-BookLock -Workspace $purgeWorkspace -BookRoot (Get-NotebookTopicLockRoot 'alpha')
try {
    $refusedRemoval = Remove-NotebookTopicOwner -Workspace $purgeWorkspace -Topic 'alpha' -ExpectedSeat 'owner' -ExpectedSeatId $purgeOwnerId
    Assert-Equal 'False' ([string]$refusedRemoval.removed) 'AN OWNERSHIP ROW WAS REMOVED FOR A TOPIC THAT EXISTS IN THE NOTEBOOK'
    Assert-True ([string]$refusedRemoval.reason -clike '*exists in notebook/*') "the refused removal gave the wrong reason: $([string]$refusedRemoval.reason)"
    Assert-Equal "owner:$purgeOwnerId" (Get-RowOwner $purgeWorkspace 'alpha') 'the refused removal dropped the row anyway'
}
finally { Exit-BookLock -Lock $liveRowLock }
# THE POSITIVE CONTROL, or every assertion above passes against a function that refuses everything.
Add-Topic $purgeWorkspace 'eta' 'owner'
Remove-Item -LiteralPath (Join-Path $purgeWorkspace 'notebook/eta') -Recurse -Force
$goneRowLock = Enter-BookLock -Workspace $purgeWorkspace -BookRoot (Get-NotebookTopicLockRoot 'eta')
try {
    $allowedRemoval = Remove-NotebookTopicOwner -Workspace $purgeWorkspace -Topic 'eta' -ExpectedSeat 'owner' -ExpectedSeatId $purgeOwnerId
    Assert-Equal 'True' ([string]$allowedRemoval.removed) 'the removal refused a row whose topic exists nowhere'
}
finally { Exit-BookLock -Lock $goneRowLock }

# --- 8b. A FOREIGN LIVE SEAT'S MATERIAL IS REFUSED ------------------------------------------------
Add-Topic $purgeWorkspace 'delta' 'owner'
$reset = Invoke-Reset $purgeWorkspace 'owner'
$quarantine = Get-QuarantineName $reset
$quarantineDirectory = Join-Path $purgeWorkspace "internal/notebook-reset-quarantine/$quarantine"
Set-NotebookTopicOwner -Workspace $purgeWorkspace -Topic 'delta' -Seat 'bystand' -ActingSeat 'owner'
$refusedRun = Invoke-Helper 'Remove-NotebookQuarantine.ps1' @('-WorkspacePath', $purgeWorkspace, '-Seat', 'owner', '-Quarantine', $quarantine, '-Preflight', '-Json')
$refusedPlan = Get-Json $refusedRun 'the foreign purge plan'
Assert-True ((@(Get-Field $refusedPlan 'refusals' 'the foreign purge plan') -join ' ').Contains("seat 'bystand'")) "a purge offered to destroy a live seat's material: $(@($refusedPlan.refusals) -join ' ')"
Assert-Equal '' ([string](Get-Field $refusedPlan 'plan_id' 'the foreign purge plan')) 'a plan_id was issued for a purge already certain to be refused'
$refusedApply = Invoke-Helper 'Remove-NotebookQuarantine.ps1' @('-WorkspacePath', $purgeWorkspace, '-Seat', 'owner',
    '-Quarantine', $quarantine, '-UserConfirmed', '-ApprovedPlanId', 'remove-notebook-quarantine-nothing', '-Json')
Assert-True ($refusedApply.ExitCode -ne 0) 'a purge ran on a plan_id nothing issued'
Assert-True (Test-Path -LiteralPath $quarantineDirectory -PathType Container) 'A REFUSED PURGE DESTROYED THE MATERIAL ANYWAY'

# =================================================================================================
# 9. THE SEAT-ARCHIVE PURGE -- THE STRANDING REFUSAL
# =================================================================================================
$archiveWorkspace = New-RecoveryWorkspace 'archive'
Add-FixtureSeat $archiveWorkspace 'keeper' 'keeper-proj' 'keeper-one'
Add-FixtureSeat $archiveWorkspace 'gone' 'gone-proj' 'gone-one'
Add-FixtureSeat $archiveWorkspace 'stayer' 'stayer-proj' 'stayer-one'
Use-Seat $archiveWorkspace 'keeper'
Add-Topic $archiveWorkspace 'gone-topic' 'gone'
Add-Topic $archiveWorkspace 'keeper-topic' 'keeper'
$goneId = Get-SeatId $archiveWorkspace 'gone'

function Invoke-Retirement([string]$Workspace, [string]$Seat) {
    $planRun = Invoke-Helper 'Retire-Seat.ps1' @('-Seat', $Seat, '-WorkspacePath', $Workspace, '-Preflight', '-Json')
    if ($planRun.ExitCode -ne 0) { throw "the fixture could not retire '$Seat': $($planRun.Text)" }
    $plan = Get-Json $planRun 'the retirement plan'
    $run = Invoke-Helper 'Retire-Seat.ps1' @('-Seat', $Seat, '-WorkspacePath', $Workspace, '-UserConfirmed', '-ApprovedPlanId', ([string]$plan.plan_id), '-Json')
    if ($run.ExitCode -ne 0) { throw "retiring '$Seat' failed: $($run.Text)" }
    Split-Path -Leaf ([string](Get-Json $run 'the retirement result').archive_directory)
}
$goneArchive = Invoke-Retirement $archiveWorkspace 'gone'
$stayerArchive = Invoke-Retirement $archiveWorkspace 'stayer'

$strandRun = Invoke-Helper 'Remove-SeatArchive.ps1' @('-WorkspacePath', $archiveWorkspace, '-Archive', $goneArchive, '-Preflight', '-Json')
Assert-True ($strandRun.ExitCode -eq 0) "the archive preflight failed: $($strandRun.Text)"
$strandPlan = Get-Json $strandRun 'the archive purge plan'
$strandRefusals = (@(Get-Field $strandPlan 'refusals' 'the archive purge plan') -join ' ')
Assert-True ($strandRefusals.Contains('notebook/gone-topic')) "PURGING AN ARCHIVE WAS OFFERED WHILE AN OWNERSHIP ROW STILL CITED THE INCARNATION IT RECORDS: $strandRefusals"
Assert-True ($strandRefusals.Contains('Set-NotebookTopicOwner.ps1')) "the stranding refusal named no route out of it: $strandRefusals"
Assert-Equal '' ([string](Get-Field $strandPlan 'plan_id' 'the archive purge plan')) 'a plan_id was issued for an archive purge already certain to be refused'
Assert-Equal 'gone' ([string](Get-Field $strandPlan 'seat' 'the archive purge plan')) 'the plan did not read the seat out of the archive record'
Assert-Equal $goneId ([string](Get-Field $strandPlan 'seat_id' 'the archive purge plan')) 'the plan did not read the incarnation out of the archive record'
$strandApply = Invoke-Helper 'Remove-SeatArchive.ps1' @('-WorkspacePath', $archiveWorkspace, '-Archive', $goneArchive, '-UserConfirmed', '-Json')
Assert-True ($strandApply.ExitCode -ne 0) 'an archive purge ran with no plan_id at all'
Assert-True (Test-Path -LiteralPath (Join-Path $archiveWorkspace "internal/seat-archive/$goneArchive/seat.json") -PathType Leaf) 'A REFUSED ARCHIVE PURGE DELETED THE RETIREMENT RECORD ANYWAY'
# THE POSITIVE CONTROL, IN A DIFFERENT SUBJECT. `stayer` was retired the same way and owns nothing,
# so its archive must be purgeable -- or every assertion above passes against a helper that refuses
# every archive there is.
$stayerPlan = Get-Json (Invoke-Helper 'Remove-SeatArchive.ps1' @('-WorkspacePath', $archiveWorkspace, '-Archive', $stayerArchive, '-Preflight', '-Json')) 'the unstranded archive plan'
Assert-Equal '0' ([string]@(Get-Field $stayerPlan 'refusals' 'the unstranded archive plan').Count) "an archive citing no Notebook material was refused: $(@($stayerPlan.refusals) -join ' ')"

# --- 9b. THE ANSWER IS DERIVED FROM WHAT WOULD REMAIN, NOT FROM THE SEAT NAME --------------------
#
# Two archives can name one incarnation, and deleting either then strands nothing because the other
# still records the retirement. An implementation that asked "is this archive's seat cited" rather
# than "what would the status be afterwards" refuses both, forever.
$duplicate = Join-Path $archiveWorkspace 'internal/seat-archive/gone-19990101-000000'
Copy-Item -LiteralPath (Join-Path $archiveWorkspace "internal/seat-archive/$goneArchive") -Destination $duplicate -Recurse -Force
$dupPlan = Get-Json (Invoke-Helper 'Remove-SeatArchive.ps1' @('-WorkspacePath', $archiveWorkspace, '-Archive', 'gone-19990101-000000', '-Preflight', '-Json')) 'the duplicate archive plan'
Assert-Equal '0' ([string]@(Get-Field $dupPlan 'refusals' 'the duplicate archive plan').Count) "a duplicate retirement record was refused even though the original still records the retirement: $(@($dupPlan.refusals) -join ' ')"
$dupRun = Invoke-Helper 'Remove-SeatArchive.ps1' @('-WorkspacePath', $archiveWorkspace, '-Archive', 'gone-19990101-000000',
    '-UserConfirmed', '-ApprovedPlanId', ([string]$dupPlan.plan_id), '-Json')
Assert-True ($dupRun.ExitCode -eq 0) "the duplicate archive could not be purged: $($dupRun.Text)"
# AND THE ORIGINAL IS REFUSED AGAIN, now that it is the last record. Same archive, same row, and the
# answer moved because the other record left -- which is what makes the derivation load-bearing.
$againPlan = Get-Json (Invoke-Helper 'Remove-SeatArchive.ps1' @('-WorkspacePath', $archiveWorkspace, '-Archive', $goneArchive, '-Preflight', '-Json')) 'the last-record archive plan'
Assert-True ((@(Get-Field $againPlan 'refusals' 'the last-record plan') -join ' ').Contains('notebook/gone-topic')) 'the last remaining retirement record was purgeable while its incarnation was still cited'

# --- 9c. THE ROUTE OUT WORKS ---------------------------------------------------------------------
Set-NotebookTopicOwner -Workspace $archiveWorkspace -Topic 'gone-topic' -Seat 'keeper' -ActingSeat 'keeper'
$clearedPlan = Get-Json (Invoke-Helper 'Remove-SeatArchive.ps1' @('-WorkspacePath', $archiveWorkspace, '-Archive', $goneArchive, '-Preflight', '-Json')) 'the cleared archive plan'
Assert-Equal '0' ([string]@(Get-Field $clearedPlan 'refusals' 'the cleared archive plan').Count) "the remedy the refusal names did not clear it, so that message sends the reader nowhere: $(@($clearedPlan.refusals) -join ' ')"
$clearedRun = Invoke-Helper 'Remove-SeatArchive.ps1' @('-WorkspacePath', $archiveWorkspace, '-Archive', $goneArchive,
    '-UserConfirmed', '-ApprovedPlanId', ([string]$clearedPlan.plan_id), '-Json')
Assert-True ($clearedRun.ExitCode -eq 0) "the archive purge failed on the plan it had just issued: $($clearedRun.Text)"
$clearedResult = Get-Json $clearedRun 'the archive purge result'
Assert-Equal 'False' ([string](Get-Field $clearedResult 'archive_directory_exists' 'the archive purge result')) 'the purge reported success over a directory that is still there'
Assert-Equal $stayerArchive ((@(Get-Field $clearedResult 'archives_remaining' 'the archive purge result')) -join ',') 'the purge took the wrong archive, or took more than the one it was given'

# =================================================================================================
# 10. THE DESK RESTORE
# =================================================================================================
#
# NO CLAIM IS HELD IN THIS WORKSPACE. Start-LibrarySeat takes the seat's claim itself, so a fixture
# holding one would be refused by the very mechanism this section drives.
Exit-FixtureSeatClaim
$env:LIBRARY_SEAT = ''
$deskWorkspace = New-RecoveryWorkspace 'desk'
Add-FixtureSeat $deskWorkspace 'deskseat' 'desk-proj' 'desk-one'
Set-FixtureDeskLines -StateDirectory (Join-Path $deskWorkspace '.claude') -Seat 'deskseat' -Kind 'books' -Lines @('books/basic-memory', 'shelf/library-dev') | Out-Null
Set-FixtureDeskLines -StateDirectory (Join-Path $deskWorkspace '.claude') -Seat 'deskseat' -Kind 'projects' -Lines @('projects/desk-proj') | Out-Null
# THREE CONVERSATIONS, for the reason every other set here has three: a merge that truncates loses
# one invisibly at two. `c-two` is the one that will already be on the live record.
$archivedConversations = [pscustomobject]@{ schema = 1; seat = 'deskseat'; conversations = @(
    [pscustomobject]@{ session_id = 'c-one'; seat_id = 'desk-one'; source = 'binding'; first_seen_utc = '2026-01-01T00:00:00.0000000Z'; last_seen_utc = '2026-01-01T00:00:00.0000000Z' },
    [pscustomobject]@{ session_id = 'c-two'; seat_id = 'desk-one'; source = 'binding'; first_seen_utc = '2026-01-02T00:00:00.0000000Z'; last_seen_utc = '2026-01-02T00:00:00.0000000Z' },
    [pscustomobject]@{ session_id = 'c-three'; seat_id = 'desk-one'; source = 'launcher'; first_seen_utc = '2026-01-03T00:00:00.0000000Z'; last_seen_utc = '2026-01-03T00:00:00.0000000Z' }) }
[IO.File]::WriteAllText((Get-SeatConversationsPath -StateDirectory (Join-Path $deskWorkspace '.claude') -Seat 'deskseat'),
    (($archivedConversations | ConvertTo-Json -Depth 5) + "`n"), $utf8)
$deskArchive = Invoke-Retirement $deskWorkspace 'deskseat'

# THE SLUG REUSED, which is the case the whole thing is for: a new incarnation of the same name,
# with its own Project Hub already on its Desk.
Add-FixtureSeat $deskWorkspace 'deskseat' 'desk-proj' 'desk-two'
Set-FixtureDeskLines -StateDirectory (Join-Path $deskWorkspace '.claude') -Seat 'deskseat' -Kind 'projects' -Lines @('projects/desk-proj') | Out-Null
# AN ENTRY THE ARCHIVE DOES NOT HAVE, which is what tells "additive" apart from "make it match". A
# restore that replaced the Desk with the archived one would pass every other assertion here.
Set-FixtureDeskLines -StateDirectory (Join-Path $deskWorkspace '.claude') -Seat 'deskseat' -Kind 'books' -Lines @('shelf/orca-ide') | Out-Null
# AND ONE CONVERSATION ALREADY HERE, stamped LATER than the archive's copy of it. A merge that let
# the archive win would drag `last_seen_utc` backwards, and that field is what the cross-seat resume
# lookup sorts on -- so it would send a resumed conversation to a seat it had left.
$liveConversations = [pscustomobject]@{ schema = 1; seat = 'deskseat'; conversations = @(
    [pscustomobject]@{ session_id = 'c-two'; seat_id = 'desk-two'; source = 'binding'; first_seen_utc = '2026-06-01T00:00:00.0000000Z'; last_seen_utc = '2026-06-01T00:00:00.0000000Z' }) }
[IO.File]::WriteAllText((Get-SeatConversationsPath -StateDirectory (Join-Path $deskWorkspace '.claude') -Seat 'deskseat'),
    (($liveConversations | ConvertTo-Json -Depth 5) + "`n"), $utf8)

$deskPlanRun = Invoke-Helper 'Start-LibrarySeat.ps1' @('-WorkspacePath', $deskWorkspace, '-Seat', 'deskseat',
    '-RestoreDeskFromArchive', $deskArchive, '-Preflight', '-NoLaunch', '-Json')
Assert-True ($deskPlanRun.ExitCode -eq 0) "the Desk restore preflight failed: $($deskPlanRun.Text)"
$deskPlan = Get-Json $deskPlanRun 'the Desk restore plan'
$restorePlan = Get-Field $deskPlan 'desk_restore' 'the launcher plan'
Assert-Equal 'books/basic-memory,shelf/library-dev' ((@(Get-Field $restorePlan 'books_to_open' 'the Desk restore plan') | Sort-Object -CaseSensitive) -join ',') 'the plan did not carry the archived Books'
Assert-Equal 'projects/desk-proj' ((@(Get-Field $restorePlan 'projects_already_open' 'the Desk restore plan')) -join ',') 'the plan did not notice the entry this Desk already holds'
Assert-Equal '0' ([string]@(Get-Field $restorePlan 'projects_to_open' 'the Desk restore plan').Count) 'the plan would have written an entry that is already there'
Assert-Equal 'merge' ([string](Get-Field $restorePlan 'history' 'the Desk restore plan')) 'the archive records this same slug and its history was not offered'
Assert-Equal 'c-one,c-three' ((@(Get-Field $restorePlan 'conversations_to_add' 'the Desk restore plan') | Sort-Object -CaseSensitive) -join ',') 'the merge did not offer exactly the conversations this seat does not already have'

# --- 10a. NO -UserConfirmed, AND A WRONG plan_id, BOTH REFUSE WITH THE DESK UNCHANGED -----------
$deskBefore = (@(Get-DeskEntriesForSeat -StateDirectory (Join-Path $deskWorkspace '.claude') -Seat 'deskseat' -Kind 'books')) -join ','
$unconfirmed = Invoke-Helper 'Start-LibrarySeat.ps1' @('-WorkspacePath', $deskWorkspace, '-Seat', 'deskseat',
    '-RestoreDeskFromArchive', $deskArchive, '-ApprovedPlanId', ([string](Get-Field $deskPlan 'plan_id' 'the launcher plan')), '-NoLaunch', '-Json')
Assert-True ($unconfirmed.ExitCode -ne 0) 'A DESK RESTORE RAN ON A CORRECT plan_id WITH NO CONFIRMATION'
$staleDesk = Invoke-Helper 'Start-LibrarySeat.ps1' @('-WorkspacePath', $deskWorkspace, '-Seat', 'deskseat',
    '-RestoreDeskFromArchive', $deskArchive, '-UserConfirmed', '-ApprovedPlanId', 'restore-desk-nothing', '-NoLaunch', '-Json')
Assert-True ($staleDesk.ExitCode -ne 0) 'a Desk restore ran on a plan_id nothing issued'
Assert-Equal $deskBefore ((@(Get-DeskEntriesForSeat -StateDirectory (Join-Path $deskWorkspace '.claude') -Seat 'deskseat' -Kind 'books')) -join ',') 'A REFUSED DESK RESTORE WROTE TO THE DESK ANYWAY'

# --- 10b. THE RESTORE ----------------------------------------------------------------------------
$deskRun = Invoke-Helper 'Start-LibrarySeat.ps1' @('-WorkspacePath', $deskWorkspace, '-Seat', 'deskseat',
    '-RestoreDeskFromArchive', $deskArchive, '-UserConfirmed', '-ApprovedPlanId', ([string](Get-Field $deskPlan 'plan_id' 'the launcher plan')), '-NoLaunch', '-Json')
Assert-True ($deskRun.ExitCode -eq 0) "the Desk restore failed on the plan it had just issued: $($deskRun.Text)"
$deskState = Join-Path $deskWorkspace '.claude'
Assert-Equal 'books/basic-memory,shelf/library-dev,shelf/orca-ide' ((@(Get-DeskEntriesForSeat -StateDirectory $deskState -Seat 'deskseat' -Kind 'books') | Sort-Object -CaseSensitive) -join ',') 'THE RESTORE MADE THE DESK MATCH THE ARCHIVE INSTEAD OF ADDING TO IT'
# ADDITIVE: the entry the new seat already had is still there, exactly once.
Assert-Equal 'projects/desk-proj' ((@(Get-DeskEntriesForSeat -StateDirectory $deskState -Seat 'deskseat' -Kind 'projects')) -join ',') 'the restore duplicated or dropped an entry the Desk already held'
$merged = Read-SeatConversations -StateDirectory $deskState -Seat 'deskseat'
Assert-Equal 'c-one,c-three,c-two' ((@($merged.conversations | ForEach-Object { [string]$_.session_id }) | Sort-Object -CaseSensitive) -join ',') 'the merged history did not gain both archived conversations'
$twoRow = @(@($merged.conversations) | Where-Object { [string]$_.session_id -ceq 'c-two' }) | Select-Object -First 1
Assert-Equal '2026-06-01T00:00:00.0000000Z' ([string]$twoRow.last_seen_utc) 'THE ARCHIVED ENTRY OVERWROTE A LIVE ONE AND DRAGGED last_seen_utc BACKWARDS'
$oneRow = @(@($merged.conversations) | Where-Object { [string]$_.session_id -ceq 'c-one' }) | Select-Object -First 1
# THE INCARNATION IT WAS WRITTEN WITH, compared against the REGISTRY -- a different subject. A
# restore that restamped it would claim the conversation sat at an incarnation that did not exist yet.
Assert-Equal 'desk-one' ([string]$oneRow.seat_id) 'the restored conversation was restamped with the incarnation that reused the slug'
Assert-Equal 'desk-two' (Get-SeatId $deskWorkspace 'deskseat') 'the fixture''s two incarnations are the same, so the assertion above proves nothing'

# --- 10c. THE HISTORY DOES NOT TRAVEL ONTO ANOTHER SLUG, AND THE DESK DOES ----------------------
Add-FixtureSeat $deskWorkspace 'otherseat' 'other-proj' 'other-one'
$otherPlanRun = Invoke-Helper 'Start-LibrarySeat.ps1' @('-WorkspacePath', $deskWorkspace, '-Seat', 'otherseat',
    '-RestoreDeskFromArchive', $deskArchive, '-Preflight', '-NoLaunch', '-Json')
$otherPlan = Get-Field (Get-Json $otherPlanRun 'the foreign-slug Desk plan') 'desk_restore' 'the launcher plan'
Assert-Equal 'skipped' ([string](Get-Field $otherPlan 'history' 'the foreign-slug Desk plan')) 'A CONVERSATION HISTORY WAS COPIED ONTO A SEAT THE CONVERSATIONS NEVER SAT AT'
Assert-True (([string](Get-Field $otherPlan 'history_note' 'the foreign-slug Desk plan')).Contains("seat 'deskseat'")) 'the skip did not say which seat the archive records'
Assert-Equal '2' ([string]@(Get-Field $otherPlan 'books_to_open' 'the foreign-slug Desk plan').Count) 'the Desk lines were withheld too; they carry no claim about where they were'
$otherRun = Invoke-Helper 'Start-LibrarySeat.ps1' @('-WorkspacePath', $deskWorkspace, '-Seat', 'otherseat',
    '-RestoreDeskFromArchive', $deskArchive, '-UserConfirmed', '-ApprovedPlanId', ([string](Get-Json $otherPlanRun 'the foreign-slug launcher plan').plan_id), '-NoLaunch', '-Json')
Assert-True ($otherRun.ExitCode -eq 0) "the Desk restore onto another slug failed: $($otherRun.Text)"
Assert-Equal 'books/basic-memory,shelf/library-dev' ((@(Get-DeskEntriesForSeat -StateDirectory $deskState -Seat 'otherseat' -Kind 'books') | Sort-Object -CaseSensitive) -join ',') 'the archived Books did not reach the other seat''s Desk'
Assert-True ($null -eq (Read-SeatConversations -StateDirectory $deskState -Seat 'otherseat')) 'a conversation record was written at a seat the archive does not name'

# --- 10d. THE COMBINATIONS THAT ARE REFUSED -------------------------------------------------------
#
# One approval per run. A run that would both CREATE a seat and restore a Desk has two things to
# approve and one argument to carry them, so it is refused -- and refused BEFORE the Active Project
# Catalog is consulted, which is what lets this case run offline at all.
$bothRun = Invoke-Helper 'Start-LibrarySeat.ps1' @('-WorkspacePath', $deskWorkspace, '-Seat', 'brandnew',
    '-Project', 'brandnew-proj', '-RestoreDeskFromArchive', $deskArchive, '-NoLaunch', '-Json')
Assert-True ($bothRun.ExitCode -ne 0) 'a run created a seat and restored a Desk onto it under one approval'
Assert-True ($bothRun.Text.Contains('-NoLaunch')) "the refusal did not name the two commands that do it: $($bothRun.Text)"
Assert-True ($null -eq (Get-SeatEntry -Registry (Read-SeatRegistry -StateDirectory $deskState) -Seat 'brandnew')) 'the refused run created the seat anyway'
$pickerRun = Invoke-Helper 'Start-LibrarySeat.ps1' @('-WorkspacePath', $deskWorkspace, '-RestoreDeskFromArchive', $deskArchive, '-NoLaunch', '-Json')
Assert-True ($pickerRun.ExitCode -ne 0) 'the picker offered a Desk restore, which it cannot plan'
Assert-True ($pickerRun.Text.Contains('-Seat')) "the picker refusal did not name the argument that fixes it: $($pickerRun.Text)"
$unknownRun = Invoke-Helper 'Start-LibrarySeat.ps1' @('-WorkspacePath', $deskWorkspace, '-Seat', 'otherseat',
    '-RestoreDeskFromArchive', 'no-such-archive', '-Preflight', '-NoLaunch', '-Json')
Assert-True ($unknownRun.ExitCode -ne 0) 'a Desk restore planned against an archive that does not exist'
Assert-True (Test-NoPlan $unknownRun) 'a plan was printed for an archive that does not exist'

# =================================================================================================
# 11. WHAT IS IN A QUARANTINE, AND HOW OLD IT IS (2026-09-15)
# =================================================================================================
#
# ITS OWN WORKSPACE, and for once not because something here destroys. Sections 1-7 assert that the
# roster holds EXACTLY one quarantine, and this needs four. FOUR, because the roster and the Desk
# both CLASSIFY the set -- oldest against the rest -- and the rule this repository already follows
# is three wherever a set is classified: with two, a truncation puts one in the right bucket and
# loses the other invisibly. The fourth is the one neither source can date at all.
#
# ONE HAS NO JOURNAL, ONE HAS A CORRUPT JOURNAL, AND ONE WAS NEVER MADE BY A RESET. That is the
# whole point of the fixture. `quarantined_utc` is `''` whenever the reset journal is missing or
# unreadable, so an age taken from that field alone leaves the first two undated -- and the OLDEST
# quarantine here is one of them. Three good journals would have proved nothing about the fallback
# that exists for exactly this, and the undated one is the decoy for a sort that ranks an empty
# stamp first and calls it the oldest thing in the workspace.
#
# THE DESK IS ASSERTED HERE RATHER THAN IN THE SEAT SUITE. The Desk block and these two reads are
# two surfaces onto one fact, and the fixture that carries three different journal states is this
# one; rebuilding it beside Get-DeskOverview.ps1's own cases would be a second copy of it, which is
# what the whole repository's fixture helpers exist to prevent.
$legibleWorkspace = New-RecoveryWorkspace 'legible'
foreach ($fixtureSeat in @('olde', 'midl', 'fresh', 'stayer')) {
    Add-FixtureSeat $legibleWorkspace $fixtureSeat "$fixtureSeat-proj" "$fixtureSeat-one"
}
# THREE TOPICS IN THE ONE THAT GETS SHOWN, for the reason there are four quarantines: -Show
# classifies topics exactly as the roster classifies quarantines.
foreach ($topic in @('olde-alpha', 'olde-beta', 'olde-gamma')) { Add-Topic $legibleWorkspace $topic 'olde' }
Add-Topic $legibleWorkspace 'midl-one' 'midl'
Add-Topic $legibleWorkspace 'fresh-one' 'fresh'
# THE DECOY THAT MUST SURVIVE. `stayer` never resets, so its topic stays in `notebook/` and is in no
# quarantine at all -- an implementation that enumerated the Notebook instead of the quarantine
# directory names it, and every assertion below about what IS in a quarantine would still pass.
Add-Topic $legibleWorkspace 'stayer-topic' 'stayer'
Add-Article $legibleWorkspace 'olde-alpha' 'first.md'
Add-Article $legibleWorkspace 'olde-alpha' 'second.md'
Add-Article $legibleWorkspace 'olde-beta' 'only.md'
# NOT AN ARTICLE, AND NOT INVISIBLE EITHER: `file_count` is what says a topic holds something this
# listing does not name, rather than letting it read as one article's worth of material.
[IO.File]::WriteAllText((Join-Path $legibleWorkspace 'notebook/olde-beta/attachment.txt'), "not markdown`n", $utf8)
Add-Article $legibleWorkspace 'midl-one' 'middle.md'
Add-Article $legibleWorkspace 'fresh-one' 'recent.md'
Add-Article $legibleWorkspace 'fresh-one' 'newer.md'
Add-Article $legibleWorkspace 'stayer-topic' 'decoy.md'
[IO.File]::WriteAllText((Join-Path $legibleWorkspace 'notebook/stray-legible.md'), "# stray`n", $utf8)

Use-Seat $legibleWorkspace 'olde'
$oldeQuarantine = Get-QuarantineName (Invoke-Reset $legibleWorkspace 'olde')
Use-Seat $legibleWorkspace 'midl'
$midlQuarantine = Get-QuarantineName (Invoke-Reset $legibleWorkspace 'midl')
Use-Seat $legibleWorkspace 'fresh'
$freshQuarantine = Get-QuarantineName (Invoke-Reset $legibleWorkspace 'fresh')
Assert-Equal 'stayer-topic' (Get-NotebookTopicNames $legibleWorkspace) 'a seat-scoped reset took a topic it does not own, so the decoy is gone before it was used'

$legibleRoot = Join-Path $legibleWorkspace 'internal/notebook-reset-quarantine'
# THE JOURNAL GOES AND THE DIRECTORY IS BACK-DATED, and both halves are needed. With the journal
# gone the only remaining source of a date is the name; unless the name says something other than
# "a moment ago", an implementation that ignored the name entirely would still rank these correctly
# by accident.
$oldeName = 'olde-20250101-000000'
Remove-Item -LiteralPath (Join-Path (Join-Path $legibleRoot $oldeQuarantine) 'reset-journal.json') -Force
[IO.Directory]::Move((Join-Path $legibleRoot $oldeQuarantine), (Join-Path $legibleRoot $oldeName))
# UNREADABLE RATHER THAN ABSENT, because `journal_status` tells those two apart and the fallback has
# to cover both.
$midlName = 'midl-20260101-000000'
[IO.File]::WriteAllText((Join-Path (Join-Path $legibleRoot $midlQuarantine) 'reset-journal.json'), "{ not json at all", $utf8)
[IO.Directory]::Move((Join-Path $legibleRoot $midlQuarantine), (Join-Path $legibleRoot $midlName))
# AND ONE NEITHER SOURCE CAN DATE: a directory a reader made by hand, with no journal and no stamp.
# An empty string sorts BEFORE every real timestamp, so a sort that does not exclude it reports this
# as the oldest quarantine in the workspace -- which is the one thing the Desk block must not say.
$undatedName = 'handmade-folder'
New-Item -ItemType Directory -Path (Join-Path $legibleRoot $undatedName) -Force | Out-Null

function Get-QuarantineRow($Rows, [string]$Name) {
    $row = @($Rows | Where-Object { [string]$_.name -ceq $Name }) | Select-Object -First 1
    if ($null -eq $row) { throw "no row for quarantine '$Name'; the read named: $(@($Rows | ForEach-Object { [string]$_.name }) -join ',')" }
    $row
}
function Get-ShownTopic($Rows, [string]$Topic) {
    $row = @($Rows | Where-Object { [string]$_.topic -ceq $Topic }) | Select-Object -First 1
    if ($null -eq $row) { throw "no topic row for '$Topic'; the read named: $(@($Rows | ForEach-Object { [string]$_.topic }) -join ',')" }
    $row
}

# --- 11a. THE ROSTER DATES ALL FOUR, AND SAYS WHICH SOURCE ANSWERED ------------------------------
$env:LIBRARY_SEAT = ''
$legibleList = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $legibleWorkspace, '-List', '-Json')
$env:LIBRARY_SEAT = 'fresh'
Assert-True ($legibleList.ExitCode -eq 0) "the enriched roster was refused to a seatless session: $($legibleList.Text)"
$legibleRows = @(Get-Field (Get-Json $legibleList 'the quarantine roster') 'quarantines' 'the roster')
Assert-Equal '4' ([string]@($legibleRows).Count) 'the roster did not report all four quarantines'

$oldeRow = Get-QuarantineRow $legibleRows $oldeName
Assert-Equal 'missing' ([string](Get-Field $oldeRow 'journal' 'the journal-less row')) 'a quarantine with no reset-journal.json was not reported as missing one'
Assert-Equal '' ([string](Get-Field $oldeRow 'quarantined_utc' 'the journal-less row')) 'THE ROSTER FILLED quarantined_utc IN FROM THE DIRECTORY NAME; a reader can then no longer tell a journal''s answer from a guess at one'
Assert-Equal 'directory-name' ([string](Get-Field $oldeRow 'stamp_source' 'the journal-less row')) 'a quarantine whose journal is gone was left undated instead of falling back to its own stamped name'
Assert-Equal 'olde-alpha,olde-beta,olde-gamma' ((@(Get-Field $oldeRow 'topics' 'the journal-less row') | Sort-Object -CaseSensitive) -join ',') 'the roster lost a topic of the quarantine holding three'
Assert-Equal '3' ([string](Get-Field $oldeRow 'article_count' 'the journal-less row')) 'the roster did not count the articles across the quarantine''s topics'

$midlRow = Get-QuarantineRow $legibleRows $midlName
Assert-Equal 'unreadable' ([string](Get-Field $midlRow 'journal' 'the corrupt-journal row')) 'a quarantine whose journal does not parse was not reported as unreadable'
Assert-Equal 'directory-name' ([string](Get-Field $midlRow 'stamp_source' 'the corrupt-journal row')) 'a corrupt journal was treated differently from an absent one'
Assert-Equal '' ([string](Get-Field $midlRow 'quarantined_utc' 'the corrupt-journal row')) 'a corrupt journal yielded a timestamp anyway'

# THE POSITIVE CONTROL. Without it every assertion above passes against an implementation that reads
# the directory name and never opens a journal at all.
$freshRow = Get-QuarantineRow $legibleRows $freshQuarantine
Assert-Equal 'read' ([string](Get-Field $freshRow 'journal' 'the intact row')) 'a quarantine with a good journal was not reported as having one'
Assert-Equal 'journal' ([string](Get-Field $freshRow 'stamp_source' 'the intact row')) 'THE FALLBACK RAN EVEN WITH A GOOD JOURNAL PRESENT; the roster no longer says where its date came from'
Assert-True (-not [string]::IsNullOrWhiteSpace([string](Get-Field $freshRow 'quarantined_utc' 'the intact row'))) 'a quarantine with a readable journal reported no journal timestamp'
Assert-Equal '2' ([string](Get-Field $freshRow 'article_count' 'the intact row')) 'the roster miscounted the articles of the newest quarantine'

$undatedRow = Get-QuarantineRow $legibleRows $undatedName
Assert-Equal 'unknown' ([string](Get-Field $undatedRow 'stamp_source' 'the undated row')) 'a directory neither source can date was given a date'
Assert-True ($null -eq (Get-Field $undatedRow 'age_days' 'the undated row')) 'a quarantine nothing can date reported an age anyway'

# THE AGES THEMSELVES, against the literal dates this fixture put in the directory names. The band
# is a day, which is wide enough to survive the run and narrow enough that hours-as-days -- the
# arithmetic slip this is really watching for -- misses it by four orders of magnitude.
$oldeExpected = [math]::Round(([datetime]::UtcNow - [datetime]::ParseExact('20250101000000', 'yyyyMMddHHmmss',
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)).TotalDays, 1)
$oldeAge = [double](Get-Field $oldeRow 'age_days' 'the journal-less row')
Assert-True ([math]::Abs($oldeAge - $oldeExpected) -lt 1) "the age dated from a directory name was $oldeAge days, not about $oldeExpected"
Assert-True ([double](Get-Field $freshRow 'age_days' 'the intact row') -lt 1) 'a quarantine made seconds ago was not reported as new'
Assert-True ($oldeAge -gt [double](Get-Field $midlRow 'age_days' 'the corrupt-journal row')) 'the two directory-dated quarantines did not order by their stamps'
Assert-True ((@($legibleRows | ForEach-Object { @($_.topics) }) -join ',').Contains('stayer-topic') -eq $false) 'the roster named a topic that is still in notebook/ and in no quarantine'

# --- 11b. -Show NAMES THE ARTICLES, AND STILL NEEDS NO SEAT --------------------------------------
$env:LIBRARY_SEAT = ''
$showRun = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $legibleWorkspace, '-Quarantine', $oldeName, '-Show', '-Json')
$env:LIBRARY_SEAT = 'fresh'
Assert-True ($showRun.ExitCode -eq 0) "-Show was refused to a seatless session, which is the reader it exists for: $($showRun.Text)"
$shown = Get-Json $showRun 'the quarantine contents'
Assert-Equal $oldeName ([string](Get-Field $shown 'quarantine' 'the contents read')) '-Show reported a different quarantine from the one it was given'
Assert-Equal 'olde-alpha,olde-beta,olde-gamma' ((@(Get-Field $shown 'topics' 'the contents read') | Sort-Object -CaseSensitive) -join ',') 'THE `topics` STRING ARRAY CHANGED SHAPE; Remove-NotebookQuarantine.ps1 and this helper''s own restore path both read it as one'
$shownTopics = @(Get-Field $shown 'topic_articles' 'the contents read')
Assert-Equal '3' ([string]@($shownTopics).Count) '-Show did not report a row for every topic; a truncation is invisible at two'

$alphaRow = Get-ShownTopic $shownTopics 'olde-alpha'
Assert-Equal 'first.md,second.md' ((@(Get-Field $alphaRow 'articles' 'the alpha row')) -join ',') 'the articles inside a quarantined topic were not named'
Assert-Equal '2' ([string](Get-Field $alphaRow 'article_count' 'the alpha row')) 'the article count disagreed with the names beside it'
Assert-Equal '3' ([string](Get-Field $alphaRow 'file_count' 'the alpha row')) 'file_count did not count _index.md beside the two articles'
$betaRow = Get-ShownTopic $shownTopics 'olde-beta'
Assert-Equal 'only.md' ((@(Get-Field $betaRow 'articles' 'the beta row')) -join ',') '_index.md or a non-markdown file was named as an article'
Assert-Equal '3' ([string](Get-Field $betaRow 'file_count' 'the beta row')) 'a topic holding a file this listing does not name reported the same count as one that holds nothing else'
# THE TOPIC THAT CAME THROUGH EMPTY, which is a real answer rather than a missing row: the reader
# asking whether their page is in there needs to be told that this topic never held one.
$gammaRow = Get-ShownTopic $shownTopics 'olde-gamma'
Assert-Equal '0' ([string](Get-Field $gammaRow 'article_count' 'the gamma row')) 'a topic holding only its rendered index was credited with an article'
Assert-Equal '1' ([string](Get-Field $gammaRow 'file_count' 'the gamma row')) 'the index-only topic did not report the one file it holds'
Assert-Equal '3' ([string](Get-Field $shown 'article_count' 'the contents read')) 'the quarantine total did not add up its topics'
Assert-Equal 'stray-legible.md' ((@(Get-Field $shown 'loose_files' 'the contents read')) -join ',') '-Show did not report the loose file, or counted a journal as one'
Assert-Equal 'directory-name' ([string](Get-Field $shown 'stamp_source' 'the contents read')) '-Show dated a journal-less quarantine differently from the roster'
Assert-Equal '' ([string](Get-Field $shown 'quarantined_utc' 'the contents read')) '-Show filled quarantined_utc in where the roster left it empty'
Assert-True (-not $showRun.Text.Contains('stayer-topic')) '-Show named a topic that is still in notebook/ and in no quarantine'

# AND THE OTHER SIDE OF THE SAME READ, so a `-Show` hard-wired to the fallback is caught too.
$showFresh = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $legibleWorkspace, '-Quarantine', $freshQuarantine, '-Show', '-Json')
Assert-True ($showFresh.ExitCode -eq 0) "-Show failed on a quarantine with an intact journal: $($showFresh.Text)"
$shownFresh = Get-Json $showFresh 'the intact quarantine''s contents'
Assert-Equal 'journal' ([string](Get-Field $shownFresh 'stamp_source' 'the intact contents read')) '-Show used the directory name where a journal was readable'
Assert-Equal 'newer.md,recent.md' ((@(Get-ShownTopic @(Get-Field $shownFresh 'topic_articles' 'the intact contents read') 'fresh-one').articles) -join ',') 'the newest quarantine''s articles were not named'

# --- 11c. THE COMBINATIONS THAT ARE REFUSED ------------------------------------------------------
$showNoName = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $legibleWorkspace, '-Show', '-Json')
Assert-True ($showNoName.ExitCode -ne 0) '-Show with no quarantine named read something anyway'
Assert-True ($showNoName.Text.Contains('-List')) "the refusal did not name the read that finds the name: $($showNoName.Text)"
$showBoth = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $legibleWorkspace, '-List', '-Show', '-Json')
Assert-True ($showBoth.ExitCode -ne 0) '-List and -Show together silently ran one of the two'
$showPlanned = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $legibleWorkspace, '-Quarantine', $oldeName, '-Show', '-Preflight', '-Json')
Assert-True ($showPlanned.ExitCode -ne 0) '-Show and -Preflight together ran without saying which one happened'
Assert-True (Test-NoPlan $showPlanned) 'a plan_id was printed by a run that was refused'
$showUnknown = Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $legibleWorkspace, '-Quarantine', 'no-such-quarantine', '-Show', '-Json')
Assert-True ($showUnknown.ExitCode -ne 0) '-Show read a quarantine that does not exist'
Assert-True ($showUnknown.Text.Contains($oldeName)) "the refusal did not name the quarantines that do exist: $($showUnknown.Text)"

# --- 11d. AND THE DESK SAYS THERE IS SOMETHING TO READ -------------------------------------------
$deskRun = Invoke-Helper 'Get-DeskOverview.ps1' @('-WorkspacePath', $legibleWorkspace, '-Seat', 'fresh', '-Json')
Assert-True ($deskRun.ExitCode -eq 0) "the Desk overview failed once it read the quarantine root: $($deskRun.Text)"
$desk = Get-Json $deskRun 'the Desk overview'
$deskNotebook = Get-Field $desk 'notebook' 'the Desk overview'
$deskQuarantine = Get-Field $deskNotebook 'quarantine' 'the notebook block'
Assert-Equal '4' ([string](Get-Field $deskQuarantine 'count' 'the quarantine block')) 'the Desk miscounted the quarantines'
Assert-Equal '5' ([string](Get-Field $deskQuarantine 'topic_count' 'the quarantine block')) 'the Desk miscounted the topics held across the quarantines'
$deskOldest = Get-Field $deskQuarantine 'oldest' 'the quarantine block'
Assert-Equal $oldeName ([string](Get-Field $deskOldest 'name' 'the oldest row')) 'THE DESK NAMED THE WRONG OLDEST QUARANTINE -- the oldest here is the one whose journal is gone, and the undated one sorts ahead of everything if it is not excluded'
Assert-Equal 'directory-name' ([string](Get-Field $deskOldest 'stamp_source' 'the oldest row')) 'the Desk did not say which source dated the quarantine it named'
# THE SEAT IS JOURNAL-ONLY, AND THAT IS NOT THE SAME DECISION AS THE DATE. The directory name
# begins with the seat that made it, so a prefix could be read here -- but a directory can be
# renamed, and the seat is what decides whether a restore may act at all, which is why
# Get-RestoreDispositions refuses rather than guesses. The date falls back because
# Reset-LocalNotebook.ps1 writes the stamp itself and an age is orientation; the owner does not.
Assert-Equal '' ([string](Get-Field $deskOldest 'quarantined_by' 'the oldest row')) 'THE DESK READ A SEAT OFF A DIRECTORY NAME; a renamed folder then names an owner no record supports'
$deskFreshOldest = @(@(Get-Field (Get-Json (Invoke-Helper 'Restore-NotebookQuarantine.ps1' @('-WorkspacePath', $legibleWorkspace, '-List', '-Json')) 'the roster') 'quarantines' 'the roster') |
    Where-Object { [string]$_.name -ceq $freshQuarantine }) | Select-Object -First 1
Assert-Equal 'fresh' ([string](Get-Field $deskFreshOldest 'quarantined_by' 'the intact row')) 'the seat is not reported even where a readable journal records it'
Assert-Equal '1' ([string](Get-Field $deskQuarantine 'undated_count' 'the quarantine block')) 'the Desk dropped the quarantine nothing can date instead of reporting it'
Assert-True ([string](Get-Field $deskQuarantine 'list_route' 'the quarantine block')).Contains('-List') 'the Desk reported quarantines without the seatless command that reads them'
# THE NOTEBOOK'S OWN COUNTS ARE NOT WIDENED BY ANY OF IT. The decoy topic is all that is left in
# notebook/, so a quarantine counted as Notebook material shows up here as a four-fold error.
Assert-Equal '1' ([string](Get-Field $deskNotebook 'topic_count' 'the notebook block')) 'the Desk counted quarantined topics as Notebook topics'
Assert-Equal '1' ([string](Get-Field $deskNotebook 'article_count' 'the notebook block')) 'the Desk counted quarantined articles as Notebook articles'
$deskScope = [string](Get-Field $desk 'scope' 'the Desk overview')
Assert-True ($deskScope.Contains('quarantine')) "the scope line does not admit that the quarantine directories were read: $deskScope"

}
catch { $failure = $_ }
finally {
    Exit-FixtureSeatClaim
    $env:LIBRARY_SEAT = $savedSeat
    $env:LIBRARY_SEAT_CLAIM = $savedClaim
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($null -ne $failure) {
    [Console]::Error.WriteLine("recovery routes: FAILED at assertion $($script:cases) -- $($failure.Exception.Message)")
    exit 1
}

"recovery routes: $($script:cases) assertion(s) over the quarantine roster, restore, adoption, collision and live-owner refusals, the quarantine purge and its ownership rows, the seat-archive purge's stranding guard, the Desk restore, and what a quarantine's contents and age read as"
