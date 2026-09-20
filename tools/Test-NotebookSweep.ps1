<#
.SYNOPSIS
    `Reset-LocalNotebook.ps1 -AllIdleSeats` end to end: which seats' topics a sweep takes, which it
    names and leaves, what its preflight shows the reader before they approve, and what the one
    quarantine it makes records about whose each topic was. Run by Invoke-LibraryChecks.ps1 as
    `notebook.idle-seat-sweep`.

.DESCRIPTION
    WHY THIS IS ITS OWN SUITE. The sweep is the first operation in the Library that moves material
    belonging to a seat other than the one running it (ADR-0023, amending ADR-0016 on its third case
    only). Everything that keeps that safe is a classification -- idle against busy, registered
    against retired against unaccounted, owned against shared -- and a classification is exactly what
    a green suite can stop covering without anything going red. So the fixture below is built so that
    a WRONG implementation differs from a right one, and every positive is a decoy that must SURVIVE
    rather than a list that must be empty.

    THE SEATS, AND WHAT EACH ONE IS THE DECOY FOR.

      acting   the seat running the sweep; holds a real claim. Its own topic goes because a reset
               always took it, on its own claim rather than on anyone's idleness.
      idle     registered, no claim, THREE topics. Three rather than one for two reasons: a set that
               is classified needs three rows before a truncation is distinguishable from a
               reordering, and one seat owning several topics is what makes the memo observable --
               four foreign rows must cost TWO claim probes, not four.
      busy     registered, holding a claim. Its topic must survive, and must be NAMED with the rule
               that left it, because a sweep that silently skipped would be indistinguishable from
               one that could not see the seat at all.
      retired  retired through the real Retire-Seat.ps1. Its topic must survive a SWEEP: retirement
               is -WholeTree's gate and ADR-0016 is unchanged there. Its claim probe reads FREE, so
               an implementation that asked about liveness before incarnation sweeps it.

    AND `shared-topic`, DECLARED SHARED, WHICH NO SEAT'S RESET TAKES. It is the decoy for a sweep
    that widened to "everything that is not mine".

    THE COPY EVIDENCE IS MEASURED, NOT ASSERTED PRESENT. `idle-one` holds three pages of which ONE
    has a hash-bound Book copy, so its row must read page_count 3 and pages_without_current_copy 2.
    A wiring that carried the same number into both fields, or that joined every row to the first
    topic, reads 3 and 3 or 3 and 3 everywhere and passes an "is it there" assertion.

    FOUR WORKSPACES, because two of the cases below are refusals whose whole point is that nothing
    moved, and a shared fixture would leave a later case reading state an earlier one destroyed.
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
# ASSERT SHAPE BEFORE VALUES. Under StrictMode a missing property throws PropertyNotFound, a red
# that names this file's line rather than the field the helper failed to emit.
function Get-Field([object]$Object, [string]$Name, [string]$What) {
    $script:cases++
    $names = @($Object.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -cnotcontains $Name) { throw "$What -- the result carries no '$Name' property; it has: $($names -join ', ')" }
    $Object.$Name
}

