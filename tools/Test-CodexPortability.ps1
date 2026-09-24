[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# The Desk path is resolved, never composed -- see BookRootSchema's SEATS section.
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
# Fixtures work at a seat named 'fixture'. Set in this process so CHILD helper processes
# inherit it: they default -Seat to LIBRARY_SEAT, and there is no default seat to fall back on.
$env:LIBRARY_SEAT = 'fixture'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Invoke-Process([string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory, [string]$InputText) {
    $stem = Join-Path ([IO.Path]::GetTempPath()) ('codex-portability-process-' + [guid]::NewGuid().ToString('N'))
    $inputPath = "$stem.in"; $outputPath = "$stem.out"; $errorPath = "$stem.err"
    [IO.File]::WriteAllText($inputPath, $InputText, [Text.UTF8Encoding]::new($false))
    try {
        $quotedArguments = @($ArgumentList | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_.Replace('"', '\"') + '"' } else { $_ } })
        $process = Start-Process -FilePath $FilePath -ArgumentList $quotedArguments -WorkingDirectory $WorkingDirectory `
            -RedirectStandardInput $inputPath -RedirectStandardOutput $outputPath -RedirectStandardError $errorPath `
            -WindowStyle Hidden -Wait -PassThru
        $stdout = if (Test-Path -LiteralPath $outputPath) { [IO.File]::ReadAllText($outputPath) } else { '' }
        $stderr = if (Test-Path -LiteralPath $errorPath) { [IO.File]::ReadAllText($errorPath) } else { '' }
        if ($process.ExitCode -ne 0) { throw "Process exited $($process.ExitCode): $stderr" }
        [pscustomobject]@{ stdout = $stdout; stderr = $stderr }
    }
    finally {
        foreach ($path in @($inputPath, $outputPath, $errorPath)) {
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
        }
    }
}

function Invoke-Handshake([string]$AdapterPath, [string]$WorkingDirectory) {
    $input = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"portability-test","version":"1"}}}' + "`n" +
        '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' + "`n" +
        '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' + "`n"
    $run = Invoke-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $AdapterPath) -WorkingDirectory $WorkingDirectory -InputText $input
    $responses = @($run.stdout -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
    $initialized = @($responses | Where-Object { $_.id -eq 1 })
    $listed = @($responses | Where-Object { $_.id -eq 2 })
    Assert-True ($initialized.Count -eq 1 -and [string]$initialized[0].result.protocolVersion -ceq '2025-03-26') 'Validated reader did not complete an initialization handshake.'
    Assert-True ($listed.Count -eq 1 -and @($listed[0].result.tools).Count -gt 0) 'Validated reader did not return its real tool list.'
}

function Get-FileCommandPath([string]$Command) {
    # The one argument a Codex binding may carry after its path is the reader's Codex prefix (S38), which
    # the Desk hook and both Shelf guards are handed; anything else after the path is still refused.
    $match = [regex]::Match($Command, '-File\s+"([^"]+)"(?:\s+-ReaderToolPrefix\s+mcp__[A-Za-z0-9_-]+__)?\s*$')
    if (-not $match.Success) { throw "Generated hook command has no exact quoted -File path: $Command" }
    $match.Groups[1].Value
}

