<#
.SYNOPSIS
    The serialized renderer for notebook/_master-index.md, and the rules for a topic that cannot be
    rendered. Dot-sourced; never invoked directly.

.DESCRIPTION
    PLAN-multi-desk.md Release 1, steps 1 and 2. They are one file because they are one critical
    section: the rules about a degenerate topic are enforced by the same scan that produces the
    index, and separating them would leave a renderer that can be handed a state it has no rule for.

    WHY THE INDEX IS DERIVED. It used to be stored, and every writer appended to whatever it found.
    Deriving it is not by itself enough -- a renderer that snapshots {a}, is overtaken by one that
    creates b and renders {a,b}, then writes its stale {a}, has lost a topic. So the scan, the write
    and the readback happen together under one lock, and nothing else may.

    WHY THE CRITICAL SECTION IS TINY, AND WHAT THAT COSTS. Everything expensive -- staging, page
    generation, journaling, hashing, network reads -- happens before Invoke-NotebookRender is
    called. The lock covers only the caller's final commit (a new topic's promotion, or an H1's
    rewrite), the directory-and-H1 scan, the atomic master write, and its readback. That is what
    lets two compiles into two different topics run at the same time, which is the whole point.

    THE PRICE OF THAT NARROWNESS IS PAID BY ATOMIC WRITES, NOT BY THE LOCK. A writer whose topic H1
    is unchanged legitimately never takes this lock at all -- so a renderer really can be reading a
    topic index while another writer rewrites it. Every topic _index.md write therefore goes through
    Write-AtomicText, unconditionally, whether or not the render lock is involved. Skip that and the
    narrow lock is bought with a torn read.

    PARTICIPATION IS TRIGGERED BY H1 MUTATION AS WELL AS VISIBILITY. The index derives both which
    topic directories exist and what each one's index calls itself, so editing an H1 invalidates the
    index without changing which topics exist. Both are commits; both take the lock.

    THE BOM IS DELIBERATE AND IS NOW ABSENT. The file carried a UTF-8 BOM until 2026-09-07 because
    Reset-LocalNotebook.ps1 wrote the scaffold with Set-Content -Encoding UTF8, which adds one in
    Windows PowerShell 5.1. Every other Library writer uses UTF8Encoding($false). A rendered file
    has to have exactly one byte sequence for a readback to mean anything, so the renderer picks the
    encoding the rest of the Library already uses and the first regeneration drops the BOM once.
    notebook/ is gitignored, so that one-time change is not a tracked diff.
#>

Set-StrictMode -Version Latest

# Enter-BookLock and Write-AtomicText. Dot-sourced here rather than assumed from the caller, so the
# module is complete when it is self-invoked with -Render; every writer already loads it too, and
# loading it twice only redefines the same functions.
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')

# The render lock is its own lock class, not a Book and not a topic. It is the last lock in the
# order PLAN-multi-desk.md step 9a specifies, so a holder of it must acquire nothing else.
$script:NotebookRenderLockRoot = 'render/notebook-master-index'

$script:NotebookMasterHeading = '# Notebook Index'
$script:NotebookEmptyParagraph = 'This Notebook is ready for a new topic. Add topic folders here as material is compiled.'

function Get-NotebookRenderLockRoot { $script:NotebookRenderLockRoot }

function Get-NotebookTopicLockRoot([string]$Topic) {
    if ([string]::IsNullOrWhiteSpace($Topic)) { throw 'A Notebook topic lock needs a topic slug.' }
    "notebook/$Topic"
}

function Get-NotebookMasterIndexPath([string]$Workspace) {
    Join-Path (Join-Path $Workspace 'notebook') '_master-index.md'
}

function Get-NotebookTopicIndexPath([string]$Workspace, [string]$Topic) {
    Join-Path (Join-Path (Join-Path $Workspace 'notebook') $Topic) '_index.md'
}

function Get-NotebookEmptyMasterIndexText {
    "$script:NotebookMasterHeading`n`n$script:NotebookEmptyParagraph`n"
}

