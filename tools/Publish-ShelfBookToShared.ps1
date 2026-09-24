<#
.SYNOPSIS
    Publish a curated Shelf Book to the shared collection, verify it, then delete the local copy.

.DESCRIPTION
    Composes the existing shared publisher with Remove-ShelfBook.ps1. One composite plan_id binds
    both child plans and one reader approval authorizes the sequence. Shared publication is never
    rolled back: if local deletion does not complete, the journal says published-awaiting-local-delete
    and the verified shared Book remains intact.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ShelfBookSlug,
    [Parameter(Mandatory = $true)][string]$BookSlug,
    [Parameter(Mandatory = $true)][string]$BookTitle,
    [Parameter(Mandatory = $true)][string]$Summary,
    [string]$Topics = 'local-notes',
    [string]$WorkspacePath,
    [ValidateSet('Projects', 'Reference', 'Workflows')][string]$Collection,
    [string]$ProjectId,
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [Alias('CandidateVersion')][string]$BookVersion = '0.1.0',
    [switch]$ReplaceExisting,
    [string]$DeleteReason = 'Published and verified in the shared collection.',
    [string]$PublicationJournalPath,
    [string]$WorkflowJournalPath,
    [string]$ApprovedPlanId,
    [switch]$UserConfirmed,
    [switch]$Preflight,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')
$ProjectId = Resolve-LibraryCollectionId -CollectionId $ProjectId