function New-Fixture([string]$SourceRoot, [string]$FixtureRoot) {
    New-Item -ItemType Directory -Path $FixtureRoot -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $SourceRoot '.claude') -Destination (Join-Path $FixtureRoot '.claude') -Recurse
    New-Item -ItemType Directory -Path (Get-DeskStateDirectory -StateDirectory (Join-Path $FixtureRoot '.claude') -Seat 'fixture') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $SourceRoot 'tools') -Destination (Join-Path $FixtureRoot 'tools') -Recurse
    # STEP 20/S13: THE FIXTURE IS A WORKSPACE, AND IT NOW HAS TO SAY SO. A workspace anchor -- a
    # hook's own location standing in for the workspace it guards -- requires
    # `.library/workspace.json`, because an installed package is a copy of a checkout and carries
    # `tools/BookRootSchema.ps1` just as this fixture does. Without a marker the generated Desk
    # context hook correctly reports "in no Library workspace" and the Desk assertion below fails.
    # That is exactly what it did from S13 until 2026-09-21, unseen because `-Fast` skips this suite
    # and both intervening sessions closed on `-Fast`.
    New-Item -ItemType Directory -Path (Join-Path $FixtureRoot '.library') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $FixtureRoot '.library/workspace.json'),
        (@{ id = [guid]::NewGuid().ToString(); program_version = 'fixture'; collection_id = '';
            backend = 'local'; writable = $false; created = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json),
        [Text.UTF8Encoding]::new($false))
    New-Item -ItemType Directory -Path (Join-Path $FixtureRoot '.codex') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $SourceRoot '.codex/config.template.toml') -Destination (Join-Path $FixtureRoot '.codex/config.template.toml')
    Copy-Item -LiteralPath (Join-Path $SourceRoot '.codex/hooks.template.json') -Destination (Join-Path $FixtureRoot '.codex/hooks.template.json')
    Copy-Item -LiteralPath (Join-Path $SourceRoot '.mcp.json') -Destination (Join-Path $FixtureRoot '.mcp.json')
    [IO.File]::WriteAllText((Get-DeskFilePath -StateDirectory (Join-Path $FixtureRoot '.claude') -Seat 'fixture' -Kind 'books'), '', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Get-DeskFilePath -StateDirectory (Join-Path $FixtureRoot '.claude') -Seat 'fixture' -Kind 'projects'), "projects/library-dev`n", [Text.UTF8Encoding]::new($false))
}