function Get-NotebookTopicHeading {
    <#
    .SYNOPSIS
        The one column-zero H1 a topic index must carry, or a refusal naming what is wrong with it.

    .DESCRIPTION
        EXACTLY ONE, AT COLUMN ZERO. Zero H1s leaves the topic with no label the index could show;
        two leaves the renderer choosing between them, which is a silent decision about what the
        reader sees.

        A second-level heading is not an H1. A space or tab is required after the single hash, so a
        '##' subheading and a hashtag are both correctly ignored.

        FENCED CODE IS SKIPPED, AND FINDING THAT OUT COST A REJECTION THE RENDERER SHOULD NOT MAKE.
        The first version anchored on start-of-file-or-newline and counted a column-zero hash
        wherever it appeared, so a topic index containing a fenced Markdown example was refused --
        and because a refusal here fails the render for the WHOLE Notebook, one legitimate example
        in one topic would have hidden every other topic from the reader. A narrow cause must not
        have a wide effect. So the scan is line-based and tracks fence state: three or more
        backticks or tildes, indented up to three spaces, toggle it, exactly as Markdown says.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$IndexPath)

    if (-not (Test-Path -LiteralPath $IndexPath -PathType Leaf)) { throw "the topic index is missing: $IndexPath" }
    # Strict UTF-8, and the BOM stripped rather than counted as part of the first heading: a BOM
    # ahead of the hash would make the first line fail to match and report a well-formed index as
    # headingless.
    $text = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $IndexPath))
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    Get-NotebookTopicHeadingFromText -Text $text -Label $IndexPath
}

function Get-NotebookTopicHeadingFromText {
    <#
    .SYNOPSIS
        The same rule as Get-NotebookTopicHeading, applied to text a writer has not written yet.

    .DESCRIPTION
        A writer needs to know whether the index it is ABOUT to write changes the heading, and that
        question cannot be asked of a file. One rule, two entry points -- so a writer's idea of
        "the H1 changed" can never disagree with the renderer's idea of what the H1 is.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [string]$Label = 'the topic index'
    )

    $headings = [Collections.Generic.List[string]]::new()
    $fence = $null
    foreach ($line in @($Text -split "`r?`n")) {
        $fenceMark = [regex]::Match($line, '^ {0,3}(`{3,}|~{3,})')
        if ($fenceMark.Success) {
            $marker = $fenceMark.Groups[1].Value.Substring(0, 1)
            if ($null -eq $fence) { $fence = $marker }
            elseif ($fence -ceq $marker) { $fence = $null }
            continue
        }
        if ($null -ne $fence) { continue }
        $headingMatch = [regex]::Match($line, '^#[ \t]+(.+)$')
        if ($headingMatch.Success) { [void]$headings.Add($headingMatch.Groups[1].Value) }
    }
    $headings = @($headings)
    if ($headings.Count -eq 0) { throw "the topic index has no column-zero H1: $Label" }
    if ($headings.Count -gt 1) { throw "the topic index carries $($headings.Count) column-zero H1 headings and must carry exactly one: $Label" }
    $heading = $headings[0].Trim()
    if ([string]::IsNullOrWhiteSpace($heading)) { throw "the topic index's H1 is empty: $Label" }
    # A label carrying a pipe or a closing double bracket would break the wiki link it is rendered
    # into, and the broken link would look like the renderer's fault rather than the heading's.
    if ($heading.Contains('|') -or $heading.Contains(']]')) { throw "the topic index's H1 cannot be rendered as a link label: $Label" }
    $heading
}

function Get-NotebookTopicInventory {
    <#
    .SYNOPSIS
        Every topic directory under notebook/, with its heading, ordered by slug.

    .DESCRIPTION
        -Force, so a hidden directory is not silently omitted -- an omitted topic is a topic the
        reader cannot see and a reset would not offer to triage.

        A REPARSE POINT IS REFUSED, NOT FOLLOWED. A junction under notebook/ would let the index
        advertise, and a reset delete, material that lives somewhere else entirely. Same refusal the
        Shelf writers already make.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$NotebookRoot)

    if (-not (Test-Path -LiteralPath $NotebookRoot -PathType Container)) { throw "the Notebook directory is missing: $NotebookRoot" }
    $topics = [Collections.Generic.List[object]]::new()
    foreach ($directory in @(Get-ChildItem -LiteralPath $NotebookRoot -Directory -Force)) {
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq [IO.FileAttributes]::ReparsePoint) {
            throw "notebook/$($directory.Name) is a reparse point; the Notebook index refuses to render material that lives outside the workspace."
        }
        $indexPath = Join-Path $directory.FullName '_index.md'
        [void]$topics.Add([pscustomobject]@{
            slug       = $directory.Name
            heading    = Get-NotebookTopicHeading -IndexPath $indexPath
            index_path = $indexPath
        })
    }
    # Ordinal by slug. Sort-Object's default comparer is culture-sensitive, so two machines could
    # order the same topics differently and each would then read the other's render as a change.
    @(@($topics) | Sort-Object -Property @{ Expression = { $_.slug }; Ascending = $true })
}

