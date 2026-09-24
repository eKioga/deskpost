<#
.SYNOPSIS
    Which Library workspaces exist on this machine, and which one an accessed path belongs to.
    Dot-sourced; never invoked directly except with -SelfTest.

.DESCRIPTION
    PLAN-public-release.md step 20. Until this file existed, every hook anchored "the workspace" at
    its own script location -- `Split-Path -Parent (Split-Path -Parent $PSScriptRoot)` -- so a guard
    installed in workspace X judged paths against X and nothing else. An absolute read into workspace
    Y's closed Shelf, from a session sitting in X, resolved `outside` and the guard exited silently.
    The Shelf rule was correct and simply never consulted.

    THE REGISTRY IS A LIST OF PLACES, NOT A LIST OF PERMISSIONS. It answers one question -- which
    workspace, if any, contains this path -- so that the existing Desk rules can then be applied
    against the RIGHT workspace's Desk. Nothing here decides whether a read is allowed; it decides
    whose rules decide.

    THE MARKER IS WHAT MAKES A DIRECTORY A WORKSPACE. `.library/workspace.json` inside the workspace
    root. The registry is a convenience index over those markers, never the authority: an entry whose
    marker is gone describes a workspace this machine can no longer characterise, and a path into it
    FAILS CLOSED rather than falling through to silence. A registry that could turn a real workspace
    into "nowhere" by having a stale line deleted would be worse than no registry at all.

    THE FAILURE IS SCOPED TO THE WORKSPACE THAT IS BROKEN, and deliberately not wider. A missing
    marker on workspace Y refuses paths into Y. It does NOT refuse paths into a healthy workspace X,
    and it does not refuse paths that are in no workspace at all. A guard that bricked every
    workspace because one stale registry line pointed at a deleted folder would be refusing correct
    work, which is the failure mode this codebase pays for more often than the permissive one.

    ABSENCE IS THE COMMON CASE AND MUST BE CHEAP. No registry file is not an error: it is a machine
    where `library init` has never run, and every path on it is in no workspace. The read is one
    file, cached per process, and a path that matches nothing costs a string comparison per entry.

    EVERY ROOT IS RESOLVED ONCE, on the way in, to a drive-rooted full path with no trailing
    separator -- the same shape `ConvertTo-WorkspaceRelative` recognises. Containment is then a
    prefix test against `root + separator`, so `D:\Library2` is never inside `D:\Library`.
#>

# NO param() BLOCK, AND THAT IS NOT AN OVERSIGHT -- IT IS THE ONLY SAFE SHAPE FOR A FILE THIS
# WIDELY DOT-SOURCED. Dot-sourcing a script that declares parameters BINDS those parameters in the
# CALLER'S scope, with their defaults, silently. This file used to declare `-RegistryRoot` and
# `-SelfTest`; the first consumer to dot-source it and also take a `-SelfTest` of its own was
# Initialize-LibraryWorkspace.ps1, and `-SelfTest` on its command line was reset to $false the
# moment this line ran. The self-test did not run. What ran instead was the REAL initialiser,
# against this repository, writing a marker and appending a managed section to a tracked CLAUDE.md
# -- and it reported success, because from its own point of view nothing had gone wrong.
#
# `tools/BookRootSchema.ps1` already had the answer, for the same reason and in the same words: it
# is dot-sourced by eight consumers and carries no param block either, reading its one flag off
# $args only when it was NOT dot-sourced. Step 20's plan puts this file in the load path of every
# helper in tools/, so the hazard was about to be multiplied by sixty.
Set-StrictMode -Version Latest

# THE REGISTRY ROOT IS RESOLVED AT ONE BOUNDARY. `LIBRARY_WORKSPACES` exists so a fixture -- and a
# contributor with a non-standard home -- can point this somewhere else without any caller in the
# tree having to know it is possible. Callers pass a path or pass nothing.
function Get-WorkspaceRegistryRoot([string]$RegistryRoot) {
    if (-not [string]::IsNullOrWhiteSpace($RegistryRoot)) { return $RegistryRoot }
    if (-not [string]::IsNullOrWhiteSpace($env:LIBRARY_WORKSPACES)) { return $env:LIBRARY_WORKSPACES }
    Join-Path $env:USERPROFILE '.library'
}

function Get-WorkspaceRegistryPath([string]$RegistryRoot) {
    Join-Path (Get-WorkspaceRegistryRoot $RegistryRoot) 'workspaces.json'
}

function Get-WorkspaceMarkerPath([string]$Workspace) {
    Join-Path (Join-Path $Workspace '.library') 'workspace.json'
}

function ConvertTo-WorkspaceRoot([string]$Path) {
    <#
        One shape for every root this file compares against, or $null if the value cannot be one.
        A root that is not drive-rooted cannot be reasoned about by prefix, and a registry line that
        holds one is a line this machine cannot honour.
    #>
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    try { $full = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar) } catch { return $null }
    if ($full -notmatch '^[A-Za-z]:[\\/]') { return $null }
    $full
}

function Read-WorkspaceRegistry {
    <#
        The registered workspaces, as objects carrying a resolved root. An ABSENT registry is an
        empty list and not an error. An UNREADABLE one throws: both guards turn a throw into a
        denial, which is the only correct direction for state that cannot vouch for itself.
    #>
    param([string]$RegistryRoot)

    $path = Get-WorkspaceRegistryPath $RegistryRoot
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return @() }

    $text = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false))
    if ([string]::IsNullOrWhiteSpace($text)) { return @() }

    $doc = $null
    try { $doc = $text | ConvertFrom-Json }
    catch { throw "the workspace registry at $path is not readable JSON, so which workspace a path belongs to cannot be established" }

    $names = @($doc.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -notcontains 'workspaces') {
        throw "the workspace registry at $path has no 'workspaces' list, so which workspace a path belongs to cannot be established"
    }

    $out = [Collections.Generic.List[object]]::new()
    foreach ($entry in @($doc.workspaces)) {
        if (-not $entry) { continue }
        $fields = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
        if ($fields -notcontains 'path') { continue }
        $root = ConvertTo-WorkspaceRoot ([string]$entry.path)
        if (-not $root) { continue }
        $id = ''
        if ($fields -contains 'id') { $id = [string]$entry.id }
        [void]$out.Add([pscustomobject]@{ id = $id; root = $root })
    }
    @($out)
}

