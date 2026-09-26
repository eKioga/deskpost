<#
.SYNOPSIS
    The supported-operation matrix: its shape, its normalisation, and the comparison that decides
    whether a row is green. Dot-sourced; never invoked directly.

.DESCRIPTION
    PLAN-public-release.md step 23. `tools/acceptance-matrix.json` is the matrix itself;
    `tools/AcceptanceFixtures.ps1` builds the workspaces a row runs over;
    `tools/Invoke-AcceptanceMatrix.ps1` is the harness that drives both arms. This file is the part
    with an opinion: what a well-formed row is, what counts as the same outcome, and which
    differences were approved in advance.

    WHY NORMALISATION IS THE WHOLE PROBLEM. Codex's round-1 review of this plan put it plainly:
    "'Zero diffs' is neither achievable nor sufficient." Timestamps, ids and absolute paths differ
    on every run of the SAME implementation, so a raw diff is never green; and two implementations
    can agree on the same defect, so a green diff is not correctness either. What makes the
    comparison mean anything is that everything normalised away is named here, in one place, where
    it can be argued with -- because every value normalised away is a value NEITHER arm is being
    held to.

    AN APPROVED DELTA IS NOT A NORMALISATION, AND THEY ARE KEPT APART ON PURPOSE. A normalisation
    says "this value is incidental in every implementation" -- a wall-clock stamp, the drive the
    fixture happens to sit on. A delta says "these two implementations are SUPPOSED to differ
    here", and step 23 requires each one to be listed and approved before the row it affects can
    go green. So a delta carries a reason, an approver and a date, and `acceptance.matrix-shape`
    fails without them. A delta that matches no row is a stale approval and fails too.

    THE FIELD MAP IS FLAT, AND THAT IS WHAT MAKES A DIFFERENCE READABLE. Both arms are reduced to
    `field -> value`: `exit`, `result.<dotted path>` when stdout parsed as JSON, `stdout` when it
    did not, `stderr`, and one `effect.<relative path>` per file the operation left behind. A
    difference then names a field rather than pointing at two blobs, and a delta can be scoped to
    exactly the fields it was approved for.

    THE EFFECT IS PART OF THE OUTCOME, WHICH IS THE HALF A RETURN VALUE CANNOT COVER. A port that
    returns the right JSON and writes the wrong files is wrong, and nothing in stdout would say
    so. Every file under the fixture workspace is hashed after the run -- content normalised
    first, so a stamp inside a file is no more significant than a stamp in stdout.
#>

Set-StrictMode -Version Latest

# THE FIXTURE IDS COME FROM THE GENERATOR, NEVER FROM A COPY. `acceptance.matrix-shape` asks
# whether every row names a fixture that can be built, and a second list of fixture names here
# would answer that question against itself.
. (Join-Path $PSScriptRoot 'AcceptanceFixtures.ps1')

function Get-AcceptanceMatrixPath {
    Join-Path $PSScriptRoot 'acceptance-matrix.json'
}

function Get-AcceptanceMatrix {
    <#
    .SYNOPSIS
        Read and validate the matrix. Throws on a malformed one rather than returning it.
    #>
    [CmdletBinding()]
    param(
        [string]$ProgramRoot,
        # For the shape check itself, which must be able to report every problem rather than die on
        # the first one.
        [switch]$SkipShapeCheck
    )
    if ([string]::IsNullOrWhiteSpace($ProgramRoot)) { $ProgramRoot = Split-Path -Parent $PSScriptRoot }
    $path = Get-AcceptanceMatrixPath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'tools/acceptance-matrix.json is missing.' }
    $matrix = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json
    if (-not $SkipShapeCheck) {
        $problems = @(Test-AcceptanceMatrixShape -Matrix $matrix -ProgramRoot $ProgramRoot)
        if ($problems.Count) { throw ('the acceptance matrix is malformed: ' + ($problems -join '; ')) }
    }
    $matrix
}

function Get-AcceptanceMatrixRow {
    param([Parameter(Mandatory = $true)]$Matrix, [Parameter(Mandatory = $true)][string]$Id)
    $row = @(@($Matrix.rows) | Where-Object { [string]$_.id -ceq $Id })
    if (-not $row.Count) {
        throw "the acceptance matrix has no row '$Id'. `tools/Invoke-AcceptanceMatrix.ps1 -List` prints every id."
    }
    $row[0]
}

function Get-AcceptanceObjectKeys {
    # Defect family 4: reading .PSObject.Properties.Name on an empty collection throws under
    # Set-StrictMode. Enumerate instead.
    #
    # A DICTIONARY IS NOT A PSCustomObject, and the two arrive at the same functions here: the
    # matrix is parsed JSON (custom objects) and an effect is built as an [ordered] map.
    # `.PSObject.Properties` on an OrderedDictionary yields Count, Keys and Values -- three
    # property names that are not keys -- so a comparison built on it would compare the wrong
    # thing and never say so.
    param($Object)
    if ($null -eq $Object) { return @() }
    if ($Object -is [Collections.IDictionary]) { return @($Object.Keys) }
    @(@($Object.PSObject.Properties) | ForEach-Object { $_.Name })
}

function Get-AcceptanceOptionalValue {
    <# One optional scalar field. Reading an absent property throws under StrictMode. #>
    param($Object, [Parameter(Mandatory = $true)][string]$Name)
    if (@(Get-AcceptanceObjectKeys $Object) -ccontains $Name) { return $Object.$Name }
    $null
}

function Compare-AcceptanceEffect {
    <#
    .SYNOPSIS
        The paths that differ between two effects, as `path (added|removed|changed)`.

    .DESCRIPTION
        What makes `readonly` a property rather than a promise. A read that writes is a defect in
        either implementation, and it is the one thing the matrix can decide before a kernel
        exists -- so it is decided on every run rather than left for the comparison that cannot
        happen yet.
    #>
    param([Parameter(Mandatory = $true)]$Before, [Parameter(Mandatory = $true)]$After)
    $beforeKeys = @(Get-AcceptanceObjectKeys $Before)
    $afterKeys = @(Get-AcceptanceObjectKeys $After)

    $touched = [Collections.Generic.List[string]]::new()
    foreach ($path in @(@(@($beforeKeys) + @($afterKeys)) | Sort-Object -Unique -CaseSensitive)) {
        $inBefore = $beforeKeys -ccontains $path
        $inAfter = $afterKeys -ccontains $path
        if ($inBefore -and -not $inAfter) { [void]$touched.Add("$path (removed)"); continue }
        if ($inAfter -and -not $inBefore) { [void]$touched.Add("$path (added)"); continue }
        if ([string]$Before[$path] -cne [string]$After[$path]) { [void]$touched.Add("$path (changed)") }
    }
    @($touched)
}

function Get-AcceptanceOptionalList {
    <# One optional array field, as an array. Reading an absent property throws under StrictMode. #>
    param($Object, [Parameter(Mandatory = $true)][string]$Name)
    if (@(Get-AcceptanceObjectKeys $Object) -ccontains $Name) { return @($Object.$Name) }
    @()
}

function Test-AcceptanceRowSelector {
    <#
    .SYNOPSIS
        Does one `applies_to` selector cover this row? `*`, `area:<area>`, or an exact row id.
    #>
    param([Parameter(Mandatory = $true)][string]$Selector, [Parameter(Mandatory = $true)]$Row)
    if ($Selector -ceq '*') { return $true }
    if ($Selector -cmatch '^area:(.+)$') { return ([string]$Row.area -ceq $Matches[1]) }
    [string]$Row.id -ceq $Selector
}

function Get-AcceptanceRowDeltas {
    <#
    .SYNOPSIS
        The deltas approved for one row, derived from each delta's `applies_to`.

    .DESCRIPTION
        DERIVED, NEVER LISTED TWICE. An earlier draft carried the delta ids on the row AS WELL as
        the selector on the delta, which is the shape `.claude/rules/library-development.md` names
        as a list standing for a table: two sources, one of which falls behind. The selector is the
        authority and the rendered document shows what it selects.
    #>
    param([Parameter(Mandatory = $true)]$Matrix, [Parameter(Mandatory = $true)]$Row)
    $applicable = [Collections.Generic.List[string]]::new()
    foreach ($name in @(Get-AcceptanceObjectKeys $Matrix.deltas)) {
        $delta = $Matrix.deltas.$name
        foreach ($selector in @($delta.applies_to)) {
            if (Test-AcceptanceRowSelector -Selector ([string]$selector) -Row $Row) {
                [void]$applicable.Add($name)
                break
            }
        }
    }
    @($applicable)
}

function Test-AcceptanceStepArguments {
    <#
    .SYNOPSIS
        Every way a PowerShell step's arguments would fail to bind to its script. Empty means they bind.

    .DESCRIPTION
        RESOLVING THE SCRIPT WAS HALF THE CHECK (S31). Until then `acceptance.matrix-shape` proved a
        step's script existed and nothing about what it passed, and five of the six `hub` rows called
        their oracle with `-Slug` and `-Json`, which none of those helpers declares -- the Report Inbox,
        2026-09-22. Skipped offline, those rows would have failed to bind the first day they ran against
        the NAS, and the gate was green over them.

        SO THE ARGUMENTS ARE BOUND AS POWERSHELL BINDS THEM, against the script's own declaration
        rather than a copy of it: an exact name or alias, else a prefix of exactly one (an ambiguous
        prefix is refused), a switch taking no value, any other parameter taking the next word, and
        at least one parameter set that holds every argument passed and every mandatory parameter it
        declares. A positional argument is refused outright, because a row that names nothing cannot
        be checked, and no row has needed one.

        What it cannot see is whether a VALUE is valid -- `{workspace}` is resolved when the row runs.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Script, [AllowEmptyCollection()][object[]]$Arguments = @())

    if (-not (Test-Path -LiteralPath 'variable:script:AcceptanceScriptCommands')) { $script:AcceptanceScriptCommands = @{} }
    if (-not $script:AcceptanceScriptCommands.ContainsKey($Script)) {
        try {
            $info = Get-Command -Name $Script -CommandType ExternalScript -ErrorAction Stop
            [void]$info.Parameters   # a script that does not parse throws here, not at the first use
            $script:AcceptanceScriptCommands[$Script] = $info
        }
        catch { return @("and its parameters could not be read: $($_.Exception.Message)") }
    }
    $command = $script:AcceptanceScriptCommands[$Script]

    # A SCRIPT WITH NO param() BLOCK RECEIVES EVERY ARGUMENT IN $args, and three the rows call are
    # written that way on purpose: `library.ps1` forwards its words untouched, and `ShelfCatalog.ps1`
    # and `NotebookIndex.ps1` are libraries a caller dot-sources that answer `-Render` when run.
    # Nothing binds there, so there is nothing to check here; the row running is what proves them.
    if ($null -eq $command.ScriptBlock.Ast.ParamBlock) { return @() }

    $problems = [Collections.Generic.List[string]]::new()
    $bound = [Collections.Generic.List[string]]::new()
    $words = @($Arguments | ForEach-Object { [string]$_ })
    for ($i = 0; $i -lt $words.Count; $i++) {
        $word = $words[$i]
        if ($word -cnotmatch '^-([A-Za-z_][A-Za-z0-9_]*)(:.*)?$') {
            [void]$problems.Add("with the positional argument '$word'; name the parameter it binds to")
            continue
        }
        $name = $Matches[1]
        $hasValue = [bool]$Matches[2]
        $candidates = @(@($command.Parameters.Values) | Where-Object { $_.Name -ieq $name -or @($_.Aliases) -icontains $name })
        if (-not $candidates.Count) {
            $candidates = @(@($command.Parameters.Values) | Where-Object {
                    $_.Name.StartsWith($name, [StringComparison]::OrdinalIgnoreCase) -or
                    @(@($_.Aliases) | Where-Object { ([string]$_).StartsWith($name, [StringComparison]::OrdinalIgnoreCase) }).Count
                })
        }
        if (-not $candidates.Count) { [void]$problems.Add("with -$name, which it does not declare"); continue }
        if ($candidates.Count -gt 1) { [void]$problems.Add("with -$name, which is ambiguous between -$((@($candidates) | ForEach-Object Name) -join ', -')"); continue }
        $parameter = $candidates[0]
        if ($bound -icontains $parameter.Name) { [void]$problems.Add("with -$($parameter.Name) more than once") }
        [void]$bound.Add($parameter.Name)
        if ($parameter.ParameterType -ne [switch] -and -not $hasValue) {
            if ($i + 1 -ge $words.Count -or $words[$i + 1] -cmatch '^-[A-Za-z_]') {
                [void]$problems.Add("with -$($parameter.Name) and no value for it")
            }
            else { $i++ }
        }
    }
    if ($problems.Count) { return @($problems) }

    # A PARAMETER SET, NOT A PARAMETER, IS WHAT BINDS. Every script here declares one set today; the
    # rule is written for the one that declares two, where a mandatory parameter of the other set is
    # no obligation and an argument that only the other set holds is.
    $unmet = @()
    foreach ($set in @($command.ParameterSets)) {
        $names = @(@($set.Parameters) | ForEach-Object Name)
        $stray = @($bound | Where-Object { $names -inotcontains $_ })
        $missing = @(@($set.Parameters) | Where-Object { $_.IsMandatory -and $bound -inotcontains $_.Name } | ForEach-Object Name)
        if (-not $stray.Count -and -not $missing.Count) { return @() }
        $unmet += , "without -$($missing -join ', -')"
        if ($stray.Count) { $unmet[-1] = "with -$($stray -join ', -') outside parameter set '$($set.Name)'" }
    }
    if (@($command.ParameterSets).Count -eq 1) { return @($unmet[0] -replace '^without -', 'without the mandatory -') }
    @("and binds no parameter set: $($unmet -join '; ')")
}

