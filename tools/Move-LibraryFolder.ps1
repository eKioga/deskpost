<#
.SYNOPSIS
    Move one folder to a new path under the cutover protocol: a maintenance barrier, a hashed
    preflight bound to a plan_id, a verified copy taken under the barrier, rename-aside instead of
    delete, pointer updates with readback, a final source-to-destination verification, a rollback
    checkpoint, and a journal under `internal/`.

.DESCRIPTION
    THE PROTOCOL THIS IMPLEMENTS is PLAN-public-release.md step 6, and every clause of it is there
    because a simpler move loses work in a way that looks like success.

      (a) THE BARRIER GOES UP FIRST. Round 2 of Codex review found what a hashed copy alone cannot
          close: a writer can change the source AFTER its copy was verified, finish, and leave no
          lock behind, so an idleness check at the end sees a quiet tree and the destination
          silently lacks that writer's completed work. Nothing here observes that the Library is
          idle -- it STOPS it, then looks.

      (b) THE BLOCKER SCAN RUNS AFTER THE BARRIER IS UP, NOT BEFORE, and that order is the point.
          Checked first, a seat could be claimed in the gap between the check and the barrier;
          checked second, the launchers are already refusing, so the answer cannot go stale while
          it is being read. A run blocked this way lifts its own barrier and refuses.

      (c) THE PLAN_ID IS RE-DERIVED UNDER THE BARRIER and compared to the approved one. The
          preflight ran in an open Library, so anything that changed between the reader's approval
          and the barrier turns the id and refuses -- which is the only way an approval can mean
          the bytes the reader was shown.

      (d) THE COPY IS VERIFIED BY READBACK, file by file, against the inventory taken in (c).

      (e) THE SOURCE IS RENAMED ASIDE, NEVER DELETED. `Remove-Item -Recurse` on the reader's own
          material at the end of a cutover is the one irreversible step in the protocol, so it is
          not in the protocol: the aside copy is deleted later by the archive purge of step 8,
          which is its own gated operation with its own approval.

      (f) EVERY POINTER IS REWRITTEN AND READ BACK, byte for byte against the text this helper
          computed. A pointer left behind is how a cutover reports success and leaves the reader's
          tools opening a folder that has moved.

      (g) THE FINAL VERIFICATION COMPARES THE ASIDE COPY TO THE DESTINATION -- source against
          destination, after the cutover, which is a different question from (d). (d) proves the
          copy matched the inventory; this proves it matches what the source actually turned out
          to be.

      (h) THE ROLLBACK CHECKPOINT IS EXECUTABLE, not a note. `-Action Rollback -RunId <id>` puts
          the aside copy back, restores every pointer from its journalled prior bytes, and removes
          the destination -- and refuses if the destination has changed since the move, because a
          destination somebody has written to is no longer a copy this run may delete.

      (i) THE BARRIER COMES DOWN in a `finally`, so a failure mid-run does not leave the Library
          stopped by accident. A failure that leaves real work half-done is journalled first.

    WHAT IT DOES NOT DO. It never deletes the aside copy, never touches a path inside `D:\2nd_b` or
    `D:\2nd_b-stratch` -- it has no opinion about those, it simply moves what it is pointed at --
    and never guesses a pointer. Every file rewritten is one the reader named on the command line
    and saw in the preflight.

    WHY POINTER REWRITING IS CONSERVATIVE. The rewrite matches the source path in three spellings
    (native `D:\x`, forward-slash `D:/x`, JSON-escaped `D:\\x`) and only where the next character
    cannot extend the path -- end of text, a separator, or a character no Windows path component may
    contain. So `D:\Library-DSH` is NOT rewritten when `D:\Library` moves, which is the whole reason
    for the rule; and `D:\Library` followed by a space in prose is not rewritten either, because
    `D:\Library Backup` would otherwise become a folder nobody named. Those are counted as
    `ambiguous_occurrences`, listed with their line numbers in the preflight, bound into the
    plan_id, and left for the reader. Under-rewriting is visible; over-rewriting is not.

.EXAMPLE
    tools/Move-LibraryFolder.ps1 -Action Status
.EXAMPLE
    tools/Move-LibraryFolder.ps1 -SourcePath D:\librarian-v2 -DestinationPath D:\deskpost\prompts\repo -PointerPath D:\deskpost\prompts\repo\AGENTS.md -Preflight
.EXAMPLE
    tools/Move-LibraryFolder.ps1 -Action Rollback -RunId move-20260919-1a2b3c4d -Preflight
#>
[CmdletBinding()]
param(
    [ValidateSet('Move', 'Rollback', 'LiftBarrier', 'Status')][string]$Action = 'Move',
    [string]$SourcePath,
    [string]$DestinationPath,
    # The files that name the source path and must name the destination afterwards: the identity,
    # configuration and pointer inventory of step 6(c), kept apart from the material on purpose.
    # Nothing is discovered; a pointer this run does not rewrite is one the reader did not name.
    [string[]]$PointerPath = @(),
    # Where the source is renamed to. Defaults beside it, stamped, so the aside copy is obvious in
    # a directory listing and cannot collide with a second run.
    [string]$AsidePath = '',
    [string]$RunId = '',
    [string]$Reason = '',
    [string]$WorkspacePath,
    # THE OPERATOR'S OWN SEAT, taken from the environment HERE and nowhere else. The blocker scan
    # below must never read `$env:` itself: a guard that resolves its own identity deep inside its
    # decision is one nothing can drive a fixture through, which is precisely how the gap this
    # parameter closes survived S2's suite. Fixtures pass these explicitly; a real session inherits
    # them from Start-LibrarySeat.ps1, the only thing that ever sets LIBRARY_SEAT_CLAIM.
    [string]$OperatorSeat = [string]$env:LIBRARY_SEAT,
    [string]$OperatorClaimToken = [string]$env:LIBRARY_SEAT_CLAIM,
    [int]$OperatorAgentProcessId = -1,
    [switch]$Preflight,
    [switch]$UserConfirmed,
    [string]$ApprovedPlanId,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'AtomicFile.ps1')
# BookWriteGuard for the Book-lock directory and the stale threshold, LibrarySeat for the registry
# and the claim states. Both are READ here and neither is taken: the barrier is not a lock and joins
# no lock order, so acquiring one to raise it would put this operation into an ordering it has no
# place in.
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'MaintenanceBarrier.ps1')

$script:MoveJournalSchema = 1
$script:MoveJournalFolder = 'move-journals'
# The characters that may follow a matched path without extending it. A Windows path component may
# not contain any of them, so a match followed by one of these -- or by nothing at all -- is the
# whole path rather than a prefix of a longer one.
$script:PointerBoundaryClass = '\\/"''<>|*?\r\n\t'

