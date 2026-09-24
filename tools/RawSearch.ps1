<#
.SYNOPSIS
    Scoped search over ONE named source batch under raw/: matching lines with the exact file path
    that opens them, every hit carrying its provenance. Dot-sourced; never invoked directly.

.DESCRIPTION
    Plan item 2.4, the third and last of Phase 2's retrieval tiers. Discovery (2.2) reads manifests
    and spans every Book. Full text (2.3) reads page bodies and is confined to Books OPEN on the
    Desk. This tier reads arbitrary converted source material that is not a Book at all.

    RAW/ IS NOT A BOOK, AND THAT IS THE WHOLE DIFFICULTY. Every tier before this one had a Desk, a
    catalog, a slug, and a manifest -- four independent authorities on what exists and what may be
    read. raw/ has none of them. It is 1.9 GB across roughly 73,000 files: whole third-party
    repository checkouts, converted documents, binaries, lockfiles, and -- the one that matters --
    a deliberately retained copy of the Library's OWN retired instructions. So the Book machinery is
    not reached for here. What replaces each of its four authorities is written down below, because
    a tier that quietly has no authority is worse than one that says it has none.

    WHAT A "SOURCE BATCH" IS, AND WHO SAYS SO. The reader says so, and this file only enumerates.
    PLAN.md 3.1 records that raw/ does NOT follow the documented raw/<project-slug>/<source-batch>/
    shape and that ownership cannot be inferred without contradicting CLAUDE.md -- so 2.4 declines
    to invent a third notion of "batch" that 3.1 would then have to reconcile. A batch here is
    exactly one thing: A CANONICAL DIRECTORY UNDER raw/, NAMED BY THE READER. Nothing is guessed,
    nothing is inferred from a folder name, and a batch that does not resolve is REPORTED with the
    real roster beside it -- never widened into a scan across raw/, which 2.4 forbids outright.
    Get-RawBatchRoster is the enumerator, and it is deliberately shaped so 3.1 can annotate the same
    roots with Project ownership later rather than replace them.

    THE HISTORICAL LABEL, AND WHY IT FAILS CLOSED. raw/LLM Workflow Testing/pilot/ holds a Pilot-era
    CLAUDE.md and docs/, retained as a source check and never to be deleted. The specific failure to
    prevent is severe and is not hypothetical: the Librarian quoting its own SUPERSEDED instructions
    back to the reader as current policy. So provenance is not an optional annotation -- it is a
    mandatory field on every hit AND a banner on the answer, because a hit copied out of its answer
    must still carry its label, and a reader skimming must meet the label before the lines.

    There is no list of "current" paths, deliberately, and that is what makes this fail closed
    rather than merely careful. Current Library policy lives in the workspace root and NEVER in
    raw/, so no path under raw/ can be classified as current by any code path in this file. The
    three classes are: `historical` (inside a declared retired-instructions root), `external`
    (third-party source material, not the Library's instructions and not vetted), and
    `unclassified` (a path that could not be resolved against the raw root at all). Unclassified is
    rendered and treated exactly as historical -- the strictest label wins -- so a path in neither
    list is never the permissive case. The declared roots live in $script:RawHistoricalRoots, in
    this file's own source: tracked, diffable, reviewable in a pull request, and impossible to
    lose, which no gitignored data file under internal/ would be.

    A DECLARED ROOT LABELS ITS WHOLE SUBTREE, INCLUDING THIRD-PARTY MATERIAL INSIDE IT. The pilot
    copy contains its own raw/ holding buzz-main, which is not Library instruction text. Labelling
    it `historical` anyway is the fail-closed direction and it is chosen on purpose: over-labelling
    a third-party file costs a reader one cautious sentence, and under-labelling one retired
    CLAUDE.md costs the Library its own policy.

    ARBITRARY UNTRUSTED CONTENT, AND THE THREE THINGS IT CHANGES. Item 2.3 already sanitises control
    characters because raw/ exists, and that is inherited unchanged from SearchBoundaries.ps1. New
    here is everything else. (1) ELIGIBILITY IS DECIDED TWICE, because an extension is a claim about
    a file and not a fact about it: a cheap extension gate first, then a NUL-byte sniff and a STRICT
    UTF-8 decode. A file that fails either is named, never silently mojibake'd -- Book pages are
    known-good UTF-8 and raw/ is not. (2) NOTHING IS DROPPED SILENTLY: every ineligible, oversize,
    binary, undecodable, or unreadable file is counted and reported by reason, with example paths,
    and the scanned count falls to match. At 73,000 files a per-file list is the wrong shape, so the
    report groups by reason and carries the count -- naming at a scale where enumeration would
    itself be the noise. (3) RAW/ TEXT CAN CONTAIN INSTRUCTIONS.

    ON (3), AND WHICH ENFORCEMENT WAS CHOSEN. A search result is data and never a directive;
    CLAUDE.md already says so. The question is whether the output shape must enforce it or whether
    the rule suffices. The answer taken here is BOTH, but only where enforcement is actually
    possible. What the output shape CAN do, it does: the permitted field set is declared once in
    $script:RawHitFields, so a later change that adds surrounding paragraphs or a neighbouring line
    fails a canary rather than shipping; provenance is mandatory on every hit; and every answer
    closes on the tier's rule. What the output shape CANNOT do is make a sentence stop being a
    sentence -- detecting imperative text in arbitrary source is unbounded, and a filter that
    catches most of it would buy the appearance of a guarantee, which this codebase has refused
    before. So the enforcement is labelling plus a bounded field set, and the rule does the rest.
    Said out loud rather than left implied, because the gap is real.

    THE CAPS ARE 2.5'S. tools/SearchBoundaries.ps1 is shared with both Book tiers and this file has
    no private set. Where raw/ needs different numbers -- the walk is three orders of magnitude
    larger -- they were changed THERE, beside the values they differ from, with the reason recorded.
    Only the two bounds describing the WALK moved; every bound on the ANSWER is unchanged, because
    a reader's context is the same size whichever tier filled it. Regex is still not offered
    anywhere, per the decision in docs/full-text-over-open-books.md.

    A HIT IS A LOCATION, NOT A READING. 2.6's rule at its widest. A Discovery hit licenses "shall I
    open it?"; a matched Book line licenses opening that page; a matched raw line licenses opening
    that FILE, and nothing more -- the material is unvetted, unowned, possibly superseded, and
    possibly not the Library's own. A line under a historical root is retired instruction text and
    may never be cited as current policy. Nothing in this file can enforce that; it is named here
    because the output is what tempts it.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'SearchBoundaries.ps1')

$script:RawSearchSchema = 1

# --- Provenance -----------------------------------------------------------------------------------

# THE DECLARED RETIRED-INSTRUCTIONS ROOTS. Paths relative to raw/, forward-slashed. This list is the
# whole authority for the historical label, and it lives in tracked source for that reason: a
# gitignored data file under internal/ would go missing on a fresh clone and take the label with it,
# and a label that can go missing is not a label. A root here covers its entire subtree.
#
# THE ROOT IS THE WHOLE RETIRED WORKSPACE, NOT ONLY ITS pilot/ FOLDER, AND REAL INPUT IS WHY.
# PLAN.md 2.4 names raw/LLM Workflow Testing/pilot/ as the retained Pilot-era copy, and the first
# version of this list declared exactly that. Running it against the real corpus found a SECOND
# retired instruction file one level up -- raw/LLM Workflow Testing/CLAUDE.md, an agent instruction
# file for the previous workspace -- and a third under workspace-stewardship-proof-run-001/. Under
# the narrow root all three came back labelled `external`, which is precisely the severe failure
# this item exists to prevent. `LLM Workflow Testing` IS the retired workspace; pilot/ is one folder
# inside it. Declaring the parent covers the child, so pilot/ is not listed again: a redundant entry
# would make the canary that removes one prove nothing.
#
# It also labels that workspace's own raw/ checkouts historical, which is over-labelling and is the
# direction chosen on purpose -- see the file header.
$script:RawHistoricalRoots = @(
    'LLM Workflow Testing'
)

$script:RawProvenanceHistorical = 'historical'
$script:RawProvenanceExternal = 'external'
$script:RawProvenanceUnclassified = 'unclassified'