function Test-AcceptanceMatrixShape {
    <#
    .SYNOPSIS
        Every structural problem with the matrix, as a list. Empty means well formed.

    .DESCRIPTION
        A LIST RATHER THAN A THROW, so one run names every problem instead of the first.

        IT RESOLVES EVERY PATH IT READS. S21 cost a day to `codex.project-access-config`, which
        asserted the script names and matchers of a configuration document and never opened one of
        the five files it named -- all five had been gone since S17, and the check passed. So every
        `powershell.steps[].script` here is resolved on disk under the program root. The kernel's
        command line is deliberately NOT resolved: it is a specification of a CLI that does not
        exist yet, and pretending to verify it would be the same mistake in the other direction.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Matrix, [string]$ProgramRoot)
    if ([string]::IsNullOrWhiteSpace($ProgramRoot)) { $ProgramRoot = Split-Path -Parent $PSScriptRoot }

    $problems = [Collections.Generic.List[string]]::new()

    foreach ($required in @('version', 'areas', 'classes', 'oracles', 'requirements', 'deltas', 'excluded_helpers', 'rows')) {
        if (@(Get-AcceptanceObjectKeys $Matrix) -cnotcontains $required) {
            [void]$problems.Add("the matrix has no '$required' section")
        }
    }
    if ($problems.Count) { return @($problems) }

    $areas = @(Get-AcceptanceObjectKeys $Matrix.areas)
    $classes = @(Get-AcceptanceObjectKeys $Matrix.classes)
    $oracles = @(Get-AcceptanceObjectKeys $Matrix.oracles)
    $requirements = @(Get-AcceptanceObjectKeys $Matrix.requirements)
    $fixtures = @(Get-AcceptanceFixtureIds)
    $rows = @($Matrix.rows)
    if (-not $rows.Count) { [void]$problems.Add('the matrix declares no rows'); return @($problems) }

    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $areasUsed = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $fixturesUsed = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)

    foreach ($row in $rows) {
        $id = [string]$row.id
        if ([string]::IsNullOrWhiteSpace($id)) { [void]$problems.Add('a row has no id'); continue }
        # Lowercase, dotted, hyphenated. -cnotmatch, not -notmatch: defect family 1 is a
        # case-insensitive operator on a lowercase-only rule, and this is exactly such a rule.
        if ($id -cnotmatch '^[a-z0-9]+(\.[a-z0-9-]+)+$') {
            [void]$problems.Add("row id '$id' is not a lowercase dotted slug")
        }
        if (-not $seen.Add($id)) { [void]$problems.Add("row id '$id' appears more than once") }

        $area = [string]$row.area
        if ($areas -cnotcontains $area) { [void]$problems.Add("row '$id' names area '$area', which is not declared") }
        else { [void]$areasUsed.Add($area) }

        if ($classes -cnotcontains [string]$row.class) { [void]$problems.Add("row '$id' names class '$($row.class)', which is not declared") }
        if ($oracles -cnotcontains [string]$row.oracle) { [void]$problems.Add("row '$id' names oracle '$($row.oracle)', which is not declared") }
        if ([string]::IsNullOrWhiteSpace([string]$row.operation)) { [void]$problems.Add("row '$id' states no operation") }

        # STEP 23'S OWN CRITERION: every matrix row has a fixture, and the fixture is one this
        # generator can really build.
        $fixture = [string]$row.fixture
        if ($fixtures -cnotcontains $fixture) {
            [void]$problems.Add("row '$id' names fixture '$fixture', which AcceptanceFixtures.ps1 does not build")
        }
        else { [void]$fixturesUsed.Add($fixture) }

        foreach ($requirement in @(Get-AcceptanceOptionalList -Object $row -Name 'requires')) {
            if ($requirements -cnotcontains [string]$requirement) {
                [void]$problems.Add("row '$id' requires '$requirement', which is not declared")
            }
        }

        # A ROW'S `prepare` MAY ONLY WRITE WHOLE FILES INSIDE ITS OWN WORKSPACE (S17). It is applied
        # to both arms before anything runs, so a path that climbed out would write beside the
        # fixture -- somewhere neither arm's effect is read from -- and a rooted one could write
        # anywhere at all. See Invoke-AcceptancePrepare.
        foreach ($entry in @(Get-AcceptanceOptionalList -Object $row -Name 'prepare')) {
            $preparePath = [string]$entry.path
            if ([string]::IsNullOrWhiteSpace($preparePath)) { [void]$problems.Add("row '$id' has a prepare entry with no path"); continue }
            if ([IO.Path]::IsPathRooted($preparePath) -or @($preparePath -split '[\\/]') -ccontains '..') {
                [void]$problems.Add("row '$id' prepares '$preparePath', which is not a path inside its workspace")
            }
            if ($null -eq $entry.text -or $entry.text -isnot [string]) { [void]$problems.Add("row '$id' prepares '$preparePath' with no text") }
        }

        # A `seed` IS A WRITER RUN INTO THE ROW'S DISPOSABLE PROJECT (S33), so it exists only on a row
        # that has one, and it is held to every rule a PowerShell step is: a script on disk, arguments
        # that bind, and -ProjectId {collection_id} wherever the script declares it. See Invoke-AcceptanceSeed.
        $seeds = @(Get-AcceptanceOptionalList -Object $row -Name 'seed')
        if ($seeds.Count -and @(Get-AcceptanceOptionalList -Object $row -Name 'requires') -cnotcontains 'shared-collection') {
            [void]$problems.Add("row '$id' seeds a collection and does not require the shared collection, so there is no disposable project to seed")
        }
        foreach ($seed in $seeds) {
            if (@(Get-AcceptanceObjectKeys $seed) -ccontains 'collection_note') {
                if ([string]$seed.collection_note -cnotmatch '^[a-z0-9][a-z0-9_-]*(/[a-z0-9_][a-z0-9_-]*)*/[A-Za-z0-9_][A-Za-z0-9_-]*$') {
                    [void]$problems.Add("row '$id' seeds the collection note '$($seed.collection_note)', which is not a note path inside its project")
                }
                if ($null -eq $seed.text -or $seed.text -isnot [string]) { [void]$problems.Add("row '$id' seeds the collection note '$($seed.collection_note)' with no text") }
                continue
            }
            # `collection_delete` (S43): one note removed from the arm's project, for the state a writer that
            # was stopped part way leaves once its obstacle is gone. Nothing else rides on the step.
            if (@(Get-AcceptanceObjectKeys $seed) -ccontains 'collection_delete') {
                if ([string]$seed.collection_delete -cnotmatch '^[a-z0-9][a-z0-9_-]*(/[a-z0-9_][a-z0-9_-]*)*/[A-Za-z0-9_][A-Za-z0-9_-]*$') {
                    [void]$problems.Add("row '$id' deletes the collection note '$($seed.collection_delete)', which is not a note path inside its project")
                }
                foreach ($key in @(Get-AcceptanceObjectKeys $seed)) {
                    if ($key -cne 'collection_delete') { [void]$problems.Add("row '$id' deletes a collection note with a '$key' key, which a delete does not take") }
                }
                continue
            }
            # `expect_failure` (S43): a seed step whose writer is SUPPOSED to stop -- the only way to a state
            # a real writer leaves when it is interrupted. The text it must say is required, so a step that
            # failed for some other reason is still an error rather than a precondition.
            if (@(Get-AcceptanceObjectKeys $seed) -ccontains 'expect_failure') {
                if ($seed.expect_failure -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$seed.expect_failure)) {
                    [void]$problems.Add("row '$id' expects a seed step to fail without saying what it must say")
                }
            }
            $script = [string]$seed.script
            $resolved = Join-Path $ProgramRoot $script
            if ([string]::IsNullOrWhiteSpace($script) -or -not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
                [void]$problems.Add("row '$id' seeds with '$script', which is not a file under the program root"); continue
            }
            $seedArguments = @(Get-AcceptanceOptionalList -Object $seed -Name 'args')
            foreach ($problem in @(Test-AcceptanceStepArguments -Script $resolved -Arguments $seedArguments)) {
                [void]$problems.Add("row '$id' seeds with '$script' $problem")
            }
            if ($script:AcceptanceScriptCommands.ContainsKey($resolved) -and $script:AcceptanceScriptCommands[$resolved].Parameters.ContainsKey('ProjectId')) {
                $at = [Array]::IndexOf([string[]]$seedArguments, '-ProjectId')
                if ($at -lt 0 -or $at + 1 -ge $seedArguments.Count -or [string]$seedArguments[$at + 1] -cne '{collection_id}') {
                    [void]$problems.Add("row '$id' seeds with '$script' without -ProjectId {collection_id}, so it would seed whatever collection that script falls back to")
                }
            }
        }

        # `share_settles_before_arm` (S39) waits out the SMB client's cache after the before-snapshot, so it
        # means something only on a row with a share to list, and it is a flag, not a duration.
        if (@(Get-AcceptanceObjectKeys $row) -ccontains 'share_settles_before_arm') {
            if ($row.share_settles_before_arm -isnot [bool]) { [void]$problems.Add("row '$id' gives share_settles_before_arm a value that is not true or false") }
            elseif (@(Get-AcceptanceOptionalList -Object $row -Name 'requires') -cnotcontains 'shared-collection') {
                [void]$problems.Add("row '$id' settles the share before its arm and does not require the shared collection, so there is no share to settle")
            }
        }

        # An independent row is one the kernel is NOT judged against PowerShell for, so it owes the
        # reason. Without it the distinction decays into "the rows nobody got round to comparing".
        if ([string]$row.oracle -ceq 'independent' -and [string]::IsNullOrWhiteSpace([string]$row.reason)) {
            [void]$problems.Add("row '$id' is independent and states no reason")
        }

        # HOW AN INDEPENDENT ROW IS JUDGED (S41, the reader's ruling): a `judge` -- a command run against the
        # kernel UNDER TEST, whose exit 0 is the row's green -- or, for a row only a real session can show, a
        # `recorded_verdict` bound to the exact release binary. One or the other, only on an independent row,
        # and a judge that never names `{kernel}` would judge whatever it judged before, not the kernel.
        $rowKeys = @(Get-AcceptanceObjectKeys $row)
        $hasJudge = $rowKeys -ccontains 'judge'
        $hasRecorded = $rowKeys -ccontains 'recorded_verdict'
        if (($hasJudge -or $hasRecorded) -and [string]$row.oracle -cne 'independent') {
            [void]$problems.Add("row '$id' declares a judge or a recorded verdict and is not independent; a differential row is judged by its comparison")
        }
        if ($hasJudge -and $hasRecorded) { [void]$problems.Add("row '$id' declares both a judge and a recorded verdict; it is judged one way") }
        if ($hasRecorded -and $row.recorded_verdict -isnot [bool]) { [void]$problems.Add("row '$id' gives recorded_verdict a value that is not true or false") }
        if ($hasJudge) {
            $judgeKeys = @(Get-AcceptanceObjectKeys $row.judge)
            $judgeCommand = @(Get-AcceptanceOptionalList -Object $row.judge -Name 'command')
            if (-not $judgeCommand.Count -or @($judgeCommand | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) }).Count) {
                [void]$problems.Add("row '$id' has a judge with no command, or a command part that is not a string")
            }
            else {
                $judgeText = ($judgeCommand -join ' ')
                if ($judgeKeys -ccontains 'environment') { $judgeText += ' ' + ((@(Get-AcceptanceObjectKeys $row.judge.environment) | ForEach-Object { [string]$row.judge.environment.$_ }) -join ' ') }
                if ($judgeText -cnotmatch '\{kernel\}') { [void]$problems.Add("row '$id' has a judge that never names {kernel}, so it would not judge the kernel under test") }
                foreach ($part in $judgeCommand) {
                    if ($part -cmatch '^(tools|kernel)/' -and -not (Test-Path -LiteralPath (Join-Path $ProgramRoot $part) -PathType Leaf)) {
                        [void]$problems.Add("row '$id' has a judge naming '$part', which is not a file under the program root")
                    }
                }
            }
            foreach ($key in $judgeKeys) {
                if (@('command', 'environment', 'timeout_seconds') -cnotcontains $key) { [void]$problems.Add("row '$id' has a judge key '$key', which is not command, environment or timeout_seconds") }
            }
        }

        foreach ($arm in @('powershell', 'kernel')) {
            if (@(Get-AcceptanceObjectKeys $row) -cnotcontains $arm) { [void]$problems.Add("row '$id' has no '$arm' arm"); continue }
            $steps = @($row.$arm.steps)
            if (-not $steps.Count) { [void]$problems.Add("row '$id' declares no $arm steps"); continue }
            foreach ($step in $steps) {
                if ($arm -ceq 'powershell') {
                    $script = [string]$step.script
                    if ([string]::IsNullOrWhiteSpace($script)) { [void]$problems.Add("row '$id' has a PowerShell step with no script"); continue }
                    $resolved = Join-Path $ProgramRoot $script
                    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
                        [void]$problems.Add("row '$id' names '$script', which is not a file under the program root")
                    }
                    else {
                        $stepArguments = @(Get-AcceptanceOptionalList -Object $step -Name 'args')
                        foreach ($problem in @(Test-AcceptanceStepArguments -Script $resolved -Arguments $stepArguments)) {
                            [void]$problems.Add("row '$id' calls '$script' $problem")
                        }
                        # A SHARED STEP NAMES ITS COLLECTION (S32, the reader's ruling). A helper that
                        # resolves no workspace falls back to the PROGRAM ROOT's pin, which in this
                        # checkout is the reader's own collection; so a step whose script declares
                        # -ProjectId passes the run's disposable project, exactly, and no fallback is asked.
                        if (@(Get-AcceptanceOptionalList -Object $row -Name 'requires') -ccontains 'shared-collection' -and
                            $script:AcceptanceScriptCommands.ContainsKey($resolved) -and
                            $script:AcceptanceScriptCommands[$resolved].Parameters.ContainsKey('ProjectId')) {
                            $at = [Array]::IndexOf([string[]]$stepArguments, '-ProjectId')
                            if ($at -lt 0 -or $at + 1 -ge $stepArguments.Count -or [string]$stepArguments[$at + 1] -cne '{collection_id}') {
                                [void]$problems.Add("row '$id' needs the shared collection and calls '$script' without -ProjectId {collection_id}, so it would address whatever collection that script falls back to")
                            }
                        }
                    }
                }
                else {
                    # A KERNEL STEP MAY WRITE A FILE (S18), for the one input no command produces: a
                    # hand edit, made after the kernel's migration put the file where the kernel reads
                    # it. Whole files inside the workspace, as `prepare` -- and never the LAST step,
                    # because the outcome compared is the last command's.
                    if (@(Get-AcceptanceObjectKeys $step) -ccontains 'write') {
                        foreach ($entry in @($step.write)) {
                            $writePath = [string]$entry.path
                            if ([string]::IsNullOrWhiteSpace($writePath) -or [IO.Path]::IsPathRooted($writePath) -or @($writePath -split '[\\/]') -ccontains '..') {
                                [void]$problems.Add("row '$id' has a kernel write step naming '$writePath', which is not a path inside its workspace")
                            }
                            if ($null -eq $entry.text -or $entry.text -isnot [string]) { [void]$problems.Add("row '$id' has a kernel write step for '$writePath' with no text") }
                        }
                        if ([object]::ReferenceEquals($step, $steps[-1])) { [void]$problems.Add("row '$id' ends on a write step, so no command's outcome is compared") }
                    }
                    elseif (-not @(Get-AcceptanceOptionalList -Object $step -Name 'command').Count) { [void]$problems.Add("row '$id' has a kernel step with no command") }
                }
            }
        }
    }

    # BOTH DIRECTIONS, never a count. A declared area with no row is a gap in the enumeration; a
    # fixture nothing uses is a shape being maintained for nobody.
    foreach ($area in @($areas)) {
        if (-not $areasUsed.Contains($area)) { [void]$problems.Add("area '$area' is declared and no row is in it") }
    }
    foreach ($fixture in @($fixtures)) {
        if (-not $fixturesUsed.Contains($fixture)) { [void]$problems.Add("fixture '$fixture' is built and no row uses it") }
    }

    # THERE IS NO EXEMPTION LIST FOR `readonly`, AND THAT WAS A DECISION RATHER THAN AN OMISSION.
    # One was written on 2026-09-22 for the seat's advisory activity record, which a Desk command
    # appeared to write even when it refused. Disabling the exemption and re-running the whole
    # matrix reported NOTHING dirty: the refusal had been writing because that row invoked the
    # wrong operation, not because the record is unavoidable. An exemption that exempts nothing is
    # an invitation to add the next finding to it instead of fixing it, so the mechanism came out
    # with the mistaken evidence for it.
    foreach ($name in @(Get-AcceptanceObjectKeys $Matrix.deltas)) {
        $delta = $Matrix.deltas.$name
        foreach ($field in @('reason', 'approved_by', 'approved_on', 'applies_to')) {
            if (@(Get-AcceptanceObjectKeys $delta) -cnotcontains $field) {
                [void]$problems.Add("delta '$name' has no '$field'; step 23 requires every intentional delta to be listed AND approved")
            }
        }
        $deltaKeys = @(Get-AcceptanceObjectKeys $delta)
        if (($deltaKeys -ccontains 'match') -eq ($deltaKeys -ccontains 'rebase')) {
            [void]$problems.Add("delta '$name' must carry exactly one of 'match' and 'rebase'")
        }
        if ($deltaKeys -ccontains 'rebase') {
            foreach ($problem in @(Test-AcceptanceRebaseShape -Name $name -Rebase $delta.rebase)) { [void]$problems.Add($problem) }
        }
        if ($deltaKeys -ccontains 'match') {
            $pattern = [string]$delta.match.field_pattern
            if ([string]::IsNullOrWhiteSpace($pattern)) { [void]$problems.Add("delta '$name' has no match.field_pattern") }
            else {
                try { [void][regex]::new($pattern) }
                catch { [void]$problems.Add("delta '$name' has an unusable field_pattern: $($_.Exception.Message)") }
            }
        }
        $covers = @(@($rows) | Where-Object { @(Get-AcceptanceRowDeltas -Matrix $Matrix -Row $_) -ccontains $name })
        if (-not $covers.Count) { [void]$problems.Add("delta '$name' is approved for no row, so it is a stale approval") }
    }

    @($problems)
}