function Write-Utf8([string]$Path, [string]$Text) {
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Get-TextDigest([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
}

# STEP 20: THE WORKSPACE IS SELECTED, NOT ASSUMED. `Split-Path -Parent $PSScriptRoot` answered
# "which workspace" with "one level above my own code", which is right only while the program and
# the workspace are the same directory. Order: -WorkspacePath, then LIBRARY_WORKSPACE, then the
# nearest `.library/workspace.json` above the working directory, then this program's own root --
# and that last one only while the program really is a workspace, which is what keeps an un-split
# checkout working and stops an installed package inventing one. tools/WorkspaceRegistry.ps1.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
$WorkspacePath = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
if ($ShelfBookSlug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'ShelfBookSlug must use lowercase letters, digits, and single hyphens.' }
if ($BookSlug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'BookSlug must use lowercase letters, digits, and single hyphens.' }
if ($BookSlug -ceq 'blog') { throw "The shared Book slug 'blog' is reserved and cannot be used by this workflow." }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$publisher = Join-Path $PSScriptRoot 'Publish-BookCopy.ps1'
$remover = Join-Path $PSScriptRoot 'Remove-ShelfBook.ps1'

$publishArgs = @{
    Destination = 'Shared'; FromShelf = $true; SourcePath = "shelf/$ShelfBookSlug"
    BookSlug = $BookSlug; BookTitle = $BookTitle; Summary = $Summary; Topics = $Topics
    WorkspacePath = $workspace; ProjectId = $ProjectId; BookVersion = $BookVersion; Preflight = $true
}
if ($Collection) { $publishArgs.Collection = $Collection }
if ($McpUrl) { $publishArgs.McpUrl = $McpUrl }
if ($ReplaceExisting) { $publishArgs.ReplaceExisting = $true }
$publicationPlan = & $publisher @publishArgs
$deletePlan = & $remover -BookSlug $ShelfBookSlug -Reason $DeleteReason -WorkspacePath $workspace -Preflight

$digestLines = @(
    'action=publish-shelf-book-to-shared',
    "shelf_slug=$ShelfBookSlug",
    "shared_slug=$BookSlug",
    "project_id=$ProjectId",
    "collection=$Collection",
    "book_version=$BookVersion",
    "replace_existing=$($ReplaceExisting.IsPresent.ToString().ToLowerInvariant())",
    "publication_plan=$($publicationPlan.plan_id)",
    "delete_plan=$($deletePlan.plan_id)"
)
$planId = 'publish-delete-shelf-book-' + (Get-TextDigest ($digestLines -join "`n"))
$plan = [pscustomobject]@{
    operation             = 'Publish a Shelf Book to shared, then delete the local copy'
    shelf_book            = "shelf/$ShelfBookSlug"
    shared_book           = "books/$BookSlug"
    execution_order       = @('publish and verify every shared page', 'verify the shared Catalog entry', 'permanently delete the local Shelf Book')
    publication_plan      = $publicationPlan
    local_delete_plan     = $deletePlan
    plan_id               = $planId
    confirmation_required = $true
    destructive           = $true
    recoverable           = $false
    shared_library_write  = $false
    scope                 = 'Creates or refreshes the verified shared Book first. Only after the shared Catalog readback succeeds does it permanently delete the local Shelf Book. No local archive copy is created.'
}
if ($Preflight) { Write-LibraryResult -Result $plan -Json:$Json; return }
if (-not $UserConfirmed) { throw 'The Shelf Book was not published or deleted: review the preflight and rerun with -UserConfirmed.' }
if ($ApprovedPlanId -cne $planId) { throw 'The Shelf Book was not published or deleted: rerun the current preflight and pass its exact plan_id as ApprovedPlanId.' }

if ([string]::IsNullOrWhiteSpace($PublicationJournalPath)) {
    $PublicationJournalPath = Join-Path $workspace "internal/publication-journals/$BookSlug-$($publicationPlan.source_digest_sha256).json"
}
if ([string]::IsNullOrWhiteSpace($WorkflowJournalPath)) {
    $WorkflowJournalPath = Join-Path $workspace "internal/publication-journals/$ShelfBookSlug-to-$BookSlug-publish-delete.json"
}
$state = 'publishing'
function Save-WorkflowJournal([string]$State, [string]$ErrorText) {
    $record = [pscustomobject]@{
        schema = 1; state = $State; timestamp_utc = [DateTime]::UtcNow.ToString('o')
        plan_id = $planId; shelf_book_slug = $ShelfBookSlug; shared_book_slug = $BookSlug
        publication_plan_id = $publicationPlan.plan_id; delete_plan_id = $deletePlan.plan_id
        publication_journal = $PublicationJournalPath; error = $ErrorText
    }
    Write-Utf8 -Path $WorkflowJournalPath -Text (($record | ConvertTo-Json -Depth 8) + "`n")
}

try {
    Save-WorkflowJournal -State $state -ErrorText $null
    $publishArgs.Remove('Preflight')
    $publishArgs.UserConfirmed = $true
    $publishArgs.ApprovedPlanId = $publicationPlan.plan_id
    $publishArgs.JournalPath = $PublicationJournalPath
    $publicationResult = & $publisher @publishArgs
    # catalog_entry_verified, NOT catalog_updated: since 2026-09-10 the publisher reports the edit it
    # issued, and a Catalog already carrying the correct line is edited not at all. Gating on the
    # write would fail this workflow on a republication whose Catalog was already right.
    if (-not $publicationResult.publication_complete -or -not $publicationResult.catalog_entry_verified) {
        throw 'the shared publisher did not report both publication completion and Catalog verification'
    }

    $state = 'published-awaiting-local-delete'
    Save-WorkflowJournal -State $state -ErrorText $null
    $deleteResult = & $remover -BookSlug $ShelfBookSlug -Reason $DeleteReason -WorkspacePath $workspace -UserConfirmed -ApprovedPlanId $deletePlan.plan_id
    if (-not $deleteResult.local_book_deleted) { throw 'the local deletion helper did not report completion' }

    $state = 'complete'
    Save-WorkflowJournal -State $state -ErrorText $null
    Write-LibraryResult -Result ([pscustomobject]@{
        operation = $plan.operation; status = 'complete'; plan_id = $planId
        shared_book = "books/$BookSlug"; shared_publication_verified = $true
        local_book = "shelf/$ShelfBookSlug"; local_book_deleted = $true
        publication = $publicationResult; deletion = $deleteResult
        workflow_journal = $WorkflowJournalPath.Substring($workspace.Length).TrimStart('\', '/').Replace('\', '/')
        shared_library_write = $true
    }) -Json:$Json
}
catch {
    Save-WorkflowJournal -State $state -ErrorText $_.Exception.Message
    throw "The publish-and-delete workflow is incomplete at '$state'. The shared publication is never rolled back. Journal: $WorkflowJournalPath. $($_.Exception.Message)"
}
