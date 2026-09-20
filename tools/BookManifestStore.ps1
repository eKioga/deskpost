<#
.SYNOPSIS
    Store one Shelf Book's Discovery metadata manifest: versioned generations, a dirty marker, and
    a commit pointer. Dot-sourced; never invoked directly.

.DESCRIPTION
    Plan item 2.2, second rung: the storage for the manifest artefact the first rung generates.
    Where BookManifest.ps1 turns a Book on disk into a manifest object, this file makes that object
    durable -- deterministically, so "has this Book changed" stays a hash comparison.

    THE READ PATH REFUSES RATHER THAN SERVES STALE METADATA. Discovery iterates every Book, so one
    Book mid-mutation must be reported unavailable, never answered from an old pointer: a dirty
    marker, a missing generation, or a hash mismatch all read as a refusal, and none of them throws.

    THE COMMIT POINTER IS WRITTEN LAST AND THE DIRTY MARKER CLEARED LAST OF ALL. A generation is
    never written without its marker, and a marker is never cleared before the pointer that
    supersedes it is on disk, so every crash leaves a state the read path can classify instead of
    one it can mistake for the truth.

    THE PER-BOOK LOCK IS RUNG 3 AND ITS ABSENCE HERE IS DELIBERATE, NOT AN OVERSIGHT. This rung is
    the ordering discipline made mechanical; the lock that makes concurrent writers impossible is
    the next rung and belongs there, wrapping Save-BookManifest and nothing else.
#>

Set-StrictMode -Version Latest

# The manifest collection names are the Book-root schema's to define, not this file's: the store key
# is (collection, shelf) flattened, and a second list here would be the fifth place the archive's
# shape was written out by hand. BookRootSchema.ps1 dot-sources only AtomicFile.ps1, which dot-sources
# nothing, so this cannot cycle.
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')

# THE STORE'S SCHEMA AND THE MANIFEST BODY'S SCHEMA ARE TWO DIFFERENT NUMBERS, AND THIS ONE HAS NOT
# MOVED. This versions current.json and dirty.json -- the pointer and the marker this file writes.
# BookManifest.ps1 versions the manifest BODY, and that went to 2 when the upstream roll-up landed
# (ADR-0011). Nothing here validates the body's schema, which is deliberate: a generation written
# under body schema 1 stays readable and keeps answering Discovery exactly as it did. Bumping this
# number instead would have read every stored pointer as corrupt and made the whole Shelf
# unavailable until a regeneration sweep -- the day-one-data failure this workspace has hit before.
$script:BookManifestStoreSchema = 1
$script:BookManifestStoreRoot   = 'internal/book-manifests'
$script:BookManifestKeepGenerations = 5
# Four attempts at ~100ms, 200ms, 300ms: enough to outlast an indexer or scanner holding a file for a
# moment, short enough that a genuinely held destination still fails inside a Book's turn.
$script:BookManifestStoreSwapAttempts = 4
$script:BookManifestStoreSwapBackoffMs = 100

# --- Shared helpers -------------------------------------------------------------------------------

# Deterministic serialization: ConvertTo-Json, then CRLF normalised to LF, then exactly one
# trailing LF. The same manifest object must produce byte-identical files across runs.
function ConvertTo-BookManifestStoreJson([object]$Object) {
    $json = $Object | ConvertTo-Json -Depth 12
    $json = $json -replace "`r`n", "`n"
    if (-not $json.EndsWith("`n")) { $json += "`n" }
    $json
}

# A hash over the written file's bytes, lowercase hex -- what the commit pointer compares against.
function Get-ManifestStoreSha256([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
}

# Atomic write, copied from Set-TopicOverlap.ps1's Save-OverlapFile: write a .tmp beside the
# destination, then swap, so a crash mid-write leaves the previous file intact rather than a
# truncated one. File.Move has no overwrite overload on Windows PowerShell, so an existing
# destination is replaced and a new one is moved into place.
function Save-BookManifestStoreFile([string]$Path, [string]$Content) {
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $temp = "$Path.tmp"
    [IO.File]::WriteAllText($temp, $Content, [Text.UTF8Encoding]::new($false))
    # Retried, because the swap can lose a race it did nothing wrong in. Rung 7's first full rebuild
    # over the shared collection lost one Book of thirteen to
    # "Unable to remove the file to be replaced" -- a momentary sharing violation from something else
    # on the machine holding the destination open, not a state problem. The design already handled it
    # correctly (that Book read dirty, the pass carried on, a re-run repaired it), and the cost was
    # still a spurious dirty Book and a second approved pass over closed content. A bounded retry with
    # backoff is the cheaper answer. It is deliberately bounded: a destination held open indefinitely
    # is a state we do not understand, and failing there is right.
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            # [NullString]::Value, not $null: PowerShell converts $null to an empty string when
            # binding a [string] parameter, and File.Replace rejects "" as "The path is not of a
            # legal form."
            if (Test-Path -LiteralPath $Path -PathType Leaf) { [IO.File]::Replace($temp, $Path, [NullString]::Value) }
            else { [IO.File]::Move($temp, $Path) }
            return
        }
        catch [IO.IOException] {
            if ($attempt -ge $script:BookManifestStoreSwapAttempts) { throw }
            Start-Sleep -Milliseconds ($script:BookManifestStoreSwapBackoffMs * $attempt)
        }
    }
}

