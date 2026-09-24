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
    WHAT THIS DELIBERATELY DOES NOT DO.

    Its first design restated the load-bearing rules from CLAUDE.md after a compaction, on the
    reasoning that compaction is what context rot is made of. `.claude/rules/library-development.md`
    says otherwise, and says it about this harness specifically:

        "a project-root CLAUDE.md is re-injected after a /compact, and a path-scoped rule is not --
         it reloads the next time a matching file is read. So process guidance belongs here, and
         anything that must survive a long session unbroken ... stays in CLAUDE.md."

    So the Library had already solved that problem, by putting those rules in the one file that comes
    back. A hook restating them would have been a second copy of text the harness re-injects for
    free, charged against a workspace that budgets its always-on instruction surface in WORDS.

    WHAT IT DOES INSTEAD. The two things a compaction genuinely takes away here.

    ONE: the path-scoped rule itself. It is scoped to tools/**, .claude/**, docs/** and .githooks/**,
    and it carries the six PowerShell defect families this codebase keeps producing and the rules for
    writing to durable storage. After a compaction it is gone until a file it scopes to is next READ
    -- and the dangerous window is a session that resumes by WRITING one. Its `## The standing rules`
    section is re-served here, from the rule file itself rather than from a copy.

    TWO: the serve ledger. Get-PlaybookContext.ps1 injects each playbook section once per session, on
    the argument that a session remembers what it was handed. A compaction is exactly the event that
    voids that argument, so the ledger is emptied and the next consequential helper re-serves its
    procedure. This is the side effect that makes the once-per-session cap affordable at all, and it
    is the reason this hook must run even when it has nothing to say.

    THE TRADEOFF IT ACCEPTS. It cannot tell a development session from an ordinary reading one, so a
    reader who has only been consulting Books pays about a hundred and twenty words, once, per
    compaction. Detecting the difference would mean threading a marker through the PreToolUse hooks;
    that was judged more coupling than the saving is worth. Revisit if compactions get frequent.

    TWO MEASURED FAULTS, FIXED 2026-09-10, AND BOTH HAD BEEN SILENT SINCE THIS FILE WAS WRITTEN.
    `PLAN-seat-launch.md` step 0c captured real SessionStart payloads on 2026-09-09.

    ONE: THE FIELD IS `source`, AND THIS READ `startup_reason`, WHICH NO PAYLOAD CARRIES. So the
    comparison below was always against an empty string, `-cnotin @('compact', 'resume')` was always
    true, and this hook EXITED 0 ON EVERY SESSION START IT HAD EVER SEEN. `PostCompact` was
    unaffected -- a different `hook_event_name` skips the early exit -- so compaction still cleared
    the ledger, and the half that never ran was the RESUMED one: the ledger is keyed by session id, a
    resumed session keeps the same id, and nothing emptied it, so a resumed session whose context was
    gone got no playbook re-served.

    TWO: `systemMessage` DOES NOT REACH THE MODEL AND `additionalContext` DOES. Measured on
    SessionStart by emitting both with distinct tokens and asking the model to echo what it had been
    given; only the `additionalContext` token came back. So the served section had no reader even on
    the path that did run. `PostCompact`'s output shape was NOT measured -- neither field was proven
    there, and `--print` mode cannot be made to compact -- so this now emits the one shape that is
    known to work somewhere rather than the one known to fail somewhere. Recorded as a limit.

    AND THE LEDGER IS NOW CLEARED ON EVERY SessionStart SOURCE, not only on the two that are served.
    A `clear` may or may not mint a new session id -- 0c could not capture that event at all -- and if
    it does not, the ledger still holds keys for a context that has just been thrown away. Clearing it
    when it was already empty costs nothing; HookContext.ps1's own note applies, that every failure in
    the ledger costs repetition and none withholds guidance.
#>

. (Join-Path $PSScriptRoot 'HookContext.ps1')

try {
    if (-not $StateDirectory) { $StateDirectory = Split-Path -Parent $PSScriptRoot }
    $call = Read-HookPayload -BoundParameters $PSBoundParameters -InputJson $InputJson -InputJsonBase64 $InputJsonBase64

    $event = [string](Get-HookField $call 'hook_event_name')
    # `source`, MEASURED, not `startup_reason`, ASSUMED. See the header: the field this used to read
    # arrives on no payload, so every SessionStart exited two lines below without ever clearing a
    # ledger or serving a section.
    $source = [string](Get-HookField $call 'source')

    # FIRST, and outside anything that can fail below: the ledger clear is this hook's contract with
    # Get-PlaybookContext.ps1, and a missing rule file must not cost a session its re-served playbooks.
    # It runs for EVERY source value, because the cheapest wrong answer here is a redundant clear.
    $sessionId = [string](Get-HookField $call 'session_id')
    Clear-HookServed $StateDirectory $sessionId

    # AND ON PostCompact THE LEDGER IS THE WHOLE JOB, MEASURED 2026-09-22 rather than assumed.
    # The header above recorded the output shape for this event as an unproven limit. It is proven
    # now, from a real /compact in a seated session, and the answer is that there is no shape:
    # Claude Code accepts no `hookSpecificOutput` for PostCompact at all. Its own words, from the
    # transcript rather than from a model reporting on itself --
    #
    #   PostCompact [... Restore-CompactedGuidance.ps1] failed: Hook JSON output validation failed
    #   - hookSpecificOutput.hookEventName: expected one of "PreToolUse" | "UserPromptSubmit" |
    #   "UserPromptExpansion" | "SessionStart" | "Setup" | "PreModelSwitch" | ...
    #
    # -- and a validation failure discards the WHOLE object, so every PostCompact run since this
    # file was written has emitted something no session ever received, and said so in a line nobody
    # was reading.
    #
    # NOTHING IS LOST BY GOING QUIET HERE, and that is measured too. One /compact fires BOTH events:
    # `SessionStart:compact` ran this same hook 0.4s earlier, its output validated, and the
    # transcript carries the delivered text as a `hook_additional_context` attachment. So the
    # guidance already arrives by the route this hook is registered under for the resumed case, and
    # emitting here as well would duplicate it if a shape existed. Exiting quietly is what this
    # event can actually do: clear the ledger, which happened above, and get out of the way.
    #
    # THE RISK, NAMED. This now depends on Claude Code firing SessionStart alongside PostCompact,
    # measured once on v2.1.278. A client that fires PostCompact alone would deliver no guidance --
    # but it delivered none before this change either, and additionally logged a failure. The
    # regression case in tools/Test-LibraryHooks.ps1 pins the shape; nothing can pin the coupling.
    if ($event -ceq 'PostCompact') { exit 0 }

    # A 'startup', 'clear' or 'fork' session has its instruction surface in full: CLAUDE.md loaded,
    # and the path-scoped rule waiting for the next matching read exactly as on any fresh session.
    # Only the resumed and post-compaction ones are carrying a context that was summarised away.
    if ($event -ceq 'SessionStart' -and $source -cnotin @('compact', 'resume')) { exit 0 }

    $rule = Join-Path $StateDirectory (Join-Path 'rules' 'library-development.md')
    $section = Get-MarkdownSection -Path $rule -Heading '## The standing rules'
    if ([string]::IsNullOrWhiteSpace($section)) { exit 0 }

    $preamble = "Context was just compacted or resumed. CLAUDE.md and the Virtual Desk line come " +
        "back on their own; .claude/rules/library-development.md does not, until a file it scopes " +
        "to is next read. If this session is changing Library code, read that rule in full before " +
        "writing -- it carries the six PowerShell defect families and the durable-write rules. Its " +
        "opening section:`n`n"
    # `additionalContext`, which step 0c measured reaching the model, and NOT `systemMessage`, which
    # it measured not reaching it. One shape for both events rather than a hedge: a hook emitting both
    # could not be asserted against either, and a future reader could not tell which was the contract.
    Write-HookOutput $event @{ additionalContext = ($preamble + $section) }
}
catch {
    # Silent. This hook cannot block, and neither PostCompact nor SessionStart is a decision point
    # where a malformed object should land.
    exit 0
}