function Test-AcceptanceKernelCommands {
    <#
    .SYNOPSIS
        Every row whose kernel command names something the CLI does not answer to. Empty means every
        row's verb, action and tool exists.

    .DESCRIPTION
        THE ASYMMETRY THIS CLOSES WAS NAMED BEFORE IT COULD BE CLOSED. `Test-AcceptanceMatrixShape`
        resolves every PowerShell script a row names on disk and deliberately checks NOTHING on the
        kernel side, because when the matrix was written there was no kernel: a row's kernel command
        was a specification of a CLI that did not exist, and pretending to verify it would have been
        S21's `codex.project-access-config` defect in the other direction. S12's kickoff put the cost
        plainly -- "a row naming `library shelf render` when the verb is `library shelf rerender`
        would sit green-adjacent and pending forever, and no check would say so."

        A kernel exists as of 2026-09-22 (S13), so the specification became checkable, and this is
        the half that checks it. ASKED OF THE CLI RATHER THAN KEPT BESIDE IT: `library verbs --json`
        prints the dispatcher's own table, which is the same rule `docs/mcp-tool-allowlist-check.md`
        settled for the reader's tool list. A second copy of a verb list here would be a second
        chance to be wrong about the thing being checked.

        A RECOGNISED VERB IS NOT A PORTED ONE, and this must not conflate them. `shelf rename`
        refuses "not ported yet" and is still a name a row may legitimately carry -- that row then
        MISMATCHES honestly when it runs. What this refuses is a row naming a verb, an action or a
        tool no dispatch branch will ever see, which no run would ever report as anything but a
        difference about something else.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Matrix,
        # The parsed `library verbs --json` document.
        [Parameter(Mandatory = $true)]$Inventory
    )

    $problems = [Collections.Generic.List[string]]::new()
    $verbNames = @(Get-AcceptanceObjectKeys $Inventory.verbs)
    if (-not $verbNames.Count) { return @('the kernel reported no verbs at all, so no row could be resolved against it') }
    $readerTools = @(@($Inventory.reader_tools) | ForEach-Object { [string]$_ })

    foreach ($row in @($Matrix.rows)) {
        $id = [string]$row.id
        if (@(Get-AcceptanceObjectKeys $row) -cnotcontains 'kernel') { continue }
        foreach ($step in @($row.kernel.steps)) {
            $command = @(@(Get-AcceptanceOptionalList -Object $step -Name 'command') | ForEach-Object { [string]$_ })
            if (-not $command.Count) { continue }
            $verb = $command[0]
            if ($verbNames -cnotcontains $verb) {
                [void]$problems.Add("row '$id' names kernel verb '$verb', which `library verbs` does not list")
                continue
            }
            $actions = @(@($Inventory.verbs.$verb.actions) | ForEach-Object { [string]$_ })
            if (-not $actions.Count) { continue }
            # ONLY A WORD IS RESOLVED, NEVER A VALUE. A second token starting with `--` means the
            # verb was invoked bare, which several of them legitimately are (`library desk --json`,
            # `library reset --preflight`); and a verb the CLI marks `positional` takes DATA in that
            # slot -- a Book slug, a batch, a folder -- which no check can resolve and which
            # pretending to resolve would be the kernel-side version of the very mistake this
            # function exists to end.
            if ($command.Count -lt 2) { continue }
            $action = $command[1]
            if ($action.StartsWith('--')) { continue }
            if ([bool]$Inventory.verbs.$verb.positional) { continue }
            if ($actions -cnotcontains $action) {
                [void]$problems.Add("row '$id' names kernel action '$verb $action', which ``library verbs`` does not list; $verb has: " + ($actions -join ', '))
                continue
            }
            # `mcp call <tool>` carries a third name, and it is the one most likely to drift: the
            # reader's tools are added and renamed far more often than the CLI's verbs are.
            if ($verb -ceq 'mcp' -and $action -ceq 'call') {
                if ($command.Count -lt 3) {
                    [void]$problems.Add("row '$id' names 'mcp call' with no tool")
                    continue
                }
                if ($readerTools -cnotcontains $command[2]) {
                    [void]$problems.Add("row '$id' calls reader tool '$($command[2])', which `library verbs` does not list")
                }
            }
        }
    }

    @($problems)
}