# --- The store ------------------------------------------------------------------------------------

function Get-BookManifestStorePath([string]$Workspace, [string]$Slug, [string]$Collection = 'shelf') {
    # -cnotmatch: -notmatch is case-insensitive, so this lowercase-only rule would accept 'Foo' and
    # build a path for a name that cannot exist. This path is built from a name, so traversal is
    # refused at the door.
    if ($Slug -cnotmatch '^[a-z0-9][a-z0-9-]*$') { throw "Book slug '$Slug' must contain only lowercase letters, digits, and hyphens." }
    # Rung 7. A store keyed on the slug ALONE was relying on a coincidence: no shared Book happens to
    # share a slug with a Shelf Book today, and the nearest miss is one word wide. The lock has always
    # distinguished the two collections -- BookWriteGuard normalises book_root to shelf-<slug> versus
    # books-<slug> -- so the store now keys the same way it does. A collision would have had one
    # Book's manifest answering for another's, which no status could detect.
    # Four names since the archives entered search, and the list is the schema's. An archived Book is
    # still `shelf` or still `shared`, so `collection` alone would put an archived Book's manifest in
    # its ACTIVE twin's store -- the collision this rung exists to prevent, one shelf over.
    if ($Collection -cnotin (Get-BookManifestCollections)) { throw "Book collection '$Collection' must be one of: $((Get-BookManifestCollections) -join ', ')." }
    Join-Path $Workspace (Join-Path $script:BookManifestStoreRoot (Join-Path $Collection $Slug))
}

function Set-BookManifestDirty([string]$Workspace, [string]$Slug, [string]$Reason, [string]$Collection = 'shelf') {
    $dir = Get-BookManifestStorePath -Workspace $Workspace -Slug $Slug -Collection $Collection
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $marker = [ordered]@{
        schema      = $script:BookManifestStoreSchema
        slug        = $Slug
        reason      = $Reason
        pid         = $PID
        started_utc = [DateTime]::UtcNow.ToString('o')
    }
    $path = Join-Path $dir 'dirty.json'
    Save-BookManifestStoreFile -Path $path -Content (ConvertTo-BookManifestStoreJson $marker)
    # Overwriting an existing marker is allowed and refreshes it: rung 3's lock makes concurrent
    # markers impossible, and a marker left behind by a crash must not block the repair that clears
    # it -- refusing to overwrite would turn a stale marker into a permanent refusal.
    $path
}

function Write-BookManifestGeneration([string]$Workspace, [string]$Slug, [object]$Manifest, [string]$Collection = 'shelf') {
    $dir = Get-BookManifestStorePath -Workspace $Workspace -Slug $Slug -Collection $Collection
    # The ordering rule made mechanical rather than merely documented: a generation written
    # without a marker is exactly the silent-stale case this rung exists to prevent.
    if (-not (Test-Path -LiteralPath (Join-Path $dir 'dirty.json') -PathType Leaf)) {
        throw "Book '$Slug' has no dirty marker; a manifest generation may only be written inside a mutation."
    }
    $generation = Get-NextGeneration -Workspace $Workspace -Slug $Slug -Collection $Collection
    $path = Join-Path $dir (Join-Path 'generations' "$generation.json")
    Save-BookManifestStoreFile -Path $path -Content (ConvertTo-BookManifestStoreJson $Manifest)
    [pscustomobject]@{
        generation      = $generation
        path            = $path
        manifest_sha256 = Get-ManifestStoreSha256 -Path $path
    }
}

function Complete-BookManifestGeneration([string]$Workspace, [string]$Slug, [int]$Generation, [string]$Collection = 'shelf') {
    $dir = Get-BookManifestStorePath -Workspace $Workspace -Slug $Slug -Collection $Collection
    $genPath = Join-Path $dir (Join-Path 'generations' "$Generation.json")
    if (-not (Test-Path -LiteralPath $genPath -PathType Leaf)) {
        throw "Generation $Generation of Book '$Slug' has no stored file; nothing to commit."
    }
    # Never trust a hash passed in: re-read the generation from disk and re-hash it.
    $stored = [IO.File]::ReadAllText($genPath) | ConvertFrom-Json
    $pointer = [ordered]@{
        schema          = $script:BookManifestStoreSchema
        slug            = $Slug
        generation      = $Generation
        committed_utc   = [DateTime]::UtcNow.ToString('o')
        manifest_sha256 = Get-ManifestStoreSha256 -Path $genPath
        source_digest   = [string]$stored.source_digest
    }
    Save-BookManifestStoreFile -Path (Join-Path $dir 'current.json') -Content (ConvertTo-BookManifestStoreJson $pointer)
    # The commit pointer is on disk; only now is the dirty marker cleared, and only after that can
    # a crash leave the read path unable to classify the state it finds.
    Remove-Item -LiteralPath (Join-Path $dir 'dirty.json') -Force -ErrorAction SilentlyContinue
    Prune-BookManifestGenerations -Workspace $Workspace -Slug $Slug -Collection $Collection
    [pscustomobject]$pointer
}

