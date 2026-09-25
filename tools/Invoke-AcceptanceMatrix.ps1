<#
.SYNOPSIS
    Run supported-operation matrix rows against the PowerShell tools and the TypeScript kernel and
    compare their normalised outcomes.

.DESCRIPTION
    PLAN-public-release.md step 23, the harness half. `tools/acceptance-matrix.json` holds the
    rows, `tools/AcceptanceFixtures.ps1` builds the workspaces, `tools/AcceptanceMatrix.ps1` holds
    the normalisation and the comparison. This drives them.

    EACH ARM GETS ITS OWN FIXTURE, BUILT FROM SCRATCH. Running both arms over one directory would
    make the second arm's input the first arm's output, and the comparison would then be measuring
    the order they ran in. Two fixtures of the same shape in two directories is also what makes
    normalisation testable: the paths and ids genuinely differ, so a row that goes green has
    survived a real difference rather than an arranged sameness.

    WITH NO KERNEL ATTACHED, A ROW IS `pending` AND NEVER GREEN. As of 2026-09-22 there is no
    TypeScript kernel: `-Kernel` is unset, the PowerShell arm runs, its normalised outcome is
    recorded, and the verdict says so in that word. This is the one thing this harness must not get
    wrong. A suite that reported the PowerShell arm's success as a matrix row passing would be
    green for the whole of Phase D and would mean nothing on the day it mattered -- the exact shape
    of the defect the plan's own verification rules keep naming: a fixture that supplies the input
    proves the code works when given it, never that it arrives.

    THE SELF-TEST FALSIFIES THE COMPARATOR RATHER THAN EXERCISING IT. `-SelfTest` builds every
    declared fixture (a table naming a builder is not a builder), runs one real row end to end, and
    then drives the comparison with a STUB kernel four ways: agreeing, differing only in values
    that normalisation removes, differing in substance, and absent. The third case is the one that
    matters -- a comparator that never reports a difference agrees with everything.

.EXAMPLE
    tools/Invoke-AcceptanceMatrix.ps1 -List
    Every row, with its area, oracle and fixture.

.EXAMPLE
    tools/Invoke-AcceptanceMatrix.ps1 -Row workspace.init-creates-marker
    Run one row. With no -Kernel it reports `pending` and prints the PowerShell arm's outcome.

.EXAMPLE
    tools/Invoke-AcceptanceMatrix.ps1 -All -Kernel 'C:\deskpost\library.exe' -RequireGreen
    The Phase D closing gate: every row compared, non-zero unless every one is green.
#>
[CmdletBinding()]
param(
    # Row ids to run. Empty with -All means every row.
    [string[]]$Row = @(),
    [string]$Area,
    [switch]$All,
    [switch]$List,

    # The TypeScript kernel's command line: an executable, or an interpreter plus a script. The
    # row's kernel command is appended to it. Unset means no kernel, which is not an error.
    [string]$Kernel,

    # Independent rows are judged against a stated property, not against PowerShell, and the
    # suites that assert them today take minutes. They are listed rather than run unless asked for.
    [switch]$IncludeIndependent,
    # Rows that need a reachable shared collection. Skipped by default so a run works offline.
    [switch]$IncludeShared,
    # WHERE A SHARED ROW'S DISPOSABLE PROJECTS ARE MADE (S32, the reader's ruling). Both are required
    # with -IncludeShared and neither is read from this machine's or this checkout's configuration:
    # that configuration names the reader's own collection. Each arm of each shared row gets a new
    # `acceptance-<guid>` project on this endpoint, at `<SharedKnowledgeRoot>\<name>` on the share,
    # deleted after the row. See tools/AcceptanceSharedCollection.ps1.
    [string]$McpUrl,
    [string]$SharedKnowledgeRoot,

    # Exit non-zero unless every selected row is green. The Phase D closing gate; today it fails
    # by design, because every differential row is pending.
    [switch]$RequireGreen,

    [string]$WorkDirectory,
    [switch]$KeepFixtures,
    [int]$TimeoutSeconds = 180,

    # Write the generated region of docs/supported-operation-matrix.md, or compare it and refuse.
    [switch]$RenderDoc,
    [switch]$CheckDoc,

    [switch]$Json,
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# AcceptanceMatrix.ps1 dot-sources AcceptanceFixtures.ps1, which dot-sources the Shelf, seat,
# Notebook and raw-ownership modules the real writers live in.
. (Join-Path $PSScriptRoot 'AcceptanceMatrix.ps1')
# For ConvertTo-GitArgumentString. Windows PowerShell 5.1 has no ProcessStartInfo.ArgumentList, so
# the CommandLineToArgvW quoting rule has to be implemented somewhere -- and GitSource.ps1 already
# implements it, with its own tests. A second copy here would be a second chance to be wrong about
# a rule whose failure mode is a silently mis-split argument.
. (Join-Path $PSScriptRoot 'GitSource.ps1')
. (Join-Path $PSScriptRoot 'AcceptanceSharedCollection.ps1')

$script:ProgramRoot = Split-Path -Parent $PSScriptRoot
# The embedding stand-in of the row running now, and a scratch verdict record the self-test points at (S41).
$script:AcceptanceEmbeddingStandIn = $null
$script:AcceptanceVerdictsPath = $null

function Write-AcceptanceJson {
    <#
    .SYNOPSIS
        Emit one JSON document a caller across a process boundary can actually parse.

    .DESCRIPTION
        NOT `$object | ConvertTo-Json`, AND THE DIFFERENCE IS NOT COSMETIC. PowerShell FORMATS what
        a script writes to its output stream, and formatting wraps long lines at the host width --
        about 120 characters -- even when the stream is redirected to a file. A row's effect map
        carries whole files, so every document this harness produced was line-wrapped INSIDE its
        string values and would not parse: measured 2026-09-22, `Invalid control character at line
        35 column 1077`. docs/helper-write-and-output-contracts.md records exactly this failure
        for the helpers, and it applies to a test harness the moment anything reads its output.

        The encoding is set for the write and put back. Without it the console's ANSI codepage
        mangles every non-ASCII character in the document, which is the other half of the same
        defect -- a reader gets a byte sequence that is not UTF-8 and cannot say why.
    #>
    param([Parameter(Mandatory = $true)]$Value, [int]$Depth = 12)
    $json = $Value | ConvertTo-Json -Depth $Depth
    $previous = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        [Console]::Out.WriteLine($json)
    }
    finally { [Console]::OutputEncoding = $previous }
}

