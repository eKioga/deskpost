<#
.SYNOPSIS
    Two seats, real processes: the properties the AST checks cannot prove. Run by
    Invoke-LibraryChecks.ps1 as `desk.two-seat-acceptance`.

.DESCRIPTION
    WHY THIS EXISTS ALONGSIDE `desk.seat-paths-resolve`. That check proves the two Desk filenames
    disappeared from every file but the schema. It cannot prove that every consumer resolves the
    SAME SEAT, and that is the failure Release 2 was built to prevent: a half-migrated Desk leaves a
    Book **open for reading and closed for searching**, because the reader and the search helpers
    resolve the Desk independently. A green static check beside a red one here is exactly that state.

    So this drives the real helpers and the real guards as SEPARATE PROCESSES, against one fixture
    workspace holding two seats, and asserts what a single-seat test cannot see:

      - a Book open at seat A is closed at seat B, for reads AND for search
      - the guards agree with the reader about which seat they are serving
      - a reset at one seat cannot move the other's Notebook topic
      - a cross-seat operation (rename) rewrites EVERY seat that holds the Book
      - a malformed or unknown foreign seat fails closed rather than falling back
      - the migration refuses to overwrite a seat Desk that already differs

    EVERY ASSERTION IS ABOUT DISAGREEMENT BETWEEN TWO CONSUMERS. A property that one process can
    check on its own belongs in that helper's own self-test, not here.
#>
[CmdletBinding()]
param([switch]$Json)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')
. (Join-Path $PSScriptRoot 'SearchBoundaries.ps1')

$script:failures = [Collections.Generic.List[string]]::new()
$script:checks = 0
function Assert([bool]$Condition, [string]$Message) {
    $script:checks++
    if (-not $Condition) { [void]$script:failures.Add($Message) }
}

