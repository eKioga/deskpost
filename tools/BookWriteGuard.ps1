<#
.SYNOPSIS
    Per-Book locking and pre-write journaling for Shelf writers. Dot-sourced; never invoked directly.

.DESCRIPTION
    Two guarantees every Shelf writer needs, and neither is optional once more than one writer
    exists.

    THE LOCK is the Book's, not any one helper's. Ordering alone protects against a crash, not
    against two writers interleaving -- and the reader does run more than one session. It is
    acquired BEFORE prior state is read or journaled, because a concurrent mutation during capture
    makes the journal describe a state that never fully existed, so a later rollback would overwrite
    another writer's committed change.

    THE JOURNAL records, before any mutation: the prior body of every page the operation will
    change, the prior ABSENCE of every page it will create (so rollback deletes rather than
    resurrects), the affected paths, and the operation digest. Rollback verifies by readback rather
    than assuming.

    Precedent note: Edit-ProjectHub.ps1 is the only existing helper that journals a previous body.
    The publishers do NOT -- their journals record new manifests and hashes, which is exactly why a
    shared refresh has no rollback and is excluded from batch triage. Do not cite them here.
#>

Set-StrictMode -Version Latest

$script:BookWriteGuardSchema = 2
$script:StaleLockMinutes = 30

# THE TWO FILES A JOURNAL MUST NEVER CARRY, lowercase because NTFS is case-insensitive and a caller
# spelling one `_Catalog.md` names the same file. These are the RENDERED indexes of
# docs/derived-indexes.md -- not `_catalog-entry.md`, which is a Book's own authored authority and
# is journaled by Rename-ShelfBook on purpose. Write-BookJournal refuses them; the reasoning is at
# that refusal.
$script:RenderedIndexFileNames = @('_master-index.md', '_catalog.md')

function Get-BookLockDirectory([string]$Workspace) {
    $dir = Join-Path $Workspace 'internal/book-locks'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $dir
}

function Get-BookJournalDirectory([string]$Workspace) {
    $dir = Join-Path $Workspace 'internal/shelf-journals'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $dir
}

# One Book, one lock name. 'shelf/demo', 'shelf\demo', and 'shelf/demo/' name the same Book,
# and a writer that spells it differently from the next writer would take a lock nobody else
# contends for -- exclusion that looks present and is not. Normalise before the name is built.
function ConvertTo-BookLockName([string]$BookRoot) {
    $normalised = ($BookRoot -replace '\\', '/').Trim()
    $normalised = $normalised -replace '/+', '/'
    $normalised = $normalised.TrimEnd('/')
    if ([string]::IsNullOrWhiteSpace($normalised)) { throw 'A Book lock needs a Book root.' }
    $normalised -replace '/', '-'
}

function Get-FileSha256([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
}

# THE ATOMIC FILE PRIMITIVES MOVED TO AtomicFile.ps1 ON 2026-09-09, and this import is what keeps
# every existing consumer of this file unchanged: Write-AtomicText and Read-AtomicBytes are still
# in scope for anyone who dot-sources BookWriteGuard.ps1. They moved because BookRootSchema.ps1
# now reads a seat's binding, which is written atomically, and the schema must not have to pull
# per-Book locking and journaling in to get a retrying read. AtomicFile.ps1 dot-sources nothing.
. (Join-Path $PSScriptRoot 'AtomicFile.ps1')

# --- WHICH LOCKS THIS PROCESS HOLDS RIGHT NOW -----------------------------------------------------
#
# A ledger of the locks acquired in this runspace and not yet released, so a function can REFUSE to
# run unlocked instead of trusting its callers to have taken the lock first. The lock file itself
# cannot answer the question: Enter-BookLock opens it with FileShare::None, so not even the holding
# process can open a second handle to read the `pid=` line back.
#
# WHY A LEDGER AND NOT A COMMENT. Until 2026-09-09 the cross-seat Desk scans in LibrarySeat.ps1 said
# "the caller holds the registry lock" in a comment, and four of the eight helpers documented as
# taking it took none -- a contract asserted in prose four times and wrong four times. Prose is not
# checked. This is.
#
# Guarded initialisation, because a script that dot-sources this file directly AND through
# LibrarySeat.ps1 loads it twice; both loads happen before any lock is taken, but an unconditional
# reset is one edit away from being wrong.
if (-not (Test-Path -LiteralPath 'variable:script:HeldBookLocks')) { $script:HeldBookLocks = @{} }

function Get-BookLockLedgerKey([string]$Workspace, [string]$BookRoot) {
    $name = ConvertTo-BookLockName $BookRoot
    (Join-Path (Get-BookLockDirectory -Workspace $Workspace) "$name.lock").ToLowerInvariant()
}

function Test-BookLockHeld {
    <#
    .SYNOPSIS
        Does THIS runspace currently hold the lock for this Book root?

    .DESCRIPTION
        Answers about this process only, which is the right scope: the question a callee asks is
        "may I assume my caller has excluded everyone else", and a lock held by some other process
        is the opposite of that. A caller that spawns a child process to do the locked work is
        therefore refused by design -- see Remove-ShelfBook.ps1, which stopped shelling out to
        Set-VirtualDesk.ps1 for exactly this reason.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$BookRoot
    )
    [int]$depth = 0
    $key = Get-BookLockLedgerKey -Workspace $Workspace -BookRoot $BookRoot
    if ($script:HeldBookLocks.ContainsKey($key)) { $depth = [int]$script:HeldBookLocks[$key] }
    $depth -gt 0
}