$utf8 = [Text.UTF8Encoding]::new($false)
$root = Join-Path ([IO.Path]::GetTempPath()) ('sweep-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$savedSeat = $env:LIBRARY_SEAT
$savedClaim = $env:LIBRARY_SEAT_CLAIM
$heldClaims = [Collections.Generic.List[object]]::new()

function New-SweepWorkspace([string]$Name) {
    $path = Join-Path $root $Name
    foreach ($relative in @('.claude', 'internal', 'internal/publication-journals', 'notebook')) {
        New-Item -ItemType Directory -Path (Join-Path $path $relative) -Force | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $path 'notebook/_master-index.md'), "# Notebook`n", $utf8)
    $path
}
function Add-SweepSeat([string]$Workspace, [string]$Seat, [string]$SeatId) {
    Initialize-SeatForFixture -StateDirectory (Join-Path $Workspace '.claude') -Seat $Seat -Project "$Seat-proj" -SeatId $SeatId | Out-Null
}
function Add-SweepTopic([string]$Workspace, [string]$Topic, [string]$Seat, [string[]]$Articles) {
    New-Item -ItemType Directory -Path (Join-Path $Workspace "notebook/$Topic") -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $Workspace "notebook/$Topic/_index.md"), "# $Topic`n", $utf8)
    foreach ($article in @($Articles)) {
        [IO.File]::WriteAllText((Join-Path $Workspace "notebook/$Topic/$article"), "# $article`n`nbody`n", $utf8)
    }
    Set-NotebookTopicOwner -Workspace $Workspace -Topic $Topic -Seat $Seat -ActingSeat $Seat
}
function Use-SweepSeat([string]$Workspace, [string]$Seat) {
    $env:LIBRARY_SEAT = $Seat
    $claim = Enter-FixtureSeatClaim -StateDirectory (Join-Path $Workspace '.claude') -Seat $Seat
    [void]$heldClaims.Add($claim)
    $env:LIBRARY_SEAT_CLAIM = [string]$claim.token
    $claim
}
function Get-SweepSeatId([string]$Workspace, [string]$Seat) {
    Get-SeatEntryIncarnation -Entry (Get-SeatEntry -Registry (Read-SeatRegistry -StateDirectory (Join-Path $Workspace '.claude')) -Seat $Seat)
}
function Get-TopicNames([string]$Workspace) {
    (@(@(Get-ChildItem -LiteralPath (Join-Path $Workspace 'notebook') -Directory -Force -ErrorAction SilentlyContinue) |
        ForEach-Object { $_.Name } | Sort-Object -CaseSensitive) -join ',')
}
# $null IS FILTERED BEFORE THE PROPERTY IS READ. An empty list reaches a parameter as $null -- the
# pipeline unrolls it away on the way out of Get-Field -- and @($null) is an array holding one $null,
# whose .topic is a PropertyNotFound under StrictMode. Defect family 2, in its production direction.
function Get-Names($Rows) {
    (@(@($Rows) | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_.topic } | Sort-Object -CaseSensitive) -join ',')
}
function Get-Utf8Sha([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
# A `complete` publication journal binding ONE Notebook page to a Book by content hash, which is the
# only shape Get-LibraryTriageInventory counts as `known-current-copy`.
function Add-BookCopyRecord([string]$Workspace, [string]$Name, [string]$Slug, [string]$Relative) {
    $body = [pscustomobject]@{
        state = 'complete'
        book_slug = $Slug
        planned_records = @(@{ path = "books/$Slug/wiki/$Name.md"; source = $Relative; sha256 = (Get-Utf8Sha (Join-Path $Workspace $Relative)) })
    }
    [IO.File]::WriteAllText((Join-Path $Workspace "internal/publication-journals/$Name.json"), ($body | ConvertTo-Json -Depth 6), $utf8)
}
# THE RESET IN-PROCESS, because it emits an object rather than JSON and a -File child would hand back
# formatted text with no plan_id in it. It is still the real helper on the real path.
$resetHelper = Join-Path $PSScriptRoot 'Reset-LocalNotebook.ps1'
function Invoke-SweepPreflight([string]$Workspace, [string]$Seat, [switch]$AllIdleSeats, [switch]$WholeTree) {
    & $resetHelper -WorkspacePath $Workspace -Seat $Seat -AllIdleSeats:$AllIdleSeats -WholeTree:$WholeTree -Preflight
}
function Invoke-SweepApply([string]$Workspace, [string]$Seat, [string]$PlanId, [switch]$AllIdleSeats, [switch]$WholeTree) {
    & $resetHelper -WorkspacePath $Workspace -Seat $Seat -AllIdleSeats:$AllIdleSeats -WholeTree:$WholeTree `
        -UserConfirmed -ApprovedPlanId $PlanId
}
function Invoke-RealRetirement([string]$Workspace, [string]$Seat) {
    $helper = Join-Path $PSScriptRoot 'Retire-Seat.ps1'
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $planLines = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper -Seat $Seat -WorkspacePath $Workspace -Preflight -Json 2>&1)
        $planJson = @($planLines | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ } | Where-Object { $_.Trim().StartsWith('{') })
        if (-not $planJson.Count) { throw "the fixture could not retire seat '$Seat': $((@($planLines) | ForEach-Object { [string]$_ }) -join ' ')" }
        $plan = $planJson[-1] | ConvertFrom-Json
        $runLines = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper -Seat $Seat -WorkspacePath $Workspace `
            -UserConfirmed -ApprovedPlanId ([string]$plan.plan_id) -Json 2>&1)
        $runJson = @($runLines | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ } | Where-Object { $_.Trim().StartsWith('{') })
        if (-not $runJson.Count) { throw "the fixture's retirement of '$Seat' produced no result: $((@($runLines) | ForEach-Object { [string]$_ }) -join ' ')" }
    }
    finally { $ErrorActionPreference = $old }
}

