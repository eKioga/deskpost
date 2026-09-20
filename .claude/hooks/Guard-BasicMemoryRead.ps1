[CmdletBinding()]
param(
    [string]$StateDirectory,
    [string]$Seat,
    [Parameter(ValueFromPipeline = $true)]
    [string]$InputJson,
    [string]$InputJsonBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The Book-root state schema (plan item 3.2) lives in tools/BookRootSchema.ps1, and this hook reads
# it rather than carrying its own copy of the shape. The dependency is deliberate and it is safe
# here for one reason worth stating: every path out of this file's catch block DENIES, so a schema
# that cannot be loaded fails the guard closed rather than opening it.
. (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) (Join-Path 'tools' 'BookRootSchema.ps1'))

function Write-Deny([string]$Reason) {
    @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $Reason } } | ConvertTo-Json -Compress
}

function Read-StateLines([string]$Path, [string]$Pattern, [string]$Label, [switch]$Optional) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if (-not $Optional) { throw "Virtual Desk configuration is missing $Label." }
        Write-AtomicText -Path $Path -Text '' | Out-Null
        return @()
    }
    $items = @(Get-DeskFileEntries -Path $Path)
    # -cnotmatch: every Pattern here is lowercase-only, and the case-insensitive default would admit
    # 'Books/Demo' as well-formed state that the -ceq comparisons below can then never match.
    foreach ($item in $items) { if ($item -cnotmatch $Pattern) { throw "Virtual Desk $Label state is malformed." } }
    if (@($items | Select-Object -Unique).Count -ne $items.Count) { throw "Virtual Desk $Label state contains duplicates." }
    $items
}

function Get-DeskState([string]$Directory, [string]$StateDirectory) {
    # $Directory is the SEAT's Desk; $StateDirectory is `.claude`, which holds the workspace pin that
    # every seat shares. Reading the pin from the Desk directory made this guard deny everything,
    # because the pin is not there -- caught by the schema self-test rather than in a live session.
    $projectPath = Join-Path $StateDirectory '.library-project'
    if (-not (Test-Path -LiteralPath $projectPath -PathType Leaf)) { throw 'Virtual Desk configuration is missing .library-project.' }
    $projectId = (Get-Content -LiteralPath $projectPath -Raw).Trim()
    if ($projectId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'Virtual Desk project pin is malformed.' }
    # books/<slug> and archive/<slug> are shared Books; shelf/<slug> is local and never reachable
    # through Basic Memory. THE ROOT IS KEPT, not reduced to a bare slug as it was before 3.2: a
    # shared Book's directory is now either books/<slug> or archive/<slug>, and a bare slug cannot
    # say which, so reducing it here would have widened the allowance to both.
    $openBooks = @(Read-StateLines -Path (Get-DeskFileInDirectory -DeskDirectory $Directory -Kind 'books') -Pattern (Get-BookRootAcceptPattern) -Label 'open-book' |
        ForEach-Object { ConvertTo-BookRoot $_ } |
        Where-Object { (Split-BookRoot $_).collection -ceq 'shared' })
    $openProjects = Read-StateLines -Path (Get-DeskFileInDirectory -DeskDirectory $Directory -Kind 'projects') -Pattern '^(projects|archive/projects)/[a-z0-9][a-z0-9-]*$' -Label 'open-project' -Optional
    @{ project_id = $projectId; open_books = $openBooks; open_projects = $openProjects }
}

function Test-CanonicalPath([string]$Path) {
    $Path -and $Path -notmatch '[\\]' -and $Path -notmatch '(^/|//|(^|/)\.\.(/|$)|(^|/)\./)' -and $Path -match '^[A-Za-z0-9._/-]+$'
}

