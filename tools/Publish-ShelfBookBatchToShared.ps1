<#
.SYNOPSIS
    Publish or delete a batch of curated Shelf Books under one approval.

.DESCRIPTION
    The batch is an explicit JSON file whose items are either `publish` (publish, verify, then
    remove locally) or `delete` (remove locally without publication).  Preflight binds the current
    child plans into one batch plan_id.  A confirmed run executes each bound child plan in order;
    a failed item is journalled and left alone while later items continue.  It never rolls back a
    verified shared publication and never retries or cleans up a failed child on its own.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PlanPath,
    [string]$WorkspacePath,
    [string]$ProjectId,
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
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

function Get-TextDigest([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
}

function Read-BatchFile([string]$Path) {
    $full = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $raw = [IO.File]::ReadAllText($full, [Text.UTF8Encoding]::new($false, $true))
    try { $value = $raw | ConvertFrom-Json } catch { throw "Batch plan '$Path' is not valid JSON. $($_.Exception.Message)" }
    if ($null -eq $value -or $null -eq $value.PSObject.Properties['items']) { throw "Batch plan '$Path' requires an items array." }
    $items = @($value.items)
    if ($items.Count -eq 0) { throw "Batch plan '$Path' contains no items." }
    [pscustomobject]@{ path = $full; items = $items }
}

function Get-RequiredString($Item, [string]$Name) {
    $property = $Item.PSObject.Properties[$Name]
    if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) { throw "Each batch item requires '$Name'." }
    [string]$property.Value
}

function Get-OptionalString($Item, [string]$Name, [string]$Default = '') {
    $property = $Item.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    [string]$property.Value
}