$failure = $null
try {

# =================================================================================================
# THE MAIN FIXTURE: four seats, six topics, one of them shared
# =================================================================================================
$w = New-SweepWorkspace 'main'
Add-SweepSeat $w 'acting'  'acting-1'
Add-SweepSeat $w 'idle'    'idle-1'
Add-SweepSeat $w 'busy'    'busy-1'
Add-SweepSeat $w 'retired' 'retired-1'

# Owned by their own seats through the real writer, so every row's incarnation comes from the real
# registry entry rather than from this file.
Add-SweepTopic $w 'acting-one' 'acting'  @()
Add-SweepTopic $w 'idle-one'   'idle'    @('a.md', 'b.md')
Add-SweepTopic $w 'idle-two'   'idle'    @()
Add-SweepTopic $w 'idle-three' 'idle'    @()
Add-SweepTopic $w 'busy-one'   'busy'    @()
Add-SweepTopic $w 'retired-one' 'retired' @()
Add-SweepTopic $w 'shared-topic' 'acting' @()
Set-NotebookTopicOwner -Workspace $w -Topic 'shared-topic' -Scope 'shared'

# ONE of idle-one's three pages has a hash-bound Book copy, so its row must read 3 and 2 rather than
# two copies of one number.
Add-BookCopyRecord $w 'idle-one-a' 'idle-book' 'notebook/idle-one/a.md'

Invoke-RealRetirement $w 'retired'
$retiredClaimState = [string](Get-SeatClaimState -StateDirectory (Join-Path $w '.claude') -Seat 'retired' -AgentProcessId 0).state
Assert-Equal 'free' $retiredClaimState 'the retired seat does not read FREE to a claim probe, so the retired case below no longer proves the incarnation question is asked before the probe'

# THE ACTING SEAT FIRST, THEN THE BUSY ONE THROUGH Enter-SeatClaim RATHER THAN THE FIXTURE HELPER.
# Enter-FixtureSeatClaim is idempotent by design -- it releases whatever claim the test process was
# already holding -- so calling it for a second seat silently frees the first, and the busy seat then
# reads `free` while every skip assertion below passes for the wrong reason. Found by running it.
$null = Use-SweepSeat $w 'acting'
$busyClaim = Enter-SeatClaim -StateDirectory (Join-Path $w '.claude') -Seat 'busy'
[void]$heldClaims.Add($busyClaim)
Assert-Equal 'held' ([string](Get-SeatClaimState -StateDirectory (Join-Path $w '.claude') -Seat 'busy' -AgentProcessId 0).state) 'the busy seat is not actually holding a claim, so every skip below would pass for the wrong reason'

# --- 1. SELECTION WITHOUT THE FLAG IS UNCHANGED --------------------------------------------------
$plainLock = Enter-SeatRegistryLock -Workspace $w
try {
    $plain = Get-NotebookResetTargets -Workspace $w -Seat 'acting'
    Assert-Equal 'acting-one' (Get-Names (Get-Field $plain 'targets' 'the plain selection')) 'a reset with no -AllIdleSeats selected something other than this seat''s own topic'
    Assert-Equal '' (Get-Names (Get-Field $plain 'swept' 'the plain selection')) 'a reset with no -AllIdleSeats swept something'
    Assert-Equal '' (Get-Names (Get-Field $plain 'skipped' 'the plain selection')) 'a reset with no -AllIdleSeats reported skipped seats it never asked about'
    Assert-Equal '0' ([string](Get-Field $plain 'sweep_probes' 'the plain selection')) 'a reset with no -AllIdleSeats probed a seat claim anyway'
    Assert-True (-not [bool](Get-Field $plain 'all_idle_seats' 'the plain selection')) 'the plain selection reported itself as a sweep'

    # --- 2. THE SWEEP TAKES THE IDLE SEAT'S TOPICS AND NOTHING ELSE ------------------------------
    $sweep = Get-NotebookResetTargets -Workspace $w -Seat 'acting' -AllIdleSeats
    Assert-Equal 'acting-one,idle-one,idle-three,idle-two' (Get-Names (Get-Field $sweep 'targets' 'the sweep selection')) 'the sweep selected the wrong set of topics'
    Assert-Equal 'idle-one,idle-three,idle-two' (Get-Names (Get-Field $sweep 'swept' 'the sweep selection')) 'the sweep''s own list does not name the topics it added to targets'
    Assert-Equal 'busy-one' (Get-Names (Get-Field $sweep 'skipped' 'the sweep selection')) 'the sweep did not name exactly the foreign topic it left alone'
    # THE EXACT SET IS THE ONE ASSERTION, and three "and it did not take X" lines are deliberately NOT
    # written beside it. Every one of them is implied by the equality above, so none of them could
    # fail while it passes -- and a second guard on one property is how the load-bearing one comes to
    # be deleted with nothing going red. Falsification confirmed it the other way round: a sweep that
    # took the retired topic and one that took the shared topic were both caught HERE, with the
    # offending name printed in the actual value. The two lines below pin something different -- that
    # the fixture still HAS a retired and a shared topic for the equality to be about.
    Assert-Equal 'retired-one' (Get-Names (Get-Field $sweep 'retired' 'the sweep selection')) 'the retired seat''s topic left the retired list, so the assertion above no longer has a subject'
    Assert-Equal 'shared-topic' (Get-Names (Get-Field $sweep 'protected' 'the sweep selection')) 'the shared topic left the protected list, so the assertion above no longer has a subject'
    Assert-Equal '0' ([string]@(Get-Field $sweep 'refusals' 'the sweep selection').Count) "a sweep over a fully mapped Notebook refused: $(@($sweep.refusals) -join ' ')"

    # THE SKIP CARRIES THE RULE AND THE READER'S SENTENCE, not one shared silence.
    $skippedRow = @(@($sweep.skipped) | Where-Object { [string]$_.topic -ceq 'busy-one' })[0]
    Assert-Equal 'skip' ([string](Get-Field $skippedRow 'decision' 'the skipped row')) 'the busy seat''s topic was not skipped'
    Assert-Equal 'live-session' ([string](Get-Field $skippedRow 'reason' 'the skipped row')) 'the busy seat''s topic was skipped for the wrong reason'
    Assert-Equal 'held' ([string](Get-Field $skippedRow 'claim_state' 'the skipped row')) 'the skipped row does not report the claim state the decision was made on'
    Assert-Equal 'busy' ([string](Get-Field $skippedRow 'seat' 'the skipped row')) 'the skipped row does not name whose topic it is'
    Assert-True (([string](Get-Field $skippedRow 'note' 'the skipped row')).Contains('live session')) "the skipped row carries no sentence a preflight could show: $([string]$skippedRow.note)"

    # --- 3. EACH DISTINCT (seat, seat_id) IS RESOLVED ONCE PER PASS ------------------------------
    #
    # FOUR FOREIGN ROWS OVER TWO SEATS. `sweep_probes` is incremented where the predicate is really
    # called, so an implementation that dropped the memo reports 4 here -- and every other assertion
    # in this section still passes, which is exactly why this one is separate. It is also a
    # CONSISTENCY guard rather than only a cost one: two probes of one seat can disagree, and then
    # one of idle's three topics goes while its siblings stay, from one pass over one record.
    Assert-Equal '4' ([string]@(Get-Field $sweep 'foreign' 'the sweep selection').Count) 'the fixture no longer has four foreign ownership rows, so the probe count below proves nothing'
    Assert-Equal '2' ([string](Get-Field $sweep 'sweep_probes' 'the sweep selection')) 'the sweep probed once per ownership ROW rather than once per distinct seat'
    Assert-Equal '2' ([string](Get-Field $sweep 'sweep_seats' 'the sweep selection')) 'the sweep resolved a different number of seats than it probed'

    # --- 4. THE TWO SWITCHES ARE REFUSED TOGETHER ------------------------------------------------
    #
    # ADR-0023 rejected extending -WholeTree to idle unretired seats BY NAME. If the flags composed,
    # the foreign refusal that keeps ADR-0016's third case refused would be half-silenced by a second
    # switch and nothing would say -WholeTree may reach an idle seat.
    $combined = $null
    try { Get-NotebookResetTargets -Workspace $w -Seat 'acting' -WholeTree -AllIdleSeats | Out-Null }
    catch { $combined = [string]$_.Exception.Message }
    Assert-True ($null -ne $combined) 'A WHOLE-TREE RESET AND AN IDLE-SEAT SWEEP COMBINED INTO ONE SELECTION'
    Assert-True ($combined -clike '*ADR-0016*' -and $combined -clike '*ADR-0023*') "the combination refusal cites neither decision that separates them: $combined"

    # --- 5. -WholeTree ALONE IS EXACTLY AS IT WAS ------------------------------------------------
    $whole = Get-NotebookResetTargets -Workspace $w -Seat 'acting' -WholeTree
    Assert-Equal 'acting-one,retired-one' (Get-Names (Get-Field $whole 'targets' 'the whole-tree selection')) 'a whole-tree reset stopped covering exactly this seat''s topics and the retired incarnation''s'
    Assert-Equal '' (Get-Names (Get-Field $whole 'swept' 'the whole-tree selection')) 'A WHOLE-TREE RESET SWEPT AN IDLE SEAT, which is the defect ADR-0016 refused'
    Assert-Equal '0' ([string](Get-Field $whole 'sweep_probes' 'the whole-tree selection')) 'a whole-tree reset probed claims, so the sweep is reachable through it'
    Assert-True (@(Get-Field $whole 'refusals' 'the whole-tree selection').Count -gt 0) 'a whole-tree reset stopped hard-refusing the live foreign seats'
}
finally { Exit-BookLock -Lock $plainLock }

# --- 6. THE PREFLIGHT THE READER APPROVES -------------------------------------------------------
#
# Completion criterion 2 of PLAN-notebook-drain.md: per topic, which will go, WHOSE it is, and how
# much of it already exists durably in a Book or a Project Hub -- in the sweep's OWN preflight, not
# in a separate report the reader would have to know to run.
$preflight = Invoke-SweepPreflight $w 'acting' -AllIdleSeats
$sweepBlock = Get-Field $preflight 'sweep' 'the sweep preflight'
Assert-True ([bool](Get-Field $sweepBlock 'requested' 'the sweep block')) 'the preflight does not report that a sweep was requested'
Assert-Equal 'idle-one,idle-three,idle-two' (Get-Names (Get-Field $sweepBlock 'to_sweep' 'the sweep block')) 'the preflight does not name the topics the sweep will take'
Assert-Equal 'busy-one' (Get-Names (Get-Field $sweepBlock 'skipped' 'the sweep block')) 'the preflight does not name the topic the sweep is leaving'
Assert-Equal '2' ([string](Get-Field $sweepBlock 'claim_probes' 'the sweep block')) 'the preflight does not carry the real probe count, so the memo cannot be held to account from outside'
Assert-True (([string](Get-Field $sweepBlock 'message' 'the sweep block')).Contains('pages_without_current_copy')) 'the preflight does not tell the reader which number to act on'

# WHOSE, on every row. A cross-seat move whose preflight cannot say whose material it is, is the
# operation ADR-0016 was right to refuse.
foreach ($row in @($sweepBlock.to_sweep)) {
    Assert-Equal 'idle' ([string](Get-Field $row 'seat' 'a to_sweep row')) "the preflight row for '$([string]$row.topic)' does not name the seat it belongs to"
    Assert-Equal 'idle-1' ([string](Get-Field $row 'seat_id' 'a to_sweep row')) "the preflight row for '$([string]$row.topic)' does not name the INCARNATION it belongs to"
    Assert-Equal 'idle' ([string](Get-Field $row 'reason' 'a to_sweep row')) "the preflight row for '$([string]$row.topic)' was taken for a reason other than idleness"
    Assert-Equal 'read' ([string](Get-Field $row 'copy_evidence' 'a to_sweep row')) "the preflight row for '$([string]$row.topic)' carries no copy evidence, so the reader is approving a move blind"
}

# AND HOW MUCH OF EACH ALREADY EXISTS DURABLY. idle-one holds three pages of which one is a
# hash-bound Book copy; the other two topics hold one page each with no copy at all. A wiring that
# carried page_count into both fields, or joined every row to the first topic, reads the same pair
# three times.
$oneRow = @(@($sweepBlock.to_sweep) | Where-Object { [string]$_.topic -ceq 'idle-one' })[0]
Assert-Equal '3' ([string](Get-Field $oneRow 'page_count' 'the idle-one row')) 'the preflight miscounted the pages in the topic it is about to move'
Assert-Equal '2' ([string](Get-Field $oneRow 'pages_without_current_copy' 'the idle-one row')) 'the preflight did not count the pages with NO current copy; only known-current-copy is proof'
Assert-Equal 'idle-book' ((@(Get-Field $oneRow 'known_books' 'the idle-one row')) -join ',') 'the preflight does not name the Book the copy is in'
Assert-Equal '' ((@(Get-Field $oneRow 'known_projects' 'the idle-one row')) -join ',') 'a Book copy was reported as a Project Hub copy; the two classes are named separately (ADR-0022)'
$twoRow = @(@($sweepBlock.to_sweep) | Where-Object { [string]$_.topic -ceq 'idle-two' })[0]
Assert-Equal '1' ([string](Get-Field $twoRow 'page_count' 'the idle-two row')) 'every to_sweep row reported the same page count, so the rows are not joined per topic'
Assert-Equal '1' ([string](Get-Field $twoRow 'pages_without_current_copy' 'the idle-two row')) 'a topic with no copy record anywhere reported pages that are safe to lose'

# THE SKIPPED ROW SHOWS THE PREDICATE'S OWN SENTENCE, never a second copy composed at the call site.
$skippedPreview = @(@($sweepBlock.skipped) | Where-Object { [string]$_.topic -ceq 'busy-one' })[0]
Assert-Equal 'busy' ([string](Get-Field $skippedPreview 'seat' 'the skipped preview row')) 'the preflight does not say whose the skipped topic is'
Assert-Equal 'live-session' ([string](Get-Field $skippedPreview 'reason' 'the skipped preview row')) 'the preflight does not say which rule left the skipped topic alone'
Assert-True (([string](Get-Field $skippedPreview 'note' 'the skipped preview row')).Contains('Wait for that session to end')) "the preflight shows no remedy for the skipped seat: $([string]$skippedPreview.note)"

# The seat scope is stated before the reader approves, because a sweep is the one shape that moves
# somebody else's topics.
Assert-True (([string](Get-Field $preflight 'seat_scope' 'the sweep preflight')).Contains('idle right now')) "the preflight does not say whose material this run reaches: $([string]$preflight.seat_scope)"

# --- 6b. THE PREFLIGHT SAYS WHAT WILL REMAIN, AND SUBTRACTS THE TARGETS ---------------------------
#
# Reported from the Report Inbox 2026-09-15: a reader asked for an empty Notebook, approved the
# widest scope available, and learned only afterwards that two topics had survived. The preflight
# predicted what it would TAKE and never what would be LEFT.
#
# THE SUBTRACTION IS THE WHOLE CLAIM, so both overlap classes get their own case and both carry a
# DECOY. The classification lists overlap `targets` by design -- a swept foreign topic sits in
# `foreign` AND `targets`, a retired one under -WholeTree sits in `retired` AND `targets` -- so an
# implementation that copies the lists instead of subtracting returns a plausible wrong answer
# rather than an empty one. Here it would say four foreign topics survive a sweep that takes three
# of them, and that retired-one survives the whole-tree reset that quarantines it.
function Join-Predicted($Values) { ((@(@($Values) | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ }) | Sort-Object -CaseSensitive) -join ',') }