$repo = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('two-seat-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stateDir = Join-Path $fixture '.claude'
$savedSeat = $env:LIBRARY_SEAT
$savedClaim = $env:LIBRARY_SEAT_CLAIM
$claims = [Collections.Generic.List[object]]::new()
# Section 7's stand-in agent client. Killed in the finally as well as in the case itself: it holds a
# copy of powershell.exe inside the fixture, which cannot be deleted while it runs.
$standIns = [Collections.Generic.List[object]]::new()

try {
    foreach ($relative in @('.claude', 'internal', 'notebook', 'docs', 'shelf/alpha-book/wiki', 'shelf/beta-book/wiki')) {
        New-Item -ItemType Directory -Path (Join-Path $fixture $relative) -Force | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $stateDir '.library-project'), "00000000-0000-0000-0000-000000000000`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $fixture 'notebook/_master-index.md'), "# Notebook`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $fixture 'shelf/_catalog.md'), "# Local Shelf`n", $utf8)
    foreach ($slug in @('alpha-book', 'beta-book')) {
        [IO.File]::WriteAllText((Join-Path $fixture "shelf/$slug/wiki/_index.md"), "# $slug`n`nA page only this seat may read.`n", $utf8)
    }

    # Two seats, each bound to its own project -- the binding is unique in both directions.
    Initialize-SeatForFixture -StateDirectory $stateDir -Seat 'alpha' -Project 'alpha-proj' -OpenBooks @('shelf/alpha-book') | Out-Null
    Initialize-SeatForFixture -StateDirectory $stateDir -Seat 'beta' -Project 'beta-proj' -OpenBooks @('shelf/beta-book') | Out-Null
    Write-SeatRegistry -StateDirectory $stateDir -Registry ([pscustomobject]@{ schema = 1; seats = @(
        [pscustomobject]@{ seat = 'alpha'; project = 'alpha-proj' },
        [pscustomobject]@{ seat = 'beta'; project = 'beta-proj' }) })

    function Invoke-ShelfGuard([string]$Seat, [string]$Relative) {
        $payload = (@{ tool_name = 'Read'; tool_input = @{ file_path = (Join-Path $fixture $Relative) } } | ConvertTo-Json -Compress -Depth 6)
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
        $guard = Join-Path $repo '.claude/hooks/Guard-ShelfBookRead.ps1'
        $out = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $guard -StateDirectory $stateDir `
            -WorkspacePath $fixture -Seat $Seat -InputJsonBase64 $encoded 2>&1 | Out-String)
        -not $out.Contains('"deny"')
    }

    # THE SAME GUARD, IDENTIFYING ITS AGENT RATHER THAN BEING TOLD ITS SEAT. `CLAUDE_PID` is the
    # route every hook and tool child has (step 0b), so this is how a bound session's guard actually
    # resolves -- and section 7 needs it to compare the guard's answer with a live adapter's, which
    # has no such variable and walks its parents instead. The caller sets the variable.
    function Invoke-ShelfGuardAsAgent([string]$Relative) {
        $payload = (@{ tool_name = 'Read'; tool_input = @{ file_path = (Join-Path $fixture $Relative) } } | ConvertTo-Json -Compress -Depth 6)
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
        $guard = Join-Path $repo '.claude/hooks/Guard-ShelfBookRead.ps1'
        $out = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $guard -StateDirectory $stateDir `
            -WorkspacePath $fixture -InputJsonBase64 $encoded 2>&1 | Out-String)
        -not $out.Contains('"deny"')
    }

    # --- 1. THE HALF-MIGRATION FAILURE ITSELF: reading and searching must agree, per seat ----------
    Assert (Invoke-ShelfGuard 'alpha' 'shelf/alpha-book/wiki/_index.md') 'seat alpha was denied its own open Book'
    Assert (-not (Invoke-ShelfGuard 'alpha' 'shelf/beta-book/wiki/_index.md')) "seat alpha could READ a Book only seat beta has open"
    Assert (Invoke-ShelfGuard 'beta' 'shelf/beta-book/wiki/_index.md') 'seat beta was denied its own open Book'
    Assert (-not (Invoke-ShelfGuard 'beta' 'shelf/alpha-book/wiki/_index.md')) "seat beta could READ a Book only seat alpha has open"

    # The SEARCH tier, resolved independently of the guard. This is the exact pair that a partial
    # migration splits: same Book, same moment, one says open and the other says closed.
    $alphaSearchRoots = @(Get-SearchOpenBookRoots -DeskStateDirectory (Get-DeskStateDirectory -StateDirectory $stateDir -Seat 'alpha'))
    $betaSearchRoots = @(Get-SearchOpenBookRoots -DeskStateDirectory (Get-DeskStateDirectory -StateDirectory $stateDir -Seat 'beta'))
    Assert ($alphaSearchRoots -ccontains 'shelf/alpha-book') 'search at seat alpha did not see the Book its guard allows'
    Assert ($alphaSearchRoots -cnotcontains 'shelf/beta-book') 'search at seat alpha saw a Book its guard denies -- open for searching, closed for reading'
    Assert ($betaSearchRoots -ccontains 'shelf/beta-book') 'search at seat beta did not see the Book its guard allows'
    Assert ($betaSearchRoots -cnotcontains 'shelf/alpha-book') 'search at seat beta saw a Book its guard denies'

    # --- 2. An unknown or malformed foreign seat FAILS CLOSED, never falls back --------------------
    Assert (-not (Invoke-ShelfGuard 'nosuchseat' 'shelf/alpha-book/wiki/_index.md')) 'an unknown seat was served a Book instead of failing closed'
    Assert (-not (Invoke-ShelfGuard 'Alpha' 'shelf/alpha-book/wiki/_index.md')) 'a MALFORMED seat name resolved instead of being refused'
    # And an ordinary file is still readable at a seat that does not exist: the Desk gates Books, not
    # the whole workspace. A guard that denied this would brick a seatless session, which it did once.
    Assert (Invoke-ShelfGuard 'nosuchseat' 'docs/anything.md') 'an unknown seat could not read an ordinary file, which the Desk does not gate'

    # --- 3. A reset at one seat cannot move the other's Notebook topic ----------------------------
    foreach ($topic in @('alpha-topic', 'beta-topic')) {
        New-Item -ItemType Directory -Path (Join-Path $fixture "notebook/$topic") -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $fixture "notebook/$topic/_index.md"), "# $topic`n", $utf8)
    }
    Set-NotebookTopicOwner -Workspace $fixture -Topic 'alpha-topic' -Seat 'alpha'
    Set-NotebookTopicOwner -Workspace $fixture -Topic 'beta-topic' -Seat 'beta'

    # Reset selection is a cross-seat read -- it decides which seats count as retired -- so it takes
    # the registry lock the way Reset-LocalNotebook.ps1 does. Falsified first: unlocked must refuse.
    $unlockedSelection = $null
    try { Get-NotebookResetTargets -Workspace $fixture -Seat 'alpha' | Out-Null }
    catch { $unlockedSelection = $_.Exception.Message }
    Assert ($null -ne $unlockedSelection -and $unlockedSelection -clike '*registry/Desk lock*') 'reset selection answered without the registry lock held'

    $selectionLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        $alphaTargets = Get-NotebookResetTargets -Workspace $fixture -Seat 'alpha'
        Assert (@($alphaTargets.targets | ForEach-Object { $_.topic }) -ccontains 'alpha-topic') 'a reset at alpha did not select its own topic'
        Assert (@($alphaTargets.targets | ForEach-Object { $_.topic }) -cnotcontains 'beta-topic') 'A RESET AT ALPHA SELECTED BETA''S TOPIC'
        $wholeTree = Get-NotebookResetTargets -Workspace $fixture -Seat 'alpha' -WholeTree
        Assert (@($wholeTree.refusals).Count -gt 0) 'a whole-tree reset did not refuse a live foreign seat'
        Assert (@($wholeTree.targets | ForEach-Object { $_.topic }) -cnotcontains 'beta-topic') 'a whole-tree reset at alpha targeted a live foreign seat''s topic'
    }
    finally { Exit-BookLock -Lock $selectionLock }

    # --- 3b. A CLAIM AT THIS SEAT IS NOT ENTITLEMENT TO ANOTHER SEAT'S TOPIC (ADR-0019) -----------
    #
    # THE DEFECT THIS COVERS NEEDED NO CONCURRENCY. Until 2026-09-09 the compiler and Triage
    # validated the ACTING seat's claim and never looked at the target topic's owner, so seat beta
    # could add material to alpha's topic and alpha's ordinary reset would quarantine it -- with beta
    # still claimed and still working. The live workspace was in exactly that state.
    #
    # A READ AND AN ASSERTION, and they are different tools: a preflight reports with no lock so it
    # can refuse before issuing a plan, and the apply path asserts under the topic lock so the answer
    # cannot move under the write.
    Assert ((Test-NotebookTopicWritable -Workspace $fixture -Topic 'alpha-topic' -Seat 'alpha').writable) 'a seat could not write into its own topic'
    $foreignVerdict = Test-NotebookTopicWritable -Workspace $fixture -Topic 'beta-topic' -Seat 'alpha'
    Assert (-not $foreignVerdict.writable) 'SEAT ALPHA WAS ALLOWED TO WRITE INTO BETA''S TOPIC'
    Assert ([string]$foreignVerdict.owner -ceq 'beta') "the refusal named owner '$([string]$foreignVerdict.owner)' rather than beta"
    Assert ([string]$foreignVerdict.reason -clike "*seat 'beta'*") "the refusal does not name the owning seat: $([string]$foreignVerdict.reason)"

    # Shared and excluded are WRITABLE by any seat -- that is what those scopes are for -- and the
    # difference from `owned` is the whole reason the check reads the scope rather than the seat.
    New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/common-topic') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'notebook/common-topic/_index.md'), "# common-topic`n", $utf8)
    Set-NotebookTopicOwner -Workspace $fixture -Topic 'common-topic' -Scope 'shared'
    Assert ((Test-NotebookTopicWritable -Workspace $fixture -Topic 'common-topic' -Seat 'alpha').writable) 'a SHARED topic was refused to a seat'
    Assert ((Test-NotebookTopicWritable -Workspace $fixture -Topic 'unmapped-topic' -Seat 'alpha').writable) 'an UNMAPPED topic was refused, which is the reset''s refusal to make and not this one'

    # THE ASSERTION IS LIVE, not merely present: without the topic lock it must refuse, or every
    # writer's gate is a call that would answer anything.
    $unlockedOwnership = $null
    try { Assert-NotebookTopicWritable -Workspace $fixture -Topic 'alpha-topic' -Seat 'alpha' | Out-Null }
    catch { $unlockedOwnership = [string]$_.Exception.Message }
    Assert ($null -ne $unlockedOwnership -and $unlockedOwnership -clike '*lock for notebook/alpha-topic*') "the ownership assertion answered with no topic lock held: $unlockedOwnership"

    $alphaTopicLock = Enter-BookLock -Workspace $fixture -BookRoot (Get-NotebookTopicLockRoot 'alpha-topic')
    try { Assert (Assert-NotebookTopicWritable -Workspace $fixture -Topic 'alpha-topic' -Seat 'alpha') 'the owning seat was refused its own topic under the lock' }
    finally { Exit-BookLock -Lock $alphaTopicLock }

    # A LIVE SEAT'S TOPIC IS NOT REASSIGNABLE, and a dormant one's is. This is the ungated remap the
    # review found: nothing stopped a session taking a live seat's topic and resetting it as its own.
    $betaClaim = Enter-SeatClaim -StateDirectory $stateDir -Seat 'beta'
    [void]$claims.Add($betaClaim)
    $liveRemap = $null
    try { Set-NotebookTopicOwner -Workspace $fixture -Topic 'beta-topic' -Seat 'alpha' -ActingSeat 'alpha' }
    catch { $liveRemap = [string]$_.Exception.Message }
    Assert ($null -ne $liveRemap) 'A LIVE SEAT''S TOPIC WAS REASSIGNED AWAY FROM IT'
    Assert ($liveRemap -clike "*seat 'beta'*" -and $liveRemap -clike '*live session*') "the reassignment refusal did not name the live owner: $liveRemap"
    Assert ([string](Get-NotebookTopicOwner -Owners (Read-NotebookTopicOwners -Workspace $fixture) -Topic 'beta-topic').seat -ceq 'beta') 'the refused reassignment changed the record anyway'

    Exit-SeatClaim -Claim $betaClaim
    $claims.Remove($betaClaim) | Out-Null
    Set-NotebookTopicOwner -Workspace $fixture -Topic 'beta-topic' -Seat 'alpha' -ActingSeat 'alpha'
    Assert ([string](Get-NotebookTopicOwner -Owners (Read-NotebookTopicOwners -Workspace $fixture) -Topic 'beta-topic').seat -ceq 'alpha') 'a DORMANT seat''s topic could not be reassigned, which is the recovery route the reset names'
    Set-NotebookTopicOwner -Workspace $fixture -Topic 'beta-topic' -Seat 'beta'

    # --- 3d. A SWEEP TAKES THE OTHER SEAT'S TOPIC ONLY WHILE IT IS IDLE (ADR-0023) ----------------
    #
    # THE SAME CROSS-SEAT QUESTION SECTION 3 ASKS, ANSWERED THE OTHER WAY ROUND. Section 3 pins that
    # a reset at alpha never reaches beta's topic; -AllIdleSeats is the one operation that may, and
    # the whole safety of it is that "may" is conditional on beta being idle at that moment. Both
    # halves are asserted here, on the same topic, seconds apart -- a suite that only proved the
    # positive would stay green for an implementation that took the topic unconditionally.
    #
    # AND THESE SEATS ARE PRE-IDENTITY. The registry above writes no `seat_id`, so every comparison
    # in the sweep runs against the empty incarnation here, which is a real incarnation and not a
    # missing value. Test-NotebookSweep.ps1 covers the same rules with real ids; neither file covers
    # both, which is why this case is not a duplicate of that suite.
    $sweepLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        $idleSweep = Get-NotebookResetTargets -Workspace $fixture -Seat 'alpha' -AllIdleSeats
        Assert (@($idleSweep.targets | ForEach-Object { $_.topic }) -ccontains 'beta-topic') 'a sweep at alpha did not take the IDLE seat beta''s topic, which is the whole operation'
        Assert (@($idleSweep.swept | ForEach-Object { $_.topic }) -ccontains 'beta-topic') 'the sweep took beta''s topic without recording it as swept, so nothing says whose it was'
        Assert (@($idleSweep.targets | ForEach-Object { $_.topic }) -ccontains 'alpha-topic') 'the sweep stopped taking the acting seat''s own topic'
        Assert (@($idleSweep.targets | ForEach-Object { $_.topic }) -cnotcontains 'common-topic') 'A SWEEP TOOK A SHARED TOPIC, which no seat''s reset takes'
        Assert (@($idleSweep.refusals).Count -eq 0) "a sweep over this fixture refused: $(@($idleSweep.refusals) -join ' ')"

        # AND THE COMBINATION IS REFUSED. -WholeTree is a name that claims completeness; ADR-0023
        # rejected widening it to idle seats by name, so a second flag must not half-silence the
        # refusal that keeps ADR-0016's third case refused.
        $bothFlags = $null
        try { Get-NotebookResetTargets -Workspace $fixture -Seat 'alpha' -WholeTree -AllIdleSeats | Out-Null }
        catch { $bothFlags = [string]$_.Exception.Message }
        Assert ($null -ne $bothFlags) 'A WHOLE-TREE RESET AT ALPHA COMBINED WITH A SWEEP, so -WholeTree can reach an idle foreign seat'
    }
    finally { Exit-BookLock -Lock $sweepLock }

    # THE SAME TOPIC, WITH BETA WORKING. Its claim is taken and released inside this case rather than
    # added to $claims, so the cleanup cannot try to release it twice.
    $sweepBetaClaim = Enter-SeatClaim -StateDirectory $stateDir -Seat 'beta'
    try {
        $busyLock = Enter-SeatRegistryLock -Workspace $fixture
        try {
            $busySweep = Get-NotebookResetTargets -Workspace $fixture -Seat 'alpha' -AllIdleSeats
            Assert (@($busySweep.targets | ForEach-Object { $_.topic }) -cnotcontains 'beta-topic') 'A SWEEP AT ALPHA TOOK THE TOPIC OF A SEAT WITH A LIVE SESSION'
            Assert (@($busySweep.targets | ForEach-Object { $_.topic }) -ccontains 'alpha-topic') 'one busy seat cancelled the sweep of the acting seat''s own topic; a sweep names the busy seat and carries on'
            $betaSkip = @(@($busySweep.skipped) | Where-Object { [string]$_.topic -ceq 'beta-topic' })
            Assert ($betaSkip.Count -eq 1) 'the sweep left beta''s topic without naming it, which is indistinguishable from not seeing the seat at all'
            if ($betaSkip.Count -eq 1) {
                Assert ([string]$betaSkip[0].reason -ceq 'live-session') "beta''s topic was skipped for the wrong reason: $([string]$betaSkip[0].reason)"
                Assert ([string]$betaSkip[0].note -clike '*Wait for that session*') "the skip carries no remedy the preflight can show: $([string]$betaSkip[0].note)"
            }
        }
        finally { Exit-BookLock -Lock $busyLock }
    }
    finally { Exit-SeatClaim -Claim $sweepBetaClaim }

    # --- 3c. AND THE GUARD GIVES THE SAME VERDICT AS THE HELPERS (ruling 1, revised, 2026-09-10) ---
    #
    # THE PROMISE THREE DOCUMENTS MADE AND NOTHING ENFORCED. `CLAUDE.md:38`, `CONTEXT.md` and
    # `docs/seats.md` all say a seatless session changes nothing; the Write/Edit guard judged Shelf
    # paths only, so a plain write into `notebook/` took no claim and checked no ownership.
    #
    # THE FIRST PROPOSAL -- refuse `notebook/` outright -- WOULD HAVE BRICKED THE CORE FLOW, because
    # authoring an article IS a direct write with no helper behind it. So what is asserted here is
    # the pair: the writes that must still work, and the two that must not. Every assertion below
    # names a VALUE, so a guard that denied everything fails the first half rather than passing the
    # second.
    # THE REASON IS DECODED, NOT PATTERN-MATCHED THROUGH JSON. A refusal naming seat 'beta' arrives on
    # the wire as seat 'beta', so the first version of these assertions failed against
    # correct refusals -- reading the escape rather than what a consumer sees.
    function Invoke-WriteGuard([string]$Relative, [string]$Seat = '', [string]$Tool = 'Write') {
        $payload = (@{ tool_name = $Tool; tool_input = @{ file_path = (Join-Path $fixture $Relative); content = 'x' } } | ConvertTo-Json -Compress -Depth 6)
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
        $guard = Join-Path $repo '.claude/hooks/Guard-ShelfBookRead.ps1'
        # NO -Seat AT ALL IS THE SEATLESS CASE, and it is not the same as a seat name nothing knows:
        # 'nosuchseat' is a WELL-FORMED slug, so Resolve-SeatName answers `named` with source
        # `explicit` and the ownership half judges it. The first version of this case passed
        # -Seat nosuchseat and asserted the seatless message, and what it actually exercised was the
        # owned-by-another-seat branch wearing the wrong assertion.
        $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $guard, '-StateDirectory', $stateDir,
            '-WorkspacePath', $fixture, '-InputJsonBase64', $encoded)
        if ($Seat) { $arguments = $arguments + @('-Seat', $Seat) }
        $out = (& powershell.exe @arguments 2>&1 | Out-String)
        $reason = ''
        try { $reason = [string]($out | ConvertFrom-Json).hookSpecificOutput.permissionDecisionReason } catch { }
        [pscustomobject]@{ Allowed = (-not $out.Contains('"deny"')); Reason = $reason; Text = ($out -replace '\s+', ' ') }
    }

    # AUTHORING IS UNTOUCHED, which is the boundary this must not cross. Four writable scopes, and
    # the third of them is a topic that does not exist yet -- creating one is how every article
    # starts, and it must need no ceremony at all.
    Assert ((Invoke-WriteGuard 'notebook/alpha-topic/page.md' 'alpha').Allowed) 'a seat was denied a write into its OWN Notebook topic, which is how an article is authored'
    Assert ((Invoke-WriteGuard 'notebook/common-topic/page.md' 'alpha').Allowed) 'a SHARED topic was denied to a seat'
    Assert ((Invoke-WriteGuard 'notebook/brand-new-topic/page.md' 'alpha').Allowed) 'creating a NEW Notebook topic was denied, which would brick the core authoring flow'
    Assert ((Invoke-WriteGuard 'notebook/_master-index.md' 'alpha').Allowed) 'a loose file directly under notebook/ was refused'
    Assert ((Invoke-WriteGuard 'docs/anything.md' 'alpha').Allowed) 'the notebook rule leaked onto a path outside notebook/'
    Assert ((Invoke-WriteGuard 'notebook/beta-topic/page.md' 'alpha' 'Read').Allowed) 'READING another seat''s Notebook topic was denied; the rule is about writing'

    # AND THE TWO REFUSALS, each naming its own fix.
    $foreignWrite = Invoke-WriteGuard 'notebook/beta-topic/page.md' 'alpha'
    Assert (-not $foreignWrite.Allowed) 'SEAT ALPHA COULD WRITE INTO BETA''S NOTEBOOK TOPIC through a plain Write'
    Assert ($foreignWrite.Reason -clike "*seat 'beta'*") "the guard's refusal did not name the owning seat: $($foreignWrite.Reason)"
    $env:LIBRARY_SEAT = ''
    $seatlessWrite = Invoke-WriteGuard 'notebook/alpha-topic/page.md'
    Assert (-not $seatlessWrite.Allowed) 'a SEATLESS session could write into notebook/, which three documents promise it cannot'
    Assert ($seatlessWrite.Reason -clike '*needs a seat*') "the seatless refusal did not say what is missing: $($seatlessWrite.Reason)"
    Assert ($seatlessWrite.Reason -clike '*Enter-LibrarySeat.ps1*') 'the seatless refusal did not name the fix'
    # A seatless READ of the same path is untouched: the Desk gates Books, not the workspace.
    Assert ((Invoke-WriteGuard 'notebook/alpha-topic/page.md' '' 'Read').Allowed) 'a seatless session was denied a READ of notebook/, which no rule refuses'
    # AND A SEATLESS WRITE OUTSIDE notebook/ IS UNTOUCHED, which is the assertion that makes the
    # `^notebook/` filter observable at all -- without it, deleting that filter left this suite green
    # while the guard refused a seatless session every ordinary edit in the workspace. That is not a
    # hypothetical: this file already denied its own author's edit once, on the first run after it
    # was made seat-aware, for exactly this shape of mistake.
    Assert ((Invoke-WriteGuard 'docs/anything.md').Allowed) 'a seatless session was denied an ordinary write outside notebook/, which no rule refuses'
    $env:LIBRARY_SEAT = $savedSeat

    # apply_patch IS A WRITE TOO. A boundary enforced on one tool and not the other is the way
    # around it -- which is the exact hole this guard was extended to close for the Shelf in 2026-09.
    $patch = "*** Begin Patch`n*** Update File: notebook/beta-topic/page.md`n@@`n-old`n+new`n*** End Patch"
    $patchPayload = (@{ tool_name = 'apply_patch'; cwd = $fixture; tool_input = @{ command = $patch } } | ConvertTo-Json -Compress -Depth 6)
    $patchEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($patchPayload))
    $patchOut = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo '.claude/hooks/Guard-ShelfBookRead.ps1') `
        -StateDirectory $stateDir -WorkspacePath $fixture -Seat 'alpha' -InputJsonBase64 $patchEncoded 2>&1 | Out-String)
    Assert ($patchOut.Contains('"deny"')) 'an apply_patch wrote into another seat''s Notebook topic, which the Write tool is refused'
    $patchReason = ''
    try { $patchReason = [string]($patchOut | ConvertFrom-Json).hookSpecificOutput.permissionDecisionReason } catch { }
    Assert ($patchReason -clike "*seat 'beta'*") "the patch refusal did not name the owning seat: $patchReason"

    # THE QUARANTINE MOVE REFUSES WITHOUT THE TOPIC LOCK, which is what makes its revalidation mean
    # anything. Its own probe topic, because a destructive falsification poisons whatever shares a
    # subject with it.
    New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/probe-topic') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'notebook/probe-topic/_index.md'), "# probe-topic`n", $utf8)
    Set-NotebookTopicOwner -Workspace $fixture -Topic 'probe-topic' -Seat 'alpha'
    $quarantine = Join-Path $fixture 'internal/probe-quarantine'
    New-Item -ItemType Directory -Path $quarantine -Force | Out-Null
    $unlockedMove = $null
    try { Move-NotebookTopicToQuarantine -Workspace $fixture -Topic 'probe-topic' -ExpectedSeat 'alpha' -ExpectedSeatId '' -QuarantineDirectory $quarantine | Out-Null }
    catch { $unlockedMove = [string]$_.Exception.Message }
    Assert ($null -ne $unlockedMove -and $unlockedMove -clike '*lock for notebook/probe-topic*') "a quarantine move answered with no topic lock held: $unlockedMove"
    Assert (Test-Path -LiteralPath (Join-Path $fixture 'notebook/probe-topic') -PathType Container) 'the refused quarantine move took the topic anyway'

    $probeLock = Enter-BookLock -Workspace $fixture -BookRoot (Get-NotebookTopicLockRoot 'probe-topic')
    try {
        # THE INCARNATION IS PART OF THE EXPECTATION SINCE 2026-09-10, and '' is the real value
        # for a fixture seat registered with no seat_id -- not a placeholder. The mismatch case is
        # asserted in seat.lifecycle, which can mint two incarnations of one slug.
        $moved = Move-NotebookTopicToQuarantine -Workspace $fixture -Topic 'probe-topic' -ExpectedSeat 'alpha' -ExpectedSeatId '' -QuarantineDirectory $quarantine
        Assert ([bool]$moved.moved) 'the quarantine move refused its own owner under the lock'
        Assert (Test-Path -LiteralPath (Join-Path $quarantine 'probe-topic') -PathType Container) 'the quarantine move reported success and moved nothing'
    }
    finally { Exit-BookLock -Lock $probeLock }

    # --- 4. A cross-seat operation touches EVERY seat that holds the Book --------------------------
    # Both seats open the same Book, which is the case a single-seat test cannot produce.
    Set-FixtureDeskLines -StateDirectory $stateDir -Seat 'beta' -Kind 'books' -Lines @('shelf/beta-book', 'shelf/alpha-book') | Out-Null

    # THE SCANS REFUSE TO ANSWER WITHOUT THE REGISTRY LOCK since 2026-09-09, so this block takes it
    # the way the real helpers do. Falsified below: the same call outside the lock must throw.
    $unlocked = $null
    try { Get-SeatsHoldingEntry -Workspace $fixture -StateDirectory $stateDir -Kind 'books' -Entry 'shelf/alpha-book' | Out-Null }
    catch { $unlocked = $_.Exception.Message }
    Assert ($null -ne $unlocked -and $unlocked -clike '*registry/Desk lock*') 'a cross-seat scan answered without the registry lock held'

    $crossSeatLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        $holders = @(Get-SeatsHoldingEntry -Workspace $fixture -StateDirectory $stateDir -Kind 'books' -Entry 'shelf/alpha-book')
        Assert (@($holders | Sort-Object) -join ',' -ceq 'alpha,beta') "the cross-seat scan found '$($holders -join ',')' rather than both seats"

        $changed = @(Update-DeskEntryAcrossSeats -Workspace $fixture -StateDirectory $stateDir -Kind 'books' -From 'shelf/alpha-book' -To 'shelf/renamed-book')
        Assert (@($changed | Sort-Object) -join ',' -ceq 'alpha,beta') 'a rename did not rewrite every seat holding the Book'
        $stragglers = @(Get-SeatsHoldingEntry -Workspace $fixture -StateDirectory $stateDir -Kind 'books' -Entry 'shelf/alpha-book')
        Assert ($stragglers.Count -eq 0) "these seats were left pointing at the old root: $($stragglers -join ', ')"

        # The single-seat writer the deletion path uses, proved under the same lock: add is
        # idempotent, remove takes exactly one entry, and neither touches the other seat.
        Assert (-not (Set-DeskEntryForSeat -Workspace $fixture -StateDirectory $stateDir -Seat 'beta' -Kind 'books' -Entry 'shelf/beta-book' -Action 'Add')) 'adding a Desk entry that was already there reported a change'
        Assert (Set-DeskEntryForSeat -Workspace $fixture -StateDirectory $stateDir -Seat 'beta' -Kind 'books' -Entry 'shelf/beta-book' -Action 'Remove') 'removing a present Desk entry reported no change'
        $betaLines = @(Get-Content -LiteralPath (Get-DeskFilePath -StateDirectory $stateDir -Seat 'beta' -Kind 'books'))
        Assert ($betaLines -cnotcontains 'shelf/beta-book') 'the single-seat remove left the entry behind'
        Assert ($betaLines -ccontains 'shelf/renamed-book') 'the single-seat remove took an entry it was not given'
        $alphaLines = @(Get-Content -LiteralPath (Get-DeskFilePath -StateDirectory $stateDir -Seat 'alpha' -Kind 'books'))
        Assert ($alphaLines -ccontains 'shelf/renamed-book') 'the single-seat remove reached another seat''s Desk'
        Set-DeskEntryForSeat -Workspace $fixture -StateDirectory $stateDir -Seat 'beta' -Kind 'books' -Entry 'shelf/beta-book' -Action 'Add' | Out-Null
    }
    finally { Exit-BookLock -Lock $crossSeatLock }
    # The rewritten root must be present at BOTH, not merely absent at one.
    foreach ($seat in @('alpha', 'beta')) {
        $lines = @(Get-Content -LiteralPath (Get-DeskFilePath -StateDirectory $stateDir -Seat $seat -Kind 'books'))
        Assert ($lines -ccontains 'shelf/renamed-book') "seat $seat lost the Book instead of having its root rewritten"
    }

    # --- 5. Migration refuses a destination that exists and DIFFERS -------------------------------
    $legacyFixture = Join-Path ([IO.Path]::GetTempPath()) ('two-seat-legacy-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $legacyState = Join-Path $legacyFixture '.claude'
    New-Item -ItemType Directory -Path $legacyState -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $legacyFixture 'internal') -Force | Out-Null
    Initialize-SeatForFixture -StateDirectory $legacyState -Seat 'alpha' -Project 'alpha-proj' -OpenBooks @('shelf/one') | Out-Null
    [IO.File]::WriteAllText((Get-DeskFileInDirectory -DeskDirectory $legacyState -Kind 'books'), "shelf/two`n", $utf8)
    [IO.File]::WriteAllText((Get-DeskFileInDirectory -DeskDirectory $legacyState -Kind 'projects'), '', $utf8)
    $refused = $false
    try { Invoke-DeskMigration -StateDirectory $legacyState -Seat 'alpha' | Out-Null }
    catch { $refused = $true }
    Assert $refused 'the migration OVERWROTE a seat Desk that already existed and differed'
    Remove-Item -LiteralPath $legacyFixture -Recurse -Force -ErrorAction SilentlyContinue

    # --- 6. One session per seat, and the claim is what says so ------------------------------------
    $claim = Enter-SeatClaim -StateDirectory $stateDir -Seat 'alpha'
    [void]$claims.Add($claim)
    Assert (Test-SeatClaim -StateDirectory $stateDir -Seat 'alpha') 'a held claim did not read as live'
    Assert (-not (Test-SeatClaim -StateDirectory $stateDir -Seat 'beta')) 'an unheld seat read as live'
    $secondRefused = $false
    try { Enter-SeatClaim -StateDirectory $stateDir -Seat 'alpha' | Out-Null } catch { $secondRefused = $true }
    Assert $secondRefused 'a SECOND session was allowed to claim a seat that was already held'
    # The token check must accept the holder and refuse everyone else.
    Assert (Assert-SeatClaimHeld -StateDirectory $stateDir -Seat 'alpha' -Token $claim.token) 'the holder was refused its own seat'
    $wrongToken = $false
    try { Assert-SeatClaimHeld -StateDirectory $stateDir -Seat 'alpha' -Token ('0' * 32) | Out-Null } catch { $wrongToken = $true }
    Assert $wrongToken 'a session with the wrong token was accepted as the seat holder'

    # --- 7. AN ALREADY-RUNNING ADAPTER ATTACHES TO A SEAT BOUND AFTER IT STARTED (step 11) --------
    #
    # THE CLOSING EVIDENCE FOR THE BLOCKER, and it belongs here rather than in seat.lifecycle for the
    # reason at the top of this file: every assertion is about two CONSUMERS agreeing. The guard
    # identifies its agent from `CLAUDE_PID`, which every hook and tool child carries; the adapter has
    # no such variable -- measured in step 0b -- and identifies the same agent by walking its own
    # parents. A session where those two disagree is a Desk open for the guard and closed for the
    # reader, which is exactly what ADR-0015 refuses to ship and exactly what was live on 2026-09-10.
    #
    # A REAL ADAPTER PROCESS, NOT A FIXTURE, and the ordering is the point: it is started with no
    # binding anywhere, refused, and only THEN is the seat bound. A startup-cached resolution passes
    # the first request and fails the second, which is the defect this closes.
    #
    # THE STAND-IN CLIENT IS A COPY OF powershell.exe NAMED claude.exe, so the detector matches for
    # the real reason -- a process whose image name genuinely is a client's. Nothing here tells the
    # resolver what to look for.
    $standInDir = Join-Path $fixture 'bin'
    New-Item -ItemType Directory -Path $standInDir -Force | Out-Null
    $realPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $standInExe = Join-Path $standInDir 'claude.exe'
    Copy-Item -LiteralPath $realPowerShell -Destination $standInExe -Force
    $driverDir = Join-Path $fixture 'adapter-drive'
    New-Item -ItemType Directory -Path $driverDir -Force | Out-Null
    $driverScript = Join-Path $fixture 'drive-adapter.ps1'

    # The closing delimiter of a here-string must sit at column 0 even inside an indented block.
    [IO.File]::WriteAllText($driverScript, @'
# Driven ONLY by desk.two-seat-acceptance section 7. It runs as the stand-in agent client, so the
# adapter it starts has this process for a parent -- which is the whole point, and is why the
# conversation is held here instead of in the suite: a suite cannot make itself the parent.
param([string]$Adapter, [string]$StateDirectory, [string]$OutDir)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
# NEITHER IDENTITY VARIABLE, which is what a real MCP server has: CLAUDE_PID does not reach one
# (step 0b) and the agent button sets no LIBRARY_SEAT. Clearing them makes the ancestry walk the
# only route the adapter has, so a pass here cannot be the environment answering.
# LIBRARY_SEAT CLEARED, CLAUDE_PID DELIBERATELY LEFT ALONE. A real MCP server is given no CLAUDE_PID
# of its own, but it INHERITS whatever the client had -- and the suite has planted a value here that
# names a different seat's agent. Clearing it would have hidden exactly the confusion this proves the
# adapter ignores.
$env:LIBRARY_SEAT = ''
$psi = New-Object System.Diagnostics.ProcessStartInfo
# The REAL powershell.exe, never this process's own image: launching the adapter through the
# claude.exe copy would make the ADAPTER the nearest client and prove nothing about the walk.
$psi.FileName = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
$psi.Arguments = ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -StateDirectory "{1}"' -f $Adapter, $StateDirectory)
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.WorkingDirectory = (Split-Path -Parent $Adapter)
$adapterProcess = [System.Diagnostics.Process]::Start($psi)
# Drained continuously. The adapter prints a launch warning when a fixture workspace registers no
# hooks, and an unread stderr pipe would eventually block it mid-response.
$drain = $adapterProcess.StandardError.ReadToEndAsync()
try {
    $adapterProcess.StandardInput.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
    $adapterProcess.StandardInput.Flush()
    $handshake = $adapterProcess.StandardOutput.ReadLine()
    [IO.File]::WriteAllText((Join-Path $OutDir 'init.json'), [string]$handshake, $utf8)
    $step = 0
    while ($true) {
        if (Test-Path -LiteralPath (Join-Path $OutDir 'stop')) { break }
        $step++
        $requestPath = Join-Path $OutDir ('req-' + $step + '.json')
        $deadline = [DateTime]::UtcNow.AddSeconds(90)
        while (-not (Test-Path -LiteralPath $requestPath -PathType Leaf) -and [DateTime]::UtcNow -lt $deadline) {
            if (Test-Path -LiteralPath (Join-Path $OutDir 'stop')) { break }
            Start-Sleep -Milliseconds 50
        }
        if (-not (Test-Path -LiteralPath $requestPath -PathType Leaf)) { break }
        $line = ([IO.File]::ReadAllText($requestPath)).Trim()
        $adapterProcess.StandardInput.WriteLine($line)
        $adapterProcess.StandardInput.Flush()
        $response = $adapterProcess.StandardOutput.ReadLine()
        [IO.File]::WriteAllText((Join-Path $OutDir ('resp-' + $step + '.json')), [string]$response, $utf8)
    }
}
finally {
    try { $adapterProcess.StandardInput.Close() } catch { }
    try { [void]$adapterProcess.WaitForExit(5000) } catch { }
    try { if (-not $adapterProcess.HasExited) { $adapterProcess.Kill() } } catch { }
    try { [IO.File]::WriteAllText((Join-Path $OutDir 'stderr.txt'), [string]$drain.Result, $utf8) } catch { }
    [IO.File]::WriteAllText((Join-Path $OutDir 'done.txt'), 'done', $utf8)
}
'@, $utf8)

    function Wait-DriverFile([string]$Name, [int]$Seconds = 90) {
        $path = Join-Path $driverDir $Name
        $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                # Written whole by WriteAllText, but the directory entry can be seen before the bytes
                # land, so a blank read is "not yet" rather than an empty response.
                $raw = ''
                try { $raw = [IO.File]::ReadAllText($path) } catch { $raw = '' }
                if (-not [string]::IsNullOrWhiteSpace($raw)) { return $raw }
            }
            Start-Sleep -Milliseconds 100
        }
        ''
    }

    function Read-AdapterAnswer([string]$Raw) {
        $answer = [pscustomobject]@{ error_message = ''; text = '' }
        if ([string]::IsNullOrWhiteSpace($Raw)) { return $answer }
        $parsed = $null
        try { $parsed = $Raw | ConvertFrom-Json } catch { return $answer }
        $names = @($parsed.PSObject.Properties | ForEach-Object { $_.Name })
        if ($names -ccontains 'error' -and $null -ne $parsed.error) {
            $errorNames = @($parsed.error.PSObject.Properties | ForEach-Object { $_.Name })
            if ($errorNames -ccontains 'message') { $answer.error_message = [string]$parsed.error.message }
        }
        if ($names -ccontains 'result' -and $null -ne $parsed.result) {
            $resultNames = @($parsed.result.PSObject.Properties | ForEach-Object { $_.Name })
            if ($resultNames -ccontains 'content') {
                $blocks = @(@($parsed.result.content) | Where-Object { $null -ne $_ })
                # A REFUSAL IS A RESULT ON THIS ADAPTER, not a JSON-RPC error: New-McpError returns
                # one text block with isError set, so reading only the `error` member would have
                # scored every refusal as a blank answer -- which is what the first run of this case
                # did, and why the parser splits on the flag the adapter actually sets.
                $failed = ($resultNames -ccontains 'isError') -and [bool]$parsed.result.isError
                if ($blocks.Count -ge 1) {
                    if ($failed) { $answer.error_message = [string]$blocks[0].text }
                    else { $answer.text = [string]$blocks[0].text }
                }
            }
        }
        $answer
    }

    function Send-AdapterRequest([int]$Step, [string]$Json) {
        [IO.File]::WriteAllText((Join-Path $driverDir ('req-' + $Step + '.json')), $Json, $utf8)
        Read-AdapterAnswer (Wait-DriverFile ('resp-' + $Step + '.json'))
    }

    # ITS OWN SEAT AND ITS OWN BOOK, because section 4 renames shelf/alpha-book on both Desks: a case
    # reusing alpha would be asking a live adapter for a Book no Desk names any more and calling the
    # refusal a seat problem. seat beta keeps shelf/beta-book, which is the foreign Book below.
    New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/gamma-book/wiki') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'shelf/gamma-book/wiki/_index.md'), "# gamma-book`n`nA page only the attaching seat may read.`n", $utf8)
    Initialize-SeatForFixture -StateDirectory $stateDir -Seat 'gamma' -Project 'gamma-proj' -OpenBooks @('shelf/gamma-book') | Out-Null
    $gammaPageBody = [IO.File]::ReadAllText((Join-Path $fixture 'shelf/gamma-book/wiki/_index.md'))
    $readGamma = '{"jsonrpc":"2.0","id":%ID%,"method":"tools/call","params":{"name":"read_open_book_page","arguments":{"slug":"gamma-book","page":"_index"}}}'
    $readBeta = '{"jsonrpc":"2.0","id":%ID%,"method":"tools/call","params":{"name":"read_open_book_page","arguments":{"slug":"beta-book","page":"_index"}}}'

    # THE DECOY, AND IT IS THE POINT OF THIS HALF. `CLAUDE_PID` is set by an agent for its own
    # children and INHERITED by everything they spawn, so an adapter can see a perfectly valid value
    # belonging to another agent -- a Library-delegated `codex exec` hands the Claude session's value
    # to the reader Codex launches. Seat beta is bound to THIS process here, and the stand-in and its
    # adapter inherit `CLAUDE_PID` naming it. An adapter that consulted the environment would serve
    # beta's Desk; it must serve the seat its own ancestry names. A plausible live value where the
    # wrong code looks, rather than an absence.
    $savedClaudePid = $env:CLAUDE_PID
    $decoyIdentity = [string](Get-AgentProcessIdentity -ProcessId $PID)
    $decoyLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat 'beta' `
            -AgentProcessId $PID -AgentStartUtc $decoyIdentity -SessionId 'conv-decoy' -State 'committed' | Out-Null
    }
    finally { Exit-BookLock -Lock $decoyLock }
    $env:LIBRARY_SEAT = ''
    # THE CONTROL FOR THE DECOY: it must really resolve a seat, or "the adapter ignored it" is true
    # of a value that named nothing.
    $decoyResolution = Resolve-SeatName -StateDirectory $stateDir -AgentProcessId $PID
    Assert ([string]$decoyResolution.seat -ceq 'beta' -and [string]$decoyResolution.source -ceq 'binding') "the decoy binding does not resolve, so the adapter ignoring CLAUDE_PID proves nothing: $([string]$decoyResolution.status)/$([string]$decoyResolution.seat)"
    $env:CLAUDE_PID = [string]$PID
    $standIn = $null
    try {
        $standIn = Start-Process -FilePath $standInExe -PassThru -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $driverScript,
            '-Adapter', (Join-Path $repo '.claude/adapters/Validated-BookReader.ps1'),
            '-StateDirectory', $stateDir, '-OutDir', $driverDir)
        [void]$standIns.Add($standIn)
        Assert (-not [string]::IsNullOrWhiteSpace((Wait-DriverFile 'init.json'))) 'the stand-in client never brought a real adapter up, so nothing below tests what it claims to'

        # THE GUARD'S OWN ROUTE, BEFORE THE BINDING EXISTS. Both consumers must refuse: this is the
        # control that makes the pair of allows after the bind mean something. The guard is a hook
        # child, so `CLAUDE_PID` is its own agent and is the route it is SUPPOSED to take.
        $env:CLAUDE_PID = [string]$standIn.Id
        $guardBeforeBind = Invoke-ShelfGuardAsAgent 'shelf/gamma-book/wiki/_index.md'
        $env:CLAUDE_PID = [string]$PID
        Assert (-not $guardBeforeBind) 'the guard served an open Book to a session with no seat at all'

        $beforeBind = Send-AdapterRequest 1 ($readGamma -replace '%ID%', '11')
        # DERIVED, NOT COPIED, and the CLAUSE is the assertion: the resolver words "this agent process
        # holds no seat binding" only when it IDENTIFIED an agent, and "not recognised as an agent tool
        # child" when it could not. A walk that found nothing would refuse with the other sentence and
        # this case would go red -- which is what makes it a test of the ancestry route rather than of
        # the refusal.
        $expectedSeatless = [string](Resolve-SeatName -StateDirectory $stateDir -AgentProcessId $standIn.Id).message
        Assert ($beforeBind.error_message.Contains($expectedSeatless)) "an unbound adapter's refusal was not the resolver's own seatless message: $($beforeBind.error_message)"
        # AND THE DECOY WAS NOT TAKEN. An adapter reading the inherited CLAUDE_PID would have resolved
        # seat beta and answered "Book 'gamma-book' is closed" instead -- a refusal for the wrong
        # reason, at the wrong Desk, which no reader could tell apart from this one.
        Assert (-not $beforeBind.error_message.Contains('is closed')) "the adapter resolved a seat from an INHERITED CLAUDE_PID naming another agent: $($beforeBind.error_message)"
        Assert ($beforeBind.error_message.Contains('This agent process holds no seat binding')) "the adapter did not identify its own agent client by ancestry: $($beforeBind.error_message)"

        # THE BINDING, WRITTEN WHILE THE ADAPTER IS ALREADY SERVING. Its agent is the stand-in client,
        # which is the process the adapter's walk found.
        $standInIdentity = [string](Get-AgentProcessIdentity -ProcessId $standIn.Id)
        Assert (-not [string]::IsNullOrWhiteSpace($standInIdentity) -and $standInIdentity -cne 'unreadable') 'the stand-in client has no readable start time, so the binding below would not verify identity'
        $bindLock = Enter-SeatRegistryLock -Workspace $fixture
        try {
            Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat 'gamma' `
                -AgentProcessId $standIn.Id -AgentStartUtc $standInIdentity -SessionId 'conv-attach' -State 'committed' | Out-Null
        }
        finally { Exit-BookLock -Lock $bindLock }

        # THE ATTACHMENT ITSELF: the same request, the same process, no restart.
        $afterBind = Send-AdapterRequest 2 ($readGamma -replace '%ID%', '12')
        Assert ($afterBind.text -ceq $gammaPageBody) "an already-running adapter did not attach to a seat bound after it started: error '$($afterBind.error_message)'"
        # AND IT IS gamma's DESK, not merely some Desk. A resolution that answered any seat at all
        # would pass the line above.
        $afterBindForeign = Send-AdapterRequest 3 ($readBeta -replace '%ID%', '13')
        Assert ($afterBindForeign.error_message.Contains("Book 'beta-book' is closed")) "the attached adapter read a Book only seat beta has open: $($afterBindForeign.error_message) / $($afterBindForeign.text)"

        # THE AGREEMENT, WHICH IS WHAT THIS SUITE IS FOR. The guard resolves the same binding from
        # CLAUDE_PID, the route a hook child actually has, and reaches the same verdict on both Books
        # as the adapter did from its parent chain.
        $env:CLAUDE_PID = [string]$standIn.Id
        $guardOwnBook = Invoke-ShelfGuardAsAgent 'shelf/gamma-book/wiki/_index.md'
        $guardForeignBook = Invoke-ShelfGuardAsAgent 'shelf/beta-book/wiki/_index.md'
        $env:CLAUDE_PID = [string]$PID
        Assert $guardOwnBook 'the guard denied the Book the live adapter had just served from the same binding'
        Assert (-not $guardForeignBook) 'the guard allowed a Book the live adapter reported closed -- open for reading, closed for the guard'
    }
    finally {
        $env:CLAUDE_PID = $savedClaudePid
        [IO.File]::WriteAllText((Join-Path $driverDir 'stop'), 'stop', $utf8)
        if ($null -ne $standIn) {
            try { [void]$standIn.WaitForExit(10000) } catch { }
            try { Stop-Process -Id $standIn.Id -Force -ErrorAction SilentlyContinue } catch { }
        }
    }
}
finally {
    foreach ($claim in $claims) { Exit-SeatClaim -Claim $claim }
    foreach ($stray in $standIns) {
        try { Stop-Process -Id $stray.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
    $env:LIBRARY_SEAT = $savedSeat
    $env:LIBRARY_SEAT_CLAIM = $savedClaim
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($script:failures.Count) {
    [Console]::Error.WriteLine("two-seat acceptance: $($script:failures.Count) of $($script:checks) check(s) FAILED")
    foreach ($failure in $script:failures) { [Console]::Error.WriteLine("  - $failure") }
    exit 1
}
"two seats, $($script:checks) cross-seat check(s): reads and search agree per seat, reset and rename respect every seat, and a live adapter attaches to a seat bound while it runs"
