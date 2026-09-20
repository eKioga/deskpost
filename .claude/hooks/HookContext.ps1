<#
.SYNOPSIS
    Shared plumbing for the Library's Claude Code hooks. Dot-sourced; never invoked directly.

.DESCRIPTION
    The two original guards (`Guard-BasicMemoryRead.ps1`, `Guard-ShelfBookRead.ps1`) each carried
    their own copy of the payload reader and their own deny writer. That was tolerable at two files.
    At seven it is the same problem `tools/BookRootSchema.ps1` exists to solve one layer down: a
    shape written out independently in every consumer is a shape nobody can change.

    This file does NOT absorb the two original guards' Desk-state parsing. Those two fail closed on
    every path out of their catch blocks, and folding them into a file that other, non-denying hooks
    also load would put a fail-open caller and a fail-closed caller behind one dependency. The
    boundary here is deliberately narrow: payload in, JSON out, and the serve ledger.

    THE SERVE LEDGER is what makes just-in-time instruction injection affordable. A hook that
    re-injects a playbook section on every call charges the reader for it every time; a hook that
    injects it once per session charges once and then rots along with everything else. The ledger
    splits the difference -- once per session per key, and `Clear-HookServed` empties the session's
    keys when the context that held them is summarised away, which is exactly what
    `Restore-CompactedGuidance.ps1` does on PostCompact.
#>

Set-StrictMode -Version Latest

# The hook payload arrives on stdin in normal operation. The two -InputJson forms exist for the
# self-test suite, which drives these hooks as real processes: `desk.book-root-selftest` established
# that a hook nothing executes is a hook whose output nobody has ever checked.
function Read-HookPayload {
    param(
        [hashtable]$BoundParameters,
        [string]$InputJson,
        [string]$InputJsonBase64
    )
    # STDIN ONLY reaches the capture below, and the distinction is load-bearing rather than tidy:
    # the two -InputJson forms are the self-test suite's, and the suite COMPOSES its payloads. A
    # capture directory left on during a suite run collected `session-a` and `session-d` alongside
    # the real ones on 2026-09-19, and the contract builder would then have stamped `captured`
    # provenance on a payload this tree wrote itself -- the exact substitution the contract exists
    # to prevent.
    $fromStdin = -not ($BoundParameters.ContainsKey('InputJsonBase64') -or $BoundParameters.ContainsKey('InputJson'))
    $raw = if ($BoundParameters.ContainsKey('InputJsonBase64')) {
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($InputJsonBase64))
    }
    elseif ($BoundParameters.ContainsKey('InputJson')) { $InputJson }
    else { [Console]::In.ReadToEnd() }
    if ($fromStdin) { Write-CapturedPayload $raw }
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    $raw | ConvertFrom-Json
}

# OFF BY DEFAULT, AND ON BY MKDIR. `.claude/hooks/.capture/` does not exist in a checkout; create it
# and every hook writes the raw bytes the HARNESS handed it into it, one file per invocation, until
# the directory is removed again. It is gitignored, and nothing in the product reads it. Only the
# stdin route is captured -- see the caller -- because a payload the self-test suite composed is
# exactly what a captured contract must never be built from.
#
# WHY IT IS WORTH ITS EIGHT LINES. Every field a hook reads is a field the client has to send, and a
# client can rename one without saying so. That failure is silent by construction -- `Get-HookField`
# answers $null for a name that is not there -- and it has already cost this tree a hook:
# `Restore-CompactedGuidance.ps1` read `startup_reason` for four days and exited early on every
# SessionStart it ever saw. `payload-contract.json` beside this file records the field set measured
# from a real payload per event, `hooks.payload-fields-are-captured` fails the gate on a read the
# contract does not cover, and this is how the contract is re-measured after a client upgrade.
function Write-CapturedPayload([string]$Raw) {
    try {
        $dir = Join-Path $PSScriptRoot '.capture'
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return }
        $name = 'payload-{0:yyyyMMdd-HHmmss-fff}-{1}.json' -f (Get-Date), $PID
        [IO.File]::WriteAllText((Join-Path $dir $name), $Raw, [Text.UTF8Encoding]::new($false))
    }
    catch { }
}

# StrictMode turns a missing property into a terminating error rather than $null, and hook payloads
# are shaped by the event. Every field read out of a payload goes through here.
#
# THE PROPERTY NAMES ARE ENUMERATED, NOT READ OFF THE AGGREGATE, and the difference is defect family
# 4: under Set-StrictMode, `$o.PSObject.Properties.Name` on an EMPTY collection throws
# "The property 'Name' cannot be found on this object" rather than yielding nothing. So this function
# -- whose entire job is to make a missing field safe -- threw on the one payload with no fields at
# all. It sat here from the day the file was written and fired the first time a hook that reads a
# payload was driven with `{}`, which is what the Codex portability suite sends: the hook failed
# closed, the Desk line said "state is invalid", and the cause was three call frames away in a
# helper named for handling exactly this. No lint covers family 4 -- `powershell.defect-families`
# looks for .Count and [0] on a pipeline, and this is neither.
function Get-HookField($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $names = @($Object.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -notcontains $Name) { return $null }
    $Object.$Name
}