$sweptRemaining = Get-Field $preflight 'predicted_remaining' 'the sweep preflight'
Assert-Equal 'busy-one (seat busy)' (Join-Predicted (Get-Field $sweptRemaining 'owned_by_other_seats' 'the sweep prediction')) 'THE PREDICTION DID NOT SUBTRACT THE SWEPT TOPICS from the foreign list, so it over-reports what survives a sweep'
Assert-Equal 'retired-one (seat retired, retired)' (Join-Predicted (Get-Field $sweptRemaining 'owned_by_retired_seats' 'the sweep prediction')) 'the prediction lost the retired topic, which a sweep does not take and which therefore does remain'
Assert-Equal 'shared-topic (shared)' (Join-Predicted (Get-Field $sweptRemaining 'protected' 'the sweep prediction')) 'the prediction does not name the protected topic as remaining'
Assert-Equal '' (Join-Predicted (Get-Field $sweptRemaining 'owned_by_this_seat' 'the sweep prediction')) 'the prediction says one of this seat''s own topics survives its own reset'
Assert-True (-not [bool](Get-Field $sweptRemaining 'notebook_will_be_empty' 'the sweep prediction')) 'THE PREDICTION CALLED THE NOTEBOOK EMPTY while three topics remain in it'
Assert-True (([string](Get-Field $sweptRemaining 'note' 'the sweep prediction')).Contains('will NOT be empty')) "the prediction does not tell the reader in words that the Notebook survives this run: $([string]$sweptRemaining.note)"