function Resolve-AcceptanceToken {
    <# One string with its {tokens} replaced from the fixture record. #>
    param([AllowEmptyString()][string]$Text, [Parameter(Mandatory = $true)]$Fixture, [string]$PlanId = '', [string]$Quarantine = '', [int]$AgentPid = 0)
    $value = [string]$Text
    # The forward-slash spelling of the arm's own workspace (S42), for a path a `prepare` writes into JSON.
    $value = $value.Replace('{workspace_slash}', ([string]$Fixture.workspace).Replace('\', '/'))
    $value = $value.Replace('{workspace}', [string]$Fixture.workspace)
    $value = $value.Replace('{registry}', [string]$Fixture.registry)
    $value = $value.Replace('{root}', [string]$Fixture.root)
    $value = $value.Replace('{seat}', [string]$Fixture.seat)
    $value = $value.Replace('{second_seat}', [string]$Fixture.second_seat)
    $value = $value.Replace('{collection_id}', [string]$Fixture.collection_id)
    if (@($Fixture.PSObject.Properties.Name) -ccontains 'second_workspace') {
        # THE FORWARD-SLASH SPELLING (S36), for a path inside a JSON payload: `{second_workspace}` there
        # would put raw backslashes into a string, which is not JSON. Replaced first, as the longer token.
        $value = $value.Replace('{second_workspace_slash}', ([string]$Fixture.second_workspace).Replace('\', '/'))
        $value = $value.Replace('{second_workspace}', [string]$Fixture.second_workspace)
    }
    $value = $value.Replace('{program}', $script:ProgramRoot)
    $value = $value.Replace('{plan_id}', $PlanId)
    $value = $value.Replace('{quarantine}', $Quarantine)
    $value = $value.Replace('{agent_pid}', [string]$AgentPid)
    $value
}

function Start-AcceptanceStandInAgent {
    <#
    .SYNOPSIS
        A live process for a row to bind a seat to, owned by the harness. Its pid is `{agent_pid}`.

    .DESCRIPTION
        A ROW THAT BINDS A SEAT MUST NAME THE PROCESS IT BINDS, AND IT MUST NOT BE WHOEVER RAN THE
        HARNESS (S14, 2026-09-22). Until this token the enter row passed no agent, so both arms
        resolved one from CLAUDE_PID -- which the child inherits -- and bound the fixture seat to the
        Claude Code session that happened to run the matrix, then left a claim holder waiting on that
        session for the rest of its life, holding a file in a fixture nothing could delete. From a plain
        terminal the same row resolved no agent at all and refused. One row, two answers, decided by who
        launched it.

        So the harness starts the agent, hands its pid to both arms' steps, and kills it once the arm's
        effect is captured -- which is what ends every claim holder waiting on it.
    #>
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 900') `
        -PassThru -WindowStyle Hidden
}

function Stop-AcceptanceStandInAgent {
    <#
    .SYNOPSIS
        End the stand-in, then wait -- bounded -- for every claim a holder took on its behalf to let go.

    .DESCRIPTION
        A holder notices its agent's death on its own schedule: the PowerShell one polls every two
        seconds, the kernel's blocks in a waiter. Deleting the fixture while one still held `.claim`
        would fail silently under -ErrorAction SilentlyContinue and leave the directory behind, so the
        release is waited for and a claim that outlives the bound is said to have.
    #>
    param($Agent, [Parameter(Mandatory = $true)]$Fixture, [int]$TimeoutSeconds = 20)
    if ($null -eq $Agent) { return $true }
    try { Stop-Process -Id $Agent.Id -Force -ErrorAction Stop } catch { }
    $seatsRoot = Join-Path ([string]$Fixture.state_directory) 'seats'
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $held = @(Get-ChildItem -LiteralPath $seatsRoot -Directory -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -cne [string]$Fixture.seat -and (Test-SeatClaim -StateDirectory ([string]$Fixture.state_directory) -Seat $_.Name)
        })
        if (-not $held.Count) { return $true }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    $false
}

function Invoke-AcceptanceProcess {
    <#
    .SYNOPSIS
        Run one child process and return its exit code, stdout and stderr.

    .DESCRIPTION
        BOTH STREAMS ARE DRAINED ASYNCHRONOUSLY, which is not a refinement: a child that fills the
        stderr pipe while the parent is blocked reading stdout deadlocks, and the suite would hang
        rather than fail.

        A TIMEOUT KILLS THE TREE. A helper that spawns its own child -- and several do -- leaves
        that child holding the fixture's files, and the run then fails at cleanup with an error
        about a directory rather than about the row.

        A ROW'S STDIN ARRIVES AS THE BYTES THE ROW DECLARED, AND IT DID NOT UNTIL S15. .NET builds
        `Process.StandardInput` as a StreamWriter over `[Console]::InputEncoding`, and this host's
        is UTF-8 WITH a 3-byte preamble -- so every `$process.StandardInput.Write($Stdin)` put
        `ef bb bf` in front of the request. Reaching past it does not help: `StreamWriter.BaseStream`
        FLUSHES the writer on the way out, which is what emits the preamble, so writing raw bytes
        there produced the same three bytes first. Measured 2026-09-22 with a child that dumped its
        own stdin: `ef bb bf 7b 22 61 22 3a 31 7d`.

        WHAT IT COST, AND IT IS THE WHOLE STDIN HALF OF THE MATRIX. `.claude/adapters/
        Validated-BookReader.ps1` parses one JSON-RPC line per iteration; a BOM-prefixed line fails
        `ConvertFrom-Json`, and its catch answers only when an inbound id was recovered -- which a
        line that never parsed has none of. So the adapter read the request, said NOTHING, and
        exited 0. Every row whose PowerShell arm drives the adapter over stdin -- five `reader`
        rows, both `discovery` rows and `search.full-text-over-open-books-only` -- compared an
        EMPTY stdout against whatever the kernel answered, and no kernel could ever have matched
        it. The harness was the arm that failed, not the adapter and not the kernel.

        SO THE ENCODING IS SET AND VERIFIED, NEVER ASSUMED. It is set only where there is stdin to
        write, checked by reading the preamble back, and RESTORED. A host that will not take the
        setting makes the step refuse by name rather than silently delivering three bytes the row
        never declared -- which is the failure this replaces.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory,
        [hashtable]$Environment = @{},
        [string]$Stdin = '',
        [int]$TimeoutSeconds = 180
    )

    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $FileName
    $psi.Arguments = ConvertTo-GitArgumentString $Arguments
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) { $psi.WorkingDirectory = $WorkingDirectory }
    foreach ($key in @($Environment.Keys)) { $psi.EnvironmentVariables[[string]$key] = [string]$Environment[$key] }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $psi
    $timedOut = $false
    # Set BEFORE the first touch of $process.StandardInput, because that is where .NET builds the
    # StreamWriter and captures the encoding it will write the preamble from.
    #
    # FOR EVERY STEP, NOT ONLY ONE WITH STDIN (S36, measured). A step that declares none still has its
    # stdin redirected and closed, and closing the writer FLUSHES the preamble: under this session's host,
    # every such step received `ef bb bf`. Most scripts never read it; `Publish-ShelfBookBatchToShared.ps1`
    # binds pipeline input, so its oracle arm wrote "The input object cannot be bound to any parameters"
    # to stderr and its row turned red -- on a host whose input encoding carries a preamble, and only there.
    $previousInputEncoding = $null
    if ($true) {
        $previousInputEncoding = [Console]::InputEncoding
        try { [Console]::InputEncoding = [Text.UTF8Encoding]::new($false) }
        catch { throw "this step's stdin cannot be delivered: [Console]::InputEncoding would not accept preamble-less UTF-8 ($($_.Exception.Message)), and a BOM ahead of the request is not what the row declared." }
        if ([Console]::InputEncoding.GetPreamble().Length -ne 0) {
            [Console]::InputEncoding = $previousInputEncoding
            throw "this step's stdin cannot be delivered: [Console]::InputEncoding still carries a $([Console]::InputEncoding.GetPreamble().Length)-byte preamble, which would arrive ahead of the request."
        }
    }
    try {
        [void]$process.Start()
        if ([string]::IsNullOrEmpty($Stdin)) { $process.StandardInput.Close() }
        else {
            $process.StandardInput.Write($Stdin)
            $process.StandardInput.Close()
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $timedOut = $true
            try { & taskkill.exe '/T' '/F' '/PID' $process.Id 2>&1 | Out-Null } catch { }
            try { if (-not $process.HasExited) { $process.Kill() } } catch { }
            [void]$process.WaitForExit(5000)
        }
        [pscustomobject]@{
            exit      = if ($timedOut) { -1 } else { $process.ExitCode }
            stdout    = [string]$stdoutTask.Result
            stderr    = if ($timedOut) { "the step did not finish within $TimeoutSeconds seconds" } else { [string]$stderrTask.Result }
            timed_out = $timedOut
        }
    }
    finally {
        $process.Dispose()
        if ($null -ne $previousInputEncoding) {
            try { [Console]::InputEncoding = $previousInputEncoding } catch { }
        }
    }
}

function Resolve-AcceptanceKernelCommand {
    <#
    .SYNOPSIS
        A kernel command line typed in one directory, made valid in another.

    .DESCRIPTION
        THE HARNESS MOVES THE WORKING DIRECTORY OUT FROM UNDER THE COMMAND IT WAS GIVEN. Every step
        runs with the FIXTURE as its working directory, which is the whole point -- a row about
        walking up from a subdirectory cannot be answered from the program root. But the caller typed
        `-Kernel 'node kernel/src/cli.ts'` standing in the program root, and that path means nothing
        inside a fixture.

        MEASURED 2026-09-22 (S14), and it is the exact defect shape S13 recorded one layer down. Both
        `kernel/README.md` and `docs/supported-operation-matrix.md` print that relative command as
        THE development invocation. Run as written it produced `Cannot find module
        <fixture>\kernel\src\cli.ts` on stderr, exit 1, on EVERY row -- so all three ported areas
        reported 0 green and 19 mismatch, and each mismatch looked exactly like an unported verb
        refusing by name. S13's 13 green were real; they are simply not what that command line
        measures. A row that fails for a reason that has nothing to do with the kernel is a row that
        tested nothing, and eight of them agreed with each other about it.

        SO A PART THAT NAMES A FILE HERE IS MADE ABSOLUTE HERE. It is still a command line rather than
        a path -- the split and the remaining parts are untouched -- and a part that names no file on
        disk (`node`, `bun`, `run`, `powershell.exe`) is left exactly as typed, which is what keeps an
        interpreter found on PATH working.
    #>
    [CmdletBinding()]
    param([AllowEmptyString()][string]$KernelCommand, [string]$BaseDirectory)

    if ([string]::IsNullOrWhiteSpace($KernelCommand)) { return $KernelCommand }
    if ([string]::IsNullOrWhiteSpace($BaseDirectory)) { $BaseDirectory = (Get-Location).Path }
    $parts = @(@($KernelCommand -split '\s+') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $resolved = foreach ($part in $parts) {
        # An already-absolute part is left alone: it is already valid from every directory.
        if ([IO.Path]::IsPathRooted($part)) { $part; continue }
        $candidate = $null
        try { $candidate = [IO.Path]::GetFullPath((Join-Path $BaseDirectory $part)) } catch { $candidate = $null }
        if ($null -ne $candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $candidate } else { $part }
    }
    @($resolved) -join ' '
}

# The kernel's own program root, which is not always this one's. Set once at the entry point from the
# kernel's `--version`; until then, and for any kernel that does not answer it, it is this program.
$script:KernelProgramRoot = $script:ProgramRoot
$script:KernelCompiled = $false

function Test-AcceptanceKernelCompiled {
    <# Whether the kernel under test reports itself compiled, which decides how its remedies are said (S47). #>
    param([AllowEmptyString()][string]$KernelCommand)
    if ([string]::IsNullOrWhiteSpace($KernelCommand)) { return $false }
    $parts = @(@($KernelCommand -split '\s+') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $arguments = @(@($parts | Select-Object -Skip 1) + '--version')
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $answer = (& $parts[0] @arguments 2>$null | Out-String)
        ($LASTEXITCODE -eq 0) -and (($answer | ConvertFrom-Json).compiled -eq $true)
    }
    catch { $false }
    finally { $ErrorActionPreference = $previous }
}

function Get-AcceptanceKernelProgramRoot {
    <#
    .SYNOPSIS
        The program root the kernel under test reports for itself, or this program's when it reports none.

    .DESCRIPTION
        THE KERNEL ARM IS ALSO NORMALISED WITH ITS OWN PROGRAM ROOT (S29). `node kernel/src/cli.ts` runs inside
        this checkout, so the two roots were one directory and one token covered both. An INSTALLED
        kernel is not: measured 2026-09-22 against the binary install.ps1 placed, its program is
        `%LOCALAPPDATA%\deskpost\versions\<v>`, and every path `library init` writes from it --
        hook scripts, the reader adapter -- compared as a difference against `<program>`, on two
        rows, 26 fields each. Which absolute directory a program is installed in is exactly the
        value normalisation already names as incidental.

        S29 KEPT THIS ONE'S TOO, AND S30 WITHDREW IT. S29's first cut gave the kernel arm its own root
        alone and 30 green rows mismatched on 4 fields each: the fixture's `.mcp.json`, hook blocks and
        Codex bindings, written by THIS checkout's `init`. So it normalised both, conceding that a
        kernel writing this checkout's path into a workspace would compare green. Since S30 the kernel
        arm's fixture is initialised by the kernel's own program (New-AcceptanceFixture -ProgramRoot),
        and the whole matrix against the installed binary stayed green with the kernel's root alone
        (measured) -- so the kernel arm reads exactly one root, and this checkout's is a difference.
    #>
    [CmdletBinding()]
    param([AllowEmptyString()][string]$KernelCommand)
    if ([string]::IsNullOrWhiteSpace($KernelCommand)) { return $script:ProgramRoot }
    $parts = @(@($KernelCommand -split '\s+') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $arguments = @(@($parts | Select-Object -Skip 1) + '--version')
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $answer = (& $parts[0] @arguments 2>$null | Out-String)
        if ($LASTEXITCODE -ne 0) { return $script:ProgramRoot }
        $root = [string]($answer | ConvertFrom-Json).program_root
        if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) { return $script:ProgramRoot }
        [IO.Path]::GetFullPath($root).TrimEnd('\', '/')
    }
    catch { $script:ProgramRoot }
    finally { $ErrorActionPreference = $previous }
}

function Get-AcceptanceArmProgramRoot {
    <#
        The ONE root an arm reads as <program>: this checkout's in the PowerShell arm, the kernel's own
        in the kernel arm. S29 gave the kernel arm both, conceding that a kernel writing THIS checkout's
        path would compare green, because its fixture was initialised by this checkout. Since S30 the
        kernel arm's fixture is initialised by the kernel's own program (New-AcceptanceFixture
        -ProgramRoot), so nothing in it carries this checkout's path and the concession is withdrawn.
    #>
    param([Parameter(Mandatory = $true)][ValidateSet('powershell', 'kernel')][string]$Arm)
    if ($Arm -eq 'kernel') { $script:KernelProgramRoot } else { $script:ProgramRoot }
}

function Get-AcceptanceChildEnvironment {
    <#
    .SYNOPSIS
        The environment a step's child process runs in.

    .DESCRIPTION
        LIBRARY_WORKSPACE IS CLEARED, ALWAYS. A row that asks how a workspace is resolved cannot be
        answered by a harness that has already answered it -- S17 measured three suites breaking on
        exactly that, and workspace resolution was the subject of all three. Rows pass an explicit
        path or rely on the walk-up their own row is about.

        LIBRARY_SEAT IS SET ONLY WHERE THERE IS A SEAT, because there is no default seat: a
        seatless session reads the Library's own files and nothing else, and a fixture with no seat
        must show that rather than borrow one.
    #>
    param([Parameter(Mandatory = $true)]$Fixture, $StepEnvironment)
    # A STEP'S OWN VALUES TAKE THE ROW'S TOKENS (S36), so a row about the registry can point
    # LIBRARY_WORKSPACES at `{registry}` -- the fixture's -- rather than at this machine's, which every
    # step read until then because nothing set it.
    $environment = @{
        LIBRARY_WORKSPACE = ''
        LIBRARY_SEAT      = if ([bool]$Fixture.seated) { [string]$Fixture.seat } else { '' }
        # THIS MACHINE'S CLAUDE CODE CONFIGURATION IS NOT THE FIXTURE'S (S42). `doctor` and the reader's
        # launch warning now read which plugins Claude has enabled, and a step would otherwise read the
        # person running the harness's own `~/.claude`. An empty directory of the fixture's; a row about
        # an installed plugin points its step at one it prepared.
        # A synthetic fixture with no root (the self-test's) gets a directory that does not exist. NOT an empty
        # value: both arms read an empty CLAUDE_CONFIG_DIR as unset, and fall back to the user's own.
        CLAUDE_CONFIG_DIR = if (@($Fixture.PSObject.Properties.Name) -ccontains 'root' -and [string]$Fixture.root) { Join-Path ([string]$Fixture.root) 'claude-config' } else { Join-Path ([IO.Path]::GetTempPath()) 'acceptance-no-claude-config' }
    }
    # A SHARED FIXTURE'S COLLECTION RIDES IN THE ENVIRONMENT TOO (S32), because the environment
    # outranks every file LibraryDeployment.ps1 falls back to -- the program root's own pin among
    # them, which is the reader's collection. A step cannot override these.
    # Cleared for every other row, so an offline row cannot inherit an endpoint from the shell.
    $shared = @{ AI_LIBRARY_MCP_URL = ''; AI_LIBRARY_PROJECT_ID = ''; LIBRARY_SHARED_COLLECTION_ROOT = '' }
    if (@($Fixture.PSObject.Properties.Name) -ccontains 'shared_root' -and [string]$Fixture.shared_root) {
        $shared = @{
            AI_LIBRARY_MCP_URL             = [string]$Fixture.mcp_url
            AI_LIBRARY_PROJECT_ID          = [string]$Fixture.collection_id
            LIBRARY_SHARED_COLLECTION_ROOT = [string]$Fixture.shared_root
        }
    }
    # THE EMBEDDING SERVICE IS THE HARNESS'S STAND-IN OR NOTHING (S41, the reader's ruling). Every step's
    # TEI_* is set, so no row -- the duplicate detector's or any other -- can reach the reader's own
    # inference server through a variable inherited from the shell that ran the matrix.
    $standIn = $script:AcceptanceEmbeddingStandIn
    $shared['TEI_EMBEDDING_URL'] = if ($null -ne $standIn) { [string]$standIn.url } else { '' }
    $shared['TEI_API_KEY'] = if ($null -ne $standIn) { [string]$standIn.key } else { '' }
    foreach ($name in @(Get-AcceptanceObjectKeys $StepEnvironment)) {
        if ($shared.ContainsKey($name)) { throw "a step may not set ${name}: a shared row's collection is the harness's to pin" }
        $environment[$name] = Resolve-AcceptanceToken -Text ([string]$StepEnvironment.$name) -Fixture $Fixture
    }
    foreach ($name in $shared.Keys) { $environment[$name] = $shared[$name] }
    $environment
}

function Invoke-AcceptanceArm {
    <#
    .SYNOPSIS
        Run one arm of one row over a fixture, and return its normalised outcome.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Row,
        [Parameter(Mandatory = $true)][ValidateSet('powershell', 'kernel')][string]$Arm,
        [Parameter(Mandatory = $true)]$Fixture,
        [string]$KernelCommand,
        [int]$TimeoutSeconds = 180
    )

    $steps = @($Row.$Arm.steps)
    # THE STAND-IN IS STARTED ONLY FOR A ROW THAT NAMES ONE, and before the tokens are computed: its pid
    # is normalised BY VALUE, so a binding that named any other process -- the harness's own agent, say
    # -- stays a difference rather than disappearing into a generic pid rule.
    $standIn = $null
    if ((@($steps) | ConvertTo-Json -Depth 8 -Compress) -cmatch '\{agent_pid\}') {
        $standIn = Start-AcceptanceStandInAgent
        $Fixture | Add-Member -NotePropertyName 'agent_pid' -NotePropertyValue ([int]$standIn.Id) -Force
    }
    $agentPid = if ($null -ne $standIn) { [int]$standIn.Id } else { 0 }
    $tokens = Get-AcceptanceNormalisationTokens -Fixture $Fixture -ProgramRoot (Get-AcceptanceArmProgramRoot -Arm $Arm)
    $planId = ''
    # THE QUARANTINE A RESET MADE, carried like the plan id and for the same reason (S17). A reset
    # names its directory `<seat>-<yyyyMMdd-HHmmss>` at the instant it runs, and a restore takes that
    # name and nothing else -- so a row about getting material BACK cannot be written with a literal,
    # and until this token existed the restore row's oracle arm ran `-List` instead: a roster, which
    # restores nothing, compared against a kernel arm that restored.
    $quarantine = ''
    $last = $null
    $stepRecords = [Collections.Generic.List[object]]::new()

    foreach ($step in $steps) {
        $stepKeys = @(Get-AcceptanceObjectKeys $step)

        # A KERNEL STEP THAT WRITES A FILE (S18). The one input no command produces is a hand edit, and
        # under ADR-0029 the file a person would edit is somewhere only the kernel's own migration puts
        # it -- so it cannot be `prepare`d before the arm runs. Whole files, inside the workspace, as
        # `prepare`; `acceptance.matrix-shape` refuses anything else and refuses a row that ends here.
        if ($Arm -ceq 'kernel' -and $stepKeys -ccontains 'write') {
            $written = [Collections.Generic.List[string]]::new()
            foreach ($entry in @($step.write)) {
                $relative = Resolve-AcceptanceToken -Text ([string]$entry.path) -Fixture $Fixture -PlanId $planId -Quarantine $quarantine -AgentPid $agentPid
                $target = Join-Path ([string]$Fixture.workspace) $relative
                $directory = Split-Path -Parent $target
                if (-not (Test-Path -LiteralPath $directory -PathType Container)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
                [IO.File]::WriteAllText($target, (([string]$entry.text) -replace "`r`n", "`n"), [Text.UTF8Encoding]::new($false))
                [void]$written.Add($relative)
            }
            [void]$stepRecords.Add([pscustomobject]@{ step = @($stepRecords).Count + 1; exit = 0; script = 'write ' + ($written -join ', ') })
            continue
        }

        $workingDirectory = if ($stepKeys -ccontains 'working_directory') {
            Resolve-AcceptanceToken -Text ([string]$step.working_directory) -Fixture $Fixture -PlanId $planId -Quarantine $quarantine -AgentPid $agentPid
        }
        else { [string]$Fixture.root }
        $stdin = if ($stepKeys -ccontains 'stdin') { Resolve-AcceptanceToken -Text ([string]$step.stdin) -Fixture $Fixture -PlanId $planId -Quarantine $quarantine -AgentPid $agentPid } else { '' }
        $environment = Get-AcceptanceChildEnvironment -Fixture $Fixture -StepEnvironment $(if ($stepKeys -ccontains 'environment') { $step.environment } else { $null })

        if ($Arm -ceq 'powershell') {
            $script = Join-Path $script:ProgramRoot ([string]$step.script)
            $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script)
            foreach ($argument in @(Get-AcceptanceOptionalList -Object $step -Name 'args')) {
                $arguments += (Resolve-AcceptanceToken -Text ([string]$argument) -Fixture $Fixture -PlanId $planId -Quarantine $quarantine -AgentPid $agentPid)
            }
            $last = Invoke-AcceptanceProcess -FileName 'powershell.exe' -Arguments $arguments `
                -WorkingDirectory $workingDirectory -Environment $environment -Stdin $stdin -TimeoutSeconds $TimeoutSeconds
        }
        else {
            # THE KERNEL COMMAND IS SPLIT ON WHITESPACE ONCE, at the harness boundary: it is a
            # command line the caller typed, not a path, because a kernel under development is
            # reached as `bun run src/cli.ts` at least as often as it is reached as one executable.
            $parts = @(@($KernelCommand -split '\s+') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            if (-not $parts.Count) { throw 'the kernel arm was asked to run with no kernel command' }
            $arguments = @()
            if ($parts.Count -gt 1) { $arguments = @($parts[1..($parts.Count - 1)]) }
            foreach ($argument in @($step.command)) {
                $arguments += (Resolve-AcceptanceToken -Text ([string]$argument) -Fixture $Fixture -PlanId $planId -Quarantine $quarantine -AgentPid $agentPid)
            }
            $last = Invoke-AcceptanceProcess -FileName $parts[0] -Arguments $arguments `
                -WorkingDirectory $workingDirectory -Environment $environment -Stdin $stdin -TimeoutSeconds $TimeoutSeconds
        }

        # THE PLAN ID IS CARRIED FROM ONE STEP TO THE NEXT, which is what makes a gated operation
        # expressible as a row at all. A preflight issues it; the confirming step is the only place
        # it can come from, because an approval bound to a digest cannot be composed by the caller.
        $parsed = ConvertFrom-AcceptanceStdout -Text ([string]$last.stdout)
        if ($null -ne $parsed -and @(Get-AcceptanceObjectKeys $parsed) -ccontains 'plan_id') {
            $planId = [string]$parsed.plan_id
        }
        elseif ([string]$last.stdout -cmatch '(?ms)^\s*plan_id\s*:\s*(\S.*?)(?=\r?\n\s*\S[^\r\n:]*:|\r?\n\s*\r?\n|\z)') {
            # NOT EVERY GATED HELPER HAS A -Json. `Reset-LocalNotebook.ps1` has none at all, so its
            # preflight speaks prose, and a row that could only read a plan id out of JSON passed an
            # EMPTY one to the confirming step -- which the helper correctly refused, and which read
            # as "the reset row is broken" rather than "the harness cannot see the id".
            #
            # IT PARSES THE ITEM, NOT THE LINE, which is defect family 3 and cost this session a
            # second round. PowerShell's list formatting WRAPS a long value at the host width, so a
            # 78-character plan id arrives as 76 characters and `3b` indented on the next line. A
            # `(\S+)$` capture took the first part, the helper refused a plan that described a state
            # it could not match, and the refusal named the STATE rather than the id -- which is the
            # correct message for the wrong diagnosis. Continuations are consumed to the next
            # property label or the blank line, and the whitespace inside is removed, because the
            # wrap is inside one unbroken token.
            $planId = [regex]::Replace([string]$Matches[1], '\s+', '')
        }
        if ($null -ne $parsed -and @(Get-AcceptanceObjectKeys $parsed) -ccontains 'quarantine_directory' -and
            -not [string]::IsNullOrWhiteSpace([string]$parsed.quarantine_directory)) {
            $quarantine = Split-Path -Leaf ([string]$parsed.quarantine_directory)
        }
        [void]$stepRecords.Add([pscustomobject]@{
            step   = @($stepRecords).Count + 1
            exit   = $last.exit
            script = if ($Arm -ceq 'powershell') { [string]$step.script } else { (@($step.command) -join ' ') }
        })
    }

    # THE PLAN ID THIS ARM CARRIED, BY VALUE (S40): see ConvertTo-AcceptanceNormalisedText. Known only
    # once the steps have run, so it joins the tokens here, before anything is normalised.
    if ($planId -cmatch '[0-9a-f]{16}$') {
        $tokens = @(@($tokens) + [pscustomobject]@{ literal = ''; token = '<plan-tail>'; plan_tail = $Matches[0] })
    }
    $parsed = ConvertFrom-AcceptanceStdout -Text ([string]$last.stdout)
    # THE EFFECT IS CAPTURED WHILE THE STAND-IN LIVES, so a claim its holder took is on disk as a held
    # claim -- which is part of what "binds this process" means -- and only then is the agent ended.
    $outcome = [ordered]@{
        exit   = [int]$last.exit
        stderr = (ConvertTo-AcceptanceNormalisedMessage -Text ([string]$last.stderr) -Tokens $tokens)
        effect = (Get-AcceptanceEffect -Workspace ([string]$Fixture.workspace) -Tokens $tokens)
        steps  = @($stepRecords)
    }
    if ($null -ne $standIn -and -not (Stop-AcceptanceStandInAgent -Agent $standIn -Fixture $Fixture)) {
        $outcome['holder_outlived_agent'] = $true
    }
    if ($null -eq $parsed) { $outcome['stdout'] = (ConvertTo-AcceptanceNormalisedText -Text ([string]$last.stdout) -Tokens $tokens) }
    else { $outcome['result'] = (ConvertTo-AcceptanceNormalisedData -Value $parsed -Tokens $tokens) }
    # THE ORACLE'S SENTENCES AS AN INSTALLED KERNEL SAYS THEM (S47, ADR-0045): see
    # ConvertTo-AcceptanceInstalledRemedy. After normalisation, so the program root is `<program>` in both arms.
    if ($Arm -ceq 'powershell' -and $script:KernelCompiled) {
        $before = ($outcome | ConvertTo-Json -Depth 30 -Compress)
        $outcome['stderr'] = ConvertTo-AcceptanceInstalledRemedy -Text ([string]$outcome['stderr'])
        if ($outcome.Contains('stdout')) { $outcome['stdout'] = ConvertTo-AcceptanceInstalledRemedy -Text ([string]$outcome['stdout']) }
        else { $outcome['result'] = ConvertTo-AcceptanceInstalledRemedyFields -Value $outcome['result'] }
        # WHICH ROWS THE RULE MOVES, named by id on the host stream (ADR-0045: the reader sees them by id).
        if (($outcome | ConvertTo-Json -Depth 30 -Compress) -cne $before) { [Console]::Error.WriteLine("remedy rule applied: $([string]$Row.id)") }
    }
    [pscustomobject]$outcome
}

function ConvertFrom-AcceptanceStdout {
    <#
    .SYNOPSIS
        Stdout as parsed JSON, or $null when it is not JSON.

    .DESCRIPTION
        A helper's `-Json` output is a document; its human output is prose. Both are outcomes worth
        comparing, and only one of them has fields. Parsing is attempted and never required, so a
        row against a helper with no -Json still compares -- on its whole text, which is a stricter
        test rather than a weaker one.
    #>
    param([AllowEmptyString()][string]$Text)
    $trimmed = ([string]$Text).Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) { return $null }
    if (-not ($trimmed.StartsWith('{') -or $trimmed.StartsWith('['))) { return $null }
    try { return ($trimmed | ConvertFrom-Json) }
    catch { return $null }
}