function Test-Fixture([string]$SourceRoot, [string]$FixtureRoot, [string]$UnrelatedDirectory) {
    New-Fixture -SourceRoot $SourceRoot -FixtureRoot $FixtureRoot
    $initializer = Join-Path $FixtureRoot 'tools/Initialize-CodexLibrary.ps1'
    $first = Invoke-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $initializer, '-Json') -WorkingDirectory $UnrelatedDirectory -InputText ''
    $firstResult = $first.stdout | ConvertFrom-Json
    Assert-True ($firstResult.config_changed -and $firstResult.hooks_changed) 'First Codex initialization did not generate both bindings.'
    $second = Invoke-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $initializer, '-Json') -WorkingDirectory $UnrelatedDirectory -InputText ''
    $secondResult = $second.stdout | ConvertFrom-Json
    Assert-True (-not $secondResult.config_changed -and -not $secondResult.hooks_changed) 'Codex initialization is not idempotent.'

    $configPath = Join-Path $FixtureRoot '.codex/config.toml'
    $hooksPath = Join-Path $FixtureRoot '.codex/hooks.json'
    $config = [IO.File]::ReadAllText($configPath)
    Assert-True ($config -cnotmatch '(?m)^cwd\s*=') 'Generated Codex config still depends on an MCP working directory.'
    Assert-True ($config -cmatch '(?ms)^\[mcp_servers\.validated-book-reader\].*?^required\s*=\s*true\s*$') 'Generated Codex config does not keep the validated reader required.'
    $argsMatch = [regex]::Match($config, '(?m)^args\s*=\s*(\[[^\r\n]+\])\s*$')
    Assert-True $argsMatch.Success 'Generated Codex config has no parseable reader argument list.'
    $adapterArguments = $argsMatch.Groups[1].Value | ConvertFrom-Json
    $codexAdapter = [string]($adapterArguments | Select-Object -Last 1)
    Assert-True ([IO.Path]::IsPathRooted($codexAdapter) -and (Test-Path -LiteralPath $codexAdapter -PathType Leaf)) "Generated Codex reader path is not an absolute path into the fixture: '$codexAdapter'."

    $hooks = [IO.File]::ReadAllText($hooksPath) | ConvertFrom-Json
    # Events nest under 'hooks'. This file read them from the ROOT until 2026-09-06, which is the
    # same wrong shape the generator was writing -- test and generator agreed with each other and
    # both disagreed with Codex, so the suite proved the bindings portable to a file Codex refused
    # to load. Reading through the correct shape here is what makes the assertion mean anything.
    $codexEvents = $hooks.hooks
    $guardCommand = [string]$codexEvents.PreToolUse[0].hooks[0].command
    $contextCommand = [string]$codexEvents.UserPromptSubmit[0].hooks[0].command
    $shellBlock = @($codexEvents.PreToolUse | Where-Object { [string]$_.matcher -cmatch 'Bash' })
    Assert-True ($shellBlock.Count -eq 1) 'Generated Codex hooks do not register a shell-tool matcher.'
    $shellCommand = [string]$shellBlock[0].hooks[0].command
    $guardPath = Get-FileCommandPath $guardCommand
    $contextPath = Get-FileCommandPath $contextCommand
    $shellGuardPath = Get-FileCommandPath $shellCommand
    foreach ($path in @($guardPath, $contextPath, $shellGuardPath)) {
        Assert-True ([IO.Path]::IsPathRooted($path) -and (Test-Path -LiteralPath $path -PathType Leaf)) "Generated hook path is not usable: $path"
    }

    Invoke-Handshake -AdapterPath $codexAdapter -WorkingDirectory $UnrelatedDirectory
    $claudeConfig = [IO.File]::ReadAllText((Join-Path $FixtureRoot '.mcp.json')) | ConvertFrom-Json
    $claudeRelativeAdapter = [string]$claudeConfig.mcpServers.'validated-book-reader'.args[-1]
    Invoke-Handshake -AdapterPath (Join-Path $FixtureRoot $claudeRelativeAdapter) -WorkingDirectory $FixtureRoot

    $projectId = [IO.File]::ReadAllText((Join-Path $FixtureRoot '.claude/.library-project')).Trim()
    $guardInput = @{ tool_name = 'mcp__basic-memory__read_note'; tool_input = @{ project_id = $projectId; identifier = 'books/closed/wiki/_book' } } | ConvertTo-Json -Compress
    $guardEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($guardInput))
    $guardRun = Invoke-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $guardPath, '-InputJsonBase64', $guardEncoded) -WorkingDirectory $UnrelatedDirectory -InputText ''
    $guardResult = $guardRun.stdout | ConvertFrom-Json
    Assert-True ([string]$guardResult.hookSpecificOutput.permissionDecision -ceq 'deny') 'Generated Codex Basic Memory guard did not run and deny a direct content read.'

    $contextRun = Invoke-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $contextPath) -WorkingDirectory $UnrelatedDirectory -InputText '{}'
    $contextResult = $contextRun.stdout | ConvertFrom-Json
    Assert-True ([string]$contextResult.hookSpecificOutput.additionalContext -cmatch 'projects/library-dev') 'Generated Codex Desk context hook did not report the fixture open Project.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $FixtureRoot '.codex-plugin'))) 'Fixture unexpectedly contains an optional Codex plugin.'
    Assert-True ($config -cnotmatch '(?i)plugin') 'Generated Codex startup depends on an optional plugin.'
}

$sourceRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$templates = @('.codex/config.template.toml', '.codex/hooks.template.json')
foreach ($relative in $templates) {
    $text = [IO.File]::ReadAllText((Join-Path $sourceRoot $relative))
    Assert-True ($text -cnotmatch '(?i)(?:[a-z]:[\\/]|/users/|/home/|%userprofile%|\$env:userprofile)') "$relative contains a machine-specific filesystem binding."
}

$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('codex-portability-' + [guid]::NewGuid().ToString('N'))
try {
    $unrelated = Join-Path $sandbox 'Unrelated Working Directory'
    New-Item -ItemType Directory -Path $unrelated -Force | Out-Null
    Test-Fixture -SourceRoot $sourceRoot -FixtureRoot (Join-Path $sandbox 'fixture-library') -UnrelatedDirectory $unrelated
    Test-Fixture -SourceRoot $sourceRoot -FixtureRoot (Join-Path $sandbox 'Relocated Library Copy With Spaces') -UnrelatedDirectory $unrelated
    [pscustomobject]@{ status = 'passed'; fixtures = 2; unrelated_working_directory = $true; codex_hooks = 2; claude_and_codex_independent = $true; plugin_required = $false }
}
finally {
    if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
}