# THE PROTECTED TOPIC IS THE ONLY ONE THAT GETS EVIDENCE, because it is the only one whose remedy is
# undoing somebody's deliberate declaration. Negative direction first: this fixture has no journal
# naming a Book called `shared-topic`, so the reader must be told it is the only copy.
$sharedEvidence = @(@(Get-Field $sweptRemaining 'protected_recoverability' 'the sweep prediction') | Where-Object { [string]$_.topic -ceq 'shared-topic' })[0]
Assert-True ($null -ne $sharedEvidence) 'the prediction carries no recoverability evidence for the protected topic'
Assert-Equal '0' ([string](Get-Field $sharedEvidence 'complete_publication_journals' 'the protected evidence')) 'a topic with no publication journal was reported as having one'
Assert-True (([string](Get-Field $sharedEvidence 'note' 'the protected evidence')).Contains('only copy')) "the evidence does not warn that an unpublished protected topic is the only copy: $([string]$sharedEvidence.note)"

# POSITIVE DIRECTION, AND EVERY WAY A JOURNAL MUST FAIL TO COUNT GETS ITS OWN FILE. One of these
# four is the real thing; the other three each break a different one of the conditions the real
# selector applies, and all four match the filename pattern. A count of 4 means the filter degraded
# to a filename match, 2 or 3 means one condition stopped being applied, and 0 means the positive
# path never ran at all.
function Add-JournalFixture([string]$Workspace, [string]$File, [hashtable]$Body) {
    [IO.File]::WriteAllText((Join-Path $Workspace "internal/publication-journals/$File"), ([pscustomobject]$Body | ConvertTo-Json -Depth 6), $utf8)
}
Add-JournalFixture $w 'shared-topic-aaa.json' @{ state = 'complete'; book_slug = 'shared-topic'; timestamp_utc = '2026-01-01T00:00:00.0000000Z'; source_digest_sha256 = 'aaa'; planned_records = @() }
Add-JournalFixture $w 'shared-topic-bbb.json' @{ state = 'partial';  book_slug = 'shared-topic'; timestamp_utc = '2026-06-01T00:00:00.0000000Z'; source_digest_sha256 = 'bbb'; planned_records = @() }
Add-JournalFixture $w 'shared-topic-ccc.json' @{ state = 'complete'; book_slug = 'other-book';   timestamp_utc = '2026-07-01T00:00:00.0000000Z'; source_digest_sha256 = 'ccc'; planned_records = @() }
Add-JournalFixture $w 'shared-topic-ddd.json' @{ state = 'complete'; book_slug = 'shared-topic'; source_digest_sha256 = 'ddd'; planned_records = @() }