# The text of a shell command, whatever shape the client wrapped it in.
#
# ONE HOOK FILE SERVES TWO CLIENTS AND THEY DO NOT AGREE. Claude Code's Bash tool sends
# `{ command: "wc -c x" }` -- a string. Codex's shell tool is named `exec`, and on 2026-09-06 its
# payload shape could not be captured: Codex hash-pins hook trust in `[hooks.state]`, so an
# untrusted hook never fires and never reveals what it would have been sent. Its transcript renders
# the call as an argv list, so an array is the likely shape and a string is not guaranteed.
#
# Rather than guess, this reads the shapes that are known, then FALLS BACK TO THE SERIALISED INPUT.
# For a guard that is the safe direction: a Shelf path anywhere in a shell tool's arguments is worth
# denying, whatever field it arrived in. The fallback is only reached when no recognised command
# field exists, so the ordinary Bash payload is never over-scanned -- its `description` field, which
# this session writes and which can legitimately name a Book, stays out of the text being judged.
function Get-HookCommandText($ToolInput) {
    if ($null -eq $ToolInput) { return '' }
    foreach ($field in @('command', 'commands')) {
        $value = Get-HookField $ToolInput $field
        if ($null -eq $value) { continue }
        # -join, not [string]: casting an array relies on $OFS defaulting to a space, and a profile
        # or a caller that has set $OFS would silently concatenate argv into one unsplittable word.
        if ($value -is [Array]) { return (@($value) -join ' ') }
        return [string]$value
    }
    # local_shell-style nesting: { action: { command: [...] } }
    $action = Get-HookField $ToolInput 'action'
    if ($null -ne $action) {
        $nested = Get-HookField $action 'command'
        if ($null -ne $nested) {
            if ($nested -is [Array]) { return (@($nested) -join ' ') }
            return [string]$nested
        }
    }
    try { return ($ToolInput | ConvertTo-Json -Compress -Depth 8) } catch { return '' }
}

function Write-HookOutput([string]$EventName, [hashtable]$Fields) {
    $payload = @{ hookEventName = $EventName }
    foreach ($key in $Fields.Keys) { $payload[$key] = $Fields[$key] }
    @{ hookSpecificOutput = $payload } | ConvertTo-Json -Compress -Depth 6
}

function Write-HookDeny([string]$EventName, [string]$Reason) {
    Write-HookOutput $EventName @{ permissionDecision = 'deny'; permissionDecisionReason = $Reason }
}

# --- The serve ledger ----------------------------------------------------------------------------
# `.claude/.hook-served.json` maps a session id to the keys already served into it. Untracked, like
# every other piece of Desk runtime state: it belongs to this checkout, not to the code.
#
# EVERY FAILURE HERE IS SWALLOWED, and that is the correct direction for this particular file. A
# ledger that cannot be read reports "not served", so the reader gets the instruction again; a
# ledger that cannot be written reports success, so the reader gets it again next time. Both
# failures cost repetition. Neither withholds guidance, and neither can block a tool call.
function Get-HookLedgerPath([string]$StateDirectory) {
    Join-Path $StateDirectory '.hook-served.json'
}

# [ordered], NOT @{}, AND THE DIFFERENCE IS THE WHOLE CAP. The file's own order is the only record
# of which session was written first; a plain hashtable throws that away on the way in, and
# Save-HookLedger then evicts by an order nobody chose. See the eviction comment below.
function Read-HookLedger([string]$StateDirectory) {
    $path = Get-HookLedgerPath $StateDirectory
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return [ordered]@{} }
    try {
        $parsed = [IO.File]::ReadAllText($path) | ConvertFrom-Json
        $table = [ordered]@{}
        foreach ($property in $parsed.PSObject.Properties) {
            # @() around the value: a session holding exactly one key round-trips through JSON as a
            # bare string, and .Count on that is the length of the string under StrictMode.
            $table[[string]$property.Name] = @($property.Value)
        }
        return $table
    }
    catch { return [ordered]@{} }
}

