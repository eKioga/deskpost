<#
.SYNOPSIS
    Where a Shelf path sits relative to the Virtual Desk, defined once. Dot-sourced; never invoked
    directly.

.DESCRIPTION
    A closed Shelf Book lives on this disk, so "closed" is a property the Library has to supply
    itself. `Guard-ShelfBookRead.ps1` supplied it for `Read`, `Grep` and `Glob`. It did not supply it
    for `Bash`, and on 2026-09-06 a `wc -c` on a page of the closed `holding` Book returned a byte
    count from a session whose `Read` of the same path had just been denied.

    That gap is why this file exists rather than a second copy of the rules inside a second guard.
    `tools/BookRootSchema.ps1` records what happens when one shape is written out in eight places;
    these five functions were on their way to being written out in two. Both guards now dot-source
    them, so a rule tightened for one tool is tightened for the other in the same edit.

    Every function here THROWS on malformed state rather than returning a permissive default. Both
    callers turn a throw into a denial, and that is the only correct direction: a Desk whose state
    cannot be parsed is a Desk that cannot vouch for anything being open.
#>

Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) (Join-Path 'tools' 'BookRootSchema.ps1'))

# $Directory is a SEAT's Desk directory now (.claude/seats/<seat>), not .claude. The parameter did
# not change meaning -- it has always been "the directory holding the Desk files" -- but where that
# directory is has, so the name is composed by BookRootSchema rather than here.
function Get-OpenShelfRoots([string]$Directory) {
    $openBooksPath = Get-DeskFileInDirectory -DeskDirectory $Directory -Kind 'books'
    if (-not (Test-Path -LiteralPath $openBooksPath -PathType Leaf)) { throw 'Virtual Desk configuration is missing .open-books.' }
    $items = @(Get-DeskFileEntries -Path $openBooksPath)
    # -cnotmatch/-cmatch, not the case-insensitive defaults: a hand-edited 'shelf/Odysseus' would
    # otherwise pass as well-formed and be returned with its original casing, which the -cin test at
    # the decision point cannot match. That denies a Book the reader did open, and reports it as
    # closed rather than as malformed state. Failing closed is right; the wrong reason is not.
    foreach ($item in $items) { if ($item -cnotmatch (Get-BookRootAcceptPattern)) { throw 'Virtual Desk open-book state is malformed.' } }
    # ROOTS, NOT SLUGS, since 2026-08-26. `shelf/demo` and `shelf/_archive/demo` are two different
    # Books that happen to share a name, so reducing both to 'demo' would let opening the ARCHIVED
    # one unlock its active twin -- precisely the defect 3.2 fixed for the shared archive, repeated
    # one collection over. Keying on the root is what makes the two distinguishable at the decision
    # point below.
    @($items | ForEach-Object { $parts = Split-BookRoot $_; if ($parts.collection -ceq 'shelf') { $parts.root } })
}

# The Shelf root a workspace-relative path names, or $null when it is not a canonical Book path.
# THE ARCHIVED FORM IS TESTED FIRST. `shelf/([a-z0-9]...)` cannot match `_archive`, so without this
# branch every path inside the archive reads as a non-canonical Shelf path and is denied -- which
# would leave an archived Book that opens on the Desk and is still unreadable, a feature in name only.
function Get-ShelfRootForPath([string]$Relative) {
    if ($Relative -match '^(?i)shelf/_archive/([a-z0-9][a-z0-9-]*)(?:/|$)') { return "shelf/_archive/$($Matches[1].ToLowerInvariant())" }
    if ($Relative -match '^(?i)shelf/([a-z0-9][a-z0-9-]*)(?:/|$)') { return "shelf/$($Matches[1].ToLowerInvariant())" }
    $null
}

# How a reader opens the Book they were just denied. The two shelves take different flags, and a
# deny that names the wrong command sends them to a helper that will refuse them again.
function Get-ShelfOpenCommand([string]$Root) {
    $parts = Split-BookRoot $Root
    if ($parts.shelf -ceq 'archive') {
        return "tools/Set-VirtualDesk.ps1 -Action Open -Kind Book -Location Shelf -Shelf Archive -Slug $($parts.slug)"
    }
    "tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug $($parts.slug)"
}