$republished = Invoke-SweepPreflight $w 'acting' -AllIdleSeats
$sharedAfter = @(@((Get-Field $republished 'predicted_remaining' 'the republished preflight').protected_recoverability) | Where-Object { [string]$_.topic -ceq 'shared-topic' })[0]
Assert-Equal '1' ([string](Get-Field $sharedAfter 'complete_publication_journals' 'the republished evidence')) 'the evidence counted a journal that is unfinished, names another Book, or carries no timestamp -- or missed the one real journal'
Assert-Equal '2026-01-01T00:00:00.0000000Z' ([string](Get-Field $sharedAfter 'newest_publication_utc' 'the republished evidence')) 'the evidence reports a publication date from a journal it should not have counted'
Assert-True (([string](Get-Field $sharedAfter 'note' 'the republished evidence')).Contains('Restore-BookSource.ps1 -Book shared-topic')) "the evidence does not name the command that rebuilds the topic: $([string]$sharedAfter.note)"
Assert-True (([string](Get-Field $sharedAfter 'note' 'the republished evidence')).Contains('not a promise')) 'the evidence promises a restore will succeed, which it has not checked and which Restore-BookSource can still refuse'

# THE SECOND OVERLAP CLASS. Under -WholeTree the retired topic IS a target, so the same list that
# had to report it above must now report nothing -- which is what makes this a subtraction rather
# than a fixed exclusion of one bucket.
$wholeRemaining = Get-Field (Invoke-SweepPreflight $w 'acting' -WholeTree) 'predicted_remaining' 'the whole-tree preflight'
Assert-Equal '' (Join-Predicted (Get-Field $wholeRemaining 'owned_by_retired_seats' 'the whole-tree prediction')) 'THE PREDICTION DID NOT SUBTRACT THE RETIRED TOPIC a whole-tree reset is about to quarantine'
Assert-True (([string](Get-Field $wholeRemaining 'note' 'the whole-tree prediction')).Contains('REFUSED')) "a whole-tree run over live foreign seats is refused, and the prediction presented it as a forecast anyway: $([string]$wholeRemaining.note)"

# --- 7. AN ORDINARY RESET'S APPROVAL CANNOT BE REPLAYED AS A SWEEP ------------------------------
$plainPreflight = Invoke-SweepPreflight $w 'acting'
Assert-True (([string]$plainPreflight.plan_id) -cne ([string]$preflight.plan_id)) 'A PLAIN RESET AND A SWEEP OVER THE SAME WORKSPACE ISSUED THE SAME plan_id'
$replayed = $null
try { Invoke-SweepApply $w 'acting' ([string]$plainPreflight.plan_id) -AllIdleSeats | Out-Null }
catch { $replayed = [string]$_.Exception.Message }
Assert-True ($null -ne $replayed) 'AN APPROVAL FOR AN ORDINARY RESET EXECUTED A CROSS-SEAT SWEEP'
Assert-True ($replayed -clike '*nothing was moved*') "the replayed approval failed for the wrong reason: $replayed"
Assert-Equal 'acting-one,busy-one,idle-one,idle-three,idle-two,retired-one,shared-topic' (Get-TopicNames $w) 'the refused replay moved something anyway'

# --- 8. THE RUN, AND THE ONE QUARANTINE IT MAKES ------------------------------------------------
$applied = Invoke-SweepApply $w 'acting' ([string]$preflight.plan_id) -AllIdleSeats
Assert-Equal 'completed' ([string](Get-Field $applied 'status' 'the sweep result')) 'the sweep did not complete'
Assert-Equal 'acting-one,idle-one,idle-three,idle-two' ((@(Get-Field $applied 'quarantined' 'the sweep result') | Sort-Object -CaseSensitive) -join ',') 'the sweep quarantined the wrong set of topics'
Assert-Equal 'busy-one,retired-one,shared-topic' (Get-TopicNames $w) 'the Notebook does not hold exactly the topics the sweep was not entitled to'

# ONE QUARANTINE PER RUN, NOT ONE PER SEAT (D4). Several seats' topics, one plan_id, one directory.
$quarantines = @(Get-NotebookQuarantineInventory -Workspace $w)
Assert-Equal '1' ([string]$quarantines.Count) 'a sweep across several seats made more than one quarantine'
$quarantine = $quarantines[0]
Assert-Equal 'acting-one,idle-one,idle-three,idle-two' ((@(Get-Field $quarantine 'topics' 'the quarantine') | Sort-Object -CaseSensitive) -join ',') 'the quarantine does not hold what the run said it moved'
Assert-True ([bool](Get-Field $quarantine 'all_idle_seats' 'the quarantine')) 'the quarantine does not record that it came from a sweep, so nothing distinguishes it from a whole-tree reset'
Assert-True (-not [bool](Get-Field $quarantine 'whole_tree' 'the quarantine')) 'the sweep recorded itself as a whole-tree reset'