function Get-BatchPlan([string]$Path, [string]$Workspace, [string]$McpEndpoint, [string]$SharedProjectId) {
    $source = Read-BatchFile $Path
    $publisher = Join-Path $PSScriptRoot 'Publish-ShelfBookToShared.ps1'
    $remover = Join-Path $PSScriptRoot 'Remove-ShelfBook.ps1'
    $seenShelf = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $seenShared = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $actions = [Collections.Generic.List[object]]::new()
    foreach ($item in $source.items) {
        $kind = Get-OptionalString $item 'action' 'publish'
        if ($kind -cnotin @('publish', 'delete')) { throw "Batch item action '$kind' must be publish or delete." }
        $shelfSlug = Get-RequiredString $item 'shelf_book_slug'
        if (-not $seenShelf.Add($shelfSlug)) { throw "Batch plan names Shelf Book '$shelfSlug' more than once." }
        if ($kind -ceq 'publish') {
            $bookSlug = Get-RequiredString $item 'book_slug'
            if (-not $seenShared.Add($bookSlug)) { throw "Batch plan names shared slug '$bookSlug' more than once." }
            $arguments = @{
                ShelfBookSlug = $shelfSlug; BookSlug = $bookSlug
                BookTitle = Get-RequiredString $item 'book_title'; Summary = Get-RequiredString $item 'summary'
                Topics = Get-OptionalString $item 'topics' 'local-notes'; WorkspacePath = $Workspace
                ProjectId = $SharedProjectId; Preflight = $true
            }
            $collection = Get-OptionalString $item 'collection'
            if ($collection) { $arguments.Collection = $collection }
            $version = Get-OptionalString $item 'book_version'
            if ($version) { $arguments.BookVersion = $version }
            if ($McpEndpoint) { $arguments.McpUrl = $McpEndpoint }
            $child = & $publisher @arguments
            [void]$actions.Add([pscustomobject]@{ action = 'publish'; shelf_book = "shelf/$shelfSlug"; shared_book = "books/$bookSlug"; child_plan = $child; input = $item })
        }
        else {
            $reason = Get-OptionalString $item 'delete_reason' 'Not selected for the shared collection.'
            $child = & $remover -BookSlug $shelfSlug -Reason $reason -WorkspacePath $Workspace -Preflight
            [void]$actions.Add([pscustomobject]@{ action = 'delete'; shelf_book = "shelf/$shelfSlug"; shared_book = $null; child_plan = $child; input = $item })
        }
    }
    $digestLines = @('action=publish-shelf-book-batch-to-shared', "plan=$($source.path)") + @($actions | ForEach-Object { "action=$($_.action)|shelf=$($_.shelf_book)|shared=$($_.shared_book)|child=$($_.child_plan.plan_id)" })
    $planId = 'publish-delete-shelf-book-batch-' + (Get-TextDigest ($digestLines -join "`n"))
    $workspacePrefix = $Workspace.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $planLabel = if ($source.path.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $source.path.Substring($Workspace.Length).TrimStart('\', '/').Replace('\', '/')
    }
    else { $source.path }
    [pscustomobject]@{
        operation = 'Publish or delete a batch of Shelf Books'
        batch_plan_path = $planLabel
        items = @($actions)
        execution_policy = 'Each item publishes and verifies before its local deletion. Failed items are preserved and later items continue; no shared publication is rolled back.'
        plan_id = $planId; confirmation_required = $true; destructive = $true; recoverable = $false; shared_library_write = $false
    }
}

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$plan = Get-BatchPlan -Path $PlanPath -Workspace $workspace -McpEndpoint $McpUrl -SharedProjectId $ProjectId
if ($Preflight) { Write-LibraryResult -Result $plan -Json:$Json; return }
if (-not $UserConfirmed) { throw 'The Shelf batch was not changed: review the preflight and rerun with -UserConfirmed.' }
if ($ApprovedPlanId -cne $plan.plan_id) { throw 'The Shelf batch was not changed: rerun the current preflight and pass its exact plan_id as ApprovedPlanId.' }

$journalPath = Join-Path $workspace "internal/publication-journals/shelf-exit-batch-$($plan.plan_id.Substring($plan.plan_id.Length - 16)).json"
$status = [Collections.Generic.List[object]]::new()
function Save-Journal {
    $record = [pscustomobject]@{ schema = 1; timestamp_utc = [DateTime]::UtcNow.ToString('o'); plan_id = $plan.plan_id; items = @($status) }
    $parent = Split-Path -Parent $journalPath
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($journalPath, (($record | ConvertTo-Json -Depth 12) + "`n"), [Text.UTF8Encoding]::new($false))
}

foreach ($action in @($plan.items)) {
    [void]$status.Add([pscustomobject]@{ shelf_book = $action.shelf_book; shared_book = $action.shared_book; action = $action.action; state = 'processing'; error = $null })
    Save-Journal
    try {
        if ($action.action -ceq 'publish') {
            $input = $action.input
            $run = @{
                ShelfBookSlug = Get-RequiredString $input 'shelf_book_slug'; BookSlug = Get-RequiredString $input 'book_slug'
                BookTitle = Get-RequiredString $input 'book_title'; Summary = Get-RequiredString $input 'summary'
                Topics = Get-OptionalString $input 'topics' 'local-notes'; WorkspacePath = $workspace
                ProjectId = $ProjectId; UserConfirmed = $true; ApprovedPlanId = $action.child_plan.plan_id
            }
            $collection = Get-OptionalString $input 'collection'; if ($collection) { $run.Collection = $collection }
            $version = Get-OptionalString $input 'book_version'; if ($version) { $run.BookVersion = $version }
            if ($McpUrl) { $run.McpUrl = $McpUrl }
            $result = & (Join-Path $PSScriptRoot 'Publish-ShelfBookToShared.ps1') @run
            if (-not $result.local_book_deleted) { throw 'the child workflow did not report local deletion' }
        }
        else {
            $result = & (Join-Path $PSScriptRoot 'Remove-ShelfBook.ps1') -BookSlug (Get-RequiredString $action.input 'shelf_book_slug') -Reason (Get-OptionalString $action.input 'delete_reason' 'Not selected for the shared collection.') -WorkspacePath $workspace -UserConfirmed -ApprovedPlanId $action.child_plan.plan_id
            if (-not $result.local_book_deleted) { throw 'the child deletion did not report completion' }
        }
        $status[$status.Count - 1].state = 'complete'
    }
    catch {
        $status[$status.Count - 1].state = 'incomplete'
        $status[$status.Count - 1].error = $_.Exception.Message
    }
    Save-Journal
}

$incomplete = @($status | Where-Object { $_.state -cne 'complete' })
Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
    operation = $plan.operation; plan_id = $plan.plan_id; status = if ($incomplete.Count) { 'incomplete' } else { 'complete' }
    items = @($status); journal = $journalPath.Substring($workspace.Length).TrimStart('\', '/').Replace('\', '/')
    shared_library_write = ($status.Count -gt $incomplete.Count)
})