function Test-AcceptanceMatrixCoverage {
    <#
    .SYNOPSIS
        Every public helper is either exercised by a row or excluded with a reason. Returns the
        problems, empty when the enumeration is complete.

    .DESCRIPTION
        THIS IS THE ANSWER TO "an unenumerated scenario set can omit recovery, publication, refresh
        or archive behaviour entirely" -- Codex's round-1 finding 23, which is why step 23 exists at
        all. A matrix that enumerates whatever its author remembered is not an oracle. The second
        source is `tools/_helpers.json`, which the gate already keeps honest against the files on
        disk in both directions, so a helper cannot be added without this check seeing it.

        BOTH DIRECTIONS. A helper with no row and no exclusion is an operation nobody decided
        about; an exclusion naming a helper that is not public is an exclusion arguing with a file
        that moved.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Matrix, [string]$ProgramRoot)
    if ([string]::IsNullOrWhiteSpace($ProgramRoot)) { $ProgramRoot = Split-Path -Parent $PSScriptRoot }

    $problems = [Collections.Generic.List[string]]::new()
    $manifestPath = Join-Path $PSScriptRoot '_helpers.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        [void]$problems.Add('tools/_helpers.json is missing, so coverage cannot be decided')
        return @($problems)
    }
    $manifest = [IO.File]::ReadAllText($manifestPath, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json
    $public = @(@($manifest.helpers.PSObject.Properties) | Where-Object { [string]$_.Value.role -ceq 'public' } | ForEach-Object { $_.Name })

    $named = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($row in @($Matrix.rows)) {
        foreach ($step in @($row.powershell.steps)) {
            [void]$named.Add((Split-Path -Leaf ([string]$step.script)))
        }
    }

    $excludedClasses = @('not-ported', 'maintainer-only', 'deferred')
    $excluded = @(Get-AcceptanceObjectKeys $Matrix.excluded_helpers)
    foreach ($name in @($excluded)) {
        $entry = $Matrix.excluded_helpers.$name
        if ($public -cnotcontains $name) {
            [void]$problems.Add("excluded_helpers names '$name', which is not a public helper in _helpers.json")
        }
        if ($excludedClasses -cnotcontains [string]$entry.class) {
            [void]$problems.Add("excluded_helpers['$name'] has class '$($entry.class)', which is not one of: $($excludedClasses -join ', ')")
        }
        if ([string]::IsNullOrWhiteSpace([string]$entry.reason)) {
            [void]$problems.Add("excluded_helpers['$name'] states no reason")
        }
        if ($named.Contains($name)) {
            [void]$problems.Add("'$name' is excluded AND exercised by a row; it cannot be both")
        }
    }

    foreach ($name in @($public)) {
        if ($named.Contains($name)) { continue }
        if ($excluded -ccontains $name) { continue }
        [void]$problems.Add("public helper '$name' has no matrix row and no exclusion")
    }

    @($problems)
}

# --- The installed kernel's remedies (S47, ADR-0045) ----------------------------------------------

# A COMPILED KERNEL ON WINDOWS SAYS A REMEDY AS A COMMAND THE READER CAN RUN (kernel/src/remedy.ts): a
# ported helper becomes its `library` verb, and one with no port is named by its full path in the
# installed program. The oracle keeps its own sentences, so when the kernel under test is compiled the
# PowerShell arm's sentences pass through THIS rewrite before the two are compared -- one rule, the
# reader's ruling, rather than a delta per row. It is a second implementation, written from the kernel's
# and never calling it, so the matrix judges the kernel's rewrite rather than repeating it. `$` in the
# kernel's pattern is JavaScript's end of input, spelled `\z` here.
$script:RemedyValue = '(?:<[^>\s]+>|[A-Za-z0-9_][A-Za-z0-9_.-]*[A-Za-z0-9_]|[A-Za-z0-9_]|\.(?=[\s)]|\z))'
$script:RemedyKeys = @('next', 'remedy', 'detail', 'message', 'reason', 'refusal', 'hint', 'repair', 'guidance', 'permissionDecisionReason', 'additionalContext')

# A FIELD NAMED `*_route` IS A COMMAND TO RUN, SO IT IS A REMEDY (S49, the reader's ruling): `library desk`'s
# `quarantine.list_route` and the restore's `show_route` and `restore_route` named a PowerShell helper on POSIX
# and from a compiled Windows kernel. Every such key, not a list of three, so a route added later is covered.
function Test-AcceptanceRemedyKey([string]$Key) {
    $null -ne $Key -and ($script:RemedyKeys -ccontains $Key -or $Key.EndsWith('_route', [StringComparison]::Ordinal))
}

function Get-AcceptanceRemedyParameters([string]$Text) {
    $found = @{}
    foreach ($match in [regex]::Matches($Text, "-([A-Za-z]+)(?:\s+($($script:RemedyValue)))?")) {
        $found[$match.Groups[1].Value.ToLowerInvariant()] = if ($match.Groups[2].Success) { $match.Groups[2].Value } else { '' }
    }
    $found
}

