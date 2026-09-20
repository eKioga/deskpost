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
    CLAUDE.md says: read docs/librarian-operation-playbooks.md and follow the applicable section
    BEFORE publishing, refreshing, handing off, archiving, resetting the Notebook, importing an
    external wiki, or doing shared-collection development.

    That instruction has a structural weakness no amount of rewording fixes. It is a POINTER, loaded
    once at session start, competing for attention against everything that arrives afterwards; and
    the operations it governs are the ones a long session reaches last. By the time the reader asks
    to archive a Book, the sentence telling the Librarian to go and read the archive procedure is
    the oldest and least salient text in the window.

    This hook inverts that. It carries no rules of its own -- it reads the same tracked document
    CLAUDE.md points at, cuts out the one section that governs the helper about to run, and hands it
    over as context at the moment of use. The procedure arrives when it is needed instead of being
    remembered from when it wasn't.

    WHAT IT COSTS. Nothing until a consequential helper is invoked, and then once per section per
    session -- the serve ledger in HookContext.ps1 keeps a second `Archive-SharedBook.ps1` call in
    the same session quiet. Restore-CompactedGuidance.ps1 clears that ledger on PostCompact, because a
    compaction is precisely the event that summarises the first injection away.

    WHAT IT IS NOT. It cannot block, and it must not: the helpers below enforce their own preflight,
    plan_id and -UserConfirmed gates, and a hook that also refused them would be a second authority
    over an approval the reader already understands. This hook informs. The helper still decides.
#>

. (Join-Path $PSScriptRoot 'HookContext.ps1')

# The routing table. Left column matches the invoked helper's filename in the command text; right
# column is a heading that must exist VERBATIM in the playbook document -- the self-test asserts
# every one of them resolves, so a heading reworded in the doc fails the gate rather than silently
# serving nothing.
#
# The trigger set is CLAUDE.md's own consequential list, plus Edit-ProjectHub. That one is not
# "consequential" in CLAUDE.md's sense, and it is here anyway: its seven modes have six documented
# traps, it is reached most often at the end of a long session when the Hub is brought current, and
# it is the single helper in this tree whose misuse has cost the most rework.
#
# Deliberately absent: Add-ShelfNote.ps1, which the playbook itself calls "ordinary work, not a
# ceremony", and Remove-SharedEntry.ps1, which no playbook section covers. Inventing a section for
# it here would put guidance in a hook that the tracked document does not agree with.
$script:PlaybookRoutes = @(
    @{ key = 'publish'; helpers = @('Publish-BookCopy.ps1', 'Publish-ShelfBookToShared.ps1', 'Publish-ShelfBookBatchToShared.ps1'); heading = '## Publish or refresh a shared Book copy' },
    @{ key = 'import';  helpers = @('Import-ExternalWikiToShelf.ps1', 'Get-WikiMigrationInventory.ps1'); heading = '## Import an external workspace wiki to the Shelf' },
    @{ key = 'archive'; helpers = @('Archive-SharedBook.ps1', 'Archive-ProjectHub.ps1', 'Archive-ShelfBook.ps1', 'Remove-ShelfBook.ps1', 'Set-ShelfBookPageStub.ps1'); heading = '## Archive a Book or Project' },
    @{ key = 'reset';   helpers = @('Reset-LocalNotebook.ps1'); heading = '## Reset the local Notebook' },
    # The reset's inverse and the two purges. Here for the same reason `reset` is: each one decides
    # what happens to material nothing else holds a copy of, and two of the three are the only
    # operations in this tree that destroy rather than move.
    @{ key = 'recover'; helpers = @('Restore-NotebookQuarantine.ps1', 'Remove-NotebookQuarantine.ps1', 'Remove-SeatArchive.ps1'); heading = '## Recover from a reset or a retirement' },
    @{ key = 'hubedit'; helpers = @('Edit-ProjectHub.ps1'); heading = '## Edit an open Project Hub page' },
    @{ key = 'projectcopy'; helpers = @('Copy-LocalPagesToProject.ps1'); heading = '## Copy local pages into a Project Hub' },
    @{ key = 'seat';    helpers = @('Start-LibrarySeat.ps1', 'Retire-Seat.ps1'); heading = '## Work at a seat' },
    @{ key = 'derived'; helpers = @('NotebookIndex.ps1', 'ShelfCatalog.ps1'); heading = '## Repair a derived index' },
    @{ key = 'triage';  helpers = @('Invoke-LibraryTriage.ps1'); heading = '## Capture and triage a Shelf note' },
    @{ key = 'compile'; helpers = @('Compile-RawBatchToNotebook.ps1'); heading = '### Compile a named raw batch into the Notebook' },
    # The cutover. It is the one helper here that stops the WHOLE Library rather than touching one
    # Book, so the section it serves leads with what the barrier does to every other seat.
    @{ key = 'cutover'; helpers = @('Move-LibraryFolder.ps1'); heading = '## Move a Library folder under the cutover protocol' },
    @{ key = 'vaultexport'; helpers = @('Export-CollectionToVault.ps1'); heading = '## Mirror the collection into the vault' }
)

function Get-PlaybookRoute([string]$Command) {
    if ([string]::IsNullOrWhiteSpace($Command)) { return $null }
    foreach ($route in $script:PlaybookRoutes) {
        foreach ($helper in $route.helpers) {
            # -match with an escaped literal, case-insensitive on purpose: a shell command may spell
            # the helper with any casing the filesystem accepts, and matching only the tracked
            # casing would serve nothing for a call that will still run.
            if ($Command -match [regex]::Escape($helper)) { return $route }
        }
    }
    $null
}

try {
    if (-not $StateDirectory) { $StateDirectory = Split-Path -Parent $PSScriptRoot }
    $workspace = Split-Path -Parent $StateDirectory
    $call = Read-HookPayload -BoundParameters $PSBoundParameters -InputJson $InputJson -InputJsonBase64 $InputJsonBase64
    $toolInput = Get-HookField $call 'tool_input'
    $command = Get-HookCommandText $toolInput

    $route = Get-PlaybookRoute $command
    if ($null -eq $route) { exit 0 }

    $sessionId = [string](Get-HookField $call 'session_id')
    $ledgerKey = "playbook:$($route.key)"
    if (Test-HookServed $StateDirectory $sessionId $ledgerKey) { exit 0 }

    $playbook = Join-Path $workspace (Join-Path 'docs' 'librarian-operation-playbooks.md')
    $section = Get-MarkdownSection -Path $playbook -Heading $route.heading
    if ([string]::IsNullOrWhiteSpace($section)) { exit 0 }

    Set-HookServed $StateDirectory $sessionId $ledgerKey

    $preamble = "The operation you are about to run has a playbook. This is that section of " +
        "docs/librarian-operation-playbooks.md, delivered here so it does not have to be remembered. " +
        "Follow it: run the preflight, show the reader what it reports, and wait for one clear yes " +
        "before the confirmed rerun.`n`n"
    Write-HookOutput 'PreToolUse' @{ additionalContext = ($preamble + $section) }
}
catch {
    # SILENT. This hook adds guidance and cannot block; a failure that printed a broken object would
    # put malformed JSON in front of a tool call that is entitled to proceed without it. The cost of
    # failing here is that the Librarian works from CLAUDE.md's pointer, which is where it started.
    exit 0
}
