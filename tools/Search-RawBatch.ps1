<#
.SYNOPSIS
    Search ONE named source batch under raw/ for a literal term, and report where it occurs.
    Never scans across raw/, and never returns a line without saying how it may be cited.

.DESCRIPTION
    Plan item 2.4. The reader-facing entry point; tools/RawSearch.ps1 holds the engine, the
    provenance rules, the leak canaries, and the suite, exactly as BookFullText.ps1 does for 2.3.

    THIS IS NOT AN MCP TOOL, AND THAT IS THE DESIGN. The two Book tiers reach the reader through the
    validated reader because they touch material the Desk gates: a Book must be proved open before a
    body may be read, and only the adapter can prove it. raw/ has no Desk, no catalog, no slug, and
    no manifest -- there is nothing here for a validated reader to validate. It is a filesystem scan
    over untracked source material, so it is a plain helper. That also keeps it honest about the
    allowlist: a new public helper raises helpers.manifest-matches-allowlist, which the reader can
    see, whereas a new MCP tool raises nothing at all and simply prompts once per session.

    SEARCH OR DELEGATE. Reach for this when the question is WHERE A KNOWN STRING LIVES: it locates
    cheaply, returns exact paths, and its output is evidence the reader can open. Delegate the read
    when the question is WHAT A BODY OF MATERIAL SAYS: a delegated read synthesises and returns a
    claim, which is not evidence until it is checked against the files it cites. This helper does
    not summarise, and quoting its lines as a summary is the failure in the other direction.

.EXAMPLE
    tools/Search-RawBatch.ps1 -List
    The real batch roster, at both depths a batch actually sits at. Name one of these.

.EXAMPLE
    tools/Search-RawBatch.ps1 -Batch 'LLM Workflow Testing/pilot' -Query 'Holding Shelf'
    Every occurrence inside the retained Pilot-era copy -- every line labelled [historical],
    because those instructions are RETIRED and must never be cited as current policy.
#>
[CmdletBinding()]
param(
    [string]$Batch,
    [string]$Query,
    [int]$MaxResults = 50,
    [string]$WorkspacePath,
    [switch]$List,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'RawSearch.ps1')

# STEP 20: THE WORKSPACE IS SELECTED, NOT ASSUMED. `Split-Path -Parent $PSScriptRoot` answered
# "which workspace" with "one level above my own code", which is right only while the program and
# the workspace are the same directory. Order: -WorkspacePath, then LIBRARY_WORKSPACE, then the
# nearest `.library/workspace.json` above the working directory, then this program's own root --
# and that last one only while the program really is a workspace, which is what keeps an un-split
# checkout working and stops an installed package inventing one. tools/WorkspaceRegistry.ps1.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
$WorkspacePath = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath $WorkspacePath -PathType Container)) {
    Write-LibraryFailure "No such workspace: $WorkspacePath"
}

try {
    if ($List) {
        $roster = @(Get-RawBatchRoster -Workspace $WorkspacePath)
        $result = [pscustomobject]@{
            operation = 'Raw source batch roster'
            status    = 'ok'
            count     = $roster.Count
            roster    = $roster
            rendered  = (Format-RawBatchRoster $roster)
        }
        if (-not $Json) { Write-Output $result.rendered; exit 0 }
        Write-LibraryResult -Result $result -Json
        exit 0
    }

    # A missing query is a failure; a missing BATCH is not. An unnamed batch is reported by the
    # engine with the roster attached, because "you did not name a batch" and "here is what you
    # could have named" are one answer, and because the alternative -- widening to raw/ -- is the
    # thing 2.4 forbids.
    if ([string]::IsNullOrWhiteSpace($Query)) {
        Write-LibraryFailure 'A search needs -Query. Run with -List to see the source batches you can name.'
    }

    $found = Find-RawBatchLines -Workspace $WorkspacePath -Batch $Batch -Query $Query -MaxResults $MaxResults
    if (-not $Json) { Write-Output (Format-RawSearchResult $found); exit 0 }
    Write-LibraryResult -Result $found -Json
    exit 0
}
catch {
    Write-LibraryFailure $_.Exception.Message
}
