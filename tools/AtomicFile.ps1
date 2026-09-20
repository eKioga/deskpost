<#
.SYNOPSIS
    Atomic whole-file replacement and the matching retrying read. Dot-sourced; never invoked directly.

.DESCRIPTION
    THESE TWO PRIMITIVES ARE ONE CONTRACT AND THEY LIVE TOGETHER. Write-AtomicText guarantees a
    reader never sees a partial file; Read-AtomicBytes is what makes the guarantee usable, because
    the rename-over holds the destination for an instant and a reader arriving in that instant is
    refused rather than served a half file. Using one without the other is the bug.

    WHY THIS FILE EXISTS SEPARATELY FROM BookWriteGuard.ps1, WHICH HELD BOTH UNTIL 2026-09-09.
    `BookRootSchema.ps1` owns seat state -- where a seat's Desk files live and what shape their
    content has -- and on 2026-09-09 that grew to include the seat BINDING, which is written
    atomically under the registry lock and read by two hooks and the reader adapter that hold no
    lock at all. So the schema needs Read-AtomicBytes. Pulling all of BookWriteGuard.ps1 in to get it
    would put per-Book locking and pre-write journaling into the load path of every read-only guard,
    which is the wrong dependency in the wrong direction. These three functions have no dependencies
    of their own, so they are the layer both files can sit on.

    THIS FILE DOT-SOURCES NOTHING, and must not start: `BookRootSchema.ps1` and `BookWriteGuard.ps1`
    both dot-source it, and one import here would put a cycle under nearly every helper in the
    repository.
#>

Set-StrictMode -Version Latest

function Initialize-AtomicFileNative {
    <#
    .SYNOPSIS
        Compile the MoveFileEx binding, once per session, on first use.
    #>
    if (-not ('LibraryAtomicFile.Native' -as [type])) {
        Add-Type -Namespace 'LibraryAtomicFile' -Name 'Native' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern bool MoveFileEx(string lpExistingFileName, string lpNewFileName, int dwFlags);
'@
    }
}

function Write-AtomicText {
    <#
    .SYNOPSIS
        Replace one file's whole content as a single atomic operation. Never truncates in place.

    .DESCRIPTION
        A derived index is read by other processes while it is being rewritten, and a plain
        WriteAllText truncates the destination before it writes -- so a reader arriving in that
        window sees an empty or half-written index and believes it. That is not a hypothetical
        ordering problem: it is the reason a NARROW render lock is safe at all. The render lock is
        taken only when a topic's visibility or H1 actually changes, which means the ordinary
        `_index.md` rewrite happens with no render lock held, which means a renderer really can be
        reading the file at that moment. Atomic replacement is what makes that legal.

        HOW: the bytes go to a uniquely named temporary file in the DESTINATION'S OWN DIRECTORY --
        same volume, so the publish is a rename rather than a copy -- and the rename then swaps the
        two entries. A reader either sees the whole old file or the whole new one, and a crash
        leaves the old file untouched.

        Staging names are unique, never a fixed `.tmp`: two writers sharing one staging name is a
        collision with no lock behind it, and the second writer would publish the first one's bytes.

        TWO PRIMITIVES, BECAUSE MEASUREMENT SHOWED NEITHER IS SUFFICIENT ALONE. Both were run
        against 400 rewrites of one file while another process read it as fast as it could,
        2026-09-07:

            File.Replace   118,498 reads   0 partial   11,047 sharing errors   443 file-NOT-FOUND
            MoveFileEx     218,700 reads   0 partial      303 sharing errors     0 file-not-found

        Neither ever yields a partial file, so both satisfy the letter of the rule. The difference
        is what a reader is told when it loses the race. File.Replace unlinks the destination before
        it renames, so 443 readers were told the file did not exist -- and a reader that concludes a
        topic index is missing is a reader about to report a perfectly healthy topic as degenerate.
        MoveFileEx with MOVEFILE_REPLACE_EXISTING renames over the destination in one step, so the
        path is never absent, and it is refused thirty-six times less often.

        But MoveFileEx refuses ACCESS_DENIED against a destination another process holds open at
        all -- even one sharing ReadWrite|Delete, which File.Replace serves happily. So MoveFileEx
        is tried first and File.Replace is the fallback, engaged only once half the attempts are
        spent. A transient holder is therefore handled with no unlink window at all, and a
        persistent delete-sharing holder is served rather than turned into a failed write. A
        destination held exclusively is refused by both, which is the correct answer.

        THE FALLBACK'S UNLINK CANNOT BE ENGINEERED AWAY, so it is covered instead. Passing a real
        backup path rather than a null one was measured on the same rig and made no difference --
        444 not-found reads with a null backup, 496 with a real one -- so File.Replace unlinks
        either way. What makes that acceptable is Read-AtomicBytes below: it retries IOException,
        which FileNotFoundException derives from, so the window is invisible to every Library reader
        even on the rare occasions the fallback runs.

        WHICH PRIMITIVE RUNS FIRST IS PINNED BY A TEST, because "simplify this to File.Replace"
        would be a plausible-looking change that quietly reintroduces the unlink. Self-test case 6f
        holds a delete-shared destination and requires a single-attempt write to FAIL: MoveFileEx
        cannot serve it, and with one attempt the fallback is not reached. A File.Replace-first
        implementation would succeed there instead.

        THE RETRY IS FOR A HOLDER, NOT FOR A RACE. An unbounded retry would hide a genuine holder,
        and no retry at all would fail a write for the duration of one virus scan.

        Add-Type IS DELIBERATELY LAZY. This file is dot-sourced by nearly every helper, including
        ones that never write a derived index, and compiling a P/Invoke stub at load time would put
        that cost on all of them.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [int]$RetryCount = 8
    )

    # UTF-8 with no BOM is the Library's one encoding, and it is applied HERE rather than in the
    # bytes primitive below: a caller holding bytes already has an encoding decision behind them,
    # and re-deciding it for them is how a BOM gets dropped from a file that had one.
    Write-AtomicBytes -Path $Path -Bytes ([Text.UTF8Encoding]::new($false).GetBytes($Text)) -RetryCount $RetryCount
}