# THE THREE ANSWERS, AND WHY $null USED TO BE TWO OF THEM.
#
# Until 2026-09-07 this returned $null for BOTH "legitimately outside the workspace" and "a path form
# I could not normalise", and Guard-ShelfBookRead read $null as allow. Four aliased spellings of a
# path INSIDE the workspace therefore tested as outside it and walked past the closed-Book guard:
#
#     \\?\D:\Library\shelf\...      //?/D:/Library/shelf/...
#     \\localhost\D$\Library\...    \\.\D:\Library\shelf\...
#
# Measured against the guard's own anchor on 2026-09-07, not reasoned about. Denying every $null
# instead would have blocked every genuine read outside the workspace, which is why this is a
# tri-state rather than a tightened boolean: `outside` is allowed, `invalid` is refused.
#
# THE RECOGNISED FORMS ARE AN ALLOWLIST, AND DELIBERATELY NOT AN ENUMERATION OF THOSE FOUR. An
# enumeration is always incomplete -- nothing says those four are all of them, and the fifth arrives
# silently. Exactly two forms are recognised: a path that is not rooted at all, which is joined to
# the workspace, and a drive-rooted local path (`X:\...` or `X:/...`). EVERY other form is `invalid`,
# UNC included -- because `\\localhost\D$\` IS a UNC path, and admitting the class to spare the
# genuine remote ones would readmit the bypass wholesale.
#
# THE COST, STATED RATHER THAN DISCOVERED: a genuine remote path like
# `\\nas\share\basic-memory\...` is refused by this guard, and the refusal names the fix (use
# the mapped drive). Nothing in this workspace reads that path through a guarded tool today --
# `SharedCollectionFiles.ps1` reaches it in-process with Test-Path, which no hook sees -- so this
# denies no call that exists. Checked 2026-09-07 rather than assumed.
#
# Returns kind `inside` with the workspace-relative forward-slash form (the workspace root itself is
# `inside` with an empty relative, naming no particular Book), `outside` with a $null relative, or
# `invalid` with the reason the form was not recognised.
function ConvertTo-WorkspaceRelative([string]$Path, [string]$Workspace) {
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return [pscustomobject]@{ kind = 'invalid'; relative = $null; reason = 'the path is empty' }
    }
    $candidate = $Path
    if ([IO.Path]::IsPathRooted($candidate)) {
        # A rooted path must be drive-rooted to be recognised. This is the whole allowlist: `\\?\`,
        # `//?/`, `\\.\`, `\\host\share` and a bare `\Library\...` or `/d/Library/...` all fail it.
        if ($candidate -notmatch '^[A-Za-z]:[\\/]') {
            return [pscustomobject]@{
                kind     = 'invalid'
                relative = $null
                reason   = 'the path form is not a drive-rooted local path, so where it points cannot be established'
            }
        }
    }
    else {
        $candidate = Join-Path $Workspace $candidate
    }
    try { $full = [IO.Path]::GetFullPath($candidate).TrimEnd([IO.Path]::DirectorySeparatorChar) } catch {
        return [pscustomobject]@{ kind = 'invalid'; relative = $null; reason = 'the path could not be normalised' }
    }
    # A normaliser that hands back something that is no longer drive-rooted has been walked out of
    # the form that was recognised on the way in, and the answer is not trustworthy.
    if ($full -notmatch '^[A-Za-z]:[\\/]') {
        return [pscustomobject]@{ kind = 'invalid'; relative = $null; reason = 'the normalised path left the drive-rooted form it was accepted as' }
    }
    $root = [IO.Path]::GetFullPath($Workspace).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{ kind = 'inside'; relative = ''; reason = $null }
    }
    if (-not $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{ kind = 'outside'; relative = $null; reason = $null }
    }
    [pscustomobject]@{ kind = 'inside'; relative = $full.Substring($root.Length + 1).Replace('\', '/'); reason = $null }
}

# --- Codex's apply_patch -----------------------------------------------------------------------
#
# THE SHAPE WAS CAPTURED, NOT GUESSED, AND GUESSING IS WHY THIS COMMENT EXISTS. The session that
# first bound these hooks guessed Codex's shell tool was named `exec` and shipped a matcher that
# could never fire; the captured payload said `Bash`. So a real `apply_patch` call was captured the
# same way before a line of this was written, on 2026-09-07 against codex-cli 0.147.0:
#
#     "tool_name": "apply_patch",
#     "tool_input": { "command": "*** Begin Patch\n*** Update File: probe.txt\n@@\n-alpha\n+beta\n*** End Patch" }
#
# TWO THINGS THAT WOULD OTHERWISE HAVE BEEN WRONG. `tool_name` is `apply_patch` verbatim -- it is
# NOT normalised to a Claude Code name the way the shell tool becomes `Bash`. And `tool_input`
# carries NO `file_path`: it reuses the shell tool's `command` field, holding the whole patch
# document, with every path inside the envelope. Guard-ShelfBookRead reads `file_path`/`path`, so
# registering apply_patch there without this parser would have matched and found nothing to judge --
# the same shape of silent no-op as the `exec` matcher.
#
# ONE PATCH CARRIES MANY FILES. A captured payload adds, updates, deletes and moves in a single call,
# so this returns EVERY path and the caller judges all of them. Stopping at the first would be the
# migrate-only-the-first-writer defect this repository has already paid for twice.
$script:ApplyPatchPathDirectives = @('Add File:', 'Update File:', 'Delete File:', 'Move to:')

# A directive that names no path. `Move to:` is deliberately NOT here: it names the destination of a
# rename, and a rename INTO a closed Book is a write into it.
#
# `End of File` IS HERE BECAUSE CODEX EMITS IT, AND THAT WAS MEASURED RATHER THAN RECALLED. The first
# version of this allowlist held only the two envelope markers, which would have refused every patch
# that appends to the end of a file -- a false denial on one of the commonest edits there is. A
# second capture on 2026-09-07, asking Codex to append a final line, returned:
#
#     *** Begin Patch
#     *** Update File: eof.txt
#     @@
#     +four
#     *** End of File
#     *** Add File: empty.txt
#     *** End Patch
#
# It names no file, so admitting it cannot hide a path. The lesson is the allowlist's own cost: it
# fails closed on what it has not been taught, so what it is taught has to come from a real payload.
$script:ApplyPatchBareDirectives = @('Begin Patch', 'End Patch', 'End of File')

function Get-ApplyPatchPaths([string]$PatchText) {
    <#
    .SYNOPSIS
        Every path an apply_patch document names. THROWS on any directive it was not taught.

    .DESCRIPTION
        AN ALLOWLIST, because a denylist in this exact position already cost this repository a live
        hole: `'Append'` is not `-cin` a lowercase list, and the operation walked past the Basic
        Memory guard. A parser that skips the directives it does not recognise fails OPEN and
        silently, which is the one outcome a boundary may never have.

        Column zero is what makes a directive a directive. Patch content lines are prefixed -- `+`,
        `-` or a space -- so a file whose own text contains `*** Begin Patch` appears here as
        `+*** Begin Patch` and cannot be mistaken for one. Same rule, and the same reason, as the
        column-zero H1 the Notebook renderer learned the expensive way.
    #>
    if ([string]::IsNullOrWhiteSpace($PatchText)) { throw 'apply_patch carried no patch document.' }
    $paths = [Collections.Generic.List[string]]::new()
    $sawBegin = $false
    foreach ($line in ($PatchText -split "`r?`n")) {
        if (-not $line.StartsWith('*** ')) { continue }
        $body = $line.Substring(4).Trim()
        if ($body -cin $script:ApplyPatchBareDirectives) {
            if ($body -ceq 'Begin Patch') { $sawBegin = $true }
            continue
        }
        $matched = $false
        foreach ($directive in $script:ApplyPatchPathDirectives) {
            if ($body.StartsWith($directive)) {
                $named = $body.Substring($directive.Length).Trim()
                if ([string]::IsNullOrWhiteSpace($named)) { throw "apply_patch names a '$directive' directive with no path." }
                [void]$paths.Add($named)
                $matched = $true
                break
            }
        }
        if (-not $matched) {
            throw ("apply_patch used the directive '$line', which this guard has not been taught. " +
                   'Refusing rather than guessing which file it names.')
        }
    }
    if (-not $sawBegin) { throw 'apply_patch carried no "*** Begin Patch" envelope, so its file list cannot be trusted.' }
    @($paths)
}

# A glob or Glob pattern aimed into shelf/ is deliberate targeting, so it is judged on the literal
# text rather than a resolved path. Returns the closed root it would reach, '*' when it spans the
# whole Shelf, or $null when it does not target the Shelf at all.
function Get-ShelfPatternTarget([string]$Pattern, [string[]]$OpenRoots) {
    if ([string]::IsNullOrWhiteSpace($Pattern)) { return $null }
    $normalized = $Pattern.Replace('\', '/').TrimStart('.', '/')
    if ($normalized -notmatch '^(?i)shelf/') { return $null }
    $patternRoot = Get-ShelfRootForPath $normalized
    if ($patternRoot) {
        if ($patternRoot -cin $OpenRoots) { return $null }
        return $patternRoot
    }
    # shelf/**, shelf/*/wiki, shelf/_archive/** and friends span Books the reader has not opened.
    return '*'
}

# The Shelf catalog is the browse surface and stays readable, exactly as the shared Book Catalog
# does. Naming what could be opened is not reading any of it.
function Test-ShelfBrowseSurface([string]$Relative) {
    $Relative -match '^(?i)shelf/_catalog\.md$'
}