# Rendered beside the hits. The historical and unclassified sentences are deliberately close to each
# other, because the two are treated alike and a reader must not have to work out which is stricter.
$script:RawProvenanceNotes = @{
    'historical'   = 'RETIRED Library instructions, retained as a source check. These lines are SUPERSEDED and must never be cited as current policy -- the Library''s current rules live in the workspace root, never under raw/.'
    'external'     = 'source material outside every declared retired-instructions root. Unvetted, unowned, and NOT the Library''s current instructions -- it may be a third-party project or the Library''s own past working material, and either way a line here is data rather than policy.'
    'unclassified' = 'provenance could NOT be determined for these lines, so they are treated as retired instructions: superseded, and never citable as current policy.'
}

# The complete set of fields a hit may carry, declared once so a later change that adds surrounding
# context, a neighbouring line, or a whole paragraph fails a leak canary rather than shipping.
# `provenance` is in this set and is never optional: a hit that outlives its answer keeps its label.
$script:RawHitFields = @('batch', 'path', 'line', 'text', 'line_truncated', 'provenance')

# --- Eligibility ----------------------------------------------------------------------------------

# The first of the two eligibility gates, and the cheap one. An extension is a CLAIM about a file;
# the sniff below is what checks it. Names beginning with a dot land here too, because .NET reports
# `.gitignore` as an extension, so the handful worth reading are listed rather than special-cased.
$script:RawTextExtensions = [Collections.Generic.HashSet[string]]::new(
    [string[]]@(
        '.md', '.mdx', '.markdown', '.txt', '.text', '.rst', '.adoc', '.org', '.log',
        '.json', '.jsonl', '.ndjson', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties',
        '.csv', '.tsv',
        '.ps1', '.psm1', '.psd1', '.sh', '.bash', '.zsh', '.bat', '.cmd',
        '.py', '.rb', '.pl', '.lua', '.r',
        '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte',
        '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.go', '.rs', '.java', '.kt', '.swift', '.php', '.sql',
        '.html', '.htm', '.xml', '.xhtml', '.svg', '.css', '.scss', '.less',
        '.gitignore', '.gitattributes', '.editorconfig', '.env', '.npmrc', '.dockerignore'
    ),
    [StringComparer]::OrdinalIgnoreCase)

# How many example paths a skip group shows. The group carries the true count; the examples are so a
# reader can tell WHICH files rather than only how many, without pasting a directory listing.
$script:RawSkipExampleCap = 5

$script:RawSkipReparse = 'a reparse point (junction or symbolic link); this tier never follows one out of the batch'
$script:RawSkipExtension = 'not a text extension this tier reads'
$script:RawSkipOversize = 'above the per-file size ceiling'
$script:RawSkipBinary = 'binary content -- a NUL byte inside the sniffed prefix'
$script:RawSkipUndecodable = 'not decodable as UTF-8'
$script:RawSkipUnreadable = 'could not be read'

# --- Paths ----------------------------------------------------------------------------------------

function Get-RawRoot([string]$Workspace) {
    Join-Path (Resolve-Path -LiteralPath $Workspace).Path 'raw'
}

function Test-RawReparsePoint($Item) {
    ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq [IO.FileAttributes]::ReparsePoint
}