function Get-NotebookMasterIndexText {
    <#
    .SYNOPSIS
        The master index the topics on disk imply. Pure: it reads, and writes nothing.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$NotebookRoot)

    $topics = @(Get-NotebookTopicInventory -NotebookRoot $NotebookRoot)
    if (-not $topics.Count) { return (Get-NotebookEmptyMasterIndexText) }
    $lines = @($topics | ForEach-Object { "- [[$($_.slug)/_index|$($_.heading)]]" })
    "$script:NotebookMasterHeading`n`n" + (($lines -join "`n") + "`n")
}

function Invoke-NotebookRender {
    <#
    .SYNOPSIS
        THE CRITICAL SECTION. Commit a visibility or H1 change and re-render the master index.

    .DESCRIPTION
        Call this with everything expensive already done. -Commit is the caller's final, cheap act
        of making its change visible: an atomic directory move for a new topic, or one
        Write-AtomicText of an existing topic's index whose H1 changed. It runs INSIDE the lock
        because a commit outside it is exactly the overtaking that loses a topic.

        A caller whose topic already exists and whose H1 is unchanged must not call this at all. Its
        writes are atomic file replacements under its own topic lock, and the rendered index they
        would produce is byte-identical to the one already on disk.

        THE COMMIT TAKES ITS VALUES AS ARGUMENTS, NOT FROM A CLOSURE. GetNewClosure() was the first
        answer and it is a trap in this codebase: it copies every variable in scope into the
        closure's own scope, INCLUDING the caller's script parameters, and re-applying a
        [ValidateSet] attribute to a copied empty value throws "the attribute cannot be added
        because variable <name> ... would no longer be valid". Publish-BookCopy.ps1 has exactly such
        a parameter, so the failure appeared only in the one caller that had one. Dynamic scoping
        would work too, and would break silently the day a local in here shadows a caller's
        variable. Explicit arguments cannot do either.

        THE SCAN FAILS BEFORE THE WRITE, SO A DEGENERATE TOPIC LEAVES THE PREVIOUS INDEX ALONE. If
        any topic is missing its index, or that index has no single H1, Get-NotebookMasterIndexText
        throws and nothing has been written yet. What the reader keeps is the last index that was
        true, not an empty one.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [scriptblock]$Commit,
        [object[]]$CommitArgument = @(),
        [int]$TimeoutSeconds = 20
    )

    $notebookRoot = Join-Path $Workspace 'notebook'
    $masterPath = Get-NotebookMasterIndexPath -Workspace $Workspace
    $lock = Enter-BookLock -Workspace $Workspace -BookRoot $script:NotebookRenderLockRoot -TimeoutSeconds $TimeoutSeconds
    $enteredUtc = [DateTime]::UtcNow
    try {
        $committed = $null
        if ($null -ne $Commit) { $committed = & $Commit @CommitArgument }

        try { $text = Get-NotebookMasterIndexText -NotebookRoot $notebookRoot }
        catch {
            throw ("The Notebook master index was NOT changed, because a topic on disk cannot be rendered: " +
                "$($_.Exception.Message). Every directory under notebook/ must hold an _index.md carrying exactly " +
                "one column-zero H1, because that heading is the label the index shows. Repair or remove that " +
                "directory: until it is renderable, no Notebook write that changes which topics exist can " +
                "complete, since the index would have to leave out a topic that is really there.")
        }
        Write-AtomicText -Path $masterPath -Text $text | Out-Null

        $readback = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $masterPath))
        if ($readback -cne $text) { throw 'The rendered Notebook master index failed readback verification.' }

        # The window the lock was actually HELD for -- not the window the caller waited plus held,
        # which is what a caller timing its own call would measure. Two serialized renders have
        # disjoint held windows and overlapping call windows, so only this pair can say whether the
        # critical section stayed narrow.
        $exitUtc = [DateTime]::UtcNow
        [pscustomobject]@{
            master_index_path = 'notebook/_master-index.md'
            topic_count       = @([regex]::Matches($text, '(?m)^- \[\[')).Count
            rendered          = $true
            commit_result     = $committed
            lock_entered_utc  = $enteredUtc.ToString('o')
            lock_exit_utc     = $exitUtc.ToString('o')
            lock_held_ms      = [int]($exitUtc - $enteredUtc).TotalMilliseconds
        }
    }
    finally { Exit-BookLock -Lock $lock }
}

