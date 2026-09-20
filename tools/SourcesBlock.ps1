<#
.SYNOPSIS
    The one authority for a compiled article's ## Sources block: the emitter that writes it, the
    parser that reads it back, and the rule that maps a cited path onto the upstream pin it came
    from. Dot-sourced; never invoked directly except with -SelfTest.

.DESCRIPTION
    Book currency anchoring (PLAN-book-currency.md, step 2). Until now the grammar existed once, as
    a string built inline at Compile-RawBatchToNotebook.ps1:164, and was parsed nowhere -- the only
    thing that ever looked at it was an assertion in Test-LibraryHelpers.ps1 checking that the words
    "## Sources" appeared. That was fine while nothing depended on the format. A Currency check
    depends on it entirely, so the format gets an owner before it gets a consumer;
    docs/raw-batch-ownership.md names two authorities on one question as the drift this codebase
    keeps paying for.

    THE FILE LINE IS LIFTED VERBATIM AND MUST STAY THAT WAY. Every article already published --
    fourteen pages of the obsidian-app Book among them -- carries the existing spelling, and those
    pages live in the shared collection where nothing local can rewrite them. A change to this line
    is a change to material that cannot be migrated, so the emitter reproduces it byte for byte and
    the round-trip self-test is what proves it.

    THE PIN LINE IS NEW AND SITS AHEAD OF THE FILE LINES. Discrimination between the two is by the
    literal token `Upstream ` after the leading `- `: a file line always begins with a backtick, so
    no lookahead is needed and no ambiguity is possible. Every interpolated field -- URL, ref AND
    repo root -- passes Test-RecordableField first, because git accepts refs containing backticks
    and semicolons (verified with check-ref-format) and a Windows path may contain either. Guarding
    only the URL would leave two of the three fields able to break the line.

    WHAT THIS FILE REFUSES TO DO IS DECIDE ANYTHING. It reports `not anchored`, `malformed`, or a
    parsed structure. Whether a Book is behind its source is Get-BookCurrency.ps1's question, and
    whether a malformed block should fail anything is the gate's -- and the answer there is no, for
    a reason the plan records: an imported wiki page has no ## Sources at all and is not a defect,
    and a pre-pin article parses perfectly and is simply unanchored.
#>

Set-StrictMode -Version Latest

# Test-RecordableField lives in GitSource.ps1 because ConvertTo-NormalisedUpstreamUrl needs it
# there. It is one rule about what may be interpolated, so it is called rather than restated.
. (Join-Path $PSScriptRoot 'GitSource.ps1')

$script:SourcesHeading = '## Sources'
# A TRAILING ANNOTATION IS PERMITTED, BECAUSE REFUSING ONE DROPPED A CLAIM THAT PARSED PERFECTLY.
# Measured 2026-09-05 across four shared Books: three pages of 2nd-b-vault carry a canonical file
# line closed with ` (both bearer keys redacted at compile time)`, and two of basic-memory's close
# one with `; **partial read** (first 120 of 364 lines)`. Path, hash and provenance are exact in
# every case; only the end-anchor rejected them, and the whole Book then read `cannot verify`
# while a real cited file went unmapped. The annotation must open with a separator -- `;`, `,`, or
# whitespace -- so `provenance: `external`extra`, which is a mangled provenance rather than a note,
# is still a refusal. What the annotation may not do is carry a second claim; see
# Test-SourcesAnnotationInert.
$script:SourcesFilePattern = '^- `(?<path>[^`]+)` - SHA-256 `(?<sha256>[0-9a-f]{64})`; provenance: `(?<provenance>[^`]+)`(?<annotation>[;,]?\s+\S.*)?$'
$script:SourcesUpstreamPattern = '^- Upstream `(?<url>[^`]+)` ref `(?<ref>[^`]+)` at `(?<oid>[0-9a-f]{40}|[0-9a-f]{64})`; repo root `(?<root>[^`]+)`; captured `(?<captured>\d{4}-\d{2}-\d{2})`$'

# The markers a claim carries even when its opening is malformed. Matched ORDINALLY, which is
# load-bearing: basic-memory's `- Self-describing. Hashes above computed with `sha256sum` over the
# pinned clone at` is prose, and a case-insensitive test would read `sha256sum` as a claim marker
# and refuse a real page for saying the word.
$script:SourcesClaimMarkers = @('SHA-256 `', 'provenance: `')

<#
.SYNOPSIS
    Whether one bullet's content is a CLAIM this check can measure, or prose it must skip.

.DESCRIPTION
    Prose inside a ## Sources block is skipped; a claim that does not parse is a refusal. This is
    the one place that decides which a line is, shared by the wrong-bullet path and the canonical
    `- ` path, because two copies of this rule would be two things to keep true.

    OPENING THE WAY A CLAIM OPENS IS NOT ENOUGH ON ITS OWN. The first version of this test asked
    only whether the content began `Upstream ` or with a backtick, which is exactly the shape a
    de-backticked file line does NOT have: `- raw/x/a.md - SHA-256 `...`; provenance: `external``
    opens with a letter and would have been skipped as prose. A dropped FILE line is the dangerous
    one -- the surviving pins then map every path still visible, `fully_mapped` holds, and the
    article reports `current` while a cited source that moved was never looked at. So the markers
    a claim carries anywhere on the line count too.
#>
function Test-SourcesClaimBearing {
    [CmdletBinding()]
    param([string]$Content, [string]$Line)

    if ($Content.StartsWith('Upstream ') -or $Content.StartsWith('`')) { return $true }
    foreach ($marker in $script:SourcesClaimMarkers) {
        if ($Line.IndexOf($marker, [StringComparison]::Ordinal) -ge 0) { return $true }
    }
    $false
}

<#
.SYNOPSIS
    Whether a file line's trailing annotation is inert commentary, or is smuggling a second claim.

.DESCRIPTION
    Relaxing the end-anchor means everything after a well-formed file line is ignored, and the one
    way that loses information is two claims written on one line: the second would be swallowed
    whole and never counted. An annotation carrying a claim marker is therefore a refusal, not a
    note -- the same conservative direction the rest of this grammar takes.
#>
function Test-SourcesAnnotationInert {
    [CmdletBinding()]
    param([string]$Annotation)

    if ([string]::IsNullOrEmpty($Annotation)) { return $true }
    foreach ($marker in $script:SourcesClaimMarkers) {
        if ($Annotation.IndexOf($marker, [StringComparison]::Ordinal) -ge 0) { return $false }
    }
    if ($Annotation.IndexOf('Upstream `', [StringComparison]::Ordinal) -ge 0) { return $false }
    $true
}

# --- Emitting --------------------------------------------------------------------------------------

function Format-SourcesFileLine {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Sha256,
        [Parameter(Mandatory = $true)][string]$Provenance
    )

    foreach ($field in @($Path, $Provenance)) {
        if (-not (Test-RecordableField $field)) { throw "A source field cannot be recorded in a ## Sources line: '$field'." }
    }
    if ($Sha256 -cnotmatch '^[0-9a-f]{64}$') { throw "A source hash must be 64 lowercase hex characters: '$Sha256'." }
    "- ``$Path`` - SHA-256 ``$Sha256``; provenance: ``$Provenance``"
}