# THE JOURNAL IS THE ONLY THING THAT WILL EVER SAY WHOSE EACH TOPIC WAS. The ownership rows stay
# behind pointing at seats, but a purge takes them; the material in the quarantine carries no owner
# of its own. If this is wrong, a sweep is a one-way door.
$owners = @(Get-Field $quarantine 'recorded_owners' 'the quarantine')
Assert-Equal '4' ([string]$owners.Count) 'the quarantine journal does not record an owner for every topic it holds'
$ownerPairs = (@(@($owners) | ForEach-Object { "$([string]$_.topic)=$([string]$_.seat):$([string]$_.seat_id)" } | Sort-Object -CaseSensitive) -join ' ')
Assert-Equal 'acting-one=acting:acting-1 idle-one=idle:idle-1 idle-three=idle:idle-1 idle-two=idle:idle-1' $ownerPairs 'the quarantine journal does not name the right seat and incarnation for each topic it holds'

# AND THE TWO SEATLESS READS MUST SAY IT, not merely the inventory function behind them. Everything
# above this line asserts Get-NotebookQuarantineInventory; `-List` and `-Show` are what the playbook,
# the Skill and the Desk's own quarantine block send a reader to, and both PROJECT the row rather
# than returning it. Both projected `whole_tree` and dropped `all_idle_seats`, so on 2026-09-15 a
# sweep's quarantine read exactly like an ordinary seat-scoped one on the only surface that answers
# "what survived?" -- which is the thing the assertion three lines above says the field exists to
# prevent. Run in-process against the real helper, for the reason the reset is.
$restoreHelper = Join-Path $PSScriptRoot 'Restore-NotebookQuarantine.ps1'
$quarantineName = [string](Get-Field $quarantine 'name' 'the quarantine')
$roster = & $restoreHelper -WorkspacePath $w -List
$rosterRow = @(Get-Field $roster 'quarantines' 'the quarantine roster')[0]
Assert-True ([bool](Get-Field $rosterRow 'all_idle_seats' 'the roster row')) 'THE ROSTER DOES NOT SAY THIS QUARANTINE CAME FROM A SWEEP, so it reads exactly like an ordinary seat-scoped one'
Assert-True (-not [bool](Get-Field $rosterRow 'whole_tree' 'the roster row')) 'the roster calls the sweep a whole-tree reset'

$shown = & $restoreHelper -WorkspacePath $w -Quarantine $quarantineName -Show
Assert-True ([bool](Get-Field $shown 'all_idle_seats' 'the -Show read')) 'the -Show read does not say this quarantine came from a sweep'
Assert-True (-not [bool](Get-Field $shown 'whole_tree' 'the -Show read')) 'the -Show read calls the sweep a whole-tree reset'
# ONE ROW PER TOPIC, WITH THE SEAT ON IT. A projection that carried the field through as an empty
# array, or joined every row to the first topic, passes an "is it there" check and fails this one.
$shownOwners = @(Get-Field $shown 'recorded_owners' 'the -Show read')
Assert-Equal 'acting-one=acting idle-one=idle idle-three=idle idle-two=idle' ((@(@($shownOwners) | ForEach-Object { "$([string]$_.topic)=$([string]$_.seat)" } | Sort-Object -CaseSensitive) -join ' ')) 'the -Show read does not name whose each topic was, which is the only record of it there will ever be'

# WHAT REMAINS, AND WHOSE IT IS (completion criterion 3), re-derived after the moves.
$remaining = Get-Field $applied 'remaining_in_notebook' 'the sweep result'
Assert-Equal '' ((@(Get-Field $remaining 'owned_by_this_seat' 'the remaining block')) -join ',') 'a topic this seat owns survived its own sweep'
Assert-Equal 'busy-one (seat busy)' ((@(Get-Field $remaining 'owned_by_other_seats' 'the remaining block')) -join ',') 'what remains does not name the busy seat''s topic and whose it is'
Assert-Equal 'retired-one (seat retired, retired)' ((@(Get-Field $remaining 'owned_by_retired_seats' 'the remaining block')) -join ',') 'what remains does not name the retired seat''s topic'
Assert-Equal 'shared-topic (shared)' ((@(Get-Field $remaining 'protected' 'the remaining block')) -join ',') 'what remains does not name the shared topic'

# NO DESK BUT THIS SEAT'S IS TOUCHED, and this seat's is preserved because -ClearDesk was not passed.
Assert-True (-not [bool](Get-Field $applied 'virtual_desk_cleared' 'the sweep result')) 'a sweep cleared the Desk without being asked to'
# 'retired' is deliberately not in this list: Retire-Seat ARCHIVED its Desk and removed the seat
# directory, so a missing file there would be the retirement rather than the sweep.
foreach ($seat in @('idle', 'busy')) {
    foreach ($kind in @('books', 'projects')) {
        $deskFile = Get-DeskFilePath -StateDirectory (Join-Path $w '.claude') -Seat $seat -Kind $kind
        Assert-True (Test-Path -LiteralPath $deskFile -PathType Leaf) "THE SWEEP REMOVED SEAT '$seat''s $kind DESK FILE"
    }
}