function Invoke-NotebookRenderAfterRollback {
    <#
    .SYNOPSIS
        Re-derive the master index once a rollback has put the topics back. The rollback's renderer.

    .DESCRIPTION
        THE ROLLBACK'S LAST STEP, AND IT IS A RENDER RATHER THAN A RESTORE. A failed Notebook write
        rolls its own article and topic index back from the journal, and those are the AUTHORITY the
        master index is derived from -- so the index is put right by re-deriving it, never by
        writing back a snapshot the journal took before the run started. Write-BookJournal refuses
        to carry such a snapshot at all; this is the other half of that refusal.

        CALL IT AFTER the journal restore and after any partially promoted topic directory has been
        removed, because a topic directory with no `_index.md` is exactly what the scan refuses.

        IT REPORTS ITS OWN FAILURE SEPARATELY. If the Notebook cannot be rendered -- most often
        because some OTHER topic on disk is degenerate -- the files this rollback restored are
        nonetheless back, and a caller reporting one flat "rollback FAILED" would hide that. So the
        message says what did land and names the one command that finishes the job.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [int]$TimeoutSeconds = 20
    )

    try { Invoke-NotebookRender -Workspace $Workspace -TimeoutSeconds $TimeoutSeconds }
    catch {
        throw ("the journaled files were restored, but notebook/_master-index.md could not be re-derived afterwards: " +
            "$($_.Exception.Message) Run tools/NotebookIndex.ps1 -Render -WorkspacePath . once that is repaired; " +
            'until then the master index still describes the Notebook as it was before this run.')
    }
}

function Get-NotebookMasterIndexDrift {
    <#
    .SYNOPSIS
        What is wrong with the master index on disk, or an empty list. Read-only; takes no lock.

    .DESCRIPTION
        The gate's detector, and it deliberately does NOT repair. A check that fixed what it found
        would report a healthy Library on every run while the writer that caused the drift stayed
        broken.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Workspace)

    $problems = [Collections.Generic.List[string]]::new()
    $notebookRoot = Join-Path $Workspace 'notebook'
    $masterPath = Get-NotebookMasterIndexPath -Workspace $Workspace
    if (-not (Test-Path -LiteralPath $notebookRoot -PathType Container)) {
        [void]$problems.Add('notebook/ is missing')
        return @($problems)
    }
    if (-not (Test-Path -LiteralPath $masterPath -PathType Leaf)) {
        [void]$problems.Add('notebook/_master-index.md is missing')
        return @($problems)
    }
    $expected = $null
    try { $expected = Get-NotebookMasterIndexText -NotebookRoot $notebookRoot }
    catch {
        [void]$problems.Add("a topic cannot be rendered: $($_.Exception.Message)")
        return @($problems)
    }
    $actualBytes = Read-AtomicBytes -Path $masterPath
    if ($actualBytes.Length -ge 3 -and $actualBytes[0] -eq 0xEF -and $actualBytes[1] -eq 0xBB -and $actualBytes[2] -eq 0xBF) {
        [void]$problems.Add('notebook/_master-index.md still carries a UTF-8 BOM; the renderer writes UTF-8 with no BOM')
    }
    $actual = [Text.UTF8Encoding]::new($false, $true).GetString($actualBytes)
    if ($actual.Length -gt 0 -and $actual[0] -eq [char]0xFEFF) { $actual = $actual.Substring(1) }
    if ($actual -cne $expected) {
        [void]$problems.Add('notebook/_master-index.md does not match the topics on disk; re-render it with tools/NotebookIndex.ps1 -Render -WorkspacePath .')
    }
    @($problems)
}

