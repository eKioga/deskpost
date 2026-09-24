<#
.SYNOPSIS
    The Library's Codex bindings, rendered from the tracked templates. Dot-sourced; never invoked
    directly.

.DESCRIPTION
    Two callers render these files and they used to be one: `tools/Initialize-CodexLibrary.ps1`
    writes the PROGRAM's bindings into the program tree, and `library init` writes a reader
    WORKSPACE's into the workspace (ADR-0036, extended to Codex). One renderer rather than two,
    because the hooks document is genuinely the same document in both places -- only the program
    root it points at differs.

    RENDER, DO NOT REBUILD. Every function here substitutes tokens into template TEXT and never
    parses a document and writes it back. The rebuild route is what shipped a malformed Claude hook
    block twice (defect family 2): a one-element array unrolls on its way out of a function, and a
    serializer then writes an object where an array is required. Text substitution cannot unroll
    anything. The parse at the end of each renderer is a JUDGE on the result, not a stage in
    producing it.

    WHAT CODEX ACTUALLY READS, MEASURED 2026-09-22 ON codex-cli 0.153.4, because the plan's step 20
    assumed and the assumption was half wrong.

      * `<project>/.codex/hooks.json`  IS read, and so is `<project>/.codex/config.toml`. Both are
        found by walking up from the session's working directory, so a seat that starts in a
        subdirectory still gets them.

      * BOTH ARE GATED ON PROJECT TRUST, and an untrusted project is ignored in SILENCE. The gate is
        `[projects.'<path>'] trust_level = "trusted"` in `$CODEX_HOME/config.toml`. The four-cell
        measurement, one binary, one fixture, one variable moved:

          | project trusted | `.codex/config.toml` declares 1 server | `codex mcp list` |
          | no              | yes                                    | `[]`             |
          | yes             | yes                                    | that server      |

          | project trusted | `.codex/hooks.json` malformed | codex's own line                   |
          | no              | yes                           | nothing at all                     |
          | yes             | yes                           | `failed to parse hooks config ...` |

        The untrusted cells are the dangerous ones and they are indistinguishable from "no such
        file". So a workspace can carry a perfect Codex boundary and run with none, which is exactly
        the shape `workspace.guards-registered` was written for on the Claude side.

      * TRUST IS PER-`CODEX_HOME`, AND THIS MACHINE HAS TWO. Orca redirects `CODEX_HOME` to a runtime
        home of its own (docs/hook-enforced-boundaries.md), so the home a reader grants trust in from
        a plain terminal is not the home an Orca-launched seat consults. `tools/CodexHome.ps1` is the
        one place that resolves it and both readers of trust go through it.

      * HOOK TRUST IS A THIRD, NARROWER GATE. `[hooks.state.'<file>:<event>:<i>:<j>']` carries a
        `trusted_hash` per hook, granted by the CLI's startup review panel. Nothing in this
        repository can assert it and nothing here tries to: it is reported, never written.

    NOTHING HERE WRITES INTO `$CODEX_HOME`. Marking a folder trusted is a security decision about a
    machine, taken by the reader in their own client on first launch; a tool that granted it quietly
    would be deciding that for them in a file no workspace owns.
#>

Set-StrictMode -Version Latest

# Test-CodexHookShape and Get-HookEntryText live with the rest of the hook registry, and the
# renderer below judges its own output with them rather than trusting its callers to. Dot-sourced
# here rather than assumed loaded: both callers already load it, and depending on the order two
# unrelated files happen to be loaded in is how a judge goes quiet. HookRegistry.ps1 declares no
# param() block, so loading it twice costs nothing.
. (Join-Path $PSScriptRoot 'HookRegistry.ps1')