function Test-PathInsideWorkspace([string]$FullPath, [string]$Root) {
    if ([string]::IsNullOrWhiteSpace($FullPath) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
    if ($FullPath.Equals($Root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    # `+ separator` and not a bare prefix: D:\Library2 must never read as inside D:\Library.
    $FullPath.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-WorkspaceForPath {
    <#
        Whose Desk rules govern this path.

        `kind` is the whole contract:
          hook           -- inside the workspace this hook was installed in; judge as before
          registered     -- inside a DIFFERENT registered workspace whose marker is present
          marker-missing -- inside a registered workspace whose marker is gone; the caller must REFUSE
          none           -- in no workspace at all; the caller must stay silent

        The hook's own workspace wins over the registry when both contain the path, because it is the
        one the caller already has open state for, and it is checked without touching the registry at
        all -- so the ordinary in-workspace call pays nothing for this file existing.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$FullPath,
        [string]$HookWorkspace,
        [AllowEmptyCollection()][object[]]$Registry = @()
    )

    $target = ConvertTo-WorkspaceRoot $FullPath
    if (-not $target) { return [pscustomobject]@{ kind = 'none'; workspace = $null; id = $null } }

    $hookRoot = ConvertTo-WorkspaceRoot $HookWorkspace
    if ($hookRoot -and (Test-PathInsideWorkspace -FullPath $target -Root $hookRoot)) {
        return [pscustomobject]@{ kind = 'hook'; workspace = $hookRoot; id = $null }
    }

    # MOST SPECIFIC WINS. Nested workspaces are not supposed to exist, but if one does, the deeper
    # root is the one whose Desk actually describes the path -- and picking the shallower one would
    # judge a page against a Desk that has never heard of it.
    $match = $null
    foreach ($entry in @($Registry)) {
        if (-not (Test-PathInsideWorkspace -FullPath $target -Root $entry.root)) { continue }
        if ((-not $match) -or ($entry.root.Length -gt $match.root.Length)) { $match = $entry }
    }
    if (-not $match) { return [pscustomobject]@{ kind = 'none'; workspace = $null; id = $null } }

    if (-not (Test-Path -LiteralPath (Get-WorkspaceMarkerPath $match.root) -PathType Leaf)) {
        return [pscustomobject]@{ kind = 'marker-missing'; workspace = $match.root; id = $match.id }
    }
    [pscustomobject]@{ kind = 'registered'; workspace = $match.root; id = $match.id }
}

# THE SURFACES A FOREIGN WORKSPACE GUARDS. `shelf` is BookRootSchema's own prefix and the self-test
# asserts it is still in that file's pattern, so a rename there fails here rather than quietly
# unguarding a Shelf. `notebook` has no schema of its own to derive from; it is named once, here.
$script:WorkspaceGuardedSurfaces = @('shelf', 'notebook')

function Get-CrossWorkspaceDenial {
    <#
        The denial a hook owes a path that belongs to a DIFFERENT workspace, or $null to let the
        existing in-workspace rules run untouched.

        WHY A FOREIGN SHELF IS ALWAYS CLOSED. A Desk belongs to a seat in a session, and this session
        holds no seat in another workspace -- so nothing is open there, and "closed" needs no lookup.
        The alternative, reading the other workspace's Desk files, would be judging its Shelf against
        a Desk that this session is not sitting at, which is a worse answer than refusing.

        ONLY AN ABSOLUTE PATH CAN NAME ANOTHER WORKSPACE. A relative one is resolved against this
        workspace by rules that have always been correct, so it is handed straight back and the
        ordinary call pays for none of this.

        AN EMPTY REGISTRY SAYS NOTHING. A machine where `library init` has never run has no other
        workspaces, so every path is either in this one or in none, which is what happened before
        this function existed.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Target,
        # ALLOWEMPTYSTRING, and it is step 20's whole second half arriving here. A hook that could not
        # establish its own workspace passes '' rather than inventing one from its script location:
        # it still has to judge an absolute path into a REGISTERED workspace, which needs no local
        # anchor at all. A Mandatory string rejects '' and would have made that call impossible.
        [Parameter(Mandatory)][AllowEmptyString()][string]$HookWorkspace,
        [string]$RegistryRoot
    )

    if ([string]::IsNullOrWhiteSpace($Target)) { return $null }
    if (-not [IO.Path]::IsPathRooted($Target)) { return $null }

    $registry = @(Read-WorkspaceRegistry -RegistryRoot $RegistryRoot)
    if (-not $registry.Count) { return $null }

    $placed = Resolve-WorkspaceForPath -FullPath $Target -HookWorkspace $HookWorkspace -Registry $registry

    # A workspace this machine can no longer characterise refuses EVERY path into it, not only a
    # Shelf one: without the marker there is nothing to say which paths are surfaces at all.
    if ($placed.kind -eq 'marker-missing') { return (Get-WorkspaceMarkerMissingReason $placed.workspace) }
    if ($placed.kind -ne 'registered') { return $null }

    $full = ConvertTo-WorkspaceRoot $Target
    $relative = $full.Substring($placed.workspace.Length).TrimStart('\', '/').Replace('\', '/')
    $surface = ($relative -split '/')[0]
    if ($script:WorkspaceGuardedSurfaces -notcontains $surface) { return $null }

    "$relative is in the Library workspace at $($placed.workspace), which is not this workspace. " +
    'Nothing is open there: a Desk belongs to a seat in a session, and this session holds no seat in that ' +
    'workspace, so its Shelf and Notebook are closed here whatever their own Desk says. Open a seat in that ' +
    'workspace and read the page there.'
}

function Get-WorkspaceMarkerMissingReason([string]$Workspace) {
    <#
        One wording, so both guards refuse a missing marker identically and the reason names the
        remedy rather than only the fault.
    #>
    "$Workspace is registered as a Library workspace but its marker $(Get-WorkspaceMarkerPath $Workspace) is missing, " +
    'so this machine cannot establish what is open there and will not read into it. Restore the marker, ' +
    'or remove the workspace from ' + (Get-WorkspaceRegistryPath '') + '.'
}

# ==================================================================================================
# WHICH WORKSPACE AM I IN
# ==================================================================================================
# Everything above answers "which workspace is THIS PATH in". This section answers the other half of
# step 20: "which workspace is this PROCESS guarding", and the two are different questions with
# different failure modes.
#
# THE DEFECT THIS EXISTS TO RETIRE, measured 2026-09-20 (S11) and named in ProgramRoot.ps1. Every
# hook and every helper answered the second question with its own script location -- two levels up
# from `.claude/hooks`, one level up from `tools/`. That is correct only while the program and the
# workspace are the same directory, which is exactly what step 19 stops being true. ProgramRoot.ps1
# fixed the FIRST question by looking for the code rather than counting levels. This fixes the
# second, and it cannot be fixed the same way: there is no marker above a package that says which of
# the reader's workspaces this session is about. The answer has to come from the CALLER -- an
# explicit selection, the environment, or the directory the session is sitting in.
#
# THE ORDER IS PRECEDENCE, AND PRECEDENCE IS NOT A GUESS.
#
#   explicit      -WorkspacePath / --workspace, the most specific thing anyone said
#   environment   LIBRARY_WORKSPACE, the session's standing answer
#   cwd           the nearest ancestor of the working directory carrying the MARKER
#   anchor        the caller's own location, and ONLY when that location really is a workspace
#   none          this process is in no workspace, and must say nothing about relative paths
#
# THE ANCHOR IS THE DANGEROUS ONE AND IS ADMITTED ON THE MARKER ALONE.
#
# IT USED TO BE ADMITTED ON TWO TESTS, and the second one expired on 2026-09-20. It read: accept the
# marker, OR accept `tools/BookRootSchema.ps1`, "which is the un-split shape and nothing else: in a
# plugin layout the hooks' grandparent is the directory the package was dropped into, which carries
# neither." That sentence was true of the package shape of the day -- a `plugin/` subdirectory
# holding six manifests -- and step 19 then measured what a plugin install actually copies and made
# the plugin root the PROGRAM root. An installed package is now a byte copy of a checkout: it
# carries `tools/BookRootSchema.ps1`, the hooks' grandparent IS the package root, and the second
# test admitted it. A guard resolving `none` would have anchored on its own installation and judged
# the reader's paths against a plugin cache -- S11's defect, reintroduced by a layout decision three
# files away from this one.
#
# NOTHING STRUCTURAL SEPARATES THE TWO, because the install IS the checkout. What separates them is
# the marker, which is the authority step 20 established for exactly this question. The exemption
# existed because `library init` did not: an un-split clone had no marker and no way to get one. It
# has one now, and this machine has been registered since 2026-09-20, so the protection the
# exemption was written for is already carried by the rule it was an exception to. An uninitialised
# clone resolves `none` and says so -- `Resolve-ToolWorkspace`'s refusal names `library init
# <folder>` as the remedy -- which is a loud wrong-nothing instead of a quiet wrong-something.
#
# THE CWD WALK ALREADY LOOKED FOR THE MARKER ALONE, and the two rules are now the same rule. The
# asymmetry that used to be load-bearing is gone because the hazard it protected against grew to
# cover the anchor too.
#
# THE CWD WALK LOOKS FOR THE MARKER ALONE, deliberately, and the asymmetry with the anchor is the
# whole point. A cwd walk that also accepted the program shape would resolve a plugin package as a
# workspace the moment a session ran from inside one.

function Test-WorkspaceMarkerPresent([string]$Path) {
    <#
        The marker, and only the marker. This is what makes a directory a workspace.
    #>
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    Test-Path -LiteralPath (Get-WorkspaceMarkerPath $Path) -PathType Leaf
}

function Test-LibraryWorkspaceAnchor {
    <#
        Whether a caller's own location may stand in for a workspace. The marker -- see the block
        comment above for the second test this used to carry and why step 19's packaging retired it
        -- and NOT A MARKER THE REGISTRY KNOWS TO BELONG SOMEWHERE ELSE.

        THE SECOND HALF WAS MEASURED, ON 2026-09-20, BY INSTALLING THIS PACKAGE. `claude plugin
        marketplace add <local directory>` does not apply `.gitignore`: it copied the entire working
        directory into the plugin cache, 5,111 files and 271 MB, INCLUDING `.library/workspace.json`.
        So the installed package carried a marker bearing THIS workspace's id, and the rule one
        paragraph up -- "a directory is a workspace when it has a marker" -- accepted the plugin
        cache as the reader's Library. The tightening that closed the `tools/BookRootSchema.ps1`
        hole did not close this one; a copied marker walks straight through it.

        A COPY IS DETECTED RATHER THAN PREVENTED, because preventing it needs the copier's
        cooperation and there is no reason to expect it. The registry already records, per workspace
        id, the path `library init` issued it for. A marker whose id the registry maps to a
        DIFFERENT directory is therefore a copy of that workspace's marker, and this is the one
        question the registry can answer that the marker cannot answer about itself.

        THE REGISTRY STILL IS NOT THE AUTHORITY, and the asymmetry is deliberate: an id the registry
        has never seen is accepted, because a workspace that was never registered is ordinary and
        this file's header says the registry is an index rather than a permission list. Only a
        CONTRADICTION refuses. That keeps the failure scoped to the case actually demonstrated.
    #>
    param([string]$Path, [string]$RegistryRoot)

    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if (-not (Test-WorkspaceMarkerPresent $Path)) { return $false }

    $here = ConvertTo-WorkspaceRoot $Path
    if (-not $here) { return $false }

    $id = ''
    try {
        $marker = [IO.File]::ReadAllText((Get-WorkspaceMarkerPath $Path), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
        $fields = @($marker.PSObject.Properties | ForEach-Object { $_.Name })
        if ($fields -contains 'id') { $id = [string]$marker.id }
    }
    catch { return $false }   # a marker that cannot be read cannot vouch for this location
    if ([string]::IsNullOrWhiteSpace($id)) { return $false }

    # A registry that cannot be read must not silently grant the anchor it exists to contradict.
    $entries = @()
    try { $entries = @(Read-WorkspaceRegistry -RegistryRoot $RegistryRoot) } catch { return $false }

    foreach ($entry in $entries) {
        if ([string]$entry.id -cne $id) { continue }
        if (-not $entry.root.Equals($here, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    }
    $true
}

function Find-WorkspaceByMarker {
    <#
        The nearest ancestor of -StartDirectory carrying `.library/workspace.json`, or $null.

        Returns $null rather than throwing, unlike Get-LibraryProgramRoot: a program that cannot
        find its own code is broken, while a session sitting outside every workspace is ordinary and
        must stay silent.
    #>
    param([string]$StartDirectory)

    if ([string]::IsNullOrWhiteSpace($StartDirectory)) { return $null }
    $current = ConvertTo-WorkspaceRoot $StartDirectory
    if (-not $current) { return $null }
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        if (Test-WorkspaceMarkerPresent $current) { return $current }
        $parent = Split-Path -Parent $current
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) { break }
        $current = $parent
    }
    $null
}

function Read-WorkspaceMarker {
    <#
        The marker's contents, or $null when there is none. An UNREADABLE marker throws, for the
        same reason an unreadable registry does: state that cannot vouch for itself must not be read
        as absent.
    #>
    param([Parameter(Mandatory)][string]$Workspace)

    $path = Get-WorkspaceMarkerPath $Workspace
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $text = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false))
    try { return ($text | ConvertFrom-Json) }
    catch { throw "the workspace marker at $path is not readable JSON, so this workspace's identity cannot be established" }
}

function Get-WorkspaceMarkerField($Marker, [string]$Name) {
    if ($null -eq $Marker) { return $null }
    $names = @($Marker.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -notcontains $Name) { return $null }
    [string]$Marker.$Name
}

function Get-WorkspaceSelectionConflict {
    <#
        The refusal a selected workspace owes when the registry contradicts it, or $null.

        WHAT COUNTS AS A DISAGREEMENT, and why it is not simply "two candidates differ". The step
        says a tool refuses "when the explicit selection, the cwd-derived one and the registry
        disagree", and the naive reading -- refuse whenever the explicit selection differs from the
        cwd-derived one -- refuses correct work on its first day. Every fixture in this tree passes
        an explicit workspace from a session sitting in a different one; so does every helper the
        reader runs against a sandbox. Precedence already answers that case, and answering it twice
        with a refusal would brick the suites that prove the rest of this works.

        The registry is what turns a difference into a CONTRADICTION, because it is the only party
        that knows what a workspace root is supposed to be:

          selected is not registered at all      no contradiction; nothing has an opinion
          selected IS a registered root          agreement, unless the two ids differ
          selected sits INSIDE a registered root selected is not a workspace root at all
          the containing registration has no marker   this machine cannot characterise it

        The cwd-derived answer is named in the message rather than used to decide, which is what the
        step asks for: a reader who has to be told a selection was refused needs all three, and the
        one that decided is rarely the one they got wrong.
    #>
    param(
        [Parameter(Mandatory)][string]$Selected,
        [string]$Source,
        [string]$CwdWorkspace,
        [string]$RegistryRoot
    )

    $registry = @(Read-WorkspaceRegistry -RegistryRoot $RegistryRoot)
    if (-not $registry.Count) { return $null }

    $placed = Resolve-WorkspaceForPath -FullPath $Selected -Registry $registry
    if ($placed.kind -ceq 'none') { return $null }

    $cwdText = if ([string]::IsNullOrWhiteSpace($CwdWorkspace)) { 'no workspace above the working directory' } else { $CwdWorkspace }
    $sourceText = if ([string]::IsNullOrWhiteSpace($Source)) { 'the selection' } else { "the $Source selection" }

    if ($placed.kind -ceq 'marker-missing') { return (Get-WorkspaceMarkerMissingReason $placed.workspace) }

    # OrdinalIgnoreCase, not -cne. Windows paths are case-insensitive, and a reader who types
    # `d:\library` where the registry holds `D:\Library` has not contradicted anything.
    if (-not $placed.workspace.Equals($Selected, [StringComparison]::OrdinalIgnoreCase)) {
        return ("$sourceText names $Selected, which is not a workspace root: it sits inside the registered workspace " +
                "$($placed.workspace). The working directory derives $cwdText, and " + (Get-WorkspaceRegistryPath $RegistryRoot) +
                " registers $($placed.workspace). Name the workspace root itself, or register $Selected as a workspace of its own.")
    }

    # Two ids for one root. The marker is the authority and the registry is the index, so this is a
    # stale or hand-edited index line rather than a broken workspace -- but a tool that carried on
    # would be writing under an identity the registry will later attribute to something else.
    $marker = Read-WorkspaceMarker -Workspace $Selected
    $markerId = Get-WorkspaceMarkerField $marker 'id'
    $registryId = [string]$placed.id
    if (-not [string]::IsNullOrWhiteSpace($markerId) -and -not [string]::IsNullOrWhiteSpace($registryId) -and $markerId -cne $registryId) {
        return ("$sourceText names $Selected, whose marker calls it '$markerId' while " + (Get-WorkspaceRegistryPath $RegistryRoot) +
                " registers that same path as '$registryId'. The working directory derives $cwdText. " +
                "The marker is the authority: re-register the workspace, or restore the registry line that matches it.")
    }

    $null
}

function Resolve-LibraryWorkspace {
    <#
        Which workspace this process is operating on.

        `kind` is the contract:
          resolved  -- `workspace` is a drive-rooted root, and `source` says who said so
          conflict  -- `reason` is a refusal the caller must pass on; `workspace` is $null
          none      -- this process is in no workspace; `workspace` is $null and that is not an error

        NONE IS NOT A FAILURE, and the distinction from `conflict` is the one this file exists to
        keep. A session outside every workspace must be silent about relative paths and must still
        judge an absolute path into a registered workspace -- which the registry half above does
        without needing to know where this process sits. A session given CONTRADICTORY answers must
        refuse, because carrying on means judging one workspace's material by another's Desk.

        THE ENVIRONMENT IS READ IN THE PARAMETER DEFAULT, at this one boundary, so that no caller
        anywhere in the tree has to remember LIBRARY_WORKSPACE exists and no test has to fight an
        ambient value it did not set.
    #>
    param(
        [string]$Explicit,
        [string]$EnvironmentWorkspace = $env:LIBRARY_WORKSPACE,
        [string]$StartDirectory,
        [string]$Anchor,
        [string]$RegistryRoot
    )

    if ([string]::IsNullOrWhiteSpace($StartDirectory)) {
        try { $StartDirectory = (Get-Location).ProviderPath } catch { $StartDirectory = $null }
    }

    $cwdWorkspace = Find-WorkspaceByMarker -StartDirectory $StartDirectory

    $candidates = [Collections.Generic.List[object]]::new()
    foreach ($pair in @(
            @{ source = 'explicit';    value = $Explicit },
            @{ source = 'environment'; value = $EnvironmentWorkspace },
            @{ source = 'cwd';         value = $cwdWorkspace })) {
        if ([string]::IsNullOrWhiteSpace($pair.value)) { continue }
        [void]$candidates.Add([pscustomobject]@{ source = [string]$pair.source; value = [string]$pair.value })
    }
    # The anchor is last and is the only candidate that has to prove itself before it is even
    # offered: a location that is not a workspace is not a weaker answer, it is a wrong one.
    if (-not [string]::IsNullOrWhiteSpace($Anchor) -and (Test-LibraryWorkspaceAnchor -Path $Anchor -RegistryRoot $RegistryRoot)) {
        [void]$candidates.Add([pscustomobject]@{ source = 'anchor'; value = $Anchor })
    }

    if (-not $candidates.Count) {
        return [pscustomobject]@{ kind = 'none'; workspace = $null; source = $null; reason = $null; cwd = $cwdWorkspace }
    }

    $chosen = $candidates[0]
    $normalised = ConvertTo-WorkspaceRoot $chosen.value
    if (-not $normalised) {
        return [pscustomobject]@{
            kind      = 'conflict'
            workspace = $null
            source    = $chosen.source
            reason    = ("the $($chosen.source) workspace selection '$($chosen.value)' is not a drive-rooted local path, " +
                         'so which workspace this session is about cannot be established')
            cwd       = $cwdWorkspace
        }
    }

    $conflict = Get-WorkspaceSelectionConflict -Selected $normalised -Source $chosen.source `
        -CwdWorkspace $cwdWorkspace -RegistryRoot $RegistryRoot
    if ($conflict) {
        return [pscustomobject]@{ kind = 'conflict'; workspace = $null; source = $chosen.source; reason = $conflict; cwd = $cwdWorkspace }
    }

    [pscustomobject]@{ kind = 'resolved'; workspace = $normalised; source = $chosen.source; reason = $null; cwd = $cwdWorkspace }
}

function Resolve-ToolWorkspace {
    <#
        The one line a helper in tools/ runs to answer "which workspace".

        A helper differs from a hook in what it does with `none`: a hook stays silent, while a helper
        asked to read a Shelf with no workspace to read it in has nothing to do and says so. So this
        THROWS on both failing kinds, and every caller already fails closed on a throw.
    #>
    param(
        [string]$Explicit,
        [string]$Anchor,
        [string]$StartDirectory,
        [string]$RegistryRoot
    )

    $resolved = Resolve-LibraryWorkspace -Explicit $Explicit -Anchor $Anchor -StartDirectory $StartDirectory -RegistryRoot $RegistryRoot
    if ($resolved.kind -ceq 'conflict') { throw $resolved.reason }
    if ($resolved.kind -ceq 'none') {
        throw ('no Library workspace was selected and none could be derived: pass -WorkspacePath, set LIBRARY_WORKSPACE, ' +
               'or run from inside a workspace. `library init <folder>` creates one.')
    }
    $resolved.workspace
}

# ==================================================================================================
# THE SELF-TEST
# ==================================================================================================
function Invoke-WorkspaceRegistrySelfTest {
    $failures = [Collections.Generic.List[string]]::new()
    $checks = 0
    function Check([bool]$Condition, [string]$Message) {
        $script:wsChecks++
        if (-not $Condition) { [void]$failures.Add($Message) }
    }
    $script:wsChecks = 0

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('ws-registry-' + [guid]::NewGuid().ToString('N'))
    $regRoot = Join-Path $tmp 'reg'
    $wsA = Join-Path $tmp 'alpha'        # the hook's own workspace
    $wsB = Join-Path $tmp 'beta'         # another registered workspace, marker present
    $wsC = Join-Path $tmp 'gamma'        # registered, marker DELETED
    $wsB2 = Join-Path $tmp 'beta2'       # the prefix decoy: NOT inside beta
    $loose = Join-Path $tmp 'nowhere'    # in no workspace at all

    try {
        foreach ($d in @($regRoot, $wsA, $wsB, $wsC, $wsB2, $loose)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
        foreach ($w in @($wsA, $wsB, $wsB2)) {
            New-Item -ItemType Directory -Path (Join-Path $w '.library') -Force | Out-Null
            [IO.File]::WriteAllText((Get-WorkspaceMarkerPath $w), '{"id":"x"}', [Text.UTF8Encoding]::new($false))
        }
        # gamma is registered and has NO marker: that is the case, not an accident of setup.
        New-Item -ItemType Directory -Path (Join-Path $wsC '.library') -Force | Out-Null

        $registryJson = @{ workspaces = @(
            @{ id = 'beta';  path = $wsB },
            @{ id = 'gamma'; path = $wsC },
            @{ id = 'beta2'; path = $wsB2 }
        ) } | ConvertTo-Json -Depth 4
        [IO.File]::WriteAllText((Join-Path $regRoot 'workspaces.json'), $registryJson, [Text.UTF8Encoding]::new($false))

        # --- an ABSENT registry is empty, not an error --------------------------------------------
        $emptyRoot = Join-Path $tmp 'no-registry-here'
        $absent = @(Read-WorkspaceRegistry -RegistryRoot $emptyRoot)
        Check ($absent.Count -eq 0) "an absent registry returned $($absent.Count) entr(ies) rather than none"

        # --- an UNREADABLE one throws, and does NOT read as absent --------------------------------
        $badRoot = Join-Path $tmp 'bad-registry'
        New-Item -ItemType Directory -Path $badRoot -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $badRoot 'workspaces.json'), '{ not json', [Text.UTF8Encoding]::new($false))
        $threw = ''
        try { Read-WorkspaceRegistry -RegistryRoot $badRoot | Out-Null } catch { $threw = [string]$_.Exception.Message }
        Check ($threw -match 'not readable JSON') "an unreadable registry did not throw; got '$threw'"

        # A registry with no `workspaces` key is the same failure, not an empty list.
        [IO.File]::WriteAllText((Join-Path $badRoot 'workspaces.json'), '{"other":[]}', [Text.UTF8Encoding]::new($false))
        $shapeThrew = ''
        try { Read-WorkspaceRegistry -RegistryRoot $badRoot | Out-Null } catch { $shapeThrew = [string]$_.Exception.Message }
        Check ($shapeThrew -match "no 'workspaces' list") "a registry with no workspaces list was read as empty; got '$shapeThrew'"

        $registry = @(Read-WorkspaceRegistry -RegistryRoot $regRoot)
        Check ($registry.Count -eq 3) "the registry resolved $($registry.Count) entr(ies) rather than 3"

        # --- the four kinds ------------------------------------------------------------------------
        $inHook = Resolve-WorkspaceForPath -FullPath (Join-Path $wsA 'shelf\holding\page.md') -HookWorkspace $wsA -Registry $registry
        Check ($inHook.kind -eq 'hook') "a path in the hook's own workspace resolved '$($inHook.kind)'"

        $inOther = Resolve-WorkspaceForPath -FullPath (Join-Path $wsB 'shelf\holding\page.md') -HookWorkspace $wsA -Registry $registry
        Check ($inOther.kind -eq 'registered') "a path in another registered workspace resolved '$($inOther.kind)'"
        Check ($inOther.id -eq 'beta') "the resolved workspace reported id '$($inOther.id)' rather than beta"

        $broken = Resolve-WorkspaceForPath -FullPath (Join-Path $wsC 'shelf\holding\page.md') -HookWorkspace $wsA -Registry $registry
        Check ($broken.kind -eq 'marker-missing') "a registered workspace with no marker resolved '$($broken.kind)' rather than failing closed"

        $nowhere = Resolve-WorkspaceForPath -FullPath (Join-Path $loose 'page.md') -HookWorkspace $wsA -Registry $registry
        Check ($nowhere.kind -eq 'none') "a path in no workspace resolved '$($nowhere.kind)'"

        # --- THE PREFIX DECOY, which is the assertion that catches a bare StartsWith ---------------
        # beta2 is registered in its own right, so a bare prefix test would ALSO report it inside
        # beta. The test is that the resolved workspace is beta2, not beta.
        $decoy = Resolve-WorkspaceForPath -FullPath (Join-Path $wsB2 'shelf\holding\page.md') -HookWorkspace $wsA -Registry $registry
        Check ($decoy.workspace -eq (ConvertTo-WorkspaceRoot $wsB2)) "beta2 resolved to '$($decoy.workspace)' rather than to itself"
        Check ($decoy.id -eq 'beta2') "beta2 resolved to id '$($decoy.id)'"

        # And the same decoy against containment directly, with beta2 NOT in the registry, so the
        # only thing that could match is the bare prefix.
        Check (-not (Test-PathInsideWorkspace -FullPath (ConvertTo-WorkspaceRoot $wsB2) -Root (ConvertTo-WorkspaceRoot $wsB))) `
            'beta2 was judged to be inside beta, so containment is a bare prefix test'

        # --- a path form that cannot be reasoned about is `none`, never a guess -------------------
        foreach ($odd in @('\\server\share\page.md', '//?/D:/x', '')) {
            $r = Resolve-WorkspaceForPath -FullPath $odd -HookWorkspace $wsA -Registry $registry
            Check ($r.kind -eq 'none') "the path form '$odd' resolved '$($r.kind)' rather than none"
        }

        # --- the hook's workspace wins, and needs no registry at all -------------------------------
        $noReg = Resolve-WorkspaceForPath -FullPath (Join-Path $wsA 'notebook\x.md') -HookWorkspace $wsA -Registry @()
        Check ($noReg.kind -eq 'hook') "with an empty registry a path in the hook's workspace resolved '$($noReg.kind)'"

        # --- THE DENIAL A GUARD ACTUALLY RECEIVES --------------------------------------------------
        $env:LIBRARY_WORKSPACES = $regRoot
        try {
            $foreignShelf = Get-CrossWorkspaceDenial -Target (Join-Path $wsB 'shelf\holding\page.md') -HookWorkspace $wsA
            Check ($foreignShelf -and $foreignShelf -match 'not this workspace') "a foreign Shelf read was not denied; got '$foreignShelf'"

            $foreignNotebook = Get-CrossWorkspaceDenial -Target (Join-Path $wsB 'notebook\topic\a.md') -HookWorkspace $wsA
            Check ([bool]$foreignNotebook) 'a foreign Notebook path was not denied'

            # A foreign path that is NOT a guarded surface is not this function's business. The
            # negative matters as much as the positive: a rule that denied everything in another
            # workspace would refuse a contributor reading a README next door.
            $foreignOther = Get-CrossWorkspaceDenial -Target (Join-Path $wsB 'README.md') -HookWorkspace $wsA
            Check ($null -eq $foreignOther) "a foreign non-surface path was denied: '$foreignOther'"

            # The hook's OWN Shelf must fall through untouched, or every local read would be denied
            # by the wrong rule and the real one would never run.
            $ownShelf = Get-CrossWorkspaceDenial -Target (Join-Path $wsA 'shelf\holding\page.md') -HookWorkspace $wsA
            Check ($null -eq $ownShelf) "the hook's own Shelf was denied by the cross-workspace rule: '$ownShelf'"

            # A relative path can never name another workspace and must not be looked up at all.
            $rel = Get-CrossWorkspaceDenial -Target 'shelf/holding/page.md' -HookWorkspace $wsA
            Check ($null -eq $rel) "a relative path was judged as cross-workspace: '$rel'"

            # A missing marker refuses EVERY path into that workspace, surface or not.
            $brokenAny = Get-CrossWorkspaceDenial -Target (Join-Path $wsC 'README.md') -HookWorkspace $wsA
            Check ($brokenAny -and $brokenAny -match 'marker') "a path into a marker-less workspace was allowed; got '$brokenAny'"
        }
        finally { Remove-Item Env:LIBRARY_WORKSPACES -ErrorAction SilentlyContinue }

        # An empty registry must say nothing, so the machine with no `library init` behaves exactly
        # as it did before this file existed.
        $emptyReg = Join-Path $tmp 'empty-reg'
        New-Item -ItemType Directory -Path $emptyReg -Force | Out-Null
        $silent = Get-CrossWorkspaceDenial -Target (Join-Path $wsB 'shelf\holding\page.md') -HookWorkspace $wsA -RegistryRoot $emptyReg
        Check ($null -eq $silent) "with no registry a foreign path was denied: '$silent'"

        # ==========================================================================================
        # WHICH WORKSPACE AM I IN
        # ==========================================================================================
        # The cases above all answer "which workspace is this PATH in". These answer the other half,
        # and the decoy that separates them is case (4): a directory carrying the PROGRAM marker and
        # no workspace marker. The cwd walk must refuse it and the anchor must accept it, because
        # that one difference is what stops a session run from inside a plugin package resolving the
        # package as the reader's workspace.
        $savedWorkspaceEnv = $env:LIBRARY_WORKSPACE
        Remove-Item Env:LIBRARY_WORKSPACE -ErrorAction SilentlyContinue
        try {
            $deep = Join-Path (Join-Path $wsA 'notebook') 'topic'
            New-Item -ItemType Directory -Path $deep -Force | Out-Null

            # (1) EXPLICIT WINS, and it wins over an environment value that is also a real workspace.
            # Both have to be real or the assertion would pass on the loser being rejected instead.
            $env:LIBRARY_WORKSPACE = $wsB
            $explicit = Resolve-LibraryWorkspace -Explicit $wsA -StartDirectory $wsB -RegistryRoot $emptyReg
            Check ($explicit.kind -ceq 'resolved' -and $explicit.workspace -eq (ConvertTo-WorkspaceRoot $wsA) -and $explicit.source -ceq 'explicit') `
                "an explicit selection resolved '$($explicit.kind)' / '$($explicit.workspace)' / '$($explicit.source)'"

            # (2) THE ENVIRONMENT WINS OVER THE CWD, and is read in the parameter default rather than
            # by any caller. -StartDirectory names a different real workspace, so a cwd that beat the
            # environment would be visible rather than merely untested.
            $fromEnv = Resolve-LibraryWorkspace -StartDirectory $wsA -RegistryRoot $emptyReg
            Check ($fromEnv.workspace -eq (ConvertTo-WorkspaceRoot $wsB) -and $fromEnv.source -ceq 'environment') `
                "LIBRARY_WORKSPACE resolved '$($fromEnv.workspace)' from source '$($fromEnv.source)'"
            Remove-Item Env:LIBRARY_WORKSPACE -ErrorAction SilentlyContinue

            # (3) THE CWD WALKS UP TO THE MARKER, from a directory well below the root.
            $fromCwd = Resolve-LibraryWorkspace -StartDirectory $deep -RegistryRoot $emptyReg
            Check ($fromCwd.workspace -eq (ConvertTo-WorkspaceRoot $wsA) -and $fromCwd.source -ceq 'cwd') `
                "a cwd two levels inside a workspace resolved '$($fromCwd.workspace)' from source '$($fromCwd.source)'"

            # (4) THE DECOY. `program` carries tools/BookRootSchema.ps1 and NO marker -- the shape of
            # a plugin package, and of this repository's own tools directory. The cwd walk must not
            # accept it, or a session running inside an installed package would be judged as though
            # the package were the reader's Library.
            $program = Join-Path $tmp 'program-not-a-workspace'
            New-Item -ItemType Directory -Path (Join-Path $program 'tools') -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $program 'tools\BookRootSchema.ps1'), '# marker', [Text.UTF8Encoding]::new($false))
            $decoyCwd = Resolve-LibraryWorkspace -StartDirectory (Join-Path $program 'tools') -RegistryRoot $emptyReg
            Check ($decoyCwd.kind -ceq 'none') `
                "a cwd inside a program root with no workspace marker resolved '$($decoyCwd.kind)' / '$($decoyCwd.workspace)'"
            Check (-not (Test-WorkspaceMarkerPresent $program)) 'the program decoy was built with a workspace marker, so case 4 proves nothing'

            # (5)-(6) THE ANCHOR IS ADMITTED ON THE MARKER, AND ON NOTHING ELSE.
            #
            # These two cases used to assert the opposite of the first one: `$program` -- the
            # un-split checkout shape, `tools/BookRootSchema.ps1` and no marker -- was ACCEPTED as
            # an anchor, on the argument that a plugin package would never look like that. Step 19
            # made the plugin root the program root, so an installed package is exactly that shape,
            # and the old rule would have let a packaged guard anchor on its own installation.
            #
            # THE FIXTURE IS NAMED FOR WHAT IT NOW STANDS FOR. `$program` is no longer "a checkout
            # we must not break"; it is a plugin cache directory, and the assertion is that a guard
            # finds no workspace in it.
            Check (-not (Test-LibraryWorkspaceAnchor $program)) `
                'a program root with no marker was accepted as an anchor; an installed plugin is exactly this shape'
            Check (Test-LibraryWorkspaceAnchor $wsA) 'a workspace with a marker was refused as an anchor'
            $fromAnchor = Resolve-LibraryWorkspace -StartDirectory $loose -Anchor $program -RegistryRoot $emptyReg
            Check ($fromAnchor.kind -ceq 'none') `
                "an anchor on a marker-less program root resolved '$($fromAnchor.kind)' / '$($fromAnchor.workspace)' instead of none"

            # AND THE HALF THE OLD RULE EXISTED TO PROTECT, which must still hold: a checkout that
            # IS the workspace resolves from its own location. What changed is where that permission
            # comes from -- the marker `library init` writes, rather than the program's shape. Built
            # by ADDING a marker to the same directory, so the only difference between this case and
            # the one above is the thing the rule now reads.
            $initialised = Join-Path $tmp 'unsplit-initialised'
            New-Item -ItemType Directory -Path (Join-Path $initialised 'tools') -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $initialised 'tools\BookRootSchema.ps1'), '# marker', [Text.UTF8Encoding]::new($false))
            New-Item -ItemType Directory -Path (Split-Path -Parent (Get-WorkspaceMarkerPath $initialised)) -Force | Out-Null
            [IO.File]::WriteAllText((Get-WorkspaceMarkerPath $initialised), '{"id":"11111111-1111-1111-1111-111111111111"}', [Text.UTF8Encoding]::new($false))
            Check (Test-LibraryWorkspaceAnchor -Path $initialised -RegistryRoot $emptyReg) `
                'an un-split checkout that HAS been initialised was refused as an anchor, which would silence the boundary on this machine'
            $fromInitialised = Resolve-LibraryWorkspace -StartDirectory $loose -Anchor $initialised -RegistryRoot $emptyReg
            Check ($fromInitialised.workspace -eq (ConvertTo-WorkspaceRoot $initialised) -and $fromInitialised.source -ceq 'anchor') `
                "an initialised un-split anchor resolved '$($fromInitialised.workspace)' from source '$($fromInitialised.source)'"

            # (6b) THE COPIED MARKER, which is the shape an install really produced on 2026-09-20:
            #      `claude plugin marketplace add <local directory>` ignored `.gitignore` and copied
            #      the whole working tree into the plugin cache, `.library/workspace.json` included.
            #      The package then carried a marker bearing the REAL workspace's id, and a guard
            #      running inside it would have anchored on the cache and judged the reader's paths
            #      against a copy of their own Library.
            #
            #      The registry is what tells the two apart: it maps that id to the directory
            #      `library init` issued it for. Built by copying `$initialised`'s marker BYTE FOR
            #      BYTE, because a fixture that mints a fresh id proves nothing -- the whole defect
            #      is that the id is the same one.
            $copiedPkg = Join-Path $tmp 'plugin-cache-copy'
            New-Item -ItemType Directory -Path (Join-Path $copiedPkg 'tools') -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $copiedPkg 'tools\BookRootSchema.ps1'), '# marker', [Text.UTF8Encoding]::new($false))
            New-Item -ItemType Directory -Path (Split-Path -Parent (Get-WorkspaceMarkerPath $copiedPkg)) -Force | Out-Null
            Copy-Item -LiteralPath (Get-WorkspaceMarkerPath $initialised) -Destination (Get-WorkspaceMarkerPath $copiedPkg) -Force
            Check ([IO.File]::ReadAllText((Get-WorkspaceMarkerPath $copiedPkg)) -ceq [IO.File]::ReadAllText((Get-WorkspaceMarkerPath $initialised))) `
                'the copied marker differs from the original, so this case is not testing a copy'

            # A registry that knows the id belongs to `$initialised`, which is the state after
            # `library init` has run once.
            $copyReg = Join-Path $tmp 'reg-copy'
            New-Item -ItemType Directory -Path $copyReg -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $copyReg 'workspaces.json'),
                (@{ workspaces = @(@{ id = '11111111-1111-1111-1111-111111111111'; path = $initialised }) } | ConvertTo-Json -Depth 5),
                [Text.UTF8Encoding]::new($false))

            Check (Test-LibraryWorkspaceAnchor -Path $initialised -RegistryRoot $copyReg) `
                'the workspace the registry actually names was refused as an anchor'
            Check (-not (Test-LibraryWorkspaceAnchor -Path $copiedPkg -RegistryRoot $copyReg)) `
                'a copy of a registered marker was accepted as an anchor, so an installed package can still pose as the Library'
            $fromCopy = Resolve-LibraryWorkspace -StartDirectory $loose -Anchor $copiedPkg -RegistryRoot $copyReg
            Check ($fromCopy.kind -ceq 'none') `
                "an anchor on a copied marker resolved '$($fromCopy.kind)' / '$($fromCopy.workspace)' instead of none"

            # AND THE ASYMMETRY, asserted rather than assumed: an id the registry has never seen is
            # still a workspace. Only a CONTRADICTION refuses, so a never-registered workspace keeps
            # working and the failure stays scoped to the case above.
            Check (Test-LibraryWorkspaceAnchor -Path $copiedPkg -RegistryRoot $emptyReg) `
                'an unregistered marker was refused, which would silence every workspace library init has not registered'

            # (7) THE PACKAGED CASE, which is the whole reason this file grew a second half. The
            # anchor is a bare directory: no marker, no tools/. It must be refused, and the result
            # must be `none` rather than a conflict -- a session outside every workspace is
            # ordinary, not broken. Case (5) above now covers the harder version of this, where the
            # anchor is a full program tree.
            Check (-not (Test-LibraryWorkspaceAnchor $loose)) 'a directory that is neither a workspace nor a program root was accepted as an anchor'
            $packaged = Resolve-LibraryWorkspace -StartDirectory $loose -Anchor $loose -RegistryRoot $emptyReg
            Check ($packaged.kind -ceq 'none' -and $null -eq $packaged.workspace) `
                "a packaged layout with nothing to anchor on resolved '$($packaged.kind)' / '$($packaged.workspace)'"

            # (8) A PATH FORM THAT CANNOT BE A ROOT IS A REFUSAL, NOT A GUESS.
            $unrooted = Resolve-LibraryWorkspace -Explicit '\\server\share\ws' -StartDirectory $loose -RegistryRoot $emptyReg
            Check ($unrooted.kind -ceq 'conflict' -and $unrooted.reason -match 'drive-rooted') `
                "a UNC workspace selection resolved '$($unrooted.kind)': $($unrooted.reason)"

            # --- THE REGISTRY TURNS A DIFFERENCE INTO A CONTRADICTION -----------------------------
            # (9) THE NEGATIVE FIRST, because it is the one that would brick this tree. A selection
            # the registry has never heard of must resolve, whatever the cwd says -- every fixture in
            # every suite passes an explicit workspace from a session sitting somewhere else.
            $unregistered = Resolve-LibraryWorkspace -Explicit $wsA -StartDirectory $wsB -RegistryRoot $regRoot
            Check ($unregistered.kind -ceq 'resolved') `
                "an unregistered workspace selected from a different cwd was refused: $($unregistered.reason)"

            # (10) A registered root selected by its own name agrees with itself. beta's marker holds
            # id `x` and the registry line says `beta`, so this pair is the id-mismatch case (11);
            # beta2 is registered as `beta2` with marker id `x` too. A matching pair is built here
            # rather than reused, so the positive and the negative are not the same fixture.
            $agreed = Join-Path $tmp 'agreed'
            New-Item -ItemType Directory -Path (Join-Path $agreed '.library') -Force | Out-Null
            [IO.File]::WriteAllText((Get-WorkspaceMarkerPath $agreed), '{"id":"agreed"}', [Text.UTF8Encoding]::new($false))
            $agreedRegRoot = Join-Path $tmp 'agreed-reg'
            New-Item -ItemType Directory -Path $agreedRegRoot -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $agreedRegRoot 'workspaces.json'),
                (@{ workspaces = @(@{ id = 'agreed'; path = $agreed }) } | ConvertTo-Json -Depth 4),
                [Text.UTF8Encoding]::new($false))
            $matching = Resolve-LibraryWorkspace -Explicit $agreed -StartDirectory $loose -RegistryRoot $agreedRegRoot
            Check ($matching.kind -ceq 'resolved' -and $matching.workspace -eq (ConvertTo-WorkspaceRoot $agreed)) `
                "a registered workspace whose marker and registry line agree was refused: $($matching.reason)"

            # (11) TWO IDS FOR ONE ROOT. beta's marker says `x`; the registry line says `beta`.
            $idClash = Resolve-LibraryWorkspace -Explicit $wsB -StartDirectory $loose -RegistryRoot $regRoot
            Check ($idClash.kind -ceq 'conflict' -and $idClash.reason -match "calls it 'x'" -and $idClash.reason -match "registers that same path as 'beta'") `
                "a marker/registry id clash resolved '$($idClash.kind)': $($idClash.reason)"

            # (12) A SELECTION THAT IS NOT A ROOT. `beta/shelf` sits inside a registered workspace,
            # so the selection, the cwd and the registry are three different answers and the refusal
            # has to name all three -- which is what the step asks for in so many words.
            $notARoot = Resolve-LibraryWorkspace -Explicit (Join-Path $wsB 'shelf') -StartDirectory $deep -RegistryRoot $regRoot
            Check ($notARoot.kind -ceq 'conflict') "a selection inside a registered workspace resolved '$($notARoot.kind)'"
            Check ($notARoot.reason -match [regex]::Escape((Join-Path $wsB 'shelf'))) "the refusal did not name the selection: $($notARoot.reason)"
            Check ($notARoot.reason -match [regex]::Escape((ConvertTo-WorkspaceRoot $wsA))) "the refusal did not name what the cwd derives: $($notARoot.reason)"
            Check ($notARoot.reason -match 'workspaces\.json') "the refusal did not name the registry: $($notARoot.reason)"

            # (13) A REGISTERED ROOT WHOSE MARKER IS GONE refuses on selection too, not only on a
            # path read into it.
            $brokenSelected = Resolve-LibraryWorkspace -Explicit $wsC -StartDirectory $loose -RegistryRoot $regRoot
            Check ($brokenSelected.kind -ceq 'conflict' -and $brokenSelected.reason -match 'marker') `
                "selecting a registered workspace with no marker resolved '$($brokenSelected.kind)': $($brokenSelected.reason)"

            # (14) THE HELPERS' FORM THROWS ON BOTH FAILING KINDS, because a helper with no workspace
            # has nothing to do, where a hook with no workspace has nothing to say.
            $toolPath = Resolve-ToolWorkspace -Explicit $wsA -RegistryRoot $emptyReg
            Check ($toolPath -eq (ConvertTo-WorkspaceRoot $wsA)) "Resolve-ToolWorkspace returned '$toolPath'"
            $noneThrew = ''
            try { Resolve-ToolWorkspace -Anchor $loose -StartDirectory $loose -RegistryRoot $emptyReg | Out-Null } catch { $noneThrew = [string]$_.Exception.Message }
            Check ($noneThrew -match 'library init') "Resolve-ToolWorkspace was silent with no workspace anywhere; got '$noneThrew'"
            $conflictThrew = ''
            try { Resolve-ToolWorkspace -Explicit $wsC -StartDirectory $loose -RegistryRoot $regRoot | Out-Null } catch { $conflictThrew = [string]$_.Exception.Message }
            Check ($conflictThrew -match 'marker') "Resolve-ToolWorkspace swallowed a conflict; got '$conflictThrew'"

            # (15) AN UNREADABLE MARKER THROWS rather than reading as an identity-less workspace, the
            # same direction Read-WorkspaceRegistry takes and for the same reason.
            $badMarker = Join-Path $tmp 'bad-marker'
            New-Item -ItemType Directory -Path (Join-Path $badMarker '.library') -Force | Out-Null
            [IO.File]::WriteAllText((Get-WorkspaceMarkerPath $badMarker), '{ not json', [Text.UTF8Encoding]::new($false))
            $markerThrew = ''
            try { Read-WorkspaceMarker -Workspace $badMarker | Out-Null } catch { $markerThrew = [string]$_.Exception.Message }
            Check ($markerThrew -match 'not readable JSON') "an unreadable marker did not throw; got '$markerThrew'"
            Check ($null -eq (Read-WorkspaceMarker -Workspace $loose)) 'a directory with no marker did not read as absent'
        }
        finally {
            if ($null -eq $savedWorkspaceEnv) { Remove-Item Env:LIBRARY_WORKSPACE -ErrorAction SilentlyContinue }
            else { $env:LIBRARY_WORKSPACE = $savedWorkspaceEnv }
        }

        # --- THE SURFACE NAMES ARE CHECKED AGAINST THEIR OWNER -------------------------------------
        # `shelf` is BookRootSchema's prefix, not this file's invention. If it is ever renamed there,
        # this guard would silently stop covering a Shelf, so the two are compared rather than
        # trusted to stay in step.
        . (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
        Check ((Get-BookRootPattern) -match 'shelf') "BookRootSchema no longer spells 'shelf', so the guarded-surface list is stale"
        Check ($script:WorkspaceGuardedSurfaces -contains 'shelf') 'the guarded-surface list lost shelf'
        Check ($script:WorkspaceGuardedSurfaces -contains 'notebook') 'the guarded-surface list lost notebook'
    }
    finally {
        try { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }

    if ($failures.Count) {
        [Console]::Error.WriteLine("WorkspaceRegistry self-test FAILED: $($failures -join '; ')")
        exit 1
    }
    Write-Host "WorkspaceRegistry self-test passed ($script:wsChecks checks)."
    exit 0
}

# `-ne '.'` is what tells a dot-source from a direct run: a dot-sourced file must define and return,
# never execute a suite in its caller's process.
if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') { Invoke-WorkspaceRegistrySelfTest }
