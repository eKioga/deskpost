<#
.SYNOPSIS
    Every file path under one shared-collection directory, from a PAGINATED MCP list_directory, with
    completeness proved rather than assumed. Dot-sourced; never invoked directly except with
    -SelfTest.

.DESCRIPTION
    WHY THIS EXISTS. list_directory paginates. Its default page size is 10, and a caller that issues
    one unpaged call gets the first ten items and no indication that it holds part of a directory.
    Both callers here did exactly that. Measured on 2026-09-05: books/obsidian-app/wiki holds 18
    items and answered with 9 files; books/game-server-admin/wiki holds 25 and answered with 4.

    WHY THE OBVIOUS GUARD DID NOT CATCH IT. Each caller checked that the directory's own root note
    -- _book.md or _project.md -- was in the listing, on the reasoning that every such directory has
    one, so its absence means truncation. Both names sort early, so both survived page one and the
    guard passed on a listing missing two thirds of the Book. A guard that a truncation can satisfy
    by luck of ordering is not a completeness check. The one Book it did fire on,
    godot-engine-architecture-reference, had enough subdirectories to push _book.md off page one --
    which is to say it fired for a reason unrelated to why it was written.

    HOW COMPLETENESS IS PROVED NOW. output_format json makes the server state the answer instead of
    the caller inferring it: every page carries total and has_more, and every node carries its own
    type and path. Each node's identity goes into a set, and the set's size must equal the total the
    server declared before any path is returned. That is stronger than counting rows, because it
    also closes a repeated or overlapping page -- a re-sent page adds no new identities, so the
    count falls short and the listing is refused rather than accepted as complete.

    IT FAILS CLOSED, AND THAT IS THE POINT. An unrecognised payload, a total that moves between
    pages, a short set, or a run past the page ceiling all THROW. For the manifest backfill a throw
    means one dirty Book, repaired by a re-run; for an archive it means the archive stops before
    moving anything. Both are better than what this replaced, which was a manifest that silently
    described half a Book and an archive that would silently leave half a Hub behind.
#>
[CmdletBinding()]
param([switch]$SelfTest)