# The four hooks a Codex session needs, with the matcher tokens each is bound to in the template.
# The set is the Codex half of tools/HookRegistry.ps1's required list: the three guards plus the
# Desk informer. The other five Library hooks are registered for Claude Code alone -- Codex fires no
# PostToolUse for its own tools and has no ConfigChange event at all.
#
# THREE OF THE FOUR NAME THE READER, and in Codex its name is not the project form (S38). Codex spells
# a server's hyphens as underscores in every tool name it offers -- measured S37 -- so the reader this
# workspace's .codex/config.toml registers as `validated-book-reader` is offered as
# `mcp__validated_book_reader__<tool>`, and a Desk line or a denial naming `mcp__validated-book-reader__`
# sends a Codex session to a tool it does not have. Each is handed the Codex prefix; the Basic Memory
# guard names no reader tool and takes none.
$script:CodexReaderServer = 'validated-book-reader'
$script:CodexReaderToolPrefix = 'mcp__' + $script:CodexReaderServer.Replace('-', '_') + '__'
$script:CodexHookTokens = @(
    @{ token = '__BASIC_MEMORY_GUARD_COMMAND__'; file = 'Guard-BasicMemoryRead.ps1'; purpose = 'the shared-collection Desk boundary'; readerPrefix = $false },
    @{ token = '__SHELL_GUARD_COMMAND__';        file = 'Guard-ShellShelfRead.ps1';  purpose = 'a closed Shelf Book is unreadable by shell command'; readerPrefix = $true },
    @{ token = '__PATCH_GUARD_COMMAND__';        file = 'Guard-ShelfBookRead.ps1';   purpose = 'apply_patch cannot write into a closed Shelf Book'; readerPrefix = $true },
    @{ token = '__DESK_CONTEXT_COMMAND__';       file = 'Get-VirtualDeskContext.ps1'; purpose = 'what is open, on every prompt'; readerPrefix = $true }
)

function Get-CodexReaderToolPrefix { $script:CodexReaderToolPrefix }

function Get-CodexHookTokenTable { @($script:CodexHookTokens) }

# The line `library init` stamps on a Codex binding it wrote. Ownership is read from the file rather
# than kept in a fingerprint beside it, for the same reason the Claude hook block's is: a second copy
# of a fact is a second chance to be wrong. A file without this line is the reader's and is refused,
# never overwritten.
$script:CodexManagedMarker = '# Managed by `library init`. Re-run it after moving the program; edits here are replaced.'

function Get-CodexManagedMarker { $script:CodexManagedMarker }

function ConvertTo-CodexTomlString {
    <# One TOML basic string. Backslashes and quotes escape; a Windows path is full of both. #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function ConvertTo-CodexTomlArray {
    <# A TOML array of basic strings, on one line -- which is the shape Test-CodexPortability reads. #>
    param([Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Values)
    '[' + ((@($Values) | ForEach-Object { ConvertTo-CodexTomlString $_ }) -join ', ') + ']'
}

function Expand-CodexTemplateToken {
    <#
        Replace a token, having first asserted it appears exactly as often as the caller expects.

        THE COUNT IS THE POINT. A token silently absent renders a document that is still valid TOML
        or JSON and no longer says what it was supposed to say -- a hooks file missing its shell
        guard parses perfectly and guards nothing. So a template edit that drops or duplicates a
        token fails here, loudly, rather than in a reader's session.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Replacement,
        [int]$ExpectedCount = 1
    )
    $count = ([regex]::Matches($Text, [regex]::Escape($Token))).Count
    if ($count -ne $ExpectedCount) {
        throw "Template token '$Token' must appear exactly $ExpectedCount time(s); found $count."
    }
    $Text.Replace($Token, $Replacement)
}

function Get-CodexGuardCommand {
    <#
        How Codex invokes one hook. `.codex/hooks.json` puts the whole invocation in ONE string,
        where `.claude/settings.json` splits the interpreter from its arguments -- which is why
        `Get-HookEntryText` in tools/HookRegistry.ps1 reads both shapes.

        NO `-WorkspacePath`, DELIBERATELY, AND THE CLAUDE HALF SPELLS IT THE SAME WAY. The guards
        resolve their workspace through `Resolve-LibraryWorkspace`, whose order is explicit, then
        `LIBRARY_WORKSPACE`, then a marker walk up from the process's working directory. A Codex hook
        subprocess inherits the session's workdir, which ADR-0037 puts inside the workspace, and
        `tools/Start-LibrarySeat.ps1` exports the variable besides. Baking the path in here would
        make one more pointer to rewrite when the reader's workspace moves, for a question that is
        already answered twice.
    #>
    param([Parameter(Mandatory)][string]$ScriptPath, [string]$ReaderToolPrefix)
    $command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $ScriptPath + '"'
    if ($ReaderToolPrefix) { $command += ' -ReaderToolPrefix ' + $ReaderToolPrefix }
    $command
}

function Get-CodexHookScriptPath {
    <#
        One hook script's absolute path under a program's hook directory, with forward slashes.

        THROWS WHEN IT IS NOT THERE. A registration naming a script that does not exist is the
        fail-open shape this tree has now met three times: the harness reports a non-blocking error
        and proceeds, so the boundary is absent and the session is told nothing.
    #>
    param(
        [Parameter(Mandatory)][string]$HookDirectory,
        [Parameter(Mandatory)][string]$FileName
    )
    $path = (Join-Path $HookDirectory $FileName).Replace('\', '/')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required Library hook is missing, so a Codex binding naming it would fail open: $path"
    }
    $path
}