function Format-SourcesUpstreamLine {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Ref,
        [Parameter(Mandatory = $true)][string]$CommitOid,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$Captured
    )

    foreach ($field in @($Url, $Ref, $RepoRoot)) {
        if (-not (Test-RecordableField $field)) { throw "An upstream field cannot be recorded in a ## Sources line: '$field'." }
    }
    if ($Ref -cnotmatch '^refs/[^ ]+$') { throw "An upstream ref must be a full refs/... name: '$Ref'." }
    # 40 for SHA-1, 64 for SHA-256. Never parsed semantically -- only compared -- so a SHA-256
    # repository is anchorable rather than permanently malformed.
    if ($CommitOid -cnotmatch '^([0-9a-f]{40}|[0-9a-f]{64})$') { throw "An upstream commit must be a full lowercase OID: '$CommitOid'." }
    if ($Captured -cnotmatch '^\d{4}-\d{2}-\d{2}$') { throw "An upstream capture date must be yyyy-MM-dd: '$Captured'." }
    "- Upstream ``$Url`` ref ``$Ref`` at ``$CommitOid``; repo root ``$RepoRoot``; captured ``$Captured``"
}

<#
.SYNOPSIS
    Compose the whole ## Sources section: pins first, then file lines, in the order given.
#>
function Format-SourcesBlock {
    [CmdletBinding()]
    param([object[]]$Upstream, [object[]]$File)

    $lines = [Collections.Generic.List[string]]::new()
    foreach ($pin in @($Upstream)) {
        [void]$lines.Add((Format-SourcesUpstreamLine -Url $pin.url -Ref $pin.ref -CommitOid $pin.commit_oid -RepoRoot $pin.repo_root -Captured $pin.captured))
    }
    foreach ($source in @($File)) {
        [void]$lines.Add((Format-SourcesFileLine -Path $source.path -Sha256 $source.sha256 -Provenance $source.provenance))
    }
    if (-not $lines.Count) { throw 'A ## Sources block needs at least one source line.' }
    "$script:SourcesHeading`n`n" + ($lines -join "`n") + "`n"
}

# --- Parsing ---------------------------------------------------------------------------------------

<#
.SYNOPSIS
    Read one article's ## Sources block. Returns the parsed pins and file lines, or the reason the
    block is malformed. Never throws on article content -- an article is data, and a bad one is a
    reported state rather than an exception.

.DESCRIPTION
    States this distinguishes, because the plan's branch ordering depends on all of them being
    separable: no block at all (an imported wiki page, not a defect); a block with file lines and no
    pin (a pre-pin article, `not anchored`); two ## Sources headings; a line inside the block that
    parses as neither kind; two pins that disagree about one repo root. Byte-identical duplicate
    pins are collapsed rather than refused, because a Book may legitimately cite one upstream twice.
#>
function Read-SourcesBlock {
    [CmdletBinding()]
    param([string]$Text)

    $result = [ordered]@{ has_block = $false; ok = $false; reason = ''; upstreams = @(); files = @() }
    if ([string]::IsNullOrEmpty($Text)) { $result.reason = 'the article is empty'; return [pscustomobject]$result }

    $lines = @($Text -split "`r?`n")
    $headings = @(0..($lines.Count - 1) | Where-Object { $lines[$_].TrimEnd() -ceq $script:SourcesHeading })
    if (-not $headings.Count) { return [pscustomobject]$result }
    $result.has_block = $true
    if ($headings.Count -gt 1) { $result.reason = "the article carries $($headings.Count) ## Sources headings"; return [pscustomobject]$result }

    $upstreams = [Collections.Generic.List[object]]::new()
    $files = [Collections.Generic.List[object]]::new()
    $seenPins = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)

    # A fence or an HTML comment inside the block is INERT, and skipping it is what made tracking it
    # necessary. While every non-bullet line was a refusal, a fence could never be reached: the
    # ``` line was itself unparseable and condemned the whole article, so no line inside one was
    # ever accepted. Skipping prose lifted that, and a `- Upstream ...` written inside a fence or a
    # comment -- which Markdown renders as sample text, not as a claim -- would otherwise be read as
    # a live pin and could carry a Book to `current` on the strength of an example.
    $inFence = $false
    $fenceMarker = ''
    $inComment = $false

    for ($index = $headings[0] + 1; $index -lt $lines.Count; $index++) {
        # A trailing \r is stripped by the split; trimming the END only, so a line indented into a
        # code block is not silently promoted into the manifest.
        $line = $lines[$index].TrimEnd()
        $bare = $line.TrimStart()

        if ($inComment) {
            if ($bare.Contains('-->')) { $inComment = $false }
            continue
        }
        if ($inFence) {
            if ($bare.StartsWith($fenceMarker)) { $inFence = $false; $fenceMarker = '' }
            continue
        }
        if ($bare.StartsWith('```') -or $bare.StartsWith('~~~')) {
            $inFence = $true
            $fenceMarker = $bare.Substring(0, 3)
            continue
        }
        # An opener that also closes on the same line encloses nothing.
        if ($bare.StartsWith('<!--')) {
            if (-not $bare.Contains('-->')) { $inComment = $true }
            continue
        }

        if ($line.Length -eq 0) { continue }
        if ($line.StartsWith('## ')) { break }
        # PROSE INSIDE THE BLOCK IS SKIPPED, AND THAT IS A CORRECTION MADE AGAINST REAL DATA. The
        # first version refused any line here that was not a bullet, which is right for a block this
        # file generated and wrong for the ones already published: obsidian-app's
        # pika-publish-plugin page opens its ## Sources with a hand-written paragraph naming the
        # clone commit and what came from the GitHub API instead. One such page made the whole
        # article `cannot verify / malformed anchor`, and at the collection tier one such article
        # made the whole BOOK unverifiable -- a false alarm on 1 of 14 real pages.
        #
        # Every CLAIM-BEARING line stays strict. A line that begins with `- ` must still parse as a
        # file line or an Upstream line or the article is malformed, so a corrupted hash or a mangled
        # pin is caught exactly as before. A prose line carries no claim this check can measure, and
        # the failure it could hide -- a pin that lost its leading bullet -- surfaces as
        # `not anchored`, which is absence rather than false currency.
        #
        # A CLAIM WEARING THE WRONG BULLET IS A REFUSAL, NOT A SKIP. `* `, `+ ` and an indented
        # `- ` are all bullets to Markdown and none of them is the canonical form, so each would
        # fall through the skip above. That is the one shape where skipping is not safe: a file
        # line silently dropped leaves the remaining pins mapping every cited path they can see,
        # and `fully_mapped` then reports `current` for an article whose other source moved. Prose
        # stays skipped -- it carries no claim this check can measure -- but a bullet whose content
        # opens the way a claim opens must parse as one.
        if (-not $line.StartsWith('- ')) {
            $smuggled = [regex]::Match($line, '^\s*(?:-|\*|\+)\s+(?<content>.*)$')
            if ($smuggled.Success -and (Test-SourcesClaimBearing $smuggled.Groups['content'].Value $line)) {
                $result.reason = "a source line is not written as a top-level '- ' bullet, so its claim would be skipped: $line"
                return [pscustomobject]$result
            }
            continue
        }

        if ($line.StartsWith('- Upstream ')) {
            $match = [regex]::Match($line, $script:SourcesUpstreamPattern)
            if (-not $match.Success) { $result.reason = "an Upstream line does not parse: $line"; return [pscustomobject]$result }
            $root = $match.Groups['root'].Value
            $signature = "$($match.Groups['url'].Value)|$($match.Groups['ref'].Value)|$($match.Groups['oid'].Value)"
            if ($seenPins.ContainsKey($root)) {
                if ($seenPins[$root] -cne $signature) {
                    $result.reason = "two Upstream lines disagree about repo root '$root'"
                    return [pscustomobject]$result
                }
                continue
            }
            $seenPins[$root] = $signature
            [void]$upstreams.Add([pscustomobject]@{
                url        = $match.Groups['url'].Value
                ref        = $match.Groups['ref'].Value
                commit_oid = $match.Groups['oid'].Value
                repo_root  = $root
                captured   = $match.Groups['captured'].Value
            })
            continue
        }

        $fileMatch = [regex]::Match($line, $script:SourcesFilePattern)
        if (-not $fileMatch.Success) {
            # PROSE ON A CANONICAL BULLET IS SKIPPED TOO, AND THE ASYMMETRY THAT PRECEDED THIS HAD
            # NO READER-FACING JUSTIFICATION: `* Repository pinned at ...` was decoration while
            # `- Repository pinned at ...` condemned the article. Measured 2026-09-05, thirteen
            # pages across three shared Books carry exactly the latter -- provenance notes a person
            # wrote before this grammar existed (`- Repository pinned at commit `...``,
            # `- Web (2026-07): [links]`, `- Live deployment probed ...`) -- and each one cost its
            # whole Book its currency answer. None of them names a URL or a ref, so none could ever
            # have been measured; refusing them bought nothing and hid the other fifteen Books'
            # honest answers behind four `cannot verify` rows.
            #
            # A CLAIM STAYS STRICT. Test-SourcesClaimBearing is what separates the two, and it looks
            # for a claim's markers anywhere on the line rather than only at its opening -- so a
            # corrupted hash, a mangled pin, and a file line that lost its leading backtick are all
            # still refusals, exactly as before.
            if (Test-SourcesClaimBearing ($line.Substring(2)) $line) {
                $result.reason = "a source line does not parse: $line"
                return [pscustomobject]$result
            }
            continue
        }
        if (-not (Test-SourcesAnnotationInert $fileMatch.Groups['annotation'].Value)) {
            $result.reason = "a source line's trailing note carries a second claim, which would be swallowed: $line"
            return [pscustomobject]$result
        }
        [void]$files.Add([pscustomobject]@{
            path       = $fileMatch.Groups['path'].Value
            sha256     = $fileMatch.Groups['sha256'].Value
            provenance = $fileMatch.Groups['provenance'].Value
        })
    }

    if (-not $files.Count) {
        # A PIN WITH NOTHING TO MAP IS STILL MALFORMED. The pin's whole use is deciding which
        # upstream a cited path belongs to, so an upstream recorded beside no cited file is a
        # half-written block rather than a page that cites nothing.
        if (@($upstreams).Count) {
            $result.reason = 'the ## Sources block records an upstream but cites no source file for it to map'
            return [pscustomobject]$result
        }
        # NO PIN AND NO CITED FILE MEANS THIS IS NOT A COMPILED ARTICLE, and reporting it malformed
        # was the same mistake in a different place. An imported wiki page may carry a `## Sources`
        # heading written entirely by hand -- library-development-design-history's five
        # ai-library-port pages cite web links and an Odysseus source tree in prose, and were
        # written years before this grammar -- and a page with no block at all is already treated
        # as readable-and-anchorless. The heading alone must not make it a defect.
        $result.ok = $true
        return [pscustomobject]$result
    }
    $result.ok = $true
    $result.upstreams = @($upstreams)
    $result.files = @($files)
    [pscustomobject]$result
}