function ConvertTo-AcceptanceInstalledRemedy {
    <#
    .SYNOPSIS
        One sentence as a compiled kernel on Windows says it. -ProgramRoot is spelled as the kernel arm's
        text is normalised, `<program>`.
    #>
    param([AllowEmptyString()][string]$Text, [string]$ProgramRoot = '<program>')
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $out = $Text
    if ($out.Contains('.ps1')) {
        $pattern = "tools/([A-Za-z-]+)\.ps1((?:\s+-[A-Za-z]+(?:\s+$($script:RemedyValue))?)*)"
        $out = [regex]::Replace($out, $pattern, {
                param($m)
                $helper = $m.Groups[1].Value
                $rest = $m.Groups[2].Value
                $given = Get-AcceptanceRemedyParameters $rest
                $named = { param($key, $default) if ($given.ContainsKey($key)) { $given[$key] } else { $default } }
                $replaced = switch -CaseSensitive ($helper) {
                    'Set-VirtualDesk' {
                        $action = (& $named 'action' 'open').ToLowerInvariant()
                        if (@('open', 'close', 'clear') -notcontains $action) { $null }
                        elseif ($action -eq 'clear') { 'library desk clear' }
                        else {
                            $parts = @('library desk', $action, $(if ((& $named 'kind' 'book').ToLowerInvariant() -eq 'project') { 'project' } else { 'book' }), (& $named 'slug' '<slug>'))
                            if ((& $named 'location' '').ToLowerInvariant() -eq 'shelf') { $parts += '--location shelf' }
                            if ((& $named 'shelf' '').ToLowerInvariant() -eq 'archive') { $parts += '--shelf archive' }
                            $parts -join ' '
                        }
                    }
                    'Enter-LibrarySeat' { "library seat enter $(& $named 'seat' '<name>')" + $(if ($given['project']) { " --create --project $($given['project'])" } else { '' }) }
                    'Start-LibrarySeat' { "library seat start $(& $named 'seat' '<name>')" + $(if ($given['project']) { " --project $($given['project'])" } else { '' }) }
                    'Retire-Seat' { "library seat retire $(& $named 'seat' '<name>')" }
                    'Get-DeskOverview' { 'library desk' }
                    'ShelfCatalog' { if ($given.ContainsKey('render')) { 'library shelf render' } else { $null } }
                    'NotebookIndex' { if ($given.ContainsKey('render')) { 'library notebook render' } else { $null } }
                    'Add-ShelfNote' { "library capture $(& $named 'bookslug' '<book>') --title <title> --body <text>" }
                    'Restore-NotebookQuarantine' {
                        if ($given.ContainsKey('list')) { 'library reset restore --list' }
                        elseif ($given.ContainsKey('quarantine')) {
                            $parts = @('library reset restore --quarantine', $given['quarantine'])
                            if ($given.ContainsKey('show')) { $parts += '--show' }
                            if ($given['topic']) { $parts += "--topic $($given['topic'])" }
                            if ($given.ContainsKey('adopt')) { $parts += '--adopt' }
                            if ($given.ContainsKey('preflight')) { $parts += '--preflight' }
                            if ($given['planid']) { $parts += "--plan-id $($given['planid'])" }
                            $parts -join ' '
                        }
                        else { 'library reset restore' }
                    }
                    default { $null }
                }
                if ($null -ne $replaced) { return [string]$replaced }
                "powershell -ExecutionPolicy Bypass -File `"$ProgramRoot\tools\$helper.ps1`"$rest"
            })
    }
    $out = [regex]::Replace($out, '\bpass -WorkspacePath\b', 'pass --workspace')
    [regex]::Replace($out, '\bpass -Seat\b', 'pass --seat')
}

function ConvertTo-AcceptanceInstalledRemedyFields {
    <# A result with its remedy fields rewritten, as the kernel's hostRemedyFields walks one; content is never touched. #>
    param($Value, [string]$Key = $null, [string]$ProgramRoot = '<program>', [switch]$InError)
    # EVERY VALUE IS RETURNED UNWRAPPED (S47, measured). A string that comes back from a pipeline is wrapped in a
    # PSObject, and Windows PowerShell 5.1 serialises a wrapped string as `{"Length":7}`; and `-is [pscustomobject]`
    # is true of ANY wrapped value, a string or a number included. So the base object is taken first, and a custom
    # object is recognised by its real type.
    if ($null -eq $Value) { return $null }
    if ($Value -is [psobject] -and $Value.psobject.BaseObject -isnot [Management.Automation.PSCustomObject]) { $Value = $Value.psobject.BaseObject }
    if ($Value -is [string]) {
        # A reader tool's ERROR text is a remedy too (kernel/src/reader.ts: `if (isError) text = hostRemedies(text)`).
        if ((Test-AcceptanceRemedyKey $Key) -or ($InError -and $Key -ceq 'text')) { return [string](ConvertTo-AcceptanceInstalledRemedy -Text $Value -ProgramRoot $ProgramRoot) }
        return [string]$Value
    }
    if ($Value -is [Collections.IDictionary]) {
        $copy = [ordered]@{}
        $inError = $InError -or ($Value.Contains('isError') -and $Value['isError'] -eq $true)
        foreach ($name in @($Value.Keys)) { $copy[$name] = ConvertTo-AcceptanceInstalledRemedyFields -Value $Value[$name] -Key ([string]$name) -ProgramRoot $ProgramRoot -InError:$inError }
        return $copy
    }
    if ($Value -is [Management.Automation.PSCustomObject]) {
        $copy = [ordered]@{}
        $inError = $InError -or ($null -ne $Value.PSObject.Properties['isError'] -and $Value.isError -eq $true)
        foreach ($property in $Value.PSObject.Properties) { $copy[$property.Name] = ConvertTo-AcceptanceInstalledRemedyFields -Value $property.Value -Key $property.Name -ProgramRoot $ProgramRoot -InError:$inError }
        return [pscustomobject]$copy
    }
    if ($Value -is [Collections.IEnumerable]) {
        return , @(@($Value) | ForEach-Object { ConvertTo-AcceptanceInstalledRemedyFields -Value $_ -Key $Key -ProgramRoot $ProgramRoot -InError:$InError })
    }
    $Value
}

# --- Normalisation --------------------------------------------------------------------------------

function Get-AcceptanceNormalisationTokens {
    <#
    .SYNOPSIS
        The literal strings that are replaced before two arms are compared, longest first.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Fixture,
        # The ARM's program root: the kernel's own in the kernel arm (S29, alone since S30). See
        # Get-AcceptanceArmProgramRoot in Invoke-AcceptanceMatrix.ps1.
        [string]$ProgramRoot
    )
    if ([string]::IsNullOrWhiteSpace($ProgramRoot)) { $ProgramRoot = Split-Path -Parent $PSScriptRoot }

    $pairs = [Collections.Generic.List[object]]::new()
    function Add-Pair([string]$Literal, [string]$Token) {
        if ([string]::IsNullOrWhiteSpace($Literal)) { return }
        [void]$pairs.Add([pscustomobject]@{ literal = $Literal.TrimEnd('\', '/'); token = $Token })
    }
    Add-Pair ([string]$Fixture.workspace) '<workspace>'
    Add-Pair ([string]$Fixture.registry) '<registry>'
    Add-Pair ([string]$Fixture.root) '<fixture-root>'
    # A shared row's disposable project (S32): each arm has its own, so its share path is incidental.
    if (@($Fixture.PSObject.Properties.Name) -ccontains 'shared_root') { Add-Pair ([string]$Fixture.shared_root) '<collection>' }
    Add-Pair $ProgramRoot '<program>'
    Add-Pair ([IO.Path]::GetTempPath()) '<temp>'
    Add-Pair $env:USERPROFILE '<home>'
    Add-Pair $env:COMPUTERNAME '<host>'
    Add-Pair $env:USERNAME '<user>'

    # THE STAND-IN AGENT A ROW BOUND A SEAT TO, carried by VALUE rather than as a literal (S14). A pid
    # is a short number, and replacing it wherever it occurred would eat digits out of unrelated text,
    # so it rides here as a pair with no literal -- the replacement loop below skips it -- and is
    # applied only where a field NAMED agent_pid holds exactly this number.
    if (@($Fixture.PSObject.Properties.Name) -ccontains 'agent_pid' -and [int]$Fixture.agent_pid -gt 0) {
        [void]$pairs.Add([pscustomobject]@{ literal = ''; token = '<agent>'; agent_pid = [int]$Fixture.agent_pid })
    }

    # LONGEST FIRST, and it is not cosmetic: the workspace lives INSIDE the fixture root, so
    # replacing the root first would leave `<fixture-root>/workspace` in one arm and `<workspace>`
    # in the other for the same directory.
    @(@($pairs) | Sort-Object -Property @{ Expression = { $_.literal.Length }; Descending = $true })
}

function ConvertTo-AcceptanceNormalisedText {
    <#
    .SYNOPSIS
        One string, with every incidental value replaced by a token.

    .DESCRIPTION
        THE ORDER IS PART OF THE CONTRACT. Paths first, longest first, in three spellings each --
        as given, with forward slashes, and with the doubled backslashes a JSON-encoded Windows
        path carries -- because a path that survived to the generic patterns would have its date
        stamps eaten and stop matching the other arm's. Then line endings, then the generic
        volatile shapes.

        WHAT IS DELIBERATELY NOT NORMALISED: a bare `yyyy-MM-dd`. The fixtures carry dated names on
        purpose -- a source batch and a capture page -- and eating those would make two arms agree
        about a page neither one wrote. Only a full timestamp, or a date followed by a run stamp,
        is incidental.
    #>
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Text, [Parameter(Mandatory = $true)]$Tokens)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $value = $Text

    foreach ($pair in @($Tokens)) {
        foreach ($spelling in @($pair.literal, ($pair.literal -replace '\\', '/'), ($pair.literal -replace '\\', '\\'))) {
            if ([string]::IsNullOrWhiteSpace($spelling)) { continue }
            # IgnoreCase because Windows paths are, and a helper that reports a drive letter in the
            # other case is not reporting a different directory.
            $value = [regex]::Replace($value, [regex]::Escape($spelling), $pair.token, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        }
    }

    # THE STAND-IN'S PID, IN A JSON FILE'S `"agent_pid":  N`, by value. See the tokens above.
    foreach ($pair in @($Tokens)) {
        if (@($pair.PSObject.Properties.Name) -cnotcontains 'agent_pid') { continue }
        $value = [regex]::Replace($value, '("agent_pid"\s*:\s*)' + [int]$pair.agent_pid + '(?!\d)', '${1}"<agent>"')
    }
    # THE ARM'S OWN CARRIED PLAN ID, BY ITS LAST SIXTEEN CHARACTERS (S40). The batch publisher names its
    # journal `shelf-exit-batch-<the plan_id's last 16>.json`, and that plan_id differs between the arms
    # for reasons that are not behaviour -- it binds the plan file's full path and each arm's own
    # disposable project -- so the journal's KEY differed while its content compared equal. Only this
    # arm's value, and only where it stands alone: inside the full plan_id it is preceded by more hex and
    # left for the sha256 rule below, so a port naming the file after any other value stays a difference.
    foreach ($pair in @($Tokens)) {
        if (@($pair.PSObject.Properties.Name) -cnotcontains 'plan_tail') { continue }
        $value = [regex]::Replace($value, '(?<![0-9A-Za-z])' + [regex]::Escape([string]$pair.plan_tail) + '(?![0-9A-Za-z])', '<plan-tail>')
    }
    # AND THE TWO HOLDER FIELDS NO TWO RUNS CAN SHARE: the holder's own pid, and the attempt id minted
    # for it. Keyed by name in a file's text, as the data rule below keys them by field.
    $value = [regex]::Replace($value, '("holder_pid"\s*:\s*)\d+', '${1}"<volatile>"')
    # A COLLECTION OWNERSHIP CLAIM'S `"pid"` (S33): the process that acquired the role, which no two
    # runs share -- the data rule's `pid`, keyed the same way. A seat claim writes `pid=N` instead,
    # which this does not touch, so no seat row's binding is loosened by it.
    $value = [regex]::Replace($value, '("pid"\s*:\s*)\d+', '${1}"<volatile>"')
    $value = [regex]::Replace($value, '("attempt_id"\s*:\s*)"[0-9a-f]{32}"', '${1}"<volatile>"')

    $value = $value -replace "`r`n", "`n"
    $value = $value -replace "`r", "`n"
    # A full timestamp, in the two spellings this codebase writes: round-trip `o` and plain ISO.
    $value = [regex]::Replace($value, '\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?', '<timestamp>')
    # A dated run stamp, which is what a quarantine or journal directory is named after.
    $value = [regex]::Replace($value, '\d{4}-\d{2}-\d{2}-\d{6}', '<stamp>')
    # THE SAME TWO SHAPES, SPELLED THE WAY A BOOK JOURNAL SPELLS THEM. Write-BookJournal names its
    # file `<yyyyMMdd-HHmmss>-<book-root>-<8 hex>.json`, and neither half was reached by the rules
    # above: the stamp carries one hyphen rather than three, and the suffix is
    # `[guid]::NewGuid().ToString('N').Substring(0, 8)` -- a GUID, but not in the dashed spelling the
    # GUID rule matches. So every Shelf writer's journal appeared in the effect map under a key
    # NEITHER ARM COULD SHARE, and its `result.journal` differed by a random eight characters. Both
    # arms would have differed on those two fields for ever, on a row whose subject is neither.
    # Measured 2026-09-22 (S14), the first session with a ported writer to compare.
    #
    # The Book root between them is KEPT, because it is the operation's subject and two arms
    # journaling different Books is a real difference.
    $value = [regex]::Replace($value,
        '(?<![0-9A-Za-z])\d{8}-\d{6}-(?<book>[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)-[0-9a-f]{8}(?=\.json)',
        '<stamp>-${book}-<suffix>')
    # THE SAME STAMP WITH NOTHING AFTER IT, which is how a Notebook reset quarantine is named:
    # `<seat>-<yyyyMMdd-HHmmss>`. Neither rule above reaches it -- the first wants three hyphens in
    # the date, the second a Book root and a suffix -- so the two arms' quarantine directories
    # differed by the second each happened to run in, on every file inside them. Measured
    # 2026-09-22 (S17): `fixture-20260922-170638` against whatever the other arm was stamped. The
    # seat in front is kept, because whose quarantine it is is the operation's subject. Applied
    # AFTER the journal rule, so a journal's stamp is spelled one way and not two.
    $value = [regex]::Replace($value, '(?<![0-9A-Za-z])\d{8}-\d{6}(?![0-9A-Za-z])', '<stamp>')
    $value = [regex]::Replace($value, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<guid>')
    $value = [regex]::Replace($value, '\b[0-9a-fA-F]{64}\b', '<sha256>')
    # Trailing whitespace per line: one arm writing a trailing space is a formatting difference, and
    # a difference this comparison cannot act on is noise in every row it appears in.
    $value = [regex]::Replace($value, '[ \t]+(?=\n)', '')
    $value.TrimEnd()
}

function ConvertTo-AcceptanceNormalisedMessage {
    <#
    .SYNOPSIS
        A human-facing message -- stderr -- normalised, with its line breaks collapsed.

    .DESCRIPTION
        WHY STDERR IS TREATED DIFFERENTLY FROM EVERY OTHER FIELD. PowerShell FORMATS an error
        record as it writes it, wrapping at the host width even into a redirected pipe, and where
        that wrap falls depends on how long the paths inside the message are. The two arms run in
        `<row>/powershell` and `<row>/kernel`, which are not the same length, so two IDENTICAL
        refusals would differ by the position of a newline -- a difference about directory naming,
        reported as a difference about behaviour.

        Collapsing whitespace is safe here and nowhere else: stderr is prose for a person, and its
        line breaks carry no meaning either implementation is being held to. Stdout and the effect
        keep theirs, because there the layout IS the outcome.
    #>
    param([AllowEmptyString()][string]$Text, [Parameter(Mandatory = $true)]$Tokens)
    # THE WRAP IS UNDONE BEFORE ANY TOKEN IS LOOKED FOR, AND WITH NOTHING IN ITS PLACE (S43). PowerShell's
    # error view wraps by CHARACTER at the host width and drops nothing, so a long refusal naming a path came
    # through as `Journal: C:` and `\Users\...` on two lines -- and the old order, tokens first and the break
    # collapsed to a space afterwards, left `C: \Users\<user>\...` where the other arm said `<workspace>\...`:
    # the first failure row to name a journal under the fixture, and a difference about the host's width.
    # The decoration is cut first, while it still starts on a line of its own; then the lines are joined.
    $value = Remove-AcceptanceErrorRecordDecoration -Text $Text
    $value = [regex]::Replace([string]$value, '\r?\n', '')
    $value = ConvertTo-AcceptanceNormalisedText -Text $value -Tokens $Tokens
    ([regex]::Replace($value, '\s+', ' ')).Trim()
}

function Remove-AcceptanceErrorRecordDecoration {
    <#
    .SYNOPSIS
        A PowerShell error record reduced to the sentence it was raised with.

    .DESCRIPTION
        THIS IS NORMALISATION AND NOT AN APPROVED DELTA, and the difference decides whether the
        failure rows are worth anything. Measured 2026-09-22 (S13), the first session with a kernel
        attached: `workspace.init-refuses-a-non-drive-rooted-path` compared the two arms' refusals
        and found the kernel's message IDENTICAL to the PowerShell one, followed in the PowerShell
        arm by

            At <program>\tools\Initialize-LibraryWorkspace.ps1:800 char:9 + throw "'$Path' is not
            ... + CategoryInfo : OperationStopped: (...) [], RuntimeException +
            FullyQualifiedErrorId : <the message again>

        which is the host FORMATTING an ErrorRecord -- the same class of thing as the line wrapping
        this function already collapses, and the reason stderr is treated differently from every
        other field here. A helper that refuses with `throw` gets it; one that refuses through
        `[Console]::Error.WriteLine` does not. It is a fact about which language raised the refusal.
        Eleven rows in this matrix are `failure` rows, so this is not a one-off.

        THE ALTERNATIVE WAS AN APPROVED DELTA ON `stderr`, AND IT WAS REJECTED. A delta matches on a
        field pattern, so the narrowest one expressible is "stderr may differ" -- which would let the
        two arms refuse for DIFFERENT REASONS and still compare green, on exactly the rows whose
        whole subject is the wording of a refusal. Removing the decoration instead holds both arms to
        the same sentence, which is stricter than what was there before rather than looser.

        THE CUT IS ANCHORED ON `FullyQualifiedErrorId`, WHICH ONLY AN ERROR RECORD CARRIES. Text
        that does not have it is returned untouched, so a refusal that merely mentions a script and a
        line number keeps every word of it.
    #>
    param([AllowEmptyString()][string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $Text }
    if ($Text -cnotmatch 'FullyQualifiedErrorId\s*:') { return $Text }

    # The earliest decoration marker wins: `At <file>:<line> char:<col>` precedes the category line
    # when the record carries a position, and is absent from the record when it does not.
    $earliest = -1
    foreach ($pattern in @('\s+At\s+\S+:\d+\s+char:\d+', '\s+\+\s+CategoryInfo\s*:', '\s+\+\s+FullyQualifiedErrorId\s*:')) {
        $match = [regex]::Match($Text, $pattern)
        if (-not $match.Success) { continue }
        if ($earliest -lt 0 -or $match.Index -lt $earliest) { $earliest = $match.Index }
    }
    if ($earliest -le 0) { return $Text }
    $Text.Substring(0, $earliest).Trim()
}

# The keys whose VALUES are volatile without looking volatile. A timestamp or a GUID is caught by
# shape; an elapsed millisecond count and a process id are just numbers, and a number cannot be
# told from a meaningful one without knowing what it is called.
$script:AcceptanceVolatileKeys = @('pid', 'process_id', 'elapsed_ms', 'duration_ms', 'plan_id', 'token', 'claim_token', 'incarnation',
    'holder_pid', 'attempt_id')

function ConvertTo-AcceptanceNormalisedData {
    <#
    .SYNOPSIS
        A parsed JSON value with every string normalised and every volatile key's value replaced.
    #>
    [CmdletBinding()]
    param($Value, [Parameter(Mandatory = $true)]$Tokens, [string]$Key = '')

    if ($script:AcceptanceVolatileKeys -ccontains $Key.ToLowerInvariant()) { return '<volatile>' }
    if ($null -eq $Value) { return $null }
    # THE STAND-IN'S PID BY VALUE (S14): a result naming any OTHER process stays a number, and differs.
    if ($Key -ceq 'agent_pid' -and ($Value -is [int] -or $Value -is [long])) {
        foreach ($pair in @($Tokens)) {
            if (@($pair.PSObject.Properties.Name) -ccontains 'agent_pid' -and [long]$Value -eq [long]$pair.agent_pid) { return '<agent>' }
        }
    }
    if ($Value -is [string]) { return (ConvertTo-AcceptanceNormalisedText -Text $Value -Tokens $Tokens) }
    if ($Value -is [bool] -or $Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) { return $Value }
    if ($Value -is [Array]) {
        # BEHIND A COMMA, AND UNTIL S17 IT WAS NOT. `return @(...)` from a function is ENUMERATED on
        # output, so a one-element array reached the caller as its bare element and an empty one as
        # $null -- and the field map then spelled `["x"]` exactly as it spelled `"x"`, and `[]`
        # exactly as `null`. Two JSON shapes, one answer, decided by this function rather than by
        # either arm: the S15 `{}`-against-`null` defect one layer down, in the harness itself, and
        # invisible for the same reason -- it was symmetric, so it could only ever hide a difference.
        # Measured 2026-09-22 on `drift_repaired`, a one-element array that arrived as a string.
        $normalised = @(@($Value) | ForEach-Object { ConvertTo-AcceptanceNormalisedData -Value $_ -Tokens $Tokens })
        return , $normalised
    }
    if ($Value -is [pscustomobject] -or $Value -is [Collections.IDictionary]) {
        $result = [ordered]@{}
        foreach ($name in @(Get-AcceptanceObjectKeys $Value)) {
            $result[$name] = ConvertTo-AcceptanceNormalisedData -Value $Value.$name -Tokens $Tokens -Key $name
        }
        return [pscustomobject]$result
    }
    ConvertTo-AcceptanceNormalisedText -Text ([string]$Value) -Tokens $Tokens
}

function Test-AcceptanceTextContent {
    <#
    .SYNOPSIS
        Is this file text? A NUL byte says no, and so does a decode that needs replacement.

    .DESCRIPTION
        [AllowEmptyCollection()] AND IT IS LOAD-BEARING. `[IO.File]::ReadAllBytes` on an empty file
        returns an empty array, which parameter binding refuses with "Cannot bind argument to
        parameter 'Bytes' because it is an empty array" -- defect family 2 in its production
        direction. AN EMPTY FILE IS A FIRST-CLASS INPUT here, not an edge case: a seat's two Desk
        files are created empty, so every fixture with a seat holds two of them, and without this
        attribute the effect of every row over every seated fixture was an error rather than an
        outcome. 44 of 49 runnable rows died on it, and the self-test did not, because the one row
        it ran end to end used the one fixture with no seat.
    #>
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes)
    if (-not $Bytes.Length) { return $true }
    foreach ($byte in $Bytes[0..([Math]::Min($Bytes.Length, 4096) - 1)]) {
        if ($byte -eq 0) { return $false }
    }
    try {
        [void]([Text.UTF8Encoding]::new($false, $true)).GetString($Bytes)
        return $true
    }
    catch { return $false }
}

function Get-AcceptanceTextHash([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-AcceptanceEffect {
    <#
    .SYNOPSIS
        What the operation left on disk: one entry per file under the workspace, normalised.

    .DESCRIPTION
        THE RETURN VALUE IS HALF THE OUTCOME AND THIS IS THE OTHER HALF. A port that answers
        correctly and writes the wrong file is wrong, and stdout would not say so.

        Small text files are carried as TEXT rather than as a hash, deliberately: a hash tells the
        next session that two files differ, and the text tells it how. Anything over the threshold,
        and anything binary, falls back to a hash of the normalised content.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)]$Tokens,
        [int]$InlineLimit = 8192,
        # How one file's bytes are read, given the file and its raw relative path. Absent, from disk. A
        # shared collection's before-snapshot reads its notes through Basic Memory instead (S33): see
        # Get-AcceptanceCollectionEffect for why a disk read there would blind the after-snapshot.
        [scriptblock]$ReadBytes
    )

    $effect = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) { return $effect }
    $root = (Resolve-Path -LiteralPath $Workspace).Path
    $files = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue)
    $rows = [Collections.Generic.List[object]]::new()
    foreach ($file in @($files | Sort-Object -Property FullName -CaseSensitive)) {
        $rawRelative = $file.FullName.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/'
        $relative = ConvertTo-AcceptanceNormalisedText -Text $rawRelative -Tokens $Tokens
        $bytes = @()
        $value = ''
        # Assigned in each branch, never from an `if` expression: that unrolls an EMPTY array to $null,
        # and an empty file -- an empty `.open-projects` -- is a real outcome.
        try {
            if ($null -ne $ReadBytes) { $bytes = [byte[]](& $ReadBytes $file $rawRelative); if ($null -eq $bytes) { $bytes = [byte[]]@() } }
            else { $bytes = [IO.File]::ReadAllBytes($file.FullName) }
        }
        catch {
            # A file another process holds open is a real outcome, not a harness failure: say so
            # rather than dropping it, because a row whose operation leaves a lock behind should
            # differ from one that does not.
            [void]$rows.Add([pscustomobject]@{ key = $relative; value = ('unreadable: ' + $_.Exception.GetType().Name) })
            continue
        }
        if (Test-AcceptanceTextContent -Bytes $bytes) {
            $text = ConvertTo-AcceptanceNormalisedText -Text ([Text.UTF8Encoding]::new($false)).GetString($bytes) -Tokens $Tokens
            if ($text.Length -le $InlineLimit) { $value = "text:$text" }
            else { $value = 'sha256:' + (Get-AcceptanceTextHash $text) }
        }
        else {
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $value = 'bytes:' + ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() }
            finally { $sha.Dispose() }
        }
        [void]$rows.Add([pscustomobject]@{ key = $relative; value = $value })
    }

    # TWO FILES WHOSE NAMES NORMALISE ALIKE ARE TWO ENTRIES, NOT ONE, and until 2026-09-22 (S14) the
    # second one silently REPLACED the first. It cost a real flake the day the Book journal's stamp and
    # suffix were normalised: shelf.archived-book-restores-to-the-active-shelf writes two journals, an
    # Archive and a Restore, and both reduce to one key. Which one survived was decided by the RAW
    # filename sort -- and for two journals written inside the same second, that is the random
    # eight-character suffix. The row went green, then mismatched, then green again over three runs of
    # identical code.
    #
    # AND THE COLLISION IS WORSE THAN THE FLAKE. One entry standing for two files means an EXTRA file in
    # one arm can be invisible, which is exactly the half of the outcome this map exists to cover.
    #
    # COLLIDING ENTRIES ARE ORDERED BY THEIR NORMALISED CONTENT, never by the name they came from: the
    # content is what survived normalisation, so it is the only thing both arms can agree an order on.
    foreach ($group in @(@($rows | Group-Object -Property key) | Sort-Object -Property Name -CaseSensitive)) {
        $items = @($group.Group)
        if ($items.Count -eq 1) {
            $effect[[string]$group.Name] = [string]$items[0].value
            continue
        }
        $ordered = @($items | Sort-Object -Property @{ Expression = { [string]$_.value } } -CaseSensitive)
        for ($index = 0; $index -lt $ordered.Count; $index++) {
            $effect["$([string]$group.Name) [$($index + 1)/$($ordered.Count)]"] = [string]$ordered[$index].value
        }
    }
    $effect
}