function Invoke-AcceptancePrepare {
    <#
    .SYNOPSIS
        Apply a row's `prepare` entries to a freshly built fixture: the same bytes, in both arms,
        before anything is snapshotted or run.

    .DESCRIPTION
        WHY A ROW MAY ADJUST ITS FIXTURE AT ALL (S17). A fixture is a shape built through the real
        writers, and that is right for every state a writer can produce. It cannot produce the one
        state `compile.master-index-is-derived-not-written` is about: a master index a PERSON edited.
        No Library writer hand-edits a derived file, so no fixture holds one -- and the row ran the
        renderer over a clean index, rewrote identical bytes, and compared two arms agreeing about a
        no-op. A row whose subject is recovery from a state the writers never leave has to be able to
        name that state.

        NARROW ON PURPOSE. Whole files, relative to the workspace, written as UTF-8 with no BOM and
        LF endings -- nothing that runs, nothing outside the workspace, and applied identically to
        both arms after each is built from scratch. `acceptance.matrix-shape` refuses a path that is
        rooted or climbs out. A mechanism that could run code here would be a second, unreviewed
        fixture builder.
    #>
    param([Parameter(Mandatory = $true)]$Row, [Parameter(Mandatory = $true)]$Fixture)
    foreach ($entry in @(Get-AcceptanceOptionalList -Object $Row -Name 'prepare')) {
        $relative = [string]$entry.path
        $target = Join-Path ([string]$Fixture.workspace) $relative
        $directory = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
        # THE ARM'S OWN TOKENS (S42), so a prepared file can name a path inside that arm's fixture -- an
        # installed plugin's `installPath`, which Claude Code records as absolute. Tokens only: nothing runs.
        $text = (Resolve-AcceptanceToken -Text ([string]$entry.text) -Fixture $Fixture) -replace "`r`n", "`n"
        [IO.File]::WriteAllText($target, $text, [Text.UTF8Encoding]::new($false))
    }
}

function Add-AcceptanceSecondWorkspace {
    <#
    .SYNOPSIS
        A second workspace for an offline row whose steps name `{second_workspace}` (S36): a
        `workspace-fresh` fixture at `<root>\second`, registered in THE ARM'S OWN REGISTRY.

    .DESCRIPTION
        WHY IT EXISTS. A guard asked about an absolute path into ANOTHER registered workspace denies it
        whatever that workspace's Desk says, and no row reached that rule: every fixture is one
        workspace, and the only registry a step could read was this machine's. So the second workspace
        is registered beside the first, a row points LIBRARY_WORKSPACES at `{registry}`, and the path
        is under the fixture root, so `<fixture-root>` normalises it the same in both arms.

        Built by the ARM'S program, as the first one is. Never snapshotted: it is a precondition. A
        seed that names `{second_workspace}` builds its own, shared, beside the fixture instead.
    #>
    param([Parameter(Mandatory = $true)]$Row, [Parameter(Mandatory = $true)]$Fixture, [string]$ProgramRoot)
    $named = (@(@($Row.powershell.steps) + @($Row.kernel.steps) + @(Get-AcceptanceOptionalList -Object $Row -Name 'prepare')) |
        ConvertTo-Json -Depth 8 -Compress) -cmatch '\{second_workspace'
    if (-not $named) { return }
    $second = New-AcceptanceFixture -Id 'workspace-fresh' -Root (Join-Path ([string]$Fixture.root) 'second') -ProgramRoot $ProgramRoot -RegistryRoot ([string]$Fixture.registry)
    $Fixture | Add-Member -NotePropertyName 'second_workspace' -NotePropertyValue ([string]$second.workspace) -Force
}

function Invoke-AcceptanceSeed {
    <#
    .SYNOPSIS
        Run a shared row's `seed` steps into one arm's disposable project: the REAL writers, the same
        invocations in both arms, before anything is snapshotted.

    .DESCRIPTION
        WHY A SHARED ROW SEEDS AT ALL (S33). A disposable project starts with nothing in it but its
        catalogs, and seven rows reached their helper's body only to refuse for want of a Hub, an open
        Project or a Book the project did not hold -- so they measured "the collection is empty", twice,
        and compared green on it. `prepare` cannot help: it writes whole files into the WORKSPACE, and
        what these rows need is in the collection, where only a writer puts it.

        SO A SEED IS A POWERSHELL STEP, NEVER A FILE, and always this checkout's writer in BOTH arms,
        because the state it produces is the row's precondition rather than its subject: New-ProjectHub
        makes the Hub the edit rows edit, Set-VirtualDesk opens it, Publish-ShelfBookToShared puts the
        Book the archive row archives. Each step runs with the arm's own environment, so every shared
        variable names that arm's project and nothing else. A step that exits non-zero ends the row as
        an ERROR naming the step: a row whose precondition did not hold has not measured its subject.

        A SECOND WORKSPACE, WHEN A SEED NAMES ONE. `{second_workspace}` is a `workspace-fresh` fixture
        beside the arm's own, pinned to the SAME disposable project, built only for a row that names it.
        It is how the ownership-refusal row gets a collection whose writable role another workspace
        holds. It is never snapshotted: what it leaves in the collection is, as `shared/<path>`.
    #>
    param([Parameter(Mandatory = $true)]$Row, [Parameter(Mandatory = $true)]$Fixture, $Collection, [int]$TimeoutSeconds = 180)
    $seeds = @(Get-AcceptanceOptionalList -Object $Row -Name 'seed')
    if (-not $seeds.Count) { return }
    if ((@($seeds) | ConvertTo-Json -Depth 8 -Compress) -cmatch '\{second_workspace\}') {
        $second = New-AcceptanceFixture -Id 'workspace-fresh' -Root ([string]$Fixture.root + '-second') -SharedCollection $Collection
        $Fixture | Add-Member -NotePropertyName 'second_workspace' -NotePropertyValue ([string]$second.workspace) -Force
    }
    $index = 0
    # A GATED WRITER SEEDS AS IT RUNS: its preflight issues the plan id the confirming step passes,
    # carried exactly as an arm carries one, because an approval cannot be composed by the caller.
    $planId = ''
    foreach ($seed in $seeds) {
        $index++
        # A HAND EDIT OF ONE COLLECTION NOTE, the collection's `prepare`: for the state no writer
        # leaves. A Book whose Catalog entry was LOST is what Add-CatalogEntry exists for, and every
        # publisher lists what it publishes, so the only way to that state is an edit made outside
        # the Library. Whole notes, into this arm's own project, through Basic Memory.
        if (@(Get-AcceptanceObjectKeys $seed) -ccontains 'collection_note') {
            $identifier = [string]$seed.collection_note
            $session = New-AcceptanceMcpSession -McpUrl ([string]$Fixture.mcp_url)
            Invoke-AcceptanceMcpTool -Session $session -Name 'write_note' -Arguments @{
                project_id = [string]$Fixture.collection_id; directory = (Split-Path -Parent $identifier) -replace '\\', '/'
                title = (Split-Path -Leaf $identifier); content = (([string]$seed.text) -replace "`r`n", "`n")
                note_type = 'note'; overwrite = $true; output_format = 'json'
            } | Out-Null
            continue
        }
        # A DELETE OF ONE COLLECTION NOTE (S43), for the state a writer stopped part way leaves once the
        # obstacle that stopped it is gone: an interrupted publication, resumable, is made by letting the real
        # publisher meet a page it refuses and then removing that page. Into this arm's own project only.
        if (@(Get-AcceptanceObjectKeys $seed) -ccontains 'collection_delete') {
            $session = New-AcceptanceMcpSession -McpUrl ([string]$Fixture.mcp_url)
            Invoke-AcceptanceMcpTool -Session $session -Name 'delete_note' -Arguments @{
                project_id = [string]$Fixture.collection_id; identifier = [string]$seed.collection_delete; output_format = 'json'
            } | Out-Null
            continue
        }
        $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $script:ProgramRoot ([string]$seed.script)))
        foreach ($argument in @(Get-AcceptanceOptionalList -Object $seed -Name 'args')) {
            $arguments += (Resolve-AcceptanceToken -Text ([string]$argument) -Fixture $Fixture -PlanId $planId)
        }
        $ran = Invoke-AcceptanceProcess -FileName 'powershell.exe' -Arguments $arguments -WorkingDirectory ([string]$Fixture.workspace) `
            -Environment (Get-AcceptanceChildEnvironment -Fixture $Fixture -StepEnvironment $null) -TimeoutSeconds $TimeoutSeconds
        # A STEP THAT MUST STOP (S43) holds the precondition only by stopping, and only for its stated reason.
        $expected = if (@(Get-AcceptanceObjectKeys $seed) -ccontains 'expect_failure') { [string]$seed.expect_failure } else { '' }
        if ($expected) {
            $said = ([string]$ran.stderr + "`n" + [string]$ran.stdout)
            if ($ran.exit -eq 0) { throw "seed step $index ($([string]$seed.script)) was expected to stop and exited 0, so the row's precondition does not hold" }
            if (-not $said.Contains($expected)) {
                $first = (@($said -split "`r?`n" | Where-Object { $_.Trim() }) | Select-Object -First 3) -join ' | '
                throw "seed step $index ($([string]$seed.script)) stopped, but not for the stated reason ('$expected'), so the row's precondition does not hold: $first"
            }
            continue
        }
        if ($ran.exit -ne 0) {
            $said = (@(([string]$ran.stderr + "`n" + [string]$ran.stdout) -split "`r?`n" | Where-Object { $_.Trim() }) | Select-Object -First 3) -join ' | '
            throw "seed step $index ($([string]$seed.script)) exited $($ran.exit), so the row's precondition does not hold: $said"
        }
        $parsed = ConvertFrom-AcceptanceStdout -Text ([string]$ran.stdout)
        if ($null -ne $parsed -and @(Get-AcceptanceObjectKeys $parsed) -ccontains 'plan_id') { $planId = [string]$parsed.plan_id }
    }
}

function Start-AcceptanceEmbeddingStandIn {
    <#
    .SYNOPSIS
        Start tools/AcceptanceEmbeddingStandIn.mjs and return its url, its key and its process (S41).
    #>
    $script_ = Join-Path $script:ProgramRoot 'tools/AcceptanceEmbeddingStandIn.mjs'
    $key = 'acceptance-stand-in-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
    $psi = [Diagnostics.ProcessStartInfo]::new('node', ('"{0}" {1}' -f $script_, $key))
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($psi)
    $read = $process.StandardOutput.ReadLineAsync()
    if (-not $read.Wait(15000) -or [string]$read.Result -cnotmatch '^listening (http://127\.0\.0\.1:\d+/v1/embeddings)$') {
        try { $process.Kill() } catch { }
        throw 'the embedding stand-in did not report that it was listening within 15 seconds'
    }
    [pscustomobject]@{ url = $Matches[1]; key = $key; process = $process }
}

function Stop-AcceptanceEmbeddingStandIn($StandIn) {
    if ($null -eq $StandIn) { return }
    # Its stdin closing is what ends it; killed only if it does not.
    try { $StandIn.process.StandardInput.Close() } catch { }
    if (-not $StandIn.process.WaitForExit(5000)) { try { $StandIn.process.Kill() } catch { } }
}

function Get-AcceptanceKernelBinary {
    <#
    .SYNOPSIS
        The kernel's own executable when the kernel under test IS one, or $null when it runs from source.

    .DESCRIPTION
        A recorded verdict binds a release, so it is looked up by the SHA-256 of the file that ran. A kernel
        reached as `node kernel/src/cli.ts` or `bun run ...` has no such file -- its first part is an
        interpreter, and hashing the interpreter would bind a verdict to whichever Node happened to be
        installed -- so it has none, and a real-session row is `pending` from source by construction.
    #>
    param([string]$Kernel)
    $parts = @(@([string]$Kernel -split '\s+') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($parts.Count -ne 1) { return $null }
    if (-not (Test-Path -LiteralPath $parts[0] -PathType Leaf)) { return $null }
    $leaf = [IO.Path]::GetFileNameWithoutExtension($parts[0]).ToLowerInvariant()
    if (@('node', 'bun', 'powershell', 'pwsh') -ccontains $leaf) { return $null }
    (Resolve-Path -LiteralPath $parts[0]).Path
}

function Get-AcceptanceRecordedVerdicts {
    <# `tools/acceptance-verdicts.json`: every verdict a real session recorded, each bound to one binary. #>
    # The self-test points this at a scratch record; nothing else sets it.
    $path = if ($script:AcceptanceVerdictsPath) { $script:AcceptanceVerdictsPath } else { Join-Path $script:ProgramRoot 'tools/acceptance-verdicts.json' }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return @() }
    $document = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json
    @(Get-AcceptanceOptionalList -Object $document -Name 'verdicts')
}

