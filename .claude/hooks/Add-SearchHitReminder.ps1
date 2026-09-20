[CmdletBinding()]
param(
    [string]$StateDirectory,
    [Parameter(ValueFromPipeline = $true)]
    [string]$InputJson,
    [string]$InputJsonBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
    docs/hit-is-a-location.md, and CLAUDE.md after it, say the same thing: discover_book_pages,
    search_open_books and Search-RawBatch report only WHERE a term occurs. Answering from the
    surrounding snippet instead of opening the page it names is the defect, and an answer that
    stopped early is never a finding of absence.

    That rule differs from most of CLAUDE.md in a way that suits it to a hook. It does not describe a
    procedure to follow at some later point; it describes a temptation that arrives at one exact
    instant -- the moment a result list appears and reading further starts to look optional. A
    sentence delivered at that instant is worth more than a paragraph read three hundred turns
    earlier, and costs about thirty tokens.

    IT FIRES ON EVERY SEARCH, with no once-per-session ledger. The other injecting hooks are capped
    because they carry procedures, which are remembered once learned. This one is not a procedure. It
    is a check against a pull that recurs identically at every result list, so a cap would silence it
    on precisely the second and third occasions it was written for.

    IT DOES NOT READ THE RESULTS. Deciding whether a particular tool returned "nothing" means
    modelling three different output shapes and being wrong about one of them; a hook that
    confidently announced an empty result set to a session that then acted on it would be doing the
    damage the rule exists to prevent. The line covers both cases and asserts nothing about which
    one this is.
#>

. (Join-Path $PSScriptRoot 'HookContext.ps1')

$script:SearchTools = @(
    'mcp__validated-book-reader__discover_book_pages',
    'mcp__validated-book-reader__search_open_books'
)

try {
    if (-not $StateDirectory) { $StateDirectory = Split-Path -Parent $PSScriptRoot }
    $call = Read-HookPayload -BoundParameters $PSBoundParameters -InputJson $InputJson -InputJsonBase64 $InputJsonBase64
    $toolName = [string](Get-HookField $call 'tool_name')

    $isSearch = $toolName -cin $script:SearchTools
    if (-not $isSearch) {
        # Search-RawBatch.ps1 is a script, so it arrives as a shell command rather than a tool name.
        $toolInput = Get-HookField $call 'tool_input'
        $command = Get-HookCommandText $toolInput
        $isSearch = $command -match 'Search-RawBatch\.ps1'
    }
    if (-not $isSearch) { exit 0 }

    $reminder = 'A hit is a location, not a reading: these results say only where the term occurs. ' +
        'Open what a hit names before answering from it, and cite the hit as where you looked. ' +
        'If nothing matched, that is a search that stopped early, not a finding of absence.'
    Write-HookOutput 'PostToolUse' @{ additionalContext = $reminder }
}
catch {
    exit 0
}