function Get-TextDigest([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text))) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-BytesDigest([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash($Bytes)) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function ConvertTo-ComparablePath([string]$Path) {
    <#
    .SYNOPSIS
        A full path with no trailing separator, for comparison and for spelling. Works on a path
        that does not exist yet, which Resolve-Path does not.
    #>
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A path is required.' }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.Length -gt 3) { $full = $full.TrimEnd([char]'\', [char]'/') }
    $full
}

function Test-PathWithin([string]$Child, [string]$Container) {
    <# Is $Child the same as, or inside, $Container? Boundary-aware: D:\Library-DSH is not inside D:\Library. #>
    $c = ConvertTo-ComparablePath $Child
    $p = ConvertTo-ComparablePath $Container
    if ($c.Equals($p, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    $c.StartsWith(($p + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)
}

# --- The source inventory -------------------------------------------------------------------------

function Get-FolderInventory {
    <#
    .SYNOPSIS
        Every file under a root with its hash and length, every directory, and a refusal on any
        reparse point.

    .DESCRIPTION
        WALKED BY HAND RATHER THAN WITH -Recurse. `AllDirectories` follows a junction, so a tree
        holding one would be copied through it -- silently duplicating whatever it points at, or
        recursing until the path length refuses. A cutover must not discover that at the copy step,
        so a reparse point is refused here, before a plan_id is ever issued.

        EMPTY DIRECTORIES ARE CARRIED. A file list alone reconstructs a tree with the empty ones
        missing, and `internal/` is full of directories that are legitimately empty between runs.
    #>
    param([Parameter(Mandatory = $true)][string]$Root)
    $root = ConvertTo-ComparablePath $Root
    $prefixLength = $root.Length + 1
    $files = [Collections.Generic.List[object]]::new()
    $directories = [Collections.Generic.List[string]]::new()
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($root)
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        foreach ($child in @([IO.Directory]::GetDirectories($current))) {
            $info = [IO.DirectoryInfo]::new($child)
            if (([int]$info.Attributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw ("$child is a reparse point (a junction or symbolic link). A cutover refuses to copy through one: " +
                       'it would either duplicate whatever it points at or walk somewhere outside the tree being moved. ' +
                       'Resolve it by hand and rerun the preflight.')
            }
            [void]$directories.Add($child.Substring($prefixLength).Replace('\', '/'))
            $pending.Push($child)
        }
        foreach ($child in @([IO.Directory]::GetFiles($current))) {
            $info = [IO.FileInfo]::new($child)
            if (([int]$info.Attributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$child is a reparse point (a hard or symbolic link). A cutover refuses to copy through one; resolve it by hand and rerun the preflight."
            }
            [void]$files.Add([pscustomobject]@{
                relative = ($child.Substring($prefixLength).Replace('\', '/'))
                sha256   = (Get-FileSha256 $child)
                length   = [long]$info.Length
            })
        }
    }
    [pscustomobject]@{
        files       = @(@($files) | Sort-Object -Property relative)
        directories = @(@($directories) | Sort-Object)
        byte_count  = [long](@($files) | Measure-Object -Property length -Sum).Sum
    }
}

# --- Pointers ---------------------------------------------------------------------------------------

function Get-PathSpellings([string]$Path) {
    <# The three ways a Windows path is written in the files that point at one. #>
    $native = ConvertTo-ComparablePath $Path
    [pscustomobject]@{
        native  = $native
        forward = $native.Replace('\', '/')
        json    = $native.Replace('\', '\\')
    }
}

function New-PointerMatchers {
    <#
    .SYNOPSIS
        Two regexes over one alternation: every occurrence, and the ones safe to rewrite.

    .DESCRIPTION
        CASE-INSENSITIVE ON PURPOSE, AND THIS IS NOT DEFECT FAMILY 1. That family is about a rule
        spelled in lowercase being applied to data that is not; here the data is a WINDOWS PATH,
        where `D:\library` and `D:\Library` name the same folder, and a case-sensitive rewrite would
        leave half the pointers behind. The option is passed explicitly rather than inherited from
        `-match`, so the intent is visible at the call site.
    #>
    param([Parameter(Mandatory = $true)][object]$Spellings)
    $forms = @(
        [pscustomobject]@{ name = 'json'; text = $Spellings.json },
        [pscustomobject]@{ name = 'native'; text = $Spellings.native },
        [pscustomobject]@{ name = 'forward'; text = $Spellings.forward }
    )
    # Longest first: two forms cannot match at one position, but ordering by length keeps that true
    # for any future spelling rather than by accident of today's three.
    $ordered = @(@($forms) | Sort-Object -Property @{ Expression = { $_.text.Length } } -Descending)
    $alternation = (@($ordered) | ForEach-Object { '(?<' + $_.name + '>' + [regex]::Escape($_.text) + ')' }) -join '|'
    $core = '(?:' + $alternation + ')'
    [pscustomobject]@{
        all        = [regex]::new($core, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        rewritable = [regex]::new(($core + '(?![^' + $script:PointerBoundaryClass + '])'), [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }
}

function Get-LineNumber([string]$Text, [int]$Index) {
    if ($Index -le 0) { return 1 }
    ([regex]::Matches($Text.Substring(0, $Index), "`n")).Count + 1
}

function Read-PointerFile {
    <#
    .SYNOPSIS
        A pointer file's bytes, its text, and whether it carried a BOM.

    .DESCRIPTION
        BOM PRESENCE IS PRESERVED RATHER THAN NORMALISED. `Get-Content -Raw` in Windows PowerShell
        5.1 reads a BOM-less file as ANSI and `Set-Content -Encoding utf8` adds a BOM that was not
        there, and a cutover that quietly re-encoded every configuration file it touched would be
        a diff nobody asked for on top of a move. Decoding THROWS on invalid UTF-8, so a binary or
        ANSI file is refused as a pointer instead of being mangled into one.
    #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $bytes = [byte[]](Read-AtomicBytes -Path $Path)
    $hasBom = ($bytes.Count -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $body = if ($hasBom) { $bytes[3..($bytes.Count - 1)] } else { $bytes }
    $text = $null
    try { $text = [Text.UTF8Encoding]::new($false, $true).GetString([byte[]]$body) }
    catch {
        throw ("$Path is not valid UTF-8, so it cannot be rewritten as a pointer file without corrupting it: " +
               "$($_.Exception.Message). Update it by hand and leave it out of -PointerPath.")
    }
    [pscustomobject]@{ bytes = [byte[]]$bytes; text = $text; has_bom = $hasBom; sha256 = (Get-BytesDigest ([byte[]]$bytes)) }
}

function ConvertTo-PointerBytes([string]$Text, [bool]$HasBom) {
    $body = [Text.UTF8Encoding]::new($false).GetBytes($Text)
    if (-not $HasBom) { return , ([byte[]]$body) }
    $withBom = [byte[]]::new($body.Length + 3)
    $withBom[0] = 0xEF; $withBom[1] = 0xBB; $withBom[2] = 0xBF
    [Array]::Copy($body, 0, $withBom, 3, $body.Length)
    , ([byte[]]$withBom)
}

function Get-PointerPlan {
    <#
    .SYNOPSIS
        What one pointer file would become: the rewritten text, the counts both ways, and the
        ambiguous occurrences with their line numbers.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$SourceSpellings,
        [Parameter(Mandatory = $true)][object]$DestinationSpellings
    )
    $file = Read-PointerFile -Path $Path
    $matchers = New-PointerMatchers -Spellings $SourceSpellings
    $everything = @($matchers.all.Matches($file.text))
    $safe = @($matchers.rewritable.Matches($file.text))
    $safeIndexes = @{}
    foreach ($hit in $safe) { $safeIndexes[[string]$hit.Index] = $true }

    $ambiguous = [Collections.Generic.List[object]]::new()
    foreach ($hit in $everything) {
        if ($safeIndexes.ContainsKey([string]$hit.Index)) { continue }
        [void]$ambiguous.Add([pscustomobject]@{
            line    = (Get-LineNumber -Text $file.text -Index $hit.Index)
            text    = $hit.Value
            # The character that made it ambiguous, so the reader can tell `-DSH` from a trailing space.
            next    = if (($hit.Index + $hit.Length) -lt $file.text.Length) { [string]$file.text[$hit.Index + $hit.Length] } else { '' }
        })
    }

    # Spliced from the end backwards so each index stays valid. `$hits` rather than `$matches`:
    # `$Matches` is a PowerShell automatic variable and shadowing it here would be silent.
    $builder = [Text.StringBuilder]::new($file.text)
    $hits = @($safe)
    for ($i = $hits.Count - 1; $i -ge 0; $i--) {
        $hit = $hits[$i]
        $replacement = if ($hit.Groups['json'].Success) { $DestinationSpellings.json }
                       elseif ($hit.Groups['forward'].Success) { $DestinationSpellings.forward }
                       else { $DestinationSpellings.native }
        [void]$builder.Remove($hit.Index, $hit.Length)
        [void]$builder.Insert($hit.Index, $replacement)
    }
    $rewritten = $builder.ToString()

    [pscustomobject]@{
        path                  = $Path
        prior_sha256          = $file.sha256
        prior_bytes_base64    = [Convert]::ToBase64String($file.bytes)
        prior_had_bom         = $file.has_bom
        rewritable_count      = $hits.Count
        ambiguous_occurrences = @($ambiguous)
        rewritten_text        = $rewritten
        changed               = ($hits.Count -gt 0)
    }
}

# --- Blockers ---------------------------------------------------------------------------------------

function Resolve-OperatorSeatExemption {
    <#
    .SYNOPSIS
        The one seat this process may be excused from the engage blocker scan for -- PROVEN, never
        taken on the word of a name. Returns '' when nothing is proven, which is the safe answer.

    .DESCRIPTION
        WHY AN EXEMPTION EXISTS AT ALL (ruled by Eric 2026-09-19, ADR-0033). Until now the scan
        refused while ANY registered seat was held, and the seat the cutover is being DRIVEN from is
        registered like any other -- so from `library-dev` the preflight itself was refused with
        "seat 'library-dev' is held by a live session", and the Librarian could run only
        `-Action Status`. That contradicted the playbook, which tells the Librarian to run the
        preflight and show the reader what it reports. S2's fixtures could not see it because every
        one of them runs against a workspace whose seats are free: they proved a held seat blocks,
        and never asked whether the OPERATOR's seat should count.

        WHAT IS AND IS NOT EXEMPTED. Only "do not count me as a reason not to start". Once the
        barrier is up this seat is refused every claim-gated mutation exactly like everyone else --
        Assert-SeatClaimHeld does not consult this function and must not learn to. The barrier's
        guarantee is therefore untouched: the hazard it exists for is a writer changing the source
        AFTER its copy was verified, and the operator cannot be that writer, because its session is
        blocked inside this script for the whole run.

        PROVEN THE WAY Assert-SeatClaimHeld PROVES IT, which is the whole point. S2's comment on the
        scan -- "a mover must not exempt itself by happening to run inside an agent that holds a
        seat" -- is right, and a name is exactly that happening. So the same disjunction stands
        here: a committed binding naming this process's agent, OR a claim token matching the one the
        seat holds. A session carrying LIBRARY_SEAT and no matching token proves nothing and blocks.

        HELD ONLY, NEVER ORPHANED. `mutate`/`orphaned` is `refuse` in Get-SeatStateMatrix even when
        `same_agent` is true, and an operator whose own claim holder died is not a session that can
        vouch for its own quietness. It blocks, with the orphan's own remedy.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [string]$Seat = '',
        [string]$ClaimToken = '',
        [int]$AgentProcessId = -1
    )
    if ([string]::IsNullOrWhiteSpace($Seat)) { return '' }
    $registry = Read-SeatRegistry -StateDirectory $StateDirectory
    # ASSIGNED, not tested as a bare pipeline: a Where-Object matching exactly one seat unrolls to a
    # scalar and matching none unrolls to nothing, and `.Count` on either is the defect family this
    # repository keeps producing.
    $known = @(@($registry.seats) | Where-Object { [string]$_.seat -ceq $Seat })
    if ($known.Count -eq 0) { return '' }

    if ($AgentProcessId -lt 0) { $AgentProcessId = Get-CurrentAgentProcessId }
    $claim = Get-SeatClaimState -StateDirectory $StateDirectory -Seat $Seat -AgentProcessId $AgentProcessId
    if ([string]$claim.state -cne 'held') { return '' }

    $heldToken = Get-SeatClaimToken -StateDirectory $StateDirectory -Seat $Seat
    # THE TOKEN HALF IS NOT DECORATION. On this machine no seat carries a committed binding, so
    # `this_agent` is false and the token is the ONLY proof available -- an exemption keyed on the
    # binding alone would have left the operator blocked and this whole change inert. Measured
    # 2026-09-19 at the library-dev seat.
    $sameAgent = ([bool]$claim.this_agent) -or
                 ((-not [string]::IsNullOrWhiteSpace($heldToken)) -and $ClaimToken -ceq $heldToken)
    if (-not $sameAgent) { return '' }
    $Seat
}

function Get-CutoverBlockers {
    <#
    .SYNOPSIS
        Everything that must be quiet before a cutover may run: live seats and held Book locks.

    .DESCRIPTION
        AN ORPHANED SEAT COUNTS AS ACTIVE, which the plan states and which is the non-obvious half.
        `orphaned` means the claim holder is gone and the AGENT IS STILL RUNNING -- a live session
        whose bookkeeping died, not a dead one. Moving its material out from under it is exactly
        what the barrier exists to prevent, so the seat states that block are everything except
        `free`.

        A STALE BOOK LOCK DOES NOT BLOCK, because `Enter-BookLock` already steals one older than
        its own threshold: a lock nothing is waiting on is not a writer. The threshold is read from
        BookWriteGuard.ps1 rather than retyped, so this cannot come to disagree with the code that
        decides what stale means. Stale locks are reported anyway -- a tree full of them is worth
        looking at before a cutover, even though none of them stops one.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        # The operator's own seat, ALREADY PROVEN by Resolve-OperatorSeatExemption. A bare name
        # arriving here is a caller that skipped the proof, so this stays a name and never a
        # decision: nothing in this function re-derives it, and nothing else may pass one.
        [string]$ExemptSeat = ''
    )
    $blocking = [Collections.Generic.List[string]]::new()
    $stale = [Collections.Generic.List[string]]::new()
    $exempted = ''

    $registry = Read-SeatRegistry -StateDirectory $StateDirectory
    foreach ($entry in @($registry.seats)) {
        $seatName = [string]$entry.seat
        # AgentProcessId 0, so `this_agent` is false: a mover must not exempt itself from the scan
        # by happening to run inside an agent that holds a seat. The ONE exemption goes through
        # Resolve-OperatorSeatExemption above, which demands the proof a name cannot supply.
        $claim = Get-SeatClaimState -StateDirectory $StateDirectory -Seat $seatName -AgentProcessId 0
        if ([string]$claim.state -ceq 'free') { continue }
        # THE OPERATOR'S SEAT, AND ONLY WHILE IT IS HELD. Guarded on the state a second time rather
        # than trusting the resolver's promise: this loop is what the barrier's whole guarantee
        # rests on, and a caller that one day passes an unproven name should still not be able to
        # wave an ORPHANED seat past -- the state matrix refuses that one even for the same agent.
        if ((-not [string]::IsNullOrWhiteSpace($ExemptSeat)) -and $seatName -ceq $ExemptSeat -and [string]$claim.state -ceq 'held') {
            $exempted = $seatName
            continue
        }
        if ([string]$claim.state -ceq 'orphaned') {
            [void]$blocking.Add("seat '$seatName' is orphaned -- its claim holder is gone but agent process $([int]$claim.agent_pid) is still running, which is a live session. Re-bind it from that conversation and end it, or end that process.")
        }
        else {
            [void]$blocking.Add("seat '$seatName' is held by a live session. End that session before a cutover; its Desk and Notebook are part of what is being moved.")
        }
    }

    $lockDirectory = Join-Path $Workspace 'internal/book-locks'
    if (Test-Path -LiteralPath $lockDirectory -PathType Container) {
        foreach ($lock in @([IO.Directory]::GetFiles($lockDirectory, '*.lock'))) {
            $age = (Get-Date) - (Get-Item -LiteralPath $lock).LastWriteTime
            $name = [IO.Path]::GetFileNameWithoutExtension($lock)
            if ($age.TotalMinutes -gt $script:StaleLockMinutes) {
                [void]$stale.Add("$name (held $([int]$age.TotalMinutes) minutes; stealable, so it does not block)")
            }
            else {
                [void]$blocking.Add("a Book lock is held on '$name' ($([int]$age.TotalMinutes) minute(s) old), so a writer is in flight. Wait for it to finish.")
            }
        }
    }

    [pscustomobject]@{ blocking = @($blocking); stale_locks = @($stale); exempt_seat = $exempted }
}

# --- The journal ------------------------------------------------------------------------------------

function Get-MoveJournalDirectory([string]$Workspace) {
    $dir = Join-Path (Join-Path $Workspace 'internal') $script:MoveJournalFolder
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $dir
}

function Get-MoveJournalPath([string]$Workspace, [string]$Id) {
    Join-Path (Get-MoveJournalDirectory $Workspace) "$Id.json"
}

function Read-MoveJournal {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$Id)
    $path = Get-MoveJournalPath $Workspace $Id
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $raw = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $path))
    $raw | ConvertFrom-Json
}

function Save-MoveJournal {
    <#
    .SYNOPSIS
        Replace the run's journal atomically, with one more stage recorded.

    .DESCRIPTION
        WRITTEN AT EVERY TRANSITION, NEVER ONLY AT THE END. A journal written at the end records a
        run that finished, which is the one case nobody needs it for -- the state this file exists
        to describe is the one a crash left behind.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][object]$Journal,
        [Parameter(Mandatory = $true)][string]$Stage,
        [string]$Detail = ''
    )
    $stages = @(@($Journal.stages) + [pscustomobject]@{ stage = $Stage; utc = [DateTime]::UtcNow.ToString('o'); detail = $Detail })
    $Journal.stages = $stages
    $Journal.state = $Stage
    $body = ($Journal | ConvertTo-Json -Depth 12) + "`n"
    Write-AtomicText -Path (Get-MoveJournalPath $Workspace ([string]$Journal.run_id)) -Text $body | Out-Null
    $Journal
}

function Get-IncompleteRuns([string]$Workspace) {
    $dir = Join-Path (Join-Path $Workspace 'internal') $script:MoveJournalFolder
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return [pscustomobject]@{ runs = @() } }
    $open = [Collections.Generic.List[object]]::new()
    foreach ($file in @([IO.Directory]::GetFiles($dir, '*.json'))) {
        $record = $null
        try { $record = ([Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $file))) | ConvertFrom-Json }
        catch {
            [void]$open.Add([pscustomobject]@{ run_id = [IO.Path]::GetFileNameWithoutExtension($file); state = 'unreadable'; detail = $_.Exception.Message })
            continue
        }
        $names = @($record.PSObject.Properties | ForEach-Object { $_.Name })
        $state = if ($names -ccontains 'state') { [string]$record.state } else { 'unreadable' }
        if ($state -ceq 'complete' -or $state -ceq 'rolled-back') { continue }
        [void]$open.Add([pscustomobject]@{ run_id = [IO.Path]::GetFileNameWithoutExtension($file); state = $state; detail = '' })
    }
    # An object with an array property, for Copy-InventoryTree's reason one function up.
    [pscustomobject]@{ runs = @($open) }
}

# --- Copy and verify ---------------------------------------------------------------------------------

function Copy-InventoryTree {
    <#
    .SYNOPSIS
        Create every directory, copy every file, and hash each one back at the destination.

    .DESCRIPTION
        RETURNS AN OBJECT WITH AN ARRAY PROPERTY RATHER THAN THE ARRAY. A bare `@()` reaching the
        pipeline unrolls to nothing and the caller's own `@()` then turns that $null into a
        one-element array -- a clean copy reported as one nameless mismatch. Comma-returning is the
        other cure and it is exclusive with the caller wrapping, so the shape that is safe under
        BOTH call forms is a property: property access never unrolls.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][object]$Inventory
    )
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($relative in @($Inventory.directories)) {
        New-Item -ItemType Directory -Path (Join-Path $Destination ([string]$relative).Replace('/', '\')) -Force | Out-Null
    }
    $mismatches = [Collections.Generic.List[string]]::new()
    foreach ($file in @($Inventory.files)) {
        $native = ([string]$file.relative).Replace('/', '\')
        $from = Join-Path $Source $native
        $to = Join-Path $Destination $native
        $parent = Split-Path -Parent $to
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Copy-Item -LiteralPath $from -Destination $to -Force
        $written = Get-FileSha256 $to
        if ($written -cne [string]$file.sha256) {
            [void]$mismatches.Add("$($file.relative): copied as $written, expected $([string]$file.sha256)")
        }
    }
    [pscustomobject]@{ mismatches = @($mismatches) }
}

function Compare-TreeAgainstInventory {
    <#
    .SYNOPSIS
        Does this tree hold exactly the inventory, and nothing else?

    .DESCRIPTION
        BOTH DIRECTIONS, because the two faults differ and only one of them is loud. A missing or
        changed file is a broken copy; an EXTRA file is somebody writing into the destination, and
        it is the fault that decides whether a rollback may delete that tree.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][object]$Inventory
    )
    $faults = [Collections.Generic.List[string]]::new()
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        [void]$faults.Add("$Root does not exist")
        return [pscustomobject]@{ faults = @($faults) }
    }
    $actual = Get-FolderInventory -Root $Root
    $expected = @{}
    foreach ($file in @($Inventory.files)) { $expected[([string]$file.relative).ToLowerInvariant()] = [string]$file.sha256 }
    $seen = @{}
    foreach ($file in @($actual.files)) {
        $key = ([string]$file.relative).ToLowerInvariant()
        $seen[$key] = $true
        if (-not $expected.ContainsKey($key)) {
            [void]$faults.Add("$($file.relative) is present and the inventory does not name it")
            continue
        }
        if ($expected[$key] -cne [string]$file.sha256) {
            [void]$faults.Add("$($file.relative) hashes $([string]$file.sha256), the inventory says $($expected[$key])")
        }
    }
    foreach ($key in @($expected.Keys)) {
        if (-not $seen.ContainsKey($key)) { [void]$faults.Add("$key is in the inventory and missing here") }
    }
    [pscustomobject]@{ faults = @($faults) }
}

# ====================================================================================================
# Entry
# ====================================================================================================

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$stateDirectory = Join-Path $workspace '.claude'
# RESOLVED ONCE, HERE, and passed down. Four call sites scan for blockers and every one of them must
# reach the same verdict; re-deriving it at each would be four chances to disagree about which seat
# is driving the run.
$operatorExemptSeat = Resolve-OperatorSeatExemption -StateDirectory $stateDirectory -Seat $OperatorSeat `
    -ClaimToken $OperatorClaimToken -AgentProcessId $OperatorAgentProcessId

# ====================================================================================================
# STATUS -- the read-only route, which answers whatever the tree is in the middle of
# ====================================================================================================
if ($Action -ceq 'Status') {
    $barrier = Get-MaintenanceBarrierState -Workspace $workspace
    $blockers = Get-CutoverBlockers -Workspace $workspace -StateDirectory $stateDirectory -ExemptSeat $operatorExemptSeat
    $result = [ordered]@{
        operation      = 'Cutover status'
        workspace      = $workspace
        barrier_state  = [string]$barrier.state
        barrier_detail = [string]$barrier.detail
        barrier_record = $barrier.record
        blocking       = @($blockers.blocking)
        stale_locks    = @($blockers.stale_locks)
        # NAMED, NEVER SILENTLY DROPPED. `blocking` answers "what stops a cutover THIS session would
        # start", so the same tree honestly gives a different answer to a different asker -- and a
        # seat that vanished from the list without being named here would be indistinguishable from
        # a seat that was never live.
        exempt_seat    = [string]$blockers.exempt_seat
        incomplete_runs = @((Get-IncompleteRuns $workspace).runs)
        scope          = 'Reads the barrier marker, every seat''s claim state and the Book-lock directory. Takes no lock, changes nothing, and needs no seat. `blocking` excludes this session''s own proven seat, which `exempt_seat` names.'
    }
    Write-LibraryResult -Result ([pscustomobject]$result) -Json:$Json
    return
}

# ====================================================================================================
# LIFT BARRIER -- for a barrier a crashed run left standing
# ====================================================================================================
if ($Action -ceq 'LiftBarrier') {
    $barrier = Get-MaintenanceBarrierState -Workspace $workspace
    if (-not $barrier.engaged) { throw 'No maintenance barrier is up, so there is nothing to lift.' }
    $journal = $null
    if (-not [string]::IsNullOrWhiteSpace($RunId)) { $journal = Read-MoveJournal -Workspace $workspace -Id $RunId }
    if ($Preflight) {
        $plan = [ordered]@{
            operation             = 'Lift a maintenance barrier'
            barrier_state         = [string]$barrier.state
            barrier_record        = $barrier.record
            run_id                = $RunId
            run_state             = if ($null -eq $journal) { '(no journal found for that run)' } else { [string]$journal.state }
            confirmation_required = $true
            recoverable           = $true
            scope                 = 'Removes the marker so mutation and seat entry work again. It moves no file and undoes nothing: read the run''s journal first, because a run that stopped part-way has left real state behind and lifting the barrier does not put it back. -Action Rollback is what does that.'
            next                  = 'Rerun with -UserConfirmed. If the run stopped after its copy, roll it back with -Action Rollback -RunId <id> instead, which lifts the barrier itself.'
        }
        Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
        return
    }
    if (-not $UserConfirmed) { throw 'The barrier was not lifted: review tools/Move-LibraryFolder.ps1 -Action LiftBarrier -Preflight and rerun with -UserConfirmed.' }
    # -Force only where the record cannot be read at all; otherwise the id must match, so one run
    # cannot lift another's barrier.
    $outcome = if ([string]$barrier.state -ceq 'engaged') {
        Remove-MaintenanceBarrier -Workspace $workspace -BarrierId ([string]$barrier.record.barrier_id)
    }
    else { Remove-MaintenanceBarrier -Workspace $workspace -Force }
    Write-LibraryResult -Result ([pscustomobject]@{
        operation = 'Lift a maintenance barrier'
        outcome   = $outcome
        run_id    = $RunId
        next      = 'Mutation and seat entry work again. Anything the interrupted run left half-done is still half-done; its journal says where it stopped.'
    }) -Json:$Json
    return
}

# ====================================================================================================
# ROLLBACK
# ====================================================================================================
if ($Action -ceq 'Rollback') {
    if ([string]::IsNullOrWhiteSpace($RunId)) { throw 'A rollback names the run it undoes: pass -RunId <id>. tools/Move-LibraryFolder.ps1 -Action Status lists the runs that have not completed.' }
    $journal = Read-MoveJournal -Workspace $workspace -Id $RunId
    if ($null -eq $journal) { throw "There is no move journal for run '$RunId' under internal/$script:MoveJournalFolder." }
    $journalNames = @($journal.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($required in @('run_id', 'source', 'destination', 'aside', 'inventory', 'pointers', 'state')) {
        if ($journalNames -cnotcontains $required) { throw "The journal for run '$RunId' has no '$required' field; it cannot drive a rollback." }
    }
    if ([string]$journal.state -ceq 'rolled-back') { throw "Run '$RunId' has already been rolled back." }

    $asideExists = Test-Path -LiteralPath ([string]$journal.aside) -PathType Container
    $destinationExists = Test-Path -LiteralPath ([string]$journal.destination) -PathType Container
    $sourceExists = Test-Path -LiteralPath ([string]$journal.source) -PathType Container

    $rollbackDigest = @(
        "action=rollback", "run=$RunId",
        "source=$([string]$journal.source)", "destination=$([string]$journal.destination)", "aside=$([string]$journal.aside)",
        "aside_present=$asideExists", "destination_present=$destinationExists", "source_present=$sourceExists"
    ) + @(@($journal.pointers) | ForEach-Object { "pointer=$([string]$_.path):$([string]$_.prior_sha256)" })
    $rollbackPlanId = 'rollback-library-folder-' + (Get-TextDigest ($rollbackDigest -join "`n"))

    if ($Preflight) {
        $plan = [ordered]@{
            operation             = 'Roll back a folder cutover'
            run_id                = $RunId
            run_state             = [string]$journal.state
            source                = [string]$journal.source
            destination           = [string]$journal.destination
            aside                 = [string]$journal.aside
            aside_present         = $asideExists
            destination_present   = $destinationExists
            source_present        = $sourceExists
            file_count            = @($journal.inventory.files).Count
            pointer_count         = @($journal.pointers).Count
            plan_id               = $rollbackPlanId
            confirmation_required = $true
            recoverable           = $true
            scope                 = 'Puts the aside copy back at the source path, restores every pointer file from the bytes journalled before the move, and then REMOVES the destination tree -- but only after verifying it still holds exactly what this run copied there. A destination somebody has written to since is refused, listing the files, because it is no longer a copy this run may delete.'
            next                  = "Rerun with -UserConfirmed -ApprovedPlanId $rollbackPlanId."
        }
        Write-LibraryResult -Result ([pscustomobject]$plan) -Json:$Json
        return
    }
    if (-not $UserConfirmed) { throw 'Nothing was rolled back: review the preflight and rerun with -UserConfirmed.' }
    if ($ApprovedPlanId -cne $rollbackPlanId) { throw 'Nothing was rolled back: rerun the current preflight and pass its exact plan_id as ApprovedPlanId. A different plan_id means the trees or the pointers changed since you approved it.' }

    $barrierRecord = New-MaintenanceBarrier -Workspace $workspace -Operation 'Move-LibraryFolder (rollback)' `
        -Reason "rolling back cutover run $RunId" -RunId $RunId
    $restored = [Collections.Generic.List[string]]::new()
    try {
        $blockers = Get-CutoverBlockers -Workspace $workspace -StateDirectory $stateDirectory -ExemptSeat $operatorExemptSeat
        if (@($blockers.blocking).Count) { throw ("A rollback moves the same material a cutover does, so it refuses for the same reasons: " + (@($blockers.blocking) -join ' ')) }

        # 1. THE DESTINATION IS VERIFIED FIRST, before anything is moved. A destination that has
        #    been written to is not this run's copy any more, and a rollback that deleted it would
        #    destroy work no journal describes.
        if ($destinationExists) {
            $faults = @((Compare-TreeAgainstInventory -Root ([string]$journal.destination) -Inventory $journal.inventory).faults)
            if ($faults.Count) {
                throw ("The destination at $([string]$journal.destination) no longer holds exactly what run $RunId copied there, so this " +
                       "rollback will not delete it: $(@($faults) -join '; '). Move what is new out of the way, then rerun.")
            }
        }

        # 2. THE SOURCE COMES BACK. Both copies exist from here until step 4, which is the safe
        #    intermediate state: an interruption leaves the reader with their material at the path
        #    everything points at.
        if (-not $sourceExists) {
            if (-not $asideExists) { throw "Neither $([string]$journal.source) nor the aside copy at $([string]$journal.aside) exists; this rollback has nothing to put back." }
            Move-Item -LiteralPath ([string]$journal.aside) -Destination ([string]$journal.source)
            [void]$restored.Add('source')
            $sourceFaults = @((Compare-TreeAgainstInventory -Root ([string]$journal.source) -Inventory $journal.inventory).faults)
            if ($sourceFaults.Count) { throw ("The restored source does not match the inventory taken before the move: $(@($sourceFaults) -join '; ')") }
        }

        # 3. THE POINTERS, from the bytes journalled before the move, each read back exactly.
        foreach ($pointer in @($journal.pointers)) {
            $path = [string]$pointer.path
            $priorBytes = [Convert]::FromBase64String([string]$pointer.prior_bytes_base64)
            Write-AtomicBytes -Path $path -Bytes $priorBytes | Out-Null
            $readback = Get-BytesDigest ([byte[]](Read-AtomicBytes -Path $path))
            if ($readback -cne [string]$pointer.prior_sha256) {
                throw "$path was restored and read back as $readback, not the journalled $([string]$pointer.prior_sha256)."
            }
            [void]$restored.Add("pointer:$path")
        }

        # 4. AND ONLY NOW THE DESTINATION GOES, verified in step 1 and superseded by step 2.
        if ($destinationExists) {
            Remove-Item -LiteralPath ([string]$journal.destination) -Recurse -Force
            [void]$restored.Add('destination removed')
        }

        Save-MoveJournal -Workspace $workspace -Journal $journal -Stage 'rolled-back' -Detail (@($restored) -join ', ') | Out-Null
    }
    catch {
        Save-MoveJournal -Workspace $workspace -Journal $journal -Stage 'rollback-failed' -Detail $_.Exception.Message | Out-Null
        throw
    }
    finally {
        # WRAPPED, so a barrier that has already gone cannot replace the real failure with a
        # secondary one. A finally that throws is how a diagnosis gets lost.
        try { Remove-MaintenanceBarrier -Workspace $workspace -BarrierId ([string]$barrierRecord.barrier_id) | Out-Null }
        catch { Write-Warning "The maintenance barrier was not lowered: $($_.Exception.Message) Lower it with tools/Move-LibraryFolder.ps1 -Action LiftBarrier -RunId $RunId -UserConfirmed." }
    }

    Write-LibraryResult -Result ([pscustomobject]@{
        operation = 'Roll back a folder cutover'
        run_id    = $RunId
        restored  = @($restored)
        source    = [string]$journal.source
        next      = 'The barrier is down and the source is back where it was. The journal records the rollback; nothing was deleted except the destination copy this run made.'
    }) -Json:$Json
    return
}

# ====================================================================================================
# MOVE
# ====================================================================================================
if ([string]::IsNullOrWhiteSpace($SourcePath)) { throw 'A cutover names what it moves: pass -SourcePath <folder> and -DestinationPath <folder>.' }
if ([string]::IsNullOrWhiteSpace($DestinationPath)) { throw 'A cutover names where it moves to: pass -DestinationPath <folder>.' }

$source = ConvertTo-ComparablePath $SourcePath
$destination = ConvertTo-ComparablePath $DestinationPath
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "$source is not a folder, so there is nothing to move." }

# Checked before a plan_id is issued, not after: an approval for an operation already certain to
# fail is worse than no approval.
if (Test-Path -LiteralPath $destination) { throw "$destination already exists. A cutover copies into a path nothing occupies; move or rename what is there first." }
if (Test-PathWithin -Child $destination -Container $source) { throw "$destination is inside $source. A cutover cannot copy a tree into itself." }
if (Test-PathWithin -Child $source -Container $destination) { throw "$source is inside $destination, so the two overlap; name a destination outside the source." }

# DERIVED, AND DELIBERATELY NOT STAMPED WITH THE TIME. The aside path is part of the plan_id, so a
# time-derived default would turn the id every second and no approval could ever match the run that
# followed it. A leftover aside from an earlier run is caught by the collision check below, which is
# the honest outcome: it names -AsidePath rather than quietly accumulating copies beside the source.
$aside = if ([string]::IsNullOrWhiteSpace($AsidePath)) {
    (ConvertTo-ComparablePath $source) + '.aside'
}
else { ConvertTo-ComparablePath $AsidePath }
if (Test-Path -LiteralPath $aside) { throw "$aside already exists, so the source cannot be renamed aside to it. It is probably an earlier run's aside copy, waiting for the archive purge; move it into the archive, or name another -AsidePath." }
if (Test-PathWithin -Child $aside -Container $source) { throw "$aside is inside $source; the aside copy cannot live inside the tree being renamed." }
if (Test-PathWithin -Child $aside -Container $destination) { throw "$aside is inside $destination; the aside copy must not live inside the new tree." }

$pointerPaths = @(@($PointerPath) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
foreach ($candidate in $pointerPaths) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "$candidate is not a file, so it cannot be a pointer to rewrite." }
    if (Test-PathWithin -Child $candidate -Container $source) {
        throw ("$candidate is inside the folder being moved. A pointer inside the source would be copied and then " +
               'rewritten, so the aside copy and the destination would disagree about where the folder is. Name the ' +
               'copy at its destination path instead, after the move, or update it by hand.')
    }
}

$sourceSpellings = Get-PathSpellings $source
$destinationSpellings = Get-PathSpellings $destination

function Get-CutoverPlan {
    <# The inventory, the pointers and the plan_id, derived the same way in the preflight and under the barrier. #>
    $inventory = Get-FolderInventory -Root $source
    $pointers = @(@($pointerPaths) | ForEach-Object { Get-PointerPlan -Path $_ -SourceSpellings $sourceSpellings -DestinationSpellings $destinationSpellings })
    $digestSource = @(
        'action=move', "source=$source", "destination=$destination", "aside=$aside"
    ) + @(@($inventory.files) | ForEach-Object { "file=$($_.relative):$($_.sha256):$($_.length)" }) +
        @(@($inventory.directories) | ForEach-Object { "dir=$_" }) +
        @(@($pointers) | ForEach-Object { "pointer=$($_.path):$($_.prior_sha256):$($_.rewritable_count):$(@($_.ambiguous_occurrences).Count)" })
    [pscustomobject]@{
        inventory = $inventory
        pointers  = @($pointers)
        plan_id   = 'move-library-folder-' + (Get-TextDigest ($digestSource -join "`n"))
    }
}

# --- Preflight --------------------------------------------------------------------------------------
if ($Preflight) {
    $barrier = Get-MaintenanceBarrierState -Workspace $workspace
    if ($barrier.engaged) { throw (Get-MaintenanceBarrierRefusal -Workspace $workspace -Operation 'planning a cutover') }
    $open = @((Get-IncompleteRuns $workspace).runs)
    if ($open.Count) {
        throw ("Run(s) $(@($open | ForEach-Object { "$($_.run_id) ($($_.state))" }) -join ', ') have not completed, so a new cutover is refused. " +
               'Finish or roll one back first: tools/Move-LibraryFolder.ps1 -Action Rollback -RunId <id> -Preflight.')
    }
    # REFUSED RATHER THAN SHOWN WITH A WARNING. Printing a plan for a cutover the barrier is certain
    # to refuse is the defect this file's sibling fixed in Start-LibrarySeat.ps1's own preflight.
    $blockers = Get-CutoverBlockers -Workspace $workspace -StateDirectory $stateDirectory -ExemptSeat $operatorExemptSeat
    if (@($blockers.blocking).Count) {
        throw ("A cutover stops the whole Library, and it cannot start while work is live: " + (@($blockers.blocking) -join ' ') +
               ' Read the current state any time with tools/Move-LibraryFolder.ps1 -Action Status.')
    }

    $plan = Get-CutoverPlan
    $ambiguousTotal = 0
    foreach ($pointer in @($plan.pointers)) { $ambiguousTotal += @($pointer.ambiguous_occurrences).Count }
    $result = [ordered]@{
        operation             = 'Move a folder under the cutover protocol'
        source                = $source
        destination           = $destination
        aside                 = $aside
        file_count            = @($plan.inventory.files).Count
        directory_count       = @($plan.inventory.directories).Count
        byte_count            = [long]$plan.inventory.byte_count
        pointers              = @(@($plan.pointers) | ForEach-Object {
            [pscustomobject]@{
                path                  = $_.path
                prior_sha256          = $_.prior_sha256
                rewritable_count      = $_.rewritable_count
                ambiguous_occurrences = @($_.ambiguous_occurrences)
            }
        })
        ambiguous_total       = $ambiguousTotal
        stale_locks           = @($blockers.stale_locks)
        # WHICH SEAT WAS EXCUSED, on the plan the reader approves. An exemption that only ever
        # appeared as an absence would be a guard relaxing itself where nobody reading the result
        # could see it.
        exempt_seat           = [string]$blockers.exempt_seat
        plan_id               = $plan.plan_id
        confirmation_required = $true
        recoverable           = $true
        shared_library_write  = $false
        scope                 = 'Raises a maintenance barrier that refuses every claim-gated mutation and both seat entry routes; re-hashes the source under it and refuses if anything moved since this plan; copies every file to the destination and hashes each one back; renames the source aside rather than deleting it; rewrites and reads back each pointer; verifies the destination against the aside copy; writes a rollback checkpoint; lowers the barrier. The aside copy is left in place for the archive purge.'
        next                  = if ($ambiguousTotal -gt 0) {
            "ambiguous_occurrences names $ambiguousTotal occurrence(s) this run will NOT rewrite, because the character after the path could extend it into a different folder. Read them; anything genuinely stale there is yours to fix by hand. Then rerun with -UserConfirmed -ApprovedPlanId $($plan.plan_id)."
        }
        else {
            "Rerun with -UserConfirmed -ApprovedPlanId $($plan.plan_id)."
        }
    }
    Write-LibraryResult -Result ([pscustomobject]$result) -Json:$Json
    return
}

# --- Confirmed run ------------------------------------------------------------------------------------
if (-not $UserConfirmed) { throw 'Nothing was moved: review the preflight and rerun with -UserConfirmed.' }
if ([string]::IsNullOrWhiteSpace($ApprovedPlanId)) { throw 'Nothing was moved: rerun the preflight and pass its exact plan_id as -ApprovedPlanId.' }

$open = @((Get-IncompleteRuns $workspace).runs)
if ($open.Count) {
    throw ("Run(s) $(@($open | ForEach-Object { "$($_.run_id) ($($_.state))" }) -join ', ') have not completed, so a new cutover is refused. " +
           'Finish or roll one back first.')
}

$runIdentifier = if ([string]::IsNullOrWhiteSpace($RunId)) {
    'move-' + [DateTime]::UtcNow.ToString('yyyyMMdd') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
}
else { $RunId }
$reasonText = if ([string]::IsNullOrWhiteSpace($Reason)) { "moving $source to $destination" } else { $Reason }

# (a) THE BARRIER FIRST, THEN THE BLOCKER SCAN. Reversing these two leaves the gap a seat can be
#     claimed in; this way the launchers are already refusing while the scan reads.
$barrierRecord = New-MaintenanceBarrier -Workspace $workspace -Operation 'Move-LibraryFolder' -Reason $reasonText -RunId $runIdentifier
$journal = $null
$movedAside = $false
$copied = $false
$pointersWritten = [Collections.Generic.List[string]]::new()
try {
    $blockers = Get-CutoverBlockers -Workspace $workspace -StateDirectory $stateDirectory -ExemptSeat $operatorExemptSeat
    if (@($blockers.blocking).Count) {
        throw ('A cutover stops the whole Library, and it cannot start while work is live: ' + (@($blockers.blocking) -join ' '))
    }

    # (b)+(c) THE INVENTORY IS TAKEN UNDER THE BARRIER AND THE APPROVAL IS CHECKED AGAINST IT.
    $plan = Get-CutoverPlan
    if ($ApprovedPlanId -cne $plan.plan_id) {
        throw ("Nothing was moved: the source, the pointers or the destination changed between the preflight and now, so the " +
               "approved plan_id no longer describes them. Rerun the preflight and approve the current plan_id ($($plan.plan_id)).")
    }

    $journal = [pscustomobject][ordered]@{
        schema                  = $script:MoveJournalSchema
        run_id                  = $runIdentifier
        operation               = 'Move a folder under the cutover protocol'
        workspace               = $workspace
        source                  = $source
        destination             = $destination
        aside                   = $aside
        plan_id                 = $plan.plan_id
        reason                  = $reasonText
        started_utc             = [DateTime]::UtcNow.ToString('o')
        barrier_id              = [string]$barrierRecord.barrier_id
        # WHICH SEAT THE SCAN WAS TOLD TO EXCUSE, journalled beside the barrier that made it safe.
        # A run whose blocker scan skipped a live seat should say so in the record it leaves behind,
        # not only in the console line that scrolls away.
        exempt_seat             = [string]$blockers.exempt_seat
        # The prior ABSENCE of what this run creates, so a rollback deletes rather than resurrects.
        destination_prior_state = 'absent'
        inventory               = $plan.inventory
        pointers                = @(@($plan.pointers) | ForEach-Object {
            [pscustomobject]@{
                path                  = $_.path
                prior_sha256          = $_.prior_sha256
                prior_bytes_base64    = $_.prior_bytes_base64
                prior_had_bom         = $_.prior_had_bom
                rewritable_count      = $_.rewritable_count
                ambiguous_occurrences = @($_.ambiguous_occurrences)
                new_sha256            = ''
            }
        })
        stages                  = @()
        state                   = 'planned'
    }
    Save-MoveJournal -Workspace $workspace -Journal $journal -Stage 'planned' -Detail "$(@($plan.inventory.files).Count) file(s), $(@($plan.pointers).Count) pointer(s)" | Out-Null

    # (d) THE COPY, HASHED BACK FILE BY FILE.
    $mismatches = @((Copy-InventoryTree -Source $source -Destination $destination -Inventory $plan.inventory).mismatches)
    $copied = $true
    Save-MoveJournal -Workspace $workspace -Journal $journal -Stage 'copied' -Detail "$(@($plan.inventory.files).Count) file(s) copied" | Out-Null
    if ($mismatches.Count) { throw ("The copy did not verify: " + (@($mismatches) -join '; ')) }
    $copyFaults = @((Compare-TreeAgainstInventory -Root $destination -Inventory $plan.inventory).faults)
    if ($copyFaults.Count) { throw ("The destination does not hold exactly the inventory: " + (@($copyFaults) -join '; ')) }
    Save-MoveJournal -Workspace $workspace -Journal $journal -Stage 'copy-verified' -Detail 'every file hashed back at the destination' | Out-Null

    # (e) RENAME ASIDE, NEVER DELETE.
    Move-Item -LiteralPath $source -Destination $aside
    $movedAside = $true
    Save-MoveJournal -Workspace $workspace -Journal $journal -Stage 'source-aside' -Detail $aside | Out-Null

    # (f) POINTERS, EACH READ BACK AGAINST THE EXACT BYTES THIS RUN COMPUTED.
    $pointerRecords = @($journal.pointers)
    for ($i = 0; $i -lt @($plan.pointers).Count; $i++) {
        $pointer = @($plan.pointers)[$i]
        $expectedBytes = [byte[]](ConvertTo-PointerBytes -Text ([string]$pointer.rewritten_text) -HasBom ([bool]$pointer.prior_had_bom))
        Write-AtomicBytes -Path ([string]$pointer.path) -Bytes $expectedBytes | Out-Null
        [void]$pointersWritten.Add([string]$pointer.path)
        $actualBytes = [byte[]](Read-AtomicBytes -Path ([string]$pointer.path))
        $expectedDigest = Get-BytesDigest $expectedBytes
        $actualDigest = Get-BytesDigest $actualBytes
        if ($actualDigest -cne $expectedDigest) {
            throw "$([string]$pointer.path) was rewritten and read back as $actualDigest, not the $expectedDigest this run wrote."
        }
        # AND THE OLD PATH IS GONE from every spelling this run is entitled to rewrite. The digest
        # proves the bytes are what was computed; this proves what was computed was a full rewrite.
        $remaining = @((New-PointerMatchers -Spellings $sourceSpellings).rewritable.Matches([string]$pointer.rewritten_text))
        if ($remaining.Count) {
            throw "$([string]$pointer.path) still names the old path in $($remaining.Count) place(s) after the rewrite."
        }
        $pointerRecords[$i].new_sha256 = $actualDigest
    }
    $journal.pointers = $pointerRecords
    Save-MoveJournal -Workspace $workspace -Journal $journal -Stage 'pointers-updated' -Detail (@($pointersWritten) -join ', ') | Out-Null

    # (g) THE FINAL VERIFICATION, SOURCE AGAINST DESTINATION, AFTER THE CUTOVER. A different
    #     question from the copy check: that one compared the destination to an inventory, this
    #     compares it to what the source turned out to actually be.
    $asideInventory = Get-FolderInventory -Root $aside
    $finalFaults = @((Compare-TreeAgainstInventory -Root $destination -Inventory $asideInventory).faults)
    if ($finalFaults.Count) { throw ("The destination does not match the source as it stands at $($aside): " + (@($finalFaults) -join '; ')) }
    Save-MoveJournal -Workspace $workspace -Journal $journal -Stage 'verified' -Detail "$(@($asideInventory.files).Count) file(s) compared source to destination" | Out-Null

    # (h) THE ROLLBACK CHECKPOINT, which is a command rather than a paragraph.
    $journal | Add-Member -NotePropertyName 'rollback' -NotePropertyValue ([pscustomobject]@{
        aside          = $aside
        destination    = $destination
        source         = $source
        pointer_count  = @($journal.pointers).Count
        command        = "tools/Move-LibraryFolder.ps1 -Action Rollback -RunId $runIdentifier -Preflight"
        what_it_does   = 'Puts the aside copy back at the source path, restores each pointer from its journalled prior bytes, and removes the destination copy after verifying it is still exactly what this run wrote there.'
    }) -Force
    Save-MoveJournal -Workspace $workspace -Journal $journal -Stage 'checkpointed' -Detail 'rollback checkpoint written' | Out-Null
    Save-MoveJournal -Workspace $workspace -Journal $journal -Stage 'complete' -Detail 'cutover complete; the aside copy is left for the archive purge' | Out-Null
}
catch {
    if ($null -ne $journal) {
        Save-MoveJournal -Workspace $workspace -Journal $journal -Stage 'failed' -Detail $_.Exception.Message | Out-Null
    }
    throw
}
finally {
    # (i) THE BARRIER COMES DOWN even on a failure, so a crashed cutover does not also leave the
    #     Library stopped. What it leaves half-done is in the journal, and -Action Rollback is the
    #     route back.
    #
    # WRAPPED, because a throw in a finally REPLACES the exception that brought us here -- and the
    # failure that mattered is the one the reader needs. A barrier that cannot be lowered is a
    # warning naming the command that lowers it, never a lost diagnosis.
    try { Remove-MaintenanceBarrier -Workspace $workspace -BarrierId ([string]$barrierRecord.barrier_id) | Out-Null }
    catch { Write-Warning "The maintenance barrier was not lowered: $($_.Exception.Message) Lower it with tools/Move-LibraryFolder.ps1 -Action LiftBarrier -RunId $runIdentifier -UserConfirmed." }
}

Write-LibraryResult -Result ([pscustomobject]@{
    operation       = 'Move a folder under the cutover protocol'
    run_id          = $runIdentifier
    source          = $source
    destination     = $destination
    aside           = $aside
    file_count      = @($journal.inventory.files).Count
    pointers        = @($pointersWritten)
    journal         = "internal/$script:MoveJournalFolder/$runIdentifier.json"
    rollback        = "tools/Move-LibraryFolder.ps1 -Action Rollback -RunId $runIdentifier -Preflight"
    aside_retained  = $true
    exempt_seat     = [string]$blockers.exempt_seat
    next            = "The source is at $aside and is NOT deleted: (j) of the protocol leaves that to the archive purge, which is its own gated operation. Verify the reader's tools open the new path before that purge runs."
}) -Json:$Json
