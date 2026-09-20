[CmdletBinding()]
param(
    [string]$WorkspacePath,
    # NO DEFAULT, on purpose. Until 2026-09-19 this carried a literal LAN address for one reader's
    # inference server -- one household's network travelling in everyone else's clone. It was the
    # only hit in the tracked tree that step 11's deployment denylist could not see, because it is
    # an embeddings host rather than the collection's endpoint, and step 12's identity scan found it
    # on its first run. The address is not repeated here: a comment that records a removal by
    # quoting the value has not removed it. Resolved at the entry point rather than inside a helper,
    # so a caller can decline it.
    [string]$EmbeddingUrl = $env:TEI_EMBEDDING_URL,
    [string]$EmbeddingModel = 'tei-bge-small-en-v1-5',
    [string]$ApiKey = $env:TEI_API_KEY,
    [double]$SimilarityThreshold = 0.85,
    [int]$BatchSize = 8
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($EmbeddingUrl)) {
    throw 'No embedding endpoint. Pass -EmbeddingUrl <url>, or set $env:TEI_EMBEDDING_URL before running. There is deliberately no default: the address of your inference server is yours, and a value committed here would ship in every clone.'
}
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    throw 'No embedding API key. Pass -ApiKey, or set $env:TEI_API_KEY before running. Never hardcode the key in this script or paste it into chat/logs.'
}
if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$shelfRoot = Join-Path $workspace 'shelf'
if (-not (Test-Path -LiteralPath $shelfRoot -PathType Container)) { throw "No Shelf found at $shelfRoot" }

function Get-TopicExcerpt([string]$Path) {
    $text = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false, $true))
    # First ~1800 chars (~roughly under TEI's 512-token cap for this model) is enough signal: title + intro + article list.
    if ($text.Length -gt 1800) { $text = $text.Substring(0, 1800) }
    return $text
}

# One "topic" per non-root _index.md (each migrated Book's subfolders got one during Workspace Wiki
# Migration), plus each Book's own _book.md Purpose as a whole-Book-level signal. Root wiki/_index.md
# is excluded — it is the Book's own generated reader map, not a topic.
$topics = [Collections.Generic.List[object]]::new()
$bookDirs = @(Get-ChildItem -LiteralPath $shelfRoot -Directory -ErrorAction SilentlyContinue)
foreach ($bookDir in $bookDirs) {
    $wikiRoot = Join-Path $bookDir.FullName 'wiki'
    if (-not (Test-Path -LiteralPath $wikiRoot -PathType Container)) { continue }
    $bookMd = Join-Path $wikiRoot '_book.md'
    if (Test-Path -LiteralPath $bookMd -PathType Leaf) {
        $topics.Add([pscustomobject]@{ book = $bookDir.Name; topic = '(whole book)'; path = $bookMd; excerpt = (Get-TopicExcerpt $bookMd) })
    }
    $indexFiles = @(Get-ChildItem -LiteralPath $wikiRoot -File -Recurse -Filter '_index.md' | Where-Object { (Split-Path -Parent $_.FullName) -ne $wikiRoot })
    foreach ($idx in $indexFiles) {
        $relativeDir = (Split-Path -Parent $idx.FullName).Substring($wikiRoot.Length).TrimStart('\', '/').Replace('\', '/')
        $topics.Add([pscustomobject]@{ book = $bookDir.Name; topic = $relativeDir; path = $idx.FullName; excerpt = (Get-TopicExcerpt $idx.FullName) })
    }
}
if ($topics.Count -eq 0) { throw "No topics found under $shelfRoot (no Book has a wiki/_book.md or a subfolder _index.md)." }

# Embed in batches (TEI's CPU backend forces batch size 8 for the deployed model; keep the default aligned).
$headers = @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
$embeddings = [Collections.Generic.List[double[]]]::new()
for ($i = 0; $i -lt $topics.Count; $i += $BatchSize) {
    $batch = $topics.GetRange($i, [Math]::Min($BatchSize, $topics.Count - $i))
    $body = @{ input = @($batch | ForEach-Object { $_.excerpt }); model = $EmbeddingModel } | ConvertTo-Json -Depth 4
    try {
        $response = Invoke-RestMethod -Uri $EmbeddingUrl -Method Post -Headers $headers -Body $body -ContentType 'application/json'
    } catch {
        throw "Embedding request failed against $EmbeddingUrl (topics $($i+1)-$($i+$batch.Count) of $($topics.Count)): $($_.Exception.Message)"
    }
    foreach ($item in $response.data) { $embeddings.Add([double[]]$item.embedding) }
}
if ($embeddings.Count -ne $topics.Count) { throw "Embedding count mismatch: got $($embeddings.Count), expected $($topics.Count)." }

function Get-CosineSimilarity([double[]]$A, [double[]]$B) {
    $dot = 0.0; $normA = 0.0; $normB = 0.0
    for ($k = 0; $k -lt $A.Length; $k++) { $dot += $A[$k] * $B[$k]; $normA += $A[$k] * $A[$k]; $normB += $B[$k] * $B[$k] }
    if ($normA -eq 0 -or $normB -eq 0) { return 0.0 }
    return $dot / ([Math]::Sqrt($normA) * [Math]::Sqrt($normB))
}

$pairs = [Collections.Generic.List[object]]::new()
for ($x = 0; $x -lt $topics.Count; $x++) {
    for ($y = $x + 1; $y -lt $topics.Count; $y++) {
        if ($topics[$x].book -eq $topics[$y].book) { continue }  # only cross-Book overlap is the duplicate-topic concern
        $score = Get-CosineSimilarity $embeddings[$x] $embeddings[$y]
        if ($score -ge $SimilarityThreshold) {
            $pairs.Add([pscustomobject]@{
                similarity = [Math]::Round($score, 4)
                book_a = $topics[$x].book; topic_a = $topics[$x].topic
                book_b = $topics[$y].book; topic_b = $topics[$y].topic
            })
        }
    }
}
$pairs = @($pairs | Sort-Object -Property similarity -Descending)

[pscustomobject]@{
    operation = 'Find candidate duplicate topics across the Shelf'
    embedding_url = $EmbeddingUrl
    embedding_model = $EmbeddingModel
    similarity_threshold = $SimilarityThreshold
    topics_scanned = $topics.Count
    books_scanned = @($bookDirs | Select-Object -ExpandProperty Name)
    candidate_pairs = $pairs
    guidance = 'A high score is a lead, not a verdict — read both topics before deciding anything. See docs/duplicate-topic-resolution.md for the survivorship rule and the canonical + stub pattern. This tool only reads the Shelf; it never writes.'
    shared_library_write = $false
}