# The path a reader sees and a provenance decision is made from. Returns '' when the file does not
# canonically sit under raw/ at all, which is the input that makes a path `unclassified` rather than
# `external` -- the fail-closed direction.
#
# OrdinalIgnoreCase is correct here and is NOT defect family 1: this compares Windows filesystem
# paths, which are case-insensitive, and the declared roots carry capitals and spaces rather than
# being a lowercase-only rule.
function ConvertTo-RawRelativePath([string]$RawRoot, [string]$FullPath) {
    if ([string]::IsNullOrWhiteSpace($RawRoot) -or [string]::IsNullOrWhiteSpace($FullPath)) { return '' }
    $root = [IO.Path]::GetFullPath($RawRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $full = [IO.Path]::GetFullPath($FullPath)
    if (-not $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { return '' }
    $full.Substring($root.Length + 1).Replace([IO.Path]::DirectorySeparatorChar, '/')
}

# The whole authority for the historical label. Fails closed twice: an unresolvable path is
# `unclassified`, and `unclassified` renders as strictly as `historical`. There is no branch that
# can return "current", because nothing under raw/ is.
function Get-RawProvenance([string]$RelativePath) {
    if ([string]::IsNullOrWhiteSpace($RelativePath)) { return $script:RawProvenanceUnclassified }
    $normalised = $RelativePath.Replace('\', '/').Trim('/')
    if ([string]::IsNullOrWhiteSpace($normalised)) { return $script:RawProvenanceUnclassified }
    foreach ($declared in $script:RawHistoricalRoots) {
        $root = $declared.Replace('\', '/').Trim('/')
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        if ($normalised.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { return $script:RawProvenanceHistorical }
        if ($normalised.StartsWith($root + '/', [StringComparison]::OrdinalIgnoreCase)) { return $script:RawProvenanceHistorical }
    }
    $script:RawProvenanceExternal
}

# True when this provenance may never be cited as current. Both non-external classes qualify, and
# the test is written once so the banner, the rendering, and the canaries cannot disagree.
function Test-RawProvenanceSuperseded([string]$Provenance) {
    ($Provenance -ceq $script:RawProvenanceHistorical) -or ($Provenance -ceq $script:RawProvenanceUnclassified)
}

# --- The roster -----------------------------------------------------------------------------------

function New-RawRosterEntry([string]$RawRoot, $Directory, [int]$Depth) {
    $relative = ConvertTo-RawRelativePath $RawRoot $Directory.FullName
    $children = 0
    try { $children = @(Get-ChildItem -LiteralPath $Directory.FullName -Directory -Force -ErrorAction Stop).Count } catch { $children = 0 }
    [pscustomobject]@{
        batch      = $relative
        depth      = $Depth
        children   = $children
        provenance = (Get-RawProvenance $relative)
    }
}

function Get-RawBatchRoster {
    <#
    .SYNOPSIS
        The real directory shape of raw/, at the two depths a batch is actually found at -- reported,
        never inferred into ownership.

    .DESCRIPTION
        The documented shape is raw/<project-slug>/<source-batch>/ and the real one is not that:
        some batches ARE the top-level directory (a whole repository checkout), and some sit one
        level down (`LLM Workflow Testing/pilot`). Both depths are listed rather than one being
        declared correct, because declaring one correct is the guess PLAN.md 3.1 forbids.

        Deliberately does not count files. A file count means walking 73,000 entries to answer
        "what is here", which is a scan across raw/ wearing an orientation's clothes. Immediate
        subdirectory count is free from the same enumeration and answers the question a reader
        actually has: is this a leaf, or does it hold batches of its own?
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Workspace)

    $rawRoot = Get-RawRoot $Workspace
    if (-not (Test-Path -LiteralPath $rawRoot -PathType Container)) { return @() }

    $entries = [Collections.Generic.List[object]]::new()
    foreach ($top in @(Get-ChildItem -LiteralPath $rawRoot -Directory -Force -ErrorAction SilentlyContinue | Sort-Object Name)) {
        if (Test-RawReparsePoint $top) { continue }
        [void]$entries.Add((New-RawRosterEntry $rawRoot $top 1))
        foreach ($child in @(Get-ChildItem -LiteralPath $top.FullName -Directory -Force -ErrorAction SilentlyContinue | Sort-Object Name)) {
            if (Test-RawReparsePoint $child) { continue }
            [void]$entries.Add((New-RawRosterEntry $rawRoot $child 2))
        }
    }
    @($entries)
}

# Resolves a reader-named batch, or explains why it could not. NEVER widens to raw/ itself and never
# picks a near match on the reader's behalf: an unrecognised batch is reported with the roster, which
# is what PLAN.md 3.1 requires of an unmapped one.
function Resolve-RawBatch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [string]$Batch
    )

    $rawRoot = Get-RawRoot $Workspace
    $name = ([string]$Batch).Replace('\', '/').Trim().Trim('/')
    $failure = { param($Reason) [pscustomobject]@{ recognised = $false; batch = $name; path = ''; provenance = ''; reason = $Reason } }

    if ([string]::IsNullOrWhiteSpace($name)) { return (& $failure 'no source batch was named, and this tier never scans all of raw/') }
    # A batch is a directory UNDER raw/. `.` and `..` are how a name becomes a scan across raw/ or an
    # escape out of it, so they are refused by shape rather than caught after resolution.
    if ($name -eq '.' -or $name.Split('/') -contains '..' -or $name.Split('/') -contains '.') {
        return (& $failure 'a source batch is a directory under raw/, named plainly; relative segments are not accepted')
    }
    if (-not (Test-Path -LiteralPath $rawRoot -PathType Container)) { return (& $failure 'this workspace has no raw/ directory') }

    $candidate = Join-Path $rawRoot ($name.Replace('/', [IO.Path]::DirectorySeparatorChar))
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
        return (& $failure "no directory raw/$name exists")
    }

    $item = $null
    try { $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop } catch { return (& $failure 'the batch directory could not be opened') }
    if (Test-RawReparsePoint $item) { return (& $failure 'that path is a reparse point, and this tier does not follow one') }

    $relative = ConvertTo-RawRelativePath $rawRoot $item.FullName
    if ([string]::IsNullOrWhiteSpace($relative)) { return (& $failure 'that path does not canonically resolve inside raw/') }

    [pscustomobject]@{
        recognised = $true
        batch      = $relative
        path       = [IO.Path]::GetFullPath($item.FullName)
        provenance = (Get-RawProvenance $relative)
        reason     = ''
    }
}

# --- Skip reporting -------------------------------------------------------------------------------

# Grouped rather than listed. At 73,000 files a per-file report is not a report, so the group carries
# the true count and a bounded sample. The count is what makes "returns less" impossible to hide.
function Add-RawSkip($Groups, [string]$Reason, [string]$Path) {
    if (-not $Groups.ContainsKey($Reason)) {
        $Groups[$Reason] = [pscustomobject]@{ reason = $Reason; count = 0; examples = [Collections.Generic.List[string]]::new() }
    }
    $group = $Groups[$Reason]
    $group.count++
    if ($group.examples.Count -lt $script:RawSkipExampleCap) { [void]$group.examples.Add($Path) }
}

# `,` IS LOAD-BEARING, AND ITS ABSENCE WAS A DEFECT IN THIS HELPER'S JSON CONTRACT. PowerShell
# ENUMERATES a collection on output, so `@()` returned from a function arrives at the caller as
# NOTHING and `$skipList` was `$null` -- which `ConvertTo-Json` then spells `{}` rather than `null`.
# Measured 2026-09-22 (S15): a clean batch reported `"files_skipped":{}` while the unrecognised-batch
# branch four hundred lines below, which builds the same field as an INLINE `@()`, reported
# `"files_skipped":[]`. One field, two shapes, decided by which branch answered -- and every consumer
# here wraps the value in `@()`, so nothing in PowerShell ever noticed. A JSON consumer does.
# Defect family 2, in its production direction.
function ConvertTo-RawSkipList($Groups) {
    , @(@($Groups.Values) | Sort-Object -Property @{ Expression = { -[int]$_.count } }, @{ Expression = { [string]$_.reason } } |
        ForEach-Object { [pscustomobject]@{ reason = $_.reason; count = $_.count; examples = @($_.examples) } })
}

# --- Reading ---------------------------------------------------------------------------------------

# The second eligibility gate. Returns the decoded text, or $null with the reason set -- so the one
# place that decides a file is unreadable is the one place that names it.
function Read-RawFileText([string]$FullPath, [ref]$Reason) {
    $Reason.Value = ''

    # ONE OPEN, NOT TWO. The first form of this sniffed a prefix through one FileStream and then
    # decoded through [IO.File]::ReadAllText, opening every eligible file twice. Over the real
    # `LLM Workflow Testing/pilot` batch that read 1,451 files before the wall clock stopped it; the
    # file is under the size ceiling by the time it reaches here, so it is read once into bytes and
    # both the sniff and the decode work from that.
    $bytes = $null
    try { $bytes = [IO.File]::ReadAllBytes($FullPath) }
    catch { $Reason.Value = $script:RawSkipUnreadable; return $null }

    $sniff = [Math]::Min([int]$script:SearchRawSniffBytes, $bytes.Length)
    for ($i = 0; $i -lt $sniff; $i++) {
        if ($bytes[$i] -eq 0) { $Reason.Value = $script:RawSkipBinary; return $null }
    }

    # STRICT UTF-8, never Get-Content -Raw. Get-Content -Raw reads a BOM-less file as ANSI in Windows
    # PowerShell 5.1, and a THROWING decoder is the difference between naming an undecodable file and
    # returning mojibake as though it were the text the file holds.
    $text = $null
    try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) }
    catch [Text.DecoderFallbackException] { $Reason.Value = $script:RawSkipUndecodable; return $null }
    catch [ArgumentException] { $Reason.Value = $script:RawSkipUndecodable; return $null }
    catch { $Reason.Value = $script:RawSkipUnreadable; return $null }

    # A byte-order mark decodes to U+FEFF and would otherwise sit inside line 1. Display strips it as
    # a format character, but the line would still carry it; removing it here keeps the two agreeing.
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    $text
}

function Split-RawLines([string]$Text) {
    @($Text.Replace("`r`n", "`n").Split("`n"))
}

function New-RawHit([string]$Batch, [string]$Path, [int]$Line, [string]$Text, [bool]$LineTruncated, [string]$Provenance) {
    [pscustomobject]@{
        batch          = $Batch
        path           = $Path
        line           = $Line
        text           = $Text
        line_truncated = $LineTruncated
        provenance     = $Provenance
    }
}

# --- The scan ---------------------------------------------------------------------------------------