function Read-McpDirectoryListing {
    <#
    .SYNOPSIS
        Page through list_directory and return every *.md file path inside $Directory's subtree,
        proved complete against the server's own declared total.

    .PARAMETER RequestPage
        { param($Page, $PageSize) } returning the raw tools/call response. The seam is here rather
        than a session object because the two callers carry different MCP clients: the shared Book
        source holds a session, the Project archiver closes over a script-scoped one.

    .PARAMETER RequiredPath
        A path that must appear, kept from the callers this replaced. It is no longer the
        completeness check -- the declared total is -- but it still catches a listing for the
        wrong directory.
    #>
    param(
        [Parameter(Mandatory = $true)][scriptblock]$RequestPage,
        [Parameter(Mandatory = $true)][string]$Directory,
        [string]$RequiredPath,
        [int]$PageSize = 200,
        [int]$MaxPages = 200
    )

    $paths = [Collections.Generic.List[string]]::new()
    # Node identity, not row count: a re-sent page then adds nothing and the total is never reached.
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $declaredTotal = $null
    $page = 1

    while ($true) {
        $response = & $RequestPage $page $PageSize
        if ($null -eq $response) { throw "Listing '$Directory' page $page returned nothing." }

        $result = $null
        if ($null -ne $response.PSObject.Properties['result']) {
            $inner = $response.result
            if ($null -ne $inner -and $null -ne $inner.PSObject.Properties['isError'] -and $inner.isError) {
                throw "Listing '$Directory' page $page was rejected by the shared Library."
            }
            if ($null -ne $inner -and $null -ne $inner.PSObject.Properties['structuredContent']) {
                $structured = $inner.structuredContent
                if ($null -ne $structured -and $null -ne $structured.PSObject.Properties['result']) { $result = $structured.result }
            }
        }
        if ($null -eq $result -or $null -eq $result.PSObject.Properties['total'] -or $null -eq $result.PSObject.Properties['nodes']) {
            throw "Listing '$Directory' page $page did not return a recognised json listing; no result was produced."
        }

        $pageTotal = [int]$result.total
        if ($null -eq $declaredTotal) { $declaredTotal = $pageTotal }
        elseif ($pageTotal -ne $declaredTotal) {
            throw "Listing '$Directory' changed its total from $declaredTotal to $pageTotal between pages; it is being written while it is read and no result was produced."
        }

        $nodes = @($result.nodes)
        foreach ($node in $nodes) {
            if ($null -eq $node) { continue }
            $type = if ($null -ne $node.PSObject.Properties['type']) { [string]$node.type } else { '' }
            $filePath = if ($null -ne $node.PSObject.Properties['file_path']) { [string]$node.file_path } else { '' }
            $dirPath = if ($null -ne $node.PSObject.Properties['directory_path']) { [string]$node.directory_path } else { '' }

            if ($type -ceq 'file') {
                if ([string]::IsNullOrWhiteSpace($filePath)) { throw "Listing '$Directory' returned a file node with no path; no result was produced." }
                [void]$seen.Add("f:$filePath")
                # Confined to the requested subtree, and markdown only: the callers want pages.
                if ($filePath.StartsWith("$Directory/", [StringComparison]::Ordinal) -and $filePath.EndsWith('.md', [StringComparison]::Ordinal)) {
                    [void]$paths.Add($filePath)
                }
            }
            else {
                $identity = if (-not [string]::IsNullOrWhiteSpace($dirPath)) { $dirPath } elseif (-not [string]::IsNullOrWhiteSpace($filePath)) { $filePath } else { '' }
                if ([string]::IsNullOrWhiteSpace($identity)) { throw "Listing '$Directory' returned a node with no identity; no result was produced." }
                [void]$seen.Add("d:$identity")
            }
        }

        $hasMore = $false
        if ($null -ne $result.PSObject.Properties['has_more']) { $hasMore = [bool]$result.has_more }
        # An empty page ends the listing whatever has_more claims; the count check below is what
        # then turns "the server declared more than it delivered" into a refusal.
        if (-not $hasMore -or $nodes.Count -eq 0) { break }

        $page++
        if ($page -gt $MaxPages) { throw "Listing '$Directory' did not terminate within $MaxPages pages; no result was produced." }
    }

    if ($seen.Count -ne $declaredTotal) {
        throw "Listing '$Directory' returned $($seen.Count) of $declaredTotal declared items; the listing is incomplete and no result was produced."
    }

    $ordered = @($paths | Sort-Object -Unique)
    if (-not [string]::IsNullOrWhiteSpace($RequiredPath) -and $RequiredPath -cnotin $ordered) {
        throw "Listing '$Directory' did not return '$RequiredPath'; the listing is incomplete or is for another directory, and no result was produced."
    }
    $ordered
}