# --- Self-invocation ------------------------------------------------------------------------------
# The same shape BookWriteGuard.ps1 uses: dot-sourced normally, and reachable directly for the two
# things a module has to be able to do on its own. -Render is the named repair when the gate reports
# drift, and it is how a workspace whose master index predates the renderer gets its first one.
if ($MyInvocation.InvocationName -ne '.' -and (@($args) -contains '-Render' -or @($args) -contains '-SelfTest')) {
    $ErrorActionPreference = 'Stop'
    $argumentList = @($args)
    $workspaceArgument = ''
    for ($i = 0; $i -lt $argumentList.Count - 1; $i++) {
        if ([string]$argumentList[$i] -ceq '-WorkspacePath') { $workspaceArgument = [string]$argumentList[$i + 1] }
    }
    if ([string]::IsNullOrWhiteSpace($workspaceArgument)) { $workspaceArgument = Split-Path -Parent $PSScriptRoot }
    $resolvedWorkspace = (Resolve-Path -LiteralPath $workspaceArgument).Path

    if (@($argumentList) -contains '-SelfTest') {
        $failures = [Collections.Generic.List[string]]::new()
        function Assert([bool]$Condition, [string]$Label) { if (-not $Condition) { [void]$failures.Add($Label) } }
        $utf8 = [Text.UTF8Encoding]::new($false)
        $fence = [string][char]0x60 * 3
        $tilde = '~~~'
        $fixture = Join-Path ([IO.Path]::GetTempPath()) ('notebook-index-selftest-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook') -Force | Out-Null
        try {
            $masterPath = Join-Path $fixture 'notebook/_master-index.md'
            function New-Topic([string]$Slug, [string]$IndexText) {
                New-Item -ItemType Directory -Path (Join-Path $fixture "notebook/$Slug") -Force | Out-Null
                if ($null -ne $IndexText) { [IO.File]::WriteAllText((Join-Path $fixture "notebook/$Slug/_index.md"), $IndexText, $utf8) }
            }
            function Set-HeadlessIndex([string]$Text) {
                [IO.File]::WriteAllText((Join-Path $fixture 'notebook/headless/_index.md'), $Text, $utf8)
            }
            function Get-HeadlessHeading {
                Get-NotebookTopicHeading -IndexPath (Join-Path $fixture 'notebook/headless/_index.md')
            }

            # 1. An empty Notebook renders the scaffold paragraph, not an empty list.
            Invoke-NotebookRender -Workspace $fixture | Out-Null
            Assert ([IO.File]::ReadAllText($masterPath) -ceq (Get-NotebookEmptyMasterIndexText)) 'an empty Notebook did not render the scaffold paragraph'
            Assert ([IO.File]::ReadAllBytes($masterPath)[0] -ne 0xEF) 'the renderer wrote a UTF-8 BOM'

            # 2. Topics render ordered by slug, labelled by their own H1 -- not in whatever order the
            #    filesystem happens to enumerate them.
            New-Topic 'zeta' "# Zeta Topic`n"
            New-Topic 'alpha' "# Alpha Topic`n`n## Articles`n"
            Invoke-NotebookRender -Workspace $fixture | Out-Null
            Assert ([IO.File]::ReadAllText($masterPath) -ceq "# Notebook Index`n`n- [[alpha/_index|Alpha Topic]]`n- [[zeta/_index|Zeta Topic]]`n") 'two topics did not render in slug order with their own headings'
            Assert (-not @(Get-NotebookMasterIndexDrift -Workspace $fixture).Count) 'a freshly rendered index reported drift'

            # 3. AN H1 EDIT IS A CHANGE, NOT ONLY A VISIBILITY CHANGE. The index derives the heading
            #    too, so renaming a topic in place must move the master index.
            [IO.File]::WriteAllText((Join-Path $fixture 'notebook/alpha/_index.md'), "# Alpha Renamed`n", $utf8)
            Assert (@(Get-NotebookMasterIndexDrift -Workspace $fixture).Count -eq 1) 'an H1 edit did not invalidate the master index'
            Invoke-NotebookRender -Workspace $fixture | Out-Null
            Assert ([IO.File]::ReadAllText($masterPath).Contains('Alpha Renamed')) 'a re-render did not pick up the edited H1'

            # 3b. A ROLLBACK RE-DERIVES THE INDEX AND MUST NOT RESTORE ONE. The whole scenario, in
            #     order, because only the interleaving shows the defect: seat A journals the topic
            #     index it is about to change, changes it, and renders; seat B then creates a topic
            #     of its own and renders; seat A fails and rolls back.
            #
            #     The assertion that matters is the LAST one. Undoing seat A's own edit is what any
            #     rollback would do. Keeping seat B's topic is what separates re-deriving from
            #     restoring -- a journal that carried notebook/_master-index.md would put back a
            #     snapshot taken before beta existed, and beta would vanish from the index with the
            #     directory still on disk. That is the lost-topic race, and it is unreachable from a
            #     single-seat test, which is why it survived being reasoned about.
            $alphaIndex = Join-Path $fixture 'notebook/alpha/_index.md'
            $rollbackJournal = Write-BookJournal -Workspace $fixture -BookRoot 'notebook/alpha' -Operation 'selftest-rollback' -Paths @($alphaIndex)
            [IO.File]::WriteAllText($alphaIndex, "# Alpha Mid-Write`n", $utf8)
            Invoke-NotebookRender -Workspace $fixture | Out-Null
            New-Topic 'beta' "# Beta Topic`n"
            Invoke-NotebookRender -Workspace $fixture | Out-Null
            Assert ([IO.File]::ReadAllText($masterPath).Contains('Beta Topic')) 'the second seat did not get its topic into the index'
            Restore-BookJournal -JournalPath $rollbackJournal.journal_path | Out-Null
            Invoke-NotebookRenderAfterRollback -Workspace $fixture | Out-Null
            $afterRollback = [IO.File]::ReadAllText($masterPath)
            Assert ([IO.File]::ReadAllText($alphaIndex) -ceq "# Alpha Renamed`n") 'the rollback did not restore the topic index it journaled'
            Assert ($afterRollback.Contains('Alpha Renamed')) 'the re-derived index still shows the heading the rollback undid'
            Assert (-not $afterRollback.Contains('Alpha Mid-Write')) 'the re-derived index kept the mid-write heading'
            Assert ($afterRollback.Contains('beta/_index')) "a rollback lost another seat's topic from the master index"
            # Handed back exactly as case 3 left it, so a later case cannot inherit beta by accident.
            Remove-Item -LiteralPath (Join-Path $fixture 'notebook/beta') -Recurse -Force
            Invoke-NotebookRender -Workspace $fixture | Out-Null

            # 3c. AND WHEN IT CANNOT RENDER, IT SAYS WHAT DID LAND. A rollback that restored its
            #     files and then met an unrelated degenerate topic is half complete, not failed, and
            #     the message is the only place a reader learns which half. It names the one command
            #     that finishes the job -- the same one docs/librarian-operation-playbooks.md gives.
            New-Topic 'unrenderable' $null
            $wrapperMessage = ''
            try { Invoke-NotebookRenderAfterRollback -Workspace $fixture | Out-Null } catch { $wrapperMessage = $_.Exception.Message }
            Assert ($wrapperMessage -cmatch 'were restored') 'the rollback render failure does not say the journaled files are back'
            Assert ($wrapperMessage -cmatch [regex]::Escape('NotebookIndex.ps1 -Render')) 'the rollback render failure does not name the repair command'
            Remove-Item -LiteralPath (Join-Path $fixture 'notebook/unrenderable') -Recurse -Force

            # 4. DEGENERATE STATE FAILS WITHOUT TOUCHING THE PREVIOUS INDEX. A topic directory with
            #    no index is exactly what Compile and Triage used to leave behind mid-write, so the
            #    reader must keep the last index that was true rather than be handed an empty one.
            $goodMaster = [IO.File]::ReadAllText($masterPath)
            New-Topic 'headless' $null
            $refused = $false
            try { Invoke-NotebookRender -Workspace $fixture | Out-Null } catch { $refused = $true }
            Assert $refused 'a topic with no _index.md was rendered anyway'
            Assert ([IO.File]::ReadAllText($masterPath) -ceq $goodMaster) 'a refused render changed the previous master index'
            Assert (@(Get-NotebookMasterIndexDrift -Workspace $fixture)[0] -cmatch 'cannot be rendered') 'the drift detector did not name the unrenderable topic'

            # 5. No H1, and two H1s, are both refused -- and neither writes.
            Set-HeadlessIndex "Some prose with no heading.`n"
            $refused = $false
            try { Get-HeadlessHeading | Out-Null } catch { $refused = $true }
            Assert $refused 'an index with no H1 was accepted'
            Set-HeadlessIndex "# One`n`n# Two`n"
            $refused = $false
            try { Get-HeadlessHeading | Out-Null } catch { $refused = $true }
            Assert $refused 'an index with two H1 headings was accepted'
            Assert ([IO.File]::ReadAllText($masterPath) -ceq $goodMaster) 'inspecting a malformed topic index changed the master index'

            # 6. A FENCED MARKDOWN EXAMPLE IS NOT A SECOND HEADING. The first implementation refused
            #    it, which would have hidden every topic because one topic held a code sample.
            Set-HeadlessIndex ("# Real Heading`n`n" + $fence + "markdown`n# not a heading`n" + $fence + "`n`n" + $tilde + "`n# nor this one`n" + $tilde + "`n")
            Assert ((Get-HeadlessHeading) -ceq 'Real Heading') 'a fenced code sample was counted as a heading'

            # 7. A subheading is not an H1, and neither is a hashtag.
            Set-HeadlessIndex "# Only One`n`n## Articles`n`n#tag`n"
            Assert ((Get-HeadlessHeading) -ceq 'Only One') 'a subheading or hashtag was counted as an H1'

            # 8. A heading that cannot be rendered as a link label is refused at the source, rather
            #    than emitted as a broken link that reads like the renderer's fault.
            Set-HeadlessIndex "# Broken | Label`n"
            $refused = $false
            try { Get-HeadlessHeading | Out-Null } catch { $refused = $true }
            Assert $refused 'a heading containing a pipe was accepted as a link label'

            # 9. Non-ASCII survives the render as UTF-8. A default-encoding write here would put a
            #    mojibake topic title in front of the reader on every Desk summary.
            $eAcute = [string][char]0x00E9
            $emDash = [string][char]0x2014
            Set-HeadlessIndex "# Caf$eAcute $emDash notes`n"
            Invoke-NotebookRender -Workspace $fixture | Out-Null
            $rendered = [Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($masterPath))
            Assert ($rendered.Contains("Caf$eAcute $emDash notes")) 'a non-ASCII topic heading did not round-trip through the render'

            # 10. A BOM on the master index is drift in its own right: a readback comparison against
            #     rendered text can never match a file whose first three bytes are not in that text.
            [IO.File]::WriteAllText($masterPath, (Get-NotebookMasterIndexText -NotebookRoot (Join-Path $fixture 'notebook')), [Text.UTF8Encoding]::new($true))
            Assert (@(Get-NotebookMasterIndexDrift -Workspace $fixture | Where-Object { $_ -cmatch 'BOM' }).Count -eq 1) 'a BOM-carrying master index was not reported as drift'

            # 11. A reparse point under notebook/ is refused rather than followed. Junction creation
            #     needs no elevation on Windows, so this is testable; if it is unavailable the case
            #     is reported as skipped rather than silently passing.
            $junction = Join-Path $fixture 'notebook/elsewhere'
            $outside = Join-Path $fixture 'outside-topic'
            New-Item -ItemType Directory -Path $outside -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $outside '_index.md'), "# Outside`n", $utf8)
            $junctionMade = $false
            try {
                New-Item -ItemType Junction -Path $junction -Target $outside -ErrorAction Stop | Out-Null
                $junctionMade = Test-Path -LiteralPath $junction
            }
            catch { $junctionMade = $false }
            if ($junctionMade) {
                $refused = $false
                try { Get-NotebookTopicInventory -NotebookRoot (Join-Path $fixture 'notebook') | Out-Null } catch { $refused = $true }
                Assert $refused 'a reparse point under notebook/ was rendered as a topic'
                # Directory.Delete, not Remove-Item: removing a junction with Remove-Item throws a
                # NullReferenceException in Windows PowerShell 5.1, and -ErrorAction cannot suppress
                # it. Directory.Delete unlinks the junction and leaves its target alone.
                [IO.Directory]::Delete($junction)
            }
            else { Write-Warning 'NotebookIndex self-test could not create a junction; the reparse-point case did not run.' }
        }
        finally { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }

        if ($failures.Count) {
            [Console]::Error.WriteLine("NotebookIndex self-test FAILED: $($failures -join '; ')")
            exit 1
        }
        Write-Host 'NotebookIndex self-test passed (19 checks).'
        exit 0
    }

    $render = Invoke-NotebookRender -Workspace $resolvedWorkspace
    [pscustomobject]@{
        operation            = 'Render the Notebook master index'
        workspace            = $resolvedWorkspace
        master_index_path    = $render.master_index_path
        topic_count          = $render.topic_count
        shared_library_write = $false
    } | Format-List
    exit 0
}