function Find-RawBatchLines {
    <#
    .SYNOPSIS
        Every matching line inside ONE named source batch, with the workspace-relative file path that
        opens it and the provenance that says how it may be cited. Never scans across raw/.

    .PARAMETER MaxFilesScanned
    .PARAMETER WallClockSeconds
    .PARAMETER MaxMatchedBytes
    .PARAMETER MaxCollectedMatches
        Caller overrides on 2.5's raw-tier budgets, defaulting to the shared constants in
        SearchBoundaries.ps1. They exist because a cap that has never been watched binding is not a
        tested cap, and a fixture batch small enough to run offline can never reach a 20,000-file
        ceiling on its own. Both values of every budget flag are asserted in the suite.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [string]$Batch,
        [Parameter(Mandatory = $true)][string]$Query,
        [int]$MaxResults = $script:SearchDefaultMaxResults,
        [int]$MaxFilesScanned = $script:SearchRawMaxFilesScanned,
        [int]$WallClockSeconds = $script:SearchRawWallClockSeconds,
        [int]$MaxMatchedBytes = $script:SearchMaxMatchedBytes,
        [int]$MaxCollectedMatches = $script:SearchMaxCollectedMatches
    )

    $root = (Resolve-Path -LiteralPath $Workspace).Path
    $rawRoot = Get-RawRoot $root

    # The query is validated BEFORE the batch is resolved, so a malformed query is reported as a
    # malformed query rather than as whatever the batch happened to be.
    $needle = Assert-SearchQuery $Query
    $cap = Resolve-SearchResultCap $MaxResults
    $resolved = Resolve-RawBatch -Workspace $root -Batch $Batch

    # AN UNRECOGNISED BATCH IS REPORTED, NEVER GUESSED. No scan happens, no near match is chosen, and
    # the roster travels with the refusal so the next attempt can be right.
    if (-not $resolved.recognised) {
        return [pscustomobject]@{
            schema               = $script:RawSearchSchema
            query                = (ConvertTo-SearchDisplay $Query)
            batch                = $resolved.batch
            batch_recognised     = $false
            batch_reason         = $resolved.reason
            provenance           = ''
            roster               = @(Get-RawBatchRoster -Workspace $root)
            files_seen           = 0
            files_scanned        = 0
            files_skipped        = @()
            files_skipped_total  = 0
            match_count          = 0
            match_count_is_floor = $false
            result_count         = 0
            truncated            = $false
            max_results          = $cap
            provenance_classes   = @()
            budget_note          = ''
            results              = @()
        }
    }

    $budget = New-SearchBudget -WallClockSeconds $WallClockSeconds -MaxMatchedBytes $MaxMatchedBytes `
        -MaxFilesScanned $MaxFilesScanned -MaxCollectedMatches $MaxCollectedMatches

    $hits = [Collections.Generic.List[object]]::new()
    $skips = @{}
    $filesSeen = 0
    $filesScanned = 0

    # An explicit stack walk rather than Get-ChildItem -Recurse, for one reason: -Recurse FOLLOWS a
    # directory junction, and every file below it still reports a path under the batch root, so a
    # junction into another batch -- or out of raw/ entirely -- would pass a textual containment test
    # while serving content the reader never named. Refusing to DESCEND is the containment, and it
    # costs one attribute check per directory instead of one ancestor walk per file.
    $stack = [Collections.Generic.Stack[string]]::new()
    $stack.Push($resolved.path)

    while ($stack.Count -gt 0) {
        if (Test-SearchBudgetSpent $budget) { break }
        $current = $stack.Pop()

        $children = @()
        try { $children = @(Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop) }
        catch {
            Add-RawSkip $skips $script:RawSkipUnreadable (ConvertTo-RawRelativePath $rawRoot $current)
            continue
        }

        # NOT sorted here. Every result is sorted by path and line before it is returned, so sorting
        # each directory again buys nothing and costs a pipeline per directory across 73,000 files.
        foreach ($child in $children) {
            if (Test-SearchBudgetSpent $budget) { break }
            $relative = ConvertTo-RawRelativePath $rawRoot $child.FullName

            if (Test-RawReparsePoint $child) {
                Add-RawSkip $skips $script:RawSkipReparse $relative
                continue
            }
            if ($child.PSIsContainer) { $stack.Push($child.FullName); continue }

            $filesSeen++
            if (-not $script:RawTextExtensions.Contains([IO.Path]::GetExtension($child.Name))) {
                Add-RawSkip $skips $script:RawSkipExtension $relative
                continue
            }
            if ($child.Length -gt $script:SearchRawMaxFileBytes) {
                Add-RawSkip $skips $script:RawSkipOversize $relative
                continue
            }

            $reason = ''
            $text = Read-RawFileText $child.FullName ([ref]$reason)
            if ($null -eq $text) {
                Add-RawSkip $skips $reason $relative
                continue
            }

            Add-SearchBudgetFile $budget
            $filesScanned++
            $provenance = Get-RawProvenance $relative

            $lineNumber = 0
            foreach ($line in (Split-RawLines $text)) {
                $lineNumber++
                if (-not (Test-SearchContains $line $needle)) { continue }
                $rendered = ConvertTo-SearchLine $line
                [void]$hits.Add((New-RawHit $resolved.batch $relative $lineNumber $rendered.text $rendered.truncated $provenance))
                Add-SearchBudgetMatch $budget
                if (Test-SearchBudgetSpent $budget) { break }
            }
        }
    }

    $sorted = @($hits | Sort-Object -Property `
        @{ Expression = { [string]$_.path } }, `
        @{ Expression = { [int]$_.line } })

    # The reply budget is spent HERE, on lines the reader will actually see. It can only make the
    # ANSWER shorter; it never stops the scan, and the two are reported by different sentences. One
    # cap doing two jobs is the defect item 2.3's first real run found.
    $returnedList = [Collections.Generic.List[object]]::new()
    foreach ($hit in @($sorted | Select-Object -First $cap)) {
        if (-not (Test-SearchBudgetAcceptsText $budget ([string]$hit.text) ($returnedList.Count -eq 0))) { break }
        [void]$returnedList.Add($hit)
    }
    $returned = @($returnedList)

    # Attached to the classes that actually CONTRIBUTED A LINE, not to whatever the batch contains,
    # because the warning is about the lines on the screen. Same rule 2.3 applies to capture Books.
    $classes = @(@($returned | ForEach-Object { [string]$_.provenance } | Sort-Object -Unique))
    $skipList = ConvertTo-RawSkipList $skips
    # Summed by hand rather than with Measure-Object -Sum: over an EMPTY set Measure-Object returns
    # an object with no Sum property at all, so under Set-StrictMode the clean case -- a batch where
    # nothing was skipped -- is the one that throws. Defect family 4, and it took the whole answer
    # down rather than the total.
    $skippedTotal = 0
    foreach ($group in @($skipList)) { $skippedTotal += [int]$group.count }

    [pscustomobject]@{
        schema               = $script:RawSearchSchema
        query                = (ConvertTo-SearchDisplay $Query)
        batch                = $resolved.batch
        batch_recognised     = $true
        batch_reason         = ''
        provenance           = $resolved.provenance
        roster               = @()
        files_seen           = $filesSeen
        files_scanned        = $filesScanned
        files_skipped        = $skipList
        files_skipped_total  = $skippedTotal
        match_count          = $sorted.Count
        match_count_is_floor = ($budget.wall_clock_hit -or $budget.files_scanned_hit -or $budget.collected_matches_hit)
        result_count         = $returned.Count
        truncated            = ($sorted.Count -gt $returned.Count)
        max_results          = $cap
        provenance_classes   = $classes
        budget_note          = (Get-SearchBudgetNote $budget)
        results              = $returned
    }
}

# --- Rendering ---------------------------------------------------------------------------------------

function Format-RawBatchRoster($Roster) {
    $lines = [Collections.Generic.List[string]]::new()
    [void]$lines.Add('Source batches under raw/, as they actually sit on disk. Name exactly one:')
    foreach ($entry in @($Roster)) {
        $mark = if (Test-RawProvenanceSuperseded ([string]$entry.provenance)) { " [$($entry.provenance)]" } else { '' }
        $holds = if ($entry.children -gt 0) { " -- holds $($entry.children) sub-batch(es)" } else { '' }
        [void]$lines.Add("  $($entry.batch)$mark$holds")
    }
    ($lines -join "`n")
}