# --- THE COLLECTION-WIDE EXPORT LOCK --------------------------------------------------------------
#
# PLAN-public-release.md step 15, contract (a). tools/Export-CollectionToVault.ps1 captures the whole
# collection and must not have a publication land in the middle of that capture, so it takes a lock
# that is not a Book's -- it excludes every Book at once -- and it lives in the same directory, by
# the same CreateNew race, so there is one lock namespace rather than two that cannot see each other.
#
# THE MUTUAL EXCLUSION IS SYMMETRIC AND NEITHER SIDE RETRIES.
#
#   The exporter creates its lock FIRST, then looks for any other lock. If it finds one, it releases
#   and refuses -- a writer got there first.
#   A Book writer looks for the export lock BEFORE it creates its own. If it finds one, it refuses.
#
# Interleaved, the worst case is that both back off, which is a refusal rather than a deadlock and
# is why the exporter refuses instead of waiting. Waiting is the shape that turns two careful
# operations into a livelock.
$script:CollectionExportLockName = 'collection-export'

function Get-CollectionExportLockPath([string]$Workspace) {
    Join-Path (Get-BookLockDirectory -Workspace $Workspace) "$($script:CollectionExportLockName).lock"
}

function Assert-NoCollectionExport {
    <#
    .SYNOPSIS
        Refuse the operation while a collection-wide export holds the workspace.

    .DESCRIPTION
        Called from the two chokepoints every writer already passes through: Enter-BookLock, which
        every Shelf writer, Hub edit and manifest transaction takes, and Assert-SeatClaimHeld, which
        the whole claim-gated set -- publication, refresh, archive -- reaches. Adding it in two
        places rather than thirty is the same reasoning Assert-NoMaintenanceBarrier is placed by,
        and checks.export-lock-coverage is what keeps it that way.

        A DISTINCT REFUSAL, not the barrier's. A cutover and an export stop different things for
        different reasons and have different remedies, and one shared message would send the reader
        to the wrong one.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [string]$Operation = 'this write'
    )
    $lockPath = Get-CollectionExportLockPath -Workspace $Workspace
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $true }
    $detail = ''
    try { $detail = (([IO.File]::ReadAllText($lockPath)) -split "`r?`n" | Where-Object { $_ -ne '' }) -join '; ' } catch { }
    throw ("A collection-wide export holds this workspace, so $Operation is refused: the export is " +
           "copying the whole collection and a write landing inside that capture would be mirrored " +
           "half-done. Wait for tools/Export-CollectionToVault.ps1 to finish. $lockPath ($detail). " +
           'If no export is running, that file is a crashed run''s leftover and removing it is safe.')
}

function Enter-CollectionExportLock {
    <#
    .SYNOPSIS
        Take the collection-wide export lock, or refuse because a Book writer already holds one.

    .DESCRIPTION
        Creates its own lock before scanning for others, so a writer that starts between the scan
        and the create sees this lock and refuses. The scan afterwards is what catches the writer
        that was already inside. Returns a handle Exit-BookLock releases -- the same release path,
        because it is the same kind of file in the same directory.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Workspace, [string]$RunId = '')

    $lockDir = Get-BookLockDirectory -Workspace $Workspace
    $lockPath = Get-CollectionExportLockPath -Workspace $Workspace
    try {
        $stream = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    }
    catch [IO.IOException] {
        throw ("Another collection export already holds this workspace ($lockPath). Wait for it, or " +
               'if no export is running, remove that file -- it is a crashed run''s leftover.')
    }
    $writer = [IO.StreamWriter]::new($stream)
    $writer.WriteLine("pid=$PID")
    $writer.WriteLine("acquired=$([DateTime]::UtcNow.ToString('o'))")
    $writer.WriteLine("run=$RunId")
    $writer.Flush()
    $ledgerKey = $lockPath.ToLowerInvariant()
    [int]$held = 0
    if ($script:HeldBookLocks.ContainsKey($ledgerKey)) { $held = [int]$script:HeldBookLocks[$ledgerKey] }
    $script:HeldBookLocks[$ledgerKey] = $held + 1
    $handle = [pscustomobject]@{ path = $lockPath; stream = $stream; writer = $writer; book_root = 'collection-export'; lock_name = $script:CollectionExportLockName; ledger_key = $ledgerKey }

    # NOW look for anybody who was already inside. Releasing on a find is what makes the refusal a
    # refusal rather than an export running beside a half-written publication.
    $others = @(Get-ChildItem -LiteralPath $lockDir -Filter '*.lock' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -ine $lockPath } | ForEach-Object { $_.Name })
    if ($others.Count) {
        Exit-BookLock -Lock $handle
        throw ("$($others.Count) Book lock(s) are held, so a whole-collection export cannot take a " +
               "consistent capture: $($others -join ', '). Wait for that writer to finish and run the " +
               'export again. It refuses rather than waiting, because waiting on a writer that is ' +
               'itself waiting on this lock is a deadlock.')
    }
    $handle
}