function Invoke-AcceptanceIndependentVerdict {
    <#
    .SYNOPSIS
        The status and detail of one independent row, judged against the kernel under test (S41).

    .DESCRIPTION
        THE READER'S RULING, 2026-09-23 (S41). An independent row is green when:

        - it names a `judge` -- a command whose exit 0 is the property holding -- and that judge passes
          when handed THE KERNEL UNDER TEST as `{kernel}`; or
        - it is a row only a real session can show, declares `recorded_verdict`, and
          `tools/acceptance-verdicts.json` holds a passing verdict for this row bound to the SHA-256 of the
          exact binary under test. A new release is a new binary, so every release is judged again.

        A row with neither says so and stays `independent`: not judged yet, which is not green. With no
        kernel, a judged row is `pending`, as a differential row is.
    #>
    param([Parameter(Mandatory = $true)]$Row, [string]$Kernel)
    $keys = @(Get-AcceptanceObjectKeys $Row)
    if ($keys -ccontains 'judge') {
        if ([string]::IsNullOrWhiteSpace($Kernel)) { return [ordered]@{ status = 'pending'; detail = 'no kernel to hand the judge; pass -Kernel' } }
        $judge = $Row.judge
        $parts = @(@(Get-AcceptanceOptionalList -Object $judge -Name 'command') | ForEach-Object { ([string]$_).Replace('{kernel}', $Kernel) })
        # A part naming a file under this program is made absolute, as the kernel command line is.
        $parts = @($parts | ForEach-Object { if ($_ -cmatch '^(tools|kernel)/') { Join-Path $script:ProgramRoot $_ } else { $_ } })
        $environment = @{ LIBRARY_WORKSPACE = ''; LIBRARY_SEAT = ''; LIBRARY_SEAT_CLAIM = ''; CLAUDE_PID = '' }
        if (@(Get-AcceptanceObjectKeys $judge) -ccontains 'environment') {
            foreach ($name in @(Get-AcceptanceObjectKeys $judge.environment)) { $environment[$name] = ([string]$judge.environment.$name).Replace('{kernel}', $Kernel) }
        }
        $timeout = if (@(Get-AcceptanceObjectKeys $judge) -ccontains 'timeout_seconds') { [int]$judge.timeout_seconds } else { 1800 }
        $arguments = @(if ($parts.Count -gt 1) { $parts[1..($parts.Count - 1)] })
        $ran = Invoke-AcceptanceProcess -FileName $parts[0] -Arguments $arguments -WorkingDirectory $script:ProgramRoot -Environment $environment -TimeoutSeconds $timeout
        $said = @((([string]$ran.stdout) + "`n" + ([string]$ran.stderr)) -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        # The line that names the failure, when there is one: a judge that crashed ends on its runtime's
        # banner (`Node.js v24...`), which says nothing about the row.
        $named = @($said | Where-Object { $_ -cmatch 'FAILED|Error|passed' })
        $last = if ($named.Count) { $named[-1].Trim() } elseif ($said.Count) { $said[-1].Trim() } else { '(the judge said nothing)' }
        if ([int]$ran.exit -eq 0) { return [ordered]@{ status = 'green'; detail = "judged against the kernel under test: $last" } }
        return [ordered]@{ status = 'mismatch'; detail = "the judge failed against the kernel under test (exit $($ran.exit)): $last" }
    }
    if ($keys -ccontains 'recorded_verdict' -and $Row.recorded_verdict -eq $true) {
        if ([string]::IsNullOrWhiteSpace($Kernel)) { return [ordered]@{ status = 'pending'; detail = 'no kernel whose recorded verdict to look up; pass -Kernel' } }
        $binary = Get-AcceptanceKernelBinary -Kernel $Kernel
        if ($null -eq $binary) { return [ordered]@{ status = 'pending'; detail = 'a recorded verdict binds a release binary, and this kernel runs from source' } }
        $sha = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
        $mine = @(Get-AcceptanceRecordedVerdicts | Where-Object { [string]$_.row -ceq [string]$Row.id -and ([string]$_.kernel_sha256).ToLowerInvariant() -ceq $sha })
        if (-not $mine.Count) {
            return [ordered]@{ status = 'pending'; detail = "no verdict is recorded for this binary (sha256 $sha); judge it in a real session and record it in tools/acceptance-verdicts.json" }
        }
        $failed = @($mine | Where-Object { [string]$_.result -cne 'pass' })
        if ($failed.Count) { return [ordered]@{ status = 'mismatch'; detail = "a real session recorded '$($failed[0].result)' for this binary: $($failed[0].evidence)" } }
        return [ordered]@{ status = 'green'; detail = "recorded $($mine[-1].judged_utc) for this binary: $($mine[-1].evidence)" }
    }
    [ordered]@{ status = 'independent'; detail = 'no judge is declared yet, so it is not judged against the kernel: ' + [string]$Row.reason }
}

function Invoke-AcceptanceRow {
    <#
    .SYNOPSIS
        One row, end to end: build the fixtures, run the arms, compare, and return the verdict.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Matrix,
        [Parameter(Mandatory = $true)]$Row,
        [Parameter(Mandatory = $true)][string]$WorkDirectory,
        [string]$Kernel,
        [switch]$IncludeIndependent,
        [switch]$IncludeShared,
        [string]$McpUrl,
        [string]$SharedKnowledgeRoot,
        [switch]$KeepFixtures,
        [int]$TimeoutSeconds = 180
    )

    $id = [string]$Row.id
    $verdict = [ordered]@{
        row     = $id
        area    = [string]$Row.area
        oracle  = [string]$Row.oracle
        fixture = [string]$Row.fixture
        status  = ''
        detail  = ''
    }

    if ([string]$Row.oracle -ceq 'independent' -and -not $IncludeIndependent) {
        $verdict['status'] = 'independent'
        $verdict['detail'] = 'judged against a stated property rather than against PowerShell: ' + [string]$Row.reason
        return [pscustomobject]$verdict
    }
    $requires = @(Get-AcceptanceOptionalList -Object $Row -Name 'requires')
    # `embedding-service` is the harness's own stand-in (S41), so it needs nothing from the network.
    $needsNetwork = @($requires | Where-Object { [string]$_ -cne 'embedding-service' })
    if ($needsNetwork.Count -and -not $IncludeShared) {
        $verdict['status'] = 'skipped'
        $verdict['detail'] = 'needs ' + ($needsNetwork -join ' and ') + '; pass -IncludeShared to run it'
        return [pscustomobject]$verdict
    }
    # AN INDEPENDENT ROW IS NEVER COMPARED (S41). Until S41 `-IncludeIndependent` fell through to the
    # differential arms below -- a PowerShell TEST SUITE compared against a kernel command, which measures
    # nothing -- so no independent row could be green and `-RequireGreen` could not pass as built.
    if ([string]$Row.oracle -ceq 'independent') {
        foreach ($entry in (Invoke-AcceptanceIndependentVerdict -Row $Row -Kernel $Kernel).GetEnumerator()) { $verdict[$entry.Key] = $entry.Value }
        return [pscustomobject]$verdict
    }

    $rowRoot = Join-Path $WorkDirectory ($id -replace '[^a-z0-9.-]', '_')
    $powershellRoot = Join-Path $rowRoot 'powershell'
    $kernelRoot = Join-Path $rowRoot 'kernel'
    $claimed = $false
    # A SHARED ROW RUNS EACH ARM IN A PROJECT OF ITS OWN (S32). Made immediately before that arm's
    # fixture, deleted in the finally, whatever the row did.
    $isShared = ($requires -ccontains 'shared-collection')
    $collections = [Collections.Generic.List[object]]::new()
    $newCollection = {
        if (-not $isShared) { return $null }
        $made = New-AcceptanceDisposableCollection -McpUrl $McpUrl -KnowledgeRoot $SharedKnowledgeRoot
        [void]$collections.Add($made)
        $made
    }
    $withCollection = {
        param($Outcome, $Fixture, $Before)
        if (-not $isShared) { return }
        $tokens = Get-AcceptanceNormalisationTokens -Fixture $Fixture -ProgramRoot $script:ProgramRoot
        # BOTH SIDES WAIT OUT THE CLIENT'S CACHE LIFETIMES: before, so the listing shows what the skeleton
        # and the seeds just wrote through Basic Memory; after, so it shows what the arm wrote. And the
        # before-snapshot reads its notes THROUGH BASIC MEMORY (S33) -- a note read from the share once is
        # served stale by this machine's SMB client long after the NAS changes it, which would make the
        # after-snapshot a copy of this one. See Get-AcceptanceCollectionEffect.
        Wait-AcceptanceShareSettled
        $through = if ($null -ne $Before) { [pscustomobject]@{ mcp_url = [string]$Fixture.mcp_url; id = [string]$Fixture.collection_id } } else { $null }
        $shared = Get-AcceptanceCollectionEffect -ShareRoot ([string]$Fixture.shared_root) -Tokens $tokens -Collection $through
        foreach ($key in @($shared.Keys)) { if ($null -ne $Before) { $Before[$key] = $shared[$key] } else { $Outcome.effect[$key] = $shared[$key] } }
    }
    # EVERY DISPOSABLE PROJECT IS DELETED, KEPT FIXTURES OR NOT: a kept fixture is a local directory,
    # and a project left on the NAS is invisible to every Library tool. Called before each early
    # return as well as from the finally, because a `return` inside `try` builds the verdict BEFORE the
    # finally runs -- measured on the first shared run, whose verdict never said it had cleaned up.
    # A deletion that fails or leaves files turns the row into an error naming the project.
    $released = [Collections.Generic.HashSet[string]]::new()
    $releaseCollections = {
        foreach ($collection in @($collections)) {
            if (-not $released.Add([string]$collection.name)) { continue }
            $record = try { Remove-AcceptanceDisposableCollection -Collection $collection }
            catch { [pscustomobject]@{ name = [string]$collection.name; deregistered = $false; files_left = $true; error = $_.Exception.Message } }
            $verdict['shared_cleanup'] = @(@(if ($verdict.Contains('shared_cleanup')) { $verdict['shared_cleanup'] }) + $record)
            if (-not $record.deregistered -or $record.files_left) {
                $verdict['status'] = 'error'
                $verdict['detail'] = "the disposable project $($record.name) was not removed cleanly (deregistered=$($record.deregistered), files_left=$($record.files_left)); " +
                    'remove it with tools/Remove-MemoryProject.ps1. The row''s own outcome was: ' + [string]$verdict['detail']
            }
        }
    }

    try {
        # ONE STAND-IN FOR BOTH ARMS (S41): the same answers for the same excerpts, so any difference is the
        # implementations'. Stopped in the finally, whatever the row did.
        if ($requires -ccontains 'embedding-service') { $script:AcceptanceEmbeddingStandIn = Start-AcceptanceEmbeddingStandIn }
        $powershellCollection = & $newCollection
        $fixture = New-AcceptanceFixture -Id ([string]$Row.fixture) -Root $powershellRoot -SharedCollection $powershellCollection
        Invoke-AcceptancePrepare -Row $Row -Fixture $fixture
        Add-AcceptanceSecondWorkspace -Row $Row -Fixture $fixture
        if ([bool]$fixture.seated) {
            Enter-FixtureSeatClaim -StateDirectory ([string]$fixture.state_directory) -Seat ([string]$fixture.seat) | Out-Null
            $claimed = $true
        }
        # Seeded under the arm's claim, because a seed may open a Project on its Desk; and before the
        # before-snapshot, so what a seed wrote is the fixture, not the row's effect.
        Invoke-AcceptanceSeed -Row $Row -Fixture $fixture -Collection $powershellCollection -TimeoutSeconds $TimeoutSeconds
        # THE FIXTURE AS IT WAS, so `readonly` is a CHECKED property rather than a claim in a
        # document. Thirty-odd rows assert that an operation leaves the workspace alone, and until
        # the effect was captured on both sides of the run, nothing whatever asked whether it did.
        # This is the one oracle in the matrix that works with no kernel attached.
        $tokens = Get-AcceptanceNormalisationTokens -Fixture $fixture -ProgramRoot $script:ProgramRoot
        $before = Get-AcceptanceEffect -Workspace ([string]$fixture.workspace) -Tokens $tokens
        & $withCollection $null $fixture $before
        # THE BEFORE-SNAPSHOT IS A LISTING OF THE SHARE (S39, measured), and this machine's SMB client
        # answers the next listing of the same directory from that one for its cache lifetime. An
        # archive's husk cleanup lists the directory the move just emptied, so straight after the
        # snapshot it saw the moved pages, reported `not-empty` and left the husk -- while the kernel
        # arm, which takes no before-snapshot, would see the NAS. A row whose subject reads the share
        # after a move says so, and its oracle arm then runs on a share this harness has not just listed.
        if ([bool](Get-AcceptanceOptionalValue -Object $Row -Name 'share_settles_before_arm')) { Wait-AcceptanceShareSettled }

        $powershellOutcome = Invoke-AcceptanceArm -Row $Row -Arm 'powershell' -Fixture $fixture -TimeoutSeconds $TimeoutSeconds
        if ($claimed) { Exit-FixtureSeatClaim; $claimed = $false }
        & $withCollection $powershellOutcome $fixture $null

        $verdict['powershell'] = $powershellOutcome
        $verdict['powershell_exit'] = [int]$powershellOutcome.exit

        if ([bool](Get-AcceptanceOptionalValue -Object $Row -Name 'readonly')) {
            $touched = @(Compare-AcceptanceEffect -Before $before -After $powershellOutcome.effect)
            if ($touched.Count) {
                $verdict['status'] = 'dirty'
                $verdict['touched'] = @($touched)
                $verdict['detail'] = 'the row is declared readonly and the PowerShell arm changed ' +
                    $touched.Count + ' path(s): ' + ((@($touched) | Select-Object -First 4) -join ', ')
                & $releaseCollections; return [pscustomobject]$verdict
            }
        }

        # A SUCCESS ROW WHOSE ORACLE FAILED HAS NOT MEASURED ITS SUBJECT (S44). A differential row compares the
        # two arms and nothing else, so two arms refusing the same way agree -- and S44's first capture-date row
        # compared green with both arms refusing, the preflight's refusal hidden behind the confirming step's.
        # The row's class says what the oracle must do; an oracle that did not is the row's error, not a match.
        # EVERY step, not the last: a success row's steps are one chain, and a step that failed broke it.
        $failedSteps = @(@($powershellOutcome.steps) | Where-Object { [int]$_.exit -ne 0 })
        if ([string]$Row.class -ceq 'success' -and ($failedSteps.Count -or [int]$powershellOutcome.exit -ne 0)) {
            $said = (@(([string]$powershellOutcome.stderr) -split "`r?`n" | Where-Object { $_.Trim() }) | Select-Object -First 2) -join ' | '
            $which = if ($failedSteps.Count) { 'step ' + (@($failedSteps | ForEach-Object { [string]$_.step }) -join ', ') } else { 'the arm' }
            $verdict['status'] = 'error'
            $verdict['detail'] = "the row declares success and its PowerShell arm failed at $which, so agreement with it would prove nothing: $said"
            & $releaseCollections; return [pscustomobject]$verdict
        }

        if ([string]::IsNullOrWhiteSpace($Kernel)) {
            # THE HONEST STATE, AND THE WORD FOR IT IS NOT `pass`.
            $verdict['status'] = 'pending'
            $verdict['detail'] = 'no TypeScript kernel is attached, so nothing was compared; the PowerShell arm ran (exit ' +
                [string]$powershellOutcome.exit + ') and its normalised outcome is recorded'
            & $releaseCollections; return [pscustomobject]$verdict
        }

        # Initialised by the KERNEL'S OWN program (S30): see New-AcceptanceFixture's -ProgramRoot.
        $kernelCollection = & $newCollection
        $kernelFixture = New-AcceptanceFixture -Id ([string]$Row.fixture) -Root $kernelRoot -ProgramRoot $script:KernelProgramRoot -SharedCollection $kernelCollection
        Invoke-AcceptancePrepare -Row $Row -Fixture $kernelFixture
        Add-AcceptanceSecondWorkspace -Row $Row -Fixture $kernelFixture -ProgramRoot $script:KernelProgramRoot
        if ([bool]$kernelFixture.seated) {
            Enter-FixtureSeatClaim -StateDirectory ([string]$kernelFixture.state_directory) -Seat ([string]$kernelFixture.seat) | Out-Null
            $claimed = $true
        }
        Invoke-AcceptanceSeed -Row $Row -Fixture $kernelFixture -Collection $kernelCollection -TimeoutSeconds $TimeoutSeconds
        $kernelOutcome = Invoke-AcceptanceArm -Row $Row -Arm 'kernel' -Fixture $kernelFixture -KernelCommand $Kernel -TimeoutSeconds $TimeoutSeconds
        if ($claimed) { Exit-FixtureSeatClaim; $claimed = $false }
        & $withCollection $kernelOutcome $kernelFixture $null

        $verdict['kernel'] = $kernelOutcome
        $comparison = Compare-AcceptanceOutcome -Matrix $Matrix -Row $Row -PowerShellOutcome $powershellOutcome -KernelOutcome $kernelOutcome -Seat ([string]$kernelFixture.seat)
        $verdict['comparison'] = $comparison
        $verdict['status'] = if ($comparison.green) { 'green' } else { 'mismatch' }
        $verdict['detail'] = '{0} field(s) compared, {1} unapproved difference(s), {2} approved delta(s)' -f `
            $comparison.fields, @($comparison.differences).Count, @($comparison.approved).Count
    }
    catch {
        $verdict['status'] = 'error'
        $verdict['detail'] = $_.Exception.Message
    }
    finally {
        if ($claimed) { Exit-FixtureSeatClaim }
        & $releaseCollections
        Stop-AcceptanceEmbeddingStandIn $script:AcceptanceEmbeddingStandIn
        $script:AcceptanceEmbeddingStandIn = $null
        if (-not $KeepFixtures -and (Test-Path -LiteralPath $rowRoot)) {
            Remove-Item -LiteralPath $rowRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    [pscustomobject]$verdict
}

# --- The self-test ----------------------------------------------------------------------------

function Invoke-AcceptanceMatrixSelfTest {
    $failures = [Collections.Generic.List[string]]::new()
    $checks = 0
    function Check([bool]$Condition, [string]$Label) {
        $script:selfTestChecks++
        if (-not $Condition) { [void]$script:selfTestFailures.Add($Label) }
    }
    $script:selfTestChecks = 0
    $script:selfTestFailures = $failures

    # A VERDICT THAT ERRORED CARRIES NEITHER ARM, AND READING ONE THROWS. Planting a fault in the
    # normalisation to check that this suite catches it produced a StrictMode property error rather
    # than a named failure -- the suite noticed, and said nothing a reader could act on. Every
    # dependent check is guarded, and the verdict's own detail is what gets reported.
    function Test-VerdictHas($Verdict, [string]$Key, [string]$Label) {
        if (@(Get-AcceptanceObjectKeys $Verdict) -ccontains $Key) { return $true }
        $script:selfTestChecks++
        [void]$script:selfTestFailures.Add("$Label -- the row reported '$([string]$Verdict.status)': $([string]$Verdict.detail)")
        $false
    }

    # THE INSTALLED KERNEL'S REMEDIES, SAID BY THE ORACLE SIDE (S47, ADR-0045): the same cases kernel self-test
    # section 23 holds the kernel's rewrite to, so the two implementations cannot drift apart unseen.
    $remedyCases = @(
        @('Open it with tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug beta, then read', 'Open it with library desk open book beta --location shelf, then read'),
        @('tools/Set-VirtualDesk.ps1 -Action Open -Kind Book -Location Shelf -Shelf Archive -Slug old', 'library desk open book old --location shelf --shelf archive'),
        @('tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug <slug>.', 'library desk open book <slug> --location shelf.'),
        @('tools/Set-VirtualDesk.ps1 -Action Close -Kind Project -Slug hub', 'library desk close project hub'),
        @('Sit down at a seat with tools/Enter-LibrarySeat.ps1 -Seat <name>, or', 'Sit down at a seat with library seat enter <name>, or'),
        @('tools/Retire-Seat.ps1 -Seat old', 'library seat retire old'),
        @('re-render it with tools/ShelfCatalog.ps1 -Render -WorkspacePath .', 're-render it with library shelf render'),
        @('tools/NotebookIndex.ps1 -Render -WorkspacePath .', 'library notebook render'),
        @('Capture into it with tools/Add-ShelfNote.ps1 -BookSlug holding. It is', 'Capture into it with library capture holding --title <title> --body <text>. It is'),
        @('Use tools/Get-DeskOverview.ps1 until then.', 'Use library desk until then.'),
        @('Create one with tools/Start-LibrarySeat.ps1 -Seat <name> -Project <project-slug>.', 'Create one with library seat start <name> --project <project-slug>.'),
        @('pass -WorkspacePath, set LIBRARY_WORKSPACE, or pass -Seat explicitly.', 'pass --workspace, set LIBRARY_WORKSPACE, or pass --seat explicitly.'),
        @('take it over with tools/Set-NotebookTopicOwner.ps1 -Topic x, or', 'take it over with powershell -ExecutionPolicy Bypass -File "<program>\tools\Set-NotebookTopicOwner.ps1" -Topic x, or'),
        @('no helper named here', 'no helper named here')
    )
    foreach ($case in $remedyCases) {
        $said = ConvertTo-AcceptanceInstalledRemedy -Text $case[0]
        Check ($said -ceq $case[1]) "the oracle side said '$($case[0])' as '$said', not '$($case[1])'"
    }
    $walked = ConvertTo-AcceptanceInstalledRemedyFields -Value ([pscustomobject]@{ next = 'Use tools/Get-DeskOverview.ps1 until then.'; body = 'tools/Get-DeskOverview.ps1'; items = @([pscustomobject]@{ reason = 'tools/Retire-Seat.ps1 -Seat old' }) })
    Check ($walked.next -ceq 'Use library desk until then.' -and $walked.body -ceq 'tools/Get-DeskOverview.ps1' -and $walked.items[0].reason -ceq 'library seat retire old') "the oracle side's field walk rewrote the wrong fields: $($walked | ConvertTo-Json -Compress -Depth 5)"
    # A READER TOOL'S ERROR TEXT IS A REMEDY, AND A PAGE IS NOT (kernel/src/reader.ts): S47's full run met the
    # seatless refusal inside `result.content[0].text`, which no remedy key names.
    $failed = ConvertTo-AcceptanceInstalledRemedyFields -Value ('{"result":{"isError":true,"content":[{"type":"text","text":"Use tools/Get-DeskOverview.ps1 until then."}]}}' | ConvertFrom-Json)
    $served = ConvertTo-AcceptanceInstalledRemedyFields -Value ('{"result":{"isError":false,"content":[{"type":"text","text":"Use tools/Get-DeskOverview.ps1 until then."}]}}' | ConvertFrom-Json)
    Check ($failed.result.content[0].text -ceq 'Use library desk until then.') "the oracle side left a reader error's text as the oracle said it: $($failed.result.content[0].text)"
    Check ($served.result.content[0].text -ceq 'Use tools/Get-DeskOverview.ps1 until then.') "the oracle side rewrote a page the reader served: $($served.result.content[0].text)"
    # A WALKED RESULT SERIALISES AS IT CAME IN: S47's first full run read a list of Book slugs back as
    # `{"Length":7}` objects, because a string from a pipeline is wrapped, on 6 fields of one row.
    $plain = ConvertTo-AcceptanceNormalisedData -Value ('{"books_scanned":["curated","holding"],"count":2,"ok":true,"nested":{"n":1}}' | ConvertFrom-Json) -Tokens @()
    $asIs = ConvertTo-AcceptanceFieldMap -Outcome ([pscustomobject]@{ exit = 0; result = $plain })
    $walkedMap = ConvertTo-AcceptanceFieldMap -Outcome ([pscustomobject]@{ exit = 0; result = (ConvertTo-AcceptanceInstalledRemedyFields -Value $plain) })
    $asIsText = (@($asIs.Keys | Sort-Object | ForEach-Object { "$_=$($asIs[$_])" }) -join '; ')
    $walkedText = (@($walkedMap.Keys | Sort-Object | ForEach-Object { "$_=$($walkedMap[$_])" }) -join '; ')
    Check ($walkedText -ceq $asIsText) "the oracle side's field walk changed the fields of a result it had nothing to rewrite in: $walkedText, not $asIsText"

    $matrix = Get-AcceptanceMatrix -SkipShapeCheck
    $shape = @(Test-AcceptanceMatrixShape -Matrix $matrix -ProgramRoot $script:ProgramRoot)
    Check ($shape.Count -eq 0) ("the matrix is malformed: " + ($shape -join '; '))

    # THE DISPOSABLE-PROJECT FENCE (S32), offline: which names and ids may be deleted, and that a
    # shared fixture's child environment names its own project and cannot be overridden by a step.
    $sharedSelfTest = Invoke-AcceptanceSharedCollectionSelfTest
    Check ([bool]$sharedSelfTest.passed) ('the disposable-project rules failed: ' + (@($sharedSelfTest.failures) -join '; '))
    $sharedFixture = [pscustomobject]@{ seated = $false; seat = ''; shared_root = 'B:\knowledge\acceptance-x'; mcp_url = 'http://127.0.0.1:1/mcp'; collection_id = '0123abcd-0000-4000-8000-000000000001' }
    $sharedEnvironment = Get-AcceptanceChildEnvironment -Fixture $sharedFixture
    Check ($sharedEnvironment['AI_LIBRARY_PROJECT_ID'] -ceq '0123abcd-0000-4000-8000-000000000001' -and $sharedEnvironment['LIBRARY_SHARED_COLLECTION_ROOT'] -ceq 'B:\knowledge\acceptance-x') 'a shared fixture''s child environment did not name its own project'
    $overridden = try { Get-AcceptanceChildEnvironment -Fixture $sharedFixture -StepEnvironment ([pscustomobject]@{ AI_LIBRARY_PROJECT_ID = 'other' }); $false } catch { $true }
    Check $overridden 'a step was allowed to override a shared fixture''s collection'
    $offlineEnvironment = Get-AcceptanceChildEnvironment -Fixture ([pscustomobject]@{ seated = $false; seat = '' })
    Check ($offlineEnvironment.ContainsKey('AI_LIBRARY_PROJECT_ID') -and $offlineEnvironment['AI_LIBRARY_PROJECT_ID'] -ceq '') 'an offline row''s child could inherit a collection id from the shell'
    # S41: NO ROW REACHES A READER'S INFERENCE SERVER. Without the stand-in both TEI_* are set empty, and a
    # step may not set either; with it, both name the stand-in and nothing else.
    Check ($offlineEnvironment.ContainsKey('TEI_EMBEDDING_URL') -and $offlineEnvironment['TEI_EMBEDDING_URL'] -ceq '' -and $offlineEnvironment.ContainsKey('TEI_API_KEY') -and $offlineEnvironment['TEI_API_KEY'] -ceq '') 'a row''s child could inherit an embedding endpoint or key from the shell'
    $teiOverride = try { Get-AcceptanceChildEnvironment -Fixture ([pscustomobject]@{ seated = $false; seat = '' }) -StepEnvironment ([pscustomobject]@{ TEI_EMBEDDING_URL = 'http://elsewhere' }); $false } catch { $true }
    Check $teiOverride 'a step was allowed to point TEI_EMBEDDING_URL somewhere of its own'
    $script:AcceptanceEmbeddingStandIn = [pscustomobject]@{ url = 'http://127.0.0.1:1/v1/embeddings'; key = 'k' }
    try { $withStandIn = Get-AcceptanceChildEnvironment -Fixture ([pscustomobject]@{ seated = $false; seat = '' }) }
    finally { $script:AcceptanceEmbeddingStandIn = $null }
    Check ($withStandIn['TEI_EMBEDDING_URL'] -ceq 'http://127.0.0.1:1/v1/embeddings' -and $withStandIn['TEI_API_KEY'] -ceq 'k') 'a row with the stand-in did not hand its children the stand-in''s url and key'
    $coverage = @(Test-AcceptanceMatrixCoverage -Matrix $matrix -ProgramRoot $script:ProgramRoot)
    Check ($coverage.Count -eq 0) ("the matrix does not cover every public helper: " + ($coverage -join '; '))

    # THE KERNEL ARM'S OWN PROGRAM ROOT (S29), AND ONLY IT (S30). An installed kernel's program is
    # elsewhere: its root reads as <program> in the kernel arm and in no other; this checkout's root
    # does NOT, now that the kernel arm's fixture is initialised by the kernel's own program -- a kernel
    # writing this checkout's path is a difference again -- and a root that is neither program's is
    # never normalised at all.
    $savedKernelRoot = $script:KernelProgramRoot
    try {
        $script:KernelProgramRoot = 'C:\installed\deskpost\current'
        $probeFixture = [pscustomobject]@{ workspace = 'C:\fx\workspace'; registry = 'C:\fx\registry'; root = 'C:\fx' }
        $kernelTokens = Get-AcceptanceNormalisationTokens -Fixture $probeFixture -ProgramRoot (Get-AcceptanceArmProgramRoot -Arm 'kernel')
        $oracleTokens = Get-AcceptanceNormalisationTokens -Fixture $probeFixture -ProgramRoot (Get-AcceptanceArmProgramRoot -Arm 'powershell')
        Check ((ConvertTo-AcceptanceNormalisedText -Text 'C:\installed\deskpost\current\tools\x.ps1' -Tokens $kernelTokens) -ceq '<program>\tools\x.ps1') 'the kernel arm did not normalise its own program root'
        Check ((ConvertTo-AcceptanceNormalisedText -Text 'C:\installed\deskpost\current\tools\x.ps1' -Tokens $oracleTokens) -cne '<program>\tools\x.ps1') "the PowerShell arm normalised the KERNEL's program root, which it never runs from"
        Check ((ConvertTo-AcceptanceNormalisedText -Text ($script:ProgramRoot + '\tools\x.ps1') -Tokens $kernelTokens) -cne '<program>\tools\x.ps1') "the kernel arm normalised THIS checkout's root, which S30 withdrew: a kernel writing it would compare green"
        Check ((ConvertTo-AcceptanceNormalisedText -Text ($script:ProgramRoot + '\tools\x.ps1') -Tokens $oracleTokens) -ceq '<program>\tools\x.ps1') "the PowerShell arm stopped normalising its own program root"
        Check ((ConvertTo-AcceptanceNormalisedText -Text 'C:\unrelated\program\tools\x.ps1' -Tokens $kernelTokens) -cmatch 'unrelated') 'the kernel arm normalised a root that belongs to neither program'
        Check ((Get-AcceptanceKernelProgramRoot -KernelCommand '') -ceq $script:ProgramRoot) 'no kernel command did not fall back to this program'
    }
    finally { $script:KernelProgramRoot = $savedKernelRoot }

    $work = Join-Path ([IO.Path]::GetTempPath()) ('acceptance-selftest-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $stub = Join-Path $PSScriptRoot 'AcceptanceKernelStub.ps1'
    Check (Test-Path -LiteralPath $stub -PathType Leaf) 'tools/AcceptanceKernelStub.ps1 is missing, so the comparison cannot be falsified'

    try {
        # --- 0. A STEP'S ARGUMENTS BIND TO ITS SCRIPT (S31) ------------------------------------------
        # The Report Inbox, 2026-09-22: five hub rows passed -Slug and -Json to helpers declaring
        # neither, and the shape check, which resolved only the script, was green over them. Each rule
        # of the binding is driven here against a script whose declaration is known, and the matrix
        # itself is planted with the original defect.
        $probe = Join-Path $work 'probe-binding.ps1'
        [IO.File]::WriteAllText($probe, "[CmdletBinding()]`nparam([Parameter(Mandatory = `$true)][string]`$ProjectSlug, [string]`$ProjectId, [string]`$WorkspacePath, [switch]`$Preflight, [switch]`$Json)`n")
        $twoSets = Join-Path $work 'probe-two-sets.ps1'
        [IO.File]::WriteAllText($twoSets, "[CmdletBinding()]`nparam([Parameter(Mandatory = `$true, ParameterSetName = 'A')][string]`$Alpha, [Parameter(Mandatory = `$true, ParameterSetName = 'B')][string]`$Beta)`n")
        $argsOnly = Join-Path $work 'probe-args-only.ps1'
        [IO.File]::WriteAllText($argsOnly, "foreach (`$a in @(`$args)) { `$a }`n")
        $bind = { param($Script, [object[]]$Arguments) @(Test-AcceptanceStepArguments -Script $Script -Arguments $Arguments) }
        Check (@(& $bind $probe @('-ProjectSlug', 'x', '-WorkspacePath', '{workspace}', '-Preflight', '-Json')).Count -eq 0) 'arguments the script declares did not bind'
        Check ((@(& $bind $probe @('-Slug', 'x', '-ProjectSlug', 'x')) -join ' ') -cmatch '-Slug, which it does not declare') 'an undeclared parameter bound'
        Check ((@(& $bind $probe @('-WorkspacePath', 'w')) -join ' ') -cmatch 'mandatory -ProjectSlug') 'a missing mandatory parameter was not named'
        Check ((@(& $bind $probe @('-ProjectSlug', 'x', '-WorkspacePath', '-Json')) -join ' ') -cmatch 'WorkspacePath and no value') 'a parameter that takes a value was passed none, and bound'
        Check ((@(& $bind $probe @('-ProjectSlug', 'x', '-Project', 'y')) -join ' ') -cmatch 'ambiguous') 'an ambiguous prefix bound'
        Check (@(& $bind $probe @('-ProjectSlug', 'x', '-Pre')).Count -eq 0) 'a unique prefix, which PowerShell binds, was refused'
        Check ((@(& $bind $probe @('-ProjectSlug', 'x', 'stray')) -join ' ') -cmatch 'positional') 'a positional argument was accepted unnamed'
        Check (@(& $bind $argsOnly @('-Anything', 'goes')).Count -eq 0) 'a script with no param() block, which reads $args, was held to a declaration it does not have'
        Check (@(& $bind $twoSets @('-Alpha', 'a')).Count -eq 0) "one parameter set's mandatory parameter was demanded by the other"
        Check ((@(& $bind $twoSets @('-Alpha', 'a', '-Beta', 'b')) -join ' ') -cmatch 'binds no parameter set') 'arguments from two parameter sets bound as one'
        Check ((@(& $bind (Join-Path $script:ProgramRoot 'tools/New-ProjectHub.ps1') @('-Slug', 'acceptance')) -join ' ') -cmatch '-Slug') "New-ProjectHub.ps1 accepted the Report Inbox's -Slug"
        $planted = (ConvertTo-Json -InputObject $matrix -Depth 32) | ConvertFrom-Json
        $plantedRow = @($planted.rows | Where-Object { [string]$_.id -ceq 'hub.new-project-hub-is-orientation-not-a-log' })[0]
        $plantedRow.powershell.steps[0].args = @(@($plantedRow.powershell.steps[0].args) + '-Slug' + 'acceptance')
        Check ((@(Test-AcceptanceMatrixShape -Matrix $planted -ProgramRoot $script:ProgramRoot) -join ' ') -cmatch "hub\.new-project-hub-is-orientation-not-a-log' calls 'tools/New-ProjectHub\.ps1' with -Slug") 'the shape check did not name a row planted with an undeclared argument'

        # A SEED IS HELD TO A STEP'S RULES (S33): its collection named, its arguments bound, and it
        # exists only where there is a disposable project to seed. Each planted into a real row.
        $plantSeed = {
            param([string]$RowId, [scriptblock]$Mutate)
            $copy = (ConvertTo-Json -InputObject $matrix -Depth 32) | ConvertFrom-Json
            & $Mutate @($copy.rows | Where-Object { [string]$_.id -ceq $RowId })[0]
            @(Test-AcceptanceMatrixShape -Matrix $copy -ProgramRoot $script:ProgramRoot) -join ' '
        }
        $seedRow = 'hub.edit-preflight-returns-the-section-before-it-writes'
        Check ((& $plantSeed $seedRow { param($r) $r.seed[0].args = @(@($r.seed[0].args) | Where-Object { $_ -cne '-ProjectId' -and $_ -cne '{collection_id}' }) }) -cmatch "seeds with 'tools/New-ProjectHub\.ps1' without -ProjectId") 'a seed without -ProjectId {collection_id} was accepted'
        Check ((& $plantSeed $seedRow { param($r) $r.seed[0].args = @(@($r.seed[0].args) + '-Slug' + 'x') }) -cmatch "seeds with 'tools/New-ProjectHub\.ps1' with -Slug") 'a seed with an undeclared argument was accepted'
        Check ((& $plantSeed 'hub.local-pages-copy-into-a-project' { param($r) $r.requires = @(); $r | Add-Member -NotePropertyName seed -NotePropertyValue @([pscustomobject]@{ script = 'tools/New-ProjectHub.ps1'; args = @() }) }) -cmatch 'does not require the shared collection') 'a seed on a row with no disposable project was accepted'
        Check ((& $plantSeed 'publication.catalog-entry-is-added-without-removing-one' { param($r) @($r.seed | Where-Object { @($_.PSObject.Properties.Name) -ccontains 'collection_note' })[0].collection_note = '../other/README' }) -cmatch "collection note '\.\./other/README'") 'a collection note path that climbs out of its project was accepted'
        # `collection_delete` and `expect_failure` (S43): a delete names a note inside its project and nothing
        # else, and a step expected to stop says what it must say.
        $resumeRow = 'publication.an-interrupted-publication-resumes-where-it-stopped'
        $deleteSeed = { param($r) @($r.seed | Where-Object { @($_.PSObject.Properties.Name) -ccontains 'collection_delete' })[0] }
        Check ((& $plantSeed $resumeRow { param($r) (& $deleteSeed $r).collection_delete = '../other/page' }) -cmatch "deletes the collection note '\.\./other/page'") 'a collection delete that climbs out of its project was accepted'
        Check ((& $plantSeed $resumeRow { param($r) (& $deleteSeed $r) | Add-Member -NotePropertyName text -NotePropertyValue 'x' }) -cmatch "with a 'text' key") 'a collection delete carrying a text was accepted'
        Check ((& $plantSeed $resumeRow { param($r) @($r.seed | Where-Object { @($_.PSObject.Properties.Name) -ccontains 'expect_failure' })[0].expect_failure = ' ' }) -cmatch 'expects a seed step to fail without saying') 'a seed step expected to fail with no stated reason was accepted'
        # `share_settles_before_arm` (S39): a flag, and only where there is a share to settle.
        $settleRow = 'hub.archive-confirmed-moves-the-hub-and-both-catalogs'
        Check ((& $plantSeed $settleRow { param($r) $r.share_settles_before_arm = 'yes' }) -cmatch 'share_settles_before_arm a value that is not true or false') 'a share_settles_before_arm that is not a boolean was accepted'
        Check ((& $plantSeed 'compile.refuses-the-whole-raw-tree' { param($r) $r | Add-Member -NotePropertyName share_settles_before_arm -NotePropertyValue $true }) -cmatch 'settles the share before its arm and does not require the shared collection') 'a share_settles_before_arm on a row with no share was accepted'
        # THE OWNERSHIP CLAIM'S PID IS VOLATILE; A SEAT CLAIM'S `pid=` IS NOT TOUCHED.
        Check ((ConvertTo-AcceptanceNormalisedText -Text "{`n    `"pid`":  22592,`n    `"incarnation`":  1`n}" -Tokens @()) -cnotmatch '22592') 'an ownership claim''s pid survived normalisation'
        Check ((ConvertTo-AcceptanceNormalisedText -Text "token=abc`npid=22592`n" -Tokens @()) -cmatch 'pid=22592') 'a seat claim''s pid= line was normalised, which would loosen a seat row''s binding'
        # A REFUSAL WRAPPED INSIDE A PATH (S43): PowerShell's error view breaks by character at the host width,
        # so the break is removed, not turned into a space, and before the path is looked for.
        $wrapTokens = @([pscustomobject]@{ literal = 'C:\fixture\row\workspace'; token = '<workspace>' })
        Check ((ConvertTo-AcceptanceNormalisedMessage -Text "Stopped. Journal: C:`r`n\fixture\row\work`r`nspace\internal\j.json. Done." -Tokens $wrapTokens) -ceq 'Stopped. Journal: <workspace>\internal\j.json. Done.') 'a refusal wrapped inside a path did not normalise to the path''s token'
        Check ((ConvertTo-AcceptanceNormalisedMessage -Text "Refused.`r`nAt C:\p\x.ps1:9 char:1`r`n+ throw 'Refused.'`r`n    + CategoryInfo          : OperationStopped: (:) [], RuntimeException`r`n    + FullyQualifiedErrorId : Refused." -Tokens @()) -ceq 'Refused.') 'the error record decoration was not cut before the lines were joined'
        # THE CARRIED PLAN ID'S TAIL (S40): this arm's value, standing alone, and nothing else.
        $tailTokens = @([pscustomobject]@{ literal = ''; token = '<plan-tail>'; plan_tail = 'bafae421b30f4fb4' })
        $fullPlan = 'publish-delete-shelf-book-batch-' + ('0' * 48) + 'bafae421b30f4fb4'
        Check ((ConvertTo-AcceptanceNormalisedText -Text 'internal/publication-journals/shelf-exit-batch-bafae421b30f4fb4.json' -Tokens $tailTokens) -ceq 'internal/publication-journals/shelf-exit-batch-<plan-tail>.json') 'the arm''s own plan_id tail in a journal name was not normalised'
        Check ((ConvertTo-AcceptanceNormalisedText -Text 'shelf-exit-batch-9c43fa4745f36b8a.json' -Tokens $tailTokens) -cmatch '9c43fa4745f36b8a') 'a tail that is NOT the arm''s own plan_id was normalised away'
        Check ((ConvertTo-AcceptanceNormalisedText -Text $fullPlan -Tokens $tailTokens) -ceq 'publish-delete-shelf-book-batch-<sha256>') 'the tail rule reached inside a full plan_id instead of leaving it to the sha256 rule'

        # --- HOW AN INDEPENDENT ROW IS JUDGED (S41, the reader's ruling) -----------------------------
        # The shape: a judge or a recorded verdict only on an independent row, never both, and a judge
        # that names no {kernel} would judge whatever it judged before.
        $judgedRow = 'seat.tier0-opens-a-seat-with-no-basic-memory'
        Check ((& $plantSeed 'workspace.init-creates-marker' { param($r) $r | Add-Member -NotePropertyName recorded_verdict -NotePropertyValue $true }) -cmatch 'is not independent') 'a recorded verdict on a differential row was accepted'
        Check ((& $plantSeed $judgedRow { param($r) $r | Add-Member -NotePropertyName recorded_verdict -NotePropertyValue $true }) -cmatch 'both a judge and a recorded verdict') 'a row with both a judge and a recorded verdict was accepted'
        Check ((& $plantSeed $judgedRow { param($r) $r.judge.environment.LIBRARY_SELFTEST_KERNEL = 'node kernel/src/cli.ts' }) -cmatch 'never names \{kernel\}') 'a judge that never names {kernel} was accepted'
        Check ((& $plantSeed $judgedRow { param($r) $r.judge.command = @('node', 'kernel/test/no-such-judge.ts') }) -cmatch "no-such-judge\.ts', which is not a file") 'a judge naming a missing file was accepted'
        # The verdict, driven: a judge's exit is its green, and it is handed the kernel under test.
        $echoKernel = Join-Path $work 'judge-echo.ps1'
        [IO.File]::WriteAllText($echoKernel, "param([string]`$Kernel) if (`$Kernel -ceq 'the-kernel-under-test') { 'judged the right kernel'; exit 0 }; ""wrong kernel: `$Kernel""; exit 1", [Text.UTF8Encoding]::new($false))
        $judge = { param([string]$Kernel) [pscustomobject]@{ id = 'x.judged'; reason = 'r'; judge = [pscustomobject]@{ command = @('powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $echoKernel, '-Kernel', '{kernel}') } } }
        $passed = Invoke-AcceptanceIndependentVerdict -Row (& $judge) -Kernel 'the-kernel-under-test'
        $failedJudge = Invoke-AcceptanceIndependentVerdict -Row (& $judge) -Kernel 'another-kernel'
        $noKernel = Invoke-AcceptanceIndependentVerdict -Row (& $judge) -Kernel ''
        Check ($passed.status -ceq 'green' -and $passed.detail -cmatch 'judged the right kernel') "a passing judge was not green: $($passed.status) $($passed.detail)"
        Check ($failedJudge.status -ceq 'mismatch' -and $failedJudge.detail -cmatch 'wrong kernel: another-kernel') "a failing judge was not a mismatch naming its kernel: $($failedJudge.status) $($failedJudge.detail)"
        Check ($noKernel.status -ceq 'pending') "a judged row with no kernel was not pending: $($noKernel.status)"
        $unjudged = Invoke-AcceptanceIndependentVerdict -Row ([pscustomobject]@{ id = 'x.unjudged'; reason = 'r' }) -Kernel 'k'
        Check ($unjudged.status -ceq 'independent') "a row with no judge read as $($unjudged.status), not independent"
        # A recorded verdict binds the exact binary, and a kernel run from source has none.
        $fakeBinary = Join-Path $work 'library.exe'
        [IO.File]::WriteAllText($fakeBinary, 'not really a kernel', [Text.UTF8Encoding]::new($false))
        $fakeSha = (Get-FileHash -LiteralPath $fakeBinary -Algorithm SHA256).Hash.ToLowerInvariant()
        $script:AcceptanceVerdictsPath = Join-Path $work 'verdicts.json'
        $recordedRow = [pscustomobject]@{ id = 'x.recorded'; reason = 'r'; recorded_verdict = $true }
        try {
            [IO.File]::WriteAllText($script:AcceptanceVerdictsPath, (@{ verdicts = @(@{ row = 'x.recorded'; kernel_sha256 = $fakeSha; result = 'pass'; judged_utc = 't'; evidence = 'seen' }) } | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
            Check ((Invoke-AcceptanceIndependentVerdict -Row $recordedRow -Kernel $fakeBinary).status -ceq 'green') 'a verdict recorded for this exact binary was not green'
            Check ((Invoke-AcceptanceIndependentVerdict -Row $recordedRow -Kernel 'node kernel/src/cli.ts').status -ceq 'pending') 'a recorded-verdict row run from source was not pending'
            [IO.File]::WriteAllText($fakeBinary, 'a different build', [Text.UTF8Encoding]::new($false))
            Check ((Invoke-AcceptanceIndependentVerdict -Row $recordedRow -Kernel $fakeBinary).status -ceq 'pending') 'a verdict recorded for ANOTHER binary was read as this one''s'
            $otherSha = (Get-FileHash -LiteralPath $fakeBinary -Algorithm SHA256).Hash.ToLowerInvariant()
            [IO.File]::WriteAllText($script:AcceptanceVerdictsPath, (@{ verdicts = @(@{ row = 'x.recorded'; kernel_sha256 = $otherSha; result = 'fail'; judged_utc = 't'; evidence = 'denied nothing' }) } | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
            Check ((Invoke-AcceptanceIndependentVerdict -Row $recordedRow -Kernel $fakeBinary).status -ceq 'mismatch') 'a failing recorded verdict was not a mismatch'
        }
        finally { $script:AcceptanceVerdictsPath = $null }

        # --- 1. EVERY DECLARED FIXTURE IS BUILT, not merely named -----------------------------------
        # S21's rule, applied to this generator: a table that names a builder has not built one.
        $seatedRecord = $null
        foreach ($id in @(Get-AcceptanceFixtureIds)) {
            $built = $false
            $root = Join-Path $work ('fixture-' + $id)
            try {
                $record = New-AcceptanceFixture -Id $id -Root $root
                $built = (Test-Path -LiteralPath ([string]$record.workspace) -PathType Container)
                if ($id -cne 'bare-folder') {
                    $built = $built -and (Test-Path -LiteralPath (Join-Path ([string]$record.workspace) '.library/workspace.json') -PathType Leaf)
                }
                if ($id -ceq 'workspace-seated') { $seatedRecord = $record }
            }
            catch { [void]$failures.Add("fixture '$id' would not build: $($_.Exception.Message)") }
            Check $built "fixture '$id' did not produce a workspace"
        }

        # AN EMPTY FILE IS A FIRST-CLASS INPUT, AND THIS IS THE REGRESSION CHECK FOR IT. A seat's
        # two Desk files are created empty, so every fixture with a seat holds two; reading one
        # through a [byte[]] parameter without [AllowEmptyCollection()] fails binding, and on
        # 2026-09-22 that turned the effect of 38 of the 49 runnable rows into an error rather than
        # an outcome. The self-test did not see it because the single row it ran end to end uses
        # the one fixture that has no seat. The fixture's CARDINALITY was the coverage gap, exactly
        # as .claude/rules/library-development.md says it usually is.
        if ($null -eq $seatedRecord) { Check $false 'the seated fixture was not built, so the empty-file case is untested' }
        else {
            # CAUGHT RATHER THAN LET FLY. The fault this check exists for -- a [byte[]] parameter
            # refusing an empty array -- THROWS rather than returning a wrong answer, and an
            # uncaught throw here ends the suite at a stack trace instead of at a sentence. The
            # gate would still go red; the next session would still have to work out why.
            try {
                $seatedTokens = Get-AcceptanceNormalisationTokens -Fixture $seatedRecord -ProgramRoot $script:ProgramRoot
                $seatedEffect = Get-AcceptanceEffect -Workspace ([string]$seatedRecord.workspace) -Tokens $seatedTokens
                $emptyFiles = @(@(Get-AcceptanceObjectKeys $seatedEffect) | Where-Object { [string]$seatedEffect[$_] -ceq 'text:' })
                Check ($emptyFiles.Count -ge 2) "a seated fixture's empty Desk files did not survive into the effect; found $($emptyFiles.Count) empty file(s)"
                Check (@(Get-AcceptanceObjectKeys $seatedEffect).Count -ge 10) 'the seated fixture produced almost no effect, so it was not read back'
            }
            catch { Check $false ("reading a seated fixture's effect threw, so an ordinary workspace cannot be compared at all: " + $_.Exception.Message) }
        }

        # --- 2. ONE TRIVIAL ROW, END TO END, FOR REAL -----------------------------------------------
        $trivial = Get-AcceptanceMatrixRow -Matrix $matrix -Id 'workspace.init-creates-marker'
        $verdict = Invoke-AcceptanceRow -Matrix $matrix -Row $trivial -WorkDirectory (Join-Path $work 'trivial') -TimeoutSeconds 120
        Check ([string]$verdict.status -ceq 'pending') "with no kernel the trivial row reported '$($verdict.status)' rather than 'pending'"
        if (Test-VerdictHas $verdict 'powershell' 'the trivial row produced no PowerShell outcome') {
            Check ([int]$verdict.powershell.exit -eq 0) "the PowerShell arm of the trivial row exited $($verdict.powershell.exit)"
            $fields = ConvertTo-AcceptanceFieldMap -Outcome $verdict.powershell
            Check ($fields.Contains('result.status')) 'the trivial row produced no result.status field'
            Check (@(@($fields.Keys) | Where-Object { $_ -clike 'effect.*' }).Count -ge 6) 'the trivial row recorded almost no effect, so the workspace it created was not read back'

            # NORMALISATION REALLY FIRED. A field map still carrying an absolute path or a
            # wall-clock stamp would compare unequal on every run of the SAME implementation, so a
            # green row would be impossible and nobody would find out until the kernel arrived.
            $rendered = (@($fields.Keys) | ForEach-Object { $_ + '=' + $fields[$_] }) -join "`n"
            # THE WORK DIRECTORY'S OWN NAME IS THE PROBE, because it is unique to this run:
            # anything carrying it is a path the token map failed to replace. Asserting "no
            # absolute path at all" would be the wrong test -- a managed instruction section
            # legitimately names paths outside this fixture, and a check that fails on those would
            # be repaired by weakening it.
            Check ($rendered.IndexOf((Split-Path -Leaf $work), [StringComparison]::OrdinalIgnoreCase) -lt 0) 'a normalised outcome still carries this run''s own fixture path'
            Check ($rendered -cnotmatch '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}') 'a normalised outcome still carries a wall-clock timestamp'
            Check ($rendered -cmatch '<workspace>') 'no workspace token appears in the normalised outcome, so the token map matched nothing'
        }

        # --- 3. THE COMPARATOR, FALSIFIED FOUR WAYS -------------------------------------------------
        $stubCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ' + $stub

        # (a) An agreeing kernel over its OWN fixture: different directory, different workspace id,
        #     different created stamp. Green only if normalisation is doing its job.
        $agree = Invoke-AcceptanceRow -Matrix $matrix -Row $trivial -WorkDirectory (Join-Path $work 'agree') -Kernel $stubCommand -TimeoutSeconds 120
        if (Test-VerdictHas $agree 'comparison' 'the agreeing kernel produced no comparison') {
            Check ([string]$agree.status -ceq 'green') ('an agreeing kernel did not compare green: ' + [string]$agree.detail + ' -- ' +
                ((@($agree.comparison.differences) | Select-Object -First 3 | ForEach-Object { [string]$_.field }) -join ', '))
        }

        # (a2) THE SAME AGREEING KERNEL, REACHED BY A RELATIVE PATH. Every step runs in a fixture,
        #      so a relative kernel command is the one shape that can be valid where the caller typed
        #      it and meaningless where it runs -- which is exactly what happened to
        #      `node kernel/src/cli.ts`, the command both the kernel README and the matrix document
        #      print. It reported mismatch on every row with MODULE_NOT_FOUND on stderr, which reads
        #      identically to an unported verb refusing. The absolute form above cannot catch that,
        #      so the relative form is driven here, end to end, and must reach the same green.
        $relativeStub = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/AcceptanceKernelStub.ps1'
        $resolvedStub = Resolve-AcceptanceKernelCommand -KernelCommand $relativeStub -BaseDirectory $script:ProgramRoot
        Check ($resolvedStub -cne $relativeStub) 'a relative kernel script was not made absolute, so it would not resolve inside a fixture'
        Check ($resolvedStub -clike '*-NoProfile*') 'resolving the kernel command dropped an argument that names no file'
        $relative = Invoke-AcceptanceRow -Matrix $matrix -Row $trivial -WorkDirectory (Join-Path $work 'relative') -Kernel $resolvedStub -TimeoutSeconds 120
        Check ([string]$relative.status -ceq 'green') ('a kernel named by a relative path did not compare green: ' + [string]$relative.detail)

        # (b) A kernel that differs in SUBSTANCE. A comparator that never reports a difference
        #     agrees with everything, so this is the case that gives the other three meaning.
        $divergeCommand = $stubCommand + ' -Divergent'
        $diverge = Invoke-AcceptanceRow -Matrix $matrix -Row $trivial -WorkDirectory (Join-Path $work 'diverge') -Kernel $divergeCommand -TimeoutSeconds 120
        if (Test-VerdictHas $diverge 'comparison' 'the divergent kernel produced no comparison') {
            Check ([string]$diverge.status -ceq 'mismatch') "a kernel writing different content compared '$($diverge.status)' rather than 'mismatch'"
            $divergentFields = @(@($diverge.comparison.differences) | ForEach-Object { [string]$_.field })
            Check (@($divergentFields | Where-Object { $_ -clike 'effect.*' }).Count -ge 1) 'the divergent kernel''s extra file was not reported as a difference'
        }

        # (c) A kernel that writes one EXTRA Notebook topic. Until S18 this case asserted the opposite:
        #     `notebook-is-seat-owned` approved any difference whose field began `effect.notebook/`,
        #     content included, so an extra topic -- or a wrong one -- compared green, and this case
        #     proved it did. The delta is a rebase now (section 3g), and an unasked-for topic is
        #     substance on every row, including the init row where no Notebook delta applies at all.
        $deltaCommand = $stubCommand + ' -NotebookOnly'
        $deltaRow = Invoke-AcceptanceRow -Matrix $matrix -Row $trivial -WorkDirectory (Join-Path $work 'delta') -Kernel $deltaCommand -TimeoutSeconds 120
        if (Test-VerdictHas $deltaRow 'comparison' 'the notebook-writing kernel produced no comparison') {
            Check ([string]$deltaRow.status -ceq 'mismatch') "a kernel that wrote an extra Notebook topic compared '$($deltaRow.status)': the Notebook delta is absorbing content again"
        }

        # (d) A kernel that refuses. An exit code difference is substance, never noise.
        $refuseCommand = $stubCommand + ' -Refuse'
        $refuse = Invoke-AcceptanceRow -Matrix $matrix -Row $trivial -WorkDirectory (Join-Path $work 'refuse') -Kernel $refuseCommand -TimeoutSeconds 120
        if (Test-VerdictHas $refuse 'comparison' 'the refusing kernel produced no comparison') {
            Check ([string]$refuse.status -ceq 'mismatch') "a kernel that refused compared '$($refuse.status)' rather than 'mismatch'"
            Check (@(@($refuse.comparison.differences) | ForEach-Object { [string]$_.field }) -ccontains 'exit') 'a differing exit code was not reported as a difference'
        }

        # --- 3b. `readonly` IS A CHECKED PROPERTY, IN BOTH DIRECTIONS ------------------------------
        #
        # BOTH CONTROLS, BECAUSE ONE OF THEM ALONE IS VACUOUS. The positive control is a real
        # refusal row: it must refuse AND leave the workspace alone. The negative control takes a
        # row that genuinely writes, declares it readonly IN MEMORY, and requires the harness to
        # call it `dirty`. Without the second, a readonly check that had quietly stopped comparing
        # would pass every row in the matrix and nobody would find out.
        $refusalRow = Get-AcceptanceMatrixRow -Matrix $matrix -Id 'desk.refuses-to-open-a-book-that-is-not-on-the-shelf'
        $refusalVerdict = Invoke-AcceptanceRow -Matrix $matrix -Row $refusalRow -WorkDirectory (Join-Path $work 'readonly') -TimeoutSeconds 120
        Check ([string]$refusalVerdict.status -ceq 'pending') ("a readonly refusal row reported '$([string]$refusalVerdict.status)': " + [string]$refusalVerdict.detail)
        Check ([int](Get-AcceptanceOptionalValue -Object $refusalVerdict -Name 'powershell_exit') -ne 0) 'the row that must refuse exited 0, so it did not refuse'

        $writingRow = Get-AcceptanceMatrixRow -Matrix $matrix -Id 'shelf.new-book-creates-a-book-root'
        $asReadonly = $writingRow | Select-Object -Property *
        $asReadonly | Add-Member -NotePropertyName 'readonly' -NotePropertyValue $true -Force
        $dirtyVerdict = Invoke-AcceptanceRow -Matrix $matrix -Row $asReadonly -WorkDirectory (Join-Path $work 'dirty') -TimeoutSeconds 120
        Check ([string]$dirtyVerdict.status -ceq 'dirty') "a row that writes, declared readonly, reported '$([string]$dirtyVerdict.status)' rather than 'dirty'"
        Check (@(Get-AcceptanceOptionalList -Object $dirtyVerdict -Name 'touched').Count -ge 1) 'the dirty verdict named no path, so a reader cannot act on it'

        # --- 3b2. A SUCCESS ROW WHOSE ORACLE FAILS IS AN ERROR, NOT AN AGREEMENT (S44) --------------
        #
        # The refusal row above, declared a success row IN MEMORY: its oracle refuses, so the row has
        # measured nothing, and the harness must say so rather than compare the refusal. The trivial
        # row reporting `pending` in section 2 is the control -- a success row whose oracle succeeds.
        $asSuccess = $refusalRow | Select-Object -Property *
        $asSuccess | Add-Member -NotePropertyName 'class' -NotePropertyValue 'success' -Force
        $failedOracle = Invoke-AcceptanceRow -Matrix $matrix -Row $asSuccess -WorkDirectory (Join-Path $work 'failed-oracle') -TimeoutSeconds 120
        Check ([string]$failedOracle.status -ceq 'error' -and [string]$failedOracle.detail -cmatch 'declares success') ("a success row whose oracle refused reported '$([string]$failedOracle.status)': " + [string]$failedOracle.detail)

        # --- 3c. A GATED ROW CARRIES ITS PLAN ID FROM ONE STEP TO THE NEXT -------------------------
        #
        # THE REGRESSION CHECK FOR DEFECT FAMILY 3, and it needs a helper with NO -Json to be worth
        # anything: `Reset-LocalNotebook.ps1` speaks prose, PowerShell's list formatting wraps its
        # 78-character plan id across two lines, and a parse that read the LINE took the first 76.
        # The confirming step then refused a plan that described a state it could not match -- the
        # right refusal for the wrong reason, which is the expensive kind. A row that completes both
        # steps is the only thing that says the id survived.
        #
        # SINCE S17 THE HELPER HAS A -Json AND THE ROW PASSES IT, so the prose this case exists for
        # is recovered IN MEMORY, the way 3b declares a row readonly: the same row with -Json taken
        # off every PowerShell step. Without that, the fix that made the reset rows compare would
        # have quietly retired the only check that a WRAPPED plan id survives.
        $gatedSource = Get-AcceptanceMatrixRow -Matrix $matrix -Id 'reset.quarantines-rather-than-deletes'
        $gatedRow = $gatedSource | ConvertTo-Json -Depth 12 | ConvertFrom-Json
        foreach ($gatedStep in @($gatedRow.powershell.steps)) {
            $gatedStep.args = @(@($gatedStep.args) | Where-Object { [string]$_ -cne '-Json' })
        }
        $gatedVerdict = Invoke-AcceptanceRow -Matrix $matrix -Row $gatedRow -WorkDirectory (Join-Path $work 'gated') -TimeoutSeconds 180
        Check ([string](Get-AcceptanceOptionalValue -Object (Get-AcceptanceOptionalValue -Object $gatedVerdict -Name 'powershell') -Name 'stdout') -cmatch 'plan_id') `
            'the prose control for 3c did not produce prose, so a wrapped plan id is no longer exercised'
        Check ([int](Get-AcceptanceOptionalValue -Object $gatedVerdict -Name 'powershell_exit') -eq 0) `
            ("a gated row's confirming step did not run: " + [string]$gatedVerdict.detail + ' -- ' +
             (' ' -join @(@((Get-AcceptanceOptionalValue -Object $gatedVerdict -Name 'powershell')).stderr)))

        # --- 3d. A RESTORE ROW CARRIES THE QUARANTINE ITS RESET MADE ------------------------------
        #
        # THE ONLY WAY `{quarantine}` IS EXERCISED. The reset stamps its directory at the instant it
        # runs, so a restore step that received an empty name would refuse "name the quarantine" --
        # and the row would read as a restore defect rather than as a harness that lost the name. A
        # PowerShell arm that completes all four steps is what says the name survived.
        $restoreRow = Get-AcceptanceMatrixRow -Matrix $matrix -Id 'reset.quarantined-material-restores'
        $restoreVerdict = Invoke-AcceptanceRow -Matrix $matrix -Row $restoreRow -WorkDirectory (Join-Path $work 'restore') -TimeoutSeconds 180
        Check ([int](Get-AcceptanceOptionalValue -Object $restoreVerdict -Name 'powershell_exit') -eq 0) `
            ("the restore row did not complete, so the quarantine name was not carried: " + [string]$restoreVerdict.detail + ' -- ' +
             [string](Get-AcceptanceOptionalValue -Object (Get-AcceptanceOptionalValue -Object $restoreVerdict -Name 'powershell') -Name 'stderr'))

        # --- 3e. `prepare` REACHES THE FIXTURE, AND THE OPERATION SEES IT ------------------------
        #
        # A prepared file the renderer never saw would leave the drift row comparing two no-ops
        # again, which is the defect `prepare` was added for. So the row's own oracle must REPORT the
        # drift it repaired -- a statement about the prepared bytes that no clean fixture can make.
        $driftRow = Get-AcceptanceMatrixRow -Matrix $matrix -Id 'compile.master-index-is-derived-not-written'
        $driftVerdict = Invoke-AcceptanceRow -Matrix $matrix -Row $driftRow -WorkDirectory (Join-Path $work 'drift') -TimeoutSeconds 180
        $driftResult = Get-AcceptanceOptionalValue -Object (Get-AcceptanceOptionalValue -Object $driftVerdict -Name 'powershell') -Name 'result'
        Check ($null -ne $driftResult -and @(Get-AcceptanceOptionalList -Object $driftResult -Name 'drift_repaired').Count -ge 1) `
            'the drift row''s oracle reported no drift repaired, so its prepared hand edit never reached the renderer'

        # --- 3f. `{agent_pid}` IS A PROCESS THE HARNESS OWNS, AND IT IS NORMALISED BY VALUE ---------
        #
        # THE ENTER ROW BOUND WHOEVER RAN THE HARNESS until S14: both arms resolved the agent from an
        # inherited CLAUDE_PID, bound the fixture seat to that Claude session, and left a claim holder
        # waiting on it for the rest of the session. So this asserts three things: the stand-in reached
        # the oracle (its result names `<agent>`, which only the by-value rule can produce), every
        # holder let go once the stand-in was ended, and no holder spawned for this fixture survives.
        $enterRow = Get-AcceptanceMatrixRow -Matrix $matrix -Id 'seat.enter-an-existing-free-seat'
        $enterWork = Join-Path $work 'stand-in'
        $enterVerdict = Invoke-AcceptanceRow -Matrix $matrix -Row $enterRow -WorkDirectory $enterWork -TimeoutSeconds 180
        $enterArm = Get-AcceptanceOptionalValue -Object $enterVerdict -Name 'powershell'
        $enterResult = Get-AcceptanceOptionalValue -Object $enterArm -Name 'result'
        Check ($null -ne $enterResult -and [string]$enterResult.agent_pid -ceq '<agent>') `
            ("the enter row's oracle did not bind the harness's stand-in agent: " + [string]$enterVerdict.detail + ' -- ' +
             [string](Get-AcceptanceOptionalValue -Object $enterArm -Name 'stderr'))
        Check (-not [bool](Get-AcceptanceOptionalValue -Object $enterArm -Name 'holder_outlived_agent')) `
            'a claim holder outlived the stand-in agent it was bound to, so its fixture could not be removed'
        $survivors = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { [string]$_.CommandLine -like "*$enterWork*" })
        Check ($survivors.Count -eq 0) ("a process spawned for the stand-in row is still running: " + (@($survivors | ForEach-Object { $_.ProcessId }) -join ', '))

        # AND THE FALSIFYING HALF: a binding naming ANY OTHER process must stay a difference. A rule
        # that turned every agent_pid into a token would make the row green against a port that bound
        # the wrong agent, and would be symmetric -- the S17 shape that can only ever make a row greener.
        $byValue = Get-AcceptanceNormalisationTokens -Fixture ([pscustomobject]@{
            workspace = $work; registry = $work; root = $work; agent_pid = 424242 }) -ProgramRoot $script:ProgramRoot
        $other = ConvertTo-AcceptanceNormalisedData -Value ([pscustomobject]@{ agent_pid = 31337 }) -Tokens $byValue
        $mine = ConvertTo-AcceptanceNormalisedData -Value ([pscustomobject]@{ agent_pid = 424242 }) -Tokens $byValue
        Check ($other.agent_pid -is [int] -and $other.agent_pid -eq 31337) 'an agent_pid that is NOT the stand-in was normalised away'
        Check ([string]$mine.agent_pid -ceq '<agent>') 'the stand-in''s own agent_pid was not normalised'
        $otherText = ConvertTo-AcceptanceNormalisedText -Text '{ "agent_pid":  31337 }' -Tokens $byValue
        Check ($otherText -cmatch '31337') 'an agent_pid in a file that is NOT the stand-in was normalised away'

        # --- 3g. THE SEAT-OWNED NOTEBOOK IS REBASED BY VALUE AND THEN COMPARED ON CONTENT -----------
        #
        # THE COMPARATOR ITSELF, DRIVEN WITH OUTCOMES WHOSE ANSWER IS KNOWN. `notebook-is-seat-owned`
        # rewrites the ACTING seat's `notebook/<seat>` onto the oracle's `notebook` and then holds the
        # kernel to the oracle's content. Each case below is one way that could be wrong and green.
        $rebaseRow = Get-AcceptanceMatrixRow -Matrix $matrix -Id 'compile.source-batch-becomes-notebook-articles'
        $oracle = [pscustomobject]@{
            exit   = 0
            result = [pscustomobject]@{ article_path = 'notebook/acceptance/note.md'; target = '<workspace>\notebook' }
            effect = [ordered]@{
                'internal/notebook-topic-owners.json' = 'text:{ "topics": [] }'
                'notebook/_master-index.md'           = 'text:# Notebook Index'
                'notebook/acceptance/note.md'         = 'text:# Note'
            }
        }
        function New-KernelOutcome([string]$Root, [string]$Note = 'text:# Note', [hashtable]$Extra = @{}) {
            $effect = [ordered]@{
                'internal/notebook-layout.json' = 'text:{ "layout": "seat-owned" }'
                "$Root/_master-index.md"       = 'text:# Notebook Index'
                "$Root/acceptance/note.md"     = $Note
            }
            foreach ($key in $Extra.Keys) { $effect[$key] = $Extra[$key] }
            [pscustomobject]@{
                exit   = 0
                result = [pscustomobject]@{ article_path = "$Root/acceptance/note.md"; target = ('<workspace>\' + ($Root -replace '/', '\')) }
                effect = $effect
            }
        }
        $same = Compare-AcceptanceOutcome -Matrix $matrix -Row $rebaseRow -PowerShellOutcome $oracle -KernelOutcome (New-KernelOutcome 'notebook/fixture') -Seat 'fixture'
        Check ([bool]$same.green) ('a kernel writing the oracle''s content under its own seat''s root did not compare green: ' +
            ((@($same.differences) | ForEach-Object { [string]$_.field }) -join ', '))
        Check (@($same.approved | Where-Object { [string]$_.delta -ceq 'notebook-is-seat-owned' }).Count -ge 4) `
            'the rebase was not reported as an approved delta on every field it rewrote, so green is hiding it'
        $wrongSeat = Compare-AcceptanceOutcome -Matrix $matrix -Row $rebaseRow -PowerShellOutcome $oracle -KernelOutcome (New-KernelOutcome 'notebook/beta') -Seat 'fixture'
        Check (-not [bool]$wrongSeat.green) 'a kernel writing into ANOTHER seat''s root compared green: the rebase is not keyed by value'
        $noSeat = Compare-AcceptanceOutcome -Matrix $matrix -Row $rebaseRow -PowerShellOutcome $oracle -KernelOutcome (New-KernelOutcome 'notebook/fixture')
        Check (-not [bool]$noSeat.green) 'with no acting seat the rebase still applied, so it is not keyed by value'
        $wrongContent = Compare-AcceptanceOutcome -Matrix $matrix -Row $rebaseRow -PowerShellOutcome $oracle -KernelOutcome (New-KernelOutcome 'notebook/fixture' 'text:# Another note') -Seat 'fixture'
        Check (@($wrongContent.differences | Where-Object { [string]$_.field -ceq 'effect.notebook/acceptance/note.md' }).Count -eq 1) `
            'a rebased Notebook file holding different content was not reported as a difference: the rebase is absorbing content'
        $collision = Compare-AcceptanceOutcome -Matrix $matrix -Row $rebaseRow -PowerShellOutcome $oracle `
            -KernelOutcome (New-KernelOutcome 'notebook/fixture' 'text:# Note' @{ 'notebook/acceptance/note.md' = 'text:# Note' }) -Seat 'fixture'
        Check (-not [bool]$collision.green) 'two kernel files that rebase onto one path compared green: one of them was silently dropped'
        $extra = Compare-AcceptanceOutcome -Matrix $matrix -Row $rebaseRow -PowerShellOutcome $oracle `
            -KernelOutcome (New-KernelOutcome 'notebook/fixture' 'text:# Note' @{ 'internal/unlisted-kernel-file.json' = 'text:{}' }) -Seat 'fixture'
        Check (-not [bool]$extra.green) 'a kernel-only file the delta does not list compared green'
        $outsideArea = Compare-AcceptanceOutcome -Matrix $matrix -Row (Get-AcceptanceMatrixRow -Matrix $matrix -Id 'desk.open-a-book') `
            -PowerShellOutcome $oracle -KernelOutcome (New-KernelOutcome 'notebook/fixture') -Seat 'fixture'
        Check (-not [bool]$outsideArea.green) 'the Notebook rebase applied to a row outside the areas it is approved for'
        $segment = ConvertTo-AcceptanceRebasedText -Text 'notebook/fixtures/x and notebook\fixture and notebook\\fixture\\y' -From 'notebook/fixture' -Onto 'notebook'
        Check ($segment -ceq 'notebook/fixtures/x and notebook and notebook\\y') "the rebase is not whole-segment in all three spellings: '$segment'"
        $fileName = ConvertTo-AcceptanceRebasedText -Text '<stamp>-notebook-fixture-acceptance-<suffix>.json and notebook-fixtures-x' -From 'notebook/fixture' -Onto 'notebook'
        Check ($fileName -ceq '<stamp>-notebook-acceptance-<suffix>.json and notebook-fixtures-x') "the rebase does not read the hyphen-joined file-name spelling, or reads it past a segment: '$fileName'"

        # --- 4. THE DOCUMENT AGREES WITH THE ROWS ---------------------------------------------------
        $docProblem = Test-AcceptanceDoc -Matrix $matrix -ProgramRoot $script:ProgramRoot
        Check ([string]::IsNullOrWhiteSpace($docProblem)) $docProblem

        # --- 4b. A STEP RECEIVES EXACTLY THE STDIN IT DECLARED, AND NONE WHEN IT DECLARED NONE (S36) -
        #
        # Under a host whose input encoding carries a preamble, which is SET here rather than hoped for:
        # the defect was host-dependent, and a check that passed on a host without one would prove nothing.
        $probe = Join-Path $work 'stdin-probe.ps1'
        [IO.File]::WriteAllText($probe, '[CmdletBinding()] param() $s = [Console]::OpenStandardInput(); $b = New-Object byte[] 64; $n = $s.Read($b, 0, 64); "bytes=" + (($b[0..([Math]::Max(0, $n - 1))] | Select-Object -First $n | ForEach-Object { $_.ToString(''x2'') }) -join '' '')', [Text.UTF8Encoding]::new($false))
        $hostEncoding = [Console]::InputEncoding
        try {
            [Console]::InputEncoding = [Text.UTF8Encoding]::new($true)
            $none = Invoke-AcceptanceProcess -FileName 'powershell.exe' -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $probe) -TimeoutSeconds 60
            Check (([string]$none.stdout).Trim() -ceq 'bytes=') "a step that declared no stdin received bytes: $(([string]$none.stdout).Trim())"
            $some = Invoke-AcceptanceProcess -FileName 'powershell.exe' -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $probe) -Stdin '{"a":1}' -TimeoutSeconds 60
            Check (([string]$some.stdout).Trim() -ceq 'bytes=7b 22 61 22 3a 31 7d') "a step's stdin did not arrive as the bytes the row declared: $(([string]$some.stdout).Trim())"
        }
        finally { [Console]::InputEncoding = $hostEncoding }

        # --- 5. THIS SCRIPT'S OWN ENTRY PATH, AS A CHILD PROCESS -------------------------------------
        #
        # WHY THIS EXISTS, AND IT IS NOT SYMMETRY. Everything above calls Invoke-AcceptanceRow
        # directly, so the parameter binding, the row selection and the reporting loop between
        # `-Row` and that function were covered by nothing. A `foreach ($row in ...)` in that loop
        # silently WAS the script's own [string[]]$Row parameter, which coerced every row object to
        # a string array, and `-All` died on the first row asking a string array for its id. The
        # suite was green at the time. A harness reached only through its internals is a harness
        # whose front door is untested.
        $self = Join-Path $PSScriptRoot 'Invoke-AcceptanceMatrix.ps1'
        $listRun = Invoke-AcceptanceProcess -FileName 'powershell.exe' `
            -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self, '-List') -TimeoutSeconds 120
        Check ([int]$listRun.exit -eq 0) "-List exited $($listRun.exit): $($listRun.stderr)"
        Check ($listRun.stdout -cmatch 'workspace\.init-creates-marker') '-List did not name a row it holds'

        $rowRun = Invoke-AcceptanceProcess -FileName 'powershell.exe' `
            -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self, '-Row', 'workspace.init-creates-marker') -TimeoutSeconds 180
        Check ([int]$rowRun.exit -eq 0) "-Row exited $($rowRun.exit): $($rowRun.stderr)"
        Check ($rowRun.stdout -cmatch 'pending\s+workspace\.init-creates-marker') "-Row did not report the row pending: $($rowRun.stdout)"

        # -RequireGreen MUST FAIL TODAY, and that is the switch's whole job. A closing gate that
        # passed while every row was pending would be the one thing this harness must not do.
        $gateRun = Invoke-AcceptanceProcess -FileName 'powershell.exe' `
            -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self, '-Row', 'workspace.init-creates-marker', '-RequireGreen') -TimeoutSeconds 180
        Check ([int]$gateRun.exit -ne 0) '-RequireGreen exited 0 with a pending row, so the Phase D closing gate would pass on nothing'
    }
    finally {
        Exit-FixtureSeatClaim
        if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    }

    $checks = $script:selfTestChecks
    if ($failures.Count) {
        [Console]::Error.WriteLine("acceptance-matrix self-test FAILED ($($failures.Count) of $checks): " + ($failures -join '; '))
        exit 1
    }
    Write-Host "acceptance-matrix self-test passed ($checks checks)."
    exit 0
}

# --- Entry point ------------------------------------------------------------------------------

# RESOLVED ONCE, HERE, WHERE THE CALLER'S DIRECTORY IS STILL THE ONE THEY TYPED IT IN. Every step
# below runs in a fixture, so a relative kernel path resolved any later would be resolved against
# the wrong directory -- which is the whole defect this repairs. See Resolve-AcceptanceKernelCommand.
$Kernel = Resolve-AcceptanceKernelCommand -KernelCommand $Kernel -BaseDirectory (Get-Location).Path

if ($SelfTest) { Invoke-AcceptanceMatrixSelfTest; return }

# THE KERNEL'S OWN PROGRAM ROOT, asked of it once (S29). See Get-AcceptanceKernelProgramRoot.
$script:KernelProgramRoot = Get-AcceptanceKernelProgramRoot -KernelCommand $Kernel
$script:KernelCompiled = Test-AcceptanceKernelCompiled -KernelCommand $Kernel

$matrix = Get-AcceptanceMatrix -ProgramRoot $script:ProgramRoot

if ($RenderDoc) {
    $result = Write-AcceptanceDoc -Matrix $matrix -ProgramRoot $script:ProgramRoot
    Write-Host "$($script:AcceptanceDocRelativePath): $result"
    return
}
if ($CheckDoc) {
    $problem = Test-AcceptanceDoc -Matrix $matrix -ProgramRoot $script:ProgramRoot
    if (-not [string]::IsNullOrWhiteSpace($problem)) { [Console]::Error.WriteLine($problem); exit 1 }
    Write-Host "$($script:AcceptanceDocRelativePath) matches the rows."
    return
}

$selected = @($matrix.rows)
if (@($Row).Count) {
    $wanted = @($Row)
    $unknown = @($wanted | Where-Object { $id = $_; -not @(@($matrix.rows) | Where-Object { [string]$_.id -ceq $id }).Count })
    if ($unknown.Count) { throw ("no such row: " + ($unknown -join ', ') + '. Run -List for every id.') }
    $selected = @(@($matrix.rows) | Where-Object { @($wanted) -ccontains [string]$_.id })
}
if (-not [string]::IsNullOrWhiteSpace($Area)) {
    $selected = @(@($selected) | Where-Object { [string]$_.area -ceq $Area })
    if (-not $selected.Count) { throw "no row is in area '$Area'." }
}

if ($List) {
    if ($Json) { Write-AcceptanceJson -Value @(@($selected) | Select-Object id, area, class, oracle, fixture) -Depth 4; return }
    # $matrixRow, NEVER $row: `-Row` is a [string[]] PARAMETER of this script, and PowerShell
    # variable names are case-insensitive, so `foreach ($row in ...)` IS that parameter. Assigning a
    # row object to it COERCES the object to a string array, and the next line asks a string array
    # for its .id. Defect family 5 in .claude/rules/library-development.md, found by running -All
    # rather than by reading: the self-test called Invoke-AcceptanceRow directly and never crossed
    # this script's own entry path.
    foreach ($matrixRow in @($selected)) {
        '{0,-62} {1,-12} {2,-12} {3}' -f [string]$matrixRow.id, [string]$matrixRow.area, [string]$matrixRow.oracle, [string]$matrixRow.fixture
    }
    "`n{0} row(s)." -f @($selected).Count
    return
}

if (-not @($Row).Count -and -not $All -and [string]::IsNullOrWhiteSpace($Area)) {
    throw 'name rows with -Row, an area with -Area, or pass -All. -List prints every row.'
}

if ([string]::IsNullOrWhiteSpace($WorkDirectory)) {
    # A SECOND IS NOT AN IDENTITY (S31). Two runs started in the same second -- one from source, one
    # against the installed binary -- shared this directory, and each one's row cleanup deleted the
    # other's fixtures: the source run died in Remove-Item with no verdict at all. The stamp stays first
    # so the directories still sort by when they ran; the suffix is what makes each one a run's own.
    $WorkDirectory = Join-Path ([IO.Path]::GetTempPath()) ('acceptance-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
}
if (-not (Test-Path -LiteralPath $WorkDirectory -PathType Container)) { New-Item -ItemType Directory -Path $WorkDirectory -Force | Out-Null }

$sharedSelected = @(@($selected) | Where-Object { @(Get-AcceptanceOptionalList -Object $_ -Name 'requires') -ccontains 'shared-collection' })
if ($IncludeShared -and $sharedSelected.Count) {
    # REFUSED BEFORE ANY ROW RUNS, not discovered by the first shared row: the disposable projects are
    # made on this endpoint and nowhere else, and there is deliberately no default for either.
    if ([string]::IsNullOrWhiteSpace($McpUrl) -or [string]::IsNullOrWhiteSpace($SharedKnowledgeRoot)) {
        throw ('-IncludeShared selects ' + $sharedSelected.Count + ' row(s) that need the shared collection, and each arm of each runs in a ' +
            'disposable project of its own: pass -McpUrl <endpoint> and -SharedKnowledgeRoot <the share folder holding its projects>. ' +
            'Neither is read from this machine''s configuration, which names the reader''s own collection.')
    }
    if (-not (Test-Path -LiteralPath $SharedKnowledgeRoot -PathType Container)) { throw "-SharedKnowledgeRoot '$SharedKnowledgeRoot' is not a reachable folder." }
}

$verdicts = [Collections.Generic.List[object]]::new()
foreach ($matrixRow in @($selected)) {
    $verdict = Invoke-AcceptanceRow -Matrix $matrix -Row $matrixRow -WorkDirectory $WorkDirectory -Kernel $Kernel `
        -IncludeIndependent:$IncludeIndependent -IncludeShared:$IncludeShared -McpUrl $McpUrl -SharedKnowledgeRoot $SharedKnowledgeRoot `
        -KeepFixtures:$KeepFixtures -TimeoutSeconds $TimeoutSeconds
    [void]$verdicts.Add($verdict)
    if (-not $Json) { '{0,-10} {1,-62} {2}' -f [string]$verdict.status, [string]$verdict.row, [string]$verdict.detail }
}

$counts = [ordered]@{}
foreach ($status in @('green', 'mismatch', 'dirty', 'pending', 'independent', 'skipped', 'error')) {
    $counts[$status] = @(@($verdicts) | Where-Object { [string]$_.status -ceq $status }).Count
}

if ($Json) {
    Write-AcceptanceJson -Value ([pscustomobject]@{
        kernel = if ([string]::IsNullOrWhiteSpace($Kernel)) { '' } else { $Kernel }
        counts = [pscustomobject]$counts
        rows   = @($verdicts)
    })
}
else {
    ''
    # DERIVED, NEVER TYPED, and `pending` is counted where it can be seen rather than folded into a
    # pass rate.
    ('{0} row(s): {1}' -f @($verdicts).Count, (@(@($counts.Keys) | Where-Object { $counts[$_] -gt 0 } | ForEach-Object { "$($counts[$_]) $_" }) -join ', '))
}

if ($RequireGreen) {
    $notGreen = @(@($verdicts) | Where-Object { [string]$_.status -cne 'green' })
    if ($notGreen.Count) {
        [Console]::Error.WriteLine(('-RequireGreen: {0} of {1} row(s) are not green' -f $notGreen.Count, @($verdicts).Count))
        exit 1
    }
}
if ($counts['error'] -gt 0) { exit 1 }