# The coverage lines come first and unconditionally, and the PROVENANCE BANNER comes before any line
# of content -- a reader must meet the label before the material it labels, not after scrolling past
# it. Same reason rung 6 put its coverage lines at the top.
function Format-RawSearchResult($Result) {
    $lines = [Collections.Generic.List[string]]::new()

    if (-not $Result.batch_recognised) {
        [void]$lines.Add("No search was run: $($Result.batch_reason).")
        [void]$lines.Add('This tier searches ONE named source batch and never scans across raw/, so nothing was guessed on your behalf.')
        [void]$lines.Add('')
        [void]$lines.Add((Format-RawBatchRoster $Result.roster))
        return ($lines -join "`n")
    }

    [void]$lines.Add("Raw source search in batch raw/$($Result.batch) for: $($Result.query)")
    # "at least 0" is a true sentence that tells a reader nothing, and it appeared on the first real
    # run. A floor only means something once there is something to be a floor OF, so the qualifier
    # goes on a non-zero count and the incompleteness is carried by the budget note and by the
    # absence sentence below -- which is the one that actually mattered.
    $found = if ($Result.match_count_is_floor -and $Result.result_count -gt 0) { "at least $($Result.result_count)" } else { "$($Result.result_count)" }
    [void]$lines.Add("$found matching line(s) from $($Result.files_scanned) file(s) read of $($Result.files_seen) seen. Only this batch was searched; raw/ as a whole was not.")
    if ($Result.truncated) {
        $total = if ($Result.match_count_is_floor) { "at least $($Result.match_count)" } else { "$($Result.match_count)" }
        [void]$lines.Add("Showing the first $($Result.result_count) of $total matching lines; ask for more with a larger result cap.")
    }
    if (-not [string]::IsNullOrWhiteSpace($Result.budget_note)) {
        [void]$lines.Add($Result.budget_note)
    }

    if (@($Result.files_skipped).Count) {
        [void]$lines.Add('')
        [void]$lines.Add("Files NOT read, so this answer is incomplete for them ($($Result.files_skipped_total) in total):")
        foreach ($group in @($Result.files_skipped)) {
            $examples = @($group.examples)
            $shown = if ($examples.Count) { " e.g. $($examples -join ', ')" } else { '' }
            $more = if ($group.count -gt $examples.Count) { " (+$($group.count - $examples.Count) more)" } else { '' }
            [void]$lines.Add("- $($group.count): $($group.reason).$shown$more")
        }
    }

    # THE BANNER. Before the content, always, and drawn from the classes that contributed a line.
    if (@($Result.provenance_classes).Count) {
        [void]$lines.Add('')
        foreach ($class in @($Result.provenance_classes)) {
            $note = if ($script:RawProvenanceNotes.ContainsKey($class)) { $script:RawProvenanceNotes[$class] } else { $script:RawProvenanceNotes['unclassified'] }
            [void]$lines.Add("Lines below marked [$class] are $note")
        }
    }

    [void]$lines.Add('')
    if (-not @($Result.results).Count) {
        # THE ONE THE FIRST REAL RUN FOUND. A scan stopped by its budget read a fraction of the batch,
        # and this line still said the term was not there -- a flat claim of ABSENCE on top of an
        # answer that had just admitted it was incomplete. Absence is only a finding when everything
        # was actually read, so the two cases get two different sentences and never the same one.
        if ($Result.match_count_is_floor) {
            [void]$lines.Add('Nothing was found in the part of the batch that was read -- and this scan STOPPED EARLY, so this is NOT evidence that the term is absent. Narrow to a smaller batch and ask again.')
        }
        else {
            [void]$lines.Add('No file read in that batch carries that term.')
        }
    }
    else {
        $currentPath = ''
        foreach ($hit in @($Result.results)) {
            if ($hit.path -cne $currentPath) {
                $currentPath = $hit.path
                [void]$lines.Add('')
                [void]$lines.Add("raw/$($hit.path) [$($hit.provenance)]")
            }
            $cut = if ($hit.line_truncated) { ' [line truncated]' } else { '' }
            [void]$lines.Add("  :$($hit.line): [$($hit.provenance)] $($hit.text)$cut")
        }
    }

    [void]$lines.Add('')
    [void]$lines.Add((Get-SearchClosingRule 'raw'))
    ($lines -join "`n")
}

