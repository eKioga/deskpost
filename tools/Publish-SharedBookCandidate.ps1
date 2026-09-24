[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidateSet('Shared')][string]$Destination,
 [Parameter(Mandatory=$true)][string]$SourcePath,
 [Parameter(Mandatory=$true)][string]$BookSlug,
 [Parameter(Mandatory=$true)][string]$BookTitle,
 [Parameter(Mandatory=$true)][string]$Summary,
 [string]$Topics='local-notes',[string]$WorkspacePath,
 [string[]]$IncludePage=@(),
 [switch]$FromShelf,
 [ValidateSet('Projects','Reference','Workflows')][string]$Collection,
 [string]$ProjectId,
 [string]$McpUrl=$env:AI_LIBRARY_MCP_URL,[Alias('CandidateVersion')][string]$BookVersion='0.1.0',
 [switch]$ReplaceExisting,
 [string]$JournalPath,[string]$ApprovedPlanId,[switch]$UserConfirmed,[switch]$Preflight
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')
# STEP 21: ONE WRITABLE WORKSPACE PER COLLECTION. Resolve-LibraryWriteEndpoint is
# Resolve-LibraryMcpUrl plus the ownership fence, and every shared writer reaches the collection
# through it. tools/CollectionOwnership.ps1, checked by collection.write-fence-coverage.
. (Join-Path $PSScriptRoot 'CollectionOwnership.ps1')
Add-Type -AssemblyName System.Net.Http
function Read-Utf8([string]$Path) { [IO.File]::ReadAllText($Path,[Text.UTF8Encoding]::new($false,$true)) }
function Write-Utf8([string]$Path,[string]$Text) { [IO.File]::WriteAllText($Path,$Text,[Text.UTF8Encoding]::new($false)) }
function Hash([string]$Text) {
 $h=[Security.Cryptography.SHA256]::Create()
 try { ([BitConverter]::ToString($h.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text)))).Replace('-','').ToLowerInvariant() }
 finally { $h.Dispose() }
}
function Split-Frontmatter([string]$Content) {
 $normalized=$Content.Replace("`r`n","`n")
 if(-not $normalized.StartsWith("---`n",[StringComparison]::Ordinal)){
  return [pscustomobject]@{frontmatter='';body=$Content}
 }
 $closing=$normalized.IndexOf("`n---`n",4,[StringComparison]::Ordinal)
 if($closing -lt 0){return [pscustomobject]@{frontmatter='';body=$Content}}
 $bodyStart=$closing+5
 [pscustomobject]@{frontmatter=$normalized.Substring(0,$bodyStart);body=$normalized.Substring($bodyStart).Trim("`r","`n")}
}
function ConvertTo-AsciiJson($Value) {
 $json=$Value|ConvertTo-Json -Compress -Depth 32
 [regex]::Replace($json,'[^\u0000-\u007f]',{
  param($match)
  '\u{0:x4}' -f [int][char]$match.Value
 })
}
function Normalize([string]$Body) {
 $Body.Trim("`r","`n").Replace("`r`n","`n")
}
function Meta($Record,[string]$Name) {
 if ($null -eq $Record.frontmatter) {return $null}
 $p=$Record.frontmatter.PSObject.Properties[$Name]
 if ($null -eq $p) {return $null}; [string]$p.Value
}
function RpcError($Response) {
 $property=$Response.PSObject.Properties['error']
 if($null -eq $property){return $null};$property.Value
}
function ToolFailure($Response) {
 $rpc=RpcError $Response
 if($null -ne $rpc){return [string]$rpc.message}
 if($null -ne $Response.result -and $Response.result.isError){return [string]($Response.result.content|ConvertTo-Json -Compress -Depth 8)}
 'Unknown MCP tool failure.'
}
function Test-Within([string]$Child,[string]$Parent) {
 $parentFull=[IO.Path]::GetFullPath($Parent).TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
 [IO.Path]::GetFullPath($Child).StartsWith($parentFull,[StringComparison]::OrdinalIgnoreCase)
}
function Resolve-LocalLink([string]$SourceFile,[string]$Target,[string]$SourceRoot,[string]$SourcePrefix) {
 $target=$Target.Trim().Split('|')[0].Split('#')[0].Trim()
 if([string]::IsNullOrWhiteSpace($target) -or $target -match ':' -or $target.StartsWith('books/') -or $target.StartsWith('projects/')){return $null}
 $candidates=@()
 $prefixedTarget="$SourcePrefix/"
 if($target.StartsWith($prefixedTarget)){$candidates+=Join-Path $SourceRoot $target.Substring($prefixedTarget.Length)}else{
  $candidates+=Join-Path (Split-Path -Parent $SourceFile) $target
  $candidates+=Join-Path $SourceRoot $target
 }
 foreach($candidate in $candidates){
  if([IO.Path]::GetExtension($candidate) -eq ''){$candidate+='.md'}
  try{$full=[IO.Path]::GetFullPath($candidate)}catch{throw "Link target '$target' in '$SourceFile' is not a canonical local path."}
  if((Test-Within $full $SourceRoot) -and (Test-Path -LiteralPath $full -PathType Leaf)){return $full}
 }
 $null
}
function Assert-SelectedLinks($Files,[hashtable]$Selected,[string]$SourceRoot,[string]$SourcePrefix) {
 foreach($file in $Files){
  $content=Read-Utf8 $file.FullName
  $targets=[Collections.Generic.List[string]]::new()
  foreach($match in [regex]::Matches($content,'\[\[([^\]]+)\]\]')){[void]$targets.Add($match.Groups[1].Value)}
  foreach($match in [regex]::Matches($content,'(?<!\!)\[[^\]]+\]\(([^)]+)\)')){[void]$targets.Add($match.Groups[1].Value)}
  foreach($target in $targets){
   $resolved=Resolve-LocalLink $file.FullName $target $SourceRoot $SourcePrefix
   if($null -ne $resolved -and -not $Selected.ContainsKey($resolved)){throw "Selected Book page '$($file.FullName)' links to omitted local page '$resolved'. Include it or remove the link before publishing."}
  }
 }
}
if ([string]::IsNullOrWhiteSpace($WorkspacePath)) {$WorkspacePath=Split-Path -Parent $PSScriptRoot}
$McpUrl = Resolve-LibraryWriteEndpoint -McpUrl $McpUrl -WorkspacePath $WorkspacePath -Operation 'publishing to the shared collection'
$ProjectId = Resolve-LibraryCollectionId -CollectionId $ProjectId
# -cnotmatch: -notmatch is case-insensitive, so 'My-Book' satisfies this lowercase-only rule and
# travels on as a shared Book root. See docs/capture-book-model.md.
if ($BookSlug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') {throw 'BookSlug must use lowercase letters, digits, and single hyphens.'}
$workspace=(Resolve-Path -LiteralPath $WorkspacePath).Path
$sourceFull=[IO.Path]::GetFullPath((Join-Path $workspace $SourcePath))
# Set by the capture-note branch below. A capture note's frontmatter is Holding Shelf bookkeeping --
# captured, review, source_project -- not content, so it is removed BEFORE this publisher sees the
# page rather than left for the server to hide. This helper writes the whole file and reads it back
# with include_frontmatter=$false, comparing against the split body; that round trip is only exercised
# for pages that HAVE no frontmatter, so relying on it here would be relying on server behaviour
# nothing has ever tested. Stripping first keeps the exercised path the one that runs.
$stripCaptureFrontmatter=$false
if($FromShelf){
 $shelfRoot=Join-Path $workspace 'shelf'
 if(-not (Test-Within $sourceFull $shelfRoot)){throw 'SourcePath must be inside shelf/ when -FromShelf is used.'}
 $requestedItem=Get-Item -LiteralPath $sourceFull -Force
 if(-not $requestedItem.PSIsContainer){throw 'SourcePath must name a Shelf Book folder, not a single file, when -FromShelf is used.'}
 $shelfRelative=$sourceFull.Substring($shelfRoot.Length).TrimStart('\','/').Replace('\','/')
 $shelfParts=@($shelfRelative -split '/')
 if($shelfParts.Count -notin @(1,2) -or ($shelfParts.Count -eq 2 -and $shelfParts[1] -cne 'wiki')){throw 'SourcePath must name shelf/<slug> or shelf/<slug>/wiki when -FromShelf is used.'}
 $shelfSlug=$shelfParts[0]
 $shelfBook=Get-ShelfBook -Workspace $workspace -Slug $shelfSlug
 $shelfBookRoot=[IO.Path]::GetFullPath((Join-Path $shelfRoot $shelfSlug))
 $shelfWikiRoot=[IO.Path]::GetFullPath($shelfBook.wiki_path)
 if(-not ([string]::Equals($sourceFull,$shelfBookRoot,[StringComparison]::OrdinalIgnoreCase) -or [string]::Equals($sourceFull,$shelfWikiRoot,[StringComparison]::OrdinalIgnoreCase))){throw 'SourcePath must name shelf/<slug> or shelf/<slug>/wiki when -FromShelf is used.'}
 if($shelfBook.is_capture){throw "Shelf Book '$shelfSlug' is a capture Book and cannot be published to the shared collection."}
 if(-not (Test-Path -LiteralPath $shelfWikiRoot -PathType Container)){throw "Shelf Book '$shelfSlug' has no pages directory at shelf/$shelfSlug/wiki."}
 Assert-ShelfBookOpen -Workspace $workspace -Slug $shelfSlug -Action 'publishing it to the shared collection'
 $sourceFull=$shelfWikiRoot
 $item=Get-Item -LiteralPath $sourceFull -Force
 $sourceRoot=$sourceFull
 $sourcePrefix="shelf/$shelfSlug/wiki"
 $sourceBoundary=$sourcePrefix
 $allFiles=@(Get-ChildItem -LiteralPath $sourceFull -Recurse -File | Where-Object {$_.Extension -eq '.md'} | Where-Object {
  $_.FullName.Substring($sourceFull.Length).TrimStart('\','/').Replace('\','/') -notin @('_book.md','_index.md')
 } | Sort-Object FullName)
}else{
 # Two permitted roots since 2026-08-28: notebook/, and one note under a capture Book's wiki/notes/
 # so a Holding Shelf finding can become a shared Book directly. The resolver owns the rule and
 # asserts the Desk gate for the capture-Book case, exactly as -FromShelf does above. Frontmatter
 # needs no special handling here: Split-Frontmatter already separates it from every page this
 # publisher writes, which is why a capture note's `---` block never reaches a shared page.
 $local=Resolve-LocalSourceRoot -Workspace $workspace -SourcePath $SourcePath
 $stripCaptureFrontmatter=($local.kind -ceq 'capture-note')
 $wikiRoot=$local.root
 $item=Get-Item -LiteralPath $sourceFull -Force
 $allFiles=@(if($item.PSIsContainer){Get-ChildItem -LiteralPath $sourceFull -Recurse -File | Where-Object {$_.Extension -eq '.md'} | Sort-Object FullName}else{if($item.Extension -ne '.md'){throw 'A Book source must be Markdown.'};$item})
 $sourceRoot=$wikiRoot
 $sourcePrefix=$local.label_root
 $sourceRelative=$sourceFull.Substring($wikiRoot.Length).TrimStart('\','/').Replace('\','/')
 $sourceBoundary="$sourcePrefix/$sourceRelative"
}
$files=@($allFiles)
if($IncludePage.Count){
 if(-not $item.PSIsContainer){throw 'IncludePage is available only when SourcePath names a Notebook folder.'}
 $selected=@{}
 foreach($page in $IncludePage){
  $normalized=$page.Trim().TrimStart('\','/').Replace('/','\')
  if($normalized -notmatch '\.md$'){throw "IncludePage '$page' must name a Markdown file relative to SourcePath."}
  try{$candidate=[IO.Path]::GetFullPath((Join-Path $sourceFull $normalized))}catch{throw "IncludePage '$page' produced an invalid relative path '$normalized'."}
  if(-not (Test-Within $candidate $sourceFull) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)){throw "IncludePage '$page' is not an exact Markdown file below SourcePath."}
  if($selected.ContainsKey($candidate)){throw "IncludePage '$page' was listed more than once."}
  $selected[$candidate]=$true
 }
 $files=@($allFiles|Where-Object{$selected.ContainsKey($_.FullName)})
 if($files.Count -ne $selected.Count){throw 'IncludePage did not resolve to the selected source files.'}
 Assert-SelectedLinks $files $selected $sourceRoot $sourcePrefix
}
if($files.Count -eq 0){if($FromShelf){throw 'The selected Shelf Book contains no publishable Markdown pages.'}else{throw 'The selected source contains no Markdown articles.'}}
$sourceName=if(-not $FromShelf){if($item.PSIsContainer){$item.Name}else{[IO.Path]::GetFileNameWithoutExtension($item.Name)}}
$bookRoot="books/$BookSlug/wiki"
$sources=@(foreach($file in $files){
 $relative=if($item.PSIsContainer){$file.FullName.Substring($sourceFull.Length).TrimStart('\','/').Replace('\','/')}else{$file.Name}
 $content=Read-Utf8 $file.FullName
 if($stripCaptureFrontmatter){$content=(Split-NoteFrontmatter $content).body}
 $parts=Split-Frontmatter $content
 if(-not [string]::IsNullOrEmpty($parts.frontmatter) -and [string]::IsNullOrWhiteSpace($parts.body)){throw "Source page '$($file.FullName)' has frontmatter but no body."}
 if($parts.body.StartsWith("`r") -or $parts.body.StartsWith("`n")){throw "Source page '$($file.FullName)' starts with a blank line and cannot be published safely."}
 $publishedRelative=if($FromShelf){$relative}elseif($item.PSIsContainer){"$sourceName/$relative"}else{$relative}
 $sourceLabel=if($FromShelf){"$sourceBoundary/$relative"}elseif($item.PSIsContainer){"$sourcePrefix/$sourceRelative/$relative"}else{$sourceBoundary}
 [pscustomobject]@{path="$bookRoot/$publishedRelative";source=$sourceLabel;content=$content;frontmatter=$parts.frontmatter;body=$parts.body;sha256=(Hash $parts.body)}
})
$frontmatterPageCount=@($sources|Where-Object{-not [string]::IsNullOrEmpty($_.frontmatter)}).Count
$sourceDigest=Hash (($sources|ForEach-Object{"$($_.source)|$($_.sha256)"})-join "`n")
# The label is each page's own first H1, not its path: see Get-ReaderMapLabel in ShelfNoteCommon.ps1.
# This is the writer behind every shared Book's reader map, so it is the one that made 23 published
# Books list filenames while their Discovery manifests held the titles.
$links=@("- [[$($bookRoot)/_book|Book metadata and limits]]")+@($sources|ForEach-Object{$target=$_.path.Substring(0,$_.path.Length-3);$relative=$_.path.Substring($bookRoot.Length+1);$pageTitle=Get-ReaderMapLabel $_.body $relative;"- [[$target|$pageTitle]]"})
$rootBody="# $BookTitle`n`n## Purpose`n`n$Summary`n`n## Reader map`n`n- [[$($bookRoot)/_index|Open the reader map]]`n"
$indexBody="# $BookTitle - Reader Map`n`n$($links -join "`n")`n"
$records=@(
 [pscustomobject]@{path="$bookRoot/_book.md";source=$null;content=$rootBody;body=$rootBody;sha256=(Hash $rootBody)}
 [pscustomobject]@{path="$bookRoot/_index.md";source=$null;content=$indexBody;body=$indexBody;sha256=(Hash $indexBody)}
)+$sources
$manifestDigest=Hash (($records|ForEach-Object{"$($_.path)|$($_.sha256)|$($_.source)"})-join "`n")
$planId="$(if($FromShelf){'shelf-copy'}else{'local-copy'})-$sourceDigest-$manifestDigest"
$metadata=@{publication_state='copying';book_slug=$BookSlug;book_version=$BookVersion;source_workspace='local-library-workspace';source_boundary=$sourceBoundary;source_digest_sha256=$sourceDigest;page_manifest_sha256=$manifestDigest;planned_page_count=$records.Count;reader_map_path="$bookRoot/_index.md";approved_plan_id=$planId}
if($Collection){$metadata.collection=$Collection}
$plan=[pscustomobject]@{operation='Publish a Copy';destination='shared';project_id=$ProjectId;book_slug=$BookSlug;collection=$Collection;source=$sourceBoundary;source_file_count=$sources.Count;frontmatter_page_count=$frontmatterPageCount;include_pages=@($sources|ForEach-Object{$_.source});source_digest_sha256=$sourceDigest;page_manifest_sha256=$manifestDigest;plan_id=$planId;planned_shared_records=@($records|ForEach-Object{[pscustomobject]@{path=$_.path;sha256=$_.sha256;source_path=$_.source}});confirmation_required=$true;shared_library_write=$false}
if($FromShelf){$plan|Add-Member -NotePropertyName local_original_preserved -NotePropertyValue $true}
if($Preflight){$plan;return}
if(-not $UserConfirmed){throw 'Shared publication is not yet performed: review the manifest and rerun with -UserConfirmed.'}
if($ApprovedPlanId -cne $planId){throw 'Shared publication is not yet performed: rerun the current preflight and pass its exact plan_id as ApprovedPlanId.'}
if([string]::IsNullOrWhiteSpace($JournalPath)){$JournalPath=Join-Path $workspace "internal/publication-journals/$BookSlug-$sourceDigest.json"}

$script:Session=$null;$script:Request=1
function Parse-Response([string]$Body,[int]$Id) {
 if($Body.Trim().StartsWith('{')){return ($Body|ConvertFrom-Json)}
 $items=@($Body -split "`r?`n"|Where-Object{$_ -like 'data:*'}|ForEach-Object{$_.Substring(5).Trim()}|Where-Object{$_}|ForEach-Object{$_|ConvertFrom-Json})
 # An id-less notifications/message log frame has no .id to read, and reading it throws under
 # StrictMode; the aggregate .Name throws in turn on a property-less {} frame (defect family 4).
 # Held by mcp.transports-guard-idless-events.
 $item=@($items|Where-Object{@($_.PSObject.Properties | ForEach-Object { $_.Name }) -contains 'id' -and $_.id -eq $Id}|Select-Object -Last 1)
 if($item.Count -ne 1){throw "MCP response for request $Id was incomplete."};$item[0]
}
# --- Session recovery -----------------------------------------------------------------------------
# The MCP transport forgets its session when the server restarts or the session expires, and then
# answers every later request with "Session not found". The cached id is permanently wrong from that
# point, so a helper holding one session across several calls fails for the rest of its run while the
# NAS is healthy and answering a fresh initialize on the first try.
#
# Re-initialising and retrying ONCE is the whole fix. It retries only on that one message, only when
# an id was actually cached, and never for `initialize` itself -- so an unreachable NAS still fails on
# the first attempt rather than being retried into a slower identical failure, and the retry cannot
# recurse. Initialize-Mcp deliberately calls the non-retrying primitive for the same reason.
#
# WHY ONE OPERATION FAMILY IS EXCLUDED. "Session not found" is emitted by the MCP transport layer
# (mcp 2.0.0 / fastmcp 4.0.0b1), NOT by Basic Memory -- the string appears nowhere in its source.
# That places the rejection before tool dispatch, which would make a retry safe for every operation.
# That is an inference from where the string is absent, not a verified reading of the code that emits
# it, so the one family that would fail SILENTLY if the inference is wrong is excluded rather than
# trusted: append, prepend and the insert_* edits are not idempotent and a second application
# duplicates content with no error. write_note is permalink-keyed, replace_section is idempotent, and
# find_replace self-guards through expected_replacements, so those stay retryable.
# See the Basic-Memory MCP Book, page basic-memory/write-semantics-and-retry-safety.
function Test-McpRetryIsSafe([string]$Method, $Params) {
    if ($Method -cne 'tools/call' -or $null -eq $Params) { return $true }
    if ([string]$Params['name'] -cne 'edit_note') { return $true }
    $arguments = $Params['arguments']
    if ($null -eq $arguments) { return $true }
    # -cin, not -in: these operation names are lowercase by the tool's own contract, and the
    # case-insensitive default would let 'Append' past the exclusion it is here to enforce.
    -not ([string]$arguments['operation'] -cin @('append', 'prepend', 'insert_before_section', 'insert_after_section'))
}

function Invoke-Mcp([string]$Method, [hashtable]$Params, [switch]$Notification) {
    try { return (Invoke-McpOnce -Method $Method -Params $Params -Notification:$Notification) }
    catch {
        if ($Method -ceq 'initialize' -or -not $script:Session) { throw }
        if ($_.Exception.Message -notmatch 'Session not found') { throw }
        if (-not (Test-McpRetryIsSafe -Method $Method -Params $Params)) { throw }
        $script:Session = $null
        Initialize-Mcp
        return (Invoke-McpOnce -Method $Method -Params $Params -Notification:$Notification)
    }
}

function Invoke-McpOnce([string]$Method,[hashtable]$Params,[switch]$Notification){
 $id=if($Notification){$null}else{$script:Request;$script:Request++}
 $payload=[ordered]@{jsonrpc='2.0';method=$Method};if($null -ne $id){$payload.id=$id};if($null -ne $Params){$payload.params=$Params}
 $headers=@{Accept='application/json, text/event-stream';'MCP-Protocol-Version'='2025-03-26'};if($script:Session){$headers['Mcp-Session-Id']=$script:Session}
 $client=[Net.Http.HttpClient]::new()
 try{
  $request=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post,$McpUrl)
  foreach($name in $headers.Keys){$request.Headers.TryAddWithoutValidation($name,[string]$headers[$name])|Out-Null}
  $request.Content=[Net.Http.ByteArrayContent]::new([Text.Encoding]::ASCII.GetBytes((ConvertTo-AsciiJson $payload)))
  $request.Content.Headers.ContentType=[Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/json; charset=utf-8')
  $response=$client.SendAsync($request).GetAwaiter().GetResult()
  $body=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  if(-not $response.IsSuccessStatusCode){throw "HTTP $([int]$response.StatusCode): $($body.Substring(0,[Math]::Min($body.Length,4096)))"}
 }catch{throw "MCP $Method failed: $($_.Exception.Message)"}
 finally{$client.Dispose()}
 if($Method -eq 'initialize'){$values=[Collections.Generic.IEnumerable[string]]$null;if(-not $response.Headers.TryGetValues('Mcp-Session-Id',[ref]$values)){throw 'The shared Library did not establish an MCP session.'};$script:Session=($values|Select-Object -First 1);if([string]::IsNullOrWhiteSpace($script:Session)){throw 'The shared Library did not establish an MCP session.'}}
 if($Notification){return};Parse-Response $body $id
}
function Initialize-Mcp{$r=Invoke-McpOnce 'initialize' @{protocolVersion='2025-03-26';capabilities=@{};clientInfo=@{name='library-resumable-publisher';version='1.0.0'}};$error=RpcError $r;if($null -ne $error){throw "MCP initialization was rejected: $($error.message)"};Invoke-McpOnce 'notifications/initialized' @{} -Notification}
function Read-ExactOrNull([string]$Path){
 $r=Invoke-Mcp 'tools/call' @{name='read_note';arguments=@{project_id=$ProjectId;identifier=$Path.Substring(0,$Path.Length-3);output_format='json';include_frontmatter=$false}}
 $error=RpcError $r;if($null -ne $error){throw "Read '$Path' failed: $($error.message)"}
 if($r.result.isError){$detail=[string]($r.result.content|ConvertTo-Json -Compress -Depth 8);if($detail -match '(?i)not found|does not exist|no note'){return $null};throw "Read '$Path' was rejected: $detail"}
 $record=$r.result.structuredContent.result;if($null -eq $record -or [string]::IsNullOrWhiteSpace([string]$record.file_path)){return $null}
 if([string]$record.file_path -cne $Path){throw "Read '$Path' returned '$($record.file_path)'; publication stopped."};$record
}
function Assert-Matches($Record,$Expected,[switch]$WriteReadback){
 $actual=Normalize ([string]$Record.content)
 $wanted=Normalize ([string]$Expected.body)
 $actualHash=Hash $actual;$wantedHash=Hash $wanted
 if($actualHash -ne $wantedHash){
  $limit=[Math]::Min($actual.Length,$wanted.Length);$offset=0
  while($offset -lt $limit -and $actual[$offset] -ceq $wanted[$offset]){$offset++}
  $actualCode=if($offset -lt $actual.Length){'U+{0:X4}' -f [int][char]$actual[$offset]}else{'<end>'}
  $wantedCode=if($offset -lt $wanted.Length){'U+{0:X4}' -f [int][char]$wanted[$offset]}else{'<end>'}
  $message=if($WriteReadback){"Page '$($Expected.path)' did not read back as written"}else{"Existing record '$($Expected.path)' differs from the approved manifest"}
  throw "$message at offset $offset (actual $actualCode, expected $wantedCode; actual length $($actual.Length), expected length $($wanted.Length); actual SHA-256 $actualHash, expected SHA-256 $wantedHash)."
 }
}
function Create-Record($Expected,$ExtraMetadata,[switch]$Overwrite){
 $args=@{project_id=$ProjectId;directory=(Split-Path -Parent $Expected.path).Replace('\','/');title=[IO.Path]::GetFileNameWithoutExtension($Expected.path);content=$Expected.content;note_type='note';overwrite=$Overwrite.IsPresent;output_format='json'};if($null -ne $ExtraMetadata){$args.metadata=$ExtraMetadata}
 $r=Invoke-Mcp 'tools/call' @{name='write_note';arguments=$args};if($null -ne (RpcError $r) -or $r.result.isError){throw "Write '$($Expected.path)' was rejected."}
 Assert-McpWriteNotConflicted -Response $r -Path ($Expected.path.Substring(0, $Expected.path.Length - 3))
 $record=Read-ExactOrNull $Expected.path;if($null -eq $record){throw "Write '$($Expected.path)' did not become readable."};Assert-Matches $record $Expected -WriteReadback
}
function Get-PublicationState($Record){
 $state=Meta $Record 'publication_state'
 if(-not [string]::IsNullOrWhiteSpace($state)){return $state}
 switch(Meta $Record 'guild_state'){
  'incomplete-candidate' {return 'copying'}
  'candidate' {return 'complete'}
  default {return $null}
 }
}
function Set-RootPublicationComplete($Expected){
 $completeMetadata=@{}
 foreach($key in $metadata.Keys){$completeMetadata[$key]=$metadata[$key]}
 $completeMetadata.publication_state='complete'
 $args=@{project_id=$ProjectId;directory=(Split-Path -Parent $Expected.path).Replace('\','/');title=[IO.Path]::GetFileNameWithoutExtension($Expected.path);content=$Expected.content;note_type='note';metadata=$completeMetadata;overwrite=$true;output_format='json'}
 $r=Invoke-Mcp 'tools/call' @{name='write_note';arguments=$args}
 if($null -ne (RpcError $r) -or $r.result.isError){throw "Publication completion update was rejected: $(ToolFailure $r)"}
 $record=Read-ExactOrNull $Expected.path
 if($null -eq $record){throw 'Publication completion update made the root unreadable.'}
 Assert-Matches $record $Expected -WriteReadback
 if((Get-PublicationState $record) -cne 'complete'){throw 'Publication completion readback did not match.'}
}
function Update-BookCatalog($Entry,[string]$CollectionName) {
 $catalog=Read-ExactOrNull 'books/README.md';if($null -eq $catalog){throw 'The Book Catalog is missing; it will not be created implicitly.'}
 if(-not $CollectionName){
  # NO -Collection IS NOT A REQUEST FOR '## Open a Book'. This heading is the insert target for a
  # Book nobody has filed yet; placement_requested stays false so a refresh run without -Collection
  # leaves an already-filed entry exactly where its last collection decision put it.
  return [pscustomobject]@{catalog=$catalog;heading='## Open a Book';placement_requested=$false}
 }
 $headings=@('Projects','Reference','Workflows')
 foreach($heading in $headings){if([string]$catalog.content -notmatch ('(?m)^## '+[regex]::Escape($heading)+'\s*$')){
   $block=($headings|ForEach-Object{"## $_`n"})-join "`n"
   $edit=@{project_id=$ProjectId;identifier='books/README';operation='find_replace';find_text='## Open a Book';content="$block`n## Open a Book";expected_replacements=1;output_format='json'}
   $r=Invoke-Mcp 'tools/call' @{name='edit_note';arguments=$edit};if($null -ne (RpcError $r) -or $r.result.isError){throw 'Book Catalog collection headings could not be created.'}
   $catalog=Read-ExactOrNull 'books/README.md';break
  }}
 [pscustomobject]@{catalog=$catalog;heading="## $CollectionName";placement_requested=$true}
}
# THE SECTION AN ENTRY SITS IN IS PART OF THE ENTRY, and nothing else in this codebase models it.
# `collection` on a Book root and throughout BookRootSchema.ps1 means shared-versus-shelf -- a
# different axis that happens to share the word -- so the heading an entry is filed under is read
# out of the Catalog here rather than inherited from a field that merely sounds like it.
# One record per owned line, each carrying the '## Heading' it sits under, $null above the first.
# ONE READER FOR BOTH USES: the decision below and the readback after it ask this same function,
# so a Catalog the publisher calls correctly placed is the same Catalog it verified.
function Get-OwnedCatalogEntries([string]$CatalogText,[string]$Prefix) {
 $heading=$null
 foreach($line in ($CatalogText -split "`r?`n")){
  # '^##\s' and not '^#{2,}': a '### Sub' heading has no whitespace at index 2, so it cannot be
  # mistaken for a collection heading and does not reset the section an entry is counted under.
  if($line -cmatch '^##\s+\S'){$heading=$line.TrimEnd()}
  elseif($line.TrimStart().StartsWith($Prefix,[StringComparison]::Ordinal)){[pscustomobject]@{line=$line;heading=$heading}}
 }
}
$attempted=[Collections.Generic.List[string]]::new();$created=[Collections.Generic.List[string]]::new();$reused=[Collections.Generic.List[string]]::new()
function Save-Journal([string]$State,[string]$ErrorText){New-Item -ItemType Directory -Path (Split-Path -Parent $JournalPath) -Force|Out-Null;Write-Utf8 $JournalPath (([pscustomobject]@{state=$State;timestamp_utc=[DateTime]::UtcNow.ToString('o');project_id=$ProjectId;book_slug=$BookSlug;collection=$Collection;source_digest_sha256=$sourceDigest;page_manifest_sha256=$manifestDigest;approved_plan_id=$planId;planned_records=@($records|Where-Object{$_.source}|ForEach-Object{[pscustomobject]@{path=$_.path;source=$_.source;sha256=$_.sha256}});attempted_records=$attempted;created_records=$created;reused_records=$reused;error=$ErrorText})|ConvertTo-Json -Depth 8)}
try{
 Initialize-Mcp;$root=Read-ExactOrNull $records[0].path
 if($null -eq $root){$attempted.Add($records[0].path);Create-Record $records[0] $metadata;$created.Add($records[0].path)}
 else{
  $sameRoot=$true;$rootKeys=@('book_slug','source_digest_sha256','page_manifest_sha256','approved_plan_id');if($Collection){$rootKeys+='collection'};foreach($name in $rootKeys){if((Meta $root $name) -cne [string]$metadata[$name]){$sameRoot=$false}}
  if(-not $sameRoot){
   if(-not $ReplaceExisting){throw 'Existing Book has a different source or manifest. Review the preflight and rerun with -ReplaceExisting to refresh this exact Book.'}
   if((Meta $root 'book_slug') -cne $BookSlug){throw 'Existing root does not belong to this Book slug; it will not be replaced.'}
   $attempted.Add($records[0].path);Create-Record $records[0] $metadata -Overwrite;$created.Add($records[0].path)
  }else{if((Get-PublicationState $root) -notin @('copying','complete')){throw 'Existing root is not resumable.'};Assert-Matches $root $records[0];$reused.Add($records[0].path)}
 }
 foreach($expected in $records|Select-Object -Skip 1){
  $record=Read-ExactOrNull $expected.path
  if($null -eq $record){$attempted.Add($expected.path);Create-Record $expected $null;$created.Add($expected.path)}
  else{try{Assert-Matches $record $expected;$reused.Add($expected.path)}catch{if(-not $ReplaceExisting){throw};$attempted.Add($expected.path);Create-Record $expected $null -Overwrite;$created.Add($expected.path)}}
 }
 foreach($expected in $records){$record=Read-ExactOrNull $expected.path;if($null -eq $record){throw "Health check could not read '$($expected.path)'."};Assert-Matches $record $expected -WriteReadback}
 $root=Read-ExactOrNull $records[0].path;if((Get-PublicationState $root) -ne 'complete'){Set-RootPublicationComplete $records[0]}
 $root=Read-ExactOrNull $records[0].path;if((Get-PublicationState $root) -cne 'complete'){throw 'Publication completion readback did not match.'}
 # THE CATALOG LINE THIS BOOK OWNS is identified by its LINK TARGET, not by the whole rendered entry.
 # The title is display text a refresh may change, and Add-CatalogEntry.ps1 already treats
 # '[[<target>|' as the identity when it decides a slug is already listed; matching the rendered
 # title too would make a retitled Book insert a SECOND line beside its stale one. $Summary is the
 # same string the root body above writes as the '## Purpose' page body, so this entry is DERIVED
 # from what _book says rather than retyped next to it.
 $entry="- [[$($bookRoot)/_book|$BookTitle]] $([char]0x2014) $Summary"
 $ownedPrefix="- [[$($bookRoot)/_book|"
 $catalogState=Update-BookCatalog $entry $Collection
 $catalog=$catalogState.catalog
 $owned=@(Get-OwnedCatalogEntries ([string]$catalog.content) $ownedPrefix)
 $edits=@();$catalogEntryState='already-current';$movedFrom=$null
 if($owned.Count -eq 0){
  $edits=@(@{name='insert';args=@{find_text=$catalogState.heading;content="$($catalogState.heading)`n`n$entry";expected_replacements=1}});$catalogEntryState='inserted'
 }elseif($owned.Count -gt 1){
  throw "The Book Catalog carries $($owned.Count) entry lines linking '$bookRoot/_book'; it will not guess which one this publication owns."
 }elseif($catalogState.placement_requested -and $owned[0].heading -cne $catalogState.heading){
  # A COLLECTION CHANGE IS A MOVE, AND UNTIL 2026-09-18 IT WAS A REWRITE IN PLACE. -Collection
  # rewrites the root's `collection` metadata, but the branch below replaces the line where it
  # already sits, so the Catalog went on listing the Book under its old heading while every
  # reported field stayed true OF THE LINE -- 'replaced' about a line in the wrong section, or
  # 'already-current' about one whose text happened not to change. Quiet, and found by reading.
  #
  # REMOVE FIRST, THEN INSERT, which is the opposite order to Archive-SharedBook.ps1's cross-catalog
  # move and for the opposite reason. Both lines here carry ONE link target in ONE Catalog: inserting
  # first and failing to remove leaves two, which is the state the branch above refuses to guess
  # between, so a crash there would wedge every later publish of this Book. Removing first and
  # failing to insert leaves none, which the Count -eq 0 branch above heals on the next run. The
  # readback below is what turns either half-finished move into a loud stop rather than a quiet one.
  $movedFrom=$owned[0].heading
  $edits=@(
   @{name='remove-from-old-collection';args=@{find_text=$owned[0].line;content='';expected_replacements=1}}
   @{name='insert-under-new-collection';args=@{find_text=$catalogState.heading;content="$($catalogState.heading)`n`n$entry";expected_replacements=1}}
  );$catalogEntryState='moved'
 }elseif($owned[0].line -cne $entry){
  # A REFRESH REACHES THE CATALOG THROUGH HERE, and until 2026-09-10 nothing did: the only replacing
  # branch matched the legacy '**Candidate** (Local notebook copy, version X).' wording by name, so
  # an existing modern entry got no edit at all while the result claimed the Catalog was updated.
  # Replacing the whole line covers the legacy wording too, and expected_replacements=1 holds
  # because the line carries this Book's own link target -- the count above proved it is the only one.
  $edits=@(@{name='replace-in-place';args=@{find_text=$owned[0].line;content=$entry;expected_replacements=1}});$catalogEntryState='replaced'
 }
 foreach($step in $edits){
  $r=Invoke-Mcp 'tools/call' @{name='edit_note';arguments=@{project_id=$ProjectId;identifier='books/README';operation='find_replace';output_format='json'}+$step.args}
  if($null -ne (RpcError $r) -or $r.result.isError){throw "Book Catalog update was rejected (planned '$catalogEntryState', step '$($step.name)')."}
 }
 $catalog=Read-ExactOrNull 'books/README.md'
 # The readback verifies the Catalog AGREES WITH _book, not merely that it mentions this Book: the
 # exact entry line, exactly once. Looking only for the wikilink is what let a stale summary read
 # back as verified while it advertised a version the Book no longer carried.
 #
 # THE COUNT IS TAKEN OVER THE WHOLE CATALOG, NEVER WITHIN A SECTION. 'Exactly one entry under the
 # requested heading' is satisfied by a Catalog that now lists this Book TWICE, so the total comes
 # first and the placement is asked of that one surviving line -- which is also what makes a move
 # whose second edit failed a refusal rather than a silent half-move.
 $ownedAfter=@(Get-OwnedCatalogEntries ([string]$catalog.content) $ownedPrefix)
 $catalogEntryVerified=($ownedAfter.Count -eq 1 -and $ownedAfter[0].line -ceq $entry)
 if(-not $catalogEntryVerified){throw "Book Catalog readback did not carry this Book's current entry line exactly once: '$entry'."}
 $catalogEntryHeading=$ownedAfter[0].heading
 if($catalogState.placement_requested -and $catalogEntryHeading -cne $catalogState.heading){
  throw "Book Catalog readback filed this Book's entry under '$(if($null -eq $catalogEntryHeading){'no collection heading'}else{$catalogEntryHeading})' rather than the requested '$($catalogState.heading)'."
 }
 Save-Journal 'complete' $null
 # catalog_updated says an edit WAS ISSUED, which is false for a Catalog that was already correct;
 # catalog_entry_verified is the field a caller gates on, because it is what the readback proved.
 # catalog_entry_heading is reported on EVERY publish and not only on a move: the section an entry
 # sits in was the one fact about the Catalog this result never carried, which is why a Book filed
 # under the wrong heading read exactly like a Book filed under the right one.
 $result=[pscustomobject]@{operation='Publish a Copy';destination='shared';book_path=$bookRoot;publication_complete=$true;catalog_entry_verified=$catalogEntryVerified;catalog_updated=($edits.Count -gt 0);catalog_entry_state=$catalogEntryState;catalog_entry_heading=$catalogEntryHeading;catalog_entry_moved_from=$movedFrom;catalog_entry=$entry;journal_path=$JournalPath;created_records=$created;reused_records=$reused}
 if($FromShelf){$result|Add-Member -NotePropertyName local_original_preserved -NotePropertyValue $true}
 $result
}catch{Save-Journal 'copying' $_.Exception.Message;throw "Shared publication stopped safely. No local source was changed. Resume is allowed only when the existing root metadata and manifest match. Journal: $JournalPath. $($_.Exception.Message)"}