function Save-BookManifest([string]$Workspace, [string]$Slug, [object]$Manifest, [string]$Reason, [string]$Collection = 'shelf') {
    # Rung 3 wraps THIS function in the per-Book lock. Nothing in this rung may acquire one; the
    # ordering rules here are what make a later lock sufficient.
    Set-BookManifestDirty -Workspace $Workspace -Slug $Slug -Reason $Reason -Collection $Collection | Out-Null
    $written = Write-BookManifestGeneration -Workspace $Workspace -Slug $Slug -Manifest $Manifest -Collection $Collection
    Complete-BookManifestGeneration -Workspace $Workspace -Slug $Slug -Generation $written.generation -Collection $Collection
}

# A Book that no longer exists under this slug must not leave a store behind. Rung 2 recorded the
# orphan as a known limit; rung 4 owns it, because a rename is the operation that creates one.
#
# Deleting a manifest is safe in a way deleting a page never is: a manifest is DERIVED from the Book,
# so the worst a wrong deletion costs is a rebuild. That is the same asymmetry the dirty marker is
# built on, and it is why this removes the whole directory -- marker, generations, and pointer -- and
# not merely the pointer. Half a store is a state the read path would have to classify for a Book
# that is not there.
function Remove-BookManifestStore([string]$Workspace, [string]$Slug, [string]$Collection = 'shelf') {
    $dir = Get-BookManifestStorePath -Workspace $Workspace -Slug $Slug -Collection $Collection
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
        return [pscustomobject]@{ slug = $Slug; removed = $false; path = $dir }
    }
    Remove-Item -LiteralPath $dir -Recurse -Force
    [pscustomobject]@{ slug = $Slug; removed = $true; path = $dir }
}

function Get-StoredBookManifest([string]$Workspace, [string]$Slug, [string]$Collection = 'shelf') {
    $dir = Get-BookManifestStorePath -Workspace $Workspace -Slug $Slug -Collection $Collection
    $result = [pscustomobject]@{
        status        = 'missing'
        reason        = ''
        slug          = $Slug
        generation    = $null
        manifest      = $null
        source_digest = $null
        # When the pointer was written. The Currency check's collection tier reports it so a reader
        # can tell "no upstream has moved" from "this manifest was measured three weeks ago".
        committed_utc = $null
    }

    # Dirty is checked first: a dirty Book is refused even when a pointer and a matching generation
    # both exist, because the mutation may not be finished.
    $dirtyPath = Join-Path $dir 'dirty.json'
    if (Test-Path -LiteralPath $dirtyPath -PathType Leaf) {
        $result.status = 'dirty'
        try {
            $marker = [IO.File]::ReadAllText($dirtyPath) | ConvertFrom-Json
            $result.reason = "mutation in progress: $($marker.reason) (pid $($marker.pid))"
        }
        catch { $result.reason = 'a dirty marker is present but does not parse' }
        return $result
    }

    $currentPath = Join-Path $dir 'current.json'
    if (-not (Test-Path -LiteralPath $currentPath -PathType Leaf)) {
        $result.status = 'missing'
        $result.reason = 'no commit pointer exists for this Book'
        return $result
    }

    $current = $null
    try { $current = [IO.File]::ReadAllText($currentPath) | ConvertFrom-Json }
    catch { }
    # Enumerate the member collection rather than reading .Name straight off it: an empty property
    # set throws under Set-StrictMode when read as an aggregate. A failed parse leaves $current
    # null, which must read corrupt, not throw.
    $currentProps = @()
    if ($null -ne $current) { $currentProps = @($current.PSObject.Properties | ForEach-Object { $_.Name }) }
    if ($currentProps.Count -eq 0) {
        $result.status = 'corrupt'
        $result.reason = 'current.json does not parse as a JSON object'
        return $result
    }

    $required = @('schema', 'slug', 'generation', 'committed_utc', 'manifest_sha256', 'source_digest')
    $missing = @($required | Where-Object { $currentProps -cnotcontains $_ })
    if ($missing.Count) {
        $result.status = 'corrupt'
        $result.reason = "current.json is missing required field(s): $($missing -join ', ')"
        return $result
    }

    $schema = 0
    if (-not [int]::TryParse([string]$current.schema, [ref]$schema)) {
        $result.status = 'corrupt'
        $result.reason = 'current.json carries a non-numeric schema'
        return $result
    }
    if ($schema -ne $script:BookManifestStoreSchema) {
        $result.status = 'corrupt'
        $result.reason = "current.json carries schema $schema, expected $($script:BookManifestStoreSchema)"
        return $result
    }

    $generation = 0
    if (-not [int]::TryParse([string]$current.generation, [ref]$generation)) {
        $result.status = 'corrupt'
        $result.reason = 'current.json carries a non-numeric generation'
        return $result
    }
    $result.generation = $generation

    $genPath = Join-Path $dir (Join-Path 'generations' "$generation.json")
    if (-not (Test-Path -LiteralPath $genPath -PathType Leaf)) {
        $result.status = 'incomplete'
        $result.reason = "generation $generation named by the commit pointer is absent"
        return $result
    }

    if ((Get-ManifestStoreSha256 -Path $genPath) -cne [string]$current.manifest_sha256) {
        $result.status = 'corrupt'
        $result.reason = 'the generation file bytes do not match the committed hash'
        return $result
    }

    $manifest = $null
    try { $manifest = [IO.File]::ReadAllText($genPath) | ConvertFrom-Json }
    catch { }
    $manifestProps = @()
    if ($null -ne $manifest) { $manifestProps = @($manifest.PSObject.Properties | ForEach-Object { $_.Name }) }
    if ($manifestProps.Count -eq 0) {
        $result.status = 'corrupt'
        $result.reason = 'the generation file does not parse as a JSON object'
        return $result
    }

    $result.status = 'ok'
    $result.reason = ''
    $result.source_digest = [string]$current.source_digest
    $result.committed_utc = [string]$current.committed_utc
    $result.manifest = $manifest
    $result
}