function New-CodexHooksDocument {
    <#
        `.codex/hooks.json`, rendered from the tracked template against one program's hook directory.

        The same document serves the program's own `.codex/` and a reader's workspace, because the
        only thing that varies between them is the program root the four commands point at -- and in
        a split install that is the SAME program root for both.
    #>
    param(
        [Parameter(Mandatory)][string]$TemplatePath,
        [Parameter(Mandatory)][string]$HookDirectory
    )

    if (-not (Test-Path -LiteralPath $TemplatePath -PathType Leaf)) {
        throw "Required Codex template is missing: $TemplatePath"
    }
    $text = [IO.File]::ReadAllText($TemplatePath)
    foreach ($entry in $script:CodexHookTokens) {
        $prefix = if ($entry.readerPrefix) { $script:CodexReaderToolPrefix } else { '' }
        $command = Get-CodexGuardCommand -ScriptPath (Get-CodexHookScriptPath -HookDirectory $HookDirectory -FileName $entry.file) -ReaderToolPrefix $prefix
        # Twice: `command` and `commandWindows` carry the same invocation, and a template that lost
        # one of them would leave Codex reading the other on one platform only.
        $text = Expand-CodexTemplateToken -Text $text -Token ('"' + $entry.token + '"') `
            -Replacement ($command | ConvertTo-Json -Compress) -ExpectedCount 2
    }
    if ($text -cmatch '__[A-Z0-9_]+__') { throw 'The rendered Codex hooks still contain a template token.' }

    # JUDGED HERE, NOT BY THE CALLER, so that no caller can write a document Codex will refuse. The
    # Claude half learned this the expensive way: `library init` wrote a hook block the harness would
    # not load, and the workspace ADR-0036 exists to guard ran with no guards for three days. Text
    # substitution cannot unroll an array, so the failure this catches is a bad TEMPLATE rather than
    # a bad transform -- and the tracked template is exactly the thing an ordinary edit changes.
    #
    # IT THROWS RATHER THAN RETURNING THE TEXT WITH A WARNING. Codex rejects the whole file on one
    # stray root key, so a document that fails this is not degraded, it is absent.
    $document = $null
    try { $document = $text | ConvertFrom-Json }
    catch { throw "The rendered Codex hooks are not valid JSON, so they were not written: $($_.Exception.Message)" }
    $faults = @(Test-CodexHookShape -Document $document -Label ('the Codex hooks rendered from ' + $TemplatePath))
    if ($faults.Count) {
        throw ('The rendered Codex hooks are not a shape Codex will load, so they were not written: ' +
               ($faults -join '; ') + '. Codex rejects the whole file rather than the bad entry, so writing it ' +
               'would leave a session with no Library hook at all and no line saying why.')
    }
    $text
}

function New-CodexWorkspaceConfigDocument {
    <#
        `.codex/config.toml` for a reader's WORKSPACE, which is a smaller document than the
        program's and deliberately so.

        IT REGISTERS THE VALIDATED READER AND NOTHING ELSE. The program's own config keeps
        `basic-memory` because the trusted interactive Codex Librarian writes through it
        (docs/model-division-of-labor.md); a reader's workspace does not, for the same reason the
        workspace's `.mcp.json` does not register it on the Claude side. A hooks file that fails to
        parse while the config beside it parses fine would leave `mcp__basic-memory__*` serving with
        the Desk boundary absent -- the two files share a trust gate but not a parser, so the
        asymmetry is real. One sentence now describes both harnesses: `library init` gives a
        workspace its guards and the validated reader.

        THE READER IS NAMED WITH A STATE DIRECTORY, exactly as `Get-DesiredMcpServers` names it for
        `.mcp.json`. In a split install the adapter sits in the PROGRAM, whose own anchor is not a
        workspace at all, so the only thing left to answer "which Library" would be whatever
        directory the client happened to launch the server in.
    #>
    param(
        [Parameter(Mandatory)][string]$TemplatePath,
        [Parameter(Mandatory)][string]$AdapterPath,
        [string]$StateDirectory
    )

    if (-not (Test-Path -LiteralPath $TemplatePath -PathType Leaf)) {
        throw "Required Codex template is missing: $TemplatePath"
    }
    if (-not (Test-Path -LiteralPath $AdapterPath -PathType Leaf)) {
        throw "The validated reader adapter is missing, so a Codex binding naming it would start no server: $AdapterPath"
    }
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $AdapterPath.Replace('\', '/'))
    if (-not [string]::IsNullOrWhiteSpace($StateDirectory)) {
        $arguments = @($arguments + @('-StateDirectory', $StateDirectory.Replace('\', '/')))
    }
    $text = [IO.File]::ReadAllText($TemplatePath)
    $text = Expand-CodexTemplateToken -Text $text -Token '"__VALIDATED_READER_ARGS__"' -Replacement (ConvertTo-CodexTomlArray $arguments)
    if ($text -cmatch '__[A-Z0-9_]+__') { throw 'The rendered Codex config still contains a template token.' }
    # The ownership stamp goes on the OUTPUT rather than in the template, because it is a statement
    # about who wrote this copy and not about what the document says.
    $script:CodexManagedMarker + "`n" + $text
}

# --- Trust, which is the gate neither file can see ------------------------------------------------

function ConvertFrom-CodexProjectKey {
    <#
        The path out of one `[projects.<key>]` header. Codex writes the key as a TOML literal string
        in single quotes and lower-cases it (`[projects.'d:\library']`); a hand-written or
        tool-written one may be a basic string in double quotes with escaped backslashes. Both are
        accepted, because both are what is actually on disk.
    #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Key)
    $trimmed = $Key.Trim()
    if ($trimmed.Length -ge 2 -and $trimmed.StartsWith("'") -and $trimmed.EndsWith("'")) {
        return $trimmed.Substring(1, $trimmed.Length - 2)
    }
    if ($trimmed.Length -ge 2 -and $trimmed.StartsWith('"') -and $trimmed.EndsWith('"')) {
        return $trimmed.Substring(1, $trimmed.Length - 2).Replace('\\', '\').Replace('\"', '"')
    }
    $trimmed
}

function Get-CodexProjectTrust {
    <#
        Whether one directory is trusted in the Codex home a session here would consult, and which
        home that was.

        `home_source` is reported rather than inferred: on this machine Orca substitutes
        `CODEX_HOME`, so the answer to "is my workspace trusted" is different depending on where the
        question is asked from, and a reader who cannot see WHICH store was read cannot act on the
        answer. Every field is what was measured, never what should be true.
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$CodexHome
    )

    if ([string]::IsNullOrWhiteSpace($CodexHome)) {
        . (Join-Path $PSScriptRoot 'CodexHome.ps1')
        $CodexHome = Get-CodexHomeDirectory
    }
    $homeSource = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) { 'default' } else { 'CODEX_HOME' }
    $configPath = Join-Path $CodexHome 'config.toml'
    $result = [ordered]@{
        path = $Path; home = $CodexHome; home_source = $homeSource; config = $configPath
        config_present = $false; trusted = $false; matched_key = $null
    }
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return [pscustomobject]$result }
    $result.config_present = $true

    $wanted = $null
    try { $wanted = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/') } catch { $wanted = $Path.TrimEnd('\', '/') }

    # Read as TEXT rather than through a TOML parser, because there is no TOML parser in this tree
    # and a trust record is one line above one line. The header form is fixed by the client that
    # writes it, and the only thing asked of the body is whether the next `trust_level` inside this
    # table says trusted -- a later table's value must not leak backwards into this one.
    $lines = @([IO.File]::ReadAllText($configPath) -split "`r?`n")
    $inWanted = $false
    foreach ($line in $lines) {
        $text = $line.Trim()
        if ($text.StartsWith('[')) {
            $inWanted = $false
            $header = [regex]::Match($text, '^\[projects\.(.+)\]$')
            if ($header.Success) {
                $candidate = ConvertFrom-CodexProjectKey $header.Groups[1].Value
                $normalised = $null
                try { $normalised = [IO.Path]::GetFullPath($candidate).TrimEnd('\', '/') } catch { $normalised = $candidate.TrimEnd('\', '/') }
                # Case-insensitively, because Windows paths are and Codex lower-cases what it writes.
                if ($normalised.Equals($wanted, [StringComparison]::OrdinalIgnoreCase)) {
                    $inWanted = $true
                    $result.matched_key = $candidate
                }
            }
            continue
        }
        if (-not $inWanted) { continue }
        $trust = [regex]::Match($text, '^trust_level\s*=\s*["'']([^"'']*)["'']\s*$')
        if ($trust.Success -and $trust.Groups[1].Value -ceq 'trusted') { $result.trusted = $true }
    }
    [pscustomobject]$result
}