# --- Mapping cited paths onto pins -------------------------------------------------------------------

<#
.SYNOPSIS
    Decide which pin each cited file belongs to, and say plainly which files belong to none.

.DESCRIPTION
    LONGEST ROOT WINS, and that rule is here rather than at the call site because nested
    repositories make it ambiguous otherwise -- one cited path can sit under both `raw/batch` and
    `raw/batch/vendor/thing` if both are recorded.

    UNMAPPED FILES ARE REPORTED, NEVER IGNORED. An article mixing a git batch with a converted wiki
    export has file lines belonging to no pin at all. Treating "at least one path mapped" as good
    enough would let such an article report `current` on the strength of the half that is anchored,
    which is the quiet wrong answer this whole feature exists to avoid.
#>
function Resolve-SourcePinMapping {
    [CmdletBinding()]
    param([object[]]$Upstream, [object[]]$File)

    $roots = @(@($Upstream) | ForEach-Object {
        [pscustomobject]@{
            pin      = $_
            prefix   = ($_.repo_root -replace '\\', '/').TrimEnd('/')
        }
    } | Sort-Object -Property @{ Expression = { $_.prefix.Length }; Descending = $true })

    $mapped = [Collections.Generic.List[object]]::new()
    $unmapped = [Collections.Generic.List[string]]::new()
    foreach ($source in @($File)) {
        $path = ($source.path -replace '\\', '/').TrimEnd('/')
        $hit = $null
        foreach ($candidate in $roots) {
            if ($path.StartsWith($candidate.prefix + '/', [StringComparison]::OrdinalIgnoreCase)) { $hit = $candidate; break }
        }
        if ($null -eq $hit) { [void]$unmapped.Add($source.path); continue }
        [void]$mapped.Add([pscustomobject]@{
            source        = $source
            pin           = $hit.pin
            repo_relative = $path.Substring($hit.prefix.Length + 1)
        })
    }

    [pscustomobject]@{
        mapped        = @($mapped)
        unmapped      = @($unmapped)
        fully_mapped  = ((@($unmapped).Count -eq 0) -and (@($File).Count -gt 0))
    }
}

# --- The Discovery manifest roll-up ------------------------------------------------------------------

<#
.SYNOPSIS
    The three fields a Discovery manifest carries per recorded upstream, and nothing else.

.DESCRIPTION
    ADR-0011. `repo root` and `captured` are deliberately absent. The root is producer-local -- it
    names a directory on the machine that compiled the article -- and the collection tier has no
    cited paths to map onto it, so carrying it would put page-derived data into a closed-readable
    place for no consumer at all. The capture date is likewise the article's business.
#>
$script:ManifestAnchorKeys = @('url', 'ref', 'commit_oid')

# The manifest body schema at which the upstream roll-up began (ADR-0011). A stored body is a file
# whose writer's version is unknown, so the schema is checked rather than inferred from the field's
# presence: schema 1 never scanned a Book for anchors, and reading a schema-1 body that happens to
# carry the field as "this Book records no upstream" would be a positive claim with nothing behind it.
$script:ManifestAnchorMinSchema = 2

<#
.SYNOPSIS
    Validate one stored (url, ref, commit_oid) tuple. Returns the sanitized values, or the reason
    it was refused. Used at generation to decide what may be written, and at read to decide what
    may be trusted -- the same rule both ways, because a manifest is a file on disk and the reader
    of one has no way to know which version wrote it.
#>
function Test-AnchorTuple {
    [CmdletBinding()]
    param([object]$Tuple)

    $refusal = { param($Reason) [pscustomobject]@{ ok = $false; reason = $Reason; url = ''; ref = ''; commit_oid = '' } }
    if ($null -eq $Tuple) { return (& $refusal 'an anchor entry is empty') }

    # Enumerate the property names rather than indexing: a JSON scalar where an object was expected
    # has no properties at all, and reading one under Set-StrictMode throws instead of answering.
    $names = @($Tuple.PSObject.Properties | ForEach-Object { $_.Name })
    if (-not $names.Count) { return (& $refusal 'an anchor entry is not an object') }
    $missing = @($script:ManifestAnchorKeys | Where-Object { $names -cnotcontains $_ })
    if ($missing.Count) { return (& $refusal "an anchor entry is missing $($missing -join ', ')") }
    $extra = @($names | Where-Object { $script:ManifestAnchorKeys -cnotcontains $_ })
    if ($extra.Count) { return (& $refusal "an anchor entry carries unexpected field(s): $($extra -join ', ')") }

    $normalised = ConvertTo-NormalisedUpstreamUrl ([string]$Tuple.url)
    if (-not $normalised.ok) { return (& $refusal "an anchor URL was refused: $($normalised.reason)") }
    $ref = [string]$Tuple.ref
    if (-not (Test-RecordableField $ref) -or $ref -cnotmatch '^refs/[^ ]+$') { return (& $refusal "an anchor ref is not a recordable full refs/... name: '$ref'") }
    $oid = [string]$Tuple.commit_oid
    if ($oid -cnotmatch '^([0-9a-f]{40}|[0-9a-f]{64})$') { return (& $refusal "an anchor commit is not a full lowercase OID: '$oid'") }

    [pscustomobject]@{ ok = $true; reason = ''; url = $normalised.url; ref = $ref; commit_oid = $oid }
}