function Write-AtomicBytes {
    <#
    .SYNOPSIS
        Replace one file's whole content, as bytes, by rename. The primitive Write-AtomicText wraps.

    .DESCRIPTION
        SPLIT OUT OF Write-AtomicText ON 2026-09-18 WITH NO CHANGE TO ITS BEHAVIOUR, because the
        rollback path needs it and rollback restores BYTES. `Restore-BookJournal` holds a prior body
        as base64 precisely so a UTF-8 BOM survives the round trip, and routing that through a text
        writer would re-encode it -- which is the lossiness schema 2 was introduced to remove. The
        measured choice of primitive, the retry, the fallback and their reasoning all live in
        Write-AtomicText's description above and apply unchanged here; this is the same code with a
        byte[] payload rather than a string.

        AN EMPTY PAYLOAD IS A FIRST-CLASS INPUT. A Desk file and a fresh derived index are both
        created empty, so -Bytes accepts an empty array rather than refusing it as a missing value.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes,
        [int]$RetryCount = 8
    )

    $directory = Split-Path -Parent $Path
    if ([string]::IsNullOrEmpty($directory)) { throw "Write-AtomicBytes needs a rooted path; '$Path' has no directory." }
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw "Write-AtomicBytes cannot publish into a missing directory: $directory" }

    Initialize-AtomicFileNative

    $staging = Join-Path $directory ('.atomic-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllBytes($staging, $Bytes)
        $attempts = [Math]::Max(1, $RetryCount)
        $fallbackFrom = [Math]::Max(1, [int][Math]::Ceiling($attempts / 2.0))
        $lastError = ''
        for ($attempt = 0; $attempt -lt $attempts; $attempt++) {
            # MOVEFILE_REPLACE_EXISTING, and no MOVEFILE_COPY_ALLOWED: a cross-volume copy would
            # not be atomic, and the staging file sits in the destination's own directory precisely
            # so that never arises. A refusal is a refusal, never a silent fallback to copying.
            if ([LibraryAtomicFile.Native]::MoveFileEx($staging, $Path, 1)) { return $Path }
            $lastError = "MoveFileEx reported Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
            if ($attempt -ge $fallbackFrom -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
                try {
                    # [NullString]::Value, not $null: PowerShell converts a bare $null argument to
                    # an empty string, and File.Replace rejects '' as an illegal backup path.
                    [IO.File]::Replace($staging, $Path, [NullString]::Value)
                    return $Path
                }
                catch { $lastError = "$lastError; File.Replace also failed: $($_.Exception.Message)" }
            }
            Start-Sleep -Milliseconds 120
        }
        throw "Could not atomically replace '$Path' after $attempts attempt(s); it is held by another process. The file was NOT changed. $lastError"
    }
    finally {
        # The staging file survives only a failed publish, and leaving it behind would make the next
        # directory scan see a stray file the renderer has no rule for.
        if (Test-Path -LiteralPath $staging -PathType Leaf) { Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue }
    }
}

function Read-AtomicBytes {
    <#
    .SYNOPSIS
        Read a file that another process may be atomically replacing. Returns its bytes.

    .DESCRIPTION
        The other half of the contract. Write-AtomicText guarantees a reader never sees a PARTIAL
        file; it cannot guarantee the reader is never refused, because a rename-over holds the
        destination for an instant and a reader arriving in that instant gets a sharing violation.
        Measured at roughly one read in seven hundred under continuous rewriting -- rare, and
        certain to happen eventually.

        So every Library reader of a derived index goes through this. Without it the failure mode is
        not a wrong answer but an occasional unexplained refusal in the middle of an unrelated
        operation, which is the kind of thing that gets diagnosed as flakiness for a year.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$RetryCount = 12
    )

    $lastError = $null
    for ($attempt = 0; $attempt -lt [Math]::Max(1, $RetryCount); $attempt++) {
        # RETURNED BEHIND A COMMA, or an EMPTY file comes back as $null. `return <expr>` writes to
        # the output pipeline and the pipeline UNROLLS a collection, so byte[0] reaches the caller
        # as nothing at all. Every caller hands the result straight to GetString, ToBase64String or
        # .Length, and each of those then reports on a null array rather than on the file -- a red
        # that names neither the path nor the emptiness. Eighteen call sites depended on it, and the
        # empty case is reachable from most: a Desk file and a fresh derived index are both created
        # empty. Found 2026-09-09 by seat.lifecycle retiring a seat nothing had been opened at.
        #
        # The comma also makes this hand back a real byte[] rather than the Object[] the unroll
        # produced, so `$bytes[0]` and `.Length` mean what they say at the call site.
        try { return , ([IO.File]::ReadAllBytes($Path)) }
        catch [IO.IOException] {
            # FileNotFoundException derives from IOException, so a genuinely absent file would be
            # retried too. That is correct here and it is cheap: this reader is only ever pointed at
            # a file the caller has already decided must exist, and the caller's own Test-Path is
            # what distinguishes "absent" from "being replaced".
            $lastError = $_
            Start-Sleep -Milliseconds 60
        }
    }
    throw "Could not read '$Path' after $RetryCount attempt(s): $($lastError.Exception.Message)"
}