function ConvertTo-AcceptanceFieldMap {
    <#
    .SYNOPSIS
        One outcome flattened to `field -> value`, which is what a difference names.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Outcome)

    $map = [ordered]@{}
    $map['exit'] = [string]$Outcome.exit

    $keys = @(Get-AcceptanceObjectKeys $Outcome)
    if ($keys -ccontains 'result' -and $null -ne $Outcome.result) {
        foreach ($entry in @(ConvertTo-AcceptanceFlatField -Prefix 'result' -Value $Outcome.result)) {
            $map[$entry.field] = $entry.value
        }
    }
    elseif ($keys -ccontains 'stdout') {
        $map['stdout'] = [string]$Outcome.stdout
    }
    if ($keys -ccontains 'stderr' -and -not [string]::IsNullOrWhiteSpace([string]$Outcome.stderr)) {
        $map['stderr'] = [string]$Outcome.stderr
    }
    if ($keys -ccontains 'effect' -and $null -ne $Outcome.effect) {
        foreach ($name in @(Get-AcceptanceObjectKeys $Outcome.effect)) {
            $map["effect.$name"] = [string]$Outcome.effect.$name
        }
    }
    $map
}

function ConvertTo-AcceptanceFlatField {
    param([Parameter(Mandatory = $true)][string]$Prefix, $Value)
    $entries = [Collections.Generic.List[object]]::new()
    if ($null -eq $Value) {
        [void]$entries.Add([pscustomobject]@{ field = $Prefix; value = '<null>' })
    }
    elseif ($Value -is [pscustomobject] -or $Value -is [Collections.IDictionary]) {
        $names = @(Get-AcceptanceObjectKeys $Value)
        if (-not $names.Count) { [void]$entries.Add([pscustomobject]@{ field = $Prefix; value = '<empty-object>' }) }
        foreach ($name in $names) {
            foreach ($child in @(ConvertTo-AcceptanceFlatField -Prefix "$Prefix.$name" -Value $Value.$name)) { [void]$entries.Add($child) }
        }
    }
    elseif ($Value -is [Array]) {
        $items = @($Value)
        if (-not $items.Count) { [void]$entries.Add([pscustomobject]@{ field = $Prefix; value = '<empty-array>' }) }
        for ($i = 0; $i -lt $items.Count; $i++) {
            foreach ($child in @(ConvertTo-AcceptanceFlatField -Prefix "$Prefix[$i]" -Value $items[$i])) { [void]$entries.Add($child) }
        }
    }
    else {
        [void]$entries.Add([pscustomobject]@{ field = $Prefix; value = [string]$Value })
    }
    @($entries)
}