<#
.SYNOPSIS
    The sanitized upstream tuples one article records, for the manifest roll-up. Reports whether the
    article's anchor data was READABLE, separately from whether it holds any.

.DESCRIPTION
    Three outcomes, and the collection tier needs all three separable. An article with no ## Sources
    block at all is readable and anchorless -- an imported wiki page, not a defect. A pre-pin
    compiled article is readable and anchorless too. A block that does not parse, or a pin that
    fails the grammar, is UNREADABLE: it contributes no tuple, and the Book it belongs to must not
    then be reported `current` on the strength of its other articles. Silently dropping it is the
    quiet wrong answer this whole feature exists to avoid.
#>
function Get-ArticleAnchors {
    [CmdletBinding()]
    param([string]$Text)

    $parsed = Read-SourcesBlock -Text $Text
    if (-not $parsed.has_block) { return [pscustomobject]@{ readable = $true; upstreams = @() } }
    if (-not $parsed.ok) { return [pscustomobject]@{ readable = $false; upstreams = @() } }

    $readable = $true
    $upstreams = [Collections.Generic.List[object]]::new()
    foreach ($pin in @($parsed.upstreams)) {
        $tuple = Test-AnchorTuple ([pscustomobject]@{ url = $pin.url; ref = $pin.ref; commit_oid = $pin.commit_oid })
        if (-not $tuple.ok) { $readable = $false; continue }
        [void]$upstreams.Add([pscustomobject][ordered]@{ url = $tuple.url; ref = $tuple.ref; commit_oid = $tuple.commit_oid })
    }
    [pscustomobject]@{ readable = $readable; upstreams = @($upstreams) }
}

<#
.SYNOPSIS
    Collapse a set of anchor tuples to the distinct ones, in first-seen order.
#>
function Select-DistinctAnchor {
    [CmdletBinding()]
    param([object[]]$Anchor)

    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $distinct = [Collections.Generic.List[object]]::new()
    foreach ($entry in @($Anchor)) {
        if ($null -eq $entry) { continue }
        $key = "$($entry.url)|$($entry.ref)|$($entry.commit_oid)"
        if (-not $seen.Add($key)) { continue }
        [void]$distinct.Add([pscustomobject][ordered]@{ url = [string]$entry.url; ref = [string]$entry.ref; commit_oid = [string]$entry.commit_oid })
    }
    @($distinct)
}

<#
.SYNOPSIS
    Read a stored manifest's `anchored_upstreams` field strictly. Never throws: a manifest is a file
    a consumer found on disk, and a bad one is a reported state rather than an exception.

.DESCRIPTION
    An ABSENT field and an EMPTY array are different answers and the caller is given both, because
    the collection tier's state machine separates `manifest lacks anchor data` (a schema-1 manifest,
    written before the roll-up existed) from `not anchored` (a current manifest that scanned the
    Book and found no pin). Collapsing the two would report a Book as having been checked when it
    never was.
#>
function Read-ManifestAnchors {
    [CmdletBinding()]
    param([object]$Manifest)

    $result = [ordered]@{ present = $false; ok = $false; reason = ''; upstreams = @(); unreadable = 0 }
    if ($null -eq $Manifest) { $result.reason = 'the manifest is empty'; return [pscustomobject]$result }
    $names = @($Manifest.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -cnotcontains 'anchored_upstreams') { return [pscustomobject]$result }

    # The field's presence is not the same as the schema that promises it. A body that predates the
    # roll-up reads as `lacks anchor data` -- a repairable absence -- and never as `not anchored`,
    # which is a positive claim about what the Book records.
    $schema = 0
    if ($names -ccontains 'schema') { [void][int]::TryParse([string]$Manifest.schema, [ref]$schema) }
    if ($schema -lt $script:ManifestAnchorMinSchema) { return [pscustomobject]$result }
    $result.present = $true

    # anchor_unreadable rides with the roll-up: New-BookManifestFromPages writes both fields or
    # neither, so a body carrying one without a usable other is malformed rather than complete. It
    # is validated HERE, at the boundary, because a consumer that defaults a missing or unparseable
    # count to zero converts "some pages could not be read" into "every page was readable" -- an
    # absence reaching `current` by the shortest possible route.
    if ($names -cnotcontains 'anchor_unreadable') {
        $result.reason = 'anchor_unreadable is absent, so the roll-up cannot say every page was readable'
        return [pscustomobject]$result
    }
    $unreadableCount = 0
    if (-not [int]::TryParse([string]$Manifest.anchor_unreadable, [ref]$unreadableCount) -or $unreadableCount -lt 0) {
        $result.reason = "anchor_unreadable is not a count: $($Manifest.anchor_unreadable)"
        return [pscustomobject]$result
    }
    $result.unreadable = $unreadableCount

    $value = $Manifest.anchored_upstreams
    # $null is the JSON `null`, which is not an empty array: it is a field written wrong.
    if ($null -eq $value) { $result.reason = 'anchored_upstreams is null rather than an array'; return [pscustomobject]$result }
    if ($value -is [string] -or $value -is [ValueType]) { $result.reason = 'anchored_upstreams is not an array'; return [pscustomobject]$result }

    $tuples = [Collections.Generic.List[object]]::new()
    foreach ($entry in @($value)) {
        $tuple = Test-AnchorTuple $entry
        if (-not $tuple.ok) { $result.reason = $tuple.reason; return [pscustomobject]$result }
        [void]$tuples.Add([pscustomobject][ordered]@{ url = $tuple.url; ref = $tuple.ref; commit_oid = $tuple.commit_oid })
    }
    $result.ok = $true
    $result.upstreams = @(Select-DistinctAnchor $tuples)
    [pscustomobject]$result
}

