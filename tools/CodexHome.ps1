Set-StrictMode -Version Latest

<#
    WHERE CODEX KEEPS ITS STATE, resolved rather than assumed.

    Codex reads and writes everything inside CODEX_HOME -- `config.toml`, the hook trust records
    under `[hooks.state]`, and one rollout per run under `sessions/`. That is an ENVIRONMENT
    variable, and on this machine it is not the default one: Library work starts from a terminal
    pane inside Orca, which points CODEX_HOME at a runtime home of its own, and `codex doctor`
    reports the substitution outright.

    MEASURED 2026-09-08 on codex-cli 0.153.4. Four `codex exec` runs -- three under the Orca home
    and one under the default -- wrote three rollouts to the Orca sessions root and one to
    `~/.codex/sessions`: one rollout per run, into the home that run used. Two helpers had the
    default hard-coded, so both read a store an Orca-launched delegate never writes to.

    The consequence was not a crash, which is why it survived. The meter reported a real reading
    that was simply OLD, and staleness is the one thing a delegation preflight is consulted to rule
    out -- `Get-MeterStatus.ps1` is step 0 of that preflight, and an understated `used_percent` is
    read as headroom that is not there. It also explains an earlier record that five `codex exec`
    runs had left `~/.codex/sessions` untouched: they had, because they were writing somewhere else.

    So the rule is spelled once, here, and both callers resolve through it. Each reading reports the
    root it actually read, which is what lets a reader SEE the substitution instead of inferring it.
#>

function Get-CodexHomeDirectory {
    $codexHome = $env:CODEX_HOME
    if (-not [string]::IsNullOrWhiteSpace($codexHome)) { return $codexHome }
    Join-Path $env:USERPROFILE '.codex'
}

function Get-CodexSessionsRoot {
    Join-Path (Get-CodexHomeDirectory) 'sessions'
}
