<#
.SYNOPSIS
    Where the Library's own code lives, as distinct from where the reader's workspace is.
    Dot-sourced; never invoked directly.

.DESCRIPTION
    Until 2026-09-20 every hook resolved BOTH of those with one expression:

        Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

    Two levels up from `.claude/hooks` is `D:\Library`, which is simultaneously the program and the
    workspace -- so the same expression answered "where is tools/?" and "which workspace am I
    guarding?" correctly, and nothing distinguished them. They are not the same question, and they
    stop having the same answer the moment the program is installed as a package (step 19): a
    plugin's hooks sit ONE level below the plugin root, not two, and the workspace is somewhere else
    entirely.

    MEASURED, NOT PREDICTED (2026-09-20, S11). The same guard bytes were run in both layouts against
    one workspace and one absolute path to a closed Shelf Book. In-workspace the guard denied
    correctly. From a plugin-shaped root all four hooks exited 1 with nothing on stdout, because
    their dependency dot-sources -- which sit ABOVE the try block -- could not resolve. Claude Code's
    documentation is explicit about what that means: "Without valid JSON on stdout, Claude Code
    treats exit code 1 as a non-blocking error and proceeds with the action." The packaged Desk
    boundary did not fail closed. It failed OPEN and said nothing.

    So this file answers only the first question. The program root is the nearest ancestor of the
    hooks directory that actually contains the code -- found by looking for it rather than by
    counting directory levels, because the level count is exactly what differs between the two
    layouts. The workspace is a separate question with a separate answer, and deriving it from
    $PSScriptRoot is the defect above, not a fallback.

    This file is dot-sourced from $PSScriptRoot and reaches for nothing, so it resolves in any
    layout -- the same property HookContext.ps1 has, and for the same reason: something has to be
    loadable before anything else can fail safely.
#>

Set-StrictMode -Version Latest

# The file every hook's dependency chain needs. Used as the marker because a directory holding it
# IS the program root by definition -- there is no separate stamp to keep in step with a move.
$script:ProgramRootMarker = Join-Path 'tools' 'BookRootSchema.ps1'

function Get-LibraryProgramRoot {
    <#
        The nearest ancestor of -From holding tools/BookRootSchema.ps1.

        THROWS when there is none, and that is load-bearing: every caller dot-sources this before its
        own try block opens, so a throw here becomes a denial rather than a silent exit 1. A guard
        that cannot find its own rules must refuse, not shrug.
    #>
    param([string]$From)

    if ([string]::IsNullOrWhiteSpace($From)) { $From = $PSScriptRoot }
    $current = [IO.Path]::GetFullPath($From)
    $seen = [Collections.Generic.List[string]]::new()

    while (-not [string]::IsNullOrWhiteSpace($current)) {
        [void]$seen.Add($current)
        if (Test-Path -LiteralPath (Join-Path $current $script:ProgramRootMarker) -PathType Leaf) {
            return $current
        }
        $parent = Split-Path -Parent $current
        # Split-Path on a drive root returns '' on Windows and the same path on some shapes; both
        # end the walk rather than spinning.
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) { break }
        $current = $parent
    }

    throw ("The Library's program root was not found above '$From': no ancestor contains " +
           "$script:ProgramRootMarker. Looked in: " + ($seen -join '; '))
}

function Get-LibraryProgramFile {
    <#
        The full path to one file under the program root's tools/ directory.

        Returns a PATH rather than dot-sourcing it, deliberately. Dot-sourcing inside a function
        binds the definitions to that function's scope, so a helper that tried to be convenient here
        would load BookRootSchema.ps1 into itself and leave the caller with nothing -- failing in the
        confusing direction, where the file loaded and the functions are still missing.
    #>
    param(
        [Parameter(Mandatory)][string]$Name,
        [string]$From
    )
    Join-Path (Get-LibraryProgramRoot -From $From) (Join-Path 'tools' $Name)
}