# --- Self-test -------------------------------------------------------------------------------------
# Gate check: sources-block.selftest. The round trip is the point: parse(emit(x)) == x, over the
# malformed shapes as well as the good ones, because the malformed states are what the Currency
# check's branch ordering depends on being separable.
if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') {
    $script:failures = [Collections.Generic.List[string]]::new()
    $script:checks = 0
    function Assert([bool]$Condition, [string]$Message) {
        $script:checks++
        if (-not $Condition) { [void]$script:failures.Add($Message) }
    }

    try {
        $hashA = 'a' * 64
        $hashB = 'b' * 64
        $oid40 = '0123456789abcdef0123456789abcdef01234567'
        $oid64 = 'c' * 64

        # --- The file line is lifted verbatim. This is the assertion that stops a well-meaning
        # tidy-up from silently orphaning every page already in the shared collection.
        $legacy = Format-SourcesFileLine -Path 'raw/obsidian-help/en/bases.md' -Sha256 $hashA -Provenance 'external'
        Assert ($legacy -ceq "- ``raw/obsidian-help/en/bases.md`` - SHA-256 ``$hashA``; provenance: ``external``") `
            "the file line spelling changed: $legacy"

        # --- Round trips.
        $pins = @(
            [pscustomobject]@{ url = 'https://github.com/obsidianmd/obsidian-help'; ref = 'refs/heads/master'; commit_oid = $oid40; repo_root = 'raw/obsidian-help'; captured = '2026-09-04' }
            [pscustomobject]@{ url = 'https://github.com/otaviocc/obsidian-pika'; ref = 'refs/heads/main'; commit_oid = $oid64; repo_root = 'raw/obsidian-pika/batch1/repo'; captured = '2026-09-04' }
        )
        $sources = @(
            [pscustomobject]@{ path = 'raw/obsidian-help/en/bases.md'; sha256 = $hashA; provenance = 'external' }
            [pscustomobject]@{ path = 'raw/obsidian-pika/batch1/repo/src/main.ts'; sha256 = $hashB; provenance = 'external' }
        )
        $block = Format-SourcesBlock -Upstream $pins -File $sources
        $article = "# An article`n`nBody.`n`n## Key Takeaways`n`n- One.`n`n$block"
        $parsed = Read-SourcesBlock -Text $article
        Assert ($parsed.has_block -and $parsed.ok) "a generated block did not parse back: $($parsed.reason)"
        Assert (@($parsed.upstreams).Count -eq 2) "expected 2 pins, parsed $(@($parsed.upstreams).Count)"
        Assert (@($parsed.files).Count -eq 2) "expected 2 file lines, parsed $(@($parsed.files).Count)"
        for ($i = 0; $i -lt 2; $i++) {
            Assert ($parsed.upstreams[$i].url -ceq $pins[$i].url) 'a round-tripped pin URL differs'
            Assert ($parsed.upstreams[$i].ref -ceq $pins[$i].ref) 'a round-tripped pin ref differs'
            Assert ($parsed.upstreams[$i].commit_oid -ceq $pins[$i].commit_oid) 'a round-tripped pin OID differs'
            Assert ($parsed.upstreams[$i].repo_root -ceq $pins[$i].repo_root) 'a round-tripped repo root differs'
            Assert ($parsed.upstreams[$i].captured -ceq $pins[$i].captured) 'a round-tripped capture date differs'
            Assert ($parsed.files[$i].path -ceq $sources[$i].path) 'a round-tripped source path differs'
            Assert ($parsed.files[$i].sha256 -ceq $sources[$i].sha256) 'a round-tripped source hash differs'
            Assert ($parsed.files[$i].provenance -ceq $sources[$i].provenance) 'a round-tripped provenance differs'
        }
        # Re-emitting the parsed structure must reproduce the same text byte for byte.
        Assert ((Format-SourcesBlock -Upstream $parsed.upstreams -File $parsed.files) -ceq $block) 'emit(parse(emit(x))) did not reproduce the block'

        # Zero upstreams: the pre-pin shape every existing article has.
        $legacyBlock = Format-SourcesBlock -Upstream @() -File $sources
        $legacyParsed = Read-SourcesBlock -Text "# A`n`n## Key Takeaways`n`n- x`n`n$legacyBlock"
        Assert ($legacyParsed.ok) "a pre-pin block did not parse: $($legacyParsed.reason)"
        Assert (@($legacyParsed.upstreams).Count -eq 0) 'a pre-pin block reported pins'
        Assert (@($legacyParsed.files).Count -eq 2) 'a pre-pin block lost file lines'

        # A path containing spaces, which raw/ genuinely has ("Fallout 4 Modding").
        $spaced = Format-SourcesBlock -Upstream @() -File @([pscustomobject]@{ path = 'raw/Fallout 4 Modding/notes/a b.md'; sha256 = $hashA; provenance = 'external' })
        $spacedParsed = Read-SourcesBlock -Text "# A`n`n$spaced"
        Assert ($spacedParsed.ok -and $spacedParsed.files[0].path -ceq 'raw/Fallout 4 Modding/notes/a b.md') 'a path containing spaces did not round-trip'

        # A 64-character OID must be accepted, so a SHA-256 repository is anchorable.
        Assert ($parsed.upstreams[1].commit_oid.Length -eq 64) 'a SHA-256 OID was not preserved'

        # --- No block at all is not a defect. An imported wiki page reaches this every time.
        $none = Read-SourcesBlock -Text "# Imported page`n`nSome prose with no provenance.`n"
        Assert (-not $none.has_block) 'a page with no ## Sources was reported as having one'
        Assert (-not $none.ok) 'a page with no ## Sources was reported ok'
        Assert ([string]::IsNullOrEmpty($none.reason)) 'a page with no ## Sources was given a failure reason'

        # --- Malformed states, each separable.
        $two = Read-SourcesBlock -Text "# A`n`n## Sources`n`n- ``x`` - SHA-256 ``$hashA``; provenance: ``external```n`n## Sources`n`n- ``y`` - SHA-256 ``$hashB``; provenance: ``external``"
        Assert ((-not $two.ok) -and $two.reason -match '2 ## Sources headings') "two headings were not caught: $($two.reason)"

        # An unparseable line that CARRIES A CLAIM is still a refusal. It has to be written as one:
        # `- this is not a source line` is prose, and prose is skipped -- so the case this asserts
        # needs a claim marker on it, which is what a real corruption has.
        $garbage = Read-SourcesBlock -Text "# A`n`n## Sources`n`n- ``x`` - SHA-256 ``not-a-hash``; provenance: ``external```n"
        Assert ((-not $garbage.ok) -and $garbage.reason -match 'does not parse') "an unparseable file line was accepted: $($garbage.reason)"

        # Prose inside the block is decoration, not a claim. obsidian-app's pika-publish-plugin page
        # opens its ## Sources with a paragraph naming the clone commit; refusing that made a real
        # published article read as malformed.
        $prose = Read-SourcesBlock -Text ("# A`n`n## Sources`n`n" +
            "Repository clone at commit ``3f4c7cbf3607d762d918f40d402a7a7297d84ce8`` (2026-05-26), read`n" +
            "2026-09-04. Star counts came from the GitHub API and are not in the clone.`n`n" +
            "- ``raw/b/x`` - SHA-256 ``$hashA``; provenance: ``external``")
        Assert ($prose.ok -and @($prose.files).Count -eq 1) "a hand-written note inside ## Sources made a real article malformed: $($prose.reason)"
        # But a bullet that CARRIES a claim must still parse, prose in the block or not. A file line
        # that lost its leading backtick is the dangerous shape: skipping it would drop a cited path
        # while the surviving pins still mapped everything visible.
        $proseThenBadBullet = Read-SourcesBlock -Text ("# A`n`n## Sources`n`nA note.`n`n- raw/b/x - SHA-256 ``$hashA``; provenance: ``external```n")
        Assert (-not $proseThenBadBullet.ok) 'a malformed bullet was excused because prose was allowed'

        $badPin = Read-SourcesBlock -Text "# A`n`n## Sources`n`n- Upstream ``https://github.com/a/b`` at ``$oid40```n- ``x`` - SHA-256 ``$hashA``; provenance: ``external``"
        Assert ((-not $badPin.ok) -and $badPin.reason -match 'Upstream line does not parse') "a pin missing its ref was accepted: $($badPin.reason)"

        $shortOid = Read-SourcesBlock -Text "# A`n`n## Sources`n`n- Upstream ``https://github.com/a/b`` ref ``refs/heads/main`` at ``0123abc``; repo root ``raw/b``; captured ``2026-09-04```n- ``raw/b/x`` - SHA-256 ``$hashA``; provenance: ``external``"
        Assert (-not $shortOid.ok) 'an abbreviated OID was accepted, but a bare-commit fetch needs the full one'

        $conflict = Read-SourcesBlock -Text ("# A`n`n## Sources`n`n" +
            "- Upstream ``https://github.com/a/b`` ref ``refs/heads/main`` at ``$oid40``; repo root ``raw/b``; captured ``2026-09-04```n" +
            "- Upstream ``https://github.com/a/c`` ref ``refs/heads/main`` at ``$oid40``; repo root ``raw/b``; captured ``2026-09-04```n" +
            "- ``raw/b/x`` - SHA-256 ``$hashA``; provenance: ``external``")
        Assert ((-not $conflict.ok) -and $conflict.reason -match 'disagree about repo root') "conflicting pins for one root were accepted: $($conflict.reason)"

        $duplicate = Read-SourcesBlock -Text ("# A`n`n## Sources`n`n" +
            "- Upstream ``https://github.com/a/b`` ref ``refs/heads/main`` at ``$oid40``; repo root ``raw/b``; captured ``2026-09-04```n" +
            "- Upstream ``https://github.com/a/b`` ref ``refs/heads/main`` at ``$oid40``; repo root ``raw/b``; captured ``2026-09-04```n" +
            "- ``raw/b/x`` - SHA-256 ``$hashA``; provenance: ``external``")
        Assert ($duplicate.ok -and @($duplicate.upstreams).Count -eq 1) 'a byte-identical duplicate pin was not collapsed'

        $noFiles = Read-SourcesBlock -Text "# A`n`n## Sources`n`n- Upstream ``https://github.com/a/b`` ref ``refs/heads/main`` at ``$oid40``; repo root ``raw/b``; captured ``2026-09-04``"
        Assert (-not $noFiles.ok) 'a block citing no source files was accepted'

        # The block stops at the next heading rather than eating the rest of the document.
        $bounded = Read-SourcesBlock -Text "# A`n`n## Sources`n`n- ``raw/b/x`` - SHA-256 ``$hashA``; provenance: ``external```n`n## Notes`n`n- not a source`n"
        Assert ($bounded.ok -and @($bounded.files).Count -eq 1) "the block did not stop at the next heading: $($bounded.reason)"

        # --- The emitter refuses a field that would break the line, on all three fields.
        foreach ($case in @(
            @{ field = 'url';  value = 'https://github.com/a/b`c' }
            @{ field = 'ref';  value = 'refs/heads/foo`bar' }
            @{ field = 'ref';  value = 'refs/heads/foo;bar' }
            @{ field = 'root'; value = 'raw/ba`tch' }
        )) {
            $threw = $false
            try {
                Format-SourcesUpstreamLine `
                    -Url  $(if ($case.field -eq 'url')  { $case.value } else { 'https://github.com/a/b' }) `
                    -Ref  $(if ($case.field -eq 'ref')  { $case.value } else { 'refs/heads/main' }) `
                    -CommitOid $oid40 `
                    -RepoRoot $(if ($case.field -eq 'root') { $case.value } else { 'raw/b' }) `
                    -Captured '2026-09-04' | Out-Null
            }
            catch { $threw = $true }
            Assert $threw "the emitter accepted an unrecordable $($case.field): $($case.value)"
        }
        foreach ($bad in @(
            @{ ref = 'main';               why = 'a short ref name' }
            @{ oid = '0123abc';            why = 'an abbreviated OID' }
            @{ captured = '4 Sept 2026';   why = 'a non-ISO capture date' }
        )) {
            $threw = $false
            try {
                Format-SourcesUpstreamLine -Url 'https://github.com/a/b' `
                    -Ref $(if ($bad.ContainsKey('ref')) { $bad.ref } else { 'refs/heads/main' }) `
                    -CommitOid $(if ($bad.ContainsKey('oid')) { $bad.oid } else { $oid40 }) `
                    -RepoRoot 'raw/b' `
                    -Captured $(if ($bad.ContainsKey('captured')) { $bad.captured } else { '2026-09-04' }) | Out-Null
            }
            catch { $threw = $true }
            Assert $threw "the emitter accepted $($bad.why)"
        }
        $threwHash = $false
        try { Format-SourcesFileLine -Path 'raw/b/x' -Sha256 'ABCDEF' -Provenance 'external' | Out-Null } catch { $threwHash = $true }
        Assert $threwHash 'the emitter accepted a malformed source hash'

        # --- Mapping. Longest root wins, and unmapped files are named rather than ignored.
        $nested = @(
            [pscustomobject]@{ url = 'https://github.com/a/outer'; ref = 'refs/heads/main'; commit_oid = $oid40; repo_root = 'raw/b'; captured = '2026-09-04' }
            [pscustomobject]@{ url = 'https://github.com/a/inner'; ref = 'refs/heads/main'; commit_oid = $oid64; repo_root = 'raw/b/vendor/thing'; captured = '2026-09-04' }
        )
        $mapping = Resolve-SourcePinMapping -Upstream $nested -File @(
            [pscustomobject]@{ path = 'raw/b/docs/a.md'; sha256 = $hashA; provenance = 'external' }
            [pscustomobject]@{ path = 'raw/b/vendor/thing/src/x.ts'; sha256 = $hashB; provenance = 'external' }
        )
        Assert ($mapping.fully_mapped) 'a fully mappable article reported unmapped files'
        Assert ($mapping.mapped[0].pin.url -ceq 'https://github.com/a/outer') 'the outer file mapped to the wrong pin'
        Assert ($mapping.mapped[1].pin.url -ceq 'https://github.com/a/inner') 'longest root did not win for a nested repository'
        Assert ($mapping.mapped[1].repo_relative -ceq 'src/x.ts') "the repo-relative path was wrong: $($mapping.mapped[1].repo_relative)"
        Assert ($mapping.mapped[0].repo_relative -ceq 'docs/a.md') "the repo-relative path was wrong: $($mapping.mapped[0].repo_relative)"

        $mixed = Resolve-SourcePinMapping -Upstream @($nested[0]) -File @(
            [pscustomobject]@{ path = 'raw/b/docs/a.md'; sha256 = $hashA; provenance = 'external' }
            [pscustomobject]@{ path = 'raw/converted-wiki/page.md'; sha256 = $hashB; provenance = 'external' }
        )
        Assert (-not $mixed.fully_mapped) 'an article mixing a pinned batch with an unpinned one reported fully mapped'
        Assert (@($mixed.unmapped).Count -eq 1 -and $mixed.unmapped[0] -ceq 'raw/converted-wiki/page.md') 'the unmapped file was not named'
        Assert (@($mixed.mapped).Count -eq 1) 'the mapped half was lost'

        $unpinned = Resolve-SourcePinMapping -Upstream @() -File @([pscustomobject]@{ path = 'raw/b/docs/a.md'; sha256 = $hashA; provenance = 'external' })
        Assert (-not $unpinned.fully_mapped) 'an article with no pins at all reported fully mapped'

        # A prefix that merely shares leading characters must not match.
        $sibling = Resolve-SourcePinMapping -Upstream @([pscustomobject]@{ url = 'https://github.com/a/b'; ref = 'refs/heads/main'; commit_oid = $oid40; repo_root = 'raw/help'; captured = '2026-09-04' }) `
            -File @([pscustomobject]@{ path = 'raw/help-extra/x.md'; sha256 = $hashA; provenance = 'external' })
        Assert (-not $sibling.fully_mapped) 'a sibling directory sharing a name prefix was matched as if it were inside the root'

        # --- The manifest roll-up. Three fields, sanitized, and readability reported separately.
        $anchored = Get-ArticleAnchors -Text $article
        Assert ($anchored.readable) 'a well-formed article was reported unreadable by the roll-up'
        Assert (@($anchored.upstreams).Count -eq 2) "expected 2 rolled-up anchors, got $(@($anchored.upstreams).Count)"
        $anchorKeys = @($anchored.upstreams[0].PSObject.Properties | ForEach-Object { $_.Name })
        Assert (($anchorKeys -join ',') -ceq 'url,ref,commit_oid') "the roll-up carried unexpected fields: $($anchorKeys -join ',')"
        Assert (($anchored.upstreams | ConvertTo-Json -Depth 6) -cnotmatch 'raw/') 'the producer-local repo root reached the manifest roll-up'
        Assert (($anchored.upstreams | ConvertTo-Json -Depth 6) -cnotmatch 'captured') 'the capture date reached the manifest roll-up'

        # A page with no ## Sources block is readable and anchorless -- an imported wiki page.
        $plainArticle = Get-ArticleAnchors -Text "# Imported`n`nNo provenance here.`n"
        Assert ($plainArticle.readable -and @($plainArticle.upstreams).Count -eq 0) 'a page with no Sources block was not readable-and-anchorless'

        # A pre-pin compiled article: readable, anchorless, and NOT the same state as malformed.
        $prePin = Get-ArticleAnchors -Text "# A`n`n$legacyBlock"
        Assert ($prePin.readable -and @($prePin.upstreams).Count -eq 0) 'a pre-pin article was not readable-and-anchorless'

        # A malformed block contributes nothing AND says so, which is what stops the collection tier
        # reporting a Book `current` on the strength of its other articles.
        $badBlock = Get-ArticleAnchors -Text "# A`n`n## Sources`n`n- ``x`` - SHA-256 ``not-a-hash``; provenance: ``external```n"
        Assert (-not $badBlock.readable) 'a malformed Sources block was rolled up as readable'
        Assert (@($badBlock.upstreams).Count -eq 0) 'a malformed Sources block contributed an anchor'

        # A hand-written block that carries NO claim at all is not a compiled article, and must not
        # be counted unreadable -- that count is what makes a whole Book `cannot verify`, and seven
        # real pages across three Books reached it this way.
        $handWritten = Get-ArticleAnchors -Text "# A`n`n## Sources`n`n- Web (2026-07): [a link](https://example.com/x)`n- Odysseus code (``raw/odysseus-dev``, 2026-07-04): ``src/rag_vector.py```n"
        Assert ($handWritten.readable -and @($handWritten.upstreams).Count -eq 0) 'a claim-free hand-written Sources block was counted as unreadable'

        # --- What the prose skip must NOT also let through. Each of these was accepted or silently
        # dropped once the non-bullet refusal was relaxed, and each ends at a false `current`.
        $goodPin = Format-SourcesUpstreamLine -Url 'https://github.com/a/b' -Ref 'refs/heads/main' -CommitOid $oid40 -RepoRoot 'raw/b' -Captured '2026-09-04'
        $goodFile = Format-SourcesFileLine -Path 'raw/b/kept.md' -Sha256 $hashA -Provenance 'external'

        # A pin inside a fenced block is sample text, not a claim. While every non-bullet line was a
        # refusal this was unreachable, because the fence line itself condemned the article.
        foreach ($fence in @('```', '~~~')) {
            $fenced = Read-SourcesBlock -Text "# A`n`n## Sources`n`n$goodFile`n$fence`n$goodPin`n$fence`n"
            Assert ($fenced.ok) "a fenced example made the article malformed ($fence): $($fenced.reason)"
            Assert (@($fenced.upstreams).Count -eq 0) "a pin inside a $fence fence was read as a live claim"
        }

        $commented = Read-SourcesBlock -Text "# A`n`n## Sources`n`n$goodFile`n<!--`n$goodPin`n-->`n"
        Assert ($commented.ok) "an HTML comment made the article malformed: $($commented.reason)"
        Assert (@($commented.upstreams).Count -eq 0) 'a pin inside an HTML comment was read as a live claim'

        # A one-line comment encloses nothing that follows it.
        $inlineComment = Read-SourcesBlock -Text "# A`n`n## Sources`n`n<!-- a note -->`n$goodPin`n$goodFile`n"
        Assert ($inlineComment.ok -and @($inlineComment.upstreams).Count -eq 1) 'a single-line comment swallowed the rest of the block'

        # A claim wearing a bullet Markdown accepts but this grammar does not is a REFUSAL. Skipping
        # it would drop a cited file, and the surviving pins would then map every path still visible
        # and report the article fully mapped.
        foreach ($marker in @('* ', '+ ', '  - ', "`t- ")) {
            $smuggledPin = Read-SourcesBlock -Text "# A`n`n## Sources`n`n$goodPin`n$goodFile`n$marker$($goodPin.Substring(2))`n"
            Assert (-not $smuggledPin.ok) "a pin on a '$($marker.Trim())' bullet was silently skipped"
            $smuggledFile = Read-SourcesBlock -Text "# A`n`n## Sources`n`n$goodPin`n$goodFile`n$marker$($goodFile.Substring(2))`n"
            Assert (-not $smuggledFile.ok) "a file line on a '$($marker.Trim())' bullet was silently skipped"
        }

        # Prose is still skipped -- including a bulleted sentence, which carries no claim this check
        # can measure. This is the correction the skip was made for; it must survive the tightening.
        $prose = Read-SourcesBlock -Text "# A`n`nSee below.`n`n## Sources`n`nCloned at commit deadbeef; figures came from the GitHub API.`n`n$goodPin`n$goodFile`n* see the repository for details`n"
        Assert ($prose.ok) "prose inside the Sources block was refused: $($prose.reason)"
        Assert (@($prose.upstreams).Count -eq 1 -and @($prose.files).Count -eq 1) 'prose skipping lost a real claim'

        # --- The three rules added 2026-09-05, each written against the page that produced it.
        # Sixteen pages across four shared Books read `cannot verify / malformed anchor`; these are
        # the exact lines, transcribed rather than invented.

        # 1. A CANONICAL FILE LINE WITH A TRAILING ANNOTATION. 2nd-b-vault x3 and basic-memory x2.
        #    Path, hash and provenance are exact; only the end-anchor rejected them.
        foreach ($note in @(
            ' (both bearer keys redacted at compile time)'
            '; **partial read** (first 120 of 364 lines)'
            ', read 2026-09-04'
        )) {
            $annotated = Read-SourcesBlock -Text "# A`n`n## Sources`n`n$goodPin`n$goodFile$note`n"
            Assert ($annotated.ok) "an annotated file line was refused ('$note'): $($annotated.reason)"
            Assert (@($annotated.files).Count -eq 1 -and $annotated.files[0].path -ceq 'raw/b/kept.md') "an annotated file line lost its path ('$note')"
            Assert ($annotated.files[0].provenance -ceq 'external') "an annotated file line's provenance absorbed its note ('$note')"
        }
        # A run-on with no separator is a mangled provenance, not a note.
        $runOn = Read-SourcesBlock -Text "# A`n`n## Sources`n`n$goodPin`n$($goodFile)extra`n"
        Assert (-not $runOn.ok) 'a provenance field running straight into more text was accepted as an annotation'
        # And an annotation may not smuggle a second claim, which relaxing the anchor would swallow.
        $twoOnOne = Read-SourcesBlock -Text "# A`n`n## Sources`n`n$goodPin`n$goodFile - ``raw/b/hidden.md`` - SHA-256 ``$hashB``; provenance: ``external```n"
        Assert (-not $twoOnOne.ok) 'a second claim hidden in a trailing annotation was swallowed'
        Assert ($twoOnOne.reason -match 'second claim') "the swallowed claim was not named: $($twoOnOne.reason)"

        # 2. PROSE ON A CANONICAL BULLET. basic-memory x6, and the same shape in two other Books.
        foreach ($written in @(
            '- Repository pinned at commit `976287194f58ef172fdd85771eefc505260981c2`, 2026-09-03.'
            '- Library-side policy read from `.claude/settings.json` in this workspace.'
            '- Self-describing. Hashes above computed with `sha256sum` over the pinned clone at'
            '- Negative result: `grep -rn "Session not found"` returned no matches.'
            '- Live deployment probed 2026-08-30: `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9`'
            '- Web (2026-07): [KB staleness](https://atlan.com/know/llm-knowledge-base-staleness/)'
        )) {
            $handBullet = Read-SourcesBlock -Text "# A`n`n## Sources`n`n$goodPin`n$goodFile`n$written`n"
            Assert ($handBullet.ok) "a hand-written provenance bullet was refused: $written -> $($handBullet.reason)"
            Assert (@($handBullet.upstreams).Count -eq 1 -and @($handBullet.files).Count -eq 1) "a hand-written bullet cost the article a real claim: $written"
        }
        # `sha256sum` in prose must not read as the claim marker `SHA-256 ` -- an ordinal test is
        # what keeps a page from being refused for saying the word.
        $sha256sum = Read-SourcesBlock -Text "# A`n`n## Sources`n`n$goodFile`n- Hashes computed with ``sha256sum``.`n"
        Assert ($sha256sum.ok) "a prose bullet naming sha256sum was read as a claim: $($sha256sum.reason)"

        # 3. A BLOCK WITH NO PIN AND NO CITED FILE IS NOT A COMPILED ARTICLE.
        #    library-development-design-history's five ai-library-port pages are exactly this.
        $claimFree = Read-SourcesBlock -Text "# A`n`n## Sources`n`n- Web (2026-07): [a link](https://example.com/x)`n- Odysseus code (``raw/odysseus-dev``, 2026-07-04)`n"
        Assert ($claimFree.has_block -and $claimFree.ok) "a claim-free hand-written Sources block was refused: $($claimFree.reason)"
        Assert (@($claimFree.files).Count -eq 0 -and @($claimFree.upstreams).Count -eq 0) 'a claim-free block invented a claim'
        # But a PIN with nothing to map is still a half-written block, not a hand-written one.
        $pinNoFile = Read-SourcesBlock -Text "# A`n`n## Sources`n`n$goodPin`n- and some prose`n"
        Assert (-not $pinNoFile.ok) 'an upstream recorded beside no cited file was accepted'
        Assert ($pinNoFile.reason -match 'cites no source file') "the unmappable pin was not named: $($pinNoFile.reason)"

        # Duplicate collapse across articles, first-seen order preserved.
        $collapsed = Select-DistinctAnchor @(
            [pscustomobject]@{ url = 'https://github.com/a/b'; ref = 'refs/heads/main'; commit_oid = $oid40 }
            [pscustomobject]@{ url = 'https://github.com/a/b'; ref = 'refs/heads/main'; commit_oid = $oid40 }
            [pscustomobject]@{ url = 'https://github.com/a/c'; ref = 'refs/heads/main'; commit_oid = $oid40 }
        )
        Assert (@($collapsed).Count -eq 2) "duplicate anchors were not collapsed: $(@($collapsed).Count)"
        Assert ($collapsed[0].url -ceq 'https://github.com/a/b') 'first-seen order was not preserved'

        # --- Reading a stored field. Absent, empty and malformed are three answers, not one.
        $absent = Read-ManifestAnchors ([pscustomobject]@{ schema = 1; slug = 'demo' })
        Assert ((-not $absent.present) -and (-not $absent.ok)) 'a schema-1 manifest was read as carrying anchor data'

        # A schema-1 body that carries the field anyway is still not evidence: the schema, not the
        # field, is what says the Book was scanned. Reading it as `not anchored` would state a fact
        # about the Book that nothing established.
        $liar = Read-ManifestAnchors ([pscustomobject]@{ schema = 1; anchored_upstreams = @(); anchor_unreadable = 0 })
        Assert ((-not $liar.present) -and (-not $liar.ok)) 'a schema-1 body carrying the roll-up field was trusted'

        $empty = Read-ManifestAnchors ([pscustomobject]@{ schema = 2; anchored_upstreams = @(); anchor_unreadable = 0 })
        Assert ($empty.present -and $empty.ok -and @($empty.upstreams).Count -eq 0) 'an empty anchor array was not read as present-and-valid'

        $nulled = Read-ManifestAnchors ([pscustomobject]@{ schema = 2; anchored_upstreams = $null; anchor_unreadable = 0 })
        Assert ($nulled.present -and -not $nulled.ok) 'a null anchor field was read as an empty array'

        $good = Read-ManifestAnchors ([pscustomobject]@{ schema = 2; anchor_unreadable = 0; anchored_upstreams = @(
            [pscustomobject]@{ url = 'https://github.com/a/b'; ref = 'refs/heads/main'; commit_oid = $oid40 }
            [pscustomobject]@{ url = 'https://github.com/a/b'; ref = 'refs/heads/main'; commit_oid = $oid40 }) })
        Assert ($good.ok -and @($good.upstreams).Count -eq 1) 'a stored duplicate anchor was not collapsed on read'

        # The readability count is carried, not defaulted. Each of these shapes would otherwise be
        # read as zero, which says every page parsed -- and a matching tip then reports `current`
        # for a Book the manifest never claimed to have read in full.
        $counted = Read-ManifestAnchors ([pscustomobject]@{ schema = 2; anchored_upstreams = @(); anchor_unreadable = 3 })
        Assert ($counted.ok -and $counted.unreadable -eq 3) "the unreadable count was not carried: $($counted.unreadable)"
        foreach ($badCount in @(
            @{ why = 'an absent count';      body = [pscustomobject]@{ schema = 2; anchored_upstreams = @() } }
            @{ why = 'a nonnumeric count';   body = [pscustomobject]@{ schema = 2; anchored_upstreams = @(); anchor_unreadable = 'garbage' } }
            @{ why = 'a negative count';     body = [pscustomobject]@{ schema = 2; anchored_upstreams = @(); anchor_unreadable = -1 } }
            @{ why = 'a null count';         body = [pscustomobject]@{ schema = 2; anchored_upstreams = @(); anchor_unreadable = $null } }
        )) {
            $readCount = Read-ManifestAnchors $badCount.body
            Assert ($readCount.present -and -not $readCount.ok) "$($badCount.why) was read as a readable Book"
        }

        foreach ($bad in @(
            @{ why = 'a missing key';        value = @([pscustomobject]@{ url = 'https://github.com/a/b'; ref = 'refs/heads/main' }) }
            @{ why = 'an extra key';         value = @([pscustomobject]@{ url = 'https://github.com/a/b'; ref = 'refs/heads/main'; commit_oid = $oid40; repo_root = 'raw/b' }) }
            @{ why = 'a non-https URL';      value = @([pscustomobject]@{ url = 'git://github.com/a/b'; ref = 'refs/heads/main'; commit_oid = $oid40 }) }
            @{ why = 'a short ref';          value = @([pscustomobject]@{ url = 'https://github.com/a/b'; ref = 'main'; commit_oid = $oid40 }) }
            @{ why = 'an abbreviated OID';   value = @([pscustomobject]@{ url = 'https://github.com/a/b'; ref = 'refs/heads/main'; commit_oid = '0123abc' }) }
            @{ why = 'a scalar entry';       value = @('https://github.com/a/b') }
        )) {
            $read = Read-ManifestAnchors ([pscustomobject]@{ schema = 2; anchor_unreadable = 0; anchored_upstreams = $bad.value })
            Assert ($read.present -and -not $read.ok) "a stored anchor field with $($bad.why) was accepted"
        }
    }
    catch {
        [void]$script:failures.Add("the suite did not run to completion: $($_.Exception.Message)")
    }

    if ($script:failures.Count) {
        [Console]::Error.WriteLine("SourcesBlock self-test FAILED: $($script:failures -join '; ')")
        exit 1
    }
    Write-Host "SourcesBlock self-test passed ($($script:checks) checks)."
    exit 0
}