# THE OPERATIONS THAT MAY TAKE THE DIRECT PATH, as an allowlist rather than a denylist of the four
# that duplicate content. Both readings were written; only one of them holds.
#
# The problem being closed: append, prepend, insert_before_section and insert_after_section
# DUPLICATE CONTENT SILENTLY on a second application, and nothing on this path journals a previous
# body or reads back what it wrote, so a retried append is indistinguishable from an intended one.
# Edit-ProjectHub.ps1 names exactly those four in its own retry predicate for exactly this reason.
#
# WHY AN ALLOWLIST. The first version here was a denylist compared with -cin, copying the idiom from
# those retry predicates, and the self-test caught it in one run: 'Append' is not -cin a lowercase
# list, so capitalising the operation walked straight past the exclusion. Comparing case-insensitively
# would fix that one spelling and still admit any operation added to the tool later -- and a guard
# that admits what it has not been taught fails OPEN, silently. So the two operations that are known
# safe are named, and everything else is refused, including an absent operation: write_note is
# permalink-keyed, replace_section is idempotent, and find_replace self-guards through
# expected_replacements. Source: the basic-memory Book, page write-semantics-and-retry-safety.
$script:IdempotentEditOperations = @('replace_section', 'find_replace')

function Test-EditOperationAllowed($ToolInput) {
    # Enumerated rather than read straight off .PSObject.Properties.Name: that aggregate throws
    # under Set-StrictMode when the collection is empty, which is defect family 4 and would take the
    # whole guard into its catch. The catch denies, so that failure is safe -- but it would deny
    # every edit, including the two that are meant to work.
    $names = @($ToolInput.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -notcontains 'operation') { return $false }
    # -cin: the allowlist is exact and lowercase, so an oddly-cased spelling is not recognised and
    # is therefore refused. That is the direction an allowlist gets wrong safely.
    [string]$ToolInput.operation -cin $script:IdempotentEditOperations
}

function Test-HubRootWrite($ToolInput) {
    <#
        THE ROOT ONLY, and that boundary is the ruling rather than a compromise. projects/<slug>/
        _project.md is the page every seat touches at session close, so it is where two writers
        actually collide; it is also the most structured page in the collection, so a whole-page
        overwrite from outside Edit-ProjectHub -- which journals the previous body, holds the
        projects/<slug> lock, and verifies the readback -- is the highest-cost write available.

        Every OTHER page under projects/<slug>/ keeps the direct path deliberately. notes/ and
        limits/ are append-only narrative where collisions are least likely and the escape hatch
        earns its keep: there is no remove-item mode in the helper, so retiring one closed entry
        already costs a whole ReplaceSection.
    #>
    $names = @($ToolInput.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -notcontains 'directory' -or $names -notcontains 'title') { return $false }
    # Exactly two segments: projects/<slug>. A page under it has more, and is not the root.
    if ([string]$ToolInput.directory -cnotmatch '^projects/[a-z0-9][a-z0-9-]*$') { return $false }
    # Both spellings, because the tool takes a title and a caller may or may not carry the suffix.
    [string]$ToolInput.title -cin @('_project', '_project.md')
}

function Test-ActiveProjectWrite($ToolInput, [string[]]$OpenProjects) {
    $projectRoot = $null
    if ($ToolInput.PSObject.Properties.Name -contains 'directory') {
        $directory = [string]$ToolInput.directory
        $title = [string]$ToolInput.title
        # -cmatch on the path: 'projects/' and the slug are lowercase-only, so the default would let a
        # write to 'Projects/<slug>' satisfy the active-Project rule. Page names stay case-tolerant.
        if ($directory -cnotmatch '^projects/[a-z0-9][a-z0-9-]*(?:/[A-Za-z0-9._-]+)*$' -or $title -notmatch '^(?:_project|[A-Za-z0-9][A-Za-z0-9 _.-]*)$') { return $false }
        $parts = @($directory -split '/')
        $projectRoot = "$($parts[0])/$($parts[1])"
    }
    elseif ($ToolInput.PSObject.Properties.Name -contains 'identifier') {
        $identifier = [string]$ToolInput.identifier
        if ($identifier -cnotmatch '^projects/[a-z0-9][a-z0-9-]*(?:/[A-Za-z0-9._ -]+)*$') { return $false }
        $parts = @($identifier -split '/')
        $projectRoot = "$($parts[0])/$($parts[1])"
    }
    if ($null -eq $projectRoot) { return $false }
    $projectRoot -cin $OpenProjects
}