# --- Generation numbering and pruning -------------------------------------------------------------

function Get-NextGeneration([string]$Workspace, [string]$Slug, [string]$Collection = 'shelf') {
    $dir = Get-BookManifestStorePath -Workspace $Workspace -Slug $Slug -Collection $Collection
    $max = 0
    $genDir = Join-Path $dir 'generations'
    if (Test-Path -LiteralPath $genDir -PathType Container) {
        foreach ($file in @(Get-ChildItem -LiteralPath $genDir -File -Filter '*.json')) {
            $base = [IO.Path]::GetFileNameWithoutExtension($file.Name)
            [int]$n = 0
            if ([int]::TryParse($base, [ref]$n) -and $n -gt $max) { $max = $n }
        }
    }
    $currentPath = Join-Path $dir 'current.json'
    if (Test-Path -LiteralPath $currentPath -PathType Leaf) {
        try {
            $current = [IO.File]::ReadAllText($currentPath) | ConvertFrom-Json
            if ($null -ne $current) {
                [int]$g = 0
                if ([int]::TryParse([string]$current.generation, [ref]$g) -and $g -gt $max) { $max = $g }
            }
        }
        catch { }
    }
    $max + 1
}

function Prune-BookManifestGenerations([string]$Workspace, [string]$Slug, [string]$Collection = 'shelf') {
    $dir = Get-BookManifestStorePath -Workspace $Workspace -Slug $Slug -Collection $Collection
    $genDir = Join-Path $dir 'generations'
    if (-not (Test-Path -LiteralPath $genDir -PathType Container)) { return }

    $committed = 0
    $currentPath = Join-Path $dir 'current.json'
    if (Test-Path -LiteralPath $currentPath -PathType Leaf) {
        try {
            $current = [IO.File]::ReadAllText($currentPath) | ConvertFrom-Json
            if ($null -ne $current) {
                [int]$g = 0
                if ([int]::TryParse([string]$current.generation, [ref]$g)) { $committed = $g }
            }
        }
        catch { }
    }

    $entries = @()
    foreach ($file in @(Get-ChildItem -LiteralPath $genDir -File -Filter '*.json')) {
        $base = [IO.Path]::GetFileNameWithoutExtension($file.Name)
        [int]$n = 0
        if ([int]::TryParse($base, [ref]$n)) {
            $entries += [pscustomobject]@{ n = $n; path = $file.FullName }
        }
    }
    $sorted = @($entries | Sort-Object -Property @{ Expression = { $_.n } } -Descending)
    $keep = @($sorted | Select-Object -First $script:BookManifestKeepGenerations)
    foreach ($entry in $sorted) {
        if ($entry.n -eq $committed) { continue }
        if (@($keep | Where-Object { $_.n -eq $entry.n }).Count -gt 0) { continue }
        Remove-Item -LiteralPath $entry.path -Force
    }
}

