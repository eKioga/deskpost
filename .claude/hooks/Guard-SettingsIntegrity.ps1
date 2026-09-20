[CmdletBinding()]
param(
    [string]$StateDirectory,
    [Parameter(ValueFromPipeline = $true)]
    [string]$InputJson,
    [string]$InputJsonBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
    From .githooks/pre-commit, describing why that gate runs outside Claude at all:

        "a hook defined inside settings.json cannot validate the file that defines it. A malformed
         settings file has already disabled the permission allowlist and both guard hooks once,
         silently."

    The first half of that is still true and this hook does not pretend otherwise. What it can do is
    the case the pre-commit gate cannot reach: a settings file edited DURING a session, whose damage
    is live for every turn between the edit and the next commit. ConfigChange fires on that edit and
    can refuse it, which leaves the previous, working configuration in force.

    So the two gates cover different windows and neither replaces the other:

        ConfigChange (here)   an edit made while a session is running    refuses the change
        pre-commit            an edit that reaches a commit              refuses the commit

    WHAT IT REFUSES. A settings file that no longer parses, or one that has stopped registering a
    load-bearing guard under an event that guard can act on. Both are silent failures today: the
    harness carries on with whatever it last loaded, and the boundary is gone with nothing said.

    WHAT IT ALLOWS. Everything else, including a change that drops an OPTIONAL hook. Those add
    guidance and cannot block, and refusing a reader's edit to protect a convenience would be this
    hook doing more than it was asked to.
#>

. (Join-Path $PSScriptRoot 'HookContext.ps1')
. (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) (Join-Path 'tools' 'HookRegistry.ps1'))

try {
    if (-not $StateDirectory) { $StateDirectory = Split-Path -Parent $PSScriptRoot }
    $call = Read-HookPayload -BoundParameters $PSBoundParameters -InputJson $InputJson -InputJsonBase64 $InputJsonBase64
    # `source`, MEASURED, NOT `config_source`, ASSUMED -- and the guard that read the assumed name
    # never judged a single real settings edit. A ConfigChange payload captured from this client on
    # 2026-09-19 carries `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`,
    # `hook_event_name`, `source` ('local_settings') and `file_path`. There is no `config_source` on
    # it, so this read answered $null, the -cnotin two lines below was true, and the hook exited 0 on
    # every edit from ba0dec9 (2026-09-06) until this line changed. Section 5 of Test-LibraryHooks.ps1
    # passed throughout, because it supplied `config_source` itself -- the same reason the serve
    # ledger's own failure survived a suite that asserted it. This is the shape
    # `Restore-CompactedGuidance.ps1` already paid for once on `startup_reason`; it is worse here,
    # because this hook REFUSES rather than informs, so its silence is the boundary being open.
    # The field name is now held by `payload-contract.json` and `hooks.payload-fields-are-captured`.
    $source = [string](Get-HookField $call 'source')

    # policy_settings cannot be blocked by any hook, and the other sources do not define the
    # Library's hooks. Judging them would produce a denial nobody can act on.
    if ($source -cnotin @('project_settings', 'local_settings')) { exit 0 }

    $files = @(@('settings.json', 'settings.local.json') |
        ForEach-Object { Join-Path $StateDirectory $_ } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if (-not $files.Count) {
        Write-HookOutput 'ConfigChange' @{
            permissionDecision = 'deny'
            permissionDecisionReason = 'That change would leave .claude/ with no settings file, and the Virtual Desk guards are defined there.'
        }
        exit 0
    }

    $trees = [Collections.Generic.List[object]]::new()
    foreach ($file in $files) {
        try { [void]$trees.Add(([IO.File]::ReadAllText($file) | ConvertFrom-Json)) }
        catch {
            Write-HookOutput 'ConfigChange' @{
                permissionDecision = 'deny'
                permissionDecisionReason = "$(Split-Path -Leaf $file) is no longer valid JSON: $($_.Exception.Message). The previous settings stay in force; fix the file and save again."
            }
            exit 0
        }
    }

    $problems = @(Get-HookRegistrationProblems -Settings $trees.ToArray())
    $blocking = @($problems | Where-Object { -not $_.optional })
    if ($blocking.Count) {
        Write-HookOutput 'ConfigChange' @{
            permissionDecision = 'deny'
            permissionDecisionReason = "That change would disable a load-bearing Virtual Desk guard: $(($blocking | ForEach-Object { $_.detail }) -join '; '). The previous settings stay in force."
        }
        exit 0
    }

    $advisory = @($problems | Where-Object { $_.optional })
    if ($advisory.Count) {
        # Allowed, and said out loud. An optional hook silently disappearing is how a guidance
        # surface decays without anyone deciding to remove it.
        Write-HookOutput 'ConfigChange' @{
            systemMessage = "Settings accepted. Not registered after this change: $(($advisory | ForEach-Object { $_.detail }) -join '; ')."
        }
        exit 0
    }
}
catch {
    # FAILS OPEN, unlike the Desk guards, and the asymmetry is the point. This hook stands between
    # the reader and their own configuration file; a bug here that refused every settings edit would
    # lock them out of the one file that could disable it. The Desk guards fail closed because the
    # cost of a wrong allow is disclosure. The cost of a wrong deny here is a reader who cannot
    # configure their own tool, and .githooks/pre-commit still catches the damage at commit time.
    exit 0
}