try {
    if (-not $StateDirectory) { $StateDirectory = Split-Path -Parent $PSScriptRoot }
    $rawInput = if ($PSBoundParameters.ContainsKey('InputJsonBase64')) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($InputJsonBase64)) } elseif ($PSBoundParameters.ContainsKey('InputJson')) { $InputJson } else { [Console]::In.ReadToEnd() }
    $call = $rawInput | ConvertFrom-Json
    # This guard needs the Desk for EVERY call it sees -- it exists to answer "is that Book open" --
    # so unlike the Shelf guards there is no cheap test that can precede the seat. No seat means no
    # Desk means nothing is open, and the catch below turns that into a denial naming the fix.
    $state = Get-DeskState -Directory (Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat) -StateDirectory $StateDirectory
    $toolName = [string]$call.tool_name
    $input = $call.tool_input
    if ([string]$input.project_id -cne $state.project_id) { Write-Deny 'Virtual Desk requires the pinned project_id.'; exit 0 }
    if ($input.PSObject.Properties.Name -contains 'project') { if ($null -ne $input.project -and -not [string]::IsNullOrWhiteSpace([string]$input.project)) { Write-Deny 'Virtual Desk does not permit project-name routing.'; exit 0 } }

    if ($toolName -in @('mcp__basic-memory__read_note', 'mcp__basic-memory__read_content', 'mcp__basic-memory__view_note', 'mcp__basic-memory__fetch', 'mcp__basic-memory__search', 'mcp__basic-memory__search_notes', 'mcp__basic-memory__build_context', 'mcp__basic-memory__recent_activity')) {
        Write-Deny 'Direct shared-content readers and search are suspended pending a return-validating adapter.'; exit 0
    }
    if ($toolName -in @('mcp__basic-memory__write_note', 'mcp__basic-memory__edit_note')) {
        if (-not (Test-ActiveProjectWrite -ToolInput $input -OpenProjects $state.open_projects)) {
            Write-Deny 'Direct shared writes are limited to an exact open active Project Hub path.'; exit 0
        }
        # -ceq: the tool names are lowercase by contract, and a case-insensitive comparison here
        # would be one more place the boundary is wider than it reads.
        if ($toolName -ceq 'mcp__basic-memory__edit_note' -and -not (Test-EditOperationAllowed -ToolInput $input)) {
            Write-Deny ("Only the edit_note operations replace_section and find_replace take this direct path. " +
                "append, prepend, insert_before_section and insert_after_section duplicate content silently when " +
                "applied twice, and nothing here journals a previous body or reads back what it wrote; any other " +
                "operation is one this guard has not been taught. Use replace_section or find_replace, or go " +
                "through tools/Edit-ProjectHub.ps1, which journals, locks and verifies."); exit 0
        }
        if ($toolName -ceq 'mcp__basic-memory__write_note' -and (Test-HubRootWrite -ToolInput $input)) {
            Write-Deny ("A Project Hub's root page is the one page every session touches, so a whole-page overwrite " +
                "of it goes through tools/Edit-ProjectHub.ps1 -- which journals the previous body, holds the " +
                "projects/<slug> lock across the write, and verifies the readback. Every other page under " +
                "projects/<slug>/ still takes this direct path."); exit 0
        }
        exit 0
    }
    if ($toolName -ne 'mcp__basic-memory__list_directory') {
        Write-Deny "Virtual Desk blocks Basic Memory tool '$toolName'."; exit 0
    }
    $target = [string]$input.dir_name
    if (-not (Test-CanonicalPath -Path $target)) { Write-Deny 'Virtual Desk requires a canonical directory path.'; exit 0 }
    # -cin and -clike, matching the -ceq beside them: these roots and Book paths are lowercase-only,
    # and a case-insensitive allow test widens the boundary to paths the Desk never opened.
    if ($target -cin @('books', 'projects', 'archive/projects')) { exit 0 }
    # The Book's own root, whichever half of the shared collection it is in. `archive` is NOT
    # allowed wholesale the way `books` is above: listing `books` discloses the active catalog's
    # shape, which the Book Catalog already publishes, while `archive` would disclose which Books
    # were retired, and no reader-facing catalog says that yet.
    foreach ($root in $state.open_books) { if ($target -ceq $root -or $target -clike "$root/*") { exit 0 } }
    foreach ($root in $state.open_projects) { if ($target -ceq $root -or $target -clike "$root/*") { exit 0 } }
    Write-Deny 'That Book or Project is closed, or the directory is outside the safe discovery boundary.'
}
catch {
    Write-Deny "Virtual Desk failed closed: $($_.Exception.Message)"
}