# ---------------------------------------------------------------------------------------------------
# Self-test. Fixture-only and offline; run by Invoke-LibraryChecks.ps1 as
# `book-manifest-store.selftest`.
# ---------------------------------------------------------------------------------------------------
if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') {
    $script:failures = [Collections.Generic.List[string]]::new()
    $script:checks = 0
    function Assert([bool]$Condition, [string]$Message) {
        $script:checks++
        if (-not $Condition) { [void]$script:failures.Add($Message) }
    }

    $utf8 = [Text.UTF8Encoding]::new($false)
    function Write-Fixture([string]$Path, [string]$Text) {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [IO.File]::WriteAllText($Path, $Text, $utf8)
    }

    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('book-manifest-store-selftest-' + [Guid]::NewGuid().ToString('n'))
    try {
        # Real New-BookManifest output is what gets stored, so the fixture is a real Shelf: one
        # curated Book and one capture Book.
        . (Join-Path $PSScriptRoot 'BookManifest.ps1')

        Write-Fixture (Join-Path $fixture 'shelf/_catalog.md') @'
# Local Shelf

## Demo Book
- **Summary:** A curated demo Book for the manifest store.
- **Topics:** demo, curated
- **Path:** shelf/demo

## Inbox
- **Summary:** Captures awaiting review.
- **Topics:** capture
- **Kind:** capture
- **Path:** shelf/inbox
'@

        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/_book.md') "# Demo Book`n`n- **Type:** fixture`n"
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/_index.md') "# Demo Book - Reader Map`n`n- [[_book|Book metadata]]`n- [[topic/plain]]`n"
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/plain.md') @'
---
captured: 2026-08-18T00:00:00Z
---

# Real Title

Body text.

## A Real Section

### Back Outside
'@

        # Non-ASCII, built from code points rather than written as literals: this file has no BOM, so
        # a literal em-dash in this source would be mangled by the very hazard the case is about.
        $emDash = [string][char]0x2014
        $curlyOpen = [string][char]0x201C
        $curlyClose = [string][char]0x201D
        $eAcute = [string][char]0x00E9
        $unicodeTitle = "Unicode Page $emDash title"
        $unicodeHeading = "Caf$eAcute $emDash $curlyOpen" + "quoted$curlyClose section"
        Write-Fixture (Join-Path $fixture 'shelf/demo/wiki/topic/unicode.md') "# $unicodeTitle`n`n## $unicodeHeading`n`nBody.`n"

        Write-Fixture (Join-Path $fixture 'shelf/inbox/wiki/_book.md') "# Inbox`n`n- **Kind:** capture`n"
        Write-Fixture (Join-Path $fixture 'shelf/inbox/wiki/_index.md') "# Inbox - Reader Map`n`n- [[notes/secret-note|Sekrit Capture Title]]`n"
        Write-Fixture (Join-Path $fixture 'shelf/inbox/wiki/notes/secret-note.md') "---`ncaptured: 2026-08-18T00:00:00Z`nreview: pending`n---`n`n# Sekrit Capture Title`n`nUnvetted body.`n"
        Write-Fixture (Join-Path $fixture 'shelf/inbox/wiki/notes/done-note.md') "---`ncaptured: 2026-08-18T00:00:00Z`nreview: done`n---`n`n# Reviewed Note`n"

        # --- The store path is catalog-class: under internal/, never under the Shelf read guard ----
        $storePath = Get-BookManifestStorePath -Workspace $fixture -Slug 'demo'
        Assert ($storePath -cmatch 'internal[\\/]book-manifests[\\/]shelf[\\/]demo$') 'the manifest store path does not resolve under internal/'
        Assert (-not $storePath.StartsWith((Join-Path $fixture 'shelf'))) 'the manifest store path resolves under the workspace Shelf, where the read guard would refuse it'

        # --- Rung 7: the store is keyed on the collection as well as the slug ----------------------
        # The lock has always distinguished the two collections; until rung 7 the store did not, and
        # was relying on the coincidence that no slug appears in both. A collision would have had one
        # Book's manifest answering for another's, and no status could have detected it.
        $sharedPath = Get-BookManifestStorePath -Workspace $fixture -Slug 'demo' -Collection 'shared'
        Assert ($sharedPath -cmatch 'internal[\\/]book-manifests[\\/]shared[\\/]demo$') 'a shared Book''s store path does not resolve under shared/'
        Assert ($sharedPath -cne $storePath) 'the same slug in both collections resolves to ONE store path'
        $badCollection = $false
        try { Get-BookManifestStorePath -Workspace $fixture -Slug 'demo' -Collection 'Shared' | Out-Null } catch { $badCollection = $true }
        Assert $badCollection 'a mis-cased collection name was accepted'
        foreach ($bad in @('..', '../x', 'Foo')) {
            $refused = $false
            try { Get-BookManifestStorePath -Workspace $fixture -Slug $bad | Out-Null } catch { $refused = $true }
            Assert $refused "slug '$bad' was accepted by Get-BookManifestStorePath"
        }

        # --- Round trip -----------------------------------------------------------------------------
        $demo = New-BookManifest -Workspace $fixture -Slug 'demo'
        $saved = Save-BookManifest -Workspace $fixture -Slug 'demo' -Manifest $demo -Reason 'selftest round trip'
        Assert ($saved.generation -eq 1) "the first saved generation was $($saved.generation), not 1"
        $read = Get-StoredBookManifest -Workspace $fixture -Slug 'demo'
        Assert ($read.status -ceq 'ok') "a saved Book read back as $($read.status), not ok"
        Assert (($read.manifest | ConvertTo-Json -Depth 12) -ceq ($demo | ConvertTo-Json -Depth 12)) 'the manifest read back does not equal the manifest saved'
        Assert ($saved.source_digest -ceq $demo.source_digest) 'the commit pointer source_digest does not match the stored manifest'
        Assert ($read.source_digest -ceq $demo.source_digest) 'the read source_digest does not match the stored manifest'

        # A generation file is UTF-8 with NO BOM, and Get-Content -Raw reads a BOM-less file as ANSI
        # in Windows PowerShell 5.1 -- the sixth hazard in .claude/rules/library-development.md. This
        # read path used it, so every text field of every manifest it returned was silently mangled
        # from the day it was written. No fixture noticed, because every fixture here was ASCII; the
        # first real Discovery query found it, with a Book title coming back as three characters
        # where the em-dash had been. The round-trip assertion above now covers it too, because the
        # fixture is no longer ASCII -- which is the point.
        $unicodePage = @($read.manifest.pages | Where-Object { $_.path -ceq 'topic/unicode' })
        Assert ($unicodePage.Count -eq 1) 'the non-ASCII fixture page is missing from the stored manifest'
        Assert (($unicodePage.Count -eq 1) -and ($unicodePage[0].title -ceq $unicodeTitle)) 'a non-ASCII page title did not survive the store round trip'
        Assert (($unicodePage.Count -eq 1) -and (@($unicodePage[0].headings | Where-Object { $_.text -ceq $unicodeHeading }).Count -eq 1)) 'a non-ASCII heading did not survive the store round trip'

        $demoDir = Get-BookManifestStorePath -Workspace $fixture -Slug 'demo'

        # --- Generations advance, deterministically --------------------------------------------------
        $saved2 = Save-BookManifest -Workspace $fixture -Slug 'demo' -Manifest $demo -Reason 'selftest determinism'
        Assert ($saved2.generation -eq 2) "the second saved generation was $($saved2.generation), not 2"
        Assert ($saved2.manifest_sha256 -ceq $saved.manifest_sha256) 'an unchanged Book produced a different manifest hash'
        $gen1Path = Join-Path $demoDir "generations/$($saved.generation).json"
        $gen2Path = Join-Path $demoDir "generations/$($saved2.generation).json"
        $gen1Bytes = [IO.File]::ReadAllBytes($gen1Path)
        $gen2Bytes = [IO.File]::ReadAllBytes($gen2Path)
        Assert ([Convert]::ToBase64String($gen1Bytes) -ceq [Convert]::ToBase64String($gen2Bytes)) 'an unchanged Book produced different generation bytes'
        Assert (-not ($gen1Bytes.Length -ge 3 -and $gen1Bytes[0] -eq 0xEF -and $gen1Bytes[1] -eq 0xBB -and $gen1Bytes[2] -eq 0xBF)) 'a generation file was written with a UTF-8 BOM'

        # --- The commit pointer is written last, the dirty marker cleared last of all ----------------
        # Run on a Book with no prior pointer: the check is that dirty+write alone must not create
        # current.json, so a Book that already has one would make the assertion vacuous.
        $freshDir = Get-BookManifestStorePath -Workspace $fixture -Slug 'fresh'
        Set-BookManifestDirty -Workspace $fixture -Slug 'fresh' -Reason 'selftest pointer-last' | Out-Null
        $written = Write-BookManifestGeneration -Workspace $fixture -Slug 'fresh' -Manifest $demo
        Assert (-not (Test-Path -LiteralPath (Join-Path $freshDir 'current.json') -PathType Leaf)) 'current.json exists before the generation is completed'
        $during = Get-StoredBookManifest -Workspace $fixture -Slug 'fresh'
        Assert ($during.status -ceq 'dirty') 'the reader did not refuse an unfinished mutation'
        Complete-BookManifestGeneration -Workspace $fixture -Slug 'fresh' -Generation $written.generation | Out-Null
        Assert (-not (Test-Path -LiteralPath (Join-Path $freshDir 'dirty.json') -PathType Leaf)) 'the dirty marker survived completion'
        Assert (Test-Path -LiteralPath (Join-Path $freshDir 'current.json') -PathType Leaf) 'current.json was not written on completion'

        # --- The reader refuses while dirty, even with a valid pointer and generation ---------------
        Set-BookManifestDirty -Workspace $fixture -Slug 'demo' -Reason 'selftest dirty refusal' | Out-Null
        $refused = Get-StoredBookManifest -Workspace $fixture -Slug 'demo'
        Assert ($refused.status -ceq 'dirty') 'a dirty Book with a valid pointer and generation was not refused'
        Assert ($null -eq $refused.manifest) 'a dirty Book returned a manifest'
        Remove-Item -LiteralPath (Join-Path $demoDir 'dirty.json') -Force

        # --- The ordering rule is mechanical, not merely documented ----------------------------------
        $threw = $false
        try { Write-BookManifestGeneration -Workspace $fixture -Slug 'demo' -Manifest $demo | Out-Null } catch { $threw = $true }
        Assert $threw 'Write-BookManifestGeneration wrote a generation with no dirty marker'

        # --- Pruning: at most the keep window, never the committed generation ------------------------
        for ($i = 0; $i -lt 5; $i++) {
            Save-BookManifest -Workspace $fixture -Slug 'demo' -Manifest $demo -Reason 'selftest prune' | Out-Null
        }
        $remaining = @(Get-ChildItem -LiteralPath (Join-Path $demoDir 'generations') -File -Filter '*.json')
        Assert ($remaining.Count -le $script:BookManifestKeepGenerations) "pruning left $($remaining.Count) generations, over the keep window of $($script:BookManifestKeepGenerations)"
        $committedGen = [int]([IO.File]::ReadAllText((Join-Path $demoDir 'current.json')) | ConvertFrom-Json).generation
        Assert (Test-Path -LiteralPath (Join-Path $demoDir "generations/$committedGen.json") -PathType Leaf) "pruning deleted the committed generation $committedGen"

        # --- The refusing read path: incomplete, then never-saved, then corrupt ----------------------
        Remove-Item -LiteralPath (Join-Path $demoDir "generations/$committedGen.json") -Force
        $incomplete = Get-StoredBookManifest -Workspace $fixture -Slug 'demo'
        Assert ($incomplete.status -ceq 'incomplete') 'a missing generation file was not reported incomplete'

        $missing = Get-StoredBookManifest -Workspace $fixture -Slug 'never-saved'
        Assert ($missing.status -ceq 'missing') 'a never-saved Book was not reported missing'
        Assert ($null -eq $missing.manifest) 'a never-saved Book returned a manifest'

        # --- Leak canary against the file on disk: capture content must not reach storage -----------
        $inbox = New-BookManifest -Workspace $fixture -Slug 'inbox'
        $inboxSaved = Save-BookManifest -Workspace $fixture -Slug 'inbox' -Manifest $inbox -Reason 'selftest leak canary'
        $inboxGenPath = Join-Path (Get-BookManifestStorePath -Workspace $fixture -Slug 'inbox') "generations/$($inboxSaved.generation).json"
        $inboxGenText = [IO.File]::ReadAllText($inboxGenPath)
        Assert ($inboxGenText -cnotmatch 'Sekrit Capture Title') 'a capture note title reached the stored generation file'
        Assert ($inboxGenText -cnotmatch 'secret-note') 'a capture note path reached the stored generation file'
        Assert ($inboxGenText -cnotmatch 'Unvetted body') 'capture note body text reached the stored generation file'

        # --- Tampered generation, then a malformed pointer -------------------------------------------
        [IO.File]::AppendAllText($inboxGenPath, 'x', $utf8)
        $tampered = Get-StoredBookManifest -Workspace $fixture -Slug 'inbox'
        Assert ($tampered.status -ceq 'corrupt') 'a tampered generation was not refused as corrupt'
        Assert ($null -eq $tampered.manifest) 'a corrupt Book still returned a manifest'
        $inboxDir = Get-BookManifestStorePath -Workspace $fixture -Slug 'inbox'
        [IO.File]::WriteAllText((Join-Path $inboxDir 'current.json'), 'this is not json{{', $utf8)
        $badPointer = Get-StoredBookManifest -Workspace $fixture -Slug 'inbox'
        Assert ($badPointer.status -ceq 'corrupt') 'a malformed current.json was not refused as corrupt'

        # --- Removing a store, for a Book that no longer exists under this slug ----------------------
        # A corrupt store is exactly the state a removal has to survive: this one has been tampered
        # with and its pointer is unparseable, and it must still go completely.
        $removedInbox = Remove-BookManifestStore -Workspace $fixture -Slug 'inbox'
        Assert $removedInbox.removed 'removing a stored manifest did not report removing it'
        Assert (-not (Test-Path -LiteralPath $inboxDir)) 'the store directory survived its removal'
        Assert ((Get-StoredBookManifest -Workspace $fixture -Slug 'inbox').status -ceq 'missing') 'a removed store did not read back as missing'
        $removedAgain = Remove-BookManifestStore -Workspace $fixture -Slug 'inbox'
        Assert (-not $removedAgain.removed) 'removing an absent store reported a removal'
        $badSlugRefused = $false
        try { Remove-BookManifestStore -Workspace $fixture -Slug '../demo' | Out-Null } catch { $badSlugRefused = $true }
        Assert $badSlugRefused 'a traversing slug was accepted by the store removal'
        Assert (Test-Path -LiteralPath (Get-BookManifestStorePath -Workspace $fixture -Slug 'demo')) 'an unrelated Book''s store was removed'

        # --- Rung 7: the atomic swap survives a momentary sharing violation --------------------------
        # Found on the first full shared rebuild, where one Book of thirteen was lost to
        # "Unable to remove the file to be replaced". Held open for the whole call, the swap must
        # still fail -- a destination nothing releases is a state we do not understand -- and it must
        # have tried more than once before giving up, which the elapsed time proves.
        $swapPath = Join-Path $fixture 'internal/swap-probe.json'
        Save-BookManifestStoreFile -Path $swapPath -Content "{}`n"
        $held = [IO.File]::Open($swapPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $swapFailed = $false
        $elapsed = [Diagnostics.Stopwatch]::StartNew()
        try { Save-BookManifestStoreFile -Path $swapPath -Content "held`n" }
        catch { $swapFailed = $true }
        finally { $elapsed.Stop(); $held.Dispose() }
        Assert $swapFailed 'a swap against a destination held open with no sharing reported success'
        Assert ($elapsed.ElapsedMilliseconds -ge ($script:BookManifestStoreSwapBackoffMs * 2)) 'the swap gave up without retrying'
        Save-BookManifestStoreFile -Path $swapPath -Content "released`n"
        Assert (([IO.File]::ReadAllText($swapPath)).Trim() -ceq 'released') 'the swap failed once and never recovered'

        # --- Rung 7: two collections, one slug, two independent stores -------------------------------
        # The collision the namespace exists to prevent, played out: a shared Book named 'demo' is
        # stored, damaged, and removed, and the Shelf Book of the same name must be untouched by all
        # three. Before rung 7 every one of these assertions would have described the same directory.
        $sharedDemo = [pscustomobject]@{
            schema = 1; slug = 'demo'; title = 'Shared Demo'; summary = 'from the shared collection'
            topics = @(); kind = 'curated'; page_metadata = 'full'; withheld_reason = ''
            page_count = 1; pending_count = $null; reader_map = $null; pages = @(); source_digest = 'deadbeef'
        }
        # The Shelf Book's own state is read FIRST and every cross-collection assertion is made
        # against that reading, so this proves "unchanged" rather than "healthy".
        $shelfBefore = Get-StoredBookManifest -Workspace $fixture -Slug 'demo'
        $sharedSaved = Save-BookManifest -Workspace $fixture -Slug 'demo' -Manifest $sharedDemo -Reason 'selftest shared' -Collection 'shared'
        Assert ($sharedSaved.generation -eq 1) 'a shared Book''s first generation was not 1, so it inherited the Shelf Book''s store'
        $sharedRead = Get-StoredBookManifest -Workspace $fixture -Slug 'demo' -Collection 'shared'
        $shelfAfter = Get-StoredBookManifest -Workspace $fixture -Slug 'demo'
        Assert ($sharedRead.status -ceq 'ok') 'the shared Book''s store did not read ok'
        Assert ([string]$sharedRead.manifest.title -ceq 'Shared Demo') 'the shared Book''s store returned another Book''s manifest'
        Assert (($shelfAfter.status -ceq $shelfBefore.status) -and ($shelfAfter.generation -eq $shelfBefore.generation)) 'storing a shared Book disturbed the Shelf Book of the same slug'
        Assert ([string]$sharedRead.manifest.source_digest -ceq 'deadbeef') 'the shared Book''s stored manifest is not the one that was saved'
        Set-BookManifestDirty -Workspace $fixture -Slug 'demo' -Reason 'selftest cross-collection' -Collection 'shared' | Out-Null
        Assert ((Get-StoredBookManifest -Workspace $fixture -Slug 'demo' -Collection 'shared').status -ceq 'dirty') 'a shared dirty marker did not make the shared Book unavailable'
        Assert ((Get-StoredBookManifest -Workspace $fixture -Slug 'demo').status -ceq $shelfBefore.status) 'a shared dirty marker changed the state of the Shelf Book of the same slug'
        Remove-BookManifestStore -Workspace $fixture -Slug 'demo' -Collection 'shared' | Out-Null
        Assert ((Get-StoredBookManifest -Workspace $fixture -Slug 'demo' -Collection 'shared').status -ceq 'missing') 'the shared store survived its removal'
        Assert ((Get-StoredBookManifest -Workspace $fixture -Slug 'demo').status -ceq $shelfBefore.status) 'removing the shared store changed the Shelf Book''s store'
        Assert (Test-Path -LiteralPath (Get-BookManifestStorePath -Workspace $fixture -Slug 'demo')) 'removing the shared store removed the Shelf Book''s store directory'
    }
    catch {
        # Without this, a strict-mode error inside the body unwinds past every remaining assertion and
        # the suite exits GREEN having run a fraction of itself -- observed once in the sibling
        # transaction suite, which announced "passed (1 checks)". A suite that can do that is worse
        # than no suite.
        [void]$script:failures.Add("the suite did not run to completion: $($_.Exception.Message)")
    }
    finally {
        Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($script:failures.Count) {
        [Console]::Error.WriteLine("BookManifestStore self-test FAILED: $($script:failures -join '; ')")
        exit 1
    }
    Write-Host "BookManifestStore self-test passed ($($script:checks) checks)."
    exit 0
}