function Enter-BookLock {
    <#
    .SYNOPSIS
        Take the exclusive lock for one Book root. Returns a handle for Exit-BookLock.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$BookRoot,
        [int]$TimeoutSeconds = 20
    )

    $name = ConvertTo-BookLockName $BookRoot
    $lockPath = Join-Path (Get-BookLockDirectory -Workspace $Workspace) "$name.lock"

    # BEFORE the lock file is created, so a writer never holds a Book while an export is capturing
    # it. Checked here rather than in each writer for the reason Assert-NoMaintenanceBarrier is
    # checked in Assert-SeatClaimHeld: this is the one door they all pass through. The export's own
    # lock goes through Enter-CollectionExportLock and never through here, so this cannot refuse it.
    Assert-NoCollectionExport -Workspace $Workspace -Operation "writing to $BookRoot" | Out-Null

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    while ($true) {
        try {
            # CreateNew is atomic: exactly one caller wins the race, the rest throw.
            $stream = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $writer = [IO.StreamWriter]::new($stream)
            $writer.WriteLine("pid=$PID")
            $writer.WriteLine("acquired=$([DateTime]::UtcNow.ToString('o'))")
            $writer.WriteLine("book=$BookRoot")
            $writer.Flush()
            # Recorded AFTER the handle is open, so a failed acquisition never reads as held.
            $ledgerKey = $lockPath.ToLowerInvariant()
            [int]$held = 0
            if ($script:HeldBookLocks.ContainsKey($ledgerKey)) { $held = [int]$script:HeldBookLocks[$ledgerKey] }
            $script:HeldBookLocks[$ledgerKey] = $held + 1
            return [pscustomobject]@{ path = $lockPath; stream = $stream; writer = $writer; book_root = $BookRoot; lock_name = $name; ledger_key = $ledgerKey }
        }
        catch [IO.IOException] {
            # Someone holds it, or a crashed process left it behind. Only the latter may be stolen.
            if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
                $age = (Get-Date) - (Get-Item -LiteralPath $lockPath).LastWriteTime
                if ($age.TotalMinutes -gt $script:StaleLockMinutes) {
                    Write-Warning "Removing a stale Book lock for $BookRoot (held $([int]$age.TotalMinutes) minutes)."
                    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
                    continue
                }
            }
            if ((Get-Date) -ge $deadline) {
                throw "Another operation holds the lock for $BookRoot. Wait for it to finish, or investigate $lockPath."
            }
            Start-Sleep -Milliseconds 250
        }
    }
}

function Exit-BookLock {
    <#
    .SYNOPSIS
        Release one Book lock, and say so out loud when the lock file survives the attempt.

    .DESCRIPTION
        NEVER THROWS, deliberately. Almost every call site is a `finally`, and a throw from a
        `finally` REPLACES the exception in flight -- destroying the diagnosis the caller was about
        to report. A release that fails warns and names the path instead.

        THE VERIFICATION IS NOT DECORATION. On 2026-09-05 a shared manifest rebuild left a lock
        behind and a Book dirty, and the run journals could not reconstruct why: the removal was
        error-suppressed AND unverified, so a failed release was indistinguishable from a clean one.
        A surviving lock is stealable after $script:StaleLockMinutes, so the cost is delay rather
        than deadlock -- but the silence is what made the cause unknowable.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$Lock)
    if ($null -eq $Lock) { return }
    # Deregistered FIRST, and never conditionally: this function must not throw (see above), so a
    # release whose file removal fails still stops claiming the lock is held. A ledger that outlived
    # a released lock would let a later unlocked call pass the assertion, which is worse than a
    # surviving lock file -- that one is stealable after $script:StaleLockMinutes.
    if ($null -ne $Lock.PSObject.Properties['ledger_key']) {
        $ledgerKey = [string]$Lock.ledger_key
        if ($script:HeldBookLocks.ContainsKey($ledgerKey)) {
            $remaining = [int]$script:HeldBookLocks[$ledgerKey] - 1
            if ($remaining -gt 0) { $script:HeldBookLocks[$ledgerKey] = $remaining }
            else { [void]$script:HeldBookLocks.Remove($ledgerKey) }
        }
    }
    # Dispose before removing: Windows will not delete a file whose open handle was taken with
    # FileShare::None, which is exactly how Enter-BookLock opens it.
    try { $Lock.writer.Dispose() } catch { }
    try { $Lock.stream.Dispose() } catch { }
    Remove-Item -LiteralPath $Lock.path -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $Lock.path -PathType Leaf) {
        # One retry. A scanner or indexer holding the file for an instant is the common case, and
        # it is usually over by the time the first attempt has failed.
        Remove-Item -LiteralPath $Lock.path -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $Lock.path -PathType Leaf) {
        Write-Warning ("The Book lock for $($Lock.book_root) was NOT released: $($Lock.path) is still on disk. " +
            "Another writer is blocked until it is removed by hand or goes stale after $script:StaleLockMinutes minutes.")
    }
}

function Write-BookJournal {
    <#
    .SYNOPSIS
        Record prior state for every path an operation will touch, before it touches any of them.

    .PARAMETER Paths
        Absolute paths the operation will create, change, or delete. A path that does not yet exist
        is recorded as absent so rollback can delete it. It may be EMPTY: an operation whose only
        durable change is a directory move has no file bytes to record, and a journal of zero
        entries is still the operation's dated record and still the thing its rollback is shaped
        around.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$BookRoot,
        [Parameter(Mandatory = $true)][string]$Operation,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Paths,
        [string]$OperationDigest = ''
    )

    # A DERIVED INDEX IS RE-DERIVED, NEVER RESTORED. This is a refusal rather than a convention
    # because the convention was already broken in four helpers, and the failure it produced is the
    # worst kind: silent, cross-seat, and only reachable when something else fails first.
    #
    # notebook/_master-index.md and shelf/_catalog.md are rendered from state that outlives any one
    # operation -- the topics on disk, the Books' own entry files. Journaling one records a snapshot
    # of a SHARED view at the moment this operation started, and a rollback then writes that
    # snapshot back over whatever the view has legitimately become since. Seat B compiling a topic
    # while seat A's compile fails loses seat B's topic from the index: exactly the lost-topic race
    # deriving these files removed, reintroduced through the rollback door. And the restore is a
    # whole-file write outside the render lock, so a renderer can be reading it at that moment.
    #
    # The repair is to journal the AUTHORITATIVE file -- the topic's _index.md, the Book's
    # _catalog-entry.md -- and re-render afterwards inside the render lock, which is what
    # Invoke-NotebookRenderAfterRollback and Invoke-ShelfCatalogRenderAfterRollback are for.
    $rendered = @($Paths | Where-Object { (Split-Path -Leaf $_).ToLowerInvariant() -cin $script:RenderedIndexFileNames })
    if ($rendered.Count) {
        throw ("A journal cannot carry a derived index: $(@($rendered) -join ', '). " +
            'notebook/_master-index.md and shelf/_catalog.md are rendered from state this operation does not own, so ' +
            'restoring a snapshot of one overwrites whatever another seat has rendered since -- and does it with a ' +
            'whole-file write outside the render lock. Journal the authoritative file instead (the topic _index.md, ' +
            'the Book _catalog-entry.md) and re-render in the rollback with Invoke-NotebookRenderAfterRollback or ' +
            'Invoke-ShelfCatalogRenderAfterRollback. See docs/derived-indexes.md.')
    }

    $entries = @()
    foreach ($path in ($Paths | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            # Bytes, not text. A journal that round-trips prior state through a string cannot
            # reproduce a UTF-8 BOM, so restoring a BOM-carrying file changed its bytes and then
            # failed the very hash check meant to prove the restore. The verification was right;
            # what it verified against was lossy. Schema 2 stores the bytes themselves.
            $entries += [pscustomobject]@{
                path           = $path
                existed        = $true
                sha256         = Get-FileSha256 -Path $path
                content_base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
            }
        }
        else {
            # Prior absence is state too: without it, rollback would leave a created file behind.
            $entries += [pscustomobject]@{ path = $path; existed = $false; sha256 = ''; content_base64 = $null }
        }
    }

    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $name = ($BookRoot -replace '[\\/]', '-')
    $journalPath = Join-Path (Get-BookJournalDirectory -Workspace $Workspace) "$stamp-$name-$suffix.json"

    $journal = [pscustomobject]@{
        schema           = $script:BookWriteGuardSchema
        operation        = $Operation
        book_root        = $BookRoot
        operation_digest = $OperationDigest
        recorded         = [DateTime]::UtcNow.ToString('o')
        entries          = $entries
    }
    [IO.File]::WriteAllText($journalPath, ($journal | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))

    [pscustomobject]@{ journal_path = $journalPath; entry_count = $entries.Count }
}