function Test-AcceptanceRebaseShape {
    <#
    .SYNOPSIS
        What is wrong with one delta's `rebase` block, or nothing.
    #>
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)]$Rebase)
    $problems = [Collections.Generic.List[string]]::new()
    $keys = @(Get-AcceptanceObjectKeys $Rebase)
    if ([string](Get-AcceptanceOptionalValue -Object $Rebase -Name 'arm') -cne 'kernel') { [void]$problems.Add("delta '$Name' rebases an arm other than the kernel's") }
    $from = [string](Get-AcceptanceOptionalValue -Object $Rebase -Name 'from')
    $onto = [string](Get-AcceptanceOptionalValue -Object $Rebase -Name 'onto')
    # KEYED BY VALUE, NEVER BY SHAPE. A rebase that did not name the acting seat would fold EVERY
    # seat's root onto the shared path, and a port writing into the wrong seat would compare green.
    if ($from -cnotmatch '\{seat\}') { [void]$problems.Add("delta '$Name' rebases '$from', which does not name {seat}, so it is not keyed by the value it rebases") }
    if ([string]::IsNullOrWhiteSpace($onto) -or $onto.Contains('/')) { [void]$problems.Add("delta '$Name' rebases onto '$onto', which must be one path segment") }
    foreach ($list in @('kernel_only', 'powershell_only')) {
        foreach ($pattern in @(Get-AcceptanceOptionalList -Object $Rebase -Name $list)) {
            if (-not ([string]$pattern).StartsWith('^effect\.')) { [void]$problems.Add("delta '$Name' lists $list '$pattern', which is not an anchored effect path") }
            try { [void][regex]::new([string]$pattern) } catch { [void]$problems.Add("delta '$Name' lists an unusable $list pattern: $($_.Exception.Message)") }
        }
    }
    foreach ($phrase in @(Get-AcceptanceOptionalList -Object $Rebase -Name 'phrases')) {
        if ([string]::IsNullOrWhiteSpace([string]$phrase.kernel) -or [string]::IsNullOrWhiteSpace([string]$phrase.powershell)) {
            [void]$problems.Add("delta '$Name' has a phrase pair missing one side")
        }
    }
    @($problems)
}

function ConvertTo-AcceptanceRebasedText {
    <#
    .SYNOPSIS
        One string with the kernel's `<from>` path replaced by the oracle's `<onto>`, in every
        spelling a path takes: forward slashes in a file, one backslash in a Windows result, two in
        a JSON-encoded one -- and the hyphen-joined form a Book root takes in a lock or journal FILE
        NAME (`toBookLockName`), where `notebook/<seat>/<topic>` is `notebook-<seat>-<topic>`. Only
        as whole segments: `notebook/fixture` inside `notebook/fixtures` is not the seat's root.
    #>
    param([AllowEmptyString()][string]$Text, [Parameter(Mandatory = $true)][string]$From, [Parameter(Mandatory = $true)][string]$Onto)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $segments = @($From -split '/' | ForEach-Object { [regex]::Escape($_) })
    $pattern = '(?<![A-Za-z0-9_-])' + ($segments -join '(?:/|\\\\|\\)') + '(?![A-Za-z0-9_-])'
    $value = [regex]::Replace($Text, $pattern, $Onto)
    # THE FILE-NAME SPELLING needs a topic after it, which is what a lock or journal name always has.
    $hyphenated = '(?<![A-Za-z0-9_])' + ($segments -join '-') + '(?=-[a-z0-9])'
    [regex]::Replace($value, $hyphenated, $Onto)
}

function Compare-AcceptanceOutcome {
    <#
    .SYNOPSIS
        Compare two normalised outcomes for one row. Returns the unapproved differences and the
        approved ones separately.

    .DESCRIPTION
        A ROW IS GREEN WHEN `differences` IS EMPTY -- never when it is merely short. An approved
        delta is reported too, because "this row is green with three approved deltas" and "this row
        is green" are different statements and the second one hides the first.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Matrix,
        [Parameter(Mandatory = $true)]$Row,
        [Parameter(Mandatory = $true)]$PowerShellOutcome,
        [Parameter(Mandatory = $true)]$KernelOutcome,
        # The ACTING seat of the kernel's fixture. A `rebase` delta is keyed by this value and does
        # nothing without it.
        [string]$Seat = ''
    )

    $left = ConvertTo-AcceptanceFieldMap -Outcome $PowerShellOutcome
    $right = ConvertTo-AcceptanceFieldMap -Outcome $KernelOutcome

    $approvedDeltas = @(Get-AcceptanceRowDeltas -Matrix $Matrix -Row $Row)
    $differences = [Collections.Generic.List[object]]::new()
    $approved = [Collections.Generic.List[object]]::new()

    # THE REBASE (S18), BEFORE ANYTHING IS COMPARED. ADR-0029 puts the kernel's Notebook at
    # `notebook/<seat>/` where the oracle's is `notebook/`, so every name and value in the kernel's
    # outcome that names the ACTING seat's root is rewritten onto the oracle's path -- and then held to
    # the oracle's CONTENT exactly. A field the rebase changed is reported as an approved delta; one it
    # could not make equal stays a difference. It is keyed by the seat's VALUE: another seat's root is
    # left alone, so a port writing into the wrong seat still differs. Two kernel fields that rebase
    # onto one name are a difference in their own right, never a silent overwrite.
    $rebasedFrom = @{}
    $kernelOnly = [Collections.Generic.List[object]]::new()
    $powershellOnly = [Collections.Generic.List[object]]::new()
    $rebaseDeltas = @($approvedDeltas | Where-Object { @(Get-AcceptanceObjectKeys $Matrix.deltas.$_) -ccontains 'rebase' })
    if ($rebaseDeltas.Count -and -not [string]::IsNullOrWhiteSpace($Seat)) {
        $rebased = [ordered]@{}
        foreach ($field in @($right.Keys)) {
            $name = [string]$field
            $value = [string]$right[$field]
            $by = ''
            foreach ($deltaName in $rebaseDeltas) {
                $rebase = $Matrix.deltas.$deltaName.rebase
                $from = ([string]$rebase.from).Replace('{seat}', $Seat)
                $newName = ConvertTo-AcceptanceRebasedText -Text $name -From $from -Onto ([string]$rebase.onto)
                $newValue = ConvertTo-AcceptanceRebasedText -Text $value -From $from -Onto ([string]$rebase.onto)
                foreach ($phrase in @(Get-AcceptanceOptionalList -Object $rebase -Name 'phrases')) {
                    $newValue = $newValue.Replace([string]$phrase.kernel, [string]$phrase.powershell)
                }
                if ($newName -cne $name -or $newValue -cne $value) { $by = $deltaName }
                $name = $newName
                $value = $newValue
                foreach ($pattern in @(Get-AcceptanceOptionalList -Object $rebase -Name 'kernel_only')) { [void]$kernelOnly.Add([pscustomobject]@{ pattern = [string]$pattern; delta = $deltaName }) }
                foreach ($pattern in @(Get-AcceptanceOptionalList -Object $rebase -Name 'powershell_only')) { [void]$powershellOnly.Add([pscustomobject]@{ pattern = [string]$pattern; delta = $deltaName }) }
            }
            if ($rebased.Contains($name)) {
                [void]$differences.Add([pscustomobject]@{
                    field      = $name
                    powershell = if ($left.Contains($name)) { [string]$left[$name] } else { '<absent>' }
                    kernel     = "two kernel fields rebase onto this one: '$($rebasedFrom[$name].field)' and '$field'"
                    delta      = ''
                })
                continue
            }
            $rebased[$name] = $value
            if (-not [string]::IsNullOrEmpty($by)) { $rebasedFrom[$name] = [pscustomobject]@{ field = [string]$field; raw = [string]$right[$field]; delta = $by } }
        }
        $right = $rebased
    }
    $fields = @(@(@($left.Keys) + @($right.Keys)) | Sort-Object -Unique -CaseSensitive)

    foreach ($field in $fields) {
        $leftValue = if ($left.Contains($field)) { [string]$left[$field] } else { '<absent>' }
        $rightValue = if ($right.Contains($field)) { [string]$right[$field] } else { '<absent>' }
        if ($leftValue -ceq $rightValue) {
            if ($rebasedFrom.ContainsKey($field)) {
                [void]$approved.Add([pscustomobject]@{
                    field      = $field
                    powershell = $leftValue
                    kernel     = "$($rebasedFrom[$field].field) = $($rebasedFrom[$field].raw)"
                    delta      = [string]$rebasedFrom[$field].delta
                })
            }
            continue
        }

        # A FILE ONLY ONE ARM WRITES, AND ONLY WHEN THE DELTA NAMES IT. The kernel's layout record and
        # migration record, and the oracle's ownership record, exist in one layout and not the other.
        $onlyDelta = ''
        if (-not $left.Contains($field)) {
            foreach ($entry in @($kernelOnly)) { if ($field -cmatch $entry.pattern) { $onlyDelta = $entry.delta; break } }
        }
        elseif (-not $right.Contains($field)) {
            foreach ($entry in @($powershellOnly)) { if ($field -cmatch $entry.pattern) { $onlyDelta = $entry.delta; break } }
        }
        if (-not [string]::IsNullOrEmpty($onlyDelta)) {
            [void]$approved.Add([pscustomobject]@{ field = $field; powershell = $leftValue; kernel = $rightValue; delta = $onlyDelta })
            continue
        }

        $matchedDelta = ''
        foreach ($name in $approvedDeltas) {
            if (@(Get-AcceptanceObjectKeys $Matrix.deltas.$name) -cnotcontains 'match') { continue }
            $match = $Matrix.deltas.$name.match
            if ($field -cnotmatch ([string]$match.field_pattern)) { continue }
            $matchKeys = @(Get-AcceptanceObjectKeys $match)
            if ($matchKeys -ccontains 'value_pattern') {
                $valuePattern = [string]$match.value_pattern
                if ($leftValue -cnotmatch $valuePattern -or $rightValue -cnotmatch $valuePattern) { continue }
            }
            $matchedDelta = $name
            break
        }

        $record = [pscustomobject]@{
            field      = $field
            powershell = $leftValue
            kernel     = $rightValue
            delta      = $matchedDelta
        }
        if ([string]::IsNullOrWhiteSpace($matchedDelta)) { [void]$differences.Add($record) }
        else { [void]$approved.Add($record) }
    }

    [pscustomobject]@{
        row         = [string]$Row.id
        fields      = $fields.Count
        differences = @($differences)
        approved    = @($approved)
        green       = (@($differences).Count -eq 0)
    }
}

