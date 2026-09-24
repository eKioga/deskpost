[CmdletBinding()]
param(
    [string]$StateDirectory,
    [string]$WorkspacePath,
    [string]$Seat,
    # The reader's callable prefix, which the REGISTRATION supplies (S38): HookContext.ps1 says why.
    [string]$ReaderToolPrefix,
    [Parameter(ValueFromPipeline = $true)]
    [string]$InputJson,
    [string]$InputJsonBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Shelf Books live on this disk, so a closed one is otherwise readable with the plain Read tool.
# This hook supplies locally what the network supplies for a closed shared Book: absence.
#
# The rules about where a Shelf path sits relative to the Desk moved to ShelfBoundary.ps1 on
# 2026-09-06, when Guard-BashShelfRead.ps1 became the second consumer of them. That file, and
# tools/BookRootSchema.ps1 below it, both fail this guard CLOSED: every path out of the catch block
# denies, so a dependency that cannot be loaded costs the guard nothing it should have allowed.
# HOOKCONTEXT FIRST, AND OUTSIDE THE TRY. It reaches for nothing, so it loads in any layout, and
# Write-HookDeny is the only reason a failure below can be a refusal rather than a silent exit 1.
# Until 2026-09-20 these dot-sources sat above the try block with nothing to catch them: in a
# packaged layout they threw, the guard exited 1 with no JSON, and Claude Code proceeds on that.
# The boundary failed OPEN and said nothing. Load the thing that can speak, then speak on failure.
. (Join-Path $PSScriptRoot 'HookContext.ps1')
try {
    . (Join-Path $PSScriptRoot 'ProgramRoot.ps1')
    . (Join-Path $PSScriptRoot 'ShelfBoundary.ps1')
    # Step 20. Every rule below this line resolves paths against THIS workspace only, which is
    # correct and was never the whole question: the registry says which workspace an absolute
    # path belongs to, so a Shelf next door stops resolving as `outside` and vanishing.
    . (Get-LibraryProgramFile -Name 'WorkspaceRegistry.ps1' -From $PSScriptRoot)
}
catch {
    Write-HookDeny 'PreToolUse' "Virtual Desk failed closed: the guard could not load its own rules. $($_.Exception.Message)"
    exit 0
}

# ONE PATH, JUDGED ONCE. Three call sites reach this -- a resolved file path, and both readings of
# every path inside an apply_patch document -- and a guard whose branches each re-derive the decision
# is a guard with three chances to disagree with itself.
#
# THE DESK IS CONSULTED LAST, AND THAT ORDERING IS LOAD-BEARING. Guard-ShellShelfRead has always read
# Desk state only after its cheap text test, "so a command naming no Shelf path never pays for a
# state read and never fails closed on state it was not going to consult." This guard read the Desk
# FIRST, which was harmless while the Desk was two files that always existed and became a brick the
# moment a Desk could be absent: with seats, a session that has not named one could not write
# `docs/x.md`, because the guard failed closed on seat state that path never needed. Found by this
# guard refusing its own author's edit, on the first run after it was made seat-aware.
#
# So the judgement is in two halves, and only a path that actually names a Shelf Book reaches the
# Desk at all.

# The Shelf root a target names, a denial that needs no Desk, or neither.
function Get-ShelfTargetRoot([string]$Target, [string]$Base) {
    $placed = ConvertTo-WorkspaceRelative -Path $Target -Workspace $Base
    # `outside` is ALLOWED and `invalid` is REFUSED, and until 2026-09-07 both were $null and both
    # were allowed. That is the whole of the tri-state's purpose at the decision point.
    if ($placed.kind -ceq 'outside') { return [pscustomobject]@{ root = $null; denial = $null } }
    if ($placed.kind -ceq 'invalid') {
        return [pscustomobject]@{
            root   = $null
            denial = ("Virtual Desk cannot establish where '$Target' points: $($placed.reason). Name it as a path " +
                      'relative to the workspace, or as a drive-rooted local path.')
        }
    }
    $relative = $placed.relative
    # '' is the workspace root itself: inside, but naming no particular Book.
    if ([string]::IsNullOrEmpty($relative)) { return [pscustomobject]@{ root = $null; denial = $null } }
    if ($relative -notmatch '^(?i)shelf/') { return [pscustomobject]@{ root = $null; denial = $null } }
    if (Test-ShelfBrowseSurface $relative) { return [pscustomobject]@{ root = $null; denial = $null } }

    $shelfRoot = Get-ShelfRootForPath $relative
    if (-not $shelfRoot) { return [pscustomobject]@{ root = $null; denial = 'Virtual Desk requires a canonical Shelf path.' } }
    [pscustomobject]@{ root = $shelfRoot; denial = $null }
}

# --- WRITING INTO notebook/ (the seats review's ruling 1, revised; ruled by Eric 2026-09-10) -------
#
# THE FINDING. This guard judged Shelf paths and nothing else, so a plain `Write` into `notebook/`
# took no claim, checked no ownership and rendered no index -- while `CLAUDE.md:38`, `CONTEXT.md:120`
# and `docs/seats.md` all promised a seatless session "changes nothing".
#
# THE FIRST FIX WAS WRONG AND CHECKING THE READER FLOW IS WHAT CAUGHT IT. Extending this guard to
# refuse `notebook/` outright would have bricked the core flow: authoring a Notebook article IS a
# direct file write, the playbook describes the render and the ownership record as the Librarian's
# own obligations, and NO helper does it. A whole-collection guard meeting its own day-one data.
#
# SO IT GUARDS THE CLAIM AND THE OWNERSHIP, NEVER THE AUTHORING. Two refusals and nothing else:
#
#   no seat            a session that resolves no seat may not write here, which is the sentence
#                      three documents already make and nothing enforced
#   another seat owns  Test-NotebookTopicWritable's verdict, which is the SAME verdict the compiler,
#                      Triage and Reset already enforce through Assert-NotebookTopicWritable
#
# THE VERDICT IS NOT CONDITIONED ON THE OTHER SEAT BEING LIVE, deliberately, and the proposal said it
# should be. A dormant seat's topic is precisely the one whose next reset quarantines whatever was
# written into it -- and a guard that permitted what the helpers refuse would teach the reader a rule
# the rest of the system does not have. One verdict, one rule.
#
# LOCK-FREE, because a PreToolUse hook must take no ordered lock: the `Test-` form is the read that
# exists for preflights, and `Assert-` is the writers'. The four writable scopes stay writable --
# owned by this seat, `shared`, `excluded`, `unmapped` -- so a NEW topic is created without ceremony.
function Get-NotebookWriteDenial([string]$Target, [string]$Base, [string]$ToolName, [string]$SeatArgument, [string]$State) {
    if ($ToolName -cnotin @('Write', 'Edit', 'apply_patch')) { return $null }
    $placed = ConvertTo-WorkspaceRelative -Path $Target -Workspace $Base
    # `outside` is not ours to judge and `invalid` is already denied by the Shelf half; either way
    # this is not the function that answers.
    if ($placed.kind -cne 'inside') { return $null }
    $relative = [string]$placed.relative
    if ([string]::IsNullOrEmpty($relative)) { return $null }
    if ($relative -notmatch '^(?i)notebook/') { return $null }

    $seatState = Resolve-SeatName -Seat $SeatArgument -StateDirectory $State
    if ($seatState.status -cne 'named') {
        return ("Writing into notebook/ needs a seat, and this session has none, so it would leave material in a " +
                "seat's namespace with no claim, no ownership record and no rendered index. " + [string]$seatState.message)
    }

    # THE SECOND SEGMENT IS THE TOPIC, and there is deliberately no separate branch for a loose file
    # directly under notebook/. One was written -- "fewer than three segments means no topic" -- and
    # falsification could not produce a single input that told the two apart: a loose FILENAME is
    # never an owned topic, so it falls out as `unmapped` and is writable either way. A branch no
    # reachable input distinguishes reads as covered and is not.
    $topic = @($relative -split '/')[1]
    if ([string]::IsNullOrWhiteSpace($topic)) { return $null }

    # LOADED ONLY ON THIS PATH. This guard runs on every Read, Grep and Glob as well, and
    # NotebookOwnership.ps1 pulls in three more files; a Read must not pay for them. Dot-sourced into
    # this function's own scope, which is where it is used one line later.
    . (Get-LibraryProgramFile -Name 'NotebookOwnership.ps1' -From $PSScriptRoot)
    $verdict = Test-NotebookTopicWritable -Workspace $Base -Topic $topic -Seat ([string]$seatState.seat)
    if ([bool]$verdict.writable) { return $null }
    [string]$verdict.reason
}

# The only half that needs the Desk, reached only once a Shelf Book has actually been named.
function Get-ClosedBookDenial([string]$Root, [string[]]$OpenRoots) {
    if ($Root -cin $OpenRoots) { return $null }
    $parts = Split-BookRoot $Root
    $kind = if ($parts.shelf -ceq 'archive') { 'Archived Shelf Book' } else { 'Shelf Book' }
    "$kind '$($parts.slug)' is closed. Open it with $(Get-ShelfOpenCommand $Root), then read its pages with $($ReaderToolPrefix)read_open_book_page."
}

try {
    # A PREFIX THAT NAMES NO TOOL IS A BROKEN REGISTRATION (S38), refused before anything is judged:
    # a denial naming a tool that does not exist sends the session nowhere, which is the defect the
    # parameter exists to remove. Failing closed on every call is loud, and loud is what gets it fixed.
    if (-not $ReaderToolPrefix) { $ReaderToolPrefix = $script:DefaultReaderToolPrefix }
    if (-not (Test-ReaderToolPrefix $ReaderToolPrefix)) {
        Write-HookDeny 'PreToolUse' "Virtual Desk failed closed: $(Get-ReaderToolPrefixFault $ReaderToolPrefix)"
        exit 0
    }
    # THE WORKSPACE IS NO LONGER DERIVED FROM THE STATE DIRECTORY (step 17). It used to be
    # `Split-Path -Parent $StateDirectory`, which silently coupled two independent things: repoint
    # the state directory and every real path resolves outside the "workspace", so
    # ConvertTo-WorkspaceRelative answers `outside` for all of them and this guard exits 0 for
    # everything -- failing OPEN, with nothing said. The same conflation already produced a
    # `.claude\.claude` bug recorded at Validated-BookReader.ps1:886.
    #
    # AND IT IS NO LONGER DERIVED FROM THIS FILE'S LOCATION EITHER (step 20, 2026-09-20). The line
    # that replaced the one above -- `Split-Path -Parent (Split-Path -Parent $PSScriptRoot)` -- was
    # the same mistake one layer out: it answered "which workspace am I guarding" with "wherever my
    # own code happens to sit", which is right only while the program and the workspace are one
    # directory. Installed as a plugin, the hooks sit ONE level below the package root, so that
    # expression named the directory the package was dropped into, every real path resolved
    # `outside`, and this guard said nothing about anything. Measured, not predicted: see
    # ProgramRoot.ps1, which fixed the same defect for the CODE half.
    #
    # The workspace is now asked for -- explicit, environment, or the directory the session is
    # actually sitting in -- and the old anchor is offered only when it really is a workspace, so an
    # un-split checkout keeps working and a package does not invent one. `none` is not an error: a
    # session outside every workspace stays silent about relative paths and still judges an absolute
    # path into a registered one, which needs no local anchor at all.
    # AN EXPLICIT -StateDirectory NAMES THE WORKSPACE, and this is a contract that predates the
    # resolver: `.claude` belongs to a workspace, so a caller that hands a hook a state directory has
    # already said which workspace it is talking about. Every fixture in this tree drives a hook that
    # way. Letting the working directory win instead would point a suite at THIS repository while its
    # Desk state came from a temp fixture -- every assertion about the wrong workspace, and a
    # conversation record written into live material by a test.
    $selected = $WorkspacePath
    if (-not $selected -and $StateDirectory) { $selected = Split-Path -Parent $StateDirectory }
    $resolved = Resolve-LibraryWorkspace -Explicit $selected -Anchor (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
    if ($resolved.kind -ceq 'conflict') {
        Write-HookDeny 'PreToolUse' "Virtual Desk failed closed: $($resolved.reason)"
        exit 0
    }
    $workspace = [string]$resolved.workspace
    # THE DESK IS THE WORKSPACE'S, NOT THE PACKAGE'S. `.claude/` holds the seat Desks and the
    # workspace pin, and both belong to the workspace being guarded; deriving the state directory
    # from $PSScriptRoot pointed a packaged guard at a Desk inside its own installation.
    if (-not $StateDirectory) {
        $StateDirectory = if ($workspace) { Join-Path $workspace '.claude' } else { Split-Path -Parent $PSScriptRoot }
    }
    $call = Read-HookPayload -BoundParameters $PSBoundParameters -InputJson $InputJson -InputJsonBase64 $InputJsonBase64
    $toolName = [string](Get-HookField $call 'tool_name')
    $toolInput = Get-HookField $call 'tool_input'

    # The Desk belongs to a SEAT now, and there is no default one: an unresolvable seat throws here
    # and the catch below denies, which is the same direction unreadable Desk state has always taken.
    # Read at most once, and only from a branch that has already established the Shelf is in play --
    # see the ordering note above. $script: because a nested function assigns it.
    $script:openShelfRootsCache = $null
    function Get-OpenRoots {
        if ($null -eq $script:openShelfRootsCache) {
            $script:openShelfRootsCache = @(Get-OpenShelfRoots -Directory (Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat))
        }
        $script:openShelfRootsCache
    }

    # Grep carries an optional glob, and Glob's whole request is a pattern. Both name Shelf paths
    # literally, so they are checked before the resolved-path branch below.
    # ONLY WITH A WORKSPACE. A `shelf/...` glob is workspace-relative by construction, so a session
    # that is in no workspace has nothing to resolve it against and must not guess one.
    $patterns = @()
    if ($workspace) {
        $glob = Get-HookField $toolInput 'glob'
        if ($null -ne $glob) { $patterns += [string]$glob }
        if ($toolName -ceq 'Glob') {
            $globPattern = Get-HookField $toolInput 'pattern'
            if ($null -ne $globPattern) { $patterns += [string]$globPattern }
        }
    }
    foreach ($pattern in $patterns) {
        # The cheap text test first, exactly as the shell guard does: a pattern naming no Shelf path
        # must not pay for a Desk read, nor fail closed on one.
        if ($pattern.Replace('\', '/').TrimStart('.', '/') -notmatch '^(?i)shelf/') { continue }
        $patternTarget = Get-ShelfPatternTarget -Pattern $pattern -OpenRoots (Get-OpenRoots)
        if ($patternTarget -ceq '*') { Write-HookDeny 'PreToolUse' 'That pattern spans Shelf Books that are closed. Narrow it to an open Book, or open the one you need with tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug <slug>.'; exit 0 }
        if ($patternTarget) { Write-HookDeny 'PreToolUse' "Shelf Book '$((Split-BookRoot $patternTarget).slug)' is closed. Open it with $(Get-ShelfOpenCommand $patternTarget), then read its pages with $($ReaderToolPrefix)read_open_book_page."; exit 0 }
    }

    # CODEX'S apply_patch. It carries no `file_path` at all -- the paths are inside the patch
    # document in `command`, which is the shell tool's field name reused. See ShelfBoundary.ps1 for
    # the captured payload this was written from rather than guessed at.
    #
    # BOTH READINGS ARE JUDGED, AND EITHER ONE DENIES. A patch path is relative to the tool's own
    # cwd, which the payload reports; it is also read as workspace-relative in case the cwd is
    # absent or misreported. Judging only one of the two leaves the other as the way around.
    if ($toolName -ceq 'apply_patch') {
        $patchText = [string](Get-HookField $toolInput 'command')
        $patchCwd = [string](Get-HookField $call 'cwd')
        # A throw from the parser -- an unknown directive, a missing envelope -- reaches the catch
        # below and denies. An apply_patch this guard cannot read is not one it may wave through.
        foreach ($named in (Get-ApplyPatchPaths $patchText)) {
            $readings = [Collections.Generic.List[string]]::new()
            [void]$readings.Add($named)
            if (-not [string]::IsNullOrWhiteSpace($patchCwd) -and -not [IO.Path]::IsPathRooted($named)) {
                [void]$readings.Add((Join-Path $patchCwd $named))
            }
            foreach ($reading in $readings) {
                $denial = Get-CrossWorkspaceDenial -Target $reading -HookWorkspace $workspace
                if ($denial) {
                    Write-HookDeny 'PreToolUse' "This patch writes '$named'. $denial"
                    exit 0
                }
                if ($workspace) {
                    $judged = Get-ShelfTargetRoot -Target $reading -Base $workspace
                    $denial = $judged.denial
                    if (-not $denial -and $judged.root) { $denial = Get-ClosedBookDenial -Root $judged.root -OpenRoots (Get-OpenRoots) }
                    # BOTH READINGS ARE JUDGED FOR notebook/ TOO. A patch is a write, and a boundary
                    # enforced on one tool and not the other is the way around it -- which is the exact
                    # hole this file was extended to close for the Shelf on 2026-09-06.
                    if (-not $denial) { $denial = Get-NotebookWriteDenial -Target $reading -Base $workspace -ToolName $toolName -SeatArgument $Seat -State $StateDirectory }
                }
                if ($denial) {
                    Write-HookDeny 'PreToolUse' "This patch writes '$named'. $denial"
                    exit 0
                }
            }
        }
        exit 0
    }

    $target = $null
    $filePath = Get-HookField $toolInput 'file_path'
    if ($null -ne $filePath) { $target = [string]$filePath }
    else {
        $pathField = Get-HookField $toolInput 'path'
        if ($null -ne $pathField) { $target = [string]$pathField }
    }
    if ([string]::IsNullOrWhiteSpace($target)) { exit 0 }

    # ANOTHER WORKSPACE'S SURFACES ARE JUDGED FIRST, because the rules below cannot see them at all:
    # they resolve every path against THIS workspace, so an absolute path into a different one
    # answers `outside` and the guard exits 0 having said nothing (step 20).
    $denial = Get-CrossWorkspaceDenial -Target $target -HookWorkspace $workspace
    if ($denial) { Write-HookDeny 'PreToolUse' $denial; exit 0 }

    # EVERY RULE BELOW RESOLVES AGAINST THIS WORKSPACE, so with none resolved there is nothing here
    # to say -- and that is the step's own wording: a path in no workspace, from a cwd in no
    # workspace, is silent. The cross-workspace rule above has already run, which is what keeps that
    # silence narrow rather than blind.
    if (-not $workspace) { exit 0 }

    $judged = Get-ShelfTargetRoot -Target $target -Base $workspace
    $denial = $judged.denial
    if (-not $denial -and $judged.root) { $denial = Get-ClosedBookDenial -Root $judged.root -OpenRoots (Get-OpenRoots) }
    if (-not $denial) { $denial = Get-NotebookWriteDenial -Target $target -Base $workspace -ToolName $toolName -SeatArgument $Seat -State $StateDirectory }
    if ($denial) { Write-HookDeny 'PreToolUse' $denial; exit 0 }
}
catch {
    Write-HookDeny 'PreToolUse' "Virtual Desk failed closed: $($_.Exception.Message)"
}
