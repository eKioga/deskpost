<#
.SYNOPSIS
    The seat lifecycle, driven through the REAL launcher and the REAL retirement helper as separate
    processes against a fixture workspace. Run by Invoke-LibraryChecks.ps1 as `seat.lifecycle`.

.DESCRIPTION
    WHY THIS EXISTS. Until 2026-09-09 `Start-LibrarySeat.ps1` and `Retire-Seat.ps1` appeared in no
    `tools/Test-*.ps1` and carried no `-SelfTest`, so the code that MINTS EVERY CLAIM on the mutation
    critical path was exercised by nothing. `desk.two-seat-acceptance` is not that cover and was
    never meant to be: it fabricates its pair with `Initialize-SeatForFixture` and
    `Write-SeatRegistry` and never drives the launcher, because every assertion it makes is about
    disagreement between two CONSUMERS of a Desk rather than about how a seat comes to exist.

    THE MECHANISM THAT MAKES A FIXTURE WORK WHERE THE LIVE REGISTRY CANNOT. A claim is an open file
    handle held by the launching process, so `-NoLaunch` -- which returns instead of spawning the
    agent -- leaves the seat UNCLAIMED the moment the child exits. That is the only way to reach
    Retire-Seat's plan body at all: against a claimed seat it refuses before a `plan_id` is issued,
    and the live registry's own seats are claimed by whichever session is reading this. NO CASE HERE
    LAUNCHES AN AGENT.

    EVERY REFUSAL IS MEASURED BY WHAT IT SAYS, not merely that it said something. A refusal naming
    the wrong seat, or listing the wrong seats as the ones that exist, sends the reader to the wrong
    fix. So the fixture plants a DECOY seat -- registered, bound to its own project, holding its own
    Desk lines -- exactly where a wrong implementation would look: at the first registry entry, at
    the `LIBRARY_SEAT` an unknown seat could fall back to, and at the Desk a retirement plan might
    read instead of the named seat's. Each assertion then reads a VALUE, so a wrong implementation
    answers with a wrong seat name rather than with a missing file.

    CASES. Seat creation and its registry entry; a project collision refused; the seat<->project
    binding refused in BOTH directions; the preflight on an unclaimed seat as the CONTROL; a second
    live claim refused, naming the fix, with the Desk untouched; `-Preflight` refused on a
    live-claimed seat (the 2026-09-09 ordering fix's regression guard); retirement refusing that same
    seat before a `plan_id` is issued; Retire-Seat's plan body reached and coherent; the `plan_id`
    bound to the Desk it planned; the Desk archived to `internal/seat-archive/` and recoverable
    byte-for-byte; and malformed, unknown and unparseable input failing closed rather than falling
    back.

    CASE 20 IS THE DESK OVERVIEW'S OWN LINE (step 14), driven as a real child process: this seat's
    agent, its bind time read back from a binding whose stamp was edited to a distinctive past
    instant, and its last conversation with the title that says WHICH transcript tree was read --
    beside the tier it must not widen, with a titled conversation planted at a foreign seat and
    asserted absent from the payload while that seat's counts and liveness are asserted present.

    CASE 21 IS THE CONVERSATION HISTORY (plan step 8), and the row it exists for is the sequence a
    binding could not survive: one conversation sits at a seat, a second takes it, and the FIRST is
    resumed and put back. Beside it, the two migration branches a pre-step-8 seat can arrive
    through -- the ordinary enter, whose `pending` write destroys the record being migrated, and the
    orphan recovery, which writes no binding at all -- a `pending` binding recording nothing, the
    unlocked write refused, four ways a record can be present and unusable each answered on its own,
    and retirement archiving the history byte for byte.

    CASE 13 IS THE RESOLUTION HALF (ADR-0018, plan steps 5 and 6), and it is about which seat a call
    is ABOUT rather than about what may be done there: the three sources in their order with the
    `source` each reports, the binding-versus-environment disagreement refused naming both and
    reaching Get-DeskStateDirectory, identity admitting a mutation with a decoy token that matches
    nothing, a reused PID neither resolving nor inheriting that admission, an agent bound elsewhere
    refused by a message naming its own seat, and two bindings for one agent failing closed.
#>
[CmdletBinding()]
param([switch]$Json)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
# The shared creation gate, for the cases that exercise it directly and for Get-NotebookOwnersPath --
# a fixture that spelled `internal/notebook-topic-owners.json` itself would be a second definition of
# a path this repository keeps in one place.
. (Join-Path $PSScriptRoot 'SeatCreation.ps1')
# The terminal picker (step 12), for case 19: its roster builder, its choice grammar and its
# transcript reader are asserted directly, and the launcher is then driven as a real process over
# the same code. It brings SeatConversation.ps1 with it, which case 20 uses to compare the picker's
# row against the Desk overview's own line at one seat -- the two surfaces that share that
# derivation.
. (Join-Path $PSScriptRoot 'SeatPicker.ps1')

$script:cases = 0
function Assert-True([bool]$Condition, [string]$What) {
    $script:cases++
    if (-not $Condition) { throw $What }
}
function Assert-Equal([string]$Expected, [string]$Actual, [string]$What) {
    $script:cases++
    if ($Expected -cne $Actual) { throw "$What -- was '$Actual', expected '$Expected'" }
}

# ASSERT SHAPE BEFORE VALUES. Under Set-StrictMode, reading a property the object does not carry
# throws PropertyNotFound -- a red that names the reader's own line rather than the field the helper
# failed to emit. The property names are ENUMERATED rather than read off the aggregate .Name, which
# on a single-property object is a bare string and answers the wrong question.
function Get-Field([object]$Object, [string]$Name, [string]$What) {
    $script:cases++
    $names = @($Object.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -cnotcontains $Name) { throw "$What -- the result carries no '$Name' property; it has: $($names -join ', ')" }
    $Object.$Name
}

# --- A LOOPBACK ACTIVE PROJECT CATALOG, so this suite stays OFFLINE -------------------------------
#
# WHY THIS EXISTS. On 2026-09-10 creating a seat began validating that its Project Hub exists and is
# ACTIVE, because the launcher had been accepting any well-formed slug -- which is what made
# one-seat-per-project unenforceable, an invented slug being unique by construction. The only
# authority for "this Hub is active" is the Active Project Catalog in the shared collection, so the
# creation path now makes one network read.
#
# THIS SUITE MUST NOT NEED THE NAS. It is registered in the offline gate and covers the launcher and
# retirement as real processes; moving it behind `-IncludeShared` would take every seat lifecycle
# case out of the default run to buy one read. So it serves that one read itself, on loopback, the
# way Test-McpHelpers.ps1 already serves a whole Basic Memory stub -- port 0 picks a free port and a
# 127.0.0.1 prefix needs no administrator rights.
#
# THE STUB IS DELIBERATELY MINIMAL AND IT IS NOT THE PROOF. It answers `initialize` and one
# `read_note` for `projects/README`, and nothing else. Whether the REAL catalog read works is
# `seat.create-acceptance`'s job, against the live collection under `-IncludeShared`; what this
# serves is the precondition, so the cases below can be about seats.
$catalogProjects = @(
    'aa-decoy-proj', 'alpha-proj', 'beta-proj', 'chi-proj', 'epsilon-proj', 'gamma-proj',
    'omega-proj', 'other-proj', 'phi-proj', 'psi-proj', 'sigma-proj', 'tau-proj',
    'upsilon-proj', 'zeta-proj',
    # Case 19's own, so the picker's creation route has a Project to bind that no other case touches.
    # `pick-fixed-proj` and `pick-reask-proj` belong to the two re-ask cases and are separate for the
    # same reason: one of them BINDS its Project, so sharing a slug with 19j would retire that case's
    # approval before it ran.
    'pick-made-proj', 'pick-approved-proj', 'pick-fixed-proj', 'pick-reask-proj',
    # Case 22's own. Two for the SAME seat slug, because the case exists to reuse that slug: a
    # second incarnation is a new seat and a seat is bound to exactly one Project.
    'recur-one-proj', 'recur-two-proj', 'bystand-proj', 'ghosted-proj', 'strand-proj'
)
$catalogBody = "# Active Projects`n`n## Projects`n`n" +
    (($catalogProjects | ForEach-Object { "- [[projects/$_/_project|$_]]" }) -join "`n") + "`n"

$catalogPort = 0
$portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$catalogPort = ([Net.IPEndPoint]$portProbe.LocalEndpoint).Port
$portProbe.Stop()

$catalogListener = [Net.HttpListener]::new()
$catalogListener.Prefixes.Add("http://127.0.0.1:$catalogPort/")
$catalogListener.Start()
# `Notes` is what lets the stub answer a WRITE, added 2026-09-11 for the picker's Hub-creation route.
# Without it the stub could only ever report "no such project", so the one branch that creates a Hub
# -- the branch the whole route exists for -- had no fixture to run in. Synchronized for the same
# reason the outer table is: the listener below runs in its own runspace.
$catalogState = [hashtable]::Synchronized(@{ Body = $catalogBody; SessionId = [guid]::NewGuid().ToString('N'); Running = $true
    Notes = [hashtable]::Synchronized(@{}) })

$catalogScript = {
    while ($State.Running) {
        $context = $null
        try { $context = $Listener.GetContext() } catch { break }
        try {
            $request = $context.Request
            $raw = ''
            if ($request.HasEntityBody) {
                $reader = [IO.StreamReader]::new($request.InputStream, [Text.Encoding]::UTF8)
                $raw = $reader.ReadToEnd()
                $reader.Dispose()
            }
            $payload = if ($raw) { $raw | ConvertFrom-Json } else { $null }
            $method = if ($null -ne $payload -and $payload.PSObject.Properties['method']) { [string]$payload.method } else { '' }
            $id = if ($null -ne $payload -and $payload.PSObject.Properties['id']) { $payload.id } else { $null }
            $response = $context.Response
            # A notification carries no id and expects no body -- only that the POST succeeded.
            if ($null -eq $id) {
                $response.StatusCode = 202
                $response.ContentLength64 = 0
                $response.Close()
                continue
            }
            $result = $null
            if ($method -eq 'initialize') {
                $result = @{ protocolVersion = '2025-03-26'; capabilities = @{ tools = @{} }; serverInfo = @{ name = 'stub-catalog'; version = '0.0.1' } }
            }
            elseif ($method -eq 'tools/call' -and [string]$payload.params.name -eq 'write_note') {
                # ONE IDENTIFIER SPACE, `.md` STRIPPED. A note is written as directory + title and read
                # back as '<directory>/<title>.md', so a stub keying the two differently would store a
                # write nothing could ever read -- and the readback is what New-ProjectHub.ps1 proves
                # its own write with.
                $writeKey = "$([string]$payload.params.arguments.directory)/$([string]$payload.params.arguments.title)"
                $State.Notes[$writeKey] = [string]$payload.params.arguments.content
                $result = @{
                    content           = @(@{ type = 'text'; text = "Wrote $writeKey" })
                    structuredContent = @{ result = @{ file_path = "$writeKey.md"; title = [string]$payload.params.arguments.title } }
                    isError           = $false
                }
            }
            elseif ($method -eq 'tools/call' -and [string]$payload.params.name -eq 'read_note') {
                $identifier = [string]$payload.params.arguments.identifier
                $readKey = $identifier -creplace '\.md$', ''
                if ($State.Notes.ContainsKey($readKey)) {
                    # A STORED WRITE OUTRANKS THE SEEDED CATALOG, which is the point: New-ProjectHub.ps1
                    # adds its entry to 'projects/README', and a re-read that still served the seed
                    # would report the Hub as inactive immediately after creating it.
                    $stored = [string]$State.Notes[$readKey]
                    $result = @{
                        content           = @(@{ type = 'text'; text = $stored })
                        structuredContent = @{ result = @{ file_path = "$readKey.md"; title = $readKey; content = $stored; frontmatter = @{} } }
                        isError           = $false
                    }
                }
                elseif ($readKey -ceq 'projects/README') {
                    $result = @{
                        content           = @(@{ type = 'text'; text = $State.Body })
                        structuredContent = @{ result = @{ file_path = 'projects/README.md'; title = 'Active Projects'; content = $State.Body; frontmatter = @{} } }
                        isError           = $false
                    }
                }
                else {
                    # An ABSENT note, in the shape Basic Memory really answers with: a successful
                    # read carrying an empty record. Get-RawOwnerCatalogSet keys its `absent` verdict
                    # on exactly that, and a stub that returned an error instead would make the
                    # archive catalog read as FAILED and degrade every answer.
                    $result = @{
                        content           = @(@{ type = 'text'; text = '' })
                        structuredContent = @{ result = @{ file_path = ''; title = ''; content = ''; frontmatter = @{} } }
                        isError           = $false
                    }
                }
            }
            else { $result = @{ content = @(@{ type = 'text'; text = "Unknown method '$method'" }); structuredContent = @{ result = $null }; isError = $true } }

            # NOT $json: this suite declares a [switch]$Json script parameter, and PowerShell variable
            # names are case-insensitive, so that assignment would rebind it. Defect family 5, caught
            # by powershell.defect-families on the first run of this stub.
            $responseJson = @{ jsonrpc = '2.0'; id = $id; result = $result } | ConvertTo-Json -Depth 32 -Compress
            $bytes = [Text.Encoding]::UTF8.GetBytes("event: message`ndata: $responseJson`n`n")
            $response.StatusCode = 200
            $response.ContentType = 'text/event-stream'
            if ($method -eq 'initialize') { $response.Headers.Add('Mcp-Session-Id', $State.SessionId) }
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
        }
        catch {
            try { $context.Response.StatusCode = 500; $context.Response.Close() } catch { }
        }
    }
}

$catalogRunspace = [runspacefactory]::CreateRunspace()
$catalogRunspace.Open()
$catalogRunspace.SessionStateProxy.SetVariable('Listener', $catalogListener)
$catalogRunspace.SessionStateProxy.SetVariable('State', $catalogState)
$catalogServer = [powershell]::Create()
$catalogServer.Runspace = $catalogRunspace
[void]$catalogServer.AddScript($catalogScript)
$catalogHandle = $catalogServer.BeginInvoke()

# EXPORTED, NOT PASSED. Every child helper defaults -McpUrl to this variable, so one export covers
# the launcher, the Enter helper and anything either of them shells out to -- and a helper that
# forgets to plumb the parameter through is still pointed at the stub rather than at the NAS.
$savedMcpUrl = $env:AI_LIBRARY_MCP_URL
$env:AI_LIBRARY_MCP_URL = "http://127.0.0.1:$catalogPort/mcp"

$utf8 = [Text.UTF8Encoding]::new($false)
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('seat-lifecycle-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stateDir = Join-Path $fixture '.claude'
$savedSeat = $env:LIBRARY_SEAT
$savedClaim = $env:LIBRARY_SEAT_CLAIM
$claims = [Collections.Generic.List[object]]::new()
# The stand-in agent processes case 12 spawns. Killed in the finally as well as in the case itself:
# an assertion that throws mid-case must not leave a sleeping process behind on the reader's machine.
$dummies = [Collections.Generic.List[object]]::new()

# A HELPER IS A PROCESS HERE, NOT A FUNCTION, because its contract includes a non-zero exit code and
# an `exit` from an in-process call would end this suite instead of the helper.
#
# THE CHILD'S STREAMS ARE SEPARATED BY TYPE, AND THE PREFERENCE IS DROPPED ACROSS THE CALL ITSELF.
# Filtering after the assignment is too late: at $ErrorActionPreference = 'Stop' the FIRST
# ErrorRecord the redirection produces terminates this suite DURING the redirection, carrying the
# child's message and a parent-side stack -- which reads as a suite bug rather than as the refusal
# the case is measuring. 'Continue' keeps the records as objects and leaves $LASTEXITCODE intact;
# $? goes false while the exit code stays the child's, which is why the exit code is what is read.
#
# AND THE TEXT IS FLATTENED. A child renders a long refusal wrapped to its own console width, so a
# message this suite asserts on arrives split across records. Joining and collapsing runs of
# whitespace restores it, because the wrap falls on a space.
function Invoke-SeatHelper([string]$Helper, [string[]]$ArgumentList) {
    $helperPath = Join-Path $PSScriptRoot $Helper
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $lines = @()
    try { $lines = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helperPath @ArgumentList 2>&1) }
    finally { $ErrorActionPreference = $old }
    $code = $LASTEXITCODE
    $out = @($lines | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
    $err = @($lines | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
    [pscustomobject]@{
        ExitCode = $code
        Stdout   = $out
        Stderr   = $err
        Text     = (((@($out) + @($err)) -join ' ') -replace '\s+', ' ')
    }
}
function Start-Seat([string[]]$ArgumentList) { Invoke-SeatHelper 'Start-LibrarySeat.ps1' (@('-WorkspacePath', $fixture) + $ArgumentList) }
function Invoke-SeatRetirement([string[]]$ArgumentList) { Invoke-SeatHelper 'Retire-Seat.ps1' (@('-WorkspacePath', $fixture) + $ArgumentList) }

# A plan is only ISSUED if it lands on STDOUT. That is the whole subject of the ordering fix: a
# refused operation must print no plan at all, so this reads the stdout stream rather than the
# merged text a `2>&1` capture would hand it.
function Get-PlanLines($Invocation) {
    @($Invocation.Stdout | Where-Object { $_.Trim().StartsWith('{') })
}
function Get-ResultJson($Invocation, [string]$What) {
    $planLines = @(Get-PlanLines $Invocation)
    if (-not $planLines.Count) { throw "$What -- the helper produced no JSON result; output was: $($Invocation.Text)" }
    ($planLines[-1] | ConvertFrom-Json)
}

# The registry as ONE comparable value covering every seat AND every binding, read through the real
# reader -- so a registry this suite could not itself parse fails here rather than silently.
function Get-RegistrySummary {
    $registry = Read-SeatRegistry -StateDirectory $stateDir
    $pairs = @(@($registry.seats) | ForEach-Object { "$([string]$_.seat)=$([string]$_.project)" })
    (@($pairs | Sort-Object) -join ',')
}
function Get-DeskText([string]$Seat, [string]$Kind) {
    $path = Get-DeskFilePath -StateDirectory $stateDir -Seat $Seat -Kind $Kind
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    [IO.File]::ReadAllText($path)
}

$failure = $null
try {
    # --- The fixture, and the decoy that makes a wrong answer a WRONG VALUE ------------------------
    #
    # `aa-decoy` sorts BEFORE every seat this suite creates, so an implementation reporting "the
    # first registry entry" instead of the named one answers aa-decoy-proj rather than nothing. It
    # holds its own Desk lines for the same reason: a retirement plan that read the wrong seat's Desk
    # names shelf/decoy-book, which no assertion below accepts.
    foreach ($relative in @('.claude', 'internal', 'notebook')) {
        New-Item -ItemType Directory -Path (Join-Path $fixture $relative) -Force | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $stateDir '.library-project'), "00000000-0000-0000-0000-000000000000`n", $utf8)
    Initialize-SeatForFixture -StateDirectory $stateDir -Seat 'aa-decoy' -Project 'aa-decoy-proj' `
        -OpenBooks @('shelf/decoy-book') -OpenProjects @('projects/aa-decoy-proj') | Out-Null

    # No seat and no claim in this process's environment. Every helper below is given its seat
    # explicitly, and a fall-back to an inherited one is a defect the unknown-seat case measures.
    $env:LIBRARY_SEAT = ''
    $env:LIBRARY_SEAT_CLAIM = ''

    Assert-Equal 'aa-decoy=aa-decoy-proj' (Get-RegistrySummary) 'the fixture registry did not start with the decoy alone'

    # --- 1. Creation: the launcher mints the seat, its Desk and its registry entry -----------------
    $created = Start-Seat @('-Seat', 'alpha', '-Project', 'alpha-proj', '-NoLaunch', '-Json')
    Assert-True ($created.ExitCode -eq 0) "creating seat alpha failed: $($created.Text)"
    $createdResult = Get-ResultJson $created 'seat creation'
    Assert-Equal 'alpha' ([string](Get-Field $createdResult 'seat' 'seat creation')) 'the launcher reported the wrong seat'
    Assert-Equal 'alpha-proj' ([string](Get-Field $createdResult 'project' 'seat creation')) 'the launcher reported the wrong project binding'
    Assert-Equal 'True' ([string](Get-Field $createdResult 'claim_held' 'seat creation')) 'the launcher did not report holding the claim'
    Assert-Equal 'False' ([string](Get-Field $createdResult 'shared_library_write' 'seat creation')) 'seat creation claimed a shared-collection write'
    Assert-Equal '' ((@(Get-Field $createdResult 'desk_migrated' 'seat creation')) -join ',') 'a brand-new seat reported migrating a legacy Desk'

    # The registry gained exactly one entry and KEPT the decoy. A create that rewrote the file from
    # its own single entry passes any "does alpha exist" test while losing the other seat.
    Assert-Equal 'aa-decoy=aa-decoy-proj,alpha=alpha-proj' (Get-RegistrySummary) 'the registry after creating alpha'

    # BOTH Desk files, always: creating only one strands day-one Project Hub state, and every reader
    # of the pair throws on a missing file rather than treating it as empty.
    Assert-Equal '' ([string](Get-DeskText 'alpha' 'books')) "the new seat's books Desk file was not created empty"
    # AND ITS OWN PROJECT HUB IS OPEN ON IT, since 2026-09-10: the same Desk tools/Enter-LibrarySeat.ps1
    # builds. This route created the Desk and left it EMPTY until then, so which route created a seat
    # decided whether the session that entered it could orient itself. seat.creation-gate holds both
    # routes to Get-NewSeatDeskEntry now, the same way it holds them to the validation gate.
    Assert-Equal 'projects/alpha-proj' (([string](Get-DeskText 'alpha' 'projects')).Trim()) "the new seat's Desk does not hold its own Project Hub"
    # -NoLaunch left the seat UNCLAIMED, which is the property every case below depends on.
    Assert-True (-not (Test-SeatClaim -StateDirectory $stateDir -Seat 'alpha')) 'a -NoLaunch run left a claim behind, so nothing below reaches an unclaimed seat'

    # --- 1b. A PROJECT HUB THAT DOES NOT EXIST IS REFUSED (SeatCreation.ps1, 2026-09-10) ----------
    #
    # THE LAUNCHER TOOK ANY WELL-FORMED SLUG UNTIL THIS LANDED, which is also what made
    # one-seat-per-project unenforceable: an invented project is unique by construction, so the
    # collision check below could never fire for one. A seat bound to a Hub nobody has would
    # namespace its Notebook and `output/` under a name nothing else in the Library knows.
    $ghostProject = Start-Seat @('-Seat', 'ghost', '-Project', 'no-such-hub', '-NoLaunch', '-Json')
    Assert-True ($ghostProject.ExitCode -ne 0) 'the launcher created a seat for a Project Hub that does not exist'
    Assert-True ($ghostProject.Text.Contains('no active Project Hub')) "the launcher's unknown-project refusal did not say why: $($ghostProject.Text)"
    Assert-True ($ghostProject.Text.Contains('alpha-proj')) "the launcher's unknown-project refusal did not list the active Projects: $($ghostProject.Text)"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path (Get-SeatsDirectory $stateDir) 'ghost'))) 'a refused creation left a seat directory behind'
    Assert-Equal 'aa-decoy=aa-decoy-proj,alpha=alpha-proj' (Get-RegistrySummary) 'the refused unknown-project creation still changed the registry'

    # AND A SEAT NAME AN OWNERSHIP ROW STILL CITES IS REFUSED, before the Project is even considered:
    # a reader whose seat NAME is the problem must not be sent to fix the Project argument. The row
    # is planted as a file rather than through Set-NotebookTopicOwner, which takes two locks and
    # refuses an acting session with no claim -- this is corrupt state the fixture is placing, not a
    # reassignment it is performing.
    $ownersPath = Get-NotebookOwnersPath -Workspace $fixture
    [IO.File]::WriteAllText($ownersPath, (([pscustomobject]@{
        schema = 1; topics = @([pscustomobject]@{ topic = 'ghost-topic'; seat = 'ghost'; scope = 'owned' })
    } | ConvertTo-Json -Depth 6) + "`n"), $utf8)
    $citedName = Start-Seat @('-Seat', 'ghost', '-Project', 'gamma-proj', '-NoLaunch', '-Json')
    Assert-True ($citedName.ExitCode -ne 0) 'a seat was created under a name the ownership record still cites'
    Assert-True ($citedName.Text.Contains('cannot be used yet')) "the cited-name refusal did not say why: $($citedName.Text)"
    Assert-True ($citedName.Text.Contains('no retirement record')) "the refusal did not name the thing that would clear it -- a retirement record: $($citedName.Text)"
    Assert-True ($citedName.Text.Contains('ghost-topic')) "the cited-name refusal did not name the record that cites it: $($citedName.Text)"
    Assert-True ($citedName.Text -cnotmatch 'no active Project Hub') "the cited-name refusal answered about the Project instead of the seat name: $($citedName.Text)"
    Remove-Item -LiteralPath $ownersPath -Force

    # --- 2. A project collision is refused, and NAMES THE SEAT THAT HOLDS IT -----------------------
    $collision = Start-Seat @('-Seat', 'beta', '-Project', 'alpha-proj', '-NoLaunch', '-Json')
    Assert-True ($collision.ExitCode -ne 0) 'a second seat was bound to a project that already had one'
    Assert-True ($collision.Text.Contains("already bound to seat 'alpha'")) "the collision refusal did not name the holding seat: $($collision.Text)"
    Assert-Equal 'aa-decoy=aa-decoy-proj,alpha=alpha-proj' (Get-RegistrySummary) 'the refused collision still changed the registry'

    # --- 3. The binding is refused in BOTH directions ----------------------------------------------
    $rebind = Start-Seat @('-Seat', 'alpha', '-Project', 'other-proj', '-NoLaunch', '-Json')
    Assert-True ($rebind.ExitCode -ne 0) 'an existing seat was rebound to a different project'
    Assert-True ($rebind.Text.Contains("already bound to project 'alpha-proj'")) "the rebind refusal did not name the existing binding: $($rebind.Text)"
    $unbound = Start-Seat @('-Seat', 'brandnew', '-NoLaunch', '-Json')
    Assert-True ($unbound.ExitCode -ne 0) 'a new seat was created with no project bound to it'
    Assert-True ($unbound.Text.Contains('-Project <project-slug>')) "the missing-project refusal did not name the fix: $($unbound.Text)"
    Assert-Equal 'aa-decoy=aa-decoy-proj,alpha=alpha-proj' (Get-RegistrySummary) 'a refused binding still changed the registry'

    # --- 4. THE CONTROL: the preflight on an UNCLAIMED seat ----------------------------------------
    # This is exactly what case 6 must NOT reproduce, and it runs without -NoLaunch deliberately, so
    # `launch` carries the promise the defect made. The preflight returns before `& $Command`, so
    # nothing is spawned by asking for it.
    $control = Start-Seat @('-Seat', 'alpha', '-Preflight', '-Json')
    Assert-True ($control.ExitCode -eq 0) "the preflight on an unclaimed seat failed: $($control.Text)"
    $controlPlan = Get-ResultJson $control 'the unclaimed preflight'
    Assert-Equal 'False' ([string](Get-Field $controlPlan 'claim_live' 'the unclaimed preflight')) 'an unclaimed seat reported a live claim'
    Assert-Equal 'claude' ([string](Get-Field $controlPlan 'launch' 'the unclaimed preflight')) 'the preflight did not promise the launch it would perform'
    Assert-Equal 'True' ([string](Get-Field $controlPlan 'seat_exists' 'the unclaimed preflight')) 'an existing seat was planned as new'
    Assert-Equal 'alpha-proj' ([string](Get-Field $controlPlan 'project' 'the unclaimed preflight')) 'the preflight read the wrong project binding'
    $others = @(Get-Field $controlPlan 'other_seats' 'the unclaimed preflight')
    Assert-True ($others -ccontains 'aa-decoy') "the preflight did not list the other seat: $($others -join ',')"
    Assert-True ($others -cnotcontains 'alpha') 'the preflight listed this seat among the OTHER seats'

    # A preflight for a seat that does not exist yet plans create-empty and writes nothing. The
    # legacy Desk this workspace migrated once is gone, so create-empty is the CORRECT plan here and
    # the migration path is deliberately not manufactured to test it.
    $newPlan = Get-ResultJson (Start-Seat @('-Seat', 'gamma', '-Project', 'gamma-proj', '-Preflight', '-Json')) 'the new-seat preflight'
    Assert-Equal 'False' ([string](Get-Field $newPlan 'seat_exists' 'the new-seat preflight')) 'a seat that does not exist was planned as existing'
    $migrationRows = @(Get-Field $newPlan 'desk_migration' 'the new-seat preflight')
    Assert-Equal '2' ([string]$migrationRows.Count) 'the Desk plan did not cover both files'
    $actions = @($migrationRows | ForEach-Object { [string](Get-Field $_ 'action' 'the new-seat Desk plan') })
    Assert-Equal 'create-empty,create-empty' (@($actions) -join ',') 'the new-seat Desk plan'
    Assert-Equal 'aa-decoy=aa-decoy-proj,alpha=alpha-proj' (Get-RegistrySummary) 'a preflight created a seat'

    # --- 5. A second live claim is refused, it names the fix, and the Desk is untouched ------------
    # CLAIM BEFORE MIGRATING: the refusal must arrive before this session starts changing the seat's
    # Desk, so the Desk seeded here is compared on the far side of the refusal.
    Set-FixtureDeskLines -StateDirectory $stateDir -Seat 'alpha' -Kind 'books' -Lines @('shelf/alpha-book') | Out-Null
    Set-FixtureDeskLines -StateDirectory $stateDir -Seat 'alpha' -Kind 'projects' -Lines @('projects/alpha-proj') | Out-Null
    $deskBefore = "$(Get-DeskText 'alpha' 'books')|$(Get-DeskText 'alpha' 'projects')"

    $claim = Enter-SeatClaim -StateDirectory $stateDir -Seat 'alpha'
    [void]$claims.Add($claim)
    Assert-True (Test-SeatClaim -StateDirectory $stateDir -Seat 'alpha') 'the held claim did not read as live, so nothing below is refused for the right reason'

    $second = Start-Seat @('-Seat', 'alpha', '-NoLaunch', '-Json')
    Assert-True ($second.ExitCode -ne 0) 'a SECOND session started at a seat that was already held'
    Assert-True ($second.Text.Contains('already has a live session')) "the second-session refusal did not say why: $($second.Text)"
    Assert-True ($second.Text.Contains('tools/Start-LibrarySeat.ps1 -Seat')) "the second-session refusal did not name the fix: $($second.Text)"
    Assert-Equal $deskBefore "$(Get-DeskText 'alpha' 'books')|$(Get-DeskText 'alpha' 'projects')" 'the refused session changed the Desk before being refused'

    # --- 6. REGRESSION GUARD for the 2026-09-09 ordering fix ---------------------------------------
    # The defect: the preflight computed the very value that refuses, printed `claim_live: True`,
    # promised `launch: claude` and exited 0 for an operation Enter-SeatClaim refuses a dozen lines
    # later. Reverting the fix makes this run reproduce the CONTROL above exactly -- which is what
    # these three assertions forbid. A plan on stdout is the fault itself, not a missing file.
    $claimedPreflight = Start-Seat @('-Seat', 'alpha', '-Preflight', '-Json')
    Assert-True ($claimedPreflight.ExitCode -ne 0) 'the preflight exited 0 for an operation certain to be refused'
    $issued = @(Get-PlanLines $claimedPreflight)
    Assert-True (-not $issued.Count) "the preflight ISSUED A PLAN for a live-claimed seat: $($issued -join ' ')"
    Assert-True ($claimedPreflight.Text.Contains('tools/Start-LibrarySeat.ps1 -Seat')) "the refused preflight did not name the fix: $($claimedPreflight.Text)"

    # --- 7. Retirement refuses that same seat BEFORE a plan_id is issued ---------------------------
    $retireClaimed = Invoke-SeatRetirement @('-Seat', 'alpha', '-Preflight', '-Json')
    Assert-True ($retireClaimed.ExitCode -ne 0) 'a seat with a live session was planned for retirement'
    Assert-True (-not @(Get-PlanLines $retireClaimed).Count) "retirement issued a plan_id for a live-claimed seat: $($retireClaimed.Text)"
    Assert-True ($retireClaimed.Text.Contains('live session')) "the retirement refusal did not say why: $($retireClaimed.Text)"

    # The claim ends exactly when its holder lets go, which is what makes the plan body below
    # reachable at all -- and is why this is a fixture rather than a throwaway live seat.
    Exit-SeatClaim -Claim $claim
    $claims.Clear()
    Assert-True (-not (Test-SeatClaim -StateDirectory $stateDir -Seat 'alpha')) 'the claim outlived its holder'

    # --- 8. Retire-Seat's plan body: reached, and reading the NAMED seat's Desk --------------------
    $preflight = Invoke-SeatRetirement @('-Seat', 'alpha', '-Preflight', '-Json')
    Assert-True ($preflight.ExitCode -eq 0) "the retirement preflight failed: $($preflight.Text)"
    $plan = Get-ResultJson $preflight 'the retirement preflight'
    $planId = [string](Get-Field $plan 'plan_id' 'the retirement preflight')
    Assert-True ($planId -cmatch '^[0-9a-f]{16}$') "the plan_id is not a 16-character digest: '$planId'"
    Assert-Equal 'alpha-proj' ([string](Get-Field $plan 'project' 'the retirement preflight')) 'the plan named the wrong project'
    Assert-Equal 'shelf/alpha-book' ((@(Get-Field $plan 'open_books' 'the retirement preflight')) -join ',') 'the plan read the wrong seat''s open Books'
    Assert-Equal 'projects/alpha-proj' ((@(Get-Field $plan 'open_projects' 'the retirement preflight')) -join ',') 'the plan read the wrong seat''s open Projects'
    Assert-Equal 'True' ([string](Get-Field $plan 'recoverable' 'the retirement preflight')) 'retirement did not describe itself as recoverable'
    Assert-Equal 'False' ([string](Get-Field $plan 'shared_library_write' 'the retirement preflight')) 'retirement claimed a shared-collection write'
    $destination = [string](Get-Field $plan 'archive_destination' 'the retirement preflight')
    Assert-True ($destination.Replace('\', '/').Contains('internal/seat-archive/alpha-')) "the archive destination is not this seat's archive: $destination"

    # --- 9. The plan_id is bound to the Desk it planned --------------------------------------------
    # A seat whose Desk changed between preflight and approval invalidates the approval. Measured as
    # a CHANGED VALUE first, then as a refusal of the stale one.
    Set-FixtureDeskLines -StateDirectory $stateDir -Seat 'alpha' -Kind 'books' -Lines @('shelf/alpha-book', 'shelf/second-book') | Out-Null
    $fresh = Invoke-SeatRetirement @('-Seat', 'alpha', '-Preflight', '-Json')
    Assert-True ($fresh.ExitCode -eq 0) "the second retirement preflight failed: $($fresh.Text)"
    $freshPlan = Get-ResultJson $fresh 'the second retirement preflight'
    $freshId = [string](Get-Field $freshPlan 'plan_id' 'the second retirement preflight')
    Assert-True ($freshId -cne $planId) "the plan_id did not change when the Desk did: both were '$freshId'"
    Assert-Equal 'shelf/alpha-book,shelf/second-book' ((@(Get-Field $freshPlan 'open_books' 'the second retirement preflight')) -join ',') 'the second plan did not read the changed Desk'

    $stale = Invoke-SeatRetirement @('-Seat', 'alpha', '-UserConfirmed', '-ApprovedPlanId', $planId, '-Json')
    Assert-True ($stale.ExitCode -ne 0) 'a STALE plan_id retired a seat whose Desk had changed since it was approved'
    $unapproved = Invoke-SeatRetirement @('-Seat', 'alpha', '-Json')
    Assert-True ($unapproved.ExitCode -ne 0) 'a seat was retired with no approval at all'
    Assert-True ($unapproved.Text.Contains('-Preflight')) "the unapproved refusal did not name the route to approval: $($unapproved.Text)"
    $noId = Invoke-SeatRetirement @('-Seat', 'alpha', '-UserConfirmed', '-Json')
    Assert-True ($noId.ExitCode -ne 0) 'a seat was retired with -UserConfirmed and no plan_id'
    Assert-Equal 'aa-decoy=aa-decoy-proj,alpha=alpha-proj' (Get-RegistrySummary) 'a refused retirement still changed the registry'

    # --- 10. The Desk is ARCHIVED and RECOVERABLE, not discarded -----------------------------------
    $booksBefore = [string](Get-DeskText 'alpha' 'books')
    $projectsBefore = [string](Get-DeskText 'alpha' 'projects')
    $retired = Invoke-SeatRetirement @('-Seat', 'alpha', '-UserConfirmed', '-ApprovedPlanId', $freshId, '-Json')
    Assert-True ($retired.ExitCode -eq 0) "the approved retirement failed: $($retired.Text)"
    $retiredResult = Get-ResultJson $retired 'the retirement'
    Assert-Equal 'books,projects' ((@(Get-Field $retiredResult 'archived' 'the retirement')) -join ',') 'retirement did not archive both Desk files'
    Assert-Equal 'aa-decoy' ((@(Get-Field $retiredResult 'seats_remaining' 'the retirement')) -join ',') 'the seats remaining after retirement'
    $archiveDirectory = [string](Get-Field $retiredResult 'archive_directory' 'the retirement')
    Assert-True (Test-Path -LiteralPath $archiveDirectory -PathType Container) "the reported archive directory does not exist: $archiveDirectory"

    # RECOVERABLE means the bytes came back, not that a directory appeared. The archived Desk is read
    # through the same resolver production uses, so an archive written under a stale filename fails
    # here rather than merely looking present.
    foreach ($pair in @(@{ kind = 'books'; text = $booksBefore }, @{ kind = 'projects'; text = $projectsBefore })) {
        $archivedPath = Get-DeskFileInDirectory -DeskDirectory $archiveDirectory -Kind ([string]$pair.kind)
        Assert-True (Test-Path -LiteralPath $archivedPath -PathType Leaf) "the archived $($pair.kind) Desk file is missing from $archiveDirectory"
        Assert-Equal ([string]$pair.text) ([IO.File]::ReadAllText($archivedPath)) "the archived $($pair.kind) Desk did not come back byte-for-byte"
    }
    $seatRecord = (Get-Content -LiteralPath (Join-Path $archiveDirectory 'seat.json') -Raw) | ConvertFrom-Json
    Assert-Equal 'alpha' ([string](Get-Field $seatRecord 'seat' 'the archived seat record')) 'the archived record names the wrong seat'
    Assert-Equal 'alpha-proj' ([string](Get-Field $seatRecord 'project' 'the archived seat record')) 'the archived record names the wrong project'
    Assert-Equal 'shelf/alpha-book,shelf/second-book' ((@(Get-Field $seatRecord 'open_books' 'the archived seat record')) -join ',') 'the archived record lost what was open'

    # Nothing is removed until the archive is on disk and read back -- and then it IS removed.
    Assert-Equal 'aa-decoy=aa-decoy-proj' (Get-RegistrySummary) 'the registry after retiring alpha'
    Assert-True (-not (Test-Path -LiteralPath (Get-DeskStateDirectory -StateDirectory $stateDir -Seat 'alpha') -PathType Container)) 'the retired seat kept its Desk directory'
    # The decoy is untouched: retirement is one seat's operation, never the registry's.
    Assert-Equal 'shelf/decoy-book' ([string](Get-DeskText 'aa-decoy' 'books')).Trim() 'retiring one seat changed another seat''s Desk'

    # --- 10b. AN EMPTY DESK IS STILL A DESK --------------------------------------------------------
    # Until 2026-09-09 retiring one crashed twice on the way there, both times because an empty file's
    # byte[0] unrolls to $null when it travels a pipeline. Get-DeskMigrationPlan could not even
    # PREFLIGHT such a seat (case 4 above is that fault's guard, since alpha's Desk was still empty
    # when it ran), and the archive read-back died inside [Convert]::ToBase64String rather than
    # reporting on the archive it had just written. Neither fault leaves a missing file to notice.
    #
    # THE DESK IS EMPTIED HERE RATHER THAN LEFT EMPTY, since 2026-09-10. Creation now opens the new
    # seat's own Project Hub, so a brand-new seat is no longer this subject -- but a seat whose
    # entries have all been closed still is, and so is every seat created before that change. The
    # state is planted rather than closed through Set-VirtualDesk.ps1, which needs a live claim this
    # -NoLaunch run does not hold.
    $zeta = Start-Seat @('-Seat', 'zeta', '-Project', 'zeta-proj', '-NoLaunch', '-Json')
    Assert-True ($zeta.ExitCode -eq 0) "creating the empty-Desk seat failed: $($zeta.Text)"
    foreach ($kind in @('books', 'projects')) {
        [IO.File]::WriteAllText((Get-DeskFilePath -StateDirectory $stateDir -Seat 'zeta' -Kind $kind), '', $utf8)
    }
    $zetaPlan = Get-ResultJson (Invoke-SeatRetirement @('-Seat', 'zeta', '-Preflight', '-Json')) 'the empty-Desk retirement preflight'
    Assert-Equal '' ((@(Get-Field $zetaPlan 'open_books' 'the empty-Desk retirement preflight')) -join ',') 'an empty Desk did not plan as empty'
    $zetaId = [string](Get-Field $zetaPlan 'plan_id' 'the empty-Desk retirement preflight')
    $zetaRetired = Invoke-SeatRetirement @('-Seat', 'zeta', '-UserConfirmed', '-ApprovedPlanId', $zetaId, '-Json')
    Assert-True ($zetaRetired.ExitCode -eq 0) "retiring a seat with an empty Desk failed: $($zetaRetired.Text)"
    $zetaResult = Get-ResultJson $zetaRetired 'the empty-Desk retirement'
    Assert-Equal 'books,projects' ((@(Get-Field $zetaResult 'archived' 'the empty-Desk retirement')) -join ',') 'an empty Desk was not archived as two files'
    $zetaArchive = [string](Get-Field $zetaResult 'archive_directory' 'the empty-Desk retirement')
    foreach ($kind in @('books', 'projects')) {
        $emptyArchived = Get-DeskFileInDirectory -DeskDirectory $zetaArchive -Kind $kind
        Assert-True (Test-Path -LiteralPath $emptyArchived -PathType Leaf) "the archived empty $kind Desk file is missing from $zetaArchive"
        Assert-Equal '' ([IO.File]::ReadAllText($emptyArchived)) "the archived empty $kind Desk did not come back empty"
    }
    Assert-Equal 'aa-decoy=aa-decoy-proj' (Get-RegistrySummary) 'the registry after retiring the empty-Desk seat'

    # --- 11. Malformed, unknown and unparseable input FAIL CLOSED ----------------------------------
    $badSeat = Start-Seat @('-Seat', 'Alpha', '-Project', 'alpha-proj', '-NoLaunch', '-Json')
    Assert-True ($badSeat.ExitCode -ne 0) 'a MALFORMED seat name was accepted instead of refused'
    Assert-True ($badSeat.Text.Contains('malformed')) "the malformed-seat refusal did not say what was wrong: $($badSeat.Text)"
    $badProject = Start-Seat @('-Seat', 'delta', '-Project', 'Bad-Proj', '-NoLaunch', '-Json')
    Assert-True ($badProject.ExitCode -ne 0) 'a MALFORMED project slug was accepted instead of refused'
    Assert-True ($badProject.Text.Contains('malformed')) "the malformed-project refusal did not say what was wrong: $($badProject.Text)"
    Assert-Equal 'aa-decoy=aa-decoy-proj' (Get-RegistrySummary) 'a malformed request still changed the registry'

    # AN UNKNOWN SEAT MUST NOT FALL BACK TO THE ENVIRONMENT'S. LIBRARY_SEAT is set to the decoy for
    # exactly this call: a helper that resolved the environment's seat when the named one is unknown
    # would plan the retirement of a seat nobody asked for, and would look like a correct run doing
    # it. There is no default seat, and this is what that costs to prove.
    $env:LIBRARY_SEAT = 'aa-decoy'
    try { $unknown = Invoke-SeatRetirement @('-Seat', 'nosuchseat', '-Preflight', '-Json') }
    finally { $env:LIBRARY_SEAT = '' }
    Assert-True ($unknown.ExitCode -ne 0) 'an unknown seat was planned for retirement'
    Assert-True (-not @(Get-PlanLines $unknown).Count) "an unknown seat produced a retirement plan: $($unknown.Text)"
    Assert-True ($unknown.Text.Contains("There is no seat named 'nosuchseat'")) "the unknown-seat refusal did not name the seat asked for: $($unknown.Text)"
    Assert-True ($unknown.Text.Contains('Seats that exist: aa-decoy.')) "the unknown-seat refusal did not list the seats that exist: $($unknown.Text)"

    # A registry that cannot be parsed is REFUSED, never treated as empty. Treating it as empty is
    # the dangerous reading: a create would then rebind a project that already has a seat, and a
    # whole-tree reset would see no foreign seats at all.
    $registryPath = Get-SeatRegistryPath $stateDir
    $registryBytes = [IO.File]::ReadAllBytes($registryPath)
    try {
        [IO.File]::WriteAllText($registryPath, '{ not json', $utf8)
        $broken = Start-Seat @('-Seat', 'epsilon', '-Project', 'epsilon-proj', '-NoLaunch', '-Json')
        Assert-True ($broken.ExitCode -ne 0) 'a seat was created against a registry that could not be parsed'
        Assert-True ($broken.Text.Contains('not valid JSON')) "the unparseable-registry refusal did not name the cause: $($broken.Text)"
    }
    finally { [IO.File]::WriteAllBytes($registryPath, $registryBytes) }
    Assert-Equal 'aa-decoy=aa-decoy-proj' (Get-RegistrySummary) 'the registry did not survive the unparseable-registry case'

    # --- 12. THE BINDING, AND THE THIRD LIVENESS STATE (ADR-0018, plan step 3) ---------------------
    #
    # A REAL PROCESS STANDS IN FOR THE AGENT, never a fabricated PID. The whole rule under test is
    # "this PID, started at this moment, is still running", and a number nobody is running cannot
    # exercise either half of it. The dummy is spawned once, killed in this block, and killed again
    # in the suite's finally in case an assertion throws in between.
    #
    # Every case here reaches `orphaned` -- no live claim handle, a committed binding, and its agent
    # alive -- which is the state that did not exist before and reads as FREE to any Boolean probe.
    $bindingSeat = 'omega'
    $omega = Start-Seat @('-Seat', $bindingSeat, '-Project', 'omega-proj', '-NoLaunch', '-Json')
    Assert-True ($omega.ExitCode -eq 0) "creating the binding seat failed: $($omega.Text)"

    $dummy = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
    [void]$dummies.Add($dummy)
    $dummyIdentity = Get-AgentProcessIdentity -ProcessId $dummy.Id
    Assert-True (-not [string]::IsNullOrWhiteSpace($dummyIdentity)) 'the dummy agent process could not be identified, so nothing below tests what it claims to'
    Assert-True ($dummyIdentity -cne 'unreadable') 'the dummy agent process start time was unreadable, so the PID-reuse case below would pass vacuously'

    # A BINDING IS REGISTRY-LOCKED STATE. Falsified first: without the lock it must refuse, or every
    # assertion below is about a function that would answer anything to anyone.
    $unlockedBinding = $null
    try {
        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat $bindingSeat `
            -AgentProcessId $dummy.Id -AgentStartUtc $dummyIdentity -State 'committed' | Out-Null
    }
    catch { $unlockedBinding = [string]$_.Exception.Message }
    Assert-True ($null -ne $unlockedBinding) 'a seat binding was written with no registry lock held'
    Assert-True ($unlockedBinding -clike '*registry/Desk lock*') "the unlocked binding write failed for the wrong reason: $unlockedBinding"

    $bindingLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        # A PENDING binding leaves the seat FREE: it is provisional state belonging to an attempt
        # that has not committed, and a crashed attempt must not hold a seat forever.
        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat $bindingSeat `
            -AgentProcessId $dummy.Id -AgentStartUtc $dummyIdentity -SessionId 'conv-1' -State 'pending' | Out-Null
        Assert-Equal 'free' ([string](Get-SeatClaimState -StateDirectory $stateDir -Seat $bindingSeat -AgentProcessId 0).state) 'a PENDING binding made the seat non-free'

        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat $bindingSeat `
            -AgentProcessId $dummy.Id -AgentStartUtc $dummyIdentity -SessionId 'conv-1' -State 'committed' | Out-Null
    }
    finally { Exit-BookLock -Lock $bindingLock }

    $orphan = Get-SeatClaimState -StateDirectory $stateDir -Seat $bindingSeat -AgentProcessId 0
    Assert-Equal 'orphaned' ([string]$orphan.state) 'a committed binding with a live agent and no claim handle did not read as orphaned'
    Assert-Equal ([string]$dummy.Id) ([string]$orphan.agent_pid) 'the orphaned state named the wrong agent process'
    Assert-Equal 'conv-1' ([string]$orphan.session_id) 'the binding lost the conversation it was bound to'
    Assert-True (-not [bool]$orphan.this_agent) 'a binding for another process reported as THIS agent'
    Assert-True (-not [bool]$orphan.binding_stale) 'a binding whose agent is alive reported as stale'

    # TEST-SEATCLAIM STAYS BOOLEAN, which is the whole reason the three-state answer is a new
    # function: every `-not (Test-SeatClaim ...)` in this repository would otherwise stop working,
    # because in PowerShell 5.1 'free' is truthy.
    Assert-True ((Test-SeatClaim -StateDirectory $stateDir -Seat $bindingSeat) -is [bool]) 'Test-SeatClaim stopped returning a Boolean'
    Assert-True (-not (Test-SeatClaim -StateDirectory $stateDir -Seat $bindingSeat)) 'an orphaned seat read as claimed by the Boolean probe, which answers about the HANDLE'

    # THE MATRIX ROWS, THROUGH THE MATRIX. A mutator refuses an orphan and names the re-bind; the
    # same agent may restore it; another agent may not.
    Assert-Equal 'refuse' (Get-SeatStateDecision -Operation 'mutate' -State 'orphaned' -SameAgent $true) 'a mutator was allowed at an orphaned seat'
    Assert-Equal 'restore' (Get-SeatStateDecision -Operation 'enter' -State 'orphaned' -SameAgent $true) 'the same agent could not restore its own orphaned seat'
    Assert-Equal 'refuse' (Get-SeatStateDecision -Operation 'enter' -State 'orphaned' -SameAgent $false) 'another agent was allowed into an orphaned seat'
    Assert-Equal 'refuse' (Get-SeatStateDecision -Operation 'retire' -State 'orphaned') 'an orphaned seat was retireable'
    # And every state of every operation is covered, so no consumer can meet an unruled combination.
    foreach ($operation in @('enter', 'mutate', 'retire', 'sweep')) {
        foreach ($state in @('free', 'held', 'orphaned')) {
            foreach ($same in @($true, $false)) {
                Assert-True (@('allow', 'refuse', 'no-op', 'restore', 'skip') -ccontains (Get-SeatStateDecision -Operation $operation -State $state -SameAgent $same)) "the matrix has no rule for $operation at a $state seat (same agent: $same)"
            }
        }
    }
    # THE SWEEP ROW-SET, PINNED BOTH WAYS (ADR-0023). A guard that pins only the positive stays green
    # when a recognised state goes blind, and `skip` is deliberately not `refuse`: a sweep names the
    # busy seat and carries on rather than aborting the run over it.
    Assert-Equal 'allow' (Get-SeatStateDecision -Operation 'sweep' -State 'free') 'the matrix will not sweep an idle seat'
    Assert-Equal 'skip' (Get-SeatStateDecision -Operation 'sweep' -State 'held') 'the matrix does not skip a held seat in a sweep'
    Assert-Equal 'skip' (Get-SeatStateDecision -Operation 'sweep' -State 'orphaned') 'the matrix does not skip an orphaned seat in a sweep'

    # --- 12b. THE SWEEP PREDICATE, AND THE ORDER OF ITS TESTS (ADR-0023) --------------------------
    #
    # SEVEN ROWS, NOT THREE. The predicate classifies a set, and with two rows per bucket a
    # truncation puts one in the right bucket and loses the other invisibly. Four of these are
    # ORDERING GUARDS: a predicate that probed the claim before asking about the incarnation answers
    # `allow`/`idle` for rows E, F and G -- a retired incarnation is -WholeTree's alone and an
    # unaccounted one is refused outright, and NEITHER is decidable from a claim state -- and answers
    # `skip` for row A, which is the acting seat's own material.
    #
    # `aa-decoy` IS THE ROW THAT MUST SURVIVE. Every negative below is followed by re-asking about it,
    # because a predicate that skipped everything would satisfy an assertion made against an empty
    # list. It is also the PRE-IDENTITY incarnation -- Initialize-SeatForFixture writes no `seat_id`
    # -- so row B is the case that breaks if '' is ever treated as "unknown" rather than as a real
    # incarnation, and row G is the case that breaks if it is treated as a wildcard.
    $sweepRegistry = Read-SeatRegistry -StateDirectory $stateDir
    $sweepRetirements = @((Read-SeatRetirementRecords -Workspace $fixture).records)
    $omegaId = Get-SeatEntryIncarnation -Entry (Get-SeatEntry -Registry $sweepRegistry -Seat $bindingSeat)
    Assert-True (-not [string]::IsNullOrWhiteSpace($omegaId)) 'the binding seat carries no incarnation id, so every comparison below would be against an empty string'
    $decoyId = Get-SeatEntryIncarnation -Entry (Get-SeatEntry -Registry $sweepRegistry -Seat 'aa-decoy')
    Assert-Equal '' $decoyId 'the decoy seat gained an incarnation id, so the pre-identity cases below no longer test what they claim to'
    $zetaOldId = [string](@(@($sweepRetirements) | Where-Object { [string]$_.seat -ceq 'zeta' }) | Select-Object -First 1).seat_id
    Assert-True (-not [string]::IsNullOrWhiteSpace($zetaOldId)) 'the retired seat archive carries no incarnation id, so the retired-row case below would compare two empty strings'

    # A. THE ACTING SEAT IS ANSWERED FIRST AND IS NOT PROBED. omega is ORPHANED here, so a predicate
    # that consulted the matrix before asking "is this mine" skips the one seat whose held claim IS
    # the authorisation.
    $sweepActing = Get-SeatSweepDisposition -StateDirectory $stateDir -Registry $sweepRegistry -Retirements $sweepRetirements `
        -Seat $bindingSeat -SeatId $omegaId -ActingSeat $bindingSeat -ActingSeatId $omegaId -AgentProcessId 0
    Assert-Equal 'allow' ([string]$sweepActing.decision) 'a sweep would not take the acting seat''s own topic'
    Assert-Equal 'acting-seat' ([string]$sweepActing.reason) 'the acting seat''s own topic was allowed for the wrong reason'
    Assert-Equal 'not-probed' ([string]$sweepActing.claim_state) 'the acting seat was probed, so a claim state was reported that the rule never consulted'

    # B. AN IDLE, REGISTERED, PRE-IDENTITY SEAT IS SWEPT.
    $sweepIdle = Get-SeatSweepDisposition -StateDirectory $stateDir -Registry $sweepRegistry -Retirements $sweepRetirements `
        -Seat 'aa-decoy' -SeatId '' -ActingSeat $bindingSeat -ActingSeatId $omegaId -AgentProcessId 0
    Assert-Equal 'allow' ([string]$sweepIdle.decision) 'a sweep would not take an IDLE foreign seat''s topic, which is the whole operation'
    Assert-Equal 'idle' ([string]$sweepIdle.reason) 'an idle foreign seat was allowed for the wrong reason'
    Assert-Equal 'free' ([string]$sweepIdle.claim_state) 'the idle seat did not report the claim state the decision was made on'
    Assert-Equal 'live' ([string]$sweepIdle.incarnation_status) 'a pre-identity incarnation that the registry names did not read as live'

    # C. THE SAME SEAT, HELD: the answer must move with the probe rather than being a constant.
    # NOT ADDED TO $claims: it is released in the finally below, and a stale entry in that list would
    # have the suite's own cleanup try to delete the claim file a LATER case legitimately holds.
    $sweepDecoyClaim = Enter-SeatClaim -StateDirectory $stateDir -Seat 'aa-decoy'
    try {
        $sweepHeld = Get-SeatSweepDisposition -StateDirectory $stateDir -Registry $sweepRegistry -Retirements $sweepRetirements `
            -Seat 'aa-decoy' -SeatId '' -ActingSeat $bindingSeat -ActingSeatId $omegaId -AgentProcessId 0
        Assert-Equal 'skip' ([string]$sweepHeld.decision) 'a sweep would take the topics of a seat with a LIVE SESSION'
        Assert-Equal 'live-session' ([string]$sweepHeld.reason) 'a held seat was skipped for the wrong reason'
        Assert-Equal 'held' ([string]$sweepHeld.claim_state) 'the held seat did not report the claim state the decision was made on'
    }
    finally { Exit-SeatClaim -Claim $sweepDecoyClaim }

    # D. ORPHANED IS NOT IDLE, which is the whole reason the predicate keys on Get-SeatClaimState
    # rather than on the Boolean probe: Test-SeatClaim answers $false here, and its agent is working.
    $sweepOrphan = Get-SeatSweepDisposition -StateDirectory $stateDir -Registry $sweepRegistry -Retirements $sweepRetirements `
        -Seat $bindingSeat -SeatId $omegaId -ActingSeat 'aa-decoy' -ActingSeatId '' -AgentProcessId 0
    Assert-Equal 'skip' ([string]$sweepOrphan.decision) 'a sweep would take the topics of an ORPHANED seat whose agent is still running'
    Assert-Equal 'lost-holder' ([string]$sweepOrphan.reason) 'an orphaned seat was skipped for the wrong reason'
    Assert-Equal 'orphaned' ([string]$sweepOrphan.claim_state) 'the orphaned seat did not report the claim state the decision was made on'
    Assert-True (-not (Test-SeatClaim -StateDirectory $stateDir -Seat $bindingSeat)) 'the orphaned seat stopped reading FREE to the Boolean probe, so row D no longer tests the predicate the obvious implementation would have used'

    # E. A RETIRED INCARNATION IS -WholeTree'S ALONE (ADR-0016), and its seat directory is gone -- so
    # the claim probe reads FREE and a probe-first predicate sweeps it.
    $sweepRetired = Get-SeatSweepDisposition -StateDirectory $stateDir -Registry $sweepRegistry -Retirements $sweepRetirements `
        -Seat 'zeta' -SeatId $zetaOldId -ActingSeat $bindingSeat -ActingSeatId $omegaId -AgentProcessId 0
    Assert-Equal 'skip' ([string]$sweepRetired.decision) 'a sweep took a RETIRED incarnation''s topic, which is a whole-tree reset''s alone'
    Assert-Equal 'retired-incarnation' ([string]$sweepRetired.reason) 'a retired incarnation was skipped for the wrong reason'
    Assert-Equal 'free' ([string](Get-SeatClaimState -StateDirectory $stateDir -Seat 'zeta' -AgentProcessId 0).state) 'the retired seat stopped reading FREE, so row E no longer proves the incarnation question is asked before the probe'

    # F. AN UNACCOUNTED INCARNATION IS REFUSED, NOT SWEPT. No registry entry and no archive record,
    # which is what a hand-deleted seat directory leaves -- the 2026-09-10 data-loss family.
    $sweepGhost = Get-SeatSweepDisposition -StateDirectory $stateDir -Registry $sweepRegistry -Retirements $sweepRetirements `
        -Seat 'ghostseat' -SeatId 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0' -ActingSeat $bindingSeat -ActingSeatId $omegaId -AgentProcessId 0
    Assert-Equal 'skip' ([string]$sweepGhost.decision) 'a sweep took material whose owning incarnation nothing can account for'
    Assert-Equal 'unaccounted-incarnation' ([string]$sweepGhost.reason) 'an unaccounted incarnation was skipped for the wrong reason'
    Assert-True ([string]$sweepGhost.note -clike '*Set-NotebookTopicOwner*') "the unaccounted skip did not name a route that clears it: $([string]$sweepGhost.note)"

    # G. AN EMPTY INCARNATION IS NOT A WILDCARD. omega HAS an id, so a row naming omega with none is
    # a different incarnation and nothing accounts for it -- and a comparison that let '' match
    # anything would answer `lost-holder` here instead, from omega's live agent.
    $sweepEmptyId = Get-SeatSweepDisposition -StateDirectory $stateDir -Registry $sweepRegistry -Retirements $sweepRetirements `
        -Seat $bindingSeat -SeatId '' -ActingSeat 'aa-decoy' -ActingSeatId '' -AgentProcessId 0
    Assert-Equal 'skip' ([string]$sweepEmptyId.decision) 'a row naming a pre-identity incarnation of a seat that HAS one was swept'
    Assert-Equal 'unaccounted-incarnation' ([string]$sweepEmptyId.reason) 'an empty incarnation matched a registry entry that carries one, so '''' is being read as a wildcard'

    # THE DECOY SURVIVED ALL OF IT. Re-asked after every negative above, because an assertion made
    # against an empty list passes for a predicate that skips everything.
    $sweepStillIdle = Get-SeatSweepDisposition -StateDirectory $stateDir -Registry $sweepRegistry -Retirements $sweepRetirements `
        -Seat 'aa-decoy' -SeatId '' -ActingSeat $bindingSeat -ActingSeatId $omegaId -AgentProcessId 0
    Assert-Equal 'allow' ([string]$sweepStillIdle.decision) 'the idle decoy stopped being sweepable after the negative cases, so those cases pass for a predicate that skips everything'

    # EVERY RULE CARRIES THE SENTENCE A PREFLIGHT SHOWS. Deliberately NOT a "the reasons are all
    # distinct" count beside it: every reason above is already asserted by name, so such a count
    # could never fail while those pass -- a second guard on one property is how the load-bearing one
    # comes to be deleted without anything going red.
    foreach ($sweepRow in @($sweepActing, $sweepIdle, $sweepOrphan, $sweepRetired, $sweepGhost, $sweepEmptyId)) {
        Assert-True (-not [string]::IsNullOrWhiteSpace([string]$sweepRow.note)) "the sweep disposition '$([string]$sweepRow.reason)' carries no note, so a preflight has nothing to show the reader"
    }

    $orphanMutation = $null
    try { Assert-SeatClaimHeld -StateDirectory $stateDir -Seat $bindingSeat -Token ('0' * 32) -AgentProcessId 0 | Out-Null }
    catch { $orphanMutation = [string]$_.Exception.Message }
    Assert-True ($null -ne $orphanMutation) 'a mutation was admitted at an orphaned seat'
    Assert-True ($orphanMutation.Contains('Re-bind it')) "the orphaned refusal did not name the re-bind: $orphanMutation"
    Assert-True ($orphanMutation.Contains([string]$dummy.Id)) "the orphaned refusal did not name the live agent process: $orphanMutation"

    # RETIREMENT AND THE LAUNCHER, THROUGH THE REAL HELPERS AS PROCESSES. Both used to read an
    # orphaned seat as free: retirement would have made a live agent's material whole-tree eligible,
    # and the launcher would have handed a second agent a seat the first one still holds.
    $retireOrphan = Invoke-SeatRetirement @('-Seat', $bindingSeat, '-Preflight', '-Json')
    Assert-True ($retireOrphan.ExitCode -ne 0) 'an ORPHANED seat was planned for retirement'
    Assert-True (-not @(Get-PlanLines $retireOrphan).Count) "retirement issued a plan_id for an orphaned seat: $($retireOrphan.Text)"
    Assert-True ($retireOrphan.Text.Contains('still running')) "the orphaned retirement refusal did not say why: $($retireOrphan.Text)"
    $enterOrphan = Start-Seat @('-Seat', $bindingSeat, '-Project', 'omega-proj', '-NoLaunch', '-Json')
    Assert-True ($enterOrphan.ExitCode -ne 0) 'a second agent was let into an ORPHANED seat'
    Assert-True ($enterOrphan.Text.Contains('claim holder is gone')) "the orphaned entry refusal did not distinguish itself from a free seat: $($enterOrphan.Text)"

    # THE SAME AGENT IS RECOGNISED, which is what makes the restore row reachable.
    $mine = Get-SeatClaimState -StateDirectory $stateDir -Seat $bindingSeat -AgentProcessId $dummy.Id
    Assert-True ([bool]$mine.this_agent) 'the binding did not recognise its own agent process'

    # A LIVE HANDLE OVER A BINDING IS `held`, not orphaned: the handle is the liveness half.
    $omegaClaim = Enter-SeatClaim -StateDirectory $stateDir -Seat $bindingSeat
    [void]$claims.Add($omegaClaim)
    Assert-Equal 'held' ([string](Get-SeatClaimState -StateDirectory $stateDir -Seat $bindingSeat -AgentProcessId 0).state) 'a live claim handle over a committed binding did not read as held'
    Exit-SeatClaim -Claim $omegaClaim
    Assert-Equal 'orphaned' ([string](Get-SeatClaimState -StateDirectory $stateDir -Seat $bindingSeat -AgentProcessId 0).state) 'releasing the handle over a live binding did not return the seat to orphaned'

    # A COMMITTED BINDING IS NOT OVERWRITTEN OR REMOVED WHILE ITS AGENT LIVES. That refusal is the
    # protection recovery rests on: a rewrite would erase the identity that makes a re-bind safe.
    $overwrite = $null
    $removeLive = $null
    $staleLie = $null
    $liveBindingLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        try {
            Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat $bindingSeat `
                -AgentProcessId $PID -State 'committed' | Out-Null
        }
        catch { $overwrite = [string]$_.Exception.Message }
        try { Remove-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat $bindingSeat | Out-Null }
        catch { $removeLive = [string]$_.Exception.Message }
        try { Remove-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat $bindingSeat -Stale | Out-Null }
        catch { $staleLie = [string]$_.Exception.Message }
    }
    finally { Exit-BookLock -Lock $liveBindingLock }
    Assert-True ($null -ne $overwrite -and $overwrite.Contains('still running')) "a committed binding was overwritten while its agent was alive: $overwrite"
    Assert-True ($null -ne $removeLive -and $removeLive.Contains('still running')) "a committed binding was removed while its agent was alive: $removeLive"
    Assert-True ($null -ne $staleLie -and $staleLie.Contains('not stale')) "a LIVE binding was cleared as stale: $staleLie"

    # A REUSED PID NEITHER INHERITS NOR ENDS A CLAIM. Same PID, a start time one second earlier: the
    # process exists, and it is not the process the binding names.
    $wrongStart = ([DateTime]::Parse($dummyIdentity).ToUniversalTime().AddSeconds(-1)).ToString('o')
    $reuseLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat $bindingSeat `
            -AgentProcessId $dummy.Id -AgentStartUtc $wrongStart -State 'committed' | Out-Null
    }
    finally { Exit-BookLock -Lock $reuseLock }
    $reused = Get-SeatClaimState -StateDirectory $stateDir -Seat $bindingSeat -AgentProcessId 0
    Assert-Equal 'free' ([string]$reused.state) 'a binding whose PID was reused by a DIFFERENT process still held the seat'
    Assert-True ([bool]$reused.binding_stale) 'a binding naming a different process at the same PID did not report as stale'

    # AND A DEAD AGENT'S BINDING IS STALE, so the seat is free and retirement works again.
    Stop-Process -Id $dummy.Id -Force -ErrorAction SilentlyContinue
    $dummy.WaitForExit(10000) | Out-Null
    $deadLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat $bindingSeat `
            -AgentProcessId $dummy.Id -AgentStartUtc $dummyIdentity -State 'committed' | Out-Null
        Assert-Equal 'free' ([string](Get-SeatClaimState -StateDirectory $stateDir -Seat $bindingSeat -AgentProcessId 0).state) 'a committed binding whose agent is gone still held the seat'
        Assert-True (Remove-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat $bindingSeat -Stale) 'a stale binding could not be cleared'
    }
    finally { Exit-BookLock -Lock $deadLock }
    Assert-True ($null -eq (Read-SeatBinding -StateDirectory $stateDir -Seat $bindingSeat)) 'the stale binding survived being cleared'

    # AN UNPARSEABLE BINDING FAILS CLOSED, never as absent: absent is the dangerous reading, because
    # it makes an occupied seat look free.
    [IO.File]::WriteAllText((Get-SeatBindingPath -StateDirectory $stateDir -Seat $bindingSeat), '{ not json', $utf8)
    $brokenBinding = $null
    try { Get-SeatClaimState -StateDirectory $stateDir -Seat $bindingSeat -AgentProcessId 0 | Out-Null }
    catch { $brokenBinding = [string]$_.Exception.Message }
    Assert-True ($null -ne $brokenBinding -and $brokenBinding.Contains('not valid JSON')) "an unparseable binding was not refused: $brokenBinding"
    Remove-Item -LiteralPath (Get-SeatBindingPath -StateDirectory $stateDir -Seat $bindingSeat) -Force
    # --- 13. WHICH SEAT A CALL IS ABOUT, AND WHAT PROVES IT (ADR-0018, plan steps 5 and 6) ---------
    #
    # A SECOND REAL PROCESS, for the reason case 12 spawns the first: the binding route compares a
    # recorded start time against the process now at that PID, and a fabricated number exercises
    # neither side of that comparison.
    #
    # EVERY ASSERTION HERE READS A SEAT NAME, never merely that something was refused. Two seats
    # exist in this fixture with bindings in play, so an implementation that resolved the FIRST
    # registry entry, or the LIBRARY_SEAT it was handed, answers with a wrong name rather than with
    # a missing file.
    $resolveSeat = 'sigma'
    $sigma = Start-Seat @('-Seat', $resolveSeat, '-Project', 'sigma-proj', '-NoLaunch', '-Json')
    Assert-True ($sigma.ExitCode -eq 0) "creating the resolution seat failed: $($sigma.Text)"

    $agent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
    [void]$dummies.Add($agent)
    $agentIdentity = Get-AgentProcessIdentity -ProcessId $agent.Id
    Assert-True ($agentIdentity -cne 'unreadable' -and -not [string]::IsNullOrWhiteSpace($agentIdentity)) 'the resolution agent had no readable start time, so the reused-PID case below would pass vacuously'

    # THE ENVIRONMENT ANSWERS ONLY WHILE THIS PROCESS HOLDS NO BINDING, and it says so.
    $env:LIBRARY_SEAT = 'aa-decoy'
    $viaEnvironment = Resolve-SeatName -StateDirectory $stateDir -AgentProcessId $agent.Id
    Assert-Equal 'named' ([string](Get-Field $viaEnvironment 'status' 'the environment resolution')) 'LIBRARY_SEAT did not resolve with no binding present'
    Assert-Equal 'aa-decoy' ([string]$viaEnvironment.seat) 'the environment resolution named the wrong seat'
    Assert-Equal 'environment' ([string](Get-Field $viaEnvironment 'source' 'the environment resolution')) 'an environment resolution did not report its source'

    $resolveLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat $resolveSeat `
            -AgentProcessId $agent.Id -AgentStartUtc $agentIdentity -SessionId 'conv-sigma' -State 'committed' | Out-Null
    }
    finally { Exit-BookLock -Lock $resolveLock }

    # A BINDING AND A DISAGREEING LIBRARY_SEAT ARE A REFUSAL NAMING BOTH. Not a preference for the
    # binding, and above all not a preference for the environment: a stale inherited value would
    # otherwise read one seat's Desk while every write refused at another.
    $disagreement = Resolve-SeatName -StateDirectory $stateDir -AgentProcessId $agent.Id
    Assert-True ([string]$disagreement.status -cne 'named') "a binding at '$resolveSeat' and LIBRARY_SEAT at 'aa-decoy' resolved to '$([string]$disagreement.seat)' instead of refusing"
    Assert-True ([string]$disagreement.message -clike "*'$resolveSeat'*") "the disagreement refusal did not name the bound seat: $([string]$disagreement.message)"
    Assert-True ([string]$disagreement.message -clike "*'aa-decoy'*") "the disagreement refusal did not name the environment seat: $([string]$disagreement.message)"
    # AND IT REACHES THE CONSUMERS, which is the half a resolver-only test cannot see: every guard,
    # hook and helper asks for its Desk through this function.
    $deskRefusal = $null
    try { Get-DeskStateDirectory -StateDirectory $stateDir -AgentProcessId $agent.Id | Out-Null }
    catch { $deskRefusal = [string]$_.Exception.Message }
    Assert-True ($null -ne $deskRefusal -and $deskRefusal -clike "*'aa-decoy'*") "a Desk was resolved despite the binding and LIBRARY_SEAT disagreeing: $deskRefusal"

    # WITH THE ENVIRONMENT SILENT, THE BINDING ANSWERS -- and the Desk that comes back is the bound
    # seat's, not the first seat on disk.
    $env:LIBRARY_SEAT = ''
    $viaBinding = Resolve-SeatName -StateDirectory $stateDir -AgentProcessId $agent.Id
    Assert-Equal 'named' ([string]$viaBinding.status) 'a committed binding for this process did not resolve'
    Assert-Equal $resolveSeat ([string]$viaBinding.seat) 'the binding resolution named the wrong seat'
    Assert-Equal 'binding' ([string]$viaBinding.source) 'a binding resolution did not report its source'
    # AND THE DESK THAT COMES BACK IS THE BOUND SEAT'S. This is the assertion the resolver alone
    # cannot make: every guard, hook and helper asks for its Desk here, and 'aa-decoy' is planted at
    # the first registry entry, which is exactly where a wrong implementation would look.
    Assert-Equal (Join-Path (Get-SeatsDirectory $stateDir) $resolveSeat) `
        (Get-DeskStateDirectory -StateDirectory $stateDir -AgentProcessId $agent.Id) `
        'the Desk directory did not follow the binding'

    # AN EXPLICIT SEAT BEATS THE BINDING, which is what keeps every cross-seat sweep able to name one.
    $viaExplicit = Resolve-SeatName -Seat 'aa-decoy' -StateDirectory $stateDir -AgentProcessId $agent.Id
    Assert-Equal 'aa-decoy' ([string]$viaExplicit.seat) 'an explicit -Seat lost to the binding'
    Assert-Equal 'explicit' ([string]$viaExplicit.source) 'an explicit resolution did not report its source'

    # IDENTITY IS PROOF ENOUGH FOR A MUTATION, with a DECOY token that matches nothing: the only
    # thing that can admit this call is the binding naming this agent at a seat whose handle is live.
    $sigmaClaim = Enter-SeatClaim -StateDirectory $stateDir -Seat $resolveSeat
    [void]$claims.Add($sigmaClaim)
    Assert-Equal 'held' ([string](Get-SeatClaimState -StateDirectory $stateDir -Seat $resolveSeat -AgentProcessId $agent.Id).state) 'a live handle over a committed binding did not read as held'
    Assert-True (Assert-SeatClaimHeld -StateDirectory $stateDir -Seat $resolveSeat -Token ('0' * 32) -AgentProcessId $agent.Id) 'the bound agent was refused its own held seat with no token'

    # AND A REUSED PID IS NOT THAT AGENT. Same number, a start time one second earlier: the handle is
    # still live and still held by the real session, so identity is the only thing standing between a
    # recycled PID and another agent's Desk. Until 2026-09-09 `this_agent` compared the NUMBER alone
    # and this call was admitted.
    $reuseStart = ([DateTime]::Parse($agentIdentity).ToUniversalTime().AddSeconds(-1)).ToString('o')
    $reuseLock2 = Enter-SeatRegistryLock -Workspace $fixture
    try {
        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat $resolveSeat `
            -AgentProcessId $agent.Id -AgentStartUtc $reuseStart -SessionId 'conv-sigma' -State 'committed' | Out-Null
    }
    finally { Exit-BookLock -Lock $reuseLock2 }
    $reusedState = Get-SeatClaimState -StateDirectory $stateDir -Seat $resolveSeat -AgentProcessId $agent.Id
    Assert-Equal 'held' ([string]$reusedState.state) 'the live handle disappeared, so the reused-PID mutation below would refuse for the wrong reason'
    Assert-True (-not [bool]$reusedState.this_agent) 'a binding whose recorded start time names a DIFFERENT process reported as THIS agent'
    $reusedMutation = $null
    try { Assert-SeatClaimHeld -StateDirectory $stateDir -Seat $resolveSeat -Token ('0' * 32) -AgentProcessId $agent.Id | Out-Null }
    catch { $reusedMutation = [string]$_.Exception.Message }
    Assert-True ($null -ne $reusedMutation) 'a reused PID inherited a live agent''s claim on identity alone'
    # AND IT DOES NOT RESOLVE EITHER: a binding naming a different process binds nothing.
    $reusedResolution = Resolve-SeatName -StateDirectory $stateDir -AgentProcessId $agent.Id
    Assert-Equal 'unset' ([string]$reusedResolution.status) 'a binding whose PID was reused by a different process still resolved a seat'

    # ONE AGENT, ONE SEAT: a mutation at a seat this agent is NOT bound to names the seat it IS bound
    # to. "Another session is working that seat" would send a reader to start a session it has.
    $elsewhereLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat $resolveSeat `
            -AgentProcessId $agent.Id -AgentStartUtc $agentIdentity -SessionId 'conv-sigma' -State 'committed' | Out-Null
    }
    finally { Exit-BookLock -Lock $elsewhereLock }
    $decoyClaim = Enter-SeatClaim -StateDirectory $stateDir -Seat 'aa-decoy'
    [void]$claims.Add($decoyClaim)
    $wrongSeat = $null
    try { Assert-SeatClaimHeld -StateDirectory $stateDir -Seat 'aa-decoy' -Token ('0' * 32) -AgentProcessId $agent.Id | Out-Null }
    catch { $wrongSeat = [string]$_.Exception.Message }
    Assert-True ($null -ne $wrongSeat) 'an agent bound to one seat was admitted at another'
    Assert-True ($wrongSeat -clike "*'$resolveSeat'*") "the wrong-seat refusal did not name the seat this agent is bound to: $wrongSeat"
    Exit-SeatClaim -Claim $decoyClaim

    # AN UNREADABLE BINDING REFUSES AND MUST NOT FALL THROUGH TO LIBRARY_SEAT. This is its OWN route
    # to the resolver going blind, and it is the dangerous one: treating "I cannot read it" as "there
    # is none" answers with the environment, which is a seat, which is a Desk. LIBRARY_SEAT names the
    # decoy here precisely so a fall-through resolves a WRONG seat rather than resolving nothing.
    $env:LIBRARY_SEAT = 'aa-decoy'
    [IO.File]::WriteAllText((Get-SeatBindingPath -StateDirectory $stateDir -Seat $resolveSeat), '{ not json', $utf8)
    $unreadable = Resolve-SeatName -StateDirectory $stateDir -AgentProcessId $agent.Id
    Assert-Equal 'malformed' ([string]$unreadable.status) 'an unreadable binding fell through to LIBRARY_SEAT instead of refusing'
    Assert-True ([string]$unreadable.message -clike '*not valid JSON*') "the unreadable-binding refusal did not say what could not be read: $([string]$unreadable.message)"
    Assert-True ([string]$unreadable.message -cnotlike '*aa-decoy*') "an unreadable binding resolved the environment's seat anyway: $([string]$unreadable.message)"
    # AND THE REFUSAL IS ABOUT THE RECORD, not a state the seat is now stuck in.
    Remove-Item -LiteralPath (Get-SeatBindingPath -StateDirectory $stateDir -Seat $resolveSeat) -Force
    Assert-Equal 'aa-decoy' ([string](Resolve-SeatName -StateDirectory $stateDir -AgentProcessId $agent.Id).seat) 'removing the unreadable binding did not return the resolver to the environment'
    $env:LIBRARY_SEAT = ''

    # SIGMA'S BINDING BACK, because the two-seat case below needs one to be the second of.
    $restoreLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat $resolveSeat `
            -AgentProcessId $agent.Id -AgentStartUtc $agentIdentity -SessionId 'conv-sigma' -State 'committed' | Out-Null
    }
    finally { Exit-BookLock -Lock $restoreLock }

    # TWO SEATS FOR ONE AGENT IS CORRUPT STATE AND FAILS CLOSED, rather than one of them being
    # picked: a resolver that chose either would put half the system on a Desk the other half
    # disagrees with.
    $doubleLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat 'aa-decoy' `
            -AgentProcessId $agent.Id -AgentStartUtc $agentIdentity -State 'committed' | Out-Null
    }
    finally { Exit-BookLock -Lock $doubleLock }
    $doubleBound = Resolve-SeatName -StateDirectory $stateDir -AgentProcessId $agent.Id
    Assert-Equal 'malformed' ([string]$doubleBound.status) 'an agent bound to TWO seats resolved to one of them'
    foreach ($both in @('aa-decoy', $resolveSeat)) {
        Assert-True ([string]$doubleBound.message -clike "*$both*") "the two-seat refusal did not name '$both': $([string]$doubleBound.message)"
    }
    # CLEARED BY DELETING THE FILE, not through Remove-SeatBinding: this agent is ALIVE, so both the
    # ordinary and the -Stale removal correctly refuse, which case 12 already proves. Corrupt state
    # planted by a fixture is cleaned up by the fixture.
    Remove-Item -LiteralPath (Get-SeatBindingPath -StateDirectory $stateDir -Seat 'aa-decoy') -Force
    Assert-Equal $resolveSeat ([string](Resolve-SeatName -StateDirectory $stateDir -AgentProcessId $agent.Id).seat) 'clearing the second binding did not restore a single resolution'

    Stop-Process -Id $agent.Id -Force -ErrorAction SilentlyContinue

    # --- 14. THE CLAIM HOLDER AND THE READINESS HANDSHAKE (plan step 4) ---------------------------
    #
    # THE HOLDER IS A REAL SPAWNED PROCESS HERE, because the property under test is that something
    # outlives this call and dies with the agent. A stubbed holder proves the helper's arithmetic and
    # nothing about the mechanism.
    #
    # A SECOND FIXTURE SEAT IS CREATED FIRST, which is also the guard for a fixture defect found on
    # 2026-09-09: Initialize-SeatForFixture wrote the registry only when the file did not exist, so a
    # second call left a seat with a Desk on disk and no registry entry -- a shape production cannot
    # produce, which made a helper answer "there is no seat named tau" about a seat that was right
    # there.
    $handshakeState = Join-Path $fixture 'handshake/.claude'
    New-Item -ItemType Directory -Path $handshakeState -Force | Out-Null
    $handshakeWorkspace = Join-Path $fixture 'handshake'
    Initialize-SeatForFixture -StateDirectory $handshakeState -Seat 'tau' -Project 'tau-proj' | Out-Null
    Initialize-SeatForFixture -StateDirectory $handshakeState -Seat 'upsilon' -Project 'upsilon-proj' | Out-Null
    $handshakeRegistry = @((Read-SeatRegistry -StateDirectory $handshakeState).seats | ForEach-Object { [string]$_.seat } | Sort-Object -CaseSensitive)
    Assert-Equal 'tau upsilon' ($handshakeRegistry -join ' ') 'a fixture seat was created on disk without a registry entry'

    $holderAgent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
    [void]$dummies.Add($holderAgent)
    $holderIdentity = Get-AgentProcessIdentity -ProcessId $holderAgent.Id
    Assert-True ($holderIdentity -cne 'unreadable' -and -not [string]::IsNullOrWhiteSpace($holderIdentity)) 'the handshake agent had no readable start time'

    # AN ATTEMPT IS REGISTRY-LOCKED STATE. Falsified first, or everything below is about a record
    # anything could write at any time.
    $unlockedAttempt = $null
    try {
        Write-SeatHolderAttempt -Workspace $handshakeWorkspace -StateDirectory $handshakeState -Seat 'tau' `
            -AttemptId ('a' * 32) -DeadlineUtc ([DateTime]::UtcNow.ToString('o')) -State 'pending' | Out-Null
    }
    catch { $unlockedAttempt = [string]$_.Exception.Message }
    Assert-True ($null -ne $unlockedAttempt -and $unlockedAttempt -clike '*registry/Desk lock*') "a holder attempt was written with no registry lock held: $unlockedAttempt"

    # THE BINDING COMMITS BEFORE THE ATTEMPT, read off the code rather than inferred from behaviour.
    # Round 4 of review found the crash window between these two writes and nothing else; the order is
    # the fix, so the order is what is pinned. The behavioural half is the case below it.
    $completeAst = [Management.Automation.Language.Parser]::ParseInput(
        [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'LibrarySeat.ps1')), [ref]$null, [ref]$null)
    $completeFn = @($completeAst.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] }, $true) |
        Where-Object { $_.Name -ceq 'Complete-SeatClaimHolder' })
    Assert-True ($completeFn.Count -eq 1) 'Complete-SeatClaimHolder is not defined exactly once, so its write order cannot be read'
    $completeCalls = @($completeFn[0].FindAll({ $args[0] -is [Management.Automation.Language.CommandAst] }, $true) |
        ForEach-Object { [string]$_.GetCommandName() } | Where-Object { $_ -cin @('Write-SeatBinding', 'Write-SeatHolderAttempt') })
    Assert-Equal 'Write-SeatBinding Write-SeatHolderAttempt' ($completeCalls -join ' ') 'Complete-SeatClaimHolder no longer commits the binding before the attempt'

    # THE HANDSHAKE ITSELF: a spawned holder takes the handle, and the claim carries THIS attempt's id.
    $handshakeLock = Enter-SeatRegistryLock -Workspace $handshakeWorkspace
    $tauAttempt = $null
    try {
        Write-SeatBinding -Workspace $handshakeWorkspace -StateDirectory $handshakeState -Seat 'tau' `
            -AgentProcessId $holderAgent.Id -AgentStartUtc $holderIdentity -SessionId 'conv-tau' -State 'pending' | Out-Null
        $tauAttempt = Start-SeatClaimHolder -Workspace $handshakeWorkspace -StateDirectory $handshakeState -Seat 'tau' `
            -AgentProcessId $holderAgent.Id -AgentStartUtc $holderIdentity
        Assert-True ((Get-Field $tauAttempt 'attempt_id' 'the handshake result') -cmatch '^[0-9a-f]{32}$') 'the handshake returned no attempt id'
        Assert-Equal ([string]$tauAttempt.attempt_id) ([string](Get-SeatClaimAttemptId -StateDirectory $handshakeState -Seat 'tau')) 'the claim handle does not carry the attempt that opened it'
        Assert-True (Test-SeatClaim -StateDirectory $handshakeState -Seat 'tau') 'the spawned holder did not take the claim handle'

        # THE HELPER DIES BETWEEN THE TWO COMMITS -- round 4's window, reproduced exactly. The binding
        # commits and the attempt does not, which is what a helper killed in that instant leaves.
        Write-SeatBinding -Workspace $handshakeWorkspace -StateDirectory $handshakeState -Seat 'tau' `
            -AgentProcessId $holderAgent.Id -AgentStartUtc $holderIdentity -SessionId 'conv-tau' -State 'committed' | Out-Null
    }
    finally { Exit-BookLock -Lock $handshakeLock }

    # The holder abandons itself at its deadline, so the seat lands on `orphaned` -- a state the matrix
    # already repairs -- rather than on a held handle over a binding nothing can recognise.
    $abandonBy = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $abandonBy -and (Test-SeatClaim -StateDirectory $handshakeState -Seat 'tau')) { Start-Sleep -Milliseconds 100 }
    Assert-True (-not (Test-SeatClaim -StateDirectory $handshakeState -Seat 'tau')) 'a holder whose attempt never committed kept the handle past its deadline'
    Assert-Equal 'orphaned' ([string](Get-SeatClaimState -StateDirectory $handshakeState -Seat 'tau' -AgentProcessId 0).state) 'the uncommitted handshake did not leave the seat orphaned'

    # A LATE HOLDER WHOSE ATTEMPT IS ALREADY ABANDONED NEVER ACQUIRES ONE. Driven as the real process,
    # because that check lives in the holder and nowhere else.
    $lateLock = Enter-SeatRegistryLock -Workspace $handshakeWorkspace
    try {
        Write-SeatHolderAttempt -Workspace $handshakeWorkspace -StateDirectory $handshakeState -Seat 'upsilon' `
            -AttemptId ('b' * 32) -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(30).ToString('o')) -State 'abandoned' | Out-Null
    }
    finally { Exit-BookLock -Lock $lateLock }
    # A DECOY CLAIM FILE, NOT HELD BY ANYONE, is what makes this observable. "Is the seat free
    # afterwards" cannot see the fault: the holder's poll loop ALSO reads the state, so a holder that
    # skipped a pre-flight check would take the handle, notice the problem a few milliseconds later
    # and let go -- two checks over one property, and deleting the load-bearing one leaves the suite
    # green (the pattern this repository recorded on 2026-09-09 and then reproduced here). What the
    # brief acquisition really costs is the abort path: a helper waiting for the handle to read free
    # before it removes provisional state would see a live claim and leave the seat half-built. So the
    # assertion is that the file is never TOUCHED -- Enter-SeatClaim opens it FileMode.Create, so an
    # acquisition truncates these bytes and the release then deletes them.
    #
    # AND EACH PRE-FLIGHT GUARD GETS ITS OWN FIXTURE, because a holder refuses for THREE separate
    # reasons and one case only exercises one of them. The first falsification round proved it: with
    # only the abandoned case here, deleting the missing-record guard and deleting the wrong-id guard
    # both left the suite green -- each case's record satisfied the guard being deleted, so nothing
    # changed. A per-class count cannot see one route going blind; a per-route fixture can.
    $decoyClaimPath = Get-SeatClaimPath -StateDirectory $handshakeState -Seat 'upsilon'
    #
    # AND THE EXIT CODE IS ASSERTED, NOT JUST THE ABSENCE OF A HANDLE. Under StrictMode a missing or
    # unreadable record makes the NEXT line throw on a null property, so the holder exits non-zero and
    # takes nothing either way -- correct behaviour, arrived at by crashing, and it left two of these
    # four routes green when their own guard was deleted. Exit 3 is the holder's word for "this
    # attempt is not wanted"; a crash is exit 1 and says nothing to anyone.
    $lateRoutes = @(
        @{ why = 'ABANDONED'; state = 'abandoned'; recorded = ('b' * 32); given = ('b' * 32); raw = $null; expect = 3 }
        @{ why = 'MISSING';   state = $null;       recorded = $null;     given = ('e' * 32); raw = $null; expect = 3 }
        @{ why = 'ANOTHER attempt''s'; state = 'pending'; recorded = ('f' * 32); given = ('9' * 32); raw = $null; expect = 3 }
        @{ why = 'UNREADABLE'; state = $null;      recorded = $null;     given = ('a' * 32); raw = '{ not json'; expect = 7 }
    )
    foreach ($route in $lateRoutes) {
        $routeLock = Enter-SeatRegistryLock -Workspace $handshakeWorkspace
        try {
            if ($null -eq $route.state) {
                Remove-SeatHolderAttempt -Workspace $handshakeWorkspace -StateDirectory $handshakeState -Seat 'upsilon' -Force | Out-Null
            }
            else {
                Write-SeatHolderAttempt -Workspace $handshakeWorkspace -StateDirectory $handshakeState -Seat 'upsilon' `
                    -AttemptId ([string]$route.recorded) -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(30).ToString('o')) `
                    -State ([string]$route.state) | Out-Null
            }
            if ($null -ne $route.raw) {
                [IO.File]::WriteAllText((Get-SeatHolderAttemptPath -StateDirectory $handshakeState -Seat 'upsilon'), [string]$route.raw, $utf8)
            }
        }
        finally { Exit-BookLock -Lock $routeLock }

        [IO.File]::WriteAllText($decoyClaimPath, "token=$('d' * 32)`nstale=1`n", $utf8)
        $lateHolder = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'Invoke-SeatClaimHolder.ps1'),
            '-WorkspacePath', $handshakeWorkspace, '-Seat', 'upsilon', '-AttemptId', ([string]$route.given),
            '-AgentProcessId', ([string]$holderAgent.Id), '-AgentStartUtc', $holderIdentity)
        [void]$dummies.Add($lateHolder)
        $lateHolder.WaitForExit(15000) | Out-Null
        Assert-True ($lateHolder.HasExited) "a holder spawned against $([string]$route.why) attempt did not exit"
        Assert-Equal ([string]$route.expect) ([string]$lateHolder.ExitCode) "a holder against $([string]$route.why) attempt did not refuse through its own guard -- some other exit answered for it, which is a crash or a neighbouring check standing in"
        Assert-True (-not (Test-SeatClaim -StateDirectory $handshakeState -Seat 'upsilon')) "a holder acquired a handle against $([string]$route.why) attempt"
        Assert-True (Test-Path -LiteralPath $decoyClaimPath -PathType Leaf) "a holder against $([string]$route.why) attempt opened the claim file and then deleted it on the way out"
        Assert-Equal ('d' * 32) ([string](Get-SeatClaimToken -StateDirectory $handshakeState -Seat 'upsilon')) "a holder against $([string]$route.why) attempt truncated a claim file it should never have opened"
        Remove-Item -LiteralPath $decoyClaimPath -Force
    }
    $tidyLock = Enter-SeatRegistryLock -Workspace $handshakeWorkspace
    try { Remove-SeatHolderAttempt -Workspace $handshakeWorkspace -StateDirectory $handshakeState -Seat 'upsilon' -Force | Out-Null }
    finally { Exit-BookLock -Lock $tidyLock }

    # A HANDLE SOMEBODY ELSE HOLDS IS NOT READINESS. The handshake asks "is this MY holder", not "does
    # a handle exist" -- and the difference is the whole reason the attempt id is written into the
    # claim file. With only the handle tested, this call would report ready the instant it looked, and
    # the caller would commit a binding over a seat another agent is working.
    $foreignHandle = Enter-SeatClaim -StateDirectory $handshakeState -Seat 'upsilon'
    [void]$claims.Add($foreignHandle)
    $foreignReady = $null
    $foreignLock = Enter-SeatRegistryLock -Workspace $handshakeWorkspace
    try {
        try {
            Start-SeatClaimHolder -Workspace $handshakeWorkspace -StateDirectory $handshakeState -Seat 'upsilon' `
                -AgentProcessId $holderAgent.Id -AgentStartUtc $holderIdentity -DeadlineSeconds 1 | Out-Null
        }
        catch { $foreignReady = [string]$_.Exception.Message }
    }
    finally { Exit-BookLock -Lock $foreignLock }
    Assert-True ($null -ne $foreignReady) 'the handshake reported ready against a handle another session was holding'
    Assert-True ($foreignReady -clike "*did not take the seat's handle*") "the foreign-handle timeout failed for the wrong reason: $foreignReady"
    Assert-True (Test-SeatClaim -StateDirectory $handshakeState -Seat 'upsilon') 'the abandoned handshake released a handle that was never its own'
    Exit-SeatClaim -Claim $foreignHandle

    # AND A HOLDER WHOSE AGENT IS NOT THAT AGENT TAKES NOTHING. Same PID, an earlier start time.
    $wrongAgentStart = ([DateTime]::Parse($holderIdentity).ToUniversalTime().AddSeconds(-1)).ToString('o')
    $pendingLock = Enter-SeatRegistryLock -Workspace $handshakeWorkspace
    try {
        Write-SeatHolderAttempt -Workspace $handshakeWorkspace -StateDirectory $handshakeState -Seat 'upsilon' `
            -AttemptId ('c' * 32) -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(30).ToString('o')) -State 'pending' | Out-Null
    }
    finally { Exit-BookLock -Lock $pendingLock }
    $wrongAgentHolder = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'Invoke-SeatClaimHolder.ps1'),
        '-WorkspacePath', $handshakeWorkspace, '-Seat', 'upsilon', '-AttemptId', ('c' * 32),
        '-AgentProcessId', ([string]$holderAgent.Id), '-AgentStartUtc', $wrongAgentStart)
    [void]$dummies.Add($wrongAgentHolder)
    $wrongAgentHolder.WaitForExit(15000) | Out-Null
    Assert-True ($wrongAgentHolder.HasExited) 'a holder spawned for a reused PID did not exit'
    Assert-True (-not (Test-SeatClaim -StateDirectory $handshakeState -Seat 'upsilon')) 'a holder took a handle for an agent whose start time did not match'

    Stop-Process -Id $holderAgent.Id -Force -ErrorAction SilentlyContinue

    # --- 15. tools/Enter-LibrarySeat.ps1, AS A REAL PROCESS (plan step 7) -------------------------
    #
    # THIS IS WHAT MAKES A BINDING REACHABLE BY ANYTHING BUT A FIXTURE, so it is driven as a helper
    # process with its own exit code, exactly as the launcher and retirement are above.
    $enterState = Join-Path $fixture 'enter/.claude'
    $enterWorkspace = Join-Path $fixture 'enter'
    New-Item -ItemType Directory -Path $enterState -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $enterWorkspace 'notebook') -Force | Out-Null
    Initialize-SeatForFixture -StateDirectory $enterState -Seat 'phi' -Project 'phi-proj' -OpenBooks @('shelf/demo') | Out-Null
    Initialize-SeatForFixture -StateDirectory $enterState -Seat 'chi' -Project 'chi-proj' | Out-Null

    $enterAgent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
    [void]$dummies.Add($enterAgent)
    $otherAgent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
    [void]$dummies.Add($otherAgent)

    function Invoke-EnterSeat([string[]]$ArgumentList) {
        Invoke-SeatHelper 'Enter-LibrarySeat.ps1' (@('-WorkspacePath', $enterWorkspace) + $ArgumentList)
    }

    # THE DESK IS READ BEFORE AND AFTER, because "entering a seat leaves the Desk exactly as it was"
    # (ADR-0010) is a promise no state read can make on its own.
    $phiBooksPath = Get-DeskFilePath -StateDirectory $enterState -Seat 'phi' -Kind 'books'
    $deskBefore = [IO.File]::ReadAllText($phiBooksPath)

    $bind = Invoke-EnterSeat @('-Seat', 'phi', '-AgentProcessId', ([string]$enterAgent.Id), '-SessionId', 'conv-phi', '-Json')
    Assert-True ($bind.ExitCode -eq 0) "binding a seat failed: $($bind.Text)"
    $bound = Get-ResultJson $bind 'the bind result'
    Assert-Equal 'phi' ([string](Get-Field $bound 'seat' 'the bind result')) 'the bind result named the wrong seat'
    Assert-Equal 'binding' ([string](Get-Field $bound 'binding_source' 'the bind result')) 'the bind result did not report a verified binding'
    Assert-Equal 'untouched' ([string](Get-Field $bound 'desk_action' 'the bind result')) 'the bind result did not report the Desk as untouched'
    Assert-Equal $deskBefore ([IO.File]::ReadAllText($phiBooksPath)) 'entering a seat changed its Desk'
    Assert-Equal 'held' ([string](Get-SeatClaimState -StateDirectory $enterState -Seat 'phi' -AgentProcessId $enterAgent.Id).state) 'the bound seat is not held'
    Assert-Equal 'committed' ([string](Read-SeatBinding -StateDirectory $enterState -Seat 'phi').state) 'the binding was left pending'
    Assert-Equal 'conv-phi' ([string](Read-SeatBinding -StateDirectory $enterState -Seat 'phi').session_id) 'the binding lost its conversation'
    Assert-Equal 'committed' ([string](Read-SeatHolderAttempt -StateDirectory $enterState -Seat 'phi').state) 'the holder attempt was left pending'

    # A SECOND BIND BY THE SAME AGENT IS A NO-OP, not a second holder: a resumed conversation's hook
    # and a reader who says it twice both land here.
    $again = Invoke-EnterSeat @('-Seat', 'phi', '-AgentProcessId', ([string]$enterAgent.Id), '-Json')
    Assert-True ($again.ExitCode -eq 0) "re-entering a bound seat failed: $($again.Text)"
    $alreadyBound = Get-ResultJson $again 'the re-entry result'
    Assert-True ([bool](Get-Field $alreadyBound 'already_bound' 'the re-entry result')) 're-entering an already-bound seat was not reported as a no-op'
    Assert-Equal 'conv-phi' ([string]$alreadyBound.session_id) 're-entry reported a different conversation from the one on the binding'

    # ANOTHER AGENT IS REFUSED AT A HELD SEAT, and this agent is refused a SECOND seat -- two different
    # refusals, and each names the fix the other one does not.
    $secondAgent = Invoke-EnterSeat @('-Seat', 'phi', '-AgentProcessId', ([string]$otherAgent.Id), '-Json')
    Assert-True ($secondAgent.ExitCode -ne 0) 'a second agent was bound to a held seat'
    Assert-True ($secondAgent.Text.Contains('live session')) "the held-seat refusal did not say the seat is in use: $($secondAgent.Text)"
    $secondSeat = Invoke-EnterSeat @('-Seat', 'chi', '-AgentProcessId', ([string]$enterAgent.Id), '-Json')
    Assert-True ($secondSeat.ExitCode -ne 0) 'one agent was bound to two seats'
    Assert-True ($secondSeat.Text.Contains("'phi'")) "the second-seat refusal did not name the seat this agent already holds: $($secondSeat.Text)"

    # KILL THE HOLDER: orphaned, and the same agent restores it WITHOUT REWRITING the committed
    # binding -- that record is the identity the restore was allowed on.
    $phiHolder = [int](Read-SeatHolderAttempt -StateDirectory $enterState -Seat 'phi').holder_pid
    $bindingBytes = [IO.File]::ReadAllBytes((Get-SeatBindingPath -StateDirectory $enterState -Seat 'phi'))
    Stop-Process -Id $phiHolder -Force -ErrorAction SilentlyContinue
    $orphanBy = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $orphanBy -and (Test-SeatClaim -StateDirectory $enterState -Seat 'phi')) { Start-Sleep -Milliseconds 100 }
    Assert-Equal 'orphaned' ([string](Get-SeatClaimState -StateDirectory $enterState -Seat 'phi' -AgentProcessId 0).state) 'killing the holder did not leave the seat orphaned'
    $restore = Invoke-EnterSeat @('-Seat', 'phi', '-AgentProcessId', ([string]$enterAgent.Id), '-Json')
    Assert-True ($restore.ExitCode -eq 0) "the same agent could not restore its own orphaned seat: $($restore.Text)"
    $restored = Get-ResultJson $restore 'the restore result'
    Assert-True ([bool](Get-Field $restored 'recovered_orphan' 'the restore result')) 'the restore was not reported as an orphan recovery'
    Assert-Equal 'conv-phi' ([string]$restored.session_id) 'the restore reported a conversation the binding does not carry'
    Assert-Equal ([Convert]::ToBase64String($bindingBytes)) `
        ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Get-SeatBindingPath -StateDirectory $enterState -Seat 'phi')))) `
        'recovering an orphan rewrote the committed binding it exists to protect'
    Assert-Equal 'held' ([string](Get-SeatClaimState -StateDirectory $enterState -Seat 'phi' -AgentProcessId $enterAgent.Id).state) 'the restored seat is not held'

    # A FOREIGN AGENT IS REFUSED AT AN ORPHANED SEAT TOO, which is the row Enter-SeatClaim alone
    # cannot answer: the handle really is gone, so the acquisition would succeed.
    Stop-Process -Id ([int](Read-SeatHolderAttempt -StateDirectory $enterState -Seat 'phi').holder_pid) -Force -ErrorAction SilentlyContinue
    $orphanAgain = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $orphanAgain -and (Test-SeatClaim -StateDirectory $enterState -Seat 'phi')) { Start-Sleep -Milliseconds 100 }
    $foreignOrphan = Invoke-EnterSeat @('-Seat', 'phi', '-AgentProcessId', ([string]$otherAgent.Id), '-Json')
    Assert-True ($foreignOrphan.ExitCode -ne 0) 'a foreign agent was let into an ORPHANED seat'
    Assert-True ($foreignOrphan.Text.Contains('claim holder is gone')) "the orphaned refusal did not distinguish itself from a free seat: $($foreignOrphan.Text)"

    # THE CREATE GATE'S OFFLINE HALF. The catalog read needs the shared collection, so the confirmed
    # transaction is pinned by `seat.create-acceptance` under -IncludeShared; what belongs here is
    # every refusal that happens before a network read or after one that failed.
    $noConfirm = Invoke-EnterSeat @('-Seat', 'psi', '-Project', 'psi-proj', '-AgentProcessId', ([string]$otherAgent.Id), '-Create', '-Json')
    Assert-True ($noConfirm.ExitCode -ne 0) 'a seat was created with no confirmation'
    Assert-True ($noConfirm.Text.Contains('-Preflight')) "the unconfirmed create refusal did not name the preflight: $($noConfirm.Text)"
    $noPlan = Invoke-EnterSeat @('-Seat', 'psi', '-Project', 'psi-proj', '-AgentProcessId', ([string]$otherAgent.Id), '-Create', '-UserConfirmed', '-Json')
    Assert-True ($noPlan.ExitCode -ne 0) 'a seat was created with no plan_id'
    Assert-True ($noPlan.Text.Contains('ApprovedPlanId')) "the missing-plan_id refusal did not name it: $($noPlan.Text)"
    # AN UNREADABLE CATALOG IS A REFUSAL, NOT A CREATION. Pointed at a closed port so the read fails
    # immediately: a seat bound to a Project that may not exist would namespace its Notebook and
    # output under a name nothing else knows.
    # THE SEAT NAME IS JUDGED BEFORE THE PROJECT IS OFFERED. With no -Project the preflight LISTS the
    # active Projects rather than refusing -- which is the right answer only when the seat name is
    # actually usable. A reader whose real problem is a slug an ownership row still cites must not be
    # handed a menu of Projects to pick from; they would pick one and be refused for something else.
    # The offer's own case lives in `seat.create-acceptance`; this is the case that must NOT offer.
    $enterOwnersPath = Get-NotebookOwnersPath -Workspace $enterWorkspace
    [IO.File]::WriteAllText($enterOwnersPath, (([pscustomobject]@{
        schema = 1; topics = @([pscustomobject]@{ topic = 'psi-topic'; seat = 'psi'; scope = 'owned' })
    } | ConvertTo-Json -Depth 6) + "`n"), $utf8)
    $citedBeforeOffer = Invoke-EnterSeat @('-Seat', 'psi', '-AgentProcessId', ([string]$otherAgent.Id), '-Create', '-Preflight', '-Json')
    Assert-True ($citedBeforeOffer.ExitCode -ne 0) 'a seat name the ownership record still cites was offered a list of Projects instead of being refused'
    Assert-True ($citedBeforeOffer.Text.Contains('cannot be used yet')) "the cited-name refusal did not say why: $($citedBeforeOffer.Text)"
    Assert-True ($citedBeforeOffer.Text -cnotmatch 'active_projects') "the cited-name refusal offered Projects anyway: $($citedBeforeOffer.Text)"
    Remove-Item -LiteralPath $enterOwnersPath -Force

    $noCatalog = Invoke-EnterSeat @('-Seat', 'psi', '-Project', 'psi-proj', '-AgentProcessId', ([string]$otherAgent.Id),
        '-Create', '-Preflight', '-McpUrl', 'http://127.0.0.1:1/mcp', '-Json')
    Assert-True ($noCatalog.ExitCode -ne 0) 'a seat creation was planned against a Project Catalog that could not be read'
    Assert-True ($noCatalog.Text.Contains('Active Project Catalog')) "the unreadable-catalog refusal did not name what it could not read: $($noCatalog.Text)"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path (Get-SeatsDirectory $enterState) 'psi'))) 'a refused creation left a seat directory behind'

    Stop-Process -Id $enterAgent.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $otherAgent.Id -Force -ErrorAction SilentlyContinue

    # --- 16. THE SessionStart HOOK, AS A REAL PROCESS, OVER ITS STATE TABLE (plan step 9) ---------
    #
    # THE HOOK IS THE ONE-CLICK HALF, AND A HOOK IS THE ONE KIND OF CODE NOTHING CALLS DURING
    # DEVELOPMENT. Its sibling read `startup_reason` for four days and never fired once, with a green
    # gate throughout, because the suite that covered it fed the same wrong field. So every row below
    # drives `.claude/hooks/Get-SeatStartContext.ps1` as a process, with a payload shaped like the
    # ones step 0c captured, and reads what comes back rather than that something did.
    #
    # A ROW PER `source` VALUE, NOT ONE STANDING FOR ALL OF THEM. `startup`, `clear` and `fork` want
    # the same answer for different reasons, so a hook that recognised only `startup` would still
    # look correct if one assertion stood for the three. Each is asserted on its own.
    #
    # ITS OWN FIXTURE WORKSPACE. This case kills agents and holders and corrupts a binding on
    # purpose; sharing case 15's seats would turn a later red into a crash naming nothing.
    $hookWorkspace = Join-Path $fixture 'sessionstart'
    $hookState = Join-Path $hookWorkspace '.claude'
    New-Item -ItemType Directory -Path $hookState -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $hookWorkspace 'notebook') -Force | Out-Null
    foreach ($pair in @(@('omega', 'omega-proj'), @('sigma', 'sigma-proj'), @('tau', 'tau-proj'), @('upsilon', 'upsilon-proj'))) {
        Initialize-SeatForFixture -StateDirectory $hookState -Seat $pair[0] -Project $pair[1] | Out-Null
    }

    $hookPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.claude/hooks/Get-SeatStartContext.ps1'
    function Invoke-SeatStartHook([string]$Source, [string]$SessionId, [int]$AgentPid, [double]$Deadline = 2) {
        # THE PAYLOAD IS THE SHAPE 0c CAPTURED, extra fields included: `resume` and `fork` arrive
        # carrying four that `startup` does not, and a reader written against the thin shape would
        # pass here and meet the real one in production.
        $payload = @{ hook_event_name = 'SessionStart'; session_id = $SessionId; cwd = $hookWorkspace; source = $Source }
        if ($Source -cin @('resume', 'fork')) {
            $payload['context_tokens'] = 41234
            $payload['prompt_cache_likely_expired'] = $true
            $payload['seconds_since_last_response'] = 9412
        }
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress -Depth 8)))
        $invocation = Invoke-SeatHelper '../.claude/hooks/Get-SeatStartContext.ps1' @(
            '-StateDirectory', $hookState, '-WorkspacePath', $hookWorkspace,
            '-AgentProcessId', ([string]$AgentPid), '-DeadlineSeconds', ([string]$Deadline),
            '-InputJsonBase64', $encoded)
        $context = ''
        foreach ($line in @($invocation.Stdout)) {
            if (-not $line.Trim().StartsWith('{')) { continue }
            try { $context = [string]($line | ConvertFrom-Json).hookSpecificOutput.additionalContext } catch { }
        }
        [pscustomobject]@{ ExitCode = $invocation.ExitCode; Text = $invocation.Text; Context = $context }
    }
    Assert-True (Test-Path -LiteralPath $hookPath -PathType Leaf) 'the SessionStart hook this case drives is not where this case looks for it'

    # THE ASK AND THE ROSTER, on every source value that means "a fresh conversation". The served
    # section is asserted by a phrase from docs/seats.md itself, so a hook that grew its own copy of
    # the wording -- the second authority ADR-0014 exists to prevent -- fails here.
    foreach ($fresh in @('startup', 'clear', 'fork', 'an-unnamed-future-source')) {
        $offer = Invoke-SeatStartHook $fresh 'conv-fresh' 0
        Assert-True ($offer.ExitCode -eq 0) "a '$fresh' session start exited non-zero: $($offer.Text)"
        Assert-True ($offer.Context.Contains('Ask the reader which seat they want')) "a '$fresh' session start did not serve the ask from docs/seats.md: $($offer.Context)"
        Assert-True ($offer.Context.Contains('omega') -and $offer.Context.Contains('upsilon')) "a '$fresh' session start's roster did not name every seat: $($offer.Context)"
        Assert-True ($offer.Context.Contains('omega-proj')) "a '$fresh' session start's roster did not say which Project a seat is bound to: $($offer.Context)"
    }
    # A COMPACTION SAYS NOTHING. The Desk context hook has told this session it has no seat on every
    # prompt already; repeating the roster here is context the reader pays for twice.
    $quietCompact = Invoke-SeatStartHook 'compact' 'conv-fresh' 0
    Assert-True ($quietCompact.ExitCode -eq 0) "a seatless compact exited non-zero: $($quietCompact.Text)"
    Assert-True ([string]::IsNullOrWhiteSpace($quietCompact.Context)) "a seatless compact offered a roster anyway: $($quietCompact.Context)"

    # A RESUME WITH NO RECORD FALLS BACK TO THE ROSTER, and says which of the two it is: a reader told
    # "no seat" and a reader told "the seat you had is gone" take different next steps.
    $noRecord = Invoke-SeatStartHook 'resume' 'conv-never-sat' 0
    Assert-True ($noRecord.Context.Contains('no seat records having been sat at by it')) "a resume with no record did not say so: $($noRecord.Context)"
    Assert-True ($noRecord.Context.Contains('Ask the reader which seat they want')) 'a resume with no record was not offered the ask'

    $hookAgent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
    [void]$dummies.Add($hookAgent)
    function Enter-HookSeat([string]$SeatName, [string]$SessionId, [int]$AgentPid) {
        Invoke-SeatHelper 'Enter-LibrarySeat.ps1' @('-Seat', $SeatName, '-WorkspacePath', $hookWorkspace,
            '-AgentProcessId', ([string]$AgentPid), '-SessionId', $SessionId, '-Json')
    }
    function Wait-SeatFree([string]$SeatName) {
        $until = [DateTime]::UtcNow.AddSeconds(15)
        while ([DateTime]::UtcNow -lt $until -and (Test-SeatClaim -StateDirectory $hookState -Seat $SeatName)) { Start-Sleep -Milliseconds 100 }
    }
    # KILLING A PROCESS IS A REQUEST, NOT AN EVENT. Stop-Process returns before the process is gone,
    # and a seat whose handle was already released reaches Wait-SeatFree instantly -- so waiting on
    # the CLAIM proves nothing about the AGENT, and the first run of this case asserted `free` against
    # a seat that was still legitimately `orphaned` half a second later.
    function Stop-AgentAndWait($Agent) {
        Stop-Process -Id $Agent.Id -Force -ErrorAction SilentlyContinue
        try { [void]$Agent.WaitForExit(15000) } catch { }
        $until = [DateTime]::UtcNow.AddSeconds(15)
        while ([DateTime]::UtcNow -lt $until) {
            if ($null -eq (Get-AgentProcessIdentity -ProcessId ([int]$Agent.Id))) { break }
            Start-Sleep -Milliseconds 100
        }
    }

    $boundOmega = Enter-HookSeat 'omega' 'conv-omega' $hookAgent.Id
    Assert-True ($boundOmega.ExitCode -eq 0) "the fixture could not bind omega: $($boundOmega.Text)"

    # BOUND: the status line, and NO roster. Offering the roster to a session that already holds a
    # seat would be telling it to leave the work it is sitting at.
    $boundStart = Invoke-SeatStartHook 'startup' 'conv-omega' $hookAgent.Id
    Assert-True ($boundStart.Context.Contains("seat 'omega' is bound to this conversation")) "a bound session was not told which seat it holds: $($boundStart.Context)"
    Assert-True (-not $boundStart.Context.Contains('Ask the reader which seat')) "a bound session was offered the seat roster: $($boundStart.Context)"
    # AND A BOUND COMPACTION IS SILENT while still recording, which the assertion below proves by
    # reading the binding rather than by reading the output.
    $boundCompact = Invoke-SeatStartHook 'compact' 'conv-omega-2' $hookAgent.Id
    Assert-True ([string]::IsNullOrWhiteSpace($boundCompact.Context)) "a bound compact said something: $($boundCompact.Context)"
    Assert-Equal 'conv-omega-2' ([string](Read-SeatBinding -StateDirectory $hookState -Seat 'omega').session_id) 'a bound session start did not record the conversation on the binding'
    # IDEMPOTENT: the same conversation twice writes nothing, which is what keeps the backstop cheap.
    $bindingBefore = [IO.File]::ReadAllBytes((Get-SeatBindingPath -StateDirectory $hookState -Seat 'omega'))
    Invoke-SeatStartHook 'clear' 'conv-omega-2' $hookAgent.Id | Out-Null
    Assert-Equal ([Convert]::ToBase64String($bindingBefore)) `
        ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Get-SeatBindingPath -StateDirectory $hookState -Seat 'omega')))) `
        'recording a conversation already on the binding rewrote it anyway'

    # A HELD SEAT IS REPORTED, NEVER TAKEN. This is the row that proves the hook decides nothing: the
    # helper it calls refuses, and the hook passes the refusal on instead of working around it.
    $heldResume = Invoke-SeatStartHook 'resume' 'conv-omega-2' 0
    Assert-True ($heldResume.ExitCode -eq 0) "a resume onto a held seat exited non-zero: $($heldResume.Text)"
    Assert-True ($heldResume.Context.Contains('another live session is at it now')) "a resume onto a held seat did not say so: $($heldResume.Context)"
    Assert-True ($heldResume.Context.Contains('Ask the reader which seat they want')) 'a resume onto a held seat was not offered the roster'
    Assert-Equal ([string]$hookAgent.Id) ([string](Read-SeatBinding -StateDirectory $hookState -Seat 'omega').agent_pid) 'a resume onto a held seat rebound it anyway'

    # AN ORPHAN IS ITS OWN ANSWER, distinguishable from held and from free. Kill the HOLDER, not the
    # agent: the seat has no live handle and a living agent, which is the state a resumed conversation
    # must not mistake for free.
    Stop-Process -Id ([int](Read-SeatHolderAttempt -StateDirectory $hookState -Seat 'omega').holder_pid) -Force -ErrorAction SilentlyContinue
    Wait-SeatFree 'omega'
    $orphanResume = Invoke-SeatStartHook 'resume' 'conv-omega-2' 0
    Assert-True ($orphanResume.Context.Contains('claim holder is gone')) "a resume onto an orphaned seat read it as held or free: $($orphanResume.Context)"
    Assert-True ($orphanResume.Context.Contains('re-bound from that conversation')) 'the orphaned resume did not name the fix'

    # THE RE-BIND ITSELF: kill the AGENT, so the holder lets go and the binding goes stale, and the
    # seat reads free. This is Orca's hibernate-and-Resume, and it is the whole point of step 9.
    Stop-AgentAndWait $hookAgent
    Wait-SeatFree 'omega'
    Assert-Equal 'free' ([string](Get-SeatClaimState -StateDirectory $hookState -Seat 'omega' -AgentProcessId 0).state) 'the fixture did not reach a free seat with a stale binding'
    $resumeAgent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
    [void]$dummies.Add($resumeAgent)
    $rebound = Invoke-SeatStartHook 'resume' 'conv-omega-2' $resumeAgent.Id
    Assert-True ($rebound.Context.Contains('re-bound to the seat it last held')) "a resumed conversation was not put back at its own free seat: $($rebound.Context)"
    Assert-True (-not $rebound.Context.Contains('Ask the reader which seat')) 'a successful re-bind asked the reader anyway'
    $reboundBinding = Read-SeatBinding -StateDirectory $hookState -Seat 'omega'
    Assert-Equal ([string]$resumeAgent.Id) ([string]$reboundBinding.agent_pid) 'the re-bind did not bind the seat to the resuming agent'
    Assert-Equal 'conv-omega-2' ([string]$reboundBinding.session_id) 'the re-bind lost the conversation it was made for'
    Assert-Equal 'held' ([string](Get-SeatClaimState -StateDirectory $hookState -Seat 'omega' -AgentProcessId $resumeAgent.Id).state) 'the re-bound seat has no live claim'

    # THE CROSS-SEAT RESUME INFORMS AND NEVER MOVES. This agent is at omega; the conversation also has
    # a record at sigma. Both facts are true, and the seat must not change.
    $sigmaAgent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
    [void]$dummies.Add($sigmaAgent)
    Enter-HookSeat 'sigma' 'conv-omega-2' $sigmaAgent.Id | Out-Null
    $crossSeat = Invoke-SeatStartHook 'resume' 'conv-omega-2' $resumeAgent.Id
    Assert-True ($crossSeat.Context.Contains("last sat at seat 'sigma'")) "a conversation with a record at another seat was not told: $($crossSeat.Context)"
    Assert-True ($crossSeat.Context.Contains("seat 'omega' is bound to this conversation")) 'the cross-seat resume did not say where this conversation actually is'
    Assert-Equal ([string]$sigmaAgent.Id) ([string](Read-SeatBinding -StateDirectory $hookState -Seat 'sigma').agent_pid) 'the cross-seat resume moved a seat it was only supposed to mention'
    Stop-AgentAndWait $sigmaAgent
    Stop-AgentAndWait $resumeAgent
    Wait-SeatFree 'omega'
    Wait-SeatFree 'sigma'

    # A RETIRED SEAT AND A REUSED NAME ARE DIFFERENT ANSWERS, and neither is a bind. The binding is
    # left in place and the REGISTRY is edited, which is what a retirement and a recreation each look
    # like from the resuming conversation's side.
    $tauAgent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
    [void]$dummies.Add($tauAgent)
    Enter-HookSeat 'tau' 'conv-tau' $tauAgent.Id | Out-Null
    Stop-AgentAndWait $tauAgent
    Wait-SeatFree 'tau'
    $hookRegistry = Read-SeatRegistry -StateDirectory $hookState
    $withoutTau = @(@($hookRegistry.seats) | Where-Object { [string]$_.seat -cne 'tau' })
    Write-SeatRegistry -StateDirectory $hookState -Registry ([pscustomobject]@{ schema = 1; seats = $withoutTau })
    $goneSeat = Invoke-SeatStartHook 'resume' 'conv-tau' 0
    Assert-True ($goneSeat.Context.Contains('no longer exists')) "a resume onto a retired seat did not say it is gone: $($goneSeat.Context)"
    Assert-True ($goneSeat.Context.Contains('Ask the reader which seat they want')) 'a resume onto a retired seat was not offered the roster'

    # THE SAME NAME, A DIFFERENT INCARNATION. upsilon is bound with a seat_id the registry then
    # changes, which is exactly what retiring and recreating a slug does. A hook comparing NAMES
    # alone would hand this conversation a stranger's Desk.
    $upsilonSeats = @(@(Read-SeatRegistry -StateDirectory $hookState).seats | ForEach-Object {
        if ([string]$_.seat -ceq 'upsilon') { [pscustomobject]@{ seat = 'upsilon'; project = 'upsilon-proj'; seat_id = 'incarnation-one' } } else { $_ }
    })
    Write-SeatRegistry -StateDirectory $hookState -Registry ([pscustomobject]@{ schema = 1; seats = $upsilonSeats })
    $upsilonAgent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
    [void]$dummies.Add($upsilonAgent)
    Enter-HookSeat 'upsilon' 'conv-upsilon' $upsilonAgent.Id | Out-Null
    Assert-Equal 'incarnation-one' ([string](Read-SeatBinding -StateDirectory $hookState -Seat 'upsilon').seat_id) 'the fixture did not put an incarnation id on the binding, so the case below would prove nothing'
    Stop-AgentAndWait $upsilonAgent
    Wait-SeatFree 'upsilon'
    $recreated = @(@(Read-SeatRegistry -StateDirectory $hookState).seats | ForEach-Object {
        if ([string]$_.seat -ceq 'upsilon') { [pscustomobject]@{ seat = 'upsilon'; project = 'upsilon-proj'; seat_id = 'incarnation-two' } } else { $_ }
    })
    Write-SeatRegistry -StateDirectory $hookState -Registry ([pscustomobject]@{ schema = 1; seats = $recreated })
    $wrongIncarnation = Invoke-SeatStartHook 'resume' 'conv-upsilon' 0
    Assert-True ($wrongIncarnation.Context.Contains('a different seat under the same name')) "a reused slug was resumed as if it were the same seat: $($wrongIncarnation.Context)"
    Assert-True (-not (Test-SeatClaim -StateDirectory $hookState -Seat 'upsilon')) 'a resume onto a different incarnation bound it anyway'

    # A BIND THAT FAILS DEGRADES TO THE ROSTER AND STILL EXITS 0. Driven with a deadline the holder
    # handshake cannot meet, so the failure is the helper's real one rather than a simulated message.
    $sigmaFail = Invoke-SeatStartHook 'resume' 'conv-omega-2' 0 -0.001
    Assert-True ($sigmaFail.ExitCode -eq 0) "a failed bind at session start exited non-zero, which would block a reader's first turn: $($sigmaFail.Text)"
    Assert-True ($sigmaFail.Context.Contains('binding it failed')) "a failed bind did not say what happened: $($sigmaFail.Context)"
    Assert-True ($sigmaFail.Context.Contains('Ask the reader which seat they want')) 'a failed bind did not degrade to the roster'
    # AND IT REPORTS THE REFUSAL, NOT THE CHILD'S STACK. A `throw` in the helper renders about 700
    # characters of PowerShell diagnostics -- source line, CategoryInfo, and a FullyQualifiedErrorId
    # repeating the message -- and all of it was landing in a reader's first turn until falsification
    # forced this path and put it on screen.
    Assert-True (-not $sigmaFail.Context.Contains('FullyQualifiedErrorId')) "a failed bind injected the child's PowerShell stack into the session: $($sigmaFail.Context)"
    Assert-True (-not $sigmaFail.Context.Contains('CategoryInfo')) 'a failed bind injected the child''s error category into the session'

    # A BINDING NOBODY CAN PARSE IS NAMED IN THE ROSTER, and the other seats still appear. The roster
    # is what the reader acts on; an empty one would be a wrong answer where "I could not read sigma"
    # is a true one. Corrupt state is written as a file, not through a writer that would refuse it.
    #
    # AT A REGISTERED SEAT, and the first attempt used `tau`, which the retirement case above had
    # already removed from the registry -- so the roster, which enumerates the REGISTRY rather than
    # the seat directories, never looked at it and the case proved nothing.
    [IO.File]::WriteAllText((Get-SeatBindingPath -StateDirectory $hookState -Seat 'sigma'), "{ not json", $utf8)
    $corrupt = Invoke-SeatStartHook 'startup' 'conv-corrupt' 0
    Assert-True ($corrupt.ExitCode -eq 0) "a corrupt binding took the session start down: $($corrupt.Text)"
    Assert-True ($corrupt.Context.Contains('unreadable')) "a corrupt binding was not named in the roster: $($corrupt.Context)"
    Assert-True ($corrupt.Context.Contains('omega')) 'one corrupt binding emptied the whole roster'
    Remove-Item -LiteralPath (Get-SeatBindingPath -StateDirectory $hookState -Seat 'sigma') -Force

    # --- 17. THE DESK LINE AS A STATUS LINE, AND THE BACKSTOP RECORDER (plan step 10) -------------
    #
    # WHAT THIS CLOSES. A seat NAME is not a seat STATE, and the Desk line said the same thing
    # whether the seat was bound to this conversation by verified identity, inherited from an
    # environment variable nothing had checked, or held by a claim holder that died half an hour ago.
    # The third is the one that costs: an orphaned seat READS normally and refuses every write, so a
    # session that is not told finds out at the moment it tries to change something.
    $deskHook = Join-Path (Split-Path -Parent $PSScriptRoot) '.claude/hooks/Get-VirtualDeskContext.ps1'
    Assert-True (Test-Path -LiteralPath $deskHook -PathType Leaf) 'the Desk context hook this case drives is not where this case looks for it'
    function Invoke-DeskHook([string]$SessionId, [int]$AgentPid, [string]$SeatArgument = '') {
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
            (@{ hook_event_name = 'UserPromptSubmit'; session_id = $SessionId; cwd = $hookWorkspace; prompt = 'what is on my desk' } | ConvertTo-Json -Compress)))
        $arguments = @('-StateDirectory', $hookState, '-WorkspacePath', $hookWorkspace,
            '-AgentProcessId', ([string]$AgentPid), '-InputJsonBase64', $encoded)
        if ($SeatArgument) { $arguments = @('-Seat', $SeatArgument) + $arguments }
        $invocation = Invoke-SeatHelper '../.claude/hooks/Get-VirtualDeskContext.ps1' $arguments
        $context = ''
        foreach ($line in @($invocation.Stdout)) {
            if (-not $line.Trim().StartsWith('{')) { continue }
            try { $context = [string]($line | ConvertFrom-Json).hookSpecificOutput.additionalContext } catch { }
        }
        [pscustomobject]@{ ExitCode = $invocation.ExitCode; Text = $invocation.Text; Context = $context }
    }

    # SEATLESS: the line says a seat is needed and that a plain answer is enough. The two helper names
    # come from the resolver's own refusal, which is why nothing restates them here.
    $seatlessLine = Invoke-DeskHook 'conv-desk' 0
    Assert-True ($seatlessLine.ExitCode -eq 0) "the Desk hook exited non-zero with no seat: $($seatlessLine.Text)"
    Assert-True ($seatlessLine.Context.Contains('Virtual Desk - no seat')) "the seatless Desk line did not say there is no seat: $($seatlessLine.Context)"
    Assert-True ($seatlessLine.Context.Contains('a plain answer is enough')) "the seatless Desk line did not say how the reader answers: $($seatlessLine.Context)"
    Assert-True ($seatlessLine.Context.Contains('Enter-LibrarySeat.ps1')) 'the seatless Desk line did not carry the resolver''s own fix'

    # BOUND: the seat is named AND said to be bound to this conversation, which is the distinction a
    # bare name cannot make.
    $deskAgent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
    [void]$dummies.Add($deskAgent)
    $deskBind = Enter-HookSeat 'omega' 'conv-desk' $deskAgent.Id
    Assert-True ($deskBind.ExitCode -eq 0) "the fixture could not bind omega for the Desk line: $($deskBind.Text)"
    $boundLine = Invoke-DeskHook 'conv-desk' $deskAgent.Id
    Assert-True ($boundLine.Context.Contains('seat omega, bound to this conversation')) "the Desk line did not report the seat as bound: $($boundLine.Context)"
    Assert-True (-not $boundLine.Context.Contains('holder lost')) 'a healthy bound seat was reported as having lost its holder'

    # THE BACKSTOP RECORDER. A conversation this seat has never heard of is written onto the binding
    # by the Desk hook alone -- no SessionStart involved -- which is the route a seat entered by hand
    # mid-session takes.
    Assert-Equal 'conv-desk' ([string](Read-SeatBinding -StateDirectory $hookState -Seat 'omega').session_id) 'the fixture did not start from the conversation it binds'
    $rebranded = Invoke-DeskHook 'conv-desk-renamed' $deskAgent.Id
    Assert-True ($rebranded.Context.Contains('seat omega, bound to this conversation')) 'the Desk line stopped reporting the seat while recording a conversation'
    Assert-Equal 'conv-desk-renamed' ([string](Read-SeatBinding -StateDirectory $hookState -Seat 'omega').session_id) 'the Desk hook did not record a conversation the binding had never seen'
    # AND IT IS CHEAP AFTERWARDS: the same conversation again rewrites nothing at all.
    $afterRecord = [IO.File]::ReadAllBytes((Get-SeatBindingPath -StateDirectory $hookState -Seat 'omega'))
    Invoke-DeskHook 'conv-desk-renamed' $deskAgent.Id | Out-Null
    Assert-Equal ([Convert]::ToBase64String($afterRecord)) `
        ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Get-SeatBindingPath -StateDirectory $hookState -Seat 'omega')))) `
        'the backstop recorder rewrote a binding that already named this conversation'

    # ENTERING AN ALREADY-BOUND SEAT IS THE THIRD ROUTE INTO THE SAME RULE, and dropping the
    # -SessionId there was invisible until this case existed: the no-op reported the seat and left
    # the binding naming an older conversation, which is the record a later resume looks itself up
    # in. Its own signal is the `conversation_record` field, not the seat name it shares with the
    # plain no-op above.
    $reEnter = Enter-HookSeat 'omega' 'conv-desk-third' $deskAgent.Id
    Assert-True ($reEnter.ExitCode -eq 0) "re-entering a bound seat with a new conversation failed: $($reEnter.Text)"
    $reEntered = Get-ResultJson $reEnter 'the re-entry result'
    Assert-True ([bool](Get-Field $reEntered 'already_bound' 'the re-entry result')) 're-entering a bound seat was not reported as a no-op'
    Assert-Equal 'recorded' ([string](Get-Field $reEntered 'conversation_record' 'the re-entry result')) 'an already-bound re-entry dropped the conversation it was handed'
    Assert-Equal 'conv-desk-third' ([string](Read-SeatBinding -StateDirectory $hookState -Seat 'omega').session_id) 'the re-entry did not record the new conversation on the binding'
    Assert-Equal 'conv-desk-third' ([string]$reEntered.session_id) 'the re-entry reported the old conversation after recording a new one'

    # THE LOCK IS TAKEN ONLY WHEN THERE IS SOMETHING TO WRITE, AND THAT IS ASSERTED RATHER THAN
    # ASSUMED. Update-SeatConversationRecord checks the binding twice -- once cheaply outside the
    # lock, once under it -- and the two mutually cover: deleting EITHER copy left this suite green,
    # which is the shape that has already hidden a load-bearing guard in this repository. They are
    # not the same check. The inner one is correctness under a race no test can stage; the OUTER one
    # is the reason this hook does not take an ordered lock before every prompt, and holding the lock
    # from another process is what makes its absence visible.
    $lockHolderScript = Join-Path $hookWorkspace 'hold-registry-lock.ps1'
    [IO.File]::WriteAllText($lockHolderScript, @'
param([string]$ToolsPath, [string]$Workspace, [string]$Sentinel, [int]$Seconds)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $ToolsPath 'LibrarySeat.ps1')
$lock = Enter-SeatRegistryLock -Workspace $Workspace -TimeoutSeconds 20
[IO.File]::WriteAllText($Sentinel, 'held', [Text.UTF8Encoding]::new($false))
Start-Sleep -Seconds $Seconds
Exit-BookLock -Lock $lock
'@, $utf8)
    $lockSentinel = Join-Path $hookWorkspace 'registry-lock-held.txt'
    $lockHolder = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $lockHolderScript,
        '-ToolsPath', $PSScriptRoot, '-Workspace', $hookWorkspace, '-Sentinel', $lockSentinel, '-Seconds', '12')
    [void]$dummies.Add($lockHolder)
    $lockBy = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $lockBy -and -not (Test-Path -LiteralPath $lockSentinel -PathType Leaf)) { Start-Sleep -Milliseconds 100 }
    Assert-True (Test-Path -LiteralPath $lockSentinel -PathType Leaf) 'the fixture could not get another process to hold the registry lock, so the three assertions below would prove nothing'

    # THE CONTROL FIRST. A conversation that genuinely needs writing must CONTEND and lose, or the
    # two assertions after it are passing because the lock was never held at all.
    $contended = $false
    try { Update-SeatConversationRecord -Workspace $hookWorkspace -StateDirectory $hookState -Seat 'omega' -AgentProcessId $deskAgent.Id -SessionId 'conv-needs-the-lock' -DeadlineSeconds 1 | Out-Null }
    catch { $contended = $true }
    Assert-True $contended 'a record that had to be written did not contend for the held registry lock, so the lock was not actually held'
    Assert-Equal 'conv-desk-third' ([string](Read-SeatBinding -StateDirectory $hookState -Seat 'omega').session_id) 'a record refused for want of the lock was written anyway'
    # NOW THE TWO FAST PATHS, each answering without the lock.
    Assert-Equal 'already-recorded' ([string](Update-SeatConversationRecord -Workspace $hookWorkspace -StateDirectory $hookState -Seat 'omega' -AgentProcessId $deskAgent.Id -SessionId 'conv-desk-third' -DeadlineSeconds 1)) 'a conversation already on the binding waited for the registry lock to say so'
    Assert-Equal 'not-this-agent' ([string](Update-SeatConversationRecord -Workspace $hookWorkspace -StateDirectory $hookState -Seat 'omega' -AgentProcessId ([int]$deskAgent.Id + 100000) -SessionId 'conv-foreign' -DeadlineSeconds 1)) 'a record for another agent''s binding waited for the registry lock to refuse it'
    Stop-Process -Id $lockHolder.Id -Force -ErrorAction SilentlyContinue
    try { [void]$lockHolder.WaitForExit(15000) } catch { }

    # ORPHANED: the state a bare seat name hides. Kill the HOLDER, not the agent.
    Stop-Process -Id ([int](Read-SeatHolderAttempt -StateDirectory $hookState -Seat 'omega').holder_pid) -Force -ErrorAction SilentlyContinue
    Wait-SeatFree 'omega'
    $orphanLine = Invoke-DeskHook 'conv-desk-renamed' $deskAgent.Id
    Assert-True ($orphanLine.Context.Contains('holder lost')) "an orphaned seat read as an ordinary bound one: $($orphanLine.Context)"
    Assert-True ($orphanLine.Context.Contains('every write will refuse')) 'the orphaned Desk line did not say what it costs'
    Assert-True ($orphanLine.Context.Contains('Enter-LibrarySeat.ps1 -Seat omega')) 'the orphaned Desk line did not name the fix'
    # THE BOOKS AND PROJECTS ARE STILL THERE. An orphaned seat reads normally, and a line that dropped
    # the Desk to deliver a warning would take away what the hook exists for.
    Assert-True ($orphanLine.Context.Contains('Books:') -and $orphanLine.Context.Contains('Projects:')) 'the orphaned Desk line lost the Desk'

    # NAMED BY THE ENVIRONMENT IS ITS OWN ANSWER, not the same sentence as a verified binding: a
    # resumed conversation cannot find this seat again, because nothing recorded it. Driven through
    # LIBRARY_SEAT itself rather than through -Seat, because the environment route is the one a
    # LAUNCHER-started session actually takes -- and the first version of this case passed an
    # explicit -Seat, which is a different `source` and was reported by a branch this case never
    # reached. The two are worded apart now, and both are asserted.
    $env:LIBRARY_SEAT = 'tau'
    try { $environmentLine = Invoke-DeskHook 'conv-desk-env' 0 }
    finally { $env:LIBRARY_SEAT = '' }
    Assert-True ($environmentLine.Context.Contains('named by LIBRARY_SEAT and not bound to this conversation')) "a seat inherited from the environment was reported as bound: $($environmentLine.Context)"
    $explicitLine = Invoke-DeskHook 'conv-desk-explicit' 0 'tau'
    Assert-True ($explicitLine.Context.Contains('named explicitly and not bound to this conversation')) "a one-shot -Seat run was reported as bound: $($explicitLine.Context)"
    Stop-Process -Id $deskAgent.Id -Force -ErrorAction SilentlyContinue

    # --- 18. WHICH AGENT A PROCESS BELONGS TO, BY ANCESTRY (plan step 11) -------------------------
    #
    # THE ROUTE THE VALIDATED READER ADAPTER RUNS ON. `CLAUDE_PID` reaches tool and hook children and
    # never an MCP server (step 0b), so the adapter's only identity is its own parent chain -- and
    # until 2026-09-10 it had none, resolved `unset`, and refused every page at a seat its guards
    # agreed was open. `desk.two-seat-acceptance` section 7 proves the attachment end to end; this
    # case proves the identity underneath it, one route at a time.
    #
    # REAL PROCESSES FOR THE ROUTES, A CAPTURED CHAIN FOR THE STOP RULES. The stand-ins are copies of
    # powershell.exe named after each client, so the detector matches for the real reason: the image
    # name genuinely is a client's, reported by the same CIM read production uses. The reuse, depth
    # and self-parent rules have no live case that can be staged on demand, so they are driven over
    # the chain those same probes CAPTURED, with exactly one field changed per case.
    $probeDir = Join-Path $fixture 'agent-probe'
    New-Item -ItemType Directory -Path $probeDir -Force | Out-Null
    $realPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $probeScript = Join-Path $probeDir 'probe-agent.ps1'
    $spawnScript = Join-Path $probeDir 'spawn-probe.ps1'

    # A here-string's closing delimiter sits at column 0 even inside an indented block.
    [IO.File]::WriteAllText($probeScript, @'
# Reports what THIS process resolves as its agent, and the chain it walked to get there. Run only by
# case 18 of seat.lifecycle, as a child of a stand-in client.
param([string]$Schema, [string]$Out)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. $Schema
# NEITHER IDENTITY VARIABLE, which is what a real MCP server has (step 0b). Cleared so a pass here
# cannot be CLAUDE_PID answering, and so Resolve-CurrentAgentProcess reports the ancestry route.
$env:CLAUDE_PID = ''
$env:LIBRARY_SEAT = ''
$live = Resolve-AgentClientProcess
$route = Resolve-CurrentAgentProcess
$rows = [Collections.Generic.List[object]]::new()
$current = Get-ProcessAncestryRecord -ProcessId $PID
$steps = 0
while ($null -ne $current -and $steps -le 12) {
    $created = ''
    if ($null -ne $current.created_utc) { $created = ([DateTime]$current.created_utc).ToString('o') }
    [void]$rows.Add([pscustomobject]@{
        pid = [int]$current.pid; parent_pid = [int]$current.parent_pid
        name = [string]$current.name; created_utc = $created })
    if ([int]$current.parent_pid -le 0) { break }
    $current = Get-ProcessAncestryRecord -ProcessId ([int]$current.parent_pid)
    $steps++
}
$payload = [ordered]@{
    own_pid = $PID
    live_agent_pid = [int]$live.agent_pid
    live_agent_name = [string]$live.agent_name
    live_depth = [int]$live.depth
    live_stopped = [string]$live.stopped
    live_chain = @($live.chain)
    route = [string]$route.route
    route_agent_pid = [int]$route.agent_pid
    rows = @($rows)
}
[IO.File]::WriteAllText($Out, (([pscustomobject]$payload) | ConvertTo-Json -Depth 6),
    (New-Object System.Text.UTF8Encoding($false)))
'@, $utf8)

    [IO.File]::WriteAllText($spawnScript, @'
# Run BY a stand-in client, so every probe it starts has that client for a parent or grandparent.
# -OutList is semicolon-separated on purpose: an array argument crosses `powershell.exe -File` as one
# string, so a [string[]] parameter here would receive every path joined together.
param([string]$Probe, [string]$Schema, [string]$OutList, [int]$Extra = 0)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$children = [Collections.Generic.List[object]]::new()
foreach ($out in @($OutList -split ';' | Where-Object { $_ })) {
    if ($Extra -gt 0) {
        # One ordinary shell between the client and the probe. The measured Orca chain has exactly
        # that shape -- claude.exe under powershell.exe -EncodedCommand -- so the walk has to cross a
        # non-client process rather than only inspect its immediate parent.
        $inner = ('& "{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}" -Schema "{2}" -Out "{3}"' -f $ps, $Probe, $Schema, $out)
        [void]$children.Add((Start-Process -FilePath $ps -PassThru -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner)))
    }
    else {
        [void]$children.Add((Start-Process -FilePath $ps -PassThru -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Probe, '-Schema', $Schema, '-Out', $out)))
    }
}
foreach ($child in $children) { [void]$child.WaitForExit(120000) }
'@, $utf8)

    $schemaPath = Join-Path $PSScriptRoot 'BookRootSchema.ps1'
    function New-StandInClient([string]$Directory, [string]$ImageName) {
        # ITS OWN DIRECTORY PER NAME. NTFS collapses case-variant filenames in one directory, so
        # `claude.exe` and `Claude.exe` beside each other would be ONE file and the cased case would
        # silently re-test the lowercase one.
        $clientHome = Join-Path $probeDir $Directory
        New-Item -ItemType Directory -Path $clientHome -Force | Out-Null
        $exe = Join-Path $clientHome $ImageName
        Copy-Item -LiteralPath $realPowerShell -Destination $exe -Force
        $exe
    }
    function Invoke-AgentProbe([string]$StandIn, [string[]]$Names, [int]$Extra = 0) {
        $outputs = @($Names | ForEach-Object { Join-Path $probeDir ($_ + '.json') })
        foreach ($output in $outputs) { if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force } }
        $client = Start-Process -FilePath $StandIn -PassThru -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $spawnScript,
            '-Probe', $probeScript, '-Schema', $schemaPath, '-OutList', ($outputs -join ';'), '-Extra', ([string]$Extra))
        [void]$dummies.Add($client)
        [void]$client.WaitForExit(180000)
        $answers = [ordered]@{}
        foreach ($index in 0..($outputs.Count - 1)) {
            $raw = ''
            if (Test-Path -LiteralPath $outputs[$index] -PathType Leaf) { $raw = [IO.File]::ReadAllText($outputs[$index]) }
            $answers[$Names[$index]] = if ([string]::IsNullOrWhiteSpace($raw)) { $null } else { $raw | ConvertFrom-Json }
        }
        [pscustomobject]@{ client_pid = [int]$client.Id; answers = $answers }
    }

    # THE DECLARATION, BOTH WAYS. A literal expected set rather than one derived from the declaration:
    # deriving it would mean dropping `codex.exe` from the code also drops its case, leaving the suite
    # green over a reader the Library had just started refusing.
    $declaredClients = @(Get-AgentClientProcessNames)
    Assert-Equal 'claude.exe,codex.exe' ((@($declaredClients) | Sort-Object) -join ',') 'the declared agent client names are not the two measured ones'

    # ROUTE 1: claude.exe as the immediate parent. The measured shape for the Claude Librarian's
    # adapter -- powershell.exe under claude.exe, read live from the process tree on 2026-09-10.
    $claudeStandIn = New-StandInClient 'claude-home' 'claude.exe'
    $claudeProbe = Invoke-AgentProbe $claudeStandIn @('claude-direct')
    $claudeAnswer = $claudeProbe.answers['claude-direct']
    Assert-True ($null -ne $claudeAnswer) 'the probe under a claude.exe stand-in produced no answer at all, so nothing below tests what it claims to'
    Assert-Equal ([string]$claudeProbe.client_pid) ([string]$claudeAnswer.live_agent_pid) 'a probe under a claude.exe parent did not resolve that process as its agent'
    Assert-Equal 'claude.exe' ([string]$claudeAnswer.live_agent_name) 'the resolved agent was not the claude.exe stand-in'
    Assert-Equal '1' ([string]$claudeAnswer.live_depth) 'an immediate client parent was not found at depth 1'
    Assert-Equal 'found' ([string]$claudeAnswer.live_stopped) 'the walk under a claude.exe parent did not report finding a client'
    # THE ROUTE, NOT ONLY THE ANSWER. With CLAUDE_PID cleared the resolver must say `parent-chain`; a
    # `environment-pid` here would mean the probe inherited a variable and proved nothing.
    Assert-Equal 'parent-chain' ([string]$claudeAnswer.route) 'the agent was resolved by the environment rather than by ancestry, so this case did not test the walk'
    Assert-Equal ([string]$claudeProbe.client_pid) ([string]$claudeAnswer.route_agent_pid) 'the ancestry route and the walk disagreed about the agent'

    # ROUTE 2: codex.exe. ITS OWN CASE, because a parent-name test written for claude.exe alone
    # refuses the Codex Librarian's reader outright -- and its adapter carries neither CLAUDECODE nor
    # LIBRARY_SEAT, so there is nothing else for it to fall back on.
    $codexStandIn = New-StandInClient 'codex-home' 'codex.exe'
    $codexProbe = Invoke-AgentProbe $codexStandIn @('codex-direct')
    $codexAnswer = $codexProbe.answers['codex-direct']
    Assert-True ($null -ne $codexAnswer) 'the probe under a codex.exe stand-in produced no answer at all'
    Assert-Equal ([string]$codexProbe.client_pid) ([string]$codexAnswer.live_agent_pid) 'a probe under a codex.exe parent did not resolve that process as its agent'
    Assert-Equal 'codex.exe' ([string]$codexAnswer.live_agent_name) 'the resolved agent was not the codex.exe stand-in'
    Assert-Equal 'parent-chain' ([string]$codexAnswer.route) 'the Codex route was answered by the environment rather than by ancestry'

    # ROUTE 3: A CLIENT SHIPPED WITH DIFFERENT CASING. A real process, really named `Claude.exe`, and
    # really reported that way by Win32_Process -- so the hazard is measured rather than imagined. A
    # Windows image name is the vendor's to case, and a case-sensitive test would refuse this reader
    # completely while the file system launched it happily.
    $casedStandIn = New-StandInClient 'cased-home' 'Claude.exe'
    $casedProbe = Invoke-AgentProbe $casedStandIn @('claude-cased')
    $casedAnswer = $casedProbe.answers['claude-cased']
    Assert-True ($null -ne $casedAnswer) 'the probe under a Claude.exe stand-in produced no answer at all'
    # WINDOWS' OWN REPORT, read off the chain the probe captured rather than off the resolution, so
    # this control cannot be satisfied or broken by the matcher it exists to test.
    Assert-Equal 'Claude.exe' ([string]@($casedAnswer.rows)[1].name) 'Windows did not report the cased stand-in verbatim, so this case cannot test the casing rule'
    Assert-Equal ([string]$casedProbe.client_pid) ([string]$casedAnswer.live_agent_pid) 'a client shipped as Claude.exe was not recognised -- and a case-sensitive match does not merely refuse it, it walks PAST it to whatever client sits higher in the chain and serves that agent''s seat'
    Assert-Equal 'Claude.exe' ([string]$casedAnswer.live_agent_name) 'the cased stand-in was not the client the walk resolved'

    # ROUTE 4: A SHELL BETWEEN THEM. The measured Orca chain is claude.exe under
    # powershell.exe -EncodedCommand, so a walk that only ever inspected its immediate parent would
    # answer for the adapter and for nothing else.
    $nestedProbe = Invoke-AgentProbe $claudeStandIn @('claude-nested') 1
    $nestedAnswer = $nestedProbe.answers['claude-nested']
    Assert-True ($null -ne $nestedAnswer) 'the grandchild probe produced no answer at all'
    Assert-Equal ([string]$nestedProbe.client_pid) ([string]$nestedAnswer.live_agent_pid) 'a probe two steps below its client did not find it'
    Assert-Equal '2' ([string]$nestedAnswer.live_depth) 'a client two steps up was not found at depth 2'

    # TWO ADAPTERS, ONE AGENT. Measured live on 2026-09-10: one claude.exe had two validated-reader
    # instances at once. Nothing may assume one per agent, so both must answer the same agent.
    $pairProbe = Invoke-AgentProbe $claudeStandIn @('pair-one', 'pair-two')
    $pairOne = $pairProbe.answers['pair-one']
    $pairTwo = $pairProbe.answers['pair-two']
    Assert-True ($null -ne $pairOne -and $null -ne $pairTwo) 'the paired probes did not both answer, so the one-agent-many-adapters case proves nothing'
    Assert-True ([int]$pairOne.own_pid -ne [int]$pairTwo.own_pid) 'the two probes were the same process, so this case did not test two adapters at all'
    Assert-Equal ([string]$pairProbe.client_pid) ([string]$pairOne.live_agent_pid) 'the first of two adapters under one client resolved the wrong agent'
    Assert-Equal ([string]$pairProbe.client_pid) ([string]$pairTwo.live_agent_pid) 'the second of two adapters under one client resolved the wrong agent'

    # --- 18b. THE STOP RULES, OVER THE CHAIN THE PROBE CAPTURED -----------------------------------
    #
    # CAPTURED INPUT, ONE FIELD CHANGED PER CASE. The rows are real: real pids, real image names, real
    # creation times, read by the same CIM function the live walk uses. A fixture that invented them
    # would prove only that the walk agrees with the fixture.
    $capturedRows = @($claudeAnswer.rows)
    Assert-True ($capturedRows.Count -ge 2) 'the probe captured no chain, so the stop rules below have nothing real to run against'
    function New-CapturedRecord($Row) {
        $created = $null
        if (-not [string]::IsNullOrWhiteSpace([string]$Row.created_utc)) {
            $created = [DateTime]::Parse([string]$Row.created_utc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
        }
        # THROUGH THE PRODUCTION CONSTRUCTOR, so a record shape that changes takes this with it.
        New-ProcessAncestryRecord -ProcessId ([int]$Row.pid) -ParentProcessId ([int]$Row.parent_pid) -Name ([string]$Row.name) -CreatedUtc $created
    }
    # TWO ROWS AND NO MORE: the probe and its client, with the client rooted. The full captured chain
    # continues up into whatever launched this gate -- which on a Claude-run gate is a REAL
    # claude.exe -- so a negative case built on it would find that one and pass for the wrong reason.
    $probeRow = New-CapturedRecord $capturedRows[0]
    $clientRow = New-CapturedRecord $capturedRows[1]
    Assert-Equal 'claude.exe' ([string]$clientRow.name) 'the second captured row is not the stand-in client, so the staged cases below are staging the wrong process'
    function Invoke-CapturedWalk($Probe, $Client, [int]$MaxDepth = -1) {
        $table = @{}
        foreach ($record in @($Probe, $Client)) { if ($null -ne $record) { $table[[int]$record.pid] = $record } }
        $provider = { param([int]$Id) if ($table.ContainsKey($Id)) { $table[$Id] } else { $null } }.GetNewClosure()
        Resolve-AgentClientProcess -ProcessId ([int]$Probe.pid) -MaxDepth $MaxDepth -RecordProvider $provider
    }
    function New-RootedClient([string]$Name, $CreatedUtc) {
        New-ProcessAncestryRecord -ProcessId ([int]$clientRow.pid) -ParentProcessId 0 -Name $Name -CreatedUtc $CreatedUtc
    }
    # THE CONTROL. Real rows, nothing changed but the client's parent id cleared: it must resolve, or
    # every negative below is negative for a reason the case never states.
    $baseline = Invoke-CapturedWalk $probeRow (New-RootedClient ([string]$clientRow.name) $clientRow.created_utc)
    Assert-Equal 'found' ([string]$baseline.stopped) 'the captured chain did not resolve at all, so the staged cases below prove nothing'
    Assert-Equal ([string]$clientRow.pid) ([string]$baseline.agent_pid) 'the captured chain resolved a different process than the live walk did'
    # AND THE SEAM IS HONEST: the captured walk and the live one agree, so testing through a provider
    # is testing the same code path production runs.
    Assert-Equal ([string]$claudeAnswer.live_agent_pid) ([string]$baseline.agent_pid) 'the walk over captured rows disagreed with the live walk over the same processes'

    # NOT A CLIENT: the chain runs out and nothing is resolved. Fail-closed, and the seatless refusal
    # is what the reader then gets.
    $notAClient = Invoke-CapturedWalk $probeRow (New-RootedClient 'notaclient.exe' $clientRow.created_utc)
    Assert-Equal 'no-parent' ([string]$notAClient.stopped) 'a chain with no client in it did not run out'
    Assert-Equal '0' ([string]$notAClient.agent_pid) 'a chain with no client in it resolved an agent anyway'

    # CASED, over the captured row rather than a second stand-in: the same rule, asserted where a
    # `-ceq` would show up as this line alone going red.
    $casedRow = Invoke-CapturedWalk $probeRow (New-RootedClient ([string]$clientRow.name).ToUpperInvariant() $clientRow.created_utc)
    Assert-Equal 'found' ([string]$casedRow.stopped) 'a client whose image name is cased differently was not recognised'

    # A PARENT THAT STARTED AFTER ITS CHILD IS A REUSED PID. The one case that decides whether an
    # adapter outliving its client can attach to a DIFFERENT agent's binding, and the walk must stop
    # rather than accept it.
    $reusedCreated = ([DateTime]$probeRow.created_utc).AddMinutes(1)
    $reused = Invoke-CapturedWalk $probeRow (New-RootedClient ([string]$clientRow.name) $reusedCreated)
    Assert-Equal 'parent-reused' ([string]$reused.stopped) 'a client that started AFTER its own child was accepted as that child''s agent'
    Assert-Equal '0' ([string]$reused.agent_pid) 'a reused parent pid resolved an agent'

    # THE PARENT IS GONE. Its row is not in the table at all, which is what an exited client looks
    # like: "I cannot tell" resolves nothing rather than falling through to something else.
    $gone = $null; $goneFault = ''
    try { $gone = Invoke-CapturedWalk $probeRow $null } catch { $goneFault = $_.Exception.Message }
    Assert-Equal 'parent-gone' $(if ($null -ne $gone) { [string]$gone.stopped } else { "threw: $goneFault" }) 'a chain whose parent could not be read did not report it'
    Assert-Equal '0' $(if ($null -ne $gone) { [string]$gone.agent_pid } else { 'threw' }) 'an unreadable parent resolved an agent'

    # A PROCESS THAT IS ITS OWN PARENT, which is how a truncated or recycled record can read.
    $selfParent = New-ProcessAncestryRecord -ProcessId ([int]$probeRow.pid) -ParentProcessId ([int]$probeRow.pid) -Name ([string]$probeRow.name) -CreatedUtc $probeRow.created_utc
    $looped = Invoke-CapturedWalk $selfParent (New-RootedClient ([string]$clientRow.name) $clientRow.created_utc)
    Assert-Equal 'self-parent' ([string]$looped.stopped) 'a process recorded as its own parent did not stop the walk'

    # THE DEPTH BOUND, asserted by its own signal rather than by the absence of an answer: the same
    # chain that resolves at depth 1 must report `depth` when no step is allowed.
    $bounded = Invoke-CapturedWalk $probeRow (New-RootedClient ([string]$clientRow.name) $clientRow.created_utc) 0
    Assert-Equal 'depth' ([string]$bounded.stopped) 'a walk allowed no steps did not report its bound'
    Assert-Equal '0' ([string]$bounded.agent_pid) 'a walk allowed no steps resolved an agent anyway'

    # AND A START PROCESS THAT DOES NOT EXIST. Its own signal, because "gone before the first step"
    # and "gone during the walk" are different faults and only one of them is about the parent.
    $startGone = $null; $startGoneFault = ''
    try { $startGone = Resolve-AgentClientProcess -ProcessId ([int]$probeRow.pid) -RecordProvider { param([int]$Id) $null } }
    catch { $startGoneFault = $_.Exception.Message }
    Assert-Equal 'start-gone' $(if ($null -ne $startGone) { [string]$startGone.stopped } else { "threw: $startGoneFault" }) 'a walk from a process that could not be read did not say so'


    # --- 18c. THE CACHE IS CONSULTED, AND IT IS REVALIDATED ---------------------------------------
    #
    # A two-step walk costs about 42ms against 1.6ms to re-read one process's start time (measured
    # 2026-09-10), and the adapter runs this on every request, so the answer is held for the
    # process's lifetime. What makes holding it safe is that the CLIENT's identity is re-read every
    # call: a pid whose process has been replaced must stop answering. Neither half has a live case
    # that can be produced on demand, so both are staged by planting a DECOY in the cache -- a
    # plausible live pid exactly where bad code looks, rather than an absence.
    $savedAgentEnvironment = $env:CLAUDE_PID
    $savedAgentCache = $script:CurrentAgentProcessCache
    try {
        # CLEARED, or the environment route answers before the cache is ever read and both cases
        # below would pass against a cache nothing consults.
        $env:CLAUDE_PID = ''
        $cacheClient = Start-Process -FilePath $claudeStandIn -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240')
        [void]$dummies.Add($cacheClient)
        $cacheIdentity = [string](Get-AgentProcessIdentity -ProcessId $cacheClient.Id)
        Assert-True (-not [string]::IsNullOrWhiteSpace($cacheIdentity) -and $cacheIdentity -cne 'unreadable') 'the cache stand-in has no readable start time, so neither case below tests the revalidation'

        # CONSULTED: a cached pid whose identity still matches is answered without a walk. THIS
        # process is not a descendant of that stand-in, so nothing but the cache can produce it.
        $script:CurrentAgentProcessCache = [pscustomobject]@{ agent_pid = [int]$cacheClient.Id; identity = $cacheIdentity }
        $fromCache = Resolve-CurrentAgentProcess
        Assert-Equal ([string]$cacheClient.Id) ([string]$fromCache.agent_pid) 'a cached agent whose identity still matched was not used, so every reader request pays for a fresh walk'
        Assert-Equal 'parent-chain' ([string]$fromCache.route) 'a cached ancestry answer was reported as coming from somewhere else'

        # REVALIDATED: the same LIVE pid with a wrong recorded identity is what a reused pid looks
        # like, and it must be discarded and re-walked rather than answered. Without this the adapter
        # could keep serving one agent's seat after its client died and another took its number.
        $script:CurrentAgentProcessCache = [pscustomobject]@{ agent_pid = [int]$cacheClient.Id; identity = '2000-01-01T00:00:00.0000000Z' }
        $revalidated = Resolve-CurrentAgentProcess
        Assert-True ([int]$revalidated.agent_pid -ne [int]$cacheClient.Id) "a cached agent whose process had been replaced kept answering: $([int]$revalidated.agent_pid)"
        Assert-True ($null -eq $script:CurrentAgentProcessCache -or [int]$script:CurrentAgentProcessCache.agent_pid -ne [int]$cacheClient.Id) 'a cache entry that failed revalidation was left in place'
        Stop-Process -Id $cacheClient.Id -Force -ErrorAction SilentlyContinue
    }
    finally {
        $env:CLAUDE_PID = $savedAgentEnvironment
        $script:CurrentAgentProcessCache = $savedAgentCache
    }
    # --- 19. THE TERMINAL PICKER: the roster, the grammar, and every route it offers --------------
    #
    # `PLAN-seat-launch.md` step 12. `Start-LibrarySeat.ps1` with NO -Seat is a numbered picker: the
    # route beside the one-click one, for a session with hooks disabled, a non-Orca terminal, or a
    # recovery. It decides where to sit and nothing else -- the claim, the creation gate and the
    # retirement gate all stay where they were -- so what is measured here is the roster it shows,
    # the grammar it accepts, and that each route reaches the gate that owns it.
    #
    # ITS OWN SEATS, ITS OWN PROJECTS AND ITS OWN TRANSCRIPT TREE. Every subject below is created
    # here and touched by no earlier case: the two-seat suite renaming a Book out from under a later
    # section, on 2026-09-10, is what that rule cost to learn.
    #
    # SIX WAYS A TITLE CAN BE MISSING, EACH WITH ITS OWN SEAT. An old client wrote none, the
    # transcript is elsewhere, the id is not an id, the file will not open, the head budget ran out,
    # nothing recorded a conversation at all. They are different facts about the same blank column,
    # and a single "no title" would let five of them break while the sixth kept this green.
    $pickerProjects = Join-Path $fixture 'picker-transcripts'
    $pickerTranscriptDirectory = Join-Path $pickerProjects 'D--Fixture'
    New-Item -ItemType Directory -Path $pickerTranscriptDirectory -Force | Out-Null

    function New-PickerTranscript([string]$SessionId, [string[]]$Lines) {
        $transcriptPath = Join-Path $pickerTranscriptDirectory "$SessionId.jsonl"
        [IO.File]::WriteAllText($transcriptPath, ((@($Lines) -join "`n") + "`n"), $utf8)
        $transcriptPath
    }
    function Get-PickerRow($Rows, [string]$Seat) {
        $matched = @(@($Rows) | Where-Object { [string]$_.seat -ceq $Seat })
        if ($matched.Count -ne 1) { throw "the picker roster carries $($matched.Count) rows for seat '$Seat', not one" }
        $matched[0]
    }
    # THE NUMBER IS READ OFF THE RENDERED LINE, never assumed. The reader types what the list shows,
    # and earlier cases have left their own seats in this registry -- so a hardcoded 1 would be
    # asserting against whatever sorted first today.
    # THE NUMBER A SEAT CARRIES, IN EITHER LAYOUT. The table writes `  7  seat`, and the card writes
    # `   7 o seat` -- a state mark between the number and the name. The optional `\S\s+` is that
    # mark, and it is optional rather than two patterns because the thing being asserted is the
    # NUMBER, which both layouts agree on. Pinned both ways on 2026-09-11 against real rendered
    # lines, including that the loosened anchor still refuses a different seat's line.
    function Get-PickerNumber($Run, [string]$Seat) {
        foreach ($rendered in @($Run.Stdout)) {
            if ($rendered -cmatch ('^\s+(\d+)\s+(?:\S\s+)?' + [regex]::Escape($Seat) + '\s')) { return [int]$Matches[1] }
        }
        0
    }
    # -Command RATHER THAN -File, and that is measured rather than stylistic: a [string[]] argument
    # crosses -File as ONE string, so @('n1','q') would arrive as the single answer "n1 q" and the
    # case would fail at a question the picker never asked.
    function Invoke-PickerRun([string[]]$Answers, [string[]]$Extra) {
        $literal = ''
        if (@($Answers).Count) {
            $quoted = @(@($Answers) | ForEach-Object { "'" + ([string]$_).Replace("'", "''") + "'" })
            $literal = " -PickerInput @(" + ($quoted -join ',') + ")"
        }
        $line = "& '" + (Join-Path $PSScriptRoot 'Start-LibrarySeat.ps1') + "' -WorkspacePath '$fixture'" +
                " -TranscriptRoot '$pickerProjects' -TerminalHandle ''" + $literal + ' ' + (@($Extra) -join ' ')
        $old = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $emitted = @()
        try { $emitted = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $line 2>&1) }
        finally { $ErrorActionPreference = $old }
        $code = $LASTEXITCODE
        $out = @($emitted | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
        $err = @($emitted | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
        [pscustomobject]@{
            ExitCode = $code; Stdout = $out; Stderr = $err
            Text = (((@($out) + @($err)) -join ' ') -replace '\s+', ' ')
        }
    }

    $titledConversation = [guid]::NewGuid().ToString()
    $untitledConversation = [guid]::NewGuid().ToString()
    $missingConversation = [guid]::NewGuid().ToString()
    $longConversation = [guid]::NewGuid().ToString()
    $lockedConversation = [guid]::NewGuid().ToString()
    # THE CONVERSATION THIS LAUNCHER MINTED AND THE READER NEVER TYPED INTO (2026-09-11). No
    # transcript is written for it, exactly as Claude Code writes none until a first turn -- so it is
    # `missingConversation`'s twin in every respect but one, and that one is `conversations.json`.
    $emptyConversation = [guid]::NewGuid().ToString()
    New-PickerTranscript $titledConversation @(
        '{"type":"mode","mode":"normal"}',
        '{"type":"user","message":{"role":"user","content":"a first turn"}}',
        ('{"type":"ai-title","aiTitle":"Picker roster subject","sessionId":"' + $titledConversation + '"}')) | Out-Null
    New-PickerTranscript $untitledConversation @('{"type":"mode","mode":"normal"}', '{"type":"user"}') | Out-Null
    New-PickerTranscript $longConversation @(@(1..($script:SeatTranscriptLineBudget + 100)) | ForEach-Object { '{"type":"user"}' }) | Out-Null
    $lockedTranscript = New-PickerTranscript $lockedConversation @('{"type":"mode","mode":"normal"}')

    foreach ($pair in @(
        @{ seat = 'pick-titled';  project = 'pick-titled-proj' },
        @{ seat = 'pick-bare';    project = 'pick-bare-proj' },
        @{ seat = 'pick-binding'; project = 'pick-binding-proj' },
        @{ seat = 'pick-gone';    project = 'pick-gone-proj' },
        @{ seat = 'pick-empty';   project = 'pick-empty-proj' },
        @{ seat = 'pick-bad';     project = 'pick-bad-proj' },
        @{ seat = 'pick-long';    project = 'pick-long-proj' },
        @{ seat = 'pick-locked';  project = 'pick-locked-proj' },
        @{ seat = 'pick-orphan';  project = 'pick-orphan-proj' },
        @{ seat = 'pick-retire';  project = 'pick-retire-proj' })) {
        Initialize-SeatForFixture -StateDirectory $stateDir -Seat ([string]$pair.seat) -Project ([string]$pair.project) `
            -OpenProjects @("projects/$([string]$pair.project)") | Out-Null
    }

    # THE ADVISORY RECORDS, written by the helper that writes them in production rather than as JSON
    # this suite composes: a fixture that invents its input proves the code agrees with the fixture.
    Write-SeatActivity -StateDirectory $stateDir -Seat 'pick-titled' -Note 'seat entered' -Conversation $titledConversation | Out-Null
    Write-SeatActivity -StateDirectory $stateDir -Seat 'pick-gone' -Note 'seat entered' -Conversation $missingConversation | Out-Null
    Write-SeatActivity -StateDirectory $stateDir -Seat 'pick-long' -Note 'seat entered' -Conversation $longConversation | Out-Null
    Write-SeatActivity -StateDirectory $stateDir -Seat 'pick-locked' -Note 'seat entered' -Conversation $lockedConversation | Out-Null
    Write-SeatActivity -StateDirectory $stateDir -Seat 'pick-empty' -Note 'seat entered' -Conversation $emptyConversation | Out-Null
    # A MALFORMED ID IS PLANTED AS A FILE, because Write-SeatActivity is not the thing being tested
    # here -- anything with write access to `.claude` can author this record, and the picker composes
    # what it finds into a path and into `claude --resume`.
    $badActivityPath = Get-SeatActivityPath -StateDirectory $stateDir -Seat 'pick-bad'
    [IO.File]::WriteAllText($badActivityPath, (([pscustomobject]@{
        advisory = 'ADVICE ONLY.'; seat = 'pick-bad'; last_seen_utc = [DateTime]::UtcNow.ToString('o')
        note = 'planted'; session_id = '../../etc/passwd'; conversation_recorded_utc = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 4) + "`n"), $utf8)

    # A BINDING WHOSE AGENT IS GONE. That is what a seat looks like after the conversation that bound
    # it ended: `free`, and still remembering which conversation it was. The picker must read that
    # record without checking liveness, which is the whole reason a resume can find a dead seat.
    $goneAgent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 2') -PassThru -WindowStyle Hidden
    $goneAgentStart = Get-AgentProcessIdentity -ProcessId $goneAgent.Id
    Stop-Process -Id $goneAgent.Id -Force -ErrorAction SilentlyContinue
    $goneAgent.WaitForExit(5000) | Out-Null
    # AND ONE SEAT WHOSE AGENT IS STILL ALIVE with no claim handle: `orphaned`, which is the only
    # state that renders a NOTE beside itself -- and therefore the only row that can push the columns
    # after it out of line. Without it the alignment assertion below passes for the wrong reason: every
    # state cell is four characters wide and any width at all lines them up.
    $orphanAgent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
    [void]$dummies.Add($orphanAgent)
    $bindingLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat 'pick-binding' `
            -AgentProcessId ([int]$goneAgent.Id) -AgentStartUtc $goneAgentStart -SessionId $untitledConversation `
            -SeatId 'pick-binding-id' -State 'committed' | Out-Null
        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat 'pick-orphan' `
            -AgentProcessId ([int]$orphanAgent.Id) -SessionId $missingConversation -SeatId 'pick-orphan-id' -State 'committed' | Out-Null
        # THE PROVENANCE THAT SEPARATES `pick-empty` FROM `pick-gone`, written by the helper the
        # launcher writes it with. Both seats record a conversation with no transcript; only this one
        # can be proved to have been minted in this checkout, and that is the whole difference
        # between starting it again and handing `--resume` to an agent that cannot find it.
        Write-SeatConversationRecord -Workspace $fixture -StateDirectory $stateDir -Seat 'pick-empty' `
            -SessionId $emptyConversation -SeatId 'pick-empty-id' -Source 'launcher' | Out-Null
    }
    finally { Exit-BookLock -Lock $bindingLock }

    # --- 19a. Every title status, each on its own seat --------------------------------------------
    $lockStream = [IO.FileStream]::new($lockedTranscript, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    $pickerRows = @()
    try { $pickerRows = @(Get-SeatPickerRows -StateDirectory $stateDir -TranscriptRoot $pickerProjects) }
    finally { $lockStream.Dispose() }

    $titledRow = Get-PickerRow $pickerRows 'pick-titled'
    Assert-Equal 'titled' ([string](Get-Field $titledRow 'title_status' 'the titled row')) 'a conversation with an ai-title record was not read as titled'
    Assert-Equal 'Picker roster subject' ([string]$titledRow.title) 'the roster read the wrong title off the transcript'
    Assert-Equal 'activity' ([string]$titledRow.conversation_source) 'a launcher-recorded conversation was not reported as advisory'
    Assert-Equal 'no-title' ([string](Get-PickerRow $pickerRows 'pick-binding').title_status) 'a transcript with no ai-title record was not reported as untitled'
    Assert-Equal 'binding' ([string](Get-PickerRow $pickerRows 'pick-binding').conversation_source) "a binding's own conversation was not read from the binding"
    Assert-Equal $untitledConversation ([string](Get-PickerRow $pickerRows 'pick-binding').session_id) 'the roster read the wrong conversation off the binding'
    Assert-Equal 'no-conversation' ([string](Get-PickerRow $pickerRows 'pick-bare').title_status) 'a seat nothing has recorded a conversation for did not say so'
    Assert-Equal 'no-transcript' ([string](Get-PickerRow $pickerRows 'pick-gone').title_status) 'a conversation with no transcript here was not reported as such'
    Assert-Equal 'malformed-conversation' ([string](Get-PickerRow $pickerRows 'pick-bad').title_status) 'a recorded conversation id that is not a uuid was looked up anyway'
    Assert-Equal 'budget-exhausted' ([string](Get-PickerRow $pickerRows 'pick-long').title_status) 'a transcript longer than the head budget was reported as untitled rather than unread'
    Assert-Equal 'unreadable' ([string](Get-PickerRow $pickerRows 'pick-locked').title_status) 'a transcript that could not be opened was reported as untitled'
    # THE THIRD CLAIM STATE, WITH ITS OWN NOTE. `orphaned` is the state a bare name hid until
    # 2026-09-09, so the roster says which agent is still running rather than only that the seat is
    # not free.
    $orphanRow = Get-PickerRow $pickerRows 'pick-orphan'
    Assert-Equal 'orphaned' ([string]$orphanRow.state) 'a seat whose agent is alive with no claim handle was not reported as orphaned'
    Assert-True ([string]$orphanRow.state_note).Contains("agent $([int]$orphanAgent.Id) alive") "the orphaned row did not name the agent still running: $([string]$orphanRow.state_note)"

    # AND WHAT TYPING THAT SEAT'S NUMBER WOULD DO, WHICH IS NOT THE SAME QUESTION AS WHAT IT IS
    # CALLED. Two rows here carry a conversation with no transcript and they must be answered
    # differently: one was minted by this checkout's launcher and recorded nothing, the other's
    # provenance is unknown and `claude` stays the authority on it. A detector that cannot tell them
    # apart passes one of these two whichever way it is broken.
    Assert-Equal 'restart' ([string](Get-PickerRow $pickerRows 'pick-empty').entry_action) 'a conversation this launcher minted that recorded nothing was still offered as a resume'
    Assert-Equal 'resume' ([string](Get-PickerRow $pickerRows 'pick-gone').entry_action) "a conversation of unknown provenance was restarted rather than left to the agent's own authority"
    Assert-Equal 'resume' ([string](Get-PickerRow $pickerRows 'pick-titled').entry_action) 'a conversation with a transcript was not offered as a resume'
    Assert-Equal 'resume' ([string](Get-PickerRow $pickerRows 'pick-binding').entry_action) "a binding's own conversation was not offered as a resume"
    Assert-Equal 'none' ([string](Get-PickerRow $pickerRows 'pick-bare').entry_action) 'a seat with no conversation was offered something to enter'
    Assert-Equal 'none' ([string](Get-PickerRow $pickerRows 'pick-bad').entry_action) 'a malformed conversation record was offered something to enter'
    # THE ROW SAYS SO BEFORE THE READER TYPES. The column used to carry `no transcript for it under
    # this configuration`, which is true and is not what happens when they type the number.
    $emptyCell = Format-SeatConversationCell -Row (Get-PickerRow $pickerRows 'pick-empty')
    Assert-True ($emptyCell.Contains('recorded nothing')) "the roster did not say the conversation was empty: $emptyCell"
    Assert-True ($emptyCell.Contains('(advisory)')) "an advisory record lost its label on the restart line: $emptyCell"
    # AND THE PROVENANCE TEST ITSELF, BOTH WAYS, so the row builder is not the only thing that can
    # reach it: an id in the history under `launcher` is proved, and the same id at a seat that never
    # recorded it is not.
    Assert-True (Test-SeatConversationMintedHere -StateDirectory $stateDir -Seat 'pick-empty' -SessionId $emptyConversation) 'a launcher record in this checkout was not read as provenance'
    Assert-True (-not (Test-SeatConversationMintedHere -StateDirectory $stateDir -Seat 'pick-gone' -SessionId $emptyConversation)) "one seat's launcher record was read as another seat's provenance"
    Assert-True (-not (Test-SeatConversationMintedHere -StateDirectory $stateDir -Seat 'pick-empty' -SessionId $missingConversation)) 'a conversation absent from the history was read as minted here'

    # A MALFORMED ID IS NOT OFFERED AS A RESUME EITHER. Reporting it on the line and still passing it
    # to `claude --resume` would be the same defect wearing a label.
    Assert-Equal '' ([string](Get-PickerRow $pickerRows 'pick-bad').session_id) 'a malformed conversation id was still offered as a resume target'
    Assert-Equal 'malformed' ([string](Get-PickerRow $pickerRows 'pick-bad').conversation_source) 'a record that is present and unusable was reported as no record at all'
    # AND THE TITLE READER REFUSES ONE DIRECTLY, so the status is not reachable only through the row
    # builder: a caller that hands it a malformed id must be told, not handed an empty title.
    Assert-Equal 'malformed-conversation' ([string](Get-SeatConversationTitle -TranscriptRoot $pickerProjects -SessionId '../../etc/passwd').status) 'the title reader composed a malformed conversation id into a path'
    Assert-Equal 'no-transcript-root' ([string](Get-SeatConversationTitle -TranscriptRoot (Join-Path $fixture 'no-such-transcripts') -SessionId $titledConversation).status) 'a missing transcript directory was reported as a missing transcript'
    # A REDIRECTED CLAUDE_CONFIG_DIR IS WHERE THE TRANSCRIPTS ARE. A picker that read ~/.claude
    # regardless would report "no transcript found here" for every conversation such a reader has ever
    # had -- one tool's negative standing in for absence.
    $savedConfigDirectory = $env:CLAUDE_CONFIG_DIR
    try {
        $env:CLAUDE_CONFIG_DIR = $fixture
        Assert-Equal (Join-Path $fixture 'projects') (Get-SeatTranscriptRoot) 'the transcript root ignored a redirected CLAUDE_CONFIG_DIR'
        $env:CLAUDE_CONFIG_DIR = ''
        Assert-Equal (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude\projects') (Get-SeatTranscriptRoot) 'with no CLAUDE_CONFIG_DIR the transcript root is not the default home'
    }
    finally { $env:CLAUDE_CONFIG_DIR = $savedConfigDirectory }

    # --- 19b. The rendered line never leaves the column blank -------------------------------------
    $renderedLines = @(Format-SeatPickerRows -Rows $pickerRows)
    Assert-True ($renderedLines.Count -eq $pickerRows.Count) "the roster rendered $($renderedLines.Count) lines for $($pickerRows.Count) rows"
    foreach ($row in @($pickerRows)) {
        $cell = Format-SeatConversationCell -Row $row
        Assert-True (-not [string]::IsNullOrWhiteSpace($cell)) "seat '$([string]$row.seat)' rendered a blank conversation column, which reads as an untitled conversation"
    }
    Assert-True ((Format-SeatConversationCell -Row $titledRow).Contains('"Picker roster subject" (advisory)')) 'the titled advisory row did not render its title and its source'
    # THE COLUMNS LINE UP, AND THE ROW THAT CARRIES A NOTE IS THE ONE THAT BREAKS THEM. The first
    # version measured the state column's width from `state` while rendering `state (note)`, so the
    # one row a reader most needs to read pushed every column after it out of line.
    $conversationColumns = @(@($pickerRows) | ForEach-Object {
        $line = @(Format-SeatPickerRows -Rows @($pickerRows))[[int]$_.index - 1]
        $line.IndexOf((Format-SeatConversationCell -Row $_))
    } | Sort-Object -Unique)
    Assert-Equal '1' ([string]@($conversationColumns).Count) "the roster's last column starts at $(@($conversationColumns).Count) different offsets, so a row with a note pushed the others out of line"
    Assert-True ((Format-SeatConversationCell -Row (Get-PickerRow $pickerRows 'pick-binding')) -cnotmatch 'advisory') 'a verified binding was labelled advisory'
    # A LONG TITLE IS CUT AND SAYS SO, rather than pushing the line past the terminal's width and
    # wrapping the whole roster.
    $longCell = Format-SeatConversationCell -Row ([pscustomobject]@{
        title_status = 'titled'; title = ('x' * 80); title_note = ''; conversation_source = 'binding' })
    Assert-True ($longCell.Length -le 56) "a long conversation title was not cut to the column: $($longCell.Length) characters"
    Assert-True ($longCell.Contains([string][char]0x2026)) 'a cut title did not say it was cut'

    # --- 19b-2. THE NARROW LAYOUT, WHICH THE TABLE CANNOT SERVE (2026-09-11) ----------------------
    #
    # THE TABLE'S WIDTHS ARE DERIVED FROM CONTENT, SO ONE ROW SETS THEM FOR ALL. An orphaned seat
    # carries a note, the note is parenthesised onto the state cell -- 47 characters where a healthy
    # seat's is 4 -- and the state column is then as wide as that note for every row. The fixture
    # plants exactly that row, plus the second source: a conversation cell whose title path is capped
    # at 52 characters while its entry_note path is not. No expected TOTAL is written into this case,
    # because the total is a property of whichever seats exist -- this checkout's own moved by 58
    # characters during the session that wrote these assertions.
    #
    # THE SEAT AND PROJECT SLUGS ARE DELIBERATELY DIFFERENT per row: an assertion that locates a
    # line by its seat name would otherwise match the Project field too and prove nothing about
    # where the column actually starts.
    $cardRows = @(
        [pscustomobject]@{ index = 1; seat = 'alpha-seat'; project = 'alpha-project'; state = 'held'; state_note = ''
            last_active_utc = '2026-09-11T22:25:00Z'; session_id = 'c1'; conversation_source = 'binding'
            title = 'Desk contents'; title_status = 'titled'; title_note = ''; entry_action = 'resume'; entry_note = '' }
        [pscustomobject]@{ index = 2; seat = 'beta-seat'; project = 'beta-project'; state = 'free'; state_note = ''
            last_active_utc = ''; session_id = ''; conversation_source = 'none'
            title = ''; title_status = 'no-conversation'; title_note = ''; entry_action = 'none'; entry_note = '' }
        [pscustomobject]@{ index = 3; seat = 'gamma-seat'; project = 'gamma-project'; state = 'orphaned'
            state_note = 'agent 12345 alive, claim holder gone'
            last_active_utc = '2026-09-10T19:00:00Z'; session_id = 'c3'; conversation_source = 'activity'
            title = ('y' * 90); title_status = 'titled'; title_note = ''; entry_action = 'resume'; entry_note = '' }
    )
    $cardGlyphs = Get-SeatPickerGlyphs -Ascii
    $cardPalette = Get-SeatPickerPalette
    $narrowWidth = 80
    $cardLines = @(Format-SeatPickerCards -Rows $cardRows -Width $narrowWidth -Glyphs $cardGlyphs -Palette $cardPalette)

    # THE PREMISE FIRST. If the table ever stops overflowing, this whole case is testing a fix for a
    # defect that no longer exists, and that is worth failing on rather than passing quietly.
    $tableWidest = 0
    foreach ($tableLine in @(Format-SeatPickerRows -Rows $cardRows)) {
        if ($tableLine.Length -gt $tableWidest) { $tableWidest = $tableLine.Length }
    }
    Assert-True ($tableWidest -gt 120) "the table rendered this orphan-carrying roster in $tableWidest characters, which is inside the breakpoint -- the narrow layout's premise no longer holds"

    # AN OVERFLOWING TABLE TAKES THE CARDS EVEN ON A WIDE TERMINAL, which is the second of the two
    # layout rules. The breakpoint alone fixed only the narrow half: a 106-character entry_note
    # measured on this checkout's own seats on 2026-09-11 wrapped a WIDE terminal too.
    #
    # CUTTING THE TABLE'S LAST COLUMN WAS THE FIRST FIX AND IT WAS WRONG. With the 47-character state
    # note in these very rows, the room left at 120 columns was 14 characters, and case 19f caught it
    # -- the picker stopped showing the conversation title it had just read. A table that fits by
    # deleting its content is worth less than the cards, so the overflow moves the LAYOUT instead.
    Assert-Equal 'cards' ([string](Get-SeatPickerRenderPlan -Width 200 -TableWidth 240).mode) 'a table wider than a 200-column terminal did not fall back to the cards'
    Assert-Equal 'table' ([string](Get-SeatPickerRenderPlan -Width 200 -TableWidth 180).mode) 'a table that fits a 200-column terminal was denied the dense layout'
    Assert-Equal 'table' ([string](Get-SeatPickerRenderPlan -Width 200 -TableWidth 200).mode) 'a table exactly as wide as the terminal was treated as overflowing'
    Assert-Equal 'table' ([string](Get-SeatPickerRenderPlan -Width 200 -TableWidth 0).mode) 'an unmeasured table did not fall back to the width rule alone'
    # AND THE MEASURER AGREES WITH THE RENDERER, rather than being a second opinion about it.
    $measuredTable = Measure-SeatPickerTableWidth -Rows $cardRows
    Assert-Equal ([string]$tableWidest) ([string]$measuredTable) 'the table measurer disagrees with the table renderer about its own widest line'

    # EACH RULE IS PROVED BY ITS OWN REASON, NOT BY THE SHARED ANSWER 'cards'. Both rules return the
    # same mode, so an assertion on the mode alone would stay green with the overflow rule deleted --
    # the breakpoint would answer for it. mode_reason is what tells them apart. The width here is
    # derived from the fixture rather than typed, because a literal would have to be re-guessed every
    # time the fixture's slugs or its title change.
    $overflowPlan = Get-SeatPickerRenderPlan -Width ($measuredTable - 1) -TableWidth $measuredTable
    Assert-Equal 'cards' ([string]$overflowPlan.mode) "a table of $measuredTable columns against a terminal of $($measuredTable - 1) did not fall back to the cards"
    Assert-True ([string]$overflowPlan.mode_reason -clike '*would be*') "the cards were chosen for the reason '$([string]$overflowPlan.mode_reason)' rather than by the overflow rule, so the overflow rule is proved by nothing here"
    $breakpointPlan = Get-SeatPickerRenderPlan -Width 80 -TableWidth 60
    Assert-Equal 'cards' ([string]$breakpointPlan.mode) 'an 80-column terminal was given the table even though it is under the breakpoint'
    Assert-True ([string]$breakpointPlan.mode_reason -clike '*breakpoint*') "the narrow terminal took the cards for the reason '$([string]$breakpointPlan.mode_reason)' rather than by the breakpoint rule"

    # THE ONE ASSERTION THE LAYOUT EXISTS FOR.
    $overWide = @(@($cardLines) | Where-Object { $_.Length -gt $narrowWidth })
    Assert-True (-not $overWide.Count) "$($overWide.Count) card lines ran past $narrowWidth characters, the widest at $((@(@($cardLines) | ForEach-Object { $_.Length }) | Sort-Object -Descending | Select-Object -First 1)) -- a wrapped card is the table's defect in a new shape"

    # THE NOTE IS A FIELD, NOT A SUFFIX, which is what keeps the head line's length dependent on the
    # seat name alone. Its absence from the head line is the half that matters: a note appended
    # there would reintroduce exactly the row-widens-everything behaviour cards were written to end.
    $gammaHead = @(@($cardLines) | Where-Object { $_ -clike '*gamma-seat*' })
    Assert-Equal '1' ([string]@($gammaHead).Count) 'the orphaned seat did not render exactly one head line'
    Assert-True (-not ([string]@($gammaHead)[0]).Contains('claim holder gone')) 'the state note was rendered onto the head line, which is what makes one row widen every other'
    Assert-True (@(@($cardLines) | Where-Object { $_ -clike '*Note*claim holder gone*' }).Count -eq 1) 'the state note did not get a field line of its own'

    # THE READER'S NUMBER SITS AT ONE COLUMN ON EVERY CARD. The same shape as 19b's assertion about
    # the table's last column, and for the same reason: a number that moves is a number that is hard
    # to aim at, and the seat name's length is the thing that would move it.
    $headOffsets = @(@($cardRows) | ForEach-Object {
        $seatName = [string]$_.seat
        $headLine = @(@($cardLines) | Where-Object { $_ -clike "*$seatName*" })[0]
        ([string]$headLine).IndexOf($seatName)
    } | Sort-Object -Unique)
    Assert-Equal '1' ([string]@($headOffsets).Count) "the seat name starts at $(@($headOffsets).Count) different columns across the cards, so the number beside it moves row to row"

    # THIS SUITE'S OWN ROSTER PARSER MUST READ BOTH LAYOUTS, and it could not until 2026-09-11. It
    # was written against the table's '  3  seat' and returned 0 for the card's '   3 ! seat', which
    # surfaced as 'the roster did not number every seat this case created' the moment an overflowing
    # fixture first chose the cards. Pinned against REAL rendered lines from both renderers rather
    # than against a retyped shape, and pinned negatively too: a loosened anchor that matched any
    # seat's line would make every number assertion in case 19f meaningless.
    $numberPattern = '^\s+(\d+)\s+(?:\S\s+)?' + [regex]::Escape('gamma-seat') + '\s'
    $gammaTableLine = @(@(Format-SeatPickerRows -Rows $cardRows) | Where-Object { $_ -clike '*gamma-seat*' })[0]
    Assert-True ([string]$gammaTableLine -cmatch $numberPattern) 'the roster number parser cannot read the TABLE layout'
    Assert-Equal '3' ([string]$Matches[1]) 'the roster number parser read the wrong number off the table line'
    Assert-True ([string]@($gammaHead)[0] -cmatch $numberPattern) 'the roster number parser cannot read the CARD layout'
    Assert-Equal '3' ([string]$Matches[1]) 'the roster number parser read the wrong number off the card line'
    Assert-True (-not ([string]@($gammaHead)[0] -cmatch ('^\s+(\d+)\s+(?:\S\s+)?' + [regex]::Escape('beta-seat') + '\s'))) "the roster number parser matched a different seat's card, so every number it reports is unproved"

    # EVERY SEAT IS ON THE LIST, because a layout that silently dropped one would satisfy every
    # width assertion above it.
    foreach ($cardRow in @($cardRows)) {
        Assert-True (@(@($cardLines) | Where-Object { $_ -clike "*$([string]$cardRow.seat)*" }).Count -eq 1) "seat '$([string]$cardRow.seat)' is not on exactly one card head line"
    }

    # --- 19b-3. ONE PLACE TO DEGRADE, AND A FILE THAT MUST STAY ASCII (2026-09-11) ----------------
    #
    # THE SOURCE FILE IS THE LOAD-BEARING ONE HERE. Every file in tools/ is stored BOM-less, and
    # Windows PowerShell 5.1 reads a BOM-less file as ANSI -- so a literal box character pasted into
    # SeatPicker.ps1 is not a rendering problem but a PARSE ERROR, and the picker does not start.
    # Measured 2026-09-11 by doing it. Nothing else in this suite would catch it, because a suite
    # that cannot load the file it tests reports the parse error rather than this.
    $pickerSource = Join-Path $PSScriptRoot 'SeatPicker.ps1'
    $pickerBytes = [IO.File]::ReadAllBytes($pickerSource)
    $highBytes = @(@($pickerBytes) | Where-Object { $_ -ge 0x80 })
    Assert-True (-not $highBytes.Count) "SeatPicker.ps1 carries $($highBytes.Count) non-ASCII bytes; it is stored BOM-less, so PowerShell 5.1 reads those as ANSI and the file fails to parse. Build every glyph from its code point instead"

    # AND THE PROBE THAT THROWS WHERE THIS RUNS. The Console WindowWidth property raises 'The handle
    # is invalid.' whenever stdin is redirected, which is how the gate spawns this suite and how
    # -PickerInput drives the picker. Guarded here because the wrong probe is the obvious one to
    # reach for and its failure is invisible until a redirected run.
    #
    # READ OFF THE AST RATHER THAN THE TEXT, and the first version of this check was the reason why:
    # matching the source text flagged the COMMENT in Get-SeatPickerRenderWidth that explains why the
    # probe is not used. A member expression's extent is real code by construction.
    $pickerParseErrors = $null
    $pickerTokens = $null
    $pickerAst = [Management.Automation.Language.Parser]::ParseFile($pickerSource, [ref]$pickerTokens, [ref]$pickerParseErrors)
    Assert-True (-not @($pickerParseErrors).Count) "SeatPicker.ps1 does not parse: $((@($pickerParseErrors) | ForEach-Object { [string]$_.Message }) -join '; ')"
    $widthProbes = @($pickerAst.FindAll({
        param($node)
        ($node -is [Management.Automation.Language.MemberExpressionAst]) -and
        (([string]$node.Extent.Text) -cmatch 'WindowWidth')
    }, $true))
    Assert-True (-not $widthProbes.Count) "SeatPicker.ps1 measures the terminal with a Console WindowWidth expression at line $((@($widthProbes) | ForEach-Object { [string]$_.Extent.StartLineNumber }) -join ', '), which throws under a redirected stdin -- RawUI answers in the same conditions"

    # BOTH ALPHABETS CARRY THE SAME NAMES, derived from each other rather than listed, so a glyph
    # added to one half alone fails here instead of rendering as '?' on somebody's console.
    $unicodeGlyphs = Get-SeatPickerGlyphs
    $asciiGlyphs = Get-SeatPickerGlyphs -Ascii
    $unicodeNames = @(@($unicodeGlyphs.Keys) | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)
    $asciiNames = @(@($asciiGlyphs.Keys) | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)
    Assert-Equal ($unicodeNames -join ',') ($asciiNames -join ',') 'the two alphabets do not carry the same glyph names, so one of them is missing a mark the renderers will ask for'

    # AND THEY ARE ACTUALLY DIFFERENT ALPHABETS. Without this, copying the ASCII set over both halves
    # satisfies every assertion above while silently retiring the Unicode layout.
    foreach ($glyphName in @($unicodeNames)) {
        if ($glyphName -ceq 'ascii') { continue }
        $asciiValue = [string]$asciiGlyphs[$glyphName]
        $asciiOffenders = @(@($asciiValue.ToCharArray()) | Where-Object { [int]$_ -ge 127 })
        Assert-True (-not $asciiOffenders.Count) "the plain alphabet's '$glyphName' is not ASCII, so it cannot be the fallback for anything"
        $unicodeValue = [string]$unicodeGlyphs[$glyphName]
        $unicodeMarks = @(@($unicodeValue.ToCharArray()) | Where-Object { [int]$_ -ge 127 })
        Assert-True ($unicodeMarks.Count -gt 0) "the Unicode alphabet's '$glyphName' is plain ASCII, so the two alphabets have collapsed into one"
    }

    # THE TRANSLITERATOR, on the characters a conversation title can actually carry. A title is read
    # out of a transcript this repository does not own, so it is the one arbitrary string here.
    Assert-Equal 'a...b' (ConvertTo-SeatPickerPlainText -Text ('a' + [char]0x2026 + 'b')) 'the cut marker did not transliterate, which is the defect this shipped with'
    Assert-Equal '"q"' (ConvertTo-SeatPickerPlainText -Text ([char]0x201C + 'q' + [char]0x201D)) 'curly quotes did not transliterate'
    Assert-Equal 'plain text 1' (ConvertTo-SeatPickerPlainText -Text 'plain text 1') 'ASCII text was altered on its way through the transliterator'
    Assert-Equal '?' (ConvertTo-SeatPickerPlainText -Text ([string][char]0x4E2D)) 'an unmapped character was not reduced to a printable placeholder'

    # THE BREAKPOINT IS PINNED TO ITS DOCUMENTED VALUE, NOT TO ITSELF. The first version of these
    # assertions took their widths FROM $script:SeatPickerCardBreakpoint, so moving the breakpoint
    # moved the question with it and the pair stayed green under exactly the regression they exist
    # to catch -- measured 2026-09-11 by setting it to 60 and watching the suite pass. 120 is the
    # number docs/seats.md and tools/_helpers.json both state, so a change that does not reach them
    # fails here rather than silently disagreeing with what the reader was told.
    Assert-Equal '120' ([string]$script:SeatPickerCardBreakpoint) 'the card breakpoint moved away from the 120 columns that docs/seats.md and tools/_helpers.json both state'
    Assert-Equal 'cards' ([string](Get-SeatPickerRenderPlan -Width 119).mode) 'a 119-column terminal was given the table'
    Assert-Equal 'table' ([string](Get-SeatPickerRenderPlan -Width 120).mode) 'a 120-column terminal was given the cards'
    Assert-Equal 'cards' ([string](Get-SeatPickerRenderPlan -Width 80).mode) 'an 80-column terminal was given the table'
    Assert-Equal 'table' ([string](Get-SeatPickerRenderPlan -Width 200).mode) 'a 200-column terminal was given the cards'
    Assert-True ((Get-SeatPickerRenderWidth -Width 0) -gt 0) 'the width probe returned a width nothing can be drawn in'

    # A REDIRECTED RUN IS PLAIN AND UNCOLOURED, which is what keeps every check in this suite
    # independent of the codepage the machine happens to be in. This suite IS redirected, so the
    # assertion is about the conditions it is running under rather than about a fixture.
    $liveRenderPlan = Get-SeatPickerRenderPlan -Width $narrowWidth
    Assert-True ([bool]$liveRenderPlan.ascii) 'a redirected run was given the Unicode alphabet, so this suite output now varies with the console codepage'
    Assert-True (-not [bool]$liveRenderPlan.color) 'a redirected run was given colour, so escape sequences are now in the captured output'

    # PLAIN IMPLIES UNCOLOURED IS A CONTRACT, not a coincidence: Write-SeatPickerLine rewrites every
    # character below 32 to '?', so a coloured line reaching the transliterator would PRINT its
    # escape codes rather than suppress them.
    $forcedPlain = Get-SeatPickerRenderPlan -Width $narrowWidth -ForcePlain
    Assert-True (-not [bool]$forcedPlain.color) 'a forced-plain render kept colour, which would put escape codes through the transliterator'

    # NO_COLOR IS HONOURED ON PRESENCE, which is that convention's own rule rather than ours.
    $savedNoColor = $env:NO_COLOR
    try {
        $env:NO_COLOR = ''
        Assert-True (-not [bool](Get-SeatPickerRenderPlan -Width $narrowWidth -ForcePlain).color) 'an empty NO_COLOR did not suppress colour'
    }
    finally { $env:NO_COLOR = $savedNoColor }

    # --- 19c. Which record is a seat's last: the NEWER one, not the more trusted one ---------------
    #
    # A launcher-started session can never hold a binding -- the launcher holds the claim handle, so
    # the agent inside it is refused by the enter/held row -- which is exactly why the advisory record
    # exists. Preferring the binding unconditionally would offer the conversation BEFORE last at
    # every seat a terminal reader uses.
    $newerConversation = [guid]::NewGuid().ToString()
    Write-SeatActivity -StateDirectory $stateDir -Seat 'pick-binding' -Note 'seat entered' -Conversation $newerConversation | Out-Null
    $afterAdvisory = Get-SeatConversationRecord -StateDirectory $stateDir -Seat 'pick-binding'
    Assert-Equal 'activity' ([string]$afterAdvisory.source) 'an advisory conversation recorded AFTER the binding did not win'
    Assert-Equal $newerConversation ([string]$afterAdvisory.session_id) 'the newer advisory conversation was not the one reported'
    # And with the advisory record stamped BEFORE the binding, the binding wins again.
    $stale = Read-SeatActivity -StateDirectory $stateDir -Seat 'pick-binding'
    $stale.conversation_recorded_utc = ([DateTime]::UtcNow.AddDays(-2)).ToString('o')
    [IO.File]::WriteAllText((Get-SeatActivityPath -StateDirectory $stateDir -Seat 'pick-binding'), (($stale | ConvertTo-Json -Depth 4) + "`n"), $utf8)
    $afterBinding = Get-SeatConversationRecord -StateDirectory $stateDir -Seat 'pick-binding'
    Assert-Equal 'binding' ([string]$afterBinding.source) 'an advisory conversation older than the binding was preferred to it'
    Assert-Equal $untitledConversation ([string]$afterBinding.session_id) "the binding's conversation was not the one reported"

    # AND -NoLaunch KEEPS IT. A script that enters a seat and returns starts no conversation, so
    # clearing the record would erase a real one on behalf of one that never happened.
    $keepRun = Start-Seat @('-Seat', 'pick-titled', '-NoLaunch', '-Json')
    Assert-True ($keepRun.ExitCode -eq 0) "entering pick-titled with -NoLaunch failed: $($keepRun.Text)"
    Assert-Equal $titledConversation ([string](Get-SeatConversationRecord -StateDirectory $stateDir -Seat 'pick-titled').session_id) 'a -NoLaunch entry erased the conversation the last real session recorded'

    # --- 19d. The choice grammar, and a distinct reason for every refusal -------------------------
    foreach ($grammar in @(
        @{ typed = '2';    action = 'resume';    index = 2 },
        @{ typed = 'n3';   action = 'new';       index = 3 },
        @{ typed = 'N3';   action = 'new';       index = 3 },
        @{ typed = 'r 1';  action = 'retire';    index = 1 },
        @{ typed = 'R1';   action = 'retire';    index = 1 },
        @{ typed = '+';    action = 'create';    index = 0 },
        @{ typed = 'q';    action = 'quit';      index = 0 },
        @{ typed = 'QUIT'; action = 'quit';      index = 0 },
        @{ typed = '';     action = 'reprompt';  index = 0 },
        @{ typed = '   ';  action = 'reprompt';  index = 0 },
        @{ typed = 'zz';   action = 'invalid';   index = 0 },
        @{ typed = 'n';    action = 'invalid';   index = 0 },
        @{ typed = '0';    action = 'out-of-range'; index = 0 },
        @{ typed = '99';   action = 'out-of-range'; index = 0 },
        @{ typed = 'n99';  action = 'out-of-range'; index = 0 })) {
        $parsed = Resolve-SeatPickerChoice -Choice ([string]$grammar.typed) -RowCount 5
        Assert-Equal ([string]$grammar.action) ([string]$parsed.action) "the picker read '$([string]$grammar.typed)' as the wrong command"
        Assert-Equal ([string][int]$grammar.index) ([string][int]$parsed.index) "the picker read '$([string]$grammar.typed)' as the wrong seat number"
    }
    # THREE REFUSALS, THREE REASONS. A shared "no seat was chosen" would let any two of them break
    # while the third kept this green -- which is the 5-of-29 shape step 11 replaced.
    # NORMALISED FIRST, because every reason ECHOES what was typed -- so two refusals with the same
    # wording still differ by the input inside them, and an unnormalised comparison would call them
    # distinct while the reader read the same sentence twice.
    $reasons = @(@('zz', '99', '') | ForEach-Object { [string](Resolve-SeatPickerChoice -Choice $_ -RowCount 5).reason })
    $reasonShapes = @(@($reasons) | ForEach-Object { $_ -replace "'[^']*'", "'<typed>'" })
    Assert-Equal '3' ([string]@($reasonShapes | Sort-Object -Unique -CaseSensitive).Count) 'the picker gave two refusals the same reason'
    Assert-True ($reasons[0].Contains('not one of the commands')) "an unreadable choice did not say so: $($reasons[0])"
    Assert-True ($reasons[1].Contains('the list offers 1 to 5')) "an out-of-range choice did not name the range: $($reasons[1])"
    # AND A NUMBER WHERE NO SEAT EXISTS IS ITS OWN REASON, not an out-of-range one: the fix is to
    # create a seat rather than to type a smaller number.
    $emptyRoster = Resolve-SeatPickerChoice -Choice '1' -RowCount 0
    Assert-Equal 'invalid' ([string]$emptyRoster.action) 'a number typed at an empty roster was read as a seat'
    Assert-True ([string]$emptyRoster.reason -cmatch 'no seat exists') "an empty roster's refusal did not say why: $([string]$emptyRoster.reason)"

    # --- 19e. A caller that cannot be asked is refused, and nothing is entered ---------------------
    #
    # Measured 2026-09-10: an agent tool call, a piped invocation and a hook child all report stdin
    # redirected; an interactive terminal does not. The child below is spawned by this suite, so its
    # stdin is redirected by construction -- which is exactly the caller the refusal is for.
    $seatlessBefore = Get-RegistrySummary
    $seatless = Invoke-PickerRun @() @('-NoLaunch', '-Json')
    Assert-True ($seatless.ExitCode -ne 0) 'a non-interactive caller with no -Seat was not refused'
    Assert-True ($seatless.Text.Contains('-Seat <name>')) "the non-interactive refusal did not name the argument that fixes it: $($seatless.Text)"
    Assert-True ($seatless.Text.Contains('pick-titled')) "the non-interactive refusal did not list the seats it could not offer: $($seatless.Text)"
    # THE SIGNAL THAT ONLY THIS GUARD PRODUCES. Removing the redirect check does NOT make this case
    # pass silently -- the picker runs, prints the roster, reads the end of its input and refuses --
    # and the first three assertions above are all satisfied by THAT refusal too, which is a second
    # check standing over one property. So the refusal is measured by what only it can say, and by
    # the roster it never got as far as printing.
    Assert-True ($seatless.Text.Contains('stdin is redirected')) "the non-interactive refusal was not the redirect one: $($seatless.Text)"
    Assert-True (-not $seatless.Text.Contains('Seats in this Library')) "a caller that cannot be asked was still shown the roster: $($seatless.Text)"
    Assert-Equal $seatlessBefore (Get-RegistrySummary) 'a refused seatless run changed the registry'
    Assert-True (-not (Test-SeatClaim -StateDirectory $stateDir -Seat 'pick-titled')) 'a refused seatless run left a claim behind'
    # -Preflight WITH NO SEAT IS A DIFFERENT REFUSAL, because a plan for a seat nobody has chosen is
    # not a plan. It must not be answered by the picker either.
    $planless = Invoke-PickerRun @('q') @('-Preflight', '-Json')
    Assert-True ($planless.ExitCode -ne 0) '-Preflight with no -Seat was not refused'
    Assert-True ($planless.Text.Contains('plans ONE named seat')) "-Preflight with no -Seat did not say why: $($planless.Text)"

    # --- 19f. A number resumes that seat's own conversation ----------------------------------------
    $rosterRun = Invoke-PickerRun @('q') @('-NoLaunch', '-Json')
    Assert-True ($rosterRun.ExitCode -eq 0) "quitting the picker failed: $($rosterRun.Text)"
    Assert-True ($rosterRun.Text.Contains('No seat was chosen')) "quitting the picker did not say so: $($rosterRun.Text)"
    Assert-Equal '' ((@($rosterRun.Stdout) | Where-Object { $_.Trim().StartsWith('{') }) -join '') 'quitting the picker still emitted a result'
    $titledNumber = Get-PickerNumber $rosterRun 'pick-titled'
    $bareNumber = Get-PickerNumber $rosterRun 'pick-bare'
    $retireNumber = Get-PickerNumber $rosterRun 'pick-retire'
    Assert-True ($titledNumber -gt 0 -and $bareNumber -gt 0 -and $retireNumber -gt 0) 'the roster did not number every seat this case created'
    Assert-True ($rosterRun.Text.Contains('Picker roster subject')) "the picker did not show the conversation title it read: $($rosterRun.Text)"

    $resumed = Invoke-PickerRun @([string]$titledNumber) @('-NoLaunch', '-Json')
    Assert-True ($resumed.ExitCode -eq 0) "resuming from the picker failed: $($resumed.Text)"
    $resumedResult = Get-ResultJson $resumed 'the picker resume'
    Assert-Equal 'pick-titled' ([string](Get-Field $resumedResult 'seat' 'the picker resume')) 'the picker entered the wrong seat'
    Assert-Equal 'resume' ([string](Get-Field $resumedResult 'conversation_action' 'the picker resume')) 'a number was not read as a resume'
    Assert-Equal 'True' ([string](Get-Field $resumedResult 'picked' 'the picker resume')) 'a chosen seat was reported as a named one'
    Assert-Equal $titledConversation ([string](Get-Field $resumedResult 'conversation' 'the picker resume')) "the picker resumed a conversation that is not the seat's own"
    Assert-Equal "--resume $titledConversation" ((@(Get-Field $resumedResult 'command_args' 'the picker resume')) -join ' ') 'the picker composed the wrong agent arguments for a resume'
    # -NoLaunch STARTED NOTHING, so nothing may be recorded as having sat here.
    Assert-Equal 'False' ([string](Get-Field $resumedResult 'conversation_recorded' 'the picker resume')) 'a -NoLaunch run recorded a conversation that never started'

    # --- 19g. A seat with no conversation is refused a resume, in its own words --------------------
    $noConversation = Invoke-PickerRun @([string]$bareNumber, 'q') @('-NoLaunch', '-Json')
    Assert-True ($noConversation.ExitCode -eq 0) "the no-conversation refusal ended the picker: $($noConversation.Text)"
    Assert-True ($noConversation.Text.Contains('has no conversation on record')) "a seat with nothing to resume did not say so: $($noConversation.Text)"
    Assert-True ($noConversation.Text.Contains("Type n$bareNumber")) "the no-conversation refusal did not name the keystroke that works: $($noConversation.Text)"
    Assert-Equal '' ((@($noConversation.Stdout) | Where-Object { $_.Trim().StartsWith('{') }) -join '') 'a seat with no conversation was entered anyway'

    # --- 19g-2. An EMPTY conversation is started again, under its own id (2026-09-11) --------------
    #
    # THE DEFECT THIS PINS, OBSERVED RATHER THAN IMAGINED. A reader created a seat, the launcher
    # minted a conversation and passed it to `claude --session-id`, the session started -- its
    # SessionStart hook ran -- and they left without typing. Claude Code writes a transcript on the
    # first turn, so there was none. The roster said `no transcript for it under this configuration`
    # and the number beside it still composed `--resume`, which answered
    # `No conversation found with session ID` and left the reader with no session at all.
    #
    # THE ID IS REUSED RATHER THAN REPLACED, which is what makes this different from `n<number>`:
    # nothing is lost because the conversation holds nothing, and the seat's two records go on naming
    # the conversation actually sitting at it. Measured against the installed binary: `--session-id`
    # accepts an id with no transcript and REFUSES one that has a transcript, so a wrongly derived
    # restart fails at the agent rather than forking two conversations onto one id.
    $emptyNumber = Get-PickerNumber $rosterRun 'pick-empty'
    Assert-True ($emptyNumber -gt 0) 'the roster did not number the seat whose conversation recorded nothing'
    $restarted = Invoke-PickerRun @([string]$emptyNumber) @('-NoLaunch', '-Json')
    Assert-True ($restarted.ExitCode -eq 0) "restarting an empty conversation from the picker failed: $($restarted.Text)"
    $restartedResult = Get-ResultJson $restarted 'the picker restart'
    Assert-Equal 'pick-empty' ([string](Get-Field $restartedResult 'seat' 'the picker restart')) 'the picker entered the wrong seat'
    Assert-Equal 'restart' ([string](Get-Field $restartedResult 'conversation_action' 'the picker restart')) 'an empty conversation was not reported as a restart'
    Assert-Equal $emptyConversation ([string](Get-Field $restartedResult 'conversation' 'the picker restart')) "the picker restarted a conversation that is not the seat's own"
    # THE ARGUMENT IS THE WHOLE FIX. `--resume` here is the defect verbatim.
    Assert-Equal "--session-id $emptyConversation" ((@(Get-Field $restartedResult 'command_args' 'the picker restart')) -join ' ') 'an empty conversation was handed to --resume'
    # AND THE READER IS TOLD BEFORE IT HAPPENS, because they typed a number meaning "put me back" and
    # are being put somewhere emptier than they asked for, even though it costs them no keystroke.
    Assert-True ($restarted.Text.Contains('recorded nothing')) "a restart did not say the conversation was empty: $($restarted.Text)"
    Assert-True ($restarted.Text.Contains('started rather than resumed')) "a restart did not say what it was doing instead: $($restarted.Text)"

    # --- 19h. n<number> mints a conversation, and a REAL launch records it -------------------------
    #
    # THE ARGV IS CAPTURED FROM A REAL CHILD, not read back off the result: the launcher's own
    # -Command and -CommandArgs point at a script that writes what it was actually given, so a picker
    # that reported one argument list and passed another fails here.
    $argvPath = Join-Path $fixture 'picker-argv.txt'
    $argvScript = Join-Path $fixture 'picker-argv.ps1'
    [IO.File]::WriteAllText($argvScript, ('[IO.File]::WriteAllText(''{0}'', ($args -join ''|''))' -f $argvPath), $utf8)
    $launched = Invoke-PickerRun @("n$bareNumber") @('-Json', '-Command', 'powershell.exe', '-CommandArgs',
        ("@('-NoProfile','-ExecutionPolicy','Bypass','-File','$argvScript')"))
    Assert-True ($launched.ExitCode -eq 0) "starting a new conversation from the picker failed: $($launched.Text)"
    $launchedResult = Get-ResultJson $launched 'the picker new conversation'
    $mintedConversation = [string](Get-Field $launchedResult 'conversation' 'the picker new conversation')
    Assert-Equal 'new' ([string](Get-Field $launchedResult 'conversation_action' 'the picker new conversation')) 'n<number> was not read as a new conversation'
    Assert-True (Test-SeatConversationId -SessionId $mintedConversation) "the minted conversation id is not a uuid: $mintedConversation"
    Assert-True (Test-Path -LiteralPath $argvPath -PathType Leaf) 'the agent was never started, so no argument list was captured'
    Assert-Equal "--session-id|$mintedConversation" ([IO.File]::ReadAllText($argvPath)) 'the agent was started with arguments the picker did not report'
    Assert-Equal 'True' ([string](Get-Field $launchedResult 'conversation_recorded' 'the picker new conversation')) 'a real launch did not record its conversation'
    $recordedAfterLaunch = Get-SeatConversationRecord -StateDirectory $stateDir -Seat 'pick-bare'
    Assert-Equal $mintedConversation ([string]$recordedAfterLaunch.session_id) 'the seat did not remember the conversation the launcher minted'
    Assert-Equal 'activity' ([string]$recordedAfterLaunch.source) "a launcher's own record was reported as a verified binding"
    # AND IT REACHES THE DURABLE HISTORY TOO (plan step 8, 2026-09-10). A launcher-started session
    # can never hold a binding, so if this route wrote only the advisory record the history would be
    # blank at exactly the seats the one-click route creates -- and resuming this conversation from a
    # bare agent would meet the roster. Asserted through the LOOKUP rather than by reading the file,
    # because what has to be true is that the conversation finds its seat again.
    $launchedHistory = @(Get-SeatsForConversation -StateDirectory $stateDir -SessionId $mintedConversation)
    Assert-Equal '1' ([string]@($launchedHistory).Count) "a real launch left the conversation history empty at the seat it started: $mintedConversation"
    Assert-Equal 'pick-bare' ([string]$launchedHistory[0].seat) 'the launcher recorded its conversation at the wrong seat'
    # LABELLED, because nothing verified a process here. `launcher` and `binding` are different
    # claims about the same row, and a record that called a minted id a verified binding would be
    # identity by assertion.
    Assert-Equal 'launcher' ([string]$launchedHistory[0].source) "the launcher's minted conversation was recorded as a verified binding"

    # --- 19i. `+` creates through the shared gate, and only after one clear yes --------------------
    $beforeCreate = Get-RegistrySummary
    $declined = Invoke-PickerRun @('+', 'pick-made', 'pick-made-proj', 'no', 'q') @('-NoLaunch', '-Json')
    Assert-True ($declined.ExitCode -eq 0) "declining a creation ended the picker badly: $($declined.Text)"
    Assert-True ($declined.Text.Contains('plan_id')) "the creation plan was not shown before the confirmation: $($declined.Text)"
    Assert-True ($declined.Text.Contains('rather than yes')) "a declined creation did not say what it read: $($declined.Text)"
    Assert-Equal $beforeCreate (Get-RegistrySummary) 'a declined creation created a seat anyway'

    # A SEAT NAME THE GATE REFUSES RE-ASKS THE NAME rather than ending the session, and the refusal is
    # the gate's own words. It is refused BEFORE the Project question now (`-SeatOnly`), which is why
    # the answer after it is the empty line that cancels rather than a Project slug.
    $refusedCreate = Invoke-PickerRun @('+', 'pick-titled', '', 'q') @('-NoLaunch', '-Json')
    Assert-True ($refusedCreate.ExitCode -eq 0) "a refused creation ended the picker: $($refusedCreate.Text)"
    Assert-True ($refusedCreate.Text.Contains('already exists')) "the creation gate's refusal was not shown: $($refusedCreate.Text)"
    Assert-True ($refusedCreate.Text -cnotmatch 'Active Projects:') "a seat name the gate refuses was still asked for a Project: $($refusedCreate.Text)"

    $created = Invoke-PickerRun @('+', 'pick-made', 'pick-made-proj', 'yes') @('-NoLaunch', '-Json')
    Assert-True ($created.ExitCode -eq 0) "creating a seat from the picker failed: $($created.Text)"
    $createdResult = Get-ResultJson $created 'the picker creation'
    Assert-Equal 'pick-made' ([string](Get-Field $createdResult 'seat' 'the picker creation')) 'the picker created the wrong seat'
    Assert-Equal 'pick-made-proj' ([string](Get-Field $createdResult 'project' 'the picker creation')) 'the created seat was bound to the wrong Project'
    Assert-Equal 'create' ([string](Get-Field $createdResult 'conversation_action' 'the picker creation')) 'a creation did not report itself as one'
    Assert-True ((Get-RegistrySummary).Contains('pick-made=pick-made-proj')) 'the created seat is not in the registry'
    Assert-True ((Get-DeskText 'pick-made' 'projects').Contains('projects/pick-made-proj')) "the created seat's Desk does not hold its own Project Hub"
    $madeEntry = Get-SeatEntry -Registry (Read-SeatRegistry -StateDirectory $stateDir) -Seat 'pick-made'
    Assert-True (@($madeEntry.PSObject.Properties | ForEach-Object { $_.Name }) -ccontains 'seat_id') 'a seat created from the picker carries no seat_id'

    # --- 19i-2. A refused ANSWER re-asks its own question (2026-09-11) ----------------------------
    #
    # Both halves of this were measured on a real run: 'Home Assistant Admin' lost the whole attempt
    # to the roster, and so did a Project whose Hub did not exist yet. The reader had typed something
    # usable each time and was handed neither the fix nor their place back.
    $suggested = Invoke-PickerRun @('+', 'Pick Fixed Seat', 'yes', 'pick-fixed-proj', 'yes') @('-NoLaunch', '-Json')
    Assert-True ($suggested.ExitCode -eq 0) "a suggested seat name failed: $($suggested.Text)"
    Assert-True ($suggested.Text.Contains("Use 'pick-fixed-seat' instead?")) "the picker did not offer a usable slug for a display name: $($suggested.Text)"
    $suggestedResult = Get-ResultJson $suggested 'the suggested creation'
    Assert-Equal 'pick-fixed-seat' ([string](Get-Field $suggestedResult 'seat' 'the suggested creation')) 'the accepted suggestion did not become the seat'
    Assert-True ((Get-RegistrySummary).Contains('pick-fixed-seat=pick-fixed-proj')) 'the seat created from a suggestion is not in the registry'

    # DECLINING IT RE-ASKS THE NAME rather than taking the suggestion or leaving: the empty line after
    # the refusal is consumed by the NAME prompt, which is what 'nothing was typed' proves.
    $declinedSuggestion = Invoke-PickerRun @('+', 'Pick Other Seat', 'no', '', 'q') @('-NoLaunch', '-Json')
    Assert-True ($declinedSuggestion.ExitCode -eq 0) "declining a suggestion ended the picker badly: $($declinedSuggestion.Text)"
    Assert-True ($declinedSuggestion.Text.Contains('nothing was typed')) "a declined suggestion did not re-ask the name: $($declinedSuggestion.Text)"
    Assert-True (-not (Get-RegistrySummary).Contains('pick-other-seat=')) 'a declined suggestion created a seat anyway'

    # A NAME WITH NO USABLE SLUG IN IT IS REFUSED WITHOUT AN OFFER, because a suggestion that the
    # resolver would itself reject is worse than none.
    $noSuggestion = Invoke-PickerRun @('+', '!!!', '', 'q') @('-NoLaunch', '-Json')
    Assert-True ($noSuggestion.ExitCode -eq 0) "an unslugifiable name ended the picker: $($noSuggestion.Text)"
    Assert-True ($noSuggestion.Text -cnotmatch 'instead\?') "a name with nothing usable in it was still offered a slug: $($noSuggestion.Text)"

    # --- 19i-3. A Project that does not exist yet is an OFFER, and the Hub is made here -----------
    #
    # The route's whole reason for existing (2026-09-11): sitting down at a NEW subject was a dead end
    # that sent the reader out to a terminal helper and back. Declining must still be free, and the
    # second answer reaching `plan_id` is what proves the Project was re-asked rather than the whole
    # creation restarted -- a restart would have wanted the seat name again.
    $hubOffer = Invoke-PickerRun @('+', 'pick-reask', 'no-such-proj', 'no', 'pick-reask-proj', 'no', 'q') @('-NoLaunch', '-Json')
    Assert-True ($hubOffer.ExitCode -eq 0) "a declined Hub offer ended the picker: $($hubOffer.Text)"
    Assert-True ($hubOffer.Text.Contains("There is no active Project Hub 'no-such-proj' yet")) "the picker did not offer to create the missing Hub: $($hubOffer.Text)"
    Assert-True ($hubOffer.Text.Contains('Create it now?')) "the offer was not put as a question: $($hubOffer.Text)"
    Assert-True ($hubOffer.Text.Contains('plan_id')) "the re-asked Project never reached the seat plan: $($hubOffer.Text)"
    Assert-True (-not (Get-RegistrySummary).Contains('pick-reask=')) 'a declined creation created a seat anyway'

    # DECLINING THE HUB PLAN WRITES NOTHING, and the reader is put back at the Project question.
    $hubDeclined = Invoke-PickerRun @('+', 'pick-nohub', 'pick-nohub-proj', 'yes', 'Pick No Hub', 'A fixture project that is never created.', 'no', 'no', '', 'q') @('-NoLaunch', '-Json')
    Assert-True ($hubDeclined.ExitCode -eq 0) "declining a Hub plan ended the picker badly: $($hubDeclined.Text)"
    Assert-True ($hubDeclined.Text.Contains("the confirmation was 'no' rather than yes")) "a declined Hub did not say what it read: $($hubDeclined.Text)"
    Assert-True (-not (Get-RegistrySummary).Contains('pick-nohub=')) 'a declined Hub created a seat anyway'

    # AN EMPTY ANSWER INSIDE THE HUB QUESTIONS CANCELS THE HUB, not the whole creation.
    $hubNoTitle = Invoke-PickerRun @('+', 'pick-notitle', 'pick-notitle-proj', 'yes', '', '', 'q') @('-NoLaunch', '-Json')
    Assert-True ($hubNoTitle.ExitCode -eq 0) "an empty Hub title ended the picker badly: $($hubNoTitle.Text)"
    Assert-True ($hubNoTitle.Text.Contains('No Hub was created: nothing was typed')) "an empty title was not reported: $($hubNoTitle.Text)"

    # AND THE WHOLE POINT: a Hub and a seat made in one pass, from a slug that did not exist.
    $hubMade = Invoke-PickerRun @('+', 'pick-hub-seat', 'pick-hub-proj', 'yes', 'Pick Hub Project',
        'A fixture project created through the picker.', 'no', 'yes', 'yes') @('-NoLaunch', '-Json')
    Assert-True ($hubMade.ExitCode -eq 0) "creating a Hub and a seat together failed: $($hubMade.Text)"
    Assert-True ($hubMade.Text.Contains('the SHARED collection')) "the Hub plan did not disclose the shared write: $($hubMade.Text)"
    Assert-True ($hubMade.Text.Contains("Project Hub 'pick-hub-proj' created")) "the Hub creation was not reported: $($hubMade.Text)"
    $hubResult = Get-ResultJson $hubMade 'the picker Hub creation'
    Assert-Equal 'pick-hub-seat' ([string](Get-Field $hubResult 'seat' 'the picker Hub creation')) 'the seat made beside a new Hub is wrong'
    Assert-Equal 'pick-hub-proj' ([string](Get-Field $hubResult 'project' 'the picker Hub creation')) 'the seat was not bound to the Hub just created'
    Assert-True ((Get-RegistrySummary).Contains('pick-hub-seat=pick-hub-proj')) 'the seat made beside a new Hub is not in the registry'
    Assert-True ((Get-DeskText 'pick-hub-seat' 'projects').Contains('projects/pick-hub-proj')) "the new seat's Desk does not hold the Hub just created"

    # --- 19j. The approval is bound to the registry it was shown against --------------------------
    #
    # A reader who typed both slugs as arguments confirmed them by typing them and passes no plan_id;
    # a reader who typed `+` was SHOWN a plan instead. The id is derived from the seat, the Project
    # and the registry digest, so a registry that changed since invalidates it.
    $approvalRegistry = Read-SeatRegistry -StateDirectory $stateDir
    $approvalPlan = Get-SeatCreationPlanId -Registry $approvalRegistry -Seat 'pick-approved' -Project 'pick-approved-proj'
    $otherRegistry = [pscustomobject]@{ schema = 1; seats = @(@($approvalRegistry.seats) + [pscustomobject]@{ seat = 'zzz-later'; project = 'zzz-proj' }) }
    Assert-True ($approvalPlan -cne (Get-SeatCreationPlanId -Registry $otherRegistry -Seat 'pick-approved' -Project 'pick-approved-proj')) 'the creation plan_id does not depend on the registry it was issued against'
    $staleApproval = Start-Seat @('-Seat', 'pick-approved', '-Project', 'pick-approved-proj', '-ApprovedPlanId', '0000000000000000', '-NoLaunch', '-Json')
    Assert-True ($staleApproval.ExitCode -ne 0) 'a creation ran against an approval that does not describe it'
    Assert-True ($staleApproval.Text.Contains('registry changed')) "the stale-approval refusal did not say why: $($staleApproval.Text)"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path (Get-SeatsDirectory $stateDir) 'pick-approved'))) 'a refused approval left a seat directory behind'
    $goodApproval = Start-Seat @('-Seat', 'pick-approved', '-Project', 'pick-approved-proj', '-ApprovedPlanId', $approvalPlan, '-NoLaunch', '-Json')
    Assert-True ($goodApproval.ExitCode -eq 0) "the exact approval was refused: $($goodApproval.Text)"
    Assert-True ((Get-RegistrySummary).Contains('pick-approved=pick-approved-proj')) 'the approved creation did not happen'

    # --- 19k. r<number> retires through Retire-Seat's own gate ------------------------------------
    $retireRoster = Invoke-PickerRun @('q') @('-NoLaunch', '-Json')
    $retireNumber = Get-PickerNumber $retireRoster 'pick-retire'
    Assert-True ($retireNumber -gt 0) 'the seat to retire was not on the roster'
    $retireDeclined = Invoke-PickerRun @("r$retireNumber", 'no', 'q') @('-NoLaunch', '-Json')
    Assert-True ($retireDeclined.Text.Contains('was not retired')) "a declined retirement did not say so: $($retireDeclined.Text)"
    Assert-True ((Get-RegistrySummary).Contains('pick-retire=pick-retire-proj')) 'a declined retirement retired the seat anyway'
    $retired = Invoke-PickerRun @("r$retireNumber", 'yes', 'q') @('-NoLaunch', '-Json')
    Assert-True ($retired.Text.Contains('plan_id')) "the retirement plan was not shown before the approval: $($retired.Text)"
    Assert-True ($retired.Text.Contains('retired')) "the retirement did not report itself: $($retired.Text)"
    Assert-True (-not (Get-RegistrySummary).Contains('pick-retire=')) 'the retired seat is still in the registry'
    Assert-True (@(Get-ChildItem -LiteralPath (Get-SeatArchiveDirectory -Workspace $fixture) -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -cmatch '^pick-retire-' }).Count -eq 1) "the retired seat's Desk was not archived"

    # --- 19l. The Orca tab: renamed whenever a handle is given, asked about never, through a real child
    #
    # THE ARGUMENTS COME FROM THE INSTALLED BINARY'S --help (1.4.198, 2026-09-10), never from memory.
    Assert-Equal "terminal rename --terminal term_fixture --title seat: pick-titled" `
        ((@(Get-OrcaTerminalRenameArguments -TerminalHandle 'term_fixture' -Seat 'pick-titled')) -join ' ') 'the Orca rename argv is not the one the installed binary documents'
    Assert-Equal 'False' ([string](Get-SeatPickerTabRename -TerminalHandle '').rename) 'a tab was renamed with no terminal handle to rename'
    Assert-Equal 'True' ([string](Get-SeatPickerTabRename -TerminalHandle 'term_fixture').rename) 'a terminal handle did not produce a rename'

    # A STAND-IN ON PATH, so the argv reaching a real process is what is measured rather than the
    # string this suite composed. Calling the real `orca` would be a side effect in a gate run.
    $orcaStubDirectory = Join-Path $fixture 'orca-stub'
    New-Item -ItemType Directory -Path $orcaStubDirectory -Force | Out-Null
    $orcaArgvPath = Join-Path $fixture 'orca-argv.txt'
    [IO.File]::WriteAllText((Join-Path $orcaStubDirectory 'orca.cmd'), "@echo off`r`n> `"$orcaArgvPath`" echo %*`r`nexit /b 0`r`n", $utf8)
    $savedPath = $env:PATH
    $env:PATH = "$orcaStubDirectory;$savedPath"
    try {
        $renamed = Set-OrcaTerminalTitle -TerminalHandle 'term_fixture' -Seat 'pick-titled'
        Assert-Equal 'renamed' ([string]$renamed.outcome) "the tab rename did not succeed against a stand-in that exits 0: $([string]$renamed.reason)"
        $orcaArgv = ([IO.File]::ReadAllText($orcaArgvPath) -replace '\s+', ' ').Trim()
        Assert-True ($orcaArgv.Contains('--terminal term_fixture')) "the stand-in was not given the terminal handle: $orcaArgv"
        Assert-True ($orcaArgv.Contains('--title "seat: pick-titled"')) "the stand-in was not given the seat title: $orcaArgv"
    }
    finally { $env:PATH = $savedPath }

    # THE DECISION CARRIES THE RENAME AND THE LAUNCHER PERFORMS IT, because a tab titled for a seat
    # the acquisition still refuses would be a title for somewhere nobody is sitting.
    #
    # AND A DECOY ANSWER IN THE QUEUE, WHICH IS WHAT THIS CASE IS FOR SINCE 2026-09-14. The prompt is
    # gone, so the property to pin is that nothing is asked on the path that ACTUALLY RENAMES -- the
    # branch a re-added question would land in, where an absence-based check that only watched the
    # no-handle branch would stay green. An answer left unconsumed is what proves it: a restored
    # prompt would eat this 'yes' and the count would drop to zero.
    $script:SeatPickerScriptedInput = [Collections.Generic.Queue[string]]::new()
    $script:SeatPickerScriptedInput.Enqueue('yes')
    $acceptedTab = New-SeatPickerDecision -Seat 'pick-titled' -Project 'pick-titled-proj' -ConversationId $titledConversation -Action 'resume' -TerminalHandle 'term_fixture'
    Assert-Equal 'True' ([string]$acceptedTab.rename_tab) 'a terminal handle did not put the rename on the decision'
    Assert-Equal 'term_fixture' ([string]$acceptedTab.terminal_handle) 'the decision did not carry the handle to rename'
    Assert-Equal '1' ([string]$script:SeatPickerScriptedInput.Count) 'the decision asked a question before renaming the tab'
    # AND NO HANDLE RENAMES NOTHING AND ASKS NOTHING EITHER, WITH A DECOY IN THE ENVIRONMENT where the
    # wrong code looks. The handle is resolved ONCE, by the launcher's parameter default, so an empty
    # one means "not this tab" -- a fallback to ORCA_TERMINAL_HANDLE here would read the variable
    # straight back and retitle a real tab anyway, which is what the first version did and what an
    # Orca terminal running this suite is asked to prove.
    $savedTerminal = $env:ORCA_TERMINAL_HANDLE
    $env:ORCA_TERMINAL_HANDLE = 'term_environment_decoy'
    try {
        $script:SeatPickerScriptedInput = [Collections.Generic.Queue[string]]::new()
        $script:SeatPickerScriptedInput.Enqueue('yes')
        $noRename = New-SeatPickerDecision -Seat 'pick-titled' -Project 'pick-titled-proj' -ConversationId $titledConversation -Action 'resume' -TerminalHandle ''
        Assert-Equal 'False' ([string]$noRename.rename_tab) 'a decision with no terminal handle still renamed a tab'
        Assert-Equal '' ([string]$noRename.terminal_handle) 'a decision with no terminal handle carried one out of the environment'
        Assert-Equal '1' ([string]$script:SeatPickerScriptedInput.Count) 'the decision asked a question with no handle to rename'
    }
    finally {
        $env:ORCA_TERMINAL_HANDLE = $savedTerminal
        $script:SeatPickerScriptedInput = $null
    }

    # --- 19m. Input that ENDS is not input that is empty -------------------------------------------
    #
    # Measured 2026-09-10: at EOF Read-Host returns $null and keeps returning it, where a reader
    # pressing Enter returns ''. An empty answer re-prompts, so without this the picker would
    # re-prompt forever rather than stop. Driven as a real child with real end-of-input, because
    # nothing in-process can hand Read-Host an ended console.
    # THE PREFERENCE IS DROPPED ACROSS THE CALL ITSELF, for the reason Invoke-SeatHelper carries: at
    # 'Stop' the first ErrorRecord the redirection produces terminates this suite DURING the
    # redirection, carrying the CHILD's message -- which reads as a suite bug rather than as the
    # refusal being measured.
    $endedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $ended = @()
    $endedCode = 0
    try {
        $ended = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ("& { . '" + (Join-Path $PSScriptRoot 'SeatPicker.ps1') + "'; Read-SeatPickerLine -Prompt 'Seat' }") 2>&1)
        $endedCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $endedPreference }
    $endedText = ((@($ended | ForEach-Object { [string]$_ }) -join ' ') -replace '\s+', ' ')
    Assert-True ($endedCode -ne 0) "the picker read the end of its input as an answer: $endedText"
    Assert-True ($endedText.Contains('its input ended')) "the end-of-input refusal did not say what happened: $endedText"

    # --- 20. THE DESK OVERVIEW'S OWN LINE, AND THE TIER IT MUST NOT WIDEN (plan step 14) ----------
    #
    # `PLAN-seat-launch.md` step 14. Until 2026-09-10 `Get-DeskOverview.ps1` reported another seat's
    # liveness and said nothing at all about THIS one, so the reader's own Desk could not answer "am
    # I sat down here, since when, and as which conversation" while it answered the liveness half
    # about everyone else. What is measured here is that this seat's line carries the agent identity,
    # the bind time and the conversation -- and that the other seats' lines still do not.
    #
    # THE REAL HELPER AS A CHILD PROCESS, not its functions in this scope. The overview's contract
    # includes what lands on stdout as one JSON object, and the cosmetic-tier assertion below is
    # about the whole payload rather than about any one function's return.
    #
    # ITS OWN SEATS AND ITS OWN TRANSCRIPT TREES, touched by no earlier case, for the reason case 19
    # states: the two-seat suite renaming a Book out from under a later section is what that rule
    # cost to learn.
    $deskTranscripts = Join-Path $fixture 'desk-transcripts'
    $deskTranscriptDirectory = Join-Path $deskTranscripts 'D--Fixture'
    # A SECOND, DECOY TREE, REACHED THE WAY A DEFECT WOULD REACH IT. `CLAUDE_CONFIG_DIR` is what
    # Get-SeatTranscriptRoot falls back to, so an overview that ignored its -TranscriptRoot parameter
    # and resolved the root itself lands HERE -- and finds the same conversation id carrying a
    # different title. An absence-based check would have found nothing to report; this one reports a
    # wrong VALUE.
    $deskDecoyConfig = Join-Path $fixture 'desk-decoy-config'
    $deskDecoyDirectory = Join-Path $deskDecoyConfig 'projects/D--Fixture'
    foreach ($directory in @($deskTranscriptDirectory, $deskDecoyDirectory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    function New-DeskTranscript([string]$Directory, [string]$SessionId, [string]$Title) {
        $lines = @('{"type":"mode","mode":"normal"}',
                   '{"type":"user","message":{"role":"user","content":"a first turn"}}',
                   ('{"type":"ai-title","aiTitle":"' + $Title + '","sessionId":"' + $SessionId + '"}'))
        [IO.File]::WriteAllText((Join-Path $Directory "$SessionId.jsonl"), ((@($lines) -join "`n") + "`n"), $utf8)
    }

    $deskOwnConversation = [guid]::NewGuid().ToString()
    $deskForeignConversation = [guid]::NewGuid().ToString()
    New-DeskTranscript $deskTranscriptDirectory $deskOwnConversation 'Own seat desk subject'
    New-DeskTranscript $deskTranscriptDirectory $deskForeignConversation 'FOREIGN DESK CONVERSATION'
    New-DeskTranscript $deskDecoyDirectory $deskOwnConversation 'DECOY TRANSCRIPT TREE'

    foreach ($pair in @(
        @{ seat = 'desk-own';     project = 'desk-own-proj';     books = @() },
        @{ seat = 'desk-bare';    project = 'desk-bare-proj';    books = @() },
        @{ seat = 'desk-orphan';  project = 'desk-orphan-proj';  books = @() },
        # THE FOREIGN SEAT CARRIES REAL MATERIAL, so its row is not empty for want of anything to
        # report: one open Book, its own advisory conversation, and a transcript that has a title.
        @{ seat = 'desk-foreign'; project = 'desk-foreign-proj'; books = @('shelf/desk-foreign-book') })) {
        Initialize-SeatForFixture -StateDirectory $stateDir -Seat ([string]$pair.seat) -Project ([string]$pair.project) `
            -OpenBooks @($pair.books) -OpenProjects @("projects/$([string]$pair.project)") | Out-Null
    }
    Write-SeatActivity -StateDirectory $stateDir -Seat 'desk-foreign' -Note 'seat entered' -Conversation $deskForeignConversation | Out-Null

    # TWO LIVE STAND-IN AGENTS: one bound with its claim held, one bound with no handle at all, which
    # is the only way to reach `orphaned`.
    $deskAgent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
    [void]$dummies.Add($deskAgent)
    $deskAgentIdentity = Get-AgentProcessIdentity -ProcessId $deskAgent.Id
    $deskOrphanAgent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
    [void]$dummies.Add($deskOrphanAgent)
    $deskLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat 'desk-own' `
            -AgentProcessId ([int]$deskAgent.Id) -AgentStartUtc $deskAgentIdentity -SessionId $deskOwnConversation `
            -SeatId 'desk-own-id' -State 'committed' | Out-Null
        Write-SeatBinding -Workspace $fixture -StateDirectory $stateDir -Seat 'desk-orphan' `
            -AgentProcessId ([int]$deskOrphanAgent.Id) -SessionId '' -SeatId 'desk-orphan-id' -State 'committed' | Out-Null
    }
    finally { Exit-BookLock -Lock $deskLock }

    # A BIND TIME THAT CANNOT BE MISTAKEN FOR "NOW". Write-SeatBinding stamps its own, so the field
    # is edited to a distinctive past instant -- the same thing case 19c does to an activity record.
    # An implementation that stamped the current time, or that read the binding a second time, would
    # report a DIFFERENT value here rather than merely a missing one.
    $deskBoundUtc = '2026-01-02T03:04:05.6789012Z'
    $deskBindingPath = Get-SeatBindingPath -StateDirectory $stateDir -Seat 'desk-own'
    $deskBindingRecord = Read-SeatBinding -StateDirectory $stateDir -Seat 'desk-own'
    $deskBindingRecord.bound_utc = $deskBoundUtc
    [IO.File]::WriteAllText($deskBindingPath, (($deskBindingRecord | ConvertTo-Json -Depth 4) + "`n"), $utf8)
    [void]$claims.Add((Enter-SeatClaim -StateDirectory $stateDir -Seat 'desk-own'))

    # The overview as a real child, with the decoy config directory exported so an implementation
    # that resolves the transcript root itself reads the wrong tree.
    $savedDeskConfig = $env:CLAUDE_CONFIG_DIR
    $deskOverviewPath = Join-Path $PSScriptRoot 'Get-DeskOverview.ps1'
    function Invoke-DeskOverview([string[]]$ArgumentList) {
        $old = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $emitted = @()
        try { $emitted = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $deskOverviewPath @ArgumentList 2>&1) }
        finally { $ErrorActionPreference = $old }
        $code = $LASTEXITCODE
        $out = @($emitted | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
        $err = @($emitted | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
        $body = @($out | Where-Object { $_.Trim().StartsWith('{') })
        [pscustomobject]@{
            ExitCode = $code
            Json = ($body -join '')
            Result = if ($body.Count) { ($body[-1] | ConvertFrom-Json) } else { $null }
            Text = (((@($out) + @($err)) -join ' ') -replace '\s+', ' ')
        }
    }

    try {
        $env:CLAUDE_CONFIG_DIR = $deskDecoyConfig

        # --- 20a. THIS SEAT'S AGENT IDENTITY, BIND TIME AND CONVERSATION ---------------------------
        #
        # NO -Seat, so the seat is resolved from the binding this agent holds. That is the route a
        # bound session actually takes, and it makes `seat_source` an answer rather than the constant
        # `explicit` every fixture that names its seat would get.
        $ownRun = Invoke-DeskOverview @('-WorkspacePath', $fixture, '-TranscriptRoot', $deskTranscripts,
                                        '-AgentProcessId', ([string][int]$deskAgent.Id), '-Json')
        Assert-True ($ownRun.ExitCode -eq 0) "the Desk overview failed at a bound seat: $($ownRun.Text)"
        $ownSeat = Get-Field $ownRun.Result 'this_seat' 'the Desk overview'
        Assert-Equal 'desk-own' ([string](Get-Field $ownSeat 'seat' "this seat's line")) 'the overview reported the wrong seat for a bound agent'
        Assert-Equal 'binding' ([string](Get-Field $ownSeat 'seat_source' "this seat's line")) 'a seat resolved from a verified binding was not reported as such'
        Assert-Equal 'held' ([string](Get-Field $ownSeat 'claim_state' "this seat's line")) 'a seat with a live claim handle was not reported as held'
        Assert-Equal 'True' ([string](Get-Field $ownSeat 'claimed' "this seat's line")) 'a held seat did not report itself claimed'
        Assert-Equal ([string][int]$deskAgent.Id) ([string](Get-Field $ownSeat 'agent_pid' "this seat's line")) 'the overview named the wrong agent process'
        Assert-Equal $deskAgentIdentity ([string](Get-Field $ownSeat 'agent_start_utc' "this seat's line")) "the overview reported the wrong agent start time, so a reused PID would look like this agent"
        Assert-Equal $deskBoundUtc ([string](Get-Field $ownSeat 'bound_utc' "this seat's line")) 'the overview did not report the bind time the binding records'
        Assert-Equal 'desk-own-id' ([string](Get-Field $ownSeat 'seat_id' "this seat's line")) 'the overview reported the wrong seat incarnation'
        Assert-Equal 'committed' ([string](Get-Field $ownSeat 'binding_state' "this seat's line")) 'a committed binding was not reported as committed'
        Assert-Equal 'True' ([string](Get-Field $ownSeat 'this_agent' "this seat's line")) 'the overview did not recognise the binding as naming this process''s agent'
        Assert-Equal 'False' ([string](Get-Field $ownSeat 'binding_stale' "this seat's line")) 'a binding whose agent is alive was reported stale'

        # THE CONVERSATION, AND THE TITLE THAT PROVES WHICH TREE WAS READ. `DECOY TRANSCRIPT TREE` is
        # the same conversation id under the CLAUDE_CONFIG_DIR exported above, so an overview that
        # ignored -TranscriptRoot answers with that title instead of failing to find one.
        Assert-Equal $deskOwnConversation ([string](Get-Field $ownSeat 'session_id' "this seat's line")) "the overview reported the wrong conversation for a bound seat"
        Assert-Equal 'binding' ([string](Get-Field $ownSeat 'conversation_source' "this seat's line")) "a binding's own conversation was not read from the binding"
        Assert-Equal 'titled' ([string](Get-Field $ownSeat 'title_status' "this seat's line")) 'a conversation with an ai-title record was not read as titled'
        Assert-Equal 'Own seat desk subject' ([string](Get-Field $ownSeat 'title' "this seat's line")) 'the overview read the title out of the wrong transcript tree'
        Assert-True ([string](Get-Field $ownSeat 'conversation_line' "this seat's line")).Contains('"Own seat desk subject"') "this seat's conversation line did not render its title: $([string]$ownSeat.conversation_line)"
        Assert-True ([string]$ownSeat.conversation_line -cnotmatch 'advisory') 'a verified binding was labelled advisory on the overview'
        # AND WHETHER THAT CONVERSATION IS THIS ONE, which is the difference between "your seat last
        # held X" and "you are X". True only when the binding names this agent AND the binding is the
        # record that won.
        Assert-Equal 'True' ([string](Get-Field $ownSeat 'is_this_conversation' "this seat's line")) 'the overview did not recognise its own conversation'

        # --- 20b. THE COSMETIC TIER: another seat stays counts and liveness -------------------------
        #
        # Locked 2026-09-07. `desk-foreign` has a real conversation with a real title, planted
        # exactly where a widened implementation would find it -- so this reads a wrong VALUE
        # appearing rather than a field failing to appear.
        Assert-True (-not $ownRun.Json.Contains('FOREIGN DESK CONVERSATION')) 'the Desk overview put another seat''s conversation TITLE on this reader''s Desk'
        Assert-True (-not $ownRun.Json.Contains($deskForeignConversation)) 'the Desk overview put another seat''s conversation ID on this reader''s Desk'
        $foreignRows = @(@(Get-Field $ownRun.Result 'other_seats' 'the Desk overview') | Where-Object { [string]$_.seat -ceq 'desk-foreign' })
        Assert-Equal '1' ([string]$foreignRows.Count) 'the foreign seat has no row at all, so the two assertions above would pass for the wrong reason'
        Assert-Equal 'free' ([string](Get-Field $foreignRows[0] 'claim_state' 'the foreign seat''s row')) 'the foreign seat''s row lost its liveness state'
        Assert-Equal '1' ([string](Get-Field $foreignRows[0] 'open_book_count' 'the foreign seat''s row')) 'the foreign seat''s row lost its open-Book count'
        $foreignFields = @($foreignRows[0].PSObject.Properties | ForEach-Object { $_.Name })
        foreach ($withheld in @('title', 'session_id', 'conversation_line', 'conversation_source')) {
            Assert-True ($foreignFields -cnotcontains $withheld) "another seat's row carries '$withheld', which the cosmetic tier withholds: it has $($foreignFields -join ', ')"
        }

        # --- 20c. A SEAT WITH NOTHING RECORDED STILL SAYS SOMETHING --------------------------------
        $bareRun = Invoke-DeskOverview @('-WorkspacePath', $fixture, '-Seat', 'desk-bare', '-TranscriptRoot', $deskTranscripts, '-Json')
        Assert-True ($bareRun.ExitCode -eq 0) "the Desk overview failed at an unbound seat: $($bareRun.Text)"
        $bareSeat = Get-Field $bareRun.Result 'this_seat' 'the Desk overview at an unbound seat'
        Assert-Equal 'explicit' ([string](Get-Field $bareSeat 'seat_source' 'an explicitly named seat')) 'a seat named on the command line was not reported as explicit'
        Assert-Equal 'free' ([string](Get-Field $bareSeat 'claim_state' 'an unbound seat')) 'a seat nobody holds was not reported free'
        Assert-Equal '0' ([string](Get-Field $bareSeat 'agent_pid' 'an unbound seat')) 'an unbound seat named an agent process'
        Assert-Equal '' ([string](Get-Field $bareSeat 'bound_utc' 'an unbound seat')) 'an unbound seat reported a bind time'
        Assert-Equal 'no-conversation' ([string](Get-Field $bareSeat 'title_status' 'an unbound seat')) 'a seat nothing has recorded a conversation for did not say so'
        # NEVER BLANK, which is the whole reason the wording is shared with the picker's column: a
        # blank reads as an untitled conversation and cannot be told from a pruned history.
        Assert-True (-not [string]::IsNullOrWhiteSpace([string](Get-Field $bareSeat 'conversation_line' 'an unbound seat'))) 'an unbound seat rendered a blank conversation line, which reads as an untitled conversation'
        Assert-Equal 'False' ([string](Get-Field $bareSeat 'is_this_conversation' 'an unbound seat')) 'a seat with no conversation claimed to be this one'

        # --- 20d. AN ORPHANED SEAT NAMES ITS AGENT AND ITS REPAIR -----------------------------------
        #
        # The state a bare name hid until 2026-09-09: the bound agent still running with its claim
        # holder gone. Reporting it as unclaimed reads as "that seat is finished", which is the
        # opposite of true, so this seat's own line says which process is still there and what fixes
        # it.
        $orphanRun = Invoke-DeskOverview @('-WorkspacePath', $fixture, '-Seat', 'desk-orphan', '-TranscriptRoot', $deskTranscripts, '-Json')
        Assert-True ($orphanRun.ExitCode -eq 0) "the Desk overview failed at an orphaned seat: $($orphanRun.Text)"
        $orphanSeat = Get-Field $orphanRun.Result 'this_seat' 'the Desk overview at an orphaned seat'
        Assert-Equal 'orphaned' ([string](Get-Field $orphanSeat 'claim_state' 'an orphaned seat')) 'a seat whose agent is alive with no claim handle was not reported as orphaned'
        $orphanNote = [string](Get-Field $orphanSeat 'state_note' 'an orphaned seat')
        Assert-True ($orphanNote.Contains("agent $([int]$deskOrphanAgent.Id) alive")) "the orphaned line did not name the agent still running: $orphanNote"
        Assert-True ($orphanNote.Contains('re-enter')) "the orphaned line did not name the repair: $orphanNote"

        # --- 20e. THE SCOPE LINE SAYS WHAT WAS READ ------------------------------------------------
        #
        # A reported field that describes LESS than the operation performed is the same defect family
        # as one describing more, and this helper's `scope` is what a reader trusts about it. Reading
        # a conversation title reads a Claude Code transcript, which is a file outside the workspace.
        $scopeLine = [string](Get-Field $ownRun.Result 'scope' 'the Desk overview')
        Assert-True ($scopeLine.Contains('transcript')) "the scope line does not admit that a transcript was read: $scopeLine"
        Assert-True ($scopeLine.Contains('No Book or Project page content was read')) "the scope line dropped the promise it still keeps: $scopeLine"

        # --- 20f. ONE DERIVATION, TWO SURFACES ------------------------------------------------------
        #
        # The picker's roster row and the overview's own line are different SHAPES and the same
        # FACTS. Two copies of the derivation would agree today and diverge the first time one of the
        # six title statuses changed, which is what SeatConversation.ps1 exists to prevent -- so the
        # two surfaces are compared against each other rather than each against a literal.
        $deskPickerRow = Get-PickerRow (@(Get-SeatPickerRows -StateDirectory $stateDir -TranscriptRoot $deskTranscripts)) 'desk-own'
        foreach ($shared in @('session_id', 'conversation_source', 'title', 'title_status', 'entry_action', 'entry_note')) {
            Assert-Equal ([string]$deskPickerRow.$shared) ([string]$ownSeat.$shared) "the picker and the Desk overview disagree about '$shared' at the same seat"
        }
        # AND THE THIRD ARM OF THE SHARED DECISION IS REACHABLE ON ITS OWN. `not-looked-up` is a
        # different fact from `no-title`, and before the extraction it existed only inside the
        # picker's row builder.
        $skipped = Get-SeatConversationView -StateDirectory $stateDir -Seat 'desk-own' -TranscriptRoot $deskTranscripts -SkipTitle
        Assert-Equal 'not-looked-up' ([string](Get-Field $skipped 'title_status' 'a view that skipped titles')) 'a caller that asked for no titles was told the conversation had none'
        Assert-Equal $deskOwnConversation ([string]$skipped.session_id) 'skipping the title also lost the conversation'
        # AND IT DOES NOT GUESS WHAT ENTERING WOULD DO EITHER. The entry action rests on the transcript
        # fact this arm never read, and a plausible `resume` returned from here is exactly the answer
        # that sent a reader to `No conversation found with session ID`.
        Assert-Equal 'not-derived' ([string](Get-Field $skipped 'entry_action' 'a view that skipped titles')) 'a view that read no transcript still said what entering the conversation would do'
    }
    finally { $env:CLAUDE_CONFIG_DIR = $savedDeskConfig }

    # --- 21. THE CONVERSATION HISTORY, AND THE SEAT A RE-BIND USED TO FORGET (plan step 8) --------
    #
    # WHAT THIS CLOSES, AND IT WAS A STATED COST RATHER THAN A DISCOVERY. Until 2026-09-10 the resume
    # lookup read the BINDING's own `session_id`, so a seat held ONE conversation: re-bound by a
    # second conversation, it forgot the first, and resuming the first was offered the roster instead
    # of its own seat. `conversations.json` is the history that closes it, and the row below is the
    # exact sequence the binding could not survive -- bind, re-bind, resume the older one.
    #
    # ITS OWN FIXTURE WORKSPACE AND ITS OWN AGENTS, for case 16's reason: this case kills agents and
    # corrupts a record on purpose, and sharing seats with a case that runs after it turns a later
    # red into a crash naming nothing.
    $histWorkspace = Join-Path $fixture 'history'
    $histState = Join-Path $histWorkspace '.claude'
    New-Item -ItemType Directory -Path $histState -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $histWorkspace 'notebook') -Force | Out-Null
    foreach ($pair in @(@('hist-a', 'hist-a-proj'), @('hist-b', 'hist-b-proj'), @('hist-legacy', 'hist-legacy-proj'), @('hist-late', 'hist-late-proj'), @('hist-retire', 'hist-retire-proj'))) {
        Initialize-SeatForFixture -StateDirectory $histState -Seat $pair[0] -Project $pair[1] | Out-Null
    }
    function Invoke-HistoryHook([string]$Source, [string]$SessionId, [int]$AgentPid, [double]$Deadline = 2) {
        $payload = @{ hook_event_name = 'SessionStart'; session_id = $SessionId; cwd = $histWorkspace; source = $Source }
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress -Depth 8)))
        $invocation = Invoke-SeatHelper '../.claude/hooks/Get-SeatStartContext.ps1' @(
            '-StateDirectory', $histState, '-WorkspacePath', $histWorkspace,
            '-AgentProcessId', ([string]$AgentPid), '-DeadlineSeconds', ([string]$Deadline),
            '-InputJsonBase64', $encoded)
        $context = ''
        foreach ($line in @($invocation.Stdout)) {
            if (-not $line.Trim().StartsWith('{')) { continue }
            try { $context = [string]($line | ConvertFrom-Json).hookSpecificOutput.additionalContext } catch { }
        }
        [pscustomobject]@{ ExitCode = $invocation.ExitCode; Text = $invocation.Text; Context = $context }
    }
    function Enter-HistorySeat([string]$SeatName, [string]$SessionId, [int]$AgentPid) {
        Invoke-SeatHelper 'Enter-LibrarySeat.ps1' @('-Seat', $SeatName, '-WorkspacePath', $histWorkspace,
            '-AgentProcessId', ([string]$AgentPid), '-SessionId', $SessionId, '-Json')
    }
    function Start-HistoryAgent {
        $agent = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 240') -PassThru -WindowStyle Hidden
        [void]$dummies.Add($agent)
        $agent
    }
    function Stop-HistoryAgent($Agent, [string]$SeatName) {
        Stop-Process -Id $Agent.Id -Force -ErrorAction SilentlyContinue
        try { [void]$Agent.WaitForExit(15000) } catch { }
        $until = [DateTime]::UtcNow.AddSeconds(15)
        while ([DateTime]::UtcNow -lt $until) {
            if ($null -eq (Get-AgentProcessIdentity -ProcessId ([int]$Agent.Id))) { break }
            Start-Sleep -Milliseconds 100
        }
        $until = [DateTime]::UtcNow.AddSeconds(15)
        while ([DateTime]::UtcNow -lt $until -and (Test-SeatClaim -StateDirectory $histState -Seat $SeatName)) { Start-Sleep -Milliseconds 100 }
    }

    # --- 21a. THE SEQUENCE THE BINDING COULD NOT SURVIVE -------------------------------------------
    #
    # THROUGH THE REAL HELPER AS A PROCESS, so what is proved is the shipped write rather than this
    # scope's idea of one. Two conversations sit at hist-a in turn, each agent ending before the next
    # begins -- which is exactly what a reader who works at a seat on Monday and again on Tuesday
    # produces, and exactly what erased Monday's record.
    $histAgentOne = Start-HistoryAgent
    Assert-True ((Enter-HistorySeat 'hist-a' 'conv-monday' $histAgentOne.Id).ExitCode -eq 0) 'the fixture could not seat the first conversation'
    Stop-HistoryAgent $histAgentOne 'hist-a'
    $histAgentTwo = Start-HistoryAgent
    Assert-True ((Enter-HistorySeat 'hist-a' 'conv-tuesday' $histAgentTwo.Id).ExitCode -eq 0) 'the fixture could not re-seat hist-a with a second conversation'
    # THE BINDING HAS MOVED ON, which is the state that used to be the whole answer. Asserted so the
    # row below cannot pass because the re-bind quietly failed to happen.
    Assert-Equal 'conv-tuesday' ([string](Read-SeatBinding -StateDirectory $histState -Seat 'hist-a').session_id) 'the second conversation never took the binding, so this case would prove nothing'
    Stop-HistoryAgent $histAgentTwo 'hist-a'

    # THE OLDER CONVERSATION STILL FINDS ITS SEAT. This is the assertion the whole step exists for.
    $mondayHistory = @(Get-SeatsForConversation -StateDirectory $histState -SessionId 'conv-monday')
    Assert-Equal '1' ([string]@($mondayHistory).Count) 'the seat forgot the conversation that sat there before the one holding its binding'
    Assert-Equal 'hist-a' ([string]$mondayHistory[0].seat) 'the older conversation was located at the wrong seat'
    Assert-Equal 'binding' ([string]$mondayHistory[0].source) 'a conversation seated through the real helper was not recorded as a verified binding'

    # AND THE HOOK PUTS IT BACK, which is the reader-visible half: before this landed, resuming the
    # older conversation was handed the roster.
    $histResumeAgent = Start-HistoryAgent
    $mondayResume = Invoke-HistoryHook 'resume' 'conv-monday' $histResumeAgent.Id
    Assert-True ($mondayResume.ExitCode -eq 0) "resuming the older conversation exited non-zero: $($mondayResume.Text)"
    Assert-True ($mondayResume.Context.Contains('re-bound to the seat it last held')) "the older conversation was not put back at its own seat: $($mondayResume.Context)"
    Assert-True (-not $mondayResume.Context.Contains('Ask the reader which seat')) 'the older conversation was offered the roster instead of its seat'
    Assert-Equal 'conv-monday' ([string](Read-SeatBinding -StateDirectory $histState -Seat 'hist-a').session_id) 'the re-bind did not restore the resumed conversation'
    Stop-HistoryAgent $histResumeAgent 'hist-a'

    # --- 21b. NOTHING IS PRUNED, AND BOTH SEATS ARE KEPT ------------------------------------------
    #
    # A CONVERSATION AT TWO SEATS IS LEGITIMATE (D9), and the lookup takes the NEWEST rather than
    # picking silently. hist-b is entered second, so it must lead -- and hist-a must still be there,
    # because a lookup that returned one row would be pruning by another name.
    $histAgentThree = Start-HistoryAgent
    Assert-True ((Enter-HistorySeat 'hist-b' 'conv-monday' $histAgentThree.Id).ExitCode -eq 0) 'the fixture could not seat one conversation at a second seat'
    Stop-HistoryAgent $histAgentThree 'hist-b'
    $twoSeats = @(Get-SeatsForConversation -StateDirectory $histState -SessionId 'conv-monday')
    Assert-Equal '2' ([string]@($twoSeats).Count) 'a conversation that sat at two seats was not recorded at both'
    Assert-Equal 'hist-b' ([string]$twoSeats[0].seat) 'the lookup did not take the newest record'
    Assert-Equal 'hist-a' ([string]$twoSeats[1].seat) 'the older seat was dropped rather than kept behind the newest'
    # AND hist-a STILL HOLDS BOTH CONVERSATIONS, which is what "no automatic pruning" means on disk.
    $histARecord = Read-SeatConversations -StateDirectory $histState -Seat 'hist-a'
    $histAIds = @(@($histARecord.conversations) | ForEach-Object { [string]$_.session_id } | Sort-Object)
    Assert-Equal 'conv-monday, conv-tuesday' (@($histAIds) -join ', ') "a seat's history was pruned to the conversation holding its binding"

    # A THIRD CONVERSATION, AND THE REASON TWO WERE NOT ENOUGH. Written after falsification found the
    # gap: disabling the migration's own "this seat already has a history" guard makes every write
    # replace the file with the binding's single record, and with only two conversations in play the
    # one it drops is put straight back by the record that follows -- so the suite stayed green over
    # a change that truncates a real seat's history. THREE is the smallest number at which the loss
    # is visible, because the third write drops the FIRST and re-adds only the third.
    $histAgentFour = Start-HistoryAgent
    Assert-True ((Enter-HistorySeat 'hist-a' 'conv-wednesday' $histAgentFour.Id).ExitCode -eq 0) 'the fixture could not seat a third conversation'
    Stop-HistoryAgent $histAgentFour 'hist-a'
    $threeIds = @(@((Read-SeatConversations -StateDirectory $histState -Seat 'hist-a').conversations) | ForEach-Object { [string]$_.session_id } | Sort-Object)
    Assert-Equal 'conv-monday, conv-tuesday, conv-wednesday' (@($threeIds) -join ', ') "a third conversation at one seat dropped the first: $(@($threeIds) -join ', ')"

    # THE STAMPS ON ONE RECORD MOVE IN ONE DIRECTION ONLY. `first_seen_utc` answers when a
    # conversation began at a seat and must survive its coming back; `last_seen_utc` is what the
    # lookup sorts on and must not. Nothing else reads `first_seen_utc`, so without this it is a
    # field the schema promises and no run measures.
    function Get-HistoryRecord([string]$SeatName, [string]$SessionId) {
        @(@((Read-SeatConversations -StateDirectory $histState -Seat $SeatName).conversations) |
            Where-Object { [string]$_.session_id -ceq $SessionId }) | Select-Object -First 1
    }
    $mondayBefore = Get-HistoryRecord 'hist-a' 'conv-monday'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$mondayBefore.first_seen_utc)) 'the record carries no first_seen_utc, so the comparison below would prove nothing'
    $histAgentFive = Start-HistoryAgent
    Assert-True ((Enter-HistorySeat 'hist-a' 'conv-monday' $histAgentFive.Id).ExitCode -eq 0) 'the fixture could not bring the first conversation back to its seat'
    Stop-HistoryAgent $histAgentFive 'hist-a'
    $mondayAfter = Get-HistoryRecord 'hist-a' 'conv-monday'
    Assert-Equal ([string]$mondayBefore.first_seen_utc) ([string]$mondayAfter.first_seen_utc) 'a conversation coming back to its seat was recorded as having begun there just now'
    Assert-True ([string]$mondayAfter.last_seen_utc -cgt [string]$mondayBefore.last_seen_utc) 'a conversation coming back to its seat did not become that seat''s most recent record'

    # --- 21c. THE DAY-ONE MIGRATION: a seat bound before the record existed ------------------------
    #
    # THE STATE IS BUILT BY DELETING THE RECORD, not by hand-writing a binding: what an upgraded
    # checkout has is a real committed binding with no history beside it, and a fabricated binding
    # would prove that the seed agrees with the fixture. Without the seed, `conv-before` would be
    # unresumable the moment anything else sat at that seat -- a regression introduced by the feature
    # that exists to prevent one.
    $legacyAgent = Start-HistoryAgent
    Assert-True ((Enter-HistorySeat 'hist-legacy' 'conv-before' $legacyAgent.Id).ExitCode -eq 0) 'the fixture could not seat the pre-upgrade conversation'
    Stop-HistoryAgent $legacyAgent 'hist-legacy'
    Remove-Item -LiteralPath (Get-SeatConversationsPath -StateDirectory $histState -Seat 'hist-legacy') -Force
    Assert-Equal 'conv-before' ([string](Read-SeatBinding -StateDirectory $histState -Seat 'hist-legacy').session_id) 'the fixture did not leave a committed binding behind, so the seed below would prove nothing'
    Assert-Equal '0' ([string]@(Get-SeatsForConversation -StateDirectory $histState -SessionId 'conv-before').Count) 'the fixture did not actually remove the history it is about to have rebuilt'
    # THE SAME CONVERSATION SITS SOMEWHERE ELSE FIRST, and that is what makes the seed's STAMP
    # measurable. Written this way because the obvious assertion -- that the seeded record sorts
    # first WITHIN its own file -- passes either way: the seed is written a few milliseconds before
    # the record that follows it, so stamping it `now` produces the same order. What a wrong stamp
    # actually breaks is the CROSS-SEAT comparison the resume lookup makes, where a conversation that
    # moved on to another seat would be dragged back to the one it left.
    $laterAgent = Start-HistoryAgent
    Assert-True ((Enter-HistorySeat 'hist-late' 'conv-before' $laterAgent.Id).ExitCode -eq 0) 'the fixture could not seat the pre-upgrade conversation at a later seat'
    Stop-HistoryAgent $laterAgent 'hist-late'
    $afterUpgradeAgent = Start-HistoryAgent
    Assert-True ((Enter-HistorySeat 'hist-legacy' 'conv-after' $afterUpgradeAgent.Id).ExitCode -eq 0) 'the fixture could not seat the post-upgrade conversation'
    Stop-HistoryAgent $afterUpgradeAgent 'hist-legacy'
    $seeded = @(Get-SeatsForConversation -StateDirectory $histState -SessionId 'conv-before')
    Assert-Equal '2' ([string]@($seeded).Count) 'a conversation bound before the history existed was lost by the first write to it'
    Assert-True (@(@($seeded) | ForEach-Object { [string]$_.seat }) -ccontains 'hist-legacy') 'the seeded record named the wrong seat'
    # THE SEED CARRIES THE BINDING'S OWN bound_utc, NOT NOW. hist-late took this conversation AFTER
    # hist-legacy did, so hist-late is where a resume belongs -- and a seed stamped with the moment
    # the migration ran would make the seat the conversation left the newest record it has.
    Assert-Equal 'hist-late' ([string]$seeded[0].seat) 'the migration stamped the seeded record with the time it ran, so the seat this conversation had left came back as its newest'
    $legacyRecord = Read-SeatConversations -StateDirectory $histState -Seat 'hist-legacy'
    $legacyOrder = @(@($legacyRecord.conversations) | ForEach-Object { [string]$_.session_id })
    Assert-Equal 'conv-before, conv-after' (@($legacyOrder) -join ', ') 'the seeded record did not sort older than the conversation recorded on top of it'

    # AND THE RECOVERY PATH MIGRATES ONE TOO, which is the commit point that writes NO binding and
    # records NO conversation -- so it is the one branch where a pre-upgrade seat would be left
    # behind, and no other row reaches it. Built as a real orphan: the agent lives, its claim HOLDER
    # is killed, and the same agent re-enters.
    Initialize-SeatForFixture -StateDirectory $histState -Seat 'hist-orphan' -Project 'hist-orphan-proj' | Out-Null
    $orphanAgent = Start-HistoryAgent
    Assert-True ((Enter-HistorySeat 'hist-orphan' 'conv-orphan' $orphanAgent.Id).ExitCode -eq 0) 'the fixture could not seat the conversation it is about to orphan'
    Remove-Item -LiteralPath (Get-SeatConversationsPath -StateDirectory $histState -Seat 'hist-orphan') -Force
    Stop-Process -Id ([int](Read-SeatHolderAttempt -StateDirectory $histState -Seat 'hist-orphan').holder_pid) -Force -ErrorAction SilentlyContinue
    $orphanUntil = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $orphanUntil -and (Test-SeatClaim -StateDirectory $histState -Seat 'hist-orphan')) { Start-Sleep -Milliseconds 100 }
    Assert-Equal 'orphaned' ([string](Get-SeatClaimState -StateDirectory $histState -Seat 'hist-orphan' -AgentProcessId $orphanAgent.Id).state) 'the fixture did not reach an orphaned seat, so the recovery branch below would not be the one exercised'
    $recovered = Enter-HistorySeat 'hist-orphan' 'conv-orphan' $orphanAgent.Id
    Assert-True ($recovered.ExitCode -eq 0) "the orphan recovery failed: $($recovered.Text)"
    $recoveredResult = (@($recovered.Stdout | Where-Object { $_.Trim().StartsWith('{') }) -join "`n") | ConvertFrom-Json
    Assert-Equal 'True' ([string](Get-Field $recoveredResult 'recovered_orphan' 'the orphan recovery')) 'the seat was re-bound rather than recovered, so this row exercised the ordinary path'
    $orphanHistory = @(Get-SeatsForConversation -StateDirectory $histState -SessionId 'conv-orphan')
    Assert-Equal '1' ([string]@($orphanHistory).Count) 'recovering an orphaned pre-upgrade seat left its conversation unresumable'
    Assert-Equal 'hist-orphan' ([string]$orphanHistory[0].seat) 'the recovery seeded the wrong seat'
    Stop-HistoryAgent $orphanAgent 'hist-orphan'

    # --- 21d. A PENDING BINDING RECORDS NOTHING ----------------------------------------------------
    #
    # It belongs to an attempt that has not committed and names a conversation that may never have
    # sat anywhere. Written through the real writer under the real lock, because the rule lives in
    # Write-SeatBinding and a fixture that wrote the file itself would be asserting its own shape.
    Initialize-SeatForFixture -StateDirectory $histState -Seat 'hist-pending' -Project 'hist-pending-proj' | Out-Null
    $pendingLock = Enter-SeatRegistryLock -Workspace $histWorkspace
    try {
        Write-SeatBinding -Workspace $histWorkspace -StateDirectory $histState -Seat 'hist-pending' `
            -AgentProcessId ([Diagnostics.Process]::GetCurrentProcess().Id) -SessionId 'conv-uncommitted' `
            -SeatId 'pending-id' -State 'pending' | Out-Null
    }
    finally { Exit-BookLock -Lock $pendingLock }
    Assert-True (-not (Test-Path -LiteralPath (Get-SeatConversationsPath -StateDirectory $histState -Seat 'hist-pending') -PathType Leaf)) 'a pending binding wrote a conversation into the durable history'
    Assert-Equal '0' ([string]@(Get-SeatsForConversation -StateDirectory $histState -SessionId 'conv-uncommitted').Count) 'an uncommitted attempt made its conversation resumable'

    # --- 21e. THE WRITE IS REFUSED WITHOUT THE REGISTRY LOCK ---------------------------------------
    #
    # A LIVE CALL, not a reading of the source: parts of this repository have carried an assertion
    # that was present and inert, and the only thing that tells the two apart is running it.
    $unlockedRefusal = ''
    try {
        Write-SeatConversationRecord -Workspace $histWorkspace -StateDirectory $histState -Seat 'hist-a' `
            -SessionId 'conv-unlocked' -SeatId '' -Source 'launcher' | Out-Null
    }
    catch { $unlockedRefusal = [string]$_.Exception.Message }
    Assert-True ($unlockedRefusal -clike '*registry/Desk lock*') "a conversation was recorded with no registry lock held: '$unlockedRefusal'"
    Assert-Equal '0' ([string]@(Get-SeatsForConversation -StateDirectory $histState -SessionId 'conv-unlocked').Count) 'the refused write landed anyway'

    # --- 21f. A RECORD THAT IS PRESENT AND UNUSABLE IS NOT AN ABSENT RECORD ------------------------
    #
    # Two faults, and they are different sentences: a file that will not parse, and a file written by
    # a NEWER Library. Reading either as "this conversation has never sat anywhere" would send the
    # reader to create a seat they already have; the second would additionally rewrite a file whose
    # fields this build does not know, which is how "no automatic pruning" gets defeated by an
    # upgrade rather than by a prune.
    $histBPath = Get-SeatConversationsPath -StateDirectory $histState -Seat 'hist-b'
    $histBBytes = [IO.File]::ReadAllBytes($histBPath)
    [IO.File]::WriteAllText($histBPath, '{ not json', $utf8)
    $corruptLookup = ''
    try { Get-SeatsForConversation -StateDirectory $histState -SessionId 'conv-monday' | Out-Null }
    catch { $corruptLookup = [string]$_.Exception.Message }
    Assert-True ($corruptLookup -clike '*conversations.json*') "an unreadable conversation record was read as an absence: '$corruptLookup'"
    # AND THE HOOK SAYS SO RATHER THAN DYING OR LYING. Its failure is guidance, never a blocked
    # session: exit 0, and a sentence naming what could not be read.
    $corruptHook = Invoke-HistoryHook 'resume' 'conv-monday' 0
    Assert-True ($corruptHook.ExitCode -eq 0) "an unreadable conversation record took the session start down: $($corruptHook.Text)"
    Assert-True ($corruptHook.Context.Contains('conversations.json')) "the hook did not name the record it could not read: $($corruptHook.Context)"
    [IO.File]::WriteAllText($histBPath, '{"schema":99,"seat":"hist-b","conversations":[]}', $utf8)
    $futureSchema = ''
    try { Read-SeatConversations -StateDirectory $histState -Seat 'hist-b' | Out-Null }
    catch { $futureSchema = [string]$_.Exception.Message }
    Assert-True ($futureSchema -clike '*schema*') "a record from a newer Library was read as this build's own: '$futureSchema'"
    # TWO ROWS FOR ONE CONVERSATION IS CORRUPT STATE, refused rather than chosen between: the lookup
    # sorts on `last_seen_utc`, so two rows for one id make "the newest record" a coin toss inside one
    # file. No documented route writes it, which is why it has a case rather than a branch.
    [IO.File]::WriteAllText($histBPath,
        '{"schema":1,"seat":"hist-b","conversations":[{"session_id":"conv-monday","last_seen_utc":"2026-01-01T00:00:00.0000000Z"},{"session_id":"conv-monday","last_seen_utc":"2026-02-01T00:00:00.0000000Z"}]}', $utf8)
    $duplicateRefusal = ''
    try { Read-SeatConversations -StateDirectory $histState -Seat 'hist-b' | Out-Null }
    catch { $duplicateRefusal = [string]$_.Exception.Message }
    Assert-True ($duplicateRefusal -clike '*twice*') "one conversation recorded twice at one seat was accepted: '$duplicateRefusal'"
    [IO.File]::WriteAllBytes($histBPath, $histBBytes)
    Assert-Equal '2' ([string]@(Get-SeatsForConversation -StateDirectory $histState -SessionId 'conv-monday').Count) 'the fixture did not restore the record it corrupted, so later rows would read a damaged file'

    # --- 21g. RETIREMENT ARCHIVES THE HISTORY, BYTE FOR BYTE ---------------------------------------
    #
    # THE SEAT DIRECTORY IS DELETED BY RETIREMENT, so `conversations.json` is the only copy and a
    # retirement that archived the Desk alone would discard the record that makes a hibernated
    # conversation findable -- silently, and after reporting success. Driven through the real helper
    # with its own preflight and plan_id, because the archive is what the approval was for.
    $retireAgent = Start-HistoryAgent
    Assert-True ((Enter-HistorySeat 'hist-retire' 'conv-retired' $retireAgent.Id).ExitCode -eq 0) 'the fixture could not seat the conversation it is about to archive'
    Stop-HistoryAgent $retireAgent 'hist-retire'
    $retirePath = Get-SeatConversationsPath -StateDirectory $histState -Seat 'hist-retire'
    $retireBindingPath = Get-SeatBindingPath -StateDirectory $histState -Seat 'hist-retire'
    Assert-True (Test-Path -LiteralPath $retirePath -PathType Leaf) 'the fixture has no conversation history to archive'
    $retireBytes = [IO.File]::ReadAllBytes($retirePath)
    $retireBindingBytes = [IO.File]::ReadAllBytes($retireBindingPath)
    $retirePlanRun = Invoke-SeatHelper 'Retire-Seat.ps1' @('-Seat', 'hist-retire', '-WorkspacePath', $histWorkspace, '-Preflight', '-Json')
    Assert-True ($retirePlanRun.ExitCode -eq 0) "the retirement preflight failed: $($retirePlanRun.Text)"
    $retirePlan = (@($retirePlanRun.Stdout | Where-Object { $_.Trim().StartsWith('{') }) -join "`n") | ConvertFrom-Json
    # THE PLAN SAYS WHAT WILL TRAVEL, and it is read from the plan rather than assumed: a reader
    # approving a retirement is approving what it archives.
    $planned = @(Get-Field $retirePlan 'records_to_archive' 'the retirement plan')
    Assert-True (@($planned) -ccontains 'conversations') "the retirement plan did not say it would archive the conversation history: $(@($planned) -join ', ')"
    Assert-True (@($planned) -ccontains 'binding') "the retirement plan did not say it would archive the binding: $(@($planned) -join ', ')"
    $retired = Invoke-SeatHelper 'Retire-Seat.ps1' @('-Seat', 'hist-retire', '-WorkspacePath', $histWorkspace,
        '-UserConfirmed', '-ApprovedPlanId', ([string]$retirePlan.plan_id), '-Json')
    Assert-True ($retired.ExitCode -eq 0) "the retirement failed: $($retired.Text)"
    $retiredResult = (@($retired.Stdout | Where-Object { $_.Trim().StartsWith('{') }) -join "`n") | ConvertFrom-Json
    $archivedKinds = @(Get-Field $retiredResult 'archived' 'the retirement result')
    Assert-True (@($archivedKinds) -ccontains 'conversations') "retirement did not report archiving the conversation history: $(@($archivedKinds) -join ', ')"
    Assert-True (-not (Test-Path -LiteralPath $retirePath -PathType Leaf)) 'the retired seat kept its conversation history in place'
    # RECOVERABLE MEANS BYTE FOR BYTE. A record archived as something a reader cannot read back is a
    # record discarded with extra steps.
    $archiveDirectory = [string](Get-Field $retiredResult 'archive_directory' 'the retirement result')
    $archivedHistory = Join-Path $archiveDirectory 'conversations.json'
    Assert-True (Test-Path -LiteralPath $archivedHistory -PathType Leaf) "the conversation history is not in the archive at $archiveDirectory"
    Assert-Equal ([Convert]::ToBase64String($retireBytes)) ([Convert]::ToBase64String([IO.File]::ReadAllBytes($archivedHistory))) 'the archived conversation history is not the one that was retired'
    $archivedBinding = Join-Path $archiveDirectory 'binding.json'
    Assert-True (Test-Path -LiteralPath $archivedBinding -PathType Leaf) 'the binding was not archived beside the Desk'
    Assert-Equal ([Convert]::ToBase64String($retireBindingBytes)) ([Convert]::ToBase64String([IO.File]::ReadAllBytes($archivedBinding))) 'the archived binding is not the one that was retired'

    # --- 22. RETIREMENT HAS AN IDENTITY, AND AN ABSENCE IS NOT ONE --------------------------------
    #
    # THE DEFECT THIS CLOSES WAS REACHABLE WITH ONE `rm -rf`. `Get-NotebookResetTargets` decided a
    # seat was retired by not finding it in `.claude/seats/`, and that directory is gitignored -- so
    # deleting one seat's folder by hand, which is the obvious thing to try when a stale claim will
    # not clear, made every Notebook topic it owned eligible for the next seat's whole-tree reset,
    # with no refusal at all. Measured in that shape before the change.
    #
    # ITS OWN WORKSPACE, because the cases below retire seats, hand-edit a registry and delete an
    # archive record. Doing that in the shared fixture would leave every later case reading state
    # this one broke on purpose, and a red would then name an unrelated crash.
    #
    # EVERY SEAT HERE IS CREATED BY THE REAL LAUNCHER, never by Initialize-SeatForFixture. The
    # fixture helper writes a registry entry with no `seat_id`, which is the PRE-IDENTITY shape --
    # a legitimate one that the two-seat suite covers -- and a case about telling incarnations apart
    # cannot be run on seats that have none.
    $incWorkspace = Join-Path $fixture 'incarnation'
    $incState = Join-Path $incWorkspace '.claude'
    New-Item -ItemType Directory -Path $incState -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $incWorkspace 'notebook') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $incWorkspace 'internal') -Force | Out-Null

    function Start-IncSeat([string]$SeatName, [string]$ProjectSlug) {
        Invoke-SeatHelper 'Start-LibrarySeat.ps1' @('-WorkspacePath', $incWorkspace, '-Seat', $SeatName,
            '-Project', $ProjectSlug, '-NoLaunch', '-Json')
    }
    function Get-IncIncarnation([string]$SeatName) {
        Get-SeatEntryIncarnation -Entry (Get-SeatEntry -Registry (Read-SeatRegistry -StateDirectory $incState) -Seat $SeatName)
    }
    function Add-IncTopic([string]$Topic, [string]$SeatName) {
        New-Item -ItemType Directory -Path (Join-Path $incWorkspace "notebook/$Topic") -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $incWorkspace "notebook/$Topic/_index.md"), "# $Topic`n", $utf8)
        Set-NotebookTopicOwner -Workspace $incWorkspace -Topic $Topic -Seat $SeatName
    }
    function Get-IncRowIncarnation([string]$Topic) {
        $row = Get-NotebookTopicOwner -Owners (Read-NotebookTopicOwners -Workspace $incWorkspace) -Topic $Topic
        if ($null -eq $row) { return '<no row>' }
        if (@($row.PSObject.Properties | ForEach-Object { $_.Name }) -cnotcontains 'seat_id') { return '' }
        [string]$row.seat_id
    }
    function Get-IncSelection([string]$SeatName, [switch]$WholeTree) {
        $lock = Enter-SeatRegistryLock -Workspace $incWorkspace
        try { Get-NotebookResetTargets -Workspace $incWorkspace -Seat $SeatName -WholeTree:$WholeTree }
        finally { Exit-BookLock -Lock $lock }
    }
    function Get-IncTopics([object]$Rows) { (@($Rows | ForEach-Object { [string]$_.topic }) | Sort-Object -CaseSensitive) -join ',' }

    Assert-True ((Start-IncSeat 'bystand' 'bystand-proj').ExitCode -eq 0) 'the bystander seat could not be created, so nothing below has a seat to reset from'
    Assert-True ((Start-IncSeat 'recur' 'recur-one-proj').ExitCode -eq 0) 'the first incarnation could not be created'
    $incarnationOne = Get-IncIncarnation 'recur'
    $bystandIncarnation = Get-IncIncarnation 'bystand'
    Assert-True (-not [string]::IsNullOrWhiteSpace($incarnationOne)) 'the launcher created a seat with no incarnation id, so every comparison below would be between two empty strings'
    Assert-True ($incarnationOne -cne $bystandIncarnation) 'two seats created by the launcher share one incarnation id'

    # THREE TOPICS, NOT TWO. The classification below walks the ownership inventory and buckets it;
    # with two rows a truncation puts one in the right bucket and loses the other invisibly, and
    # three is the smallest number at which a dropped row is distinguishable from a reordering.
    # The bystander's own topic is the decoy: an implementation that stamped rows with the ACTING
    # seat's incarnation, or with the first entry in the registry, writes the same id on all four.
    Add-IncTopic 'bystand-topic' 'bystand'
    foreach ($topic in @('recur-a', 'recur-b', 'recur-c')) { Add-IncTopic $topic 'recur' }
    Assert-Equal $incarnationOne (Get-IncRowIncarnation 'recur-a') "the ownership row does not carry the incarnation the REGISTRY gives that seat"
    Assert-Equal $bystandIncarnation (Get-IncRowIncarnation 'bystand-topic') 'the bystander topic was stamped with something other than its own seat''s incarnation'
    Assert-True ((Get-IncRowIncarnation 'recur-a') -cne (Get-IncRowIncarnation 'bystand-topic')) 'two seats'' topics carry the same incarnation id, so no comparison below can tell them apart'

    # --- 22a. A HAND-DELETED SEAT DIRECTORY IS NOT A RETIREMENT -----------------------------------
    #
    # The defect itself, in the shape that produced it. The registry still names the seat, so the
    # topics are FOREIGN and refused -- and the refusal has to send the reader to retirement, which
    # 22b then proves actually works on a seat whose Desk is gone.
    Assert-True ((Start-IncSeat 'ghosted' 'ghosted-proj').ExitCode -eq 0) 'the seat whose directory is about to be deleted could not be created'
    Add-IncTopic 'ghosted-topic' 'ghosted'
    Remove-Item -LiteralPath (Get-DeskStateDirectory -StateDirectory $incState -Seat 'ghosted') -Recurse -Force
    $afterDeletion = Get-IncSelection 'bystand' -WholeTree
    Assert-Equal 'bystand-topic' (Get-IncTopics $afterDeletion.targets) 'A HAND-DELETED SEAT DIRECTORY MADE ANOTHER SEAT''S TOPIC WHOLE-TREE ELIGIBLE'
    Assert-True ((Get-IncTopics $afterDeletion.foreign).Contains('ghosted-topic')) "a seat whose directory was deleted was not reported as foreign: $(Get-IncTopics $afterDeletion.foreign)"
    Assert-True ((@($afterDeletion.refusals) -join ' ').Contains('Retire-Seat.ps1 -Seat ghosted')) "the refusal did not name the route that fixes it: $(@($afterDeletion.refusals) -join ' ')"

    # AND THE DESK SAYS SO, which is the half that keeps it from being silent. Driven as a real
    # process, because the payload's shape is what the reader sees.
    $consistencyRun = Invoke-SeatHelper 'Get-DeskOverview.ps1' @('-WorkspacePath', $incWorkspace, '-Seat', 'bystand', '-Json')
    Assert-True ($consistencyRun.ExitCode -eq 0) "the Desk overview failed over an inconsistent registry: $($consistencyRun.Text)"
    $overview = (@($consistencyRun.Stdout | Where-Object { $_.Trim().StartsWith('{') }) -join "`n") | ConvertFrom-Json
    $consistency = Get-Field $overview 'seat_consistency' 'the Desk overview'
    Assert-Equal 'False' ([string](Get-Field $consistency 'consistent' 'the consistency block')) 'the Desk overview called a registry with a missing seat directory consistent'
    $ghostRow = @(@(Get-Field $consistency 'seats' 'the consistency block') | Where-Object { [string]$_.seat -ceq 'ghosted' }) | Select-Object -First 1
    Assert-True ($null -ne $ghostRow) 'the consistency block has no row for the seat whose directory is gone'
    Assert-Equal 'desk-missing' ([string](Get-Field $ghostRow 'state' 'the ghosted seat''s row')) 'the state of a registered seat with no directory'
    Assert-True ((@(Get-Field $consistency 'faults' 'the consistency block') -join ' ').Contains('Retire-Seat.ps1 -Seat ghosted')) 'the Desk overview reported the fault without the route that clears it'
    # THE POSITIVE CONTROL, or every assertion above passes against a reporter that calls everything
    # inconsistent. `bystand` is registered with its directory intact in the same payload.
    $bystandRow = @(@(Get-Field $consistency 'seats' 'the consistency block') | Where-Object { [string]$_.seat -ceq 'bystand' }) | Select-Object -First 1
    Assert-Equal 'ok' ([string](Get-Field $bystandRow 'state' 'the bystander''s row')) 'a healthy seat was reported as a fault'

    # --- 22a-ii. AND EVERY NOTEBOOK TOPIC SAYS WHOSE IT IS (2026-09-15) ---------------------------
    #
    # `notebook/` is shared by every seat, so a list of folders with no owner beside them is a list
    # in which the reader cannot tell their own material from anyone else's -- and until now the only
    # surface that answered it was a RESET PREFLIGHT, which is a destructive operation's preview.
    #
    # ONE FIXTURE PER ROUTE, because `owner_label` has four and a single owned topic proves one of
    # them. The two declared scopes pass through as themselves, an absent row is `unmapped` -- the
    # answer that matters most to act on, since it is what stops a reset outright -- and an owned
    # topic splits on whether the owner is the reader. An implementation that printed the raw scope
    # for everything passes the first three and fails the last two; one that printed the seat for
    # everything fails the first three.
    New-Item -ItemType Directory -Path (Join-Path $incWorkspace 'notebook/nobody-topic') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $incWorkspace 'notebook/nobody-topic/_index.md'), "# Nobody`n", $utf8)
    New-Item -ItemType Directory -Path (Join-Path $incWorkspace 'notebook/common-topic') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $incWorkspace 'notebook/common-topic/_index.md'), "# Common`n", $utf8)
    Set-NotebookTopicOwner -Workspace $incWorkspace -Topic 'common-topic' -Scope 'shared' -ActingSeat 'bystand' | Out-Null

    $labelRun = Invoke-SeatHelper 'Get-DeskOverview.ps1' @('-WorkspacePath', $incWorkspace, '-Seat', 'bystand', '-Json')
    Assert-True ($labelRun.ExitCode -eq 0) "the Desk overview failed once it read the ownership record: $($labelRun.Text)"
    $labelOverview = (@($labelRun.Stdout | Where-Object { $_.Trim().StartsWith('{') }) -join "`n") | ConvertFrom-Json
    $labelTopics = @(Get-Field (Get-Field $labelOverview 'notebook' 'the Desk overview') 'topics' 'the notebook block')
    function Get-LabelRow([string]$Folder) {
        $row = @($labelTopics | Where-Object { [string]$_.folder -ceq $Folder }) | Select-Object -First 1
        if ($null -eq $row) { throw "the Desk overview listed no topic '$Folder'; it listed: $(@($labelTopics | ForEach-Object { [string]$_.folder }) -join ',')" }
        $row
    }
    # THE READER'S OWN, which is the distinction the label exists to draw -- and the seat name is kept
    # beside 'yours' so a reader comparing two seats' Desks can still tell which one this is.
    $ownTopicRow = Get-LabelRow 'bystand-topic'
    Assert-Equal 'owned' ([string](Get-Field $ownTopicRow 'owner_scope' 'the reader''s own topic')) 'an owned topic did not report its scope'
    Assert-Equal 'bystand' ([string](Get-Field $ownTopicRow 'owner_seat' 'the reader''s own topic')) 'an owned topic did not name its owning seat'
    Assert-Equal 'yours (bystand)' ([string](Get-Field $ownTopicRow 'owner_label' 'the reader''s own topic')) 'the reader''s own Notebook topic was not labelled as theirs'
    # ANOTHER SEAT'S. The decoy for a label that always says 'yours'.
    Assert-Equal 'seat recur' ([string](Get-Field (Get-LabelRow 'recur-a') 'owner_label' 'another seat''s topic')) 'another seat''s Notebook topic was labelled as the reader''s'
    Assert-Equal 'recur' ([string](Get-Field (Get-LabelRow 'recur-a') 'owner_seat' 'another seat''s topic')) 'another seat''s topic named the wrong owning seat'
    # THE DECLARED SCOPES AND THE ABSENT ROW, which no seat owns and which must not be rendered as
    # though one did. `owner_seat` stays null for all three, so a consumer keying on the seat cannot
    # read 'shared' or 'unmapped' as a seat name.
    Assert-Equal 'shared' ([string](Get-Field (Get-LabelRow 'common-topic') 'owner_label' 'a shared topic')) 'a topic declared shared was not labelled as such'
    Assert-True ($null -eq (Get-Field (Get-LabelRow 'common-topic') 'owner_seat' 'a shared topic')) 'a shared topic was given an owning seat'
    Assert-Equal 'unmapped' ([string](Get-Field (Get-LabelRow 'nobody-topic') 'owner_label' 'an unowned topic')) 'a topic no seat owns was not reported as unmapped'
    Assert-True ($null -eq (Get-Field (Get-LabelRow 'nobody-topic') 'owner_seat' 'an unowned topic')) 'an unmapped topic was given an owning seat'
    # AND THE SCOPE LINE ADMITS THE READ, the same rule case 20e pins for the transcript: a reported
    # field describing LESS than the operation performed is the defect family this helper keeps
    # paying for, one direction over.
    $labelScope = [string](Get-Field $labelOverview 'scope' 'the Desk overview')
    Assert-True ($labelScope.Contains('topic-ownership record')) "the scope line does not admit that the Notebook ownership record was read: $labelScope"
    # THE UNMAPPED TOPIC DOES NOT OUTLIVE ITS CASE. Every later case in this workspace reads
    # Get-NotebookResetTargets, which REFUSES on an unmapped topic -- so leaving it here would put an
    # extra refusal into selections that 22c and 22d assert against, and the red would name those
    # cases rather than this fixture. `common-topic` stays: a declared scope lands in `protected`,
    # raises no refusal, and none of those assertions read that list. Tolerant, so a cleanup that
    # failed could not replace a named assertion failure with a missing-path error naming this line.
    Remove-Item -LiteralPath (Join-Path $incWorkspace 'notebook/nobody-topic') -Recurse -Force -ErrorAction SilentlyContinue

    # --- 22b. RETIREMENT RECORDS THE INCARNATION, AND WORKS ON A SEAT WHOSE DESK IS GONE ----------
    #
    # The remedy 22a's refusal names has to be a route the reader can actually take. It is the same
    # gated helper, and the thing it leaves behind is now what "retired" MEANS.
    $ghostPlanRun = Invoke-SeatHelper 'Retire-Seat.ps1' @('-Seat', 'ghosted', '-WorkspacePath', $incWorkspace, '-Preflight', '-Json')
    Assert-True ($ghostPlanRun.ExitCode -eq 0) "a seat whose Desk directory is gone could not be retired: $($ghostPlanRun.Text)"
    $ghostPlan = (@($ghostPlanRun.Stdout | Where-Object { $_.Trim().StartsWith('{') }) -join "`n") | ConvertFrom-Json
    Assert-Equal (Get-IncIncarnation 'ghosted') ([string](Get-Field $ghostPlan 'seat_id' 'the retirement plan')) 'the retirement plan named an incarnation the registry does not give that seat'
    $ghostRetired = Invoke-SeatHelper 'Retire-Seat.ps1' @('-Seat', 'ghosted', '-WorkspacePath', $incWorkspace,
        '-UserConfirmed', '-ApprovedPlanId', ([string]$ghostPlan.plan_id), '-Json')
    Assert-True ($ghostRetired.ExitCode -eq 0) "retiring a Desk-less seat failed: $($ghostRetired.Text)"
    $ghostAfter = Get-IncSelection 'bystand' -WholeTree
    Assert-Equal 'bystand-topic,ghosted-topic' (Get-IncTopics $ghostAfter.targets) 'the remedy the refusal names did not make the topic eligible, so that message sends the reader nowhere'
    Assert-Equal 'ghosted-topic' (Get-IncTopics $ghostAfter.retired) 'a properly retired seat''s topic was not reported as retired'

    # --- 22c. THE RECORD IS THE RETIREMENT: REMOVE IT AND ELIGIBILITY GOES ------------------------
    #
    # Falsified from the data rather than from the code: the seat is gone from the registry either
    # way, so if the archive record were decorative the selection would not move. Its own subject --
    # `recur`, three topics -- because the state this leaves is the `unaccounted` one and 22d needs
    # it before it is put back.
    $recurIncarnation = Get-IncIncarnation 'recur'
    Assert-Equal $incarnationOne $recurIncarnation 'the first incarnation changed under the case'
    $recurPlanRun = Invoke-SeatHelper 'Retire-Seat.ps1' @('-Seat', 'recur', '-WorkspacePath', $incWorkspace, '-Preflight', '-Json')
    $recurPlan = (@($recurPlanRun.Stdout | Where-Object { $_.Trim().StartsWith('{') }) -join "`n") | ConvertFrom-Json
    $recurRetiredRun = Invoke-SeatHelper 'Retire-Seat.ps1' @('-Seat', 'recur', '-WorkspacePath', $incWorkspace,
        '-UserConfirmed', '-ApprovedPlanId', ([string]$recurPlan.plan_id), '-Json')
    Assert-True ($recurRetiredRun.ExitCode -eq 0) "the first incarnation could not be retired: $($recurRetiredRun.Text)"
    $recurRetired = (@($recurRetiredRun.Stdout | Where-Object { $_.Trim().StartsWith('{') }) -join "`n") | ConvertFrom-Json
    $recurArchive = [string](Get-Field $recurRetired 'archive_directory' 'the retirement result')
    $recurRecordPath = Join-Path $recurArchive 'seat.json'
    $recurRecord = [Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($recurRecordPath)) | ConvertFrom-Json
    Assert-Equal $incarnationOne ([string](Get-Field $recurRecord 'seat_id' 'the archived seat record')) 'the archive does not say WHICH incarnation was retired, so a reused slug could not be told from it'
    Assert-Equal 'ghosted-topic,recur-a,recur-b,recur-c' (Get-IncTopics (Get-IncSelection 'bystand' -WholeTree).retired) 'a retired incarnation''s three topics did not all come through as retired'

    $recurRecordBytes = [IO.File]::ReadAllBytes($recurRecordPath)
    Remove-Item -LiteralPath $recurRecordPath -Force
    $withoutRecord = Get-IncSelection 'bystand' -WholeTree
    Assert-Equal 'bystand-topic,ghosted-topic' (Get-IncTopics $withoutRecord.targets) 'AN ARCHIVE WITH NO seat.json STILL LICENSED A WHOLE-TREE RESET OVER THE TOPICS IT NAMES'
    Assert-Equal 'recur-a,recur-b,recur-c' (Get-IncTopics $withoutRecord.unaccounted) 'a seat with no registry entry and no readable retirement record was not reported as unaccounted for'
    Assert-True ((@($withoutRecord.refusals) -join ' ').Contains('cannot be accounted for')) "the unaccounted refusal did not say what was wrong: $(@($withoutRecord.refusals) -join ' ')"
    Assert-True ((@($withoutRecord.refusals) -join ' ').Contains('Set-NotebookTopicOwner.ps1')) 'the unaccounted refusal named no route out of it'

    # AND THAT SAME STATE BLOCKS THE NAME, for a different reason from the one D12 had. A row whose
    # incarnation nothing can account for would be STRANDED by taking the slug: the old incarnation
    # could never be retired afterwards, so no reset would ever reach the topic.
    $strandedVerdict = Test-NewSeatIsCreatable -Workspace $incWorkspace -StateDirectory $incState `
        -Registry (Read-SeatRegistry -StateDirectory $incState) -Seat 'recur' -SeatOnly -ActiveProjects @('recur-two-proj')
    Assert-Equal 'False' ([string]$strandedVerdict.creatable) 'a slug whose ownership rows name an incarnation nothing can account for was reusable'
    Assert-True ([string]$strandedVerdict.reason -clike '*recur-a*') "the refusal did not name the record still citing the slug: $([string]$strandedVerdict.reason)"
    Assert-True ([string]$strandedVerdict.reason -clike "*incarnation $incarnationOne*") "the refusal did not say WHICH incarnation is unaccounted for: $([string]$strandedVerdict.reason)"
    [IO.File]::WriteAllBytes($recurRecordPath, $recurRecordBytes)

    # --- 22d. A REGISTRY ENTRY BEATS AN ARCHIVE, so a reused slug is never read off the old one ---
    #
    # Both halves of "retired" are load-bearing and this is the one the other cases cannot see: the
    # archive record is present and correct throughout, and the answer still has to be `live`.
    $restored = Read-SeatRegistry -StateDirectory $incState
    $handEdited = [pscustomobject]@{ schema = 1; seats = @(@($restored.seats) + [pscustomobject]@{
        seat = 'recur'; project = 'recur-one-proj'; created_utc = '2026-01-01T00:00:00.0000000Z'; seat_id = $incarnationOne }) }
    $editLock = Enter-SeatRegistryLock -Workspace $incWorkspace
    try { Write-SeatRegistry -StateDirectory $incState -Registry $handEdited }
    finally { Exit-BookLock -Lock $editLock }
    $registeredAgain = Get-IncSelection 'bystand' -WholeTree
    Assert-Equal 'bystand-topic,ghosted-topic' (Get-IncTopics $registeredAgain.targets) 'AN INCARNATION THE REGISTRY STILL NAMES WAS TREATED AS RETIRED BECAUSE AN ARCHIVE MENTIONED IT'
    Assert-Equal 'recur-a,recur-b,recur-c' (Get-IncTopics $registeredAgain.foreign) 'a registered incarnation was not reported as foreign'
    $undoLock = Enter-SeatRegistryLock -Workspace $incWorkspace
    try { Write-SeatRegistry -StateDirectory $incState -Registry $restored }
    finally { Exit-BookLock -Lock $undoLock }

    # --- 22e. THE SLUG IS REUSABLE, AND THE NEW SEAT INHERITS NOTHING -----------------------------
    #
    # What the whole item is for. `recur` is created again through the real launcher, under a
    # different Project because a seat is bound to exactly one -- and its ORDINARY reset, the
    # habitual one, must not see a single topic of the incarnation whose name it took.
    $reuse = Start-IncSeat 'recur' 'recur-two-proj'
    Assert-True ($reuse.ExitCode -eq 0) "a slug could not be reused after its incarnation was properly retired: $($reuse.Text)"
    $incarnationTwo = Get-IncIncarnation 'recur'
    Assert-True (-not [string]::IsNullOrWhiteSpace($incarnationTwo)) 'the reused slug was created with no incarnation id'
    Assert-True ($incarnationTwo -cne $incarnationOne) 'THE SECOND INCARNATION REUSED THE FIRST ONE''S ID, so nothing distinguishes them'
    Assert-Equal '' (Get-IncTopics (Get-IncSelection 'recur').targets) 'A NEW SEAT INHERITED THE RETIRED INCARNATION''S TOPICS AT ITS ORDINARY RESET'
    Assert-Equal 'ghosted-topic,recur-a,recur-b,recur-c' (Get-IncTopics (Get-IncSelection 'recur' -WholeTree).retired) 'the new incarnation''s whole-tree reset did not see the old one''s topics as retired'
    # Its OWN topic is its own, which is the control: a matcher that refused everything under this
    # slug would pass every assertion above.
    Add-IncTopic 'recur-two-topic' 'recur'
    Assert-Equal $incarnationTwo (Get-IncRowIncarnation 'recur-two-topic') 'the new incarnation''s own topic was stamped with the old id'
    Assert-Equal 'recur-two-topic' (Get-IncTopics (Get-IncSelection 'recur').targets) 'the new incarnation could not reset its own topic'

    # --- 22f. THE REVALIDATION AT THE MOVE COMPARES THE INCARNATION TOO ---------------------------
    #
    # Selection classifies by (seat, incarnation) and the apply path re-reads under the topic lock;
    # a revalidation that compared the SLUG alone would move a topic on an approval describing a
    # different incarnation of the same name -- which is exactly what reuse makes reachable. One
    # assertion, at the write, with a positive control beside it so a mover that refused everything
    # would fail rather than pass.
    $moveQuarantine = Join-Path $incWorkspace 'internal/inc-quarantine'
    New-Item -ItemType Directory -Path $moveQuarantine -Force | Out-Null
    $moveLock = Enter-BookLock -Workspace $incWorkspace -BookRoot (Get-NotebookTopicLockRoot 'recur-two-topic')
    try {
        $staleMove = Move-NotebookTopicToQuarantine -Workspace $incWorkspace -Topic 'recur-two-topic' `
            -ExpectedSeat 'recur' -ExpectedSeatId $incarnationOne -QuarantineDirectory $moveQuarantine
        Assert-Equal 'False' ([string]$staleMove.moved) 'A TOPIC WAS QUARANTINED ON AN APPROVAL NAMING A DIFFERENT INCARNATION OF ITS SEAT'
        Assert-True (Test-Path -LiteralPath (Join-Path $incWorkspace 'notebook/recur-two-topic') -PathType Container) 'the refused move took the topic anyway'
        $goodMove = Move-NotebookTopicToQuarantine -Workspace $incWorkspace -Topic 'recur-two-topic' `
            -ExpectedSeat 'recur' -ExpectedSeatId $incarnationTwo -QuarantineDirectory $moveQuarantine
        Assert-Equal 'True' ([string]$goodMove.moved) 'the move refused the very incarnation that owns the topic'
    }
    finally { Exit-BookLock -Lock $moveLock }

    # --- 22g. THE RECORD HAS ONE SPELLING FOR "NO INCARNATION" ------------------------------------
    #
    # Absent means pre-identity; an empty string is refused, and so is an incarnation on a topic
    # that is not owned by a seat at all. Two spellings of one state is how a record starts meaning
    # different things to two readers, and this record is read by the reset, the creation gate and
    # the Desk.
    $ownersBackup = [IO.File]::ReadAllBytes((Get-NotebookOwnersPath -Workspace $incWorkspace))
    foreach ($bad in @(
        @{ why = 'an empty incarnation'; row = [pscustomobject]@{ topic = 'bad-topic'; scope = 'owned'; seat = 'bystand'; seat_id = '' }; expect = 'malformed seat incarnation' }
        @{ why = 'an incarnation on a shared topic'; row = [pscustomobject]@{ topic = 'bad-topic'; scope = 'shared'; seat_id = 'abc' }; expect = 'only an owned topic names an incarnation' })) {
        [IO.File]::WriteAllText((Get-NotebookOwnersPath -Workspace $incWorkspace),
            (([pscustomobject]@{ schema = 1; topics = @($bad.row) } | ConvertTo-Json -Depth 6) + "`n"), $utf8)
        $refusal = ''
        try { Read-NotebookTopicOwners -Workspace $incWorkspace | Out-Null }
        catch { $refusal = [string]$_.Exception.Message }
        Assert-True ($refusal.Contains([string]$bad.expect)) "the ownership record accepted $([string]$bad.why): '$refusal'"
    }
    [IO.File]::WriteAllBytes((Get-NotebookOwnersPath -Workspace $incWorkspace), $ownersBackup)
    Assert-Equal $incarnationTwo (Get-IncRowIncarnation 'recur-two-topic') 'the fixture did not restore the ownership record it corrupted'

    # --- 22h. A REPORT ANSWERS OVER A BROKEN REGISTRY RATHER THAN FAILING CLOSED ------------------
    #
    # Every DECISION refuses an unreadable registry, which is right. The Desk overview is not a
    # decision: a reader whose registry has been hand-edited into nonsense needs the one tool that
    # would tell them so, and it now reads the registry where it did not before. The rows must NOT
    # come back `unregistered` either -- that is a different fault with a different remedy, and it
    # would send the reader to delete the Desks that are still there.
    $registryPath = Get-SeatRegistryPath $incState
    $registryBytes = [IO.File]::ReadAllBytes($registryPath)
    [IO.File]::WriteAllText($registryPath, "{ not json at all", $utf8)
    $brokenRun = Invoke-SeatHelper 'Get-DeskOverview.ps1' @('-WorkspacePath', $incWorkspace, '-Seat', 'bystand', '-Json')
    Assert-True ($brokenRun.ExitCode -eq 0) "the Desk overview died over an unreadable registry instead of reporting it: $($brokenRun.Text)"
    $brokenOverview = (@($brokenRun.Stdout | Where-Object { $_.Trim().StartsWith('{') }) -join "`n") | ConvertFrom-Json
    $brokenConsistency = Get-Field $brokenOverview 'seat_consistency' 'the Desk overview over a broken registry'
    Assert-Equal 'False' ([string](Get-Field $brokenConsistency 'consistent' 'the consistency block')) 'an unreadable registry was reported as consistent'
    Assert-True ((@(Get-Field $brokenConsistency 'faults' 'the consistency block') -join ' ').Contains('not valid JSON')) 'the fault did not carry the registry reader''s own wording'
    $brokenRows = @(@(Get-Field $brokenConsistency 'seats' 'the consistency block') | ForEach-Object { [string]$_.state } | Sort-Object -Unique -CaseSensitive)
    Assert-Equal 'unknown' ($brokenRows -join ',') 'a seat whose registry could not be read was given a state that names the wrong remedy'
    [IO.File]::WriteAllBytes($registryPath, $registryBytes)
    Assert-Equal 'bystand' ([string](Get-SeatEntry -Registry (Read-SeatRegistry -StateDirectory $incState) -Seat 'bystand').seat) 'the fixture did not restore the registry it corrupted'

}
catch { $failure = $_ }
finally {
    foreach ($held in $claims) { Exit-SeatClaim -Claim $held }
    foreach ($stray in $dummies) {
        try { Stop-Process -Id $stray.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
    $env:LIBRARY_SEAT = $savedSeat
    $env:LIBRARY_SEAT_CLAIM = $savedClaim
    $env:AI_LIBRARY_MCP_URL = $savedMcpUrl
    $catalogState.Running = $false
    try { $catalogListener.Stop() } catch { }
    try { $catalogListener.Close() } catch { }
    try { [void]$catalogServer.EndInvoke($catalogHandle) } catch { }
    try { $catalogServer.Dispose() } catch { }
    try { $catalogRunspace.Dispose() } catch { }
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($null -ne $failure) {
    [Console]::Error.WriteLine("seat lifecycle: FAILED at assertion $($script:cases) -- $($failure.Exception.Message)")
    exit 1
}

"seat lifecycle: $($script:cases) assertion(s) over create, collision, binding, claim, agent ancestry, preflight, retire, archive, the terminal picker, the Desk overview's own line, the conversation history, retirement's identity and fail-closed"