# --- The rendered document ------------------------------------------------------------------------

$script:AcceptanceDocRelativePath = 'docs/supported-operation-matrix.md'
$script:AcceptanceDocBeginMarker = '<!-- BEGIN GENERATED MATRIX -- rendered by tools/Invoke-AcceptanceMatrix.ps1 -RenderDoc; do not edit by hand -->'
$script:AcceptanceDocEndMarker = '<!-- END GENERATED MATRIX -->'

function Get-AcceptanceDocMarkers { [pscustomobject]@{ begin = $script:AcceptanceDocBeginMarker; end = $script:AcceptanceDocEndMarker } }

function ConvertTo-AcceptanceCell([string]$Text) {
    # A pipe inside a cell ends the cell, and a row's operation sentence is prose written by a
    # human who has no reason to know that.
    ($Text -replace '\|', '\|') -replace '\s+', ' '
}

function Get-AcceptanceMatrixDocTable {
    <#
    .SYNOPSIS
        The generated region of docs/supported-operation-matrix.md, rendered from the rows.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Matrix)

    $rows = @($Matrix.rows)
    $lines = [Collections.Generic.List[string]]::new()

    $differential = @(@($rows) | Where-Object { [string]$_.oracle -ceq 'differential' }).Count
    $independent = @(@($rows) | Where-Object { [string]$_.oracle -ceq 'independent' }).Count
    $needShared = @(@($rows) | Where-Object { @(Get-AcceptanceOptionalList -Object $_ -Name 'requires') -ccontains 'shared-collection' }).Count

    [void]$lines.Add("**$($rows.Count) rows** across $(@(Get-AcceptanceObjectKeys $Matrix.areas).Count) areas: $differential compared against PowerShell, $independent judged independently. $needShared need a reachable shared collection and are skipped offline. $(@(Get-AcceptanceObjectKeys $Matrix.excluded_helpers).Count) public helpers are excluded with a reason rather than given a row.")
    [void]$lines.Add('')

    # THE UNIVERSAL DELTAS ARE NAMED ONCE, not on all 79 rows. A mark repeated on every line is
    # read as decoration and stops being read at all, which is the opposite of what an approved
    # delta is for. The per-row marks below carry the deltas that are scoped to something.
    $universal = @(@(Get-AcceptanceObjectKeys $Matrix.deltas) | Where-Object { @($Matrix.deltas.$_.applies_to) -ccontains '*' })
    if ($universal.Count) {
        [void]$lines.Add('Approved for **every** row, so not repeated on each one: ' +
            ((@($universal) | ForEach-Object { '`' + $_ + '`' }) -join ', ') + '.')
        [void]$lines.Add('')
    }

    foreach ($area in @(Get-AcceptanceObjectKeys $Matrix.areas)) {
        $areaRows = @(@($rows) | Where-Object { [string]$_.area -ceq $area })
        if (-not $areaRows.Count) { continue }
        $summary = ConvertTo-AcceptanceCell ([string]$Matrix.areas.$area.summary)
        [void]$lines.Add("### $area")
        [void]$lines.Add('')
        [void]$lines.Add($summary)
        [void]$lines.Add('')
        [void]$lines.Add('| Row | Class | Oracle | Fixture | Operation |')
        [void]$lines.Add('| --- | --- | --- | --- | --- |')
        foreach ($row in $areaRows) {
            $marks = [Collections.Generic.List[string]]::new()
            foreach ($requirement in @(Get-AcceptanceOptionalList -Object $row -Name 'requires')) { [void]$marks.Add("needs $requirement") }
            foreach ($delta in @(Get-AcceptanceRowDeltas -Matrix $Matrix -Row $row)) {
                if ($universal -ccontains $delta) { continue }
                [void]$marks.Add("delta: $delta")
            }
            $operation = ConvertTo-AcceptanceCell ([string]$row.operation)
            if ($marks.Count) { $operation += ' _(' + (($marks | Sort-Object -CaseSensitive) -join '; ') + ')_' }
            [void]$lines.Add(('| `{0}` | {1} | {2} | `{3}` | {4} |' -f $row.id, $row.class, $row.oracle, $row.fixture, $operation))
        }
        [void]$lines.Add('')
    }

    [void]$lines.Add('### Approved deltas')
    [void]$lines.Add('')
    [void]$lines.Add('| Delta | Applies to | Field | Reason | Approved |')
    [void]$lines.Add('| --- | --- | --- | --- | --- |')
    foreach ($name in @(Get-AcceptanceObjectKeys $Matrix.deltas)) {
        $delta = $Matrix.deltas.$name
        # A REBASE IS SAID IN FULL, because every part of it is an approval: the path it rewrites, the
        # files only one arm has, and each sentence pair.
        $field = if (@(Get-AcceptanceObjectKeys $delta) -ccontains 'rebase') {
            $rebase = $delta.rebase
            $parts = @("rebase ``$([string]$rebase.from)`` onto ``$([string]$rebase.onto)``, then compare content")
            $kernelOnly = @(Get-AcceptanceOptionalList -Object $rebase -Name 'kernel_only')
            $powershellOnly = @(Get-AcceptanceOptionalList -Object $rebase -Name 'powershell_only')
            $phrases = @(Get-AcceptanceOptionalList -Object $rebase -Name 'phrases')
            if ($kernelOnly.Count) { $parts += 'kernel only: ' + ((@($kernelOnly) | ForEach-Object { '`' + $_ + '`' }) -join ', ') }
            if ($powershellOnly.Count) { $parts += 'PowerShell only: ' + ((@($powershellOnly) | ForEach-Object { '`' + $_ + '`' }) -join ', ') }
            if ($phrases.Count) { $parts += "$($phrases.Count) sentence pair(s), verbatim" }
            $parts -join '; '
        }
        else { '`' + [string]$delta.match.field_pattern + '`' }
        [void]$lines.Add(('| `{0}` | {1} | {2} | {3} | {4}, {5} |' -f $name,
            ((@($delta.applies_to) | ForEach-Object { '`' + $_ + '`' }) -join ', '),
            (ConvertTo-AcceptanceCell $field),
            (ConvertTo-AcceptanceCell ([string]$delta.reason)),
            (ConvertTo-AcceptanceCell ([string]$delta.approved_by)),
            [string]$delta.approved_on))
    }
    [void]$lines.Add('')

    [void]$lines.Add('### Public helpers with no row, and why')
    [void]$lines.Add('')
    [void]$lines.Add('| Helper | Class | Reason |')
    [void]$lines.Add('| --- | --- | --- |')
    foreach ($name in @(Get-AcceptanceObjectKeys $Matrix.excluded_helpers)) {
        $entry = $Matrix.excluded_helpers.$name
        [void]$lines.Add(('| `{0}` | {1} | {2} |' -f $name, [string]$entry.class, (ConvertTo-AcceptanceCell ([string]$entry.reason))))
    }

    ($lines -join "`n")
}

# --- The generated document -----------------------------------------------------------------------

function Get-AcceptanceDocText {
    param([Parameter(Mandatory = $true)]$Matrix, [string]$ProgramRoot)
    if ([string]::IsNullOrWhiteSpace($ProgramRoot)) { $ProgramRoot = Split-Path -Parent $PSScriptRoot }
    $path = Join-Path $ProgramRoot $script:AcceptanceDocRelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "$($script:AcceptanceDocRelativePath) is missing, so its generated region cannot be rendered into it." }
    $text = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false, $true)) -replace "`r`n", "`n"
    $markers = Get-AcceptanceDocMarkers
    $beginIndex = $text.IndexOf($markers.begin, [StringComparison]::Ordinal)
    $endIndex = $text.IndexOf($markers.end, [StringComparison]::Ordinal)
    if ($beginIndex -lt 0 -or $endIndex -lt $beginIndex) {
        throw "$($script:AcceptanceDocRelativePath) has no generated region; it must contain the begin and end markers, in that order."
    }
    $rendered = ($markers.begin + "`n`n" + (Get-AcceptanceMatrixDocTable -Matrix $Matrix) + "`n`n" + $markers.end)
    [pscustomobject]@{
        path     = $path
        current  = $text
        expected = ($text.Substring(0, $beginIndex) + $rendered + $text.Substring($endIndex + $markers.end.Length))
    }
}

function Write-AcceptanceDoc {
    param([Parameter(Mandatory = $true)]$Matrix, [string]$ProgramRoot)
    $document = Get-AcceptanceDocText -Matrix $Matrix -ProgramRoot $ProgramRoot
    if ($document.current -ceq $document.expected) { return 'unchanged' }
    [IO.File]::WriteAllText($document.path, $document.expected, [Text.UTF8Encoding]::new($false))
    'rewritten'
}

function Test-AcceptanceDoc {
    param([Parameter(Mandatory = $true)]$Matrix, [string]$ProgramRoot)
    $document = Get-AcceptanceDocText -Matrix $Matrix -ProgramRoot $ProgramRoot
    if ($document.current -ceq $document.expected) { return '' }
    'the generated region of ' + $script:AcceptanceDocRelativePath + ' does not match the rows; run tools/Invoke-AcceptanceMatrix.ps1 -RenderDoc'
}
