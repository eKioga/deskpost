<#
.SYNOPSIS
    Shared output contract for Library helpers. Dot-sourced; never invoked directly.

.DESCRIPTION
    Helpers are called two ways, and the two need different output.

    In-process, one helper composes another: Invoke-LibraryTriage.ps1 calls
    Publish-BookCopy.ps1 via `& $publisher @args` and reads `$child.plan_id`. That caller needs a
    rich object.

    Across a process boundary — `powershell.exe -File tools/<helper>.ps1` — PowerShell returns
    *formatted text*, so a caller projecting a field silently receives empty records instead of an
    error. That already made a successful, journaled shared write look like a failure.

    So the mode is explicit rather than global. `-Json` is opt-in and off by default, which is what
    preserves composition: a nested caller simply does not pass it and keeps getting objects.
    Making every helper emit JSON unconditionally would reproduce the empty-field bug inside the
    composed call.

    Failures leave by a different door: stderr plus a non-zero exit code, never a formatted object
    on stdout that a caller might mistake for a result.
#>

Set-StrictMode -Version Latest

$script:LibraryOutputSchema = 1

function Write-LibraryResult {
    <#
    .SYNOPSIS
        Emit a helper's result in the mode the caller asked for.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Result,
        [switch]$Json,
        [int]$Depth = 12
    )

    if (-not $Json) {
        # In-process: hand back the live object so property access keeps working.
        return $Result
    }

    # Process boundary: exactly one JSON object on stdout, schema-versioned so a consumer can tell
    # which contract it is reading.
    $payload = [ordered]@{ schema = $script:LibraryOutputSchema }
    foreach ($property in $Result.PSObject.Properties) {
        $payload[$property.Name] = $property.Value
    }
    ([pscustomobject]$payload) | ConvertTo-Json -Depth $Depth -Compress
}

function Write-LibraryFailure {
    <#
    .SYNOPSIS
        Report a failure on stderr and exit non-zero. Never writes a result object to stdout.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [int]$ExitCode = 1
    )
    [Console]::Error.WriteLine($Message)
    exit $ExitCode
}

# --- Self-test ------------------------------------------------------------------------------------
# Run with:  powershell.exe -File tools/LibraryOutput.ps1 -SelfTest
# Guarded so dot-sourcing never executes it.
if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') {
    $ErrorActionPreference = 'Stop'
    $failures = [Collections.Generic.List[string]]::new()
    function Assert([bool]$Condition, [string]$Label) {
        if (-not $Condition) { [void]$failures.Add($Label) }
    }

    $sample = [pscustomobject]@{ operation = 'Sample'; plan_id = 'abc123'; nested = [pscustomobject]@{ count = 2 } }

    # 1. Object mode returns a live object whose properties are reachable.
    $asObject = Write-LibraryResult -Result $sample
    Assert ($asObject.plan_id -ceq 'abc123') 'object mode lost plan_id'
    Assert ($asObject.nested.count -eq 2) 'object mode lost a nested property'

    # 2. JSON mode returns exactly one parseable line carrying the schema version.
    $asJson = Write-LibraryResult -Result $sample -Json
    Assert (@($asJson).Count -eq 1) 'JSON mode emitted more than one object'
    $parsed = $asJson | ConvertFrom-Json
    Assert ($parsed.plan_id -ceq 'abc123') 'JSON mode lost plan_id'
    Assert ($parsed.schema -eq 1) 'JSON mode omitted the schema version'
    Assert ($asJson -notmatch "`n") 'JSON mode emitted a multi-line payload'

    # 3. The composition case: an inner script returning through the adapter must still be
    #    property-accessible to an outer in-process caller. This is the exact path a blanket JSON
    #    contract would have broken.
    $fixture = Join-Path ([IO.Path]::GetTempPath()) ("library-output-selftest-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $fixture -Force | Out-Null
    try {
        $adapterPath = $PSCommandPath
        $innerPath = Join-Path $fixture 'inner.ps1'
        @"
param([switch]`$Json)
. '$adapterPath'
Write-LibraryResult -Result ([pscustomobject]@{ operation = 'Inner'; plan_id = 'inner-999' }) -Json:`$Json
"@ | Set-Content -LiteralPath $innerPath -Encoding utf8

        $child = & $innerPath
        Assert ($child.plan_id -ceq 'inner-999') 'in-process composition lost plan_id'

        $childJson = & $innerPath -Json
        Assert ((($childJson | ConvertFrom-Json).plan_id) -ceq 'inner-999') 'JSON composition lost plan_id'
    }
    finally {
        Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($failures.Count) {
        [Console]::Error.WriteLine("LibraryOutput self-test FAILED: $($failures -join '; ')")
        exit 1
    }
    Write-Host 'LibraryOutput self-test passed (8 checks).'
    exit 0
}