function Save-HookLedger([string]$StateDirectory, [System.Collections.IDictionary]$Ledger) {
    # Twenty sessions is enough to keep a day's work addressable and small enough that the file stays
    # a few hundred bytes. Ordering is the file's own, which for this table is the order sessions
    # first served a key -- good enough to drop the oldest, and nothing depends on it being exact.
    #
    # A [hashtable] HAS NO SUCH ORDER, AND THIS TRIM SPENT WEEKS ASSUMING IT DID. The line read
    # `@($table.Keys)[-20..-1]` off a plain hashtable and called it insertion order. It is bucket
    # order: measured on 2026-09-19 against this very ledger, a newly added key enumerates FIRST,
    # for every id tried. So "keep the last twenty" kept the twenty OLDEST and evicted the session
    # that had just served. The moment the file reached twenty sessions it froze: no new session was
    # ever recorded again, Test-HookServed answered $false forever, every playbook section was
    # re-injected on every matching tool call for the life of every session, and PostCompact's
    # Clear-HookServed had nothing to clear. The ledger stayed exactly twenty entries and looked
    # healthy, which is why two reports read it as a blank session id -- the write was happening,
    # landing on the right file, and coming out byte-identical.
    #
    # [ordered] is what makes the first paragraph true. Do not narrow the parameter back to
    # [hashtable]: PowerShell coerces an OrderedDictionary to one on the way in, silently, and the
    # defect returns with no diagnostic at all.
    $table = $Ledger
    if ($table.Count -gt 20) {
        $trimmed = [ordered]@{}
        foreach ($key in @($table.Keys | Select-Object -Last 20)) { $trimmed.Add([string]$key, $table[[string]$key]) }
        $table = $trimmed
    }
    try {
        $json = $table | ConvertTo-Json -Compress -Depth 4
        [IO.File]::WriteAllText((Get-HookLedgerPath $StateDirectory), $json, [Text.UTF8Encoding]::new($false))
    }
    catch { }
}

function Test-HookServed([string]$StateDirectory, [string]$SessionId, [string]$Key) {
    if ([string]::IsNullOrWhiteSpace($SessionId)) { return $false }
    $ledger = Read-HookLedger $StateDirectory
    if (-not $ledger.Contains($SessionId)) { return $false }
    @($ledger[$SessionId]) -ccontains $Key
}

function Set-HookServed([string]$StateDirectory, [string]$SessionId, [string]$Key) {
    if ([string]::IsNullOrWhiteSpace($SessionId)) { return }
    $ledger = Read-HookLedger $StateDirectory
    # @() AROUND THE WHOLE `if`, not just around the value inside it. An `if` used as an
    # expression puts its branch's output on the pipeline, and a one-element array unrolls to a
    # bare string on the way out -- so the inner @() here was defeated by the assignment around
    # it, and `$existing + $Key` CONCATENATED the second key onto the first instead of adding to
    # a list. The cap then held for exactly one key per session and failed silently for every
    # key after it: a live ledger reached sixteen servings across five distinct keys, re-injecting
    # eleven playbook sections nobody needed. Read-HookLedger already carries this fix and the
    # same reasoning; this call site was missed. Defect family 2 in
    # .claude/rules/library-development.md, wearing `if` clothing rather than a pipeline's.
    $existing = @(if ($ledger.Contains($SessionId)) { $ledger[$SessionId] } else { @() })
    if ($existing -ccontains $Key) { return }
    $ledger[$SessionId] = @($existing + $Key)
    Save-HookLedger $StateDirectory $ledger
}

function Clear-HookServed([string]$StateDirectory, [string]$SessionId) {
    if ([string]::IsNullOrWhiteSpace($SessionId)) { return }
    $ledger = Read-HookLedger $StateDirectory
    if (-not $ledger.Contains($SessionId)) { return }
    $ledger.Remove($SessionId)
    Save-HookLedger $StateDirectory $ledger
}

# --- Bounded Markdown section extraction ---------------------------------------------------------
# Cuts one section out of a durable doc so a hook can hand the reader the procedure itself rather
# than a pointer to it.
#
# THE CUT IS BY STRUCTURE, NOT BY AN END MARKER. An end-marker cut in this repository once swallowed
# four unrelated sections because the marker it looked for appeared later than the author expected.
# A section ends at the next heading of the SAME OR HIGHER level -- so a `##` section keeps its `###`
# children and stops at the next `##`, and a `###` section stops at the next `###` or `##` alike.
function Get-MarkdownSection([string]$Path, [string]$Heading) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    if ($Heading -cnotmatch '^(#{1,6}) ') { return $null }
    $level = $Matches[1].Length
    $lines = [IO.File]::ReadAllLines($Path)
    $start = -1
    for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($lines[$i].TrimEnd() -ceq $Heading) { $start = $i; break }
    }
    if ($start -lt 0) { return $null }
    $end = $lines.Length
    for ($i = $start + 1; $i -lt $lines.Length; $i++) {
        if ($lines[$i] -cmatch '^(#{1,6}) ' -and $Matches[1].Length -le $level) { $end = $i; break }
    }
    (($lines[$start..($end - 1)] -join "`n").TrimEnd())
}