# ---------------------------------------------------------------------------------------------------
# Self-test. Fixture-only and offline; run by Invoke-LibraryChecks.ps1 as `raw-search.selftest`.
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
    function Write-FixtureBytes([string]$Path, [byte[]]$Bytes) {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [IO.File]::WriteAllBytes($Path, $Bytes)
    }

    # Indexing an empty match set throws, and an outer catch then swallows every assertion after it,
    # so a suite that HAS the right canary reports only the first one that noticed.
    function First($Items) {
        $all = @($Items)
        if ($all.Count) { return $all[0] }
        $null
    }
    # A query that throws must be a failed assertion, not a dead suite.
    function Invoke-SafeFind {
        param([string]$Root, [string]$Batch, [string]$Term, [hashtable]$Extra = @{})
        try { return Find-RawBatchLines -Workspace $Root -Batch $Batch -Query $Term @Extra }
        catch { return $null }
    }
    function Test-AnyText($Result, [string]$Needle) {
        if ($null -eq $Result) { return $false }
        [bool]@(@($Result.results) | Where-Object { ([string]$_.text).IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count
    }
    function Get-SkipGroup($Result, [string]$Reason) {
        if ($null -eq $Result) { return $null }
        First @(@($Result.files_skipped) | Where-Object { [string]$_.reason -ceq $Reason })
    }
    function Test-RenderContains($Result, [string]$Needle) {
        if ($null -eq $Result) { return $false }
        (Format-RawSearchResult $Result).IndexOf($Needle, [StringComparison]::Ordinal) -ge 0
    }

    # Sentinels. Each exists in exactly one place, so its appearance in a result is unambiguous.
    $inBatch = 'ZZINBATCHZZ'
    $otherBatch = 'ZZOTHERBATCHZZ'
    $pilotSentinel = 'ZZPILOTRULEZZ'
    $nestedSentinel = 'ZZNESTEDZZ'
    $common = 'ZZCOMMONZZ'
    # A non-ASCII fixture, built from code points because this file has no BOM. An ASCII fixture
    # cannot catch an encoding defect, and this tier returns the characters it read.
    $eAcute = [string][char]0x00E9
    $accented = 'caf' + $eAcute + 'ZZACCENTZZ'

    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('raw-search-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $fixture -Force | Out-Null
        $rawDir = Join-Path $fixture 'raw'

        # --- The named batch -----------------------------------------------------------------------
        Write-Fixture (Join-Path $rawDir 'alpha/notes.md') "intro`n$inBatch here`nlast"
        Write-Fixture (Join-Path $rawDir 'alpha/accent.md') "$accented"
        # The SAME word stored DECOMPOSED -- 'e' followed by a combining acute. Normalisation is what
        # makes it match a composed query, so this is the fixture that proves the shared fast reject
        # cannot false-negative: with the ASCII guard the needle has no fast-reject token and takes
        # the exact path; without it, a raw IndexOf of the composed form would miss this line and the
        # search would quietly return less.
        $decomposed = 'caf' + [string][char]0x0065 + [string][char]0x0301 + 'ZZDECOMPZZ'
        Write-Fixture (Join-Path $rawDir 'alpha/decomposed.md') "$decomposed"
        Write-Fixture (Join-Path $rawDir 'alpha/deep/more.md') "$nestedSentinel and $inBatch"
        # Control characters in real converted source, which must never reach the reader intact.
        Write-Fixture (Join-Path $rawDir 'alpha/control.md') ("ZZCTRLZZ" + [string][char]0x0007 + "tail")
        # A pathological single line, for the per-line cap.
        Write-Fixture (Join-Path $rawDir 'alpha/long.md') ('ZZLONGZZ ' + ('x' * 900))
        # Ineligible by extension, and it CARRIES the sentinel: a file skipped for the right reason
        # must still not contribute a line.
        Write-Fixture (Join-Path $rawDir 'alpha/image.png') "$inBatch"
        # Binary by content despite an eligible extension -- the reason eligibility is decided twice.
        Write-FixtureBytes (Join-Path $rawDir 'alpha/binary.md') ([byte[]]@(0x5A, 0x5A, 0x00, 0x5A, 0x5A))
        # Valid extension, invalid UTF-8: a lone 0xFF byte is not decodable in any UTF-8 sequence.
        Write-FixtureBytes (Join-Path $rawDir 'alpha/broken.md') ([byte[]]@(0x61, 0x62, 0xFF, 0x63))
        # Above the per-file ceiling.
        Write-Fixture (Join-Path $rawDir 'alpha/huge.md') ("$inBatch`n" + ('y' * ($script:SearchRawMaxFileBytes + 64)))
        # Several files carrying one common term, so the answer and scan budgets can be watched
        # binding without a fixture the size of raw/.
        foreach ($n in 1..6) { Write-Fixture (Join-Path $rawDir "alpha/common$n.md") "$common line $n" }

        # --- A different batch, which must never appear -------------------------------------------
        Write-Fixture (Join-Path $rawDir 'beta/secret.md') "$otherBatch and $inBatch and $common"

        # --- The declared historical root ----------------------------------------------------------
        Write-Fixture (Join-Path $rawDir 'LLM Workflow Testing/pilot/CLAUDE.md') "$pilotSentinel is a retired rule"
        Write-Fixture (Join-Path $rawDir 'LLM Workflow Testing/pilot/raw/vendor/lib.md') "$pilotSentinel inside third-party material"
        Write-Fixture (Join-Path $rawDir 'Other Workspace/current/notes.md') "$pilotSentinel outside the retired root"

        # --- A junction OUT of the named batch, for the containment canary -------------------------
        $junction = Join-Path $rawDir 'alpha/link-to-beta'
        $junctionMade = $false
        & cmd.exe /c mklink /J "`"$junction`"" "`"$(Join-Path $rawDir 'beta')`"" 2>&1 | Out-Null
        $junctionMade = Test-Path -LiteralPath $junction -PathType Container
        # A canary that silently could not be exercised is worse than no canary, so this is a failed
        # assertion rather than a skipped one.
        Assert $junctionMade 'the fixture junction could not be created, so the containment canary was never exercised'

        # A SECOND junction, at DEPTH 1, and it exists because its absence was a finding. The roster
        # refuses a reparse point at both depths, but only the depth-2 refusal had a fixture -- so
        # mutating the depth-1 guard away fired NOTHING, which is no test of that guard at all.
        $topJunction = Join-Path $rawDir 'link-to-alpha'
        & cmd.exe /c mklink /J "`"$topJunction`"" "`"$(Join-Path $rawDir 'alpha')`"" 2>&1 | Out-Null
        Assert (Test-Path -LiteralPath $topJunction -PathType Container) 'the depth-1 fixture junction could not be created, so the depth-1 roster guard was never exercised'

        # === 1. The batch scope ====================================================================
        $alpha = Invoke-SafeFind $fixture 'alpha' $inBatch
        Assert ($null -ne $alpha) 'a plain query over the named batch threw'
        Assert ($alpha.batch_recognised) 'the named batch was not recognised'
        Assert (Test-AnyText $alpha $inBatch) 'the in-batch sentinel was not returned'
        # THE LEAK CANARY. beta/secret.md carries the same sentinel and sits outside the batch.
        Assert (-not (Test-AnyText $alpha $otherBatch)) 'LEAK: a line from outside the named batch was returned'
        Assert (@(@($alpha.results) | Where-Object { ([string]$_.path).StartsWith('alpha/', [StringComparison]::Ordinal) }).Count -eq @($alpha.results).Count) `
            'LEAK: a result carried a path outside the named batch'
        Assert (@(@($alpha.results) | Where-Object { ([string]$_.path).IndexOf('beta', [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -eq 0) `
            'LEAK: the junction was followed into another batch'
        $reparseGroup = Get-SkipGroup $alpha $script:RawSkipReparse
        Assert ($null -ne $reparseGroup -and $reparseGroup.count -ge 1) 'the junction was not NAMED as skipped, only avoided'

        # A batch one level down is searchable in its own right, and scopes to itself.
        $deep = Invoke-SafeFind $fixture 'alpha/deep' $nestedSentinel
        Assert ($null -ne $deep -and (Test-AnyText $deep $nestedSentinel)) 'a depth-2 batch could not be searched'
        $deepOnly = Invoke-SafeFind $fixture 'alpha/deep' $accented
        Assert ($null -ne $deepOnly -and @($deepOnly.results).Count -eq 0) 'a depth-2 batch reached its parent''s files'

        # === 2. Unrecognised batches are REPORTED, never guessed ===================================
        foreach ($bad in @('nope', '', '.', '../..', 'alpha/../beta')) {
            $refused = Invoke-SafeFind $fixture $bad $inBatch
            Assert ($null -ne $refused) "an unrecognised batch name threw instead of reporting: '$bad'"
            if ($null -ne $refused) {
                Assert (-not $refused.batch_recognised) "an unrecognised batch name was accepted: '$bad'"
                Assert (@($refused.results).Count -eq 0) "an unrecognised batch name still returned lines: '$bad'"
                Assert (-not [string]::IsNullOrWhiteSpace([string]$refused.batch_reason)) "an unrecognised batch gave no reason: '$bad'"
                Assert (@($refused.roster).Count -gt 0) "an unrecognised batch reported no roster: '$bad'"
            }
        }
        $refusedText = Format-RawSearchResult (Invoke-SafeFind $fixture 'nope' $inBatch)
        Assert ($refusedText.IndexOf('never scans across raw/', [StringComparison]::Ordinal) -ge 0) 'the refusal did not say raw/ was not scanned'
        Assert ($refusedText.IndexOf('alpha', [StringComparison]::Ordinal) -ge 0) 'the refusal did not carry the real roster'
        # A junction named AS the batch is refused too, not silently followed.
        $viaLink = Invoke-SafeFind $fixture 'alpha/link-to-beta' $otherBatch
        Assert ($null -ne $viaLink -and -not $viaLink.batch_recognised) 'a reparse point was accepted as a batch root'

        # === 3. Provenance, and the historical label ===============================================
        $pilot = Invoke-SafeFind $fixture 'LLM Workflow Testing' $pilotSentinel
        Assert ($null -ne $pilot -and (Test-AnyText $pilot $pilotSentinel)) 'the pilot fixture returned nothing'
        $pilotHits = @(@($pilot.results) | Where-Object { ([string]$_.path).IndexOf('pilot/', [StringComparison]::Ordinal) -ge 0 })
        Assert ($pilotHits.Count -ge 2) 'the pilot subtree did not contribute the expected hits'
        # THE HISTORICAL CANARY. Every hit under the declared root, including the third-party material
        # nested inside it, carries the label.
        Assert (@($pilotHits | Where-Object { [string]$_.provenance -cne 'historical' }).Count -eq 0) `
            'LEAK: a Pilot-era line was returned WITHOUT its historical label'
        # The boundary: the SAME sentinel in a batch outside every declared root must come back
        # external, or `historical` would just be what this fixture always says.
        $outside = Invoke-SafeFind $fixture 'Other Workspace' $pilotSentinel
        $outsideHits = @($outside.results)
        Assert ($outsideHits.Count -ge 1) 'the batch outside the retired root contributed nothing, so the boundary was untested'
        Assert (@($outsideHits | Where-Object { [string]$_.provenance -cne 'external' }).Count -eq 0) `
            'a path outside every retired root was mislabelled'
        Assert (-not (Test-RenderContains $outside 'SUPERSEDED')) 'an external-only answer carried the historical banner'
        # The label travels BOTH ways: on the hit, and as a banner ahead of the lines.
        Assert (Test-RenderContains $pilot 'SUPERSEDED') 'the rendered answer carried no historical banner'
        $rendered = Format-RawSearchResult $pilot
        $bannerAt = $rendered.IndexOf('SUPERSEDED', [StringComparison]::Ordinal)
        $firstHitAt = $rendered.IndexOf('  :', [StringComparison]::Ordinal)
        Assert ($bannerAt -ge 0 -and $firstHitAt -gt $bannerAt) 'the historical banner appeared AFTER the lines it labels'
        Assert ($rendered.IndexOf('[historical]', [StringComparison]::Ordinal) -ge 0) 'no rendered line carried its provenance inline'

        # Provenance classification itself, including the fail-closed third state.
        Assert ((Get-RawProvenance 'LLM Workflow Testing') -ceq 'historical') 'the declared root itself was not historical'
        Assert ((Get-RawProvenance 'LLM Workflow Testing/pilot/docs/x.md') -ceq 'historical') 'a path inside the declared root was not historical'
        Assert ((Get-RawProvenance 'LLM Workflow Testing Extra/x.md') -ceq 'external') 'a prefix-only sibling was wrongly labelled historical'
        Assert ((Get-RawProvenance 'buzz-main/README.md') -ceq 'external') 'ordinary source material was not labelled external'
        Assert ((Get-RawProvenance '') -ceq 'unclassified') 'an unresolvable path was not unclassified'
        Assert ((Get-RawProvenance '   ') -ceq 'unclassified') 'a blank path was not unclassified'
        # FAIL CLOSED: the third state is never the permissive one.
        Assert (Test-RawProvenanceSuperseded 'unclassified') 'an unclassified path was not treated as superseded'
        Assert (Test-RawProvenanceSuperseded 'historical') 'a historical path was not treated as superseded'
        Assert (-not (Test-RawProvenanceSuperseded 'external')) 'external material was treated as superseded'
        Assert ($script:RawProvenanceNotes.ContainsKey('unclassified') -and $script:RawProvenanceNotes['unclassified'].IndexOf('superseded', [StringComparison]::Ordinal) -ge 0) `
            'the unclassified note does not say the lines are superseded'
        # There is no "current" class at all, by construction.
        Assert (@($script:RawProvenanceNotes.Keys | Where-Object { $_ -cmatch 'current' }).Count -eq 0) 'a provenance class named "current" exists'
        Assert ($script:RawHistoricalRoots.Count -ge 1) 'the declared historical root list is EMPTY'
        Assert ($script:RawHistoricalRoots -ccontains 'LLM Workflow Testing') 'the retired workspace root is not declared historical'
        # The three retired instruction files real input turned up, asserted by path. The narrow root
        # covered only the first of them.
        Assert ((Get-RawProvenance 'LLM Workflow Testing/pilot/CLAUDE.md') -ceq 'historical') 'the Pilot-era CLAUDE.md was not labelled historical'
        Assert ((Get-RawProvenance 'LLM Workflow Testing/CLAUDE.md') -ceq 'historical') 'the retired workspace CLAUDE.md one level ABOVE pilot/ was not labelled historical'
        Assert ((Get-RawProvenance 'LLM Workflow Testing/workspace-stewardship-proof-run-001/CLAUDE.md') -ceq 'historical') 'a retired proof-run CLAUDE.md was not labelled historical'

        # === 4. Nothing is dropped silently ========================================================
        $extGroup = Get-SkipGroup $alpha $script:RawSkipExtension
        Assert ($null -ne $extGroup -and $extGroup.count -ge 1) 'an ineligible file was dropped instead of NAMED'
        Assert (@($extGroup.examples).Count -ge 1) 'a skip group named no example path'
        $binGroup = Get-SkipGroup $alpha $script:RawSkipBinary
        Assert ($null -ne $binGroup -and $binGroup.count -ge 1) 'a binary file was dropped instead of NAMED'
        $undecGroup = Get-SkipGroup $alpha $script:RawSkipUndecodable
        Assert ($null -ne $undecGroup -and $undecGroup.count -ge 1) 'an undecodable file was dropped instead of NAMED'
        $bigGroup = Get-SkipGroup $alpha $script:RawSkipOversize
        Assert ($null -ne $bigGroup -and $bigGroup.count -ge 1) 'an oversize file was dropped instead of NAMED'
        Assert ($alpha.files_skipped_total -ge 4) 'the skipped total did not account for the skipped files'
        # The counts must FALL to match: seen is more than read, and the difference is accounted for.
        Assert ($alpha.files_seen -gt $alpha.files_scanned) 'files_seen did not exceed files_scanned when files were skipped'
        Assert (($alpha.files_scanned + $alpha.files_skipped_total) -ge $alpha.files_seen) 'skipped files were neither read nor reported'
        Assert (Test-RenderContains $alpha 'this answer is incomplete for them') 'the rendered answer did not admit the skipped files'
        # A file skipped for a good reason must still not contribute its line.
        Assert (@(@($alpha.results) | Where-Object { ([string]$_.path).EndsWith('image.png', [StringComparison]::OrdinalIgnoreCase) }).Count -eq 0) `
            'LEAK: an ineligible file contributed a line'
        Assert (@(@($alpha.results) | Where-Object { ([string]$_.path).EndsWith('huge.md', [StringComparison]::OrdinalIgnoreCase) }).Count -eq 0) `
            'LEAK: an oversize file contributed a line'

        # === 5. Sanitisation, encoding, and the per-line cap ========================================
        $ctrl = Invoke-SafeFind $fixture 'alpha' 'ZZCTRLZZ'
        $ctrlHit = First @($ctrl.results)
        Assert ($null -ne $ctrlHit) 'the control-character fixture returned nothing'
        if ($null -ne $ctrlHit) {
            Assert (([string]$ctrlHit.text).IndexOf([string][char]0x0007, [StringComparison]::Ordinal) -lt 0) `
                'LEAK: a control character survived into the emitted line'
            Assert (([string]$ctrlHit.text).IndexOf('tail', [StringComparison]::Ordinal) -ge 0) 'sanitisation destroyed the surrounding text'
        }
        # THE SHARED FAST REJECT, both branches. A multi-token query whose match exists only AFTER
        # normalisation must still be found: the pre-check sees the ASCII token in the raw line and
        # the exact comparison then matches across the control character the pipeline turned into a
        # space. A fast path that quietly returned less here would be invisible without this case.
        $joined = Invoke-SafeFind $fixture 'alpha' 'ZZCTRLZZ tail'
        Assert ($null -ne $joined -and @($joined.results).Count -ge 1) 'a match that exists only after normalisation was fast-rejected'
        $cased = Invoke-SafeFind $fixture 'alpha' 'zzctrlzz TAIL'
        Assert ($null -ne $cased -and @($cased.results).Count -ge 1) 'the fast reject broke case-insensitive matching'
        # And a needle with NO ASCII token at all takes the exact path unconditionally.
        Assert ((Get-SearchNeedleToken 'ZZCTRLZZ tail'.ToLowerInvariant()) -ceq 'zzctrlzz') 'the longest ASCII token was not chosen'
        Assert ((Get-SearchNeedleToken ([string][char]0x00E9 + [string][char]0x00E8)) -ceq '') 'a non-ASCII needle was given a fast-reject token'
        # THE BEHAVIOURAL HALF, and it is the one that matters. The line above only asserts the token
        # RULE; this asserts that the rule protects a real match. A COMPOSED query must find a
        # DECOMPOSED line, which only normalisation can do -- so a fast reject that ran on a
        # non-ASCII token would skip this line and the search would return less without saying so.
        $composedQuery = 'caf' + $eAcute + 'ZZDECOMPZZ'
        $decomp = Invoke-SafeFind $fixture 'alpha' $composedQuery
        Assert ($null -ne $decomp -and @($decomp.results).Count -ge 1) `
            'a decomposed line was fast-rejected against a composed query, so the search silently returned less'

        # Encoding, against a real accented character rather than an ASCII stand-in.
        $acc = Invoke-SafeFind $fixture 'alpha' $accented
        Assert ($null -ne $acc -and (Test-AnyText $acc $accented)) 'a UTF-8 accented line was not matched as written'
        $accHit = First @($acc.results)
        if ($null -ne $accHit) { Assert (([string]$accHit.text).IndexOf($eAcute, [StringComparison]::Ordinal) -ge 0) 'the accented character was mangled on the way out' }
        # The per-line cap, and its flag in BOTH directions.
        $long = Invoke-SafeFind $fixture 'alpha' 'ZZLONGZZ'
        $longHit = First @($long.results)
        Assert ($null -ne $longHit -and $longHit.line_truncated) 'a pathological line was not marked truncated'
        if ($null -ne $longHit) { Assert (([string]$longHit.text).Length -le $script:SearchMaxLineCharacters) 'the per-line cap did not bind' }
        Assert ($null -ne $ctrlHit -and -not $ctrlHit.line_truncated) 'an ordinary line was marked truncated'

        # === 6. The declared field set ==============================================================
        $anyHit = First @($alpha.results)
        Assert ($null -ne $anyHit) 'no hit was available to check the field set'
        if ($null -ne $anyHit) {
            $fields = @($anyHit.PSObject.Properties | ForEach-Object { $_.Name })
            $extra = @($fields | Where-Object { $_ -cnotin $script:RawHitFields })
            Assert ($extra.Count -eq 0) "LEAK: a hit carried undeclared field(s): $($extra -join ', ')"
            $missing = @($script:RawHitFields | Where-Object { $_ -cnotin $fields })
            Assert ($missing.Count -eq 0) "a hit was missing declared field(s): $($missing -join ', ')"
            Assert ($script:RawHitFields -ccontains 'provenance') 'provenance is not a declared field, so a hit could travel without its label'
        }

        # === 7. The budgets, both values of every flag ==============================================
        # A complete search: floor false, nothing trimmed, no note.
        $complete = Invoke-SafeFind $fixture 'alpha' $common
        Assert ($null -ne $complete) 'the common-term query threw'
        Assert (-not $complete.match_count_is_floor) 'a COMPLETE search reported its count as a floor'
        Assert ([string]::IsNullOrWhiteSpace([string]$complete.budget_note)) 'a complete search emitted a budget note'
        Assert (-not (Test-RenderContains $complete 'at least')) 'a complete search rendered its count as a floor'
        Assert ($complete.match_count -ge 6) 'the common-term fixture did not produce enough matches to bound'

        # A SCAN budget bound: pages went unread, the count is a floor, and the answer says INCOMPLETE.
        $stopped = Invoke-SafeFind $fixture 'alpha' $common @{ MaxCollectedMatches = 2 }
        Assert ($null -ne $stopped) 'the scan-bounded query threw'
        Assert ($stopped.match_count_is_floor) 'a search stopped by its SCAN budget did not report its count as a floor'
        Assert ((([string]$stopped.budget_note)).IndexOf('INCOMPLETE', [StringComparison]::Ordinal) -ge 0) 'a scan-bounded search did not say it was incomplete'
        Assert ($stopped.match_count -lt $complete.match_count) 'the scan budget did not actually stop the scan'
        Assert (Test-RenderContains $stopped 'at least') 'a scan-bounded answer rendered its count as exact'
        # The files-scanned budget is its own flag, asserted true as well as false.
        $fileBound = Invoke-SafeFind $fixture 'alpha' $common @{ MaxFilesScanned = 2 }
        Assert ($null -ne $fileBound -and $fileBound.match_count_is_floor) 'the files-scanned budget did not report a floor'
        Assert ((([string]$fileBound.budget_note)).IndexOf('scan budget', [StringComparison]::Ordinal) -ge 0) 'the files-scanned budget was not named in the note'
        Assert ($fileBound.files_scanned -le 3) 'the files-scanned budget did not bind'

        # An ANSWER budget bound: every file was still read, and the sentence is the OTHER one.
        # One cap must do one job -- this is the defect 2.3's first real run found.
        $trimmed = Invoke-SafeFind $fixture 'alpha' $common @{ MaxMatchedBytes = 12 }
        Assert ($null -ne $trimmed) 'the answer-bounded query threw'
        Assert (-not $trimmed.match_count_is_floor) 'an answer trimmed by the REPLY budget was reported as an incomplete SCAN'
        Assert ($trimmed.result_count -lt $complete.result_count) 'the reply budget did not trim the answer'
        Assert ((([string]$trimmed.budget_note)).IndexOf('Every page was still searched', [StringComparison]::Ordinal) -ge 0) `
            'a trimmed answer did not say the search was complete'
        Assert ((([string]$trimmed.budget_note)).IndexOf('INCOMPLETE', [StringComparison]::Ordinal) -lt 0) 'a trimmed answer claimed the SCAN was incomplete'
        Assert ($trimmed.result_count -ge 1) 'the first line was not returned regardless of the reply budget'
        # The result cap trims and SAYS SO.
        $capped = Invoke-SafeFind $fixture 'alpha' $common @{ MaxResults = 2 }
        Assert ($null -ne $capped -and $capped.truncated) 'the result cap trimmed without saying so'
        Assert ($capped.result_count -eq 2) 'the result cap did not bind'
        Assert (Test-RenderContains $capped 'Showing the first 2') 'the trimmed answer did not report the trim'

        # === 8. Query validation, shared with the other two tiers ===================================
        $threw = $false
        try { Find-RawBatchLines -Workspace $fixture -Batch 'alpha' -Query ('q' * ($script:SearchMaxQueryLength + 1)) | Out-Null }
        catch { $threw = $true }
        Assert $threw 'an over-length query was accepted'
        $threw = $false
        try { Find-RawBatchLines -Workspace $fixture -Batch 'alpha' -Query '   ' | Out-Null } catch { $threw = $true }
        Assert $threw 'a blank query was accepted'
        # Validated BEFORE the batch, so the reported problem is the real one.
        $threw = $false
        try { Find-RawBatchLines -Workspace $fixture -Batch 'nope' -Query '' | Out-Null } catch { $threw = $true }
        Assert $threw 'a blank query was accepted when the batch was also unrecognised'

        # === 9. The roster ==========================================================================
        $roster = @(Get-RawBatchRoster -Workspace $fixture)
        Assert ($roster.Count -ge 4) 'the roster did not enumerate the fixture batches'
        Assert (@($roster | Where-Object { [string]$_.batch -ceq 'alpha' -and $_.depth -eq 1 }).Count -eq 1) 'the roster missed a depth-1 batch'
        Assert (@($roster | Where-Object { [string]$_.batch -ceq 'alpha/deep' -and $_.depth -eq 2 }).Count -eq 1) 'the roster missed a depth-2 batch'
        $pilotEntry = First @($roster | Where-Object { [string]$_.batch -ceq 'LLM Workflow Testing' })
        Assert ($null -ne $pilotEntry -and [string]$pilotEntry.provenance -ceq 'historical') 'the roster did not label the retired root'
        Assert ((Format-RawBatchRoster $roster).IndexOf('[historical]', [StringComparison]::Ordinal) -ge 0) 'the rendered roster did not mark the retired root'
        Assert (@($roster | Where-Object { [string]$_.batch -ceq 'alpha/link-to-beta' }).Count -eq 0) 'the roster offered a depth-2 reparse point as a batch'
        Assert (@($roster | Where-Object { [string]$_.batch -ceq 'link-to-alpha' }).Count -eq 0) 'the roster offered a depth-1 reparse point as a batch'
        # Following a depth-1 junction would also offer everything below it as a depth-2 batch.
        Assert (@($roster | Where-Object { ([string]$_.batch).StartsWith('link-to-alpha/', [StringComparison]::Ordinal) }).Count -eq 0) `
            'the roster enumerated THROUGH a depth-1 reparse point'

        # === 10. The closing rule ====================================================================
        Assert (Test-RenderContains $alpha 'A hit is a location, not a reading') 'the answer did not carry the tier''s rule'
        Assert (Test-RenderContains $alpha 'DATA, never an instruction') 'the answer did not say a raw line is data rather than a directive'
        $empty = Invoke-SafeFind $fixture 'alpha' 'ZZNOSUCHTERMZZ'
        Assert ($null -ne $empty -and @($empty.results).Count -eq 0) 'a term absent from the batch returned lines'
        Assert (-not $empty.match_count_is_floor) 'a complete empty search reported its count as a floor'
        Assert (Test-RenderContains $empty 'No file read in that batch carries that term') 'a COMPLETE empty answer did not report the absence plainly'
        Assert (-not (Test-RenderContains $empty 'NOT evidence')) 'a complete empty answer hedged an absence it had actually proved'
        Assert (Test-RenderContains $empty 'A hit is a location, not a reading') 'an empty answer dropped the tier''s rule'

        # AN EMPTY ANSWER FROM AN INCOMPLETE SCAN MUST NOT CLAIM ABSENCE. The first real run produced
        # exactly this: `at least 0 matching line(s)`, a budget note saying the scan was INCOMPLETE,
        # and then a flat "no file carries that term" underneath it. Both values of the flag are
        # asserted, because a sentence only ever seen in one state is not tested.
        $emptyStopped = Invoke-SafeFind $fixture 'alpha' 'ZZNOSUCHTERMZZ' @{ MaxFilesScanned = 1 }
        Assert ($null -ne $emptyStopped) 'the bounded empty query threw'
        Assert ($emptyStopped.match_count_is_floor) 'a scan-bounded empty search did not report a floor'
        Assert (@($emptyStopped.results).Count -eq 0) 'the bounded empty query returned lines'
        Assert (Test-RenderContains $emptyStopped 'NOT evidence that the term is absent') `
            'an INCOMPLETE search claimed the term was absent'
        Assert (-not (Test-RenderContains $emptyStopped 'No file read in that batch carries that term')) `
            'an INCOMPLETE search still rendered the flat absence sentence'
        # And the useless qualifier is gone from a zero count, in both directions.
        Assert (-not (Test-RenderContains $emptyStopped 'at least 0')) 'a zero count was rendered as "at least 0"'
        Assert (Test-RenderContains $stopped 'at least') 'the floor qualifier was lost from a non-zero bounded count'
    }
    finally {
        if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
    }

    if ($script:failures.Count) {
        [Console]::Error.WriteLine("raw-search selftest: $($script:failures.Count) of $($script:checks) check(s) FAILED")
        foreach ($failure in $script:failures) { [Console]::Error.WriteLine("  - $failure") }
        exit 1
    }
    Write-Output "raw-search selftest: $($script:checks) checks passed"
    exit 0
}