function Restore-BookJournal {
    <#
    .SYNOPSIS
        Put every journaled path back the way it was, and verify by readback.

    .DESCRIPTION
        EVERY RESTORE IS AN ATOMIC REPLACEMENT, for the same reason every ordinary write is one.
        Until 2026-09-18 this wrote each prior body with a truncating WriteAllBytes, which meant the
        one write in the Library that happens while something has already gone wrong was also the
        one write a concurrent reader could catch half-finished. A topic's `_index.md` is the live
        case: an ordinary compile takes no render lock, so a renderer really can be scanning it
        while a failing compile in another topic restores it.

        WHAT IT WILL NOT RESTORE IS A DERIVED INDEX, and that is enforced at the other end --
        Write-BookJournal refuses to record one, so no journal reaching here can name one. Guarding
        it there rather than here is deliberate: a refusal at journal time stops the operation
        before it mutates anything, where a refusal at restore time would fire only once a rollback
        was already under way and had nowhere good to go.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$JournalPath)

    $journal = [IO.File]::ReadAllText($JournalPath) | ConvertFrom-Json
    $restored = @()
    $failures = [Collections.Generic.List[string]]::new()

    foreach ($entry in @($journal.entries)) {
        if ($entry.existed) {
            $parent = Split-Path -Parent $entry.path
            if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            # The delete branch below already passes -Force, which clears read-only. The write branch
            # did not, so a read-only file made rollback fail where deletion would have succeeded --
            # a rollback that gives up over a file attribute leaves the Book half-migrated, which is
            # strictly worse than restoring it. Found by 1.1's rename writer.
            if (Test-Path -LiteralPath $entry.path -PathType Leaf) {
                $existing = Get-Item -LiteralPath $entry.path -Force
                if ($existing.IsReadOnly) { $existing.IsReadOnly = $false }
            }
            $recorded = @($entry.PSObject.Properties.Name)
            if ($recorded -ccontains 'content_base64' -and $null -ne $entry.content_base64) {
                Write-AtomicBytes -Path $entry.path -Bytes ([Convert]::FromBase64String([string]$entry.content_base64)) | Out-Null
            }
            elseif ($recorded -ccontains 'content') {
                # Schema 1 journals stored text only. Still restorable, just not byte-exact.
                Write-AtomicText -Path $entry.path -Text ([string]$entry.content) | Out-Null
            }
            else { throw "the journal entry for $($entry.path) records no prior content" }
            $after = Get-FileSha256 -Path $entry.path
            if ($after -cne $entry.sha256) { [void]$failures.Add("$($entry.path): restored content does not match the journaled hash") }
            $restored += $entry.path
        }
        else {
            if (Test-Path -LiteralPath $entry.path -PathType Leaf) { Remove-Item -LiteralPath $entry.path -Force }
            if (Test-Path -LiteralPath $entry.path -PathType Leaf) { [void]$failures.Add("$($entry.path): should be absent but still exists") }
            $restored += $entry.path
        }
    }

    if ($failures.Count) { throw "Rollback verification failed: $($failures -join '; ')" }
    [pscustomobject]@{ journal_path = $JournalPath; restored_count = $restored.Count; verified = $true }
}