# --- 8b. THE DIGEST BINDS THE SWITCH ITSELF, NOT ONLY WHAT IT HAPPENS TO SELECT -----------------
#
# FOUND BY FALSIFICATION, AND IT IS WHY THIS CASE IS SEPARATE FROM CASE 7. There, the two plan_ids
# differ because the sweep adds three topics -- so deleting `all_idle_seats=` from the digest left
# case 7 green while the approval for an ordinary reset became replayable as a sweep on any workspace
# where the sweep happened to add nothing. That workspace is THIS one, now: the sweep above took
# every idle foreign topic, so a second sweep selects exactly what an ordinary reset selects. If the
# switch is bound, the two plans still differ; if it is not, they are the same string.
$afterPlain = Invoke-SweepPreflight $w 'acting'
$afterSweep = Invoke-SweepPreflight $w 'acting' -AllIdleSeats
Assert-Equal '' (Get-Names (Get-Field (Get-Field $afterSweep 'sweep' 'the post-run preflight') 'to_sweep' 'the post-run sweep block')) 'the second sweep still has something to take, so the plan_ids below would differ for the ordinary reason and prove nothing'
Assert-Equal '' ((@(Get-Field $afterPlain 'topics_to_quarantine' 'the post-run plain preflight')) -join ',') 'the post-run plain reset still has a target, so this case is not comparing two empty selections'
Assert-True (([string]$afterPlain.plan_id) -cne ([string]$afterSweep.plan_id)) 'A SWEEP AND AN ORDINARY RESET THAT SELECT THE SAME TOPICS ISSUED THE SAME plan_id, so an approval for one executes the other'

# --- 9. AN UNMAPPED TOPIC STILL STOPS THE RUN ---------------------------------------------------
#
# Its own workspace: the point of this case is that NOTHING moved, and a shared fixture would leave
# the next reader unable to tell a refusal from an earlier case's leftovers.
$u = New-SweepWorkspace 'unmapped'
Add-SweepSeat $u 'acting' 'acting-1'
Add-SweepSeat $u 'idle'   'idle-1'
Add-SweepTopic $u 'acting-one' 'acting' @()
Add-SweepTopic $u 'idle-one'   'idle'   @()
New-Item -ItemType Directory -Path (Join-Path $u 'notebook/nobodys') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $u 'notebook/nobodys/_index.md'), "# nobodys`n", $utf8)
$null = Use-SweepSeat $u 'acting'
$unmappedPlan = Invoke-SweepPreflight $u 'acting' -AllIdleSeats
Assert-True (@(Get-Field $unmappedPlan 'refusals' 'the unmapped preflight').Count -gt 0) 'A SWEEP OVER A NOTEBOOK HOLDING AN UNMAPPED TOPIC WAS PLANNED WITHOUT REFUSAL'
Assert-True ((@($unmappedPlan.refusals) -join ' ') -clike '*nobodys*') "the refusal does not name the unmapped topic: $(@($unmappedPlan.refusals) -join ' ')"
# And it stops the APPLY, not only the preview: a refusal that only the preflight raises is advice.
$unmappedApply = $null
try { Invoke-SweepApply $u 'acting' ([string]$unmappedPlan.plan_id) -AllIdleSeats | Out-Null }
catch { $unmappedApply = [string]$_.Exception.Message }
Assert-True ($null -ne $unmappedApply) 'a sweep ran over a Notebook holding a topic owned by nobody'
Assert-Equal 'acting-one,idle-one,nobodys' (Get-TopicNames $u) 'the refused sweep moved something anyway'

# --- 10. A SEAT THAT BECOMES BUSY AFTER THE PREVIEW STOPS THE RUN -------------------------------
#
# The digest binds the target set WITH its owners, so a seat waking up between the preview and the
# approval changes the selection and the approval no longer describes it. Nothing moves, and the
# reader is sent back to a fresh preflight rather than to a fresh plan_id.
$r = New-SweepWorkspace 'raced'
Add-SweepSeat $r 'acting' 'acting-1'
Add-SweepSeat $r 'idle'   'idle-1'
Add-SweepTopic $r 'acting-one' 'acting' @()
Add-SweepTopic $r 'idle-one'   'idle'   @()
$null = Use-SweepSeat $r 'acting'
$racedPlan = Invoke-SweepPreflight $r 'acting' -AllIdleSeats
Assert-Equal 'idle-one' (Get-Names (Get-Field (Get-Field $racedPlan 'sweep' 'the raced preflight') 'to_sweep' 'the raced sweep block')) 'the raced fixture''s preflight did not plan to take the idle seat''s topic, so the race below has no subject'
# Enter-SeatClaim, not the fixture helper, for the same reason section 2 records: the fixture helper
# would release the acting seat's claim and the apply would then refuse for want of one.
$wakes = Enter-SeatClaim -StateDirectory (Join-Path $r '.claude') -Seat 'idle'
[void]$heldClaims.Add($wakes)
$racedApply = $null
try { Invoke-SweepApply $r 'acting' ([string]$racedPlan.plan_id) -AllIdleSeats | Out-Null }
catch { $racedApply = [string]$_.Exception.Message }
Assert-True ($null -ne $racedApply) 'A SEAT THAT TOOK A SESSION AFTER THE PREVIEW HAD ITS TOPIC SWEPT ANYWAY'
Assert-True ($racedApply -clike '*Rerun the current preflight*') "the raced approval failed without sending the reader back to a preflight: $racedApply"
Assert-Equal 'acting-one,idle-one' (Get-TopicNames $r) 'the refused sweep moved something anyway'

}
catch { $failure = $_ }
finally {
    foreach ($claim in $heldClaims) { Exit-SeatClaim -Claim $claim }
    $env:LIBRARY_SEAT = $savedSeat
    $env:LIBRARY_SEAT_CLAIM = $savedClaim
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($null -ne $failure) {
    if ($Json) { [pscustomobject]@{ suite = 'notebook-sweep'; status = 'fail'; cases = $script:cases; detail = [string]$failure.Exception.Message } | ConvertTo-Json -Depth 4 }
    else { Write-Error ([string]$failure.Exception.Message) -ErrorAction Continue }
    exit 1
}
if ($Json) { [pscustomobject]@{ suite = 'notebook-sweep'; status = 'pass'; cases = $script:cases } | ConvertTo-Json -Depth 4 }
else { "$($script:cases) sweep assertions passed" }
exit 0