if ($SelfTest) {
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $failures = [Collections.Generic.List[string]]::new()
    function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { [void]$failures.Add($Message) } }
    function Assert-Throws([scriptblock]$Action, [string]$Fragment, [string]$Message) {
        try { & $Action | Out-Null; [void]$failures.Add("$Message (nothing was thrown)") }
        catch { if ("$($_.Exception.Message)" -notlike "*$Fragment*") { [void]$failures.Add("$Message (threw: $($_.Exception.Message))") } }
    }

    $dir = 'books/demo/wiki'
    function New-Node([string]$Path, [string]$Type) {
        if ($Type -ceq 'file') { [pscustomobject]@{ type = 'file'; file_path = $Path; directory_path = "/$Path" } }
        else { [pscustomobject]@{ type = 'directory'; file_path = $null; directory_path = "/$Path" } }
    }
    function New-Response($Nodes, [int]$Total, [bool]$HasMore) {
        [pscustomobject]@{ result = [pscustomobject]@{
                isError           = $false
                structuredContent = [pscustomobject]@{ result = [pscustomobject]@{ nodes = @($Nodes); total = $Total; page_size = 2; has_more = $HasMore } }
            }
        }
    }

    # One subdirectory and four files, delivered two at a time.
    $all = @(
        (New-Node "$dir/sub" 'directory'),
        (New-Node "$dir/_book.md" 'file'),
        (New-Node "$dir/a.md" 'file'),
        (New-Node "$dir/sub/b.md" 'file'),
        (New-Node "$dir/notes.txt" 'file')
    )
    $paged = {
        param($Page, $PageSize)
        $slice = @($all | Select-Object -Skip (($Page - 1) * 2) -First 2)
        New-Response $slice $all.Count (($Page * 2) -lt $all.Count)
    }

    # 1. A paginated listing is followed to its last page. This is the defect that shipped: one
    #    unpaged call would have seen the subdirectory and _book.md and stopped there.
    $got = Read-McpDirectoryListing -RequestPage $paged -Directory $dir -RequiredPath "$dir/_book.md" -PageSize 2
    Assert ((@($got) -join ',') -ceq "$dir/_book.md,$dir/a.md,$dir/sub/b.md") "the paginated listing lost pages: $(@($got) -join ',')"
    Assert ("$dir/notes.txt" -cnotin @($got)) 'a non-markdown file was returned as a page'

    # 2. A server that declares more than it delivers is refused. The root-note guard cannot see
    #    this: _book.md is present and every delivered row is real.
    $short = { param($Page, $PageSize) New-Response @($all[0], $all[1]) 9 $false }
    Assert-Throws { Read-McpDirectoryListing -RequestPage $short -Directory $dir -RequiredPath "$dir/_book.md" } 'incomplete' 'a short listing was accepted'

    # 3. A repeated page reaches the row count but not the identity count.
    $repeat = { param($Page, $PageSize) New-Response @($all[0], $all[1]) $all.Count ($Page -lt 3) }
    Assert-Throws { Read-McpDirectoryListing -RequestPage $repeat -Directory $dir -RequiredPath "$dir/_book.md" -PageSize 2 } 'incomplete' 'a repeated page was accepted as progress'

    # 4. A total that moves between pages means the directory is being written as it is read.
    $moving = {
        param($Page, $PageSize)
        if ($Page -eq 1) { New-Response @($all[0], $all[1]) $all.Count $true } else { New-Response @($all[2], $all[3]) 99 $false }
    }
    Assert-Throws { Read-McpDirectoryListing -RequestPage $moving -Directory $dir -PageSize 2 } 'changed its total' 'a moving total was accepted'

    # 5. An unrecognised payload is refused rather than read as an empty directory.
    Assert-Throws { Read-McpDirectoryListing -RequestPage { param($Page, $PageSize) [pscustomobject]@{ result = [pscustomobject]@{ isError = $false } } } -Directory $dir } 'recognised json listing' 'an unrecognised payload was read as a listing'

    # 6. A rejected call is a refusal, not an empty directory.
    Assert-Throws { Read-McpDirectoryListing -RequestPage { param($Page, $PageSize) [pscustomobject]@{ result = [pscustomobject]@{ isError = $true } } } -Directory $dir } 'rejected' 'a rejected listing was read as empty'

    # 7. A complete listing that is for the wrong directory still fails the required-path check.
    $wrong = { param($Page, $PageSize) New-Response @((New-Node 'books/other/wiki/_book.md' 'file')) 1 $false }
    Assert-Throws { Read-McpDirectoryListing -RequestPage $wrong -Directory $dir -RequiredPath "$dir/_book.md" } 'did not return' 'a listing for another directory was accepted'

    # 8. A server that never stops paging is bounded.
    $endless = { param($Page, $PageSize) New-Response @((New-Node "$dir/p$Page.md" 'file')) 9999 $true }
    Assert-Throws { Read-McpDirectoryListing -RequestPage $endless -Directory $dir -MaxPages 5 } 'did not terminate' 'an endless listing was not bounded'

    # 9. An empty directory is a legitimate answer when nothing is required of it.
    $empty = { param($Page, $PageSize) New-Response @() 0 $false }
    $none = Read-McpDirectoryListing -RequestPage $empty -Directory $dir
    Assert (@($none).Count -eq 0) 'an empty directory did not return an empty set'

    if ($failures.Count -gt 0) {
        Write-Host "mcp-directory-listing.selftest FAILED ($($failures.Count)):"
        foreach ($failure in $failures) { Write-Host "  - $failure" }
        exit 1
    }
    Write-Host 'mcp-directory-listing.selftest passed (9 assertions).'
}