# --- Self-test ------------------------------------------------------------------------------------
if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') {
    $ErrorActionPreference = 'Stop'
    $failures = [Collections.Generic.List[string]]::new()
    function Assert([bool]$Condition, [string]$Label) { if (-not $Condition) { [void]$failures.Add($Label) } }

    $fixture = Join-Path ([IO.Path]::GetTempPath()) ("book-guard-selftest-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/demo/wiki/notes') -Force | Out-Null
    try {
        $existing = Join-Path $fixture 'shelf/demo/wiki/notes/kept.md'
        $created = Join-Path $fixture 'shelf/demo/wiki/notes/new.md'
        # Non-ASCII, built from code points because this file has no BOM and a literal em-dash in
        # this source would itself be read as ANSI. The journal is written UTF-8 with no BOM, so a
        # reader that assumes ANSI mangles every prior body it holds -- and a rollback then writes
        # the mangled text back over the reader's page. An ASCII fixture cannot see that.
        $emDash = [string][char]0x2014
        $eAcute = [string][char]0x00E9
        [IO.File]::WriteAllText($existing, "# Kept $emDash caf$eAcute`nOriginal body.`n", [Text.UTF8Encoding]::new($false))
        $existingBytes = [IO.File]::ReadAllBytes($existing)

        # 1. The lock is exclusive.
        $lock = Enter-BookLock -Workspace $fixture -BookRoot 'shelf/demo'
        Assert (Test-Path -LiteralPath $lock.path) 'lock file was not created'
        $secondFailed = $false
        try { Enter-BookLock -Workspace $fixture -BookRoot 'shelf/demo' -TimeoutSeconds 1 | Out-Null }
        catch { $secondFailed = $true }
        Assert $secondFailed 'a second writer acquired a held lock'

        # 2. A different Book is not blocked.
        $other = Enter-BookLock -Workspace $fixture -BookRoot 'shelf/other' -TimeoutSeconds 1
        Assert ($null -ne $other) 'an unrelated Book was blocked by another Book lock'
        Exit-BookLock -Lock $other

        # 3. The journal records prior content AND prior absence.
        $j = Write-BookJournal -Workspace $fixture -BookRoot 'shelf/demo' -Operation 'selftest' -Paths @($existing, $created)
        Assert ($j.entry_count -eq 2) 'journal did not record both paths'
        $parsed = [IO.File]::ReadAllText($j.journal_path) | ConvertFrom-Json
        $absent = @($parsed.entries | Where-Object { $_.path -ceq $created })[0]
        Assert (-not $absent.existed) 'prior absence was not recorded'

        # 4. Mutate the way a failed operation would, then roll back.
        [IO.File]::WriteAllText($existing, "# Kept`nCLOBBERED.`n", [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($created, "# New`nShould not survive rollback.`n", [Text.UTF8Encoding]::new($false))
        $result = Restore-BookJournal -JournalPath $j.journal_path
        Assert $result.verified 'rollback did not report verification'
        Assert ([IO.File]::ReadAllText($existing) -cmatch 'Original body') 'prior body was not restored'
        # Bytes, not text: a mangled body still matches 'Original body', because the ASCII half of it
        # survives. Only the byte comparison can tell a restored page from a corrupted one.
        Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($existing)) -ceq [Convert]::ToBase64String($existingBytes)) 'a non-ASCII prior body was not restored byte for byte'
        Assert (-not (Test-Path -LiteralPath $created)) 'a created file survived rollback'

        # 4b. A page whose FILENAME is not ASCII is restored to the path it came from.
        #     The prior body is journaled as base64, which is ASCII and therefore immune to the
        #     encoding hazard; `path` is not. A journal read that assumes ANSI mangles the path, and
        #     the rollback then writes the recovered bytes to a path that is not the one it clobbered
        #     -- leaving the reader's page clobbered and a stray file beside it. Found 2026-08-19
        #     while checking whether the store's Get-Content -Raw defect had siblings.
        $accented = Join-Path $fixture "shelf/demo/wiki/notes/caf$eAcute-$emDash.md"
        [IO.File]::WriteAllText($accented, "# Accented`nOriginal accented body.`n", [Text.UTF8Encoding]::new($false))
        $accentedBytes = [IO.File]::ReadAllBytes($accented)
        $ja = Write-BookJournal -Workspace $fixture -BookRoot 'shelf/demo' -Operation 'selftest-accented-path' -Paths @($accented)
        [IO.File]::WriteAllText($accented, "# Accented`nCLOBBERED.`n", [Text.UTF8Encoding]::new($false))
        $accentedRestored = $false
        try { $accentedRestored = (Restore-BookJournal -JournalPath $ja.journal_path).verified } catch { $accentedRestored = $false }
        Assert $accentedRestored 'rollback did not verify a page with a non-ASCII filename'
        Assert (Test-Path -LiteralPath $accented -PathType Leaf) 'the non-ASCII path was not the path restored'
        Assert ((Test-Path -LiteralPath $accented -PathType Leaf) -and ([Convert]::ToBase64String([IO.File]::ReadAllBytes($accented)) -ceq [Convert]::ToBase64String($accentedBytes))) 'a page with a non-ASCII filename was not restored byte for byte'
        Assert (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'shelf/demo/wiki/notes') -File -Filter '*.md').Count -eq 2) 'rollback left a stray file beside the page it should have restored'

        # 5. A read-only file is still restored. This is the shape a failed write leaves behind when
        #    the reason the write failed is the attribute itself.
        $locked = Join-Path $fixture 'shelf/demo/wiki/notes/locked.md'
        [IO.File]::WriteAllText($locked, "# Locked`nOriginal locked body.`n", [Text.UTF8Encoding]::new($false))
        $jr = Write-BookJournal -Workspace $fixture -BookRoot 'shelf/demo' -Operation 'selftest-readonly' -Paths @($locked)
        [IO.File]::WriteAllText($locked, "# Locked`nCLOBBERED.`n", [Text.UTF8Encoding]::new($false))
        (Get-Item -LiteralPath $locked -Force).IsReadOnly = $true
        $roResult = Restore-BookJournal -JournalPath $jr.journal_path
        Assert $roResult.verified 'rollback did not verify over a read-only file'
        Assert ([IO.File]::ReadAllText($locked) -cmatch 'Original locked body') 'a read-only file was not restored'
        (Get-Item -LiteralPath $locked -Force).IsReadOnly = $false

        # 6. A journal must reproduce bytes, not merely text. A UTF-8 BOM is the cheapest proof:
        #    a text round-trip silently drops it, and the readback check then fails on a file the
        #    rollback believed it had restored.
        $bom = Join-Path $fixture 'shelf/demo/wiki/notes/bom.md'
        [IO.File]::WriteAllText($bom, "# BOM`nOriginal BOM body.`n", [Text.UTF8Encoding]::new($true))
        $jb = Write-BookJournal -Workspace $fixture -BookRoot 'shelf/demo' -Operation 'selftest-bom' -Paths @($bom)
        [IO.File]::WriteAllText($bom, "# BOM`nCLOBBERED.`n", [Text.UTF8Encoding]::new($false))
        $bomResult = Restore-BookJournal -JournalPath $jb.journal_path
        Assert $bomResult.verified 'rollback did not verify a BOM-carrying file'
        Assert ([IO.File]::ReadAllBytes($bom)[0] -eq 0xEF) 'the BOM was dropped by rollback'
        Assert ([IO.File]::ReadAllText($bom) -cmatch 'Original BOM body') 'a BOM-carrying file was not restored'

        # 6b. ATOMIC REPLACEMENT IS REPLACEMENT, NOT TRUNCATION. This is the property the narrow
        #     render lock depends on: an `_index.md` rewrite with no render lock held is only legal
        #     if a concurrent reader cannot see a partial file. A writer that truncated in place
        #     would let the open handle below observe the NEW bytes; a rename-based publish leaves
        #     it reading the whole OLD file. Measured behaviour, not documentation: MoveFileEx with
        #     MOVEFILE_REPLACE_EXISTING succeeds over a destination shared for ReadWrite|Delete and
        #     the old handle keeps its own bytes.
        $atomicPath = Join-Path $fixture 'shelf/demo/wiki/notes/atomic.md'
        [IO.File]::WriteAllText($atomicPath, "OLD BODY $emDash caf$eAcute`n", [Text.UTF8Encoding]::new($false))
        $held = [IO.File]::Open($atomicPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            Write-AtomicText -Path $atomicPath -Text "NEW BODY`n" | Out-Null
            Assert ([IO.File]::ReadAllText($atomicPath) -ceq "NEW BODY`n") 'an atomic replacement did not land'
            $throughOldHandle = [IO.StreamReader]::new($held).ReadToEnd()
            Assert ($throughOldHandle -cmatch 'OLD BODY') 'the destination was truncated in place rather than replaced by rename'
            Assert ($throughOldHandle -cnotmatch 'NEW BODY') 'a reader holding the old file observed the new bytes; the write was not atomic'
        }
        finally { $held.Dispose() }
        Assert (-not @(Get-ChildItem -LiteralPath (Split-Path -Parent $atomicPath) -Force -Filter '.atomic-*').Count) 'an atomic replacement left its staging file behind'

        # 6c. It creates a file that does not exist yet, and writes non-ASCII as UTF-8 with no BOM --
        #     the encoding every other Library writer uses. A default-encoding write here would
        #     mangle an accented topic title on the way into a derived index.
        $atomicNew = Join-Path $fixture 'shelf/demo/wiki/notes/atomic-new.md'
        Write-AtomicText -Path $atomicNew -Text "# caf$eAcute $emDash new`n" | Out-Null
        $newBytes = [IO.File]::ReadAllBytes($atomicNew)
        Assert ($newBytes[0] -ne 0xEF) 'an atomic write added a UTF-8 BOM'
        Assert ([IO.File]::ReadAllText($atomicNew, [Text.UTF8Encoding]::new($false, $true)) -ceq "# caf$eAcute $emDash new`n") 'a non-ASCII atomic write did not round-trip as UTF-8'

        # 6d. A destination another process holds WITHOUT delete sharing is refused, and the file it
        #     refused is left exactly as it was. A writer that fell back to truncation here would
        #     trade a clean refusal for the torn read this whole mechanism exists to prevent -- and
        #     one that fell back to a cross-volume copy would trade it for a non-atomic publish.
        $blockedPath = Join-Path $fixture 'shelf/demo/wiki/notes/blocked.md'
        [IO.File]::WriteAllText($blockedPath, "UNTOUCHED`n", [Text.UTF8Encoding]::new($false))
        $blocker = [IO.File]::Open($blockedPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            $refused = $false
            try { Write-AtomicText -Path $blockedPath -Text "CLOBBERED`n" -RetryCount 2 | Out-Null } catch { $refused = $true }
            Assert $refused 'a held destination was not refused'
            Assert ([IO.File]::ReadAllText($blockedPath) -ceq "UNTOUCHED`n") 'a refused atomic write changed the destination anyway'
        }
        finally { $blocker.Dispose() }
        Assert (-not @(Get-ChildItem -LiteralPath (Split-Path -Parent $blockedPath) -Force -Filter '.atomic-*').Count) 'a refused atomic write left its staging file behind'

        # 6f. MoveFileEx RUNS FIRST, and this is the deterministic proof of it. A destination held
        #     with ReadWrite|Delete is exactly the case the two primitives disagree on: MoveFileEx
        #     refuses it, File.Replace serves it. With RetryCount 1 the fallback is unreachable, so
        #     a refusal here means MoveFileEx was tried first -- and a success would mean the order
        #     had been swapped and the unlink window brought back.
        $orderPath = Join-Path $fixture 'shelf/demo/wiki/notes/order.md'
        [IO.File]::WriteAllText($orderPath, "ORIGINAL`n", [Text.UTF8Encoding]::new($false))
        $shared = [IO.File]::Open($orderPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            $firstRefused = $false
            try { Write-AtomicText -Path $orderPath -Text "SWAPPED`n" -RetryCount 1 | Out-Null } catch { $firstRefused = $true }
            Assert $firstRefused 'a single-attempt write over a delete-shared destination succeeded, so File.Replace is running before MoveFileEx'
            Assert ([IO.File]::ReadAllText($orderPath) -ceq "ORIGINAL`n") 'the refused single-attempt write changed the destination'
        }
        finally { $shared.Dispose() }
        # And with the retries it is entitled to, the same write IS served -- by the fallback. A
        # delete-shared holder must be a delay, not a permanent refusal.
        $shared = [IO.File]::Open($orderPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            Write-AtomicText -Path $orderPath -Text "SERVED`n" | Out-Null
            Assert ([IO.File]::ReadAllText($orderPath) -ceq "SERVED`n") 'the fallback did not serve a delete-shared destination'
        }
        finally { $shared.Dispose() }

        # 6e. THE RETRYING READER IS THE OTHER HALF OF THE CONTRACT. A held file is retried and then
        #     reported with the path in the message, rather than surfacing as a bare sharing
        #     violation from somewhere deep inside an unrelated operation.
        $readable = Join-Path $fixture 'shelf/demo/wiki/notes/readable.md'
        [IO.File]::WriteAllText($readable, "# Readable $emDash caf$eAcute`n", [Text.UTF8Encoding]::new($false))
        Assert (([Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $readable))) -ceq "# Readable $emDash caf$eAcute`n") 'the retrying reader did not return the file bytes'
        $exclusive = [IO.File]::Open($readable, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        try {
            $readRefused = $false
            $readMessage = ''
            try { Read-AtomicBytes -Path $readable -RetryCount 2 | Out-Null } catch { $readRefused = $true; $readMessage = $_.Exception.Message }
            Assert $readRefused 'an exclusively held file was not reported as unreadable'
            Assert ($readMessage -cmatch [regex]::Escape($readable)) 'the read refusal does not name the file it could not read'
        }
        finally { $exclusive.Dispose() }

        # 6g. A JOURNAL REFUSES A DERIVED INDEX, AND ACCEPTS EVERYTHING ELSE. Both directions,
        #     because only the second one stops the rule firing on correct code: `_catalog-entry.md`
        #     is a Book's own authored authority and Rename-ShelfBook journals it on purpose, and a
        #     topic's `_index.md` is the authority the master index is DERIVED FROM rather than a
        #     derived file itself. A guard that caught those would block the repair it exists to
        #     require.
        #
        #     The case spellings are deliberate: NTFS is case-insensitive, so `_Catalog.md` names the
        #     same file a lowercase rule is written for, and an ordinal comparison would wave it
        #     through.
        New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/demo-topic') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/demo') -Force | Out-Null
        $masterIndex = Join-Path $fixture 'notebook/_master-index.md'
        $shelfCatalog = Join-Path $fixture 'shelf/_catalog.md'
        [IO.File]::WriteAllText($masterIndex, "# Notebook`n", [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($shelfCatalog, "# Shelf`n", [Text.UTF8Encoding]::new($false))
        foreach ($derivedPath in @($masterIndex, $shelfCatalog, (Join-Path $fixture 'shelf/_Catalog.md'))) {
            $journalRefused = $false
            $journalMessage = ''
            try { Write-BookJournal -Workspace $fixture -BookRoot 'shelf/demo' -Operation 'selftest-derived' -Paths @($derivedPath) | Out-Null }
            catch { $journalRefused = $true; $journalMessage = $_.Exception.Message }
            Assert $journalRefused "a journal accepted the derived index $derivedPath"
            Assert ($journalMessage -cmatch 'derived index') "the refusal for $derivedPath does not say what it refused"
        }
        # The safe forms. A derived name buried in a DIRECTORY component is one of them: only the
        # leaf decides, so a page that happens to live under a folder called `_catalog.md` is a page.
        $topicIndex = Join-Path $fixture 'notebook/demo-topic/_index.md'
        $entryFile = Join-Path $fixture 'shelf/demo/_catalog-entry.md'
        [IO.File]::WriteAllText($topicIndex, "# Demo Topic`n", [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($entryFile, "## Demo`n", [Text.UTF8Encoding]::new($false))
        $safeJournal = Write-BookJournal -Workspace $fixture -BookRoot 'shelf/demo' -Operation 'selftest-authoritative' `
            -Paths @($topicIndex, $entryFile, (Join-Path $fixture 'shelf/_catalog.md/page.md'))
        Assert ($safeJournal.entry_count -eq 3) 'the journal refused an authoritative path it must accept'

        # 6h. AN EMPTY -Paths IS LEGAL. Archive and Remove record no file bytes at all -- their
        #     authority rides inside the directory they move -- and a mandatory parameter that
        #     rejected an empty array would push them back to journaling the catalog.
        $emptyJournal = Write-BookJournal -Workspace $fixture -BookRoot 'shelf/demo' -Operation 'selftest-empty' -Paths @()
        Assert ($emptyJournal.entry_count -eq 0) 'an empty journal recorded entries'
        Assert ((Restore-BookJournal -JournalPath $emptyJournal.journal_path).restored_count -eq 0) 'restoring an empty journal did not report zero'

        # 6i. A RESTORE IS A REPLACEMENT, NOT A TRUNCATION. The same held-handle proof as 6b, applied
        #     to the one write that happens after something has already gone wrong. It used to be a
        #     truncating WriteAllBytes, so a renderer scanning a topic index while a failing compile
        #     rolled it back could read a half file -- and an ordinary compile takes no render lock,
        #     which is exactly what makes that reachable. Reasoning cannot see this; only a reader
        #     holding the old handle across the write can.
        $rollbackPath = Join-Path $fixture 'notebook/demo-topic/rollback.md'
        [IO.File]::WriteAllText($rollbackPath, "PRIOR BODY $emDash caf$eAcute`n", [Text.UTF8Encoding]::new($false))
        $jRollback = Write-BookJournal -Workspace $fixture -BookRoot 'shelf/demo' -Operation 'selftest-restore-atomic' -Paths @($rollbackPath)
        [IO.File]::WriteAllText($rollbackPath, "CLOBBERED BY THE FAILED RUN`n", [Text.UTF8Encoding]::new($false))
        $duringRollback = [IO.File]::Open($rollbackPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            Restore-BookJournal -JournalPath $jRollback.journal_path | Out-Null
            Assert ([IO.File]::ReadAllText($rollbackPath, [Text.UTF8Encoding]::new($false, $true)) -ceq "PRIOR BODY $emDash caf$eAcute`n") 'the atomic restore did not land the prior body'
            $seenByReader = [IO.StreamReader]::new($duringRollback, [Text.UTF8Encoding]::new($false, $true)).ReadToEnd()
            Assert ($seenByReader -cmatch 'CLOBBERED') 'the rollback truncated the destination in place rather than replacing it by rename'
            Assert ($seenByReader -cnotmatch 'PRIOR BODY') 'a reader holding the file across a rollback observed the restored bytes; the restore was not atomic'
        }
        finally { $duringRollback.Dispose() }
        Assert (-not @(Get-ChildItem -LiteralPath (Split-Path -Parent $rollbackPath) -Force -Filter '.atomic-*').Count) 'a rollback left its staging file behind'

        Exit-BookLock -Lock $lock
        Assert (-not (Test-Path -LiteralPath $lock.path)) 'lock file was not released'

        # 7. Spelling a Book root differently must not mint a second lock for the same Book.
        #    'shelf\demo' and 'shelf/demo' are one Book; two lock files for it would exclude
        #    nobody, which is the failure that looks exactly like safety.
        $spelled = Enter-BookLock -Workspace $fixture -BookRoot 'shelf/spelled' -TimeoutSeconds 2
        Assert ($spelled.lock_name -ceq 'shelf-spelled') "the lock name normalised to $($spelled.lock_name)"
        $collided = $false
        try { Enter-BookLock -Workspace $fixture -BookRoot 'shelf\spelled/' -TimeoutSeconds 1 | Out-Null }
        catch { $collided = $true }
        Assert $collided 'a differently spelled Book root took a second lock for the same Book'
        Exit-BookLock -Lock $spelled

        # 6. The lock is reusable after release.
        $again = Enter-BookLock -Workspace $fixture -BookRoot 'shelf/demo' -TimeoutSeconds 2
        Assert ($null -ne $again) 'lock could not be reacquired after release'
        Exit-BookLock -Lock $again

        # 8. A RELEASE THAT DOES NOT RELEASE MUST SAY SO. Until 2026-09-06 Exit-BookLock removed the
        #    lock file error-suppressed AND unverified, so a failed release was indistinguishable
        #    from a clean one. That is why the shared manifest rebuild which left a stale lock and a
        #    dirty Book on 2026-09-05 could not be diagnosed from its own journals.
        $stuckPath = Join-Path (Get-BookLockDirectory -Workspace $fixture) 'shelf-stuck.lock'
        # Held with FileShare::None by a handle Exit-BookLock does not own, so the removal fails the
        # way a scanner, an indexer, or a crashed sibling makes it fail.
        $holder = [IO.File]::Open($stuckPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $stuckLock = [pscustomobject]@{
                path      = $stuckPath
                stream    = [IO.MemoryStream]::new()
                writer    = [IO.StringWriter]::new()
                book_root = 'shelf/stuck'
                lock_name = 'shelf-stuck'
            }
            Exit-BookLock -Lock $stuckLock -WarningVariable stuckWarnings -WarningAction SilentlyContinue
            $stuckText = (@($stuckWarnings) -join ' ')
            Assert (@($stuckWarnings).Count -ge 1) 'a lock file that survived release was not reported at all'
            Assert ($stuckText -cmatch 'NOT released') 'the release warning does not say the lock is still held'
            Assert ($stuckText -cmatch 'shelf/stuck') 'the release warning does not name the Book'
            Assert ($stuckText -cmatch [regex]::Escape($stuckPath)) 'the release warning does not name the lock path to remove'
            Assert (Test-Path -LiteralPath $stuckPath -PathType Leaf) 'the fixture did not actually hold the lock file, so this case proved nothing'
        }
        finally {
            $holder.Dispose()
            Remove-Item -LiteralPath $stuckPath -Force -ErrorAction SilentlyContinue
        }

        # 9. And a release that DOES release stays silent. A warning on every exit would be noise
        #    that trains the operator to ignore the one release that mattered.
        $quiet = Enter-BookLock -Workspace $fixture -BookRoot 'shelf/quiet' -TimeoutSeconds 2
        Exit-BookLock -Lock $quiet -WarningVariable quietWarnings -WarningAction SilentlyContinue
        Assert (-not @($quietWarnings).Count) "a clean release warned anyway: $(@($quietWarnings) -join ' ')"
        Assert (-not (Test-Path -LiteralPath $quiet.path)) 'a clean release left the lock file behind'

        # 10. A null handle is REFUSED at the parameter binding, not silently ignored. The
        #     function's own `if ($null -eq $Lock) { return }` is unreachable through binding, so
        #     what actually holds this is the `if ($null -ne $lock)` guard at each call site -- the
        #     two manifest updaters included, where an acquire failure now returns before the
        #     window's finally is ever reached. Pinned so a later 'simplification' of those guards
        #     fails here rather than in a finally, where the throw would replace a real diagnosis.
        $nullRefused = $false
        try { Exit-BookLock -Lock $null } catch { $nullRefused = $true }
        Assert $nullRefused 'a null lock handle was accepted; the call-site guards are what hold this, so it must stay refused'
    }
    finally {
        Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($failures.Count) {
        [Console]::Error.WriteLine("BookWriteGuard self-test FAILED: $($failures -join '; ')")
        exit 1
    }
    Write-Host 'BookWriteGuard self-test passed (46 checks).'
    exit 0
}
