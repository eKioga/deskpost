<#
.SYNOPSIS
    Drives every Library hook as a real process against a fixture workspace.

.DESCRIPTION
    A hook is the one kind of code in this tree that nothing calls during development. It is invoked
    by the harness, its output is consumed by the harness, and a broken one does not throw where
    anybody is looking -- it simply stops guarding, or stops speaking, and the session carries on.

    `desk.book-root-selftest` established the standard after the Desk context hook spent weeks being
    checked only for REGISTRATION while nothing ever read what it said. This suite applies that
    standard to the rest: every assertion below spawns the actual hook file, feeds it an actual
    payload on the actual parameter the harness uses, and reads the actual JSON that comes back.

    The fixture is a throwaway workspace, with two exceptions that are deliberately real:

        docs/librarian-operation-playbooks.md   copied in, so heading routes are checked against the
        docs/session-invariants.md              tracked documents rather than against a stub that
                                                would keep passing after the real headings changed

    and one assertion that reads the live .claude/settings.json, because "the guards are registered"
    is a claim about this checkout and cannot be made against a fixture.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# The Desk path is resolved, never composed -- see BookRootSchema's SEATS section.
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
# Fixtures work at a seat named 'fixture'. Set in this process so CHILD helper processes
# inherit it: they default -Seat to LIBRARY_SEAT, and there is no default seat to fall back on.
$env:LIBRARY_SEAT = 'fixture'

$repo = Split-Path -Parent $PSScriptRoot
$hooks = Join-Path $repo '.claude/hooks'
$utf8 = [Text.UTF8Encoding]::new($false)
$script:Failures = [Collections.Generic.List[string]]::new()

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { [void]$script:Failures.Add($Message) }
}

# The harness sends the payload on stdin. The suite sends it base64-encoded on a parameter instead,
# for one reason: a here-string piped into a child powershell.exe on Windows is subject to console
# encoding, and a payload containing a non-ASCII page title would arrive mangled. Both routes land in
# the same Read-HookPayload call one line apart, so what is exercised is the same reader.
function Invoke-Hook([string]$Name, [hashtable]$Payload, [string]$StateDirectory) {
    $json = $Payload | ConvertTo-Json -Compress -Depth 8
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $script = Join-Path $hooks $Name
    (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -StateDirectory $StateDirectory -InputJsonBase64 $encoded 2>&1 | Out-String).Trim()
}

function Get-HookField-FromOutput([string]$Output, [string]$Field) {
    if ([string]::IsNullOrWhiteSpace($Output)) { return $null }
    try {
        $parsed = $Output | ConvertFrom-Json
        $inner = $parsed.hookSpecificOutput
        if ($inner.PSObject.Properties.Name -notcontains $Field) { return $null }
        return [string]$inner.$Field
    }
    catch { return $null }
}

function Test-Denied([string]$Output) { $Output.Contains('"deny"') }

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('library-hooks-' + [guid]::NewGuid().ToString('n'))
try {
    $stateDir = Join-Path $fixture '.claude'
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    New-Item -ItemType Directory -Path (Get-DeskStateDirectory -StateDirectory $stateDir -Seat 'fixture') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'docs') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/demo/wiki') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/other/wiki') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/_archive/demo/wiki') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'shelf/_catalog.md'), "# Local Shelf`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $fixture 'shelf/demo/wiki/_index.md'), "# Demo`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $stateDir '.library-project'), "00000000-0000-0000-0000-000000000000`n", $utf8)
    [IO.File]::WriteAllText((Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'projects'), '', $utf8)
    Copy-Item -LiteralPath (Join-Path $repo 'docs/librarian-operation-playbooks.md') -Destination (Join-Path $fixture 'docs') -Force

    function Set-OpenBooks([string[]]$Roots) {
        $text = if ($Roots.Count) { ($Roots -join "`n") + "`n" } else { '' }
        [IO.File]::WriteAllText((Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books'), $text, $utf8)
    }
    function Invoke-Shell([string]$Command, [string]$ToolName = 'Bash') {
        Invoke-Hook 'Guard-ShellShelfRead.ps1' @{ tool_name = $ToolName; tool_input = @{ command = $Command } } $stateDir
    }

    # === 1. The shell guard: the hole measured on 2026-09-06 ======================================
    Set-OpenBooks @()

    # The exact command that returned 328 bytes from a closed Book while Read of the same path was
    # being denied. If this assertion ever passes trivially, the hook has stopped being registered.
    Assert (Test-Denied (Invoke-Shell 'wc -c shelf/demo/wiki/_index.md')) 'wc -c on a closed Shelf Book was not denied'
    Assert (Test-Denied (Invoke-Shell 'cat shelf/demo/wiki/_index.md')) 'cat on a closed Shelf Book was not denied'
    $denial = Invoke-Shell 'cat shelf/demo/wiki/_index.md'
    $reason = Get-HookField-FromOutput $denial 'permissionDecisionReason'
    Assert ($null -ne $reason -and $reason.Contains('demo')) 'the shell denial did not name the Book it refused'
    Assert ($null -ne $reason -and $reason.Contains('Set-VirtualDesk.ps1')) 'the shell denial did not say how to open the Book'

    # Spelling the workspace root differently must not change the answer; the guard anchors on the
    # shelf/ segment precisely so that it does not have to know how the path was written.
    Assert (Test-Denied (Invoke-Shell "cat $($fixture.Replace('\','/'))/shelf/demo/wiki/_index.md")) 'an absolute path to a closed Shelf Book was not denied'
    Assert (Test-Denied (Invoke-Shell 'type shelf\demo\wiki\_index.md')) 'a backslash path to a closed Shelf Book was not denied'
    Assert (Test-Denied (Invoke-Shell 'cat "shelf/demo/wiki/_index.md"')) 'a quoted path to a closed Shelf Book was not denied'
    Assert (Test-Denied (Invoke-Shell 'grep -rn token shelf/demo/')) 'a grep into a closed Shelf Book was not denied'

    # Breadth. A pattern spanning Books nobody opened is refused as a span, not as one Book.
    foreach ($span in @('ls shelf/*/wiki', 'cat shelf/**/*.md', 'ls shelf/_archive/*')) {
        $out = Invoke-Shell $span
        Assert (Test-Denied $out) "a command spanning the Shelf was not denied: $span"
    }

    # The PowerShell tool carries the same field and must be judged the same way.
    Assert (Test-Denied (Invoke-Shell 'Get-Content shelf/demo/wiki/_index.md' 'PowerShell')) 'the PowerShell tool reached a closed Shelf Book'

    # --- What must still be allowed ---------------------------------------------------------------
    # A bare `shelf/` naming no Book is a search string. Refusing it would make the guard's own
    # source unreadable and would teach the reader that the guard is noise.
    Assert (-not (Test-Denied (Invoke-Shell 'grep -rn "shelf/" docs/'))) 'searching for the literal string shelf/ was denied'
    Assert (-not (Test-Denied (Invoke-Shell 'cat shelf/_catalog.md'))) 'the Shelf catalog browse surface was denied'
    Assert (-not (Test-Denied (Invoke-Shell 'echo hello'))) 'an unrelated command was denied'
    Assert (-not (Test-Denied (Invoke-Shell 'cat notebook/_master-index.md'))) 'a Notebook read was denied'
    Assert (-not (Test-Denied (Invoke-Shell 'cat bookshelf/demo/x.md'))) 'a path merely ending in shelf was treated as the Shelf'
    Assert (-not (Test-Denied (Invoke-Shell 'ls tools/Add-ShelfNote.ps1'))) 'a Shelf helper invocation was denied'

    # --- A path argument, told from a quoted pattern (2026-09-12 report, closed 2026-09-19) --------
    #
    # THE NEGATIVES COME FIRST AND THEY ARE THE ONES THAT MATTER. This block exists to remove
    # friction, and a guard that fails open is far worse than the friction it was relaxed to remove,
    # so every shape that must STILL be refused is pinned before the first relaxation is.
    #
    # `shelf*/` IS THE ONE THAT WAS ACTUALLY OPEN. The scanner required a literal slash after
    # `shelf`, so this walked straight past it while Git Bash expanded the glob back to `shelf/` and
    # printed the page -- the 2026-09-06 hole again, wearing one character. Found on 2026-09-19 while
    # reading the guard for the friction report, which claimed nothing of the sort.
    Assert (Test-Denied (Invoke-Shell 'cat shelf*/demo/wiki/_index.md')) 'a glob the shell expands to shelf/ reached a closed Book'
    Assert (Test-Denied (Invoke-Shell 'wc -c shelf**/demo/wiki/_index.md')) 'a doubled glob reached a closed Book'
    # A DOUBLED BACKSLASH IS STILL ONE SEPARATOR. This is how a Windows path survives a quoted shell
    # string, and reading it as two separators is what reported a single Book as the whole Shelf.
    $doubled = Invoke-Shell 'cat "shelf\\demo\\wiki\\_index.md"'
    Assert (Test-Denied $doubled) 'a doubled-backslash Windows path to a closed Shelf Book was not denied'
    $doubledReason = Get-HookField-FromOutput $doubled 'permissionDecisionReason'
    Assert ($null -ne $doubledReason -and $doubledReason.Contains("'demo'")) 'a doubled-backslash path was not resolved to the Book it names'
    Assert ($null -ne $doubledReason -and -not $doubledReason.Contains('spans')) 'a single Book was still reported as spanning the Shelf'
    # A SCRIPT THAT SPELLS A REAL SHELF PATH IS STILL A MENTION, AND MENTIONS ARE STILL REFUSED.
    # Nothing in a command's text tells `grep -rn "shelf/demo" .` from `grep -rn x shelf/demo`, so
    # this guard does not try; what changed is that the refusal now names the route that is not
    # refused. Relaxing this case is what a later session will be tempted by -- it is the line.
    Assert (Test-Denied (Invoke-Shell "sed -n 's/shelf\/demo/X/p' notes.txt")) 'a sed script spelling a real Shelf path was allowed'
    Assert (Test-Denied (Invoke-Shell 'grep -rn "shelf/demo" docs/')) 'a grep pattern spelling a real Shelf path was allowed'
    # THE ALIASED SPELLINGS STAY CLOSED. `//?/D:/...` and the MSYS `/d/...` form are exactly the
    # shapes that walked past the Read guard on 2026-09-07; this guard never resolved a prefix and
    # still does not, which is why they were never open here and must not become so.
    Assert (Test-Denied (Invoke-Shell 'cat //?/D:/Library/shelf/demo/wiki/_index.md')) 'an aliased absolute spelling reached a closed Book'
    Assert (Test-Denied (Invoke-Shell 'cat /d/Library/shelf/demo/wiki/_index.md')) 'an MSYS absolute spelling reached a closed Book'
    # A FIXTURE SHELF UNDER THE SYSTEM TEMP DIRECTORY IS IN SCOPE, decided 2026-09-19. The assertion
    # at the top of this section already covers it -- $fixture IS under the temp directory -- and this
    # one records that the coverage is a decision rather than an accident, so that a session reading
    # the report's third question finds the answer in the suite. The guard's own header carries why.
    Assert (Test-Denied (Invoke-Shell "sed -i 's|x|y|' $($fixture.Replace('\','/'))/shelf/demo/wiki/_index.md")) 'a fixture Shelf under the temp directory was exempted'

    # --- ...and the relaxation itself -------------------------------------------------------------
    # THE COMMAND FROM THE REPORT, verbatim. Its only path argument is CONTEXT.md; `\*` is a regex
    # escape and was being read as a path separator, which manufactured `Shelf/*/*` out of nothing.
    $reported = "grep -n -A4 '^\*\*Shelf\*\*\|^\*\*Holding Shelf\*\*\|^\*\*Book\*\*\|^\*\*Capture Book\*\*' CONTEXT.md"
    Assert (-not (Test-Denied (Invoke-Shell $reported))) 'the 2026-09-12 grep over CONTEXT.md was still refused'
    Assert (-not (Test-Denied (Invoke-Shell "sed -i 's/\*\*Shelf\*\*/x/' docs/a.md"))) 'a sed script escaping a metacharacter after Shelf was refused'
    Assert (-not (Test-Denied (Invoke-Shell "grep -E '[Ss]helf\|Book' docs/x.md"))) 'an alternation after the word shelf was refused'
    Assert (-not (Test-Denied (Invoke-Shell 'ls shelf*/'))) 'a glob naming no Book was refused'

    # --- The refusal quotes the command, not the token --------------------------------------------
    # THE HALF THAT A CORRECT FIX STILL GETS WRONG. Everything above asserts the VERDICT, and a
    # scanner can reach the right verdict while reporting a path the reader never typed -- which is
    # precisely what the report was about. So the message is asserted in both directions: the
    # characters that were actually in the command are present, and the normalised form is not.
    $typed = Get-HookField-FromOutput (Invoke-Shell 'type shelf\demo\wiki\_index.md') 'permissionDecisionReason'
    Assert ($null -ne $typed -and $typed.Contains('shelf\demo\wiki\_index.md')) 'the refusal did not quote the text the command actually carried'
    Assert ($null -ne $typed -and -not $typed.Contains('shelf/demo/wiki/_index.md')) 'the refusal quoted the normalised token instead of the command'
    $globbed = Get-HookField-FromOutput (Invoke-Shell 'cat shelf*/demo/wiki/_index.md') 'permissionDecisionReason'
    Assert ($null -ne $globbed -and $globbed.Contains('shelf*/demo/wiki/_index.md')) 'the refusal did not quote the glob the command carried'
    # AND IT NAMES THE ROUTE THAT IS NOT REFUSED. A refusal is an instruction surface: told only to
    # open a Book, a reader with a search pattern opens something irrelevant and is refused again.
    Assert ($null -ne $typed -and $typed.Contains('never on its pattern')) 'the refusal did not name the route a search pattern should take'
    $spanReason = Get-HookField-FromOutput (Invoke-Shell 'ls shelf/*/wiki') 'permissionDecisionReason'
    Assert ($null -ne $spanReason -and $spanReason.Contains('never on its pattern')) 'the span refusal did not name the route a search pattern should take'

    # --- Heredoc bodies are data ------------------------------------------------------------------
    # Found by real use within an hour of the guard shipping: it refused a commit message quoting the
    # very incident that motivated it. A quoted delimiter suppresses all expansion, so the body is
    # text the shell hands to a process and never opens.
    $heredocCommit = @"
git commit -F- <<'EOF'
Close the shell route to a closed Book

A session whose Read of shelf/holding/wiki/_index.md was denied ran wc -c on the
same path and got 328 bytes back.
EOF
"@
    Assert (-not (Test-Denied (Invoke-Shell $heredocCommit))) 'a quoted heredoc body naming a closed Book was treated as a read'
    $heredocDouble = @"
cat <<"END"
see shelf/demo/wiki/_index.md
END
"@
    Assert (-not (Test-Denied (Invoke-Shell $heredocDouble))) 'a double-quoted heredoc body was treated as a read'

    # THE EXEMPTION IS NARROW, and these three are what keep it from becoming a hole.
    $unquoted = @"
cat <<EOF
`$(cat shelf/demo/wiki/_index.md)
EOF
"@
    Assert (Test-Denied (Invoke-Shell $unquoted)) 'an UNQUOTED heredoc still expands, so its body must still be judged'
    $redirected = @"
cat <<'EOF' > shelf/demo/wiki/new.md
text
EOF
"@
    Assert (Test-Denied (Invoke-Shell $redirected)) 'a redirection on the heredoc line sits outside the body and must be judged'
    $afterHeredoc = @"
cat <<'EOF'
harmless
EOF
wc -c shelf/demo/wiki/_index.md
"@
    Assert (Test-Denied (Invoke-Shell $afterHeredoc)) 'a command after the heredoc terminator escaped the scan'

    # --- The Desk actually opening something ------------------------------------------------------
    Set-OpenBooks @('shelf/demo')
    Assert (-not (Test-Denied (Invoke-Shell 'cat shelf/demo/wiki/_index.md'))) 'an OPEN Shelf Book was denied to the shell'
    Assert (Test-Denied (Invoke-Shell 'cat shelf/other/wiki/_index.md')) 'opening one Shelf Book opened another'

    # THE SHARP ONE, mirroring the assertion Guard-ShelfBookRead carries for Read. shelf/demo and
    # shelf/_archive/demo are two Books that share a name; opening the archived one must not unlock
    # its active twin, and a guard keyed on the bare slug would.
    Set-OpenBooks @('shelf/_archive/demo')
    Assert (Test-Denied (Invoke-Shell 'cat shelf/demo/wiki/_index.md')) 'opening the ARCHIVED Shelf Book also opened its active twin to the shell'
    Assert (-not (Test-Denied (Invoke-Shell 'cat shelf/_archive/demo/wiki/_index.md'))) 'the open archived Shelf Book was denied to the shell'

    # --- Fail closed ------------------------------------------------------------------------------
    [IO.File]::WriteAllText((Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books'), "Shelf/Demo`n", $utf8)
    Assert (Test-Denied (Invoke-Shell 'cat shelf/demo/wiki/_index.md')) 'malformed Desk state did not fail the shell guard closed'
    Remove-Item -LiteralPath (Get-DeskFilePath -StateDirectory $stateDir -Seat 'fixture' -Kind 'books') -Force
    Assert (Test-Denied (Invoke-Shell 'cat shelf/demo/wiki/_index.md')) 'missing Desk state did not fail the shell guard closed'
    # ...but a command naming no Shelf path is not judged against state it never needed.
    Assert (-not (Test-Denied (Invoke-Shell 'echo hello'))) 'missing Desk state denied a command that named no Book'
    Set-OpenBooks @()

    # === 2. The Read/Grep/Glob guard, after the ShelfBoundary.ps1 refactor =========================
    function Invoke-ReadGuard([string]$ToolName, [hashtable]$ToolInput) {
        Invoke-Hook 'Guard-ShelfBookRead.ps1' @{ tool_name = $ToolName; tool_input = $ToolInput } $stateDir
    }
    Assert (Test-Denied (Invoke-ReadGuard 'Read' @{ file_path = 'shelf/demo/wiki/_index.md' })) 'Read of a closed Shelf Book was not denied'
    Assert (Test-Denied (Invoke-ReadGuard 'Glob' @{ pattern = 'shelf/**/*.md' })) 'a Glob spanning the Shelf was not denied'
    Assert (Test-Denied (Invoke-ReadGuard 'Grep' @{ pattern = 'x'; glob = 'shelf/demo/**' })) 'a Grep glob into a closed Shelf Book was not denied'
    Assert (-not (Test-Denied (Invoke-ReadGuard 'Read' @{ file_path = 'shelf/_catalog.md' }))) 'Read of the Shelf catalog was denied'
    Assert (-not (Test-Denied (Invoke-ReadGuard 'Read' @{ file_path = 'docs/_index.md' }))) 'Read outside the Shelf was denied'
    # WRITE AND EDIT, added to the matcher on 2026-09-06. Reading a closed Book was guarded and
    # writing into one was not, which is the same boundary with a larger blast radius.
    Assert (Test-Denied (Invoke-ReadGuard 'Write' @{ file_path = 'shelf/demo/wiki/new.md'; content = 'x' })) 'a Write into a closed Shelf Book was not denied'
    Assert (Test-Denied (Invoke-ReadGuard 'Edit' @{ file_path = 'shelf/demo/wiki/_index.md' })) 'an Edit of a closed Shelf Book was not denied'
    Set-OpenBooks @('shelf/demo')
    Assert (-not (Test-Denied (Invoke-ReadGuard 'Read' @{ file_path = 'shelf/demo/wiki/_index.md' }))) 'Read of an OPEN Shelf Book was denied'
    Set-OpenBooks @()

    # === 3. Just-in-time playbook injection =======================================================
    . (Join-Path $hooks 'HookContext.ps1')
    $realPlaybook = Join-Path $repo 'docs/librarian-operation-playbooks.md'

    # EVERY ROUTE RESOLVES IN THE TRACKED DOCUMENT. This is the assertion that makes the routing
    # table safe to maintain: reword a heading in the playbook and the gate fails here, rather than
    # the hook silently serving nothing at the moment it was written for.
    $routes = @(
        '## Publish or refresh a shared Book copy',
        '## Import an external workspace wiki to the Shelf',
        '## Archive a Book or Project',
        '## Reset the local Notebook',
        '## Recover from a reset or a retirement',
        '## Edit an open Project Hub page',
        '## Copy local pages into a Project Hub',
        '## Work at a seat',
        '## Repair a derived index',
        '## Capture and triage a Shelf note',
        '### Compile a named raw batch into the Notebook',
        '## Move a Library folder under the cutover protocol',
        '## Mirror the collection into the vault'
    )
    foreach ($heading in $routes) {
        $section = Get-MarkdownSection -Path $realPlaybook -Heading $heading
        Assert (-not [string]::IsNullOrWhiteSpace($section)) "the playbook has no section '$heading'; a route in Get-PlaybookContext.ps1 points at nothing"
    }
    # The routing table itself, read out of the hook rather than retyped here -- a copy of the table
    # in the test would pass while the hook pointed somewhere else entirely.
    $hookText = [IO.File]::ReadAllText((Join-Path $hooks 'Get-PlaybookContext.ps1'))
    foreach ($heading in $routes) {
        Assert ($hookText.Contains("heading = '$heading'")) "Get-PlaybookContext.ps1 does not route to '$heading'"
    }

    # AND BOTH WAYS. The list above is a COPY of the routing table, so until 2026-09-08 a route
    # added to the hook and not to it was asserted by nothing -- the same shape as a spawned suite
    # missing from the -Fast roster, which shipped twice. Derive the hook's own headings and
    # compare, so the copy cannot fall behind the table it stands for.
    $hookHeadings = @([regex]::Matches($hookText, "heading\s*=\s*'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    Assert ($hookHeadings.Count -gt 0) 'no heading route was found in Get-PlaybookContext.ps1; this assertion read nothing rather than proving anything'
    $unlisted = @($hookHeadings | Where-Object { $routes -notcontains $_ })
    Assert ($unlisted.Count -eq 0) "Get-PlaybookContext.ps1 routes to $($unlisted -join ', '), which this suite does not check"

    # THE CUT IS BOUNDED. An end-marker cut in this repository once swallowed four unrelated
    # sections; the archive section must stop before the next ## rather than running to end of file.
    $archiveSection = Get-MarkdownSection -Path $realPlaybook -Heading '## Archive a Book or Project'
    Assert (-not $archiveSection.Contains('## Reset the local Notebook')) 'the archive section cut ran past its own heading into the next one'
    Assert ($archiveSection.Contains('Archive-SharedBook.ps1')) 'the archive section cut lost its own content'
    # A ## section keeps its ### children; a ### section stops at the next ## as well as the next ###.
    $inventory = Get-MarkdownSection -Path $realPlaybook -Heading '## Library inventory and triage'
    Assert ($inventory.Contains('### Compile a named raw batch into the Notebook')) 'a parent section lost its own subsections'
    $compile = Get-MarkdownSection -Path $realPlaybook -Heading '### Compile a named raw batch into the Notebook'
    Assert (-not $compile.Contains('## Publish or refresh')) 'a subsection cut ran into the next top-level section'

    function Invoke-Playbook([string]$Command, [string]$SessionId) {
        Invoke-Hook 'Get-PlaybookContext.ps1' @{ session_id = $SessionId; tool_name = 'PowerShell'; tool_input = @{ command = $Command } } $stateDir
    }
    $archiveCommand = 'powershell.exe -File "tools/Archive-SharedBook.ps1" -BookSlug demo -Preflight'
    $first = Invoke-Playbook $archiveCommand 'session-a'
    $served = Get-HookField-FromOutput $first 'additionalContext'
    Assert ($null -ne $served -and $served.Contains('Archive-SharedBook.ps1')) 'the playbook hook served nothing for an archive preflight'
    Assert ($null -ne $served -and $served.Contains('source_tree_removed')) 'the served section was not the archive playbook'

    # Once per session per section. The second call is silent; a DIFFERENT section in the same
    # session is not.
    $second = Invoke-Playbook $archiveCommand 'session-a'
    Assert ([string]::IsNullOrWhiteSpace($second)) 'the playbook hook served the same section twice in one session'
    $resetOut = Invoke-Playbook 'powershell.exe -File "tools/Reset-LocalNotebook.ps1" -Preflight' 'session-a'
    $resetServed = Get-HookField-FromOutput $resetOut 'additionalContext'
    Assert ($null -ne $resetServed -and $resetServed.Contains('Reset the local Notebook')) 'a second, different section was suppressed by the first'
    # A different session starts clean.
    $otherSession = Invoke-Playbook $archiveCommand 'session-b'
    Assert ($null -ne (Get-HookField-FromOutput $otherSession 'additionalContext')) 'a new session inherited another session''s serve ledger'

    Assert ([string]::IsNullOrWhiteSpace((Invoke-Playbook 'ls -la' 'session-c'))) 'the playbook hook spoke for an unrelated command'
    Assert ([string]::IsNullOrWhiteSpace((Invoke-Playbook 'powershell.exe -File "tools/Add-ShelfNote.ps1" -Title x' 'session-c'))) 'the playbook hook ceremonialised ordinary capture'
    # IT MUST NEVER DECIDE. The helpers own their own approval gates; a second authority over them
    # would be a hook overruling a preflight the reader already understands.
    Assert (-not $first.Contains('permissionDecision')) 'the playbook hook returned a permission decision'

    # === 4. What a compaction actually drops ======================================================
    # The fixture needs the path-scoped rule, because that is what this hook serves. Copied from the
    # real one rather than stubbed: the assertions below are about the tracked rule's actual content,
    # so a stub would keep passing after the rule was reorganised.
    New-Item -ItemType Directory -Path (Join-Path $stateDir 'rules') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo '.claude/rules/library-development.md') -Destination (Join-Path $stateDir 'rules') -Force

    function Invoke-Compacted([hashtable]$Payload) {
        Invoke-Hook 'Restore-CompactedGuidance.ps1' $Payload $stateDir
    }
    # A REAL SessionStart PAYLOAD, PER `source` VALUE. Captured on 2026-09-09 (PLAN-seat-launch.md
    # step 0c) by registering a capture hook through `claude --settings` in a throwaway directory.
    # The extra fields are carried because the real ones carry them: `resume` and `fork` arrive with
    # four the `startup` payload does not, and a fixture that omitted them would not exercise the
    # reader against the shape the harness actually sends. `clear` and `compact` were NOT capturable
    # -- neither is reachable in `--print` mode -- so their names come from the documentation, which
    # is exactly why the source value is read rather than inferred from anything else in the payload.
    function New-SessionStartPayload([string]$Source, [string]$SessionId) {
        $payload = @{
            hook_event_name = 'SessionStart'
            session_id      = $SessionId
            cwd             = $repo
            transcript_path = "$HOME/.claude/projects/D--Library/$SessionId.jsonl"
            source          = $Source
        }
        if ($Source -cin @('resume', 'fork')) {
            $payload['context_tokens'] = 41234
            $payload['estimated_cache_write_usd'] = 0.0217
            $payload['prompt_cache_likely_expired'] = $true
            $payload['seconds_since_last_response'] = 9412
        }
        $payload
    }

    $compacted = Invoke-Compacted @{ hook_event_name = 'PostCompact'; session_id = 'session-a'; compact_reason = 'auto' }
    $message = Get-HookField-FromOutput $compacted 'additionalContext'
    Assert ($null -ne $message -and $message.Contains('A fix without a check is a fix that comes back')) 'PostCompact did not re-serve the standing rules'
    Assert ($null -ne $message -and $message.Contains('library-development.md')) 'the restatement did not name the rule that stopped being loaded'
    # BOUNDED. The rule file is 9.7KB; only its opening section may be served, or the hook becomes
    # the context cost it was written to avoid.
    Assert ($null -ne $message -and -not $message.Contains('## Three standing facts')) 'the standing-rules cut ran into the next section'
    Assert ($null -ne $message -and -not $message.Contains('defect families this codebase keeps producing')) 'the standing-rules cut ran to the end of the rule file'

    # IT MUST NOT RESTATE CLAUDE.md. The project's own rule records that a project-root CLAUDE.md is
    # re-injected after a compaction, so anything this hook says that CLAUDE.md already says is paid
    # for twice out of a workspace that budgets its always-on surface in words.
    $claudeMd = [IO.File]::ReadAllText((Join-Path $repo 'CLAUDE.md'))
    foreach ($phrase in @('A closed Book is unavailable', 'A hit is a location')) {
        Assert ($claudeMd.Contains($phrase)) "CLAUDE.md no longer carries '$phrase'; the post-compact hook's scope was decided on the assumption that it does"
        Assert ($null -eq $message -or -not $message.Contains($phrase)) "the post-compact hook restated '$phrase', which CLAUDE.md re-injects on its own"
    }

    # THE LEDGER IS CLEARED, which is what makes the once-per-session cap in section 3 affordable:
    # a compaction is exactly the event that summarises the first injection away.
    $afterCompact = Invoke-Playbook $archiveCommand 'session-a'
    Assert ($null -ne (Get-HookField-FromOutput $afterCompact 'additionalContext')) 'PostCompact did not clear the serve ledger, so a summarised-away playbook is never re-served'

    # THE FIELD IS `source`, AND READING `startup_reason` MADE THIS HOOK EXIT 0 ON EVERY SESSION
    # START IT HAD EVER SEEN. The old form of these three assertions passed a `startup_reason` the
    # harness never sends, so the hook's early exit was reached for the same reason on all five
    # values -- 'served nothing' was true, and true for the wrong reason, on the two that must serve.
    # Driven per source value, so a hook that goes blind on ONE of them fails at that value's own
    # line rather than being covered by a neighbour that happens to want the same answer.
    foreach ($quiet in @('startup', 'clear', 'fork')) {
        $out = Invoke-Compacted (New-SessionStartPayload $quiet 'session-d')
        Assert ([string]::IsNullOrWhiteSpace($out)) "a '$quiet' SessionStart was served guidance it had just loaded in full"
    }
    foreach ($lossy in @('compact', 'resume')) {
        $out = Invoke-Compacted (New-SessionStartPayload $lossy 'session-d')
        $served = Get-HookField-FromOutput $out 'additionalContext'
        Assert ($null -ne $served -and $served.Contains('A fix without a check is a fix that comes back')) "a '$lossy' SessionStart was served nothing"
        # THE SHAPE, ASSERTED SEPARATELY FROM THE CONTENT. `systemMessage` was measured NOT reaching
        # the model, so a revert to it would leave every assertion above about content passing while
        # nothing arrived. This is the assertion that has no neighbour able to reach its result.
        Assert ($null -eq (Get-HookField-FromOutput $out 'systemMessage')) "a '$lossy' SessionStart emitted systemMessage, which does not reach the model"
    }
    Assert ($null -eq (Get-HookField-FromOutput $compacted 'systemMessage')) 'PostCompact emitted systemMessage, which SessionStart measured as not reaching the model'

    # THE LEDGER IS CLEARED ON EVERY SOURCE VALUE, INCLUDING THE ONES SERVED NOTHING. A `clear` may
    # keep its session id -- 0c could not capture that event -- and if it does, a ledger left in
    # place withholds every playbook from a context that has just been thrown away. Each value gets
    # its own session id so one value's clear cannot be mistaken for another's.
    foreach ($source in @('startup', 'clear', 'fork', 'compact', 'resume')) {
        $ledgerSession = "session-clear-$source"
        Invoke-Playbook $archiveCommand $ledgerSession | Out-Null
        Assert (Test-HookServed $stateDir $ledgerSession 'playbook:archive') "the fixture did not record a served playbook to clear for '$source'"
        Invoke-Compacted (New-SessionStartPayload $source $ledgerSession) | Out-Null
        Assert (-not (Test-HookServed $stateDir $ledgerSession 'playbook:archive')) "a '$source' SessionStart left the serve ledger in place"
    }

    # THE LEDGER CLEAR MUST NOT DEPEND ON THE RULE FILE. It is this hook's contract with
    # Get-PlaybookContext.ps1, and a checkout without the rule must still get its playbooks back.
    Invoke-Playbook $archiveCommand 'session-e' | Out-Null
    Assert (Test-HookServed $stateDir 'session-e' 'playbook:archive') 'the fixture did not record a served playbook to clear'
    Remove-Item -LiteralPath (Join-Path $stateDir 'rules/library-development.md') -Force
    Invoke-Compacted @{ hook_event_name = 'PostCompact'; session_id = 'session-e'; compact_reason = 'manual' } | Out-Null
    Assert (-not (Test-HookServed $stateDir 'session-e' 'playbook:archive')) 'a missing rule file cost the session its serve-ledger clear'
    Copy-Item -LiteralPath (Join-Path $repo '.claude/rules/library-development.md') -Destination (Join-Path $stateDir 'rules') -Force

    # === 4b. AN EMPTY PAYLOAD IS A FIRST-CLASS INPUT ==============================================
    #
    # `{}` IS WHAT THE CODEX PORTABILITY SUITE SENDS, and until 2026-09-10 every hook that read a
    # field out of a payload threw on it: Get-HookField read the AGGREGATE `.PSObject.Properties`
    # `.Name`, which under Set-StrictMode throws on an empty collection instead of yielding nothing.
    # Defect family 4, in the one helper written to make a missing field safe, and no lint covers it.
    # It stayed invisible because every payload any suite sent had at least one field.
    #
    # DRIVEN AT EVERY HOOK THAT PARSES A PAYLOAD, not at one standing for the rest: the fault was in
    # shared plumbing, so a single subject would have proved the plumbing works for that subject.
    foreach ($subject in @('Restore-CompactedGuidance.ps1', 'Get-VirtualDeskContext.ps1', 'Get-SeatStartContext.ps1', 'Get-PlaybookContext.ps1')) {
        $empty = Invoke-Hook $subject @{} $stateDir
        Assert (-not $empty.Contains('cannot be found on this object')) "$subject threw on an empty payload: $empty"
        Assert (-not $empty.Contains('state is invalid')) "$subject failed closed on an empty payload rather than reading no fields from it: $empty"
    }

    # === 5. A settings edit cannot disable the guards =============================================
    . (Join-Path $repo 'tools/HookRegistry.ps1')
    $liveSettings = Join-Path $repo '.claude/settings.json'
    $liveTree = [IO.File]::ReadAllText($liveSettings) | ConvertFrom-Json

    # THE ONE ASSERTION THAT IS ABOUT THIS CHECKOUT rather than about a fixture. Everything else here
    # proves the hooks work; this proves they are switched on.
    $liveProblems = @(Get-HookRegistrationProblems -Settings @($liveTree))
    Assert (-not $liveProblems.Count) "the live .claude/settings.json does not register every Library hook: $(($liveProblems | ForEach-Object { $_.detail }) -join '; ')"

    # `source`, MEASURED, NOT `config_source`, WHICH THIS FIXTURE INVENTED. From 2026-09-06 to
    # 2026-09-19 this line spelled the field `config_source`, the hook read `config_source`, and
    # every denial below passed -- while the real payload carried `source` and the guard exited 0 on
    # every settings edit in every session. Two copies of one guess agreeing is not a measurement.
    # Section 12 drives this same guard with the captured envelope; this is the composed fixture
    # brought into line with it, and the pair is deliberate: this one varies the source value cheaply,
    # that one proves the name arrives.
    function Invoke-SettingsGuard([string]$Source) {
        Invoke-Hook 'Guard-SettingsIntegrity.ps1' @{ hook_event_name = 'ConfigChange'; source = $Source } $stateDir
    }
    $fixtureSettings = Join-Path $stateDir 'settings.json'
    Copy-Item -LiteralPath $liveSettings -Destination $fixtureSettings -Force
    Assert (-not (Test-Denied (Invoke-SettingsGuard 'project_settings'))) 'a valid settings file was refused'
    Assert ([string]::IsNullOrWhiteSpace((Invoke-SettingsGuard 'user_settings'))) 'the guard judged a settings source it cannot block'
    # THE OLD SPELLING MUST NOW BE IGNORED. A guard that accepted both names would pass every
    # assertion here while still being wrong about which one the client sends.
    $strippedForOldName = [IO.File]::ReadAllText($liveSettings).Replace('Guard-ShelfBookRead.ps1', 'Guard-Disabled.ps1')
    [IO.File]::WriteAllText($fixtureSettings, $strippedForOldName, $utf8)
    Assert ([string]::IsNullOrWhiteSpace((Invoke-Hook 'Guard-SettingsIntegrity.ps1' @{ hook_event_name = 'ConfigChange'; config_source = 'project_settings' } $stateDir))) 'the settings guard still answers to config_source, a field no captured payload carries'
    Copy-Item -LiteralPath $liveSettings -Destination $fixtureSettings -Force

    # A load-bearing guard removed entirely.
    $stripped = [IO.File]::ReadAllText($liveSettings).Replace('Guard-ShelfBookRead.ps1', 'Guard-Disabled.ps1')
    [IO.File]::WriteAllText($fixtureSettings, $stripped, $utf8)
    $out = Invoke-SettingsGuard 'project_settings'
    Assert (Test-Denied $out) 'removing a load-bearing guard from settings was allowed'
    Assert ((Get-HookField-FromOutput $out 'permissionDecisionReason') -match 'Guard-ShelfBookRead') 'the refusal did not name the guard that went missing'

    # A load-bearing guard still NAMED, but moved to an event where it cannot act. This is the case a
    # substring search passes and the boundary does not survive.
    $moved = [IO.File]::ReadAllText($liveSettings) | ConvertFrom-Json
    $shelfBlock = @($moved.hooks.PreToolUse | Where-Object { (Get-HookEntryText $_.hooks[0]) -match 'Guard-ShelfBookRead' })
    Assert ($shelfBlock.Count -eq 1) 'the fixture could not find the Shelf guard registration to move'
    if ($shelfBlock.Count -eq 1) {
        $moved.hooks.PreToolUse = @($moved.hooks.PreToolUse | Where-Object { (Get-HookEntryText $_.hooks[0]) -notmatch 'Guard-ShelfBookRead' })
        $moved.hooks.PostToolUse = @(@($moved.hooks.PostToolUse) + $shelfBlock)
        [IO.File]::WriteAllText($fixtureSettings, ($moved | ConvertTo-Json -Depth 12), $utf8)
        $out = Invoke-SettingsGuard 'project_settings'
        Assert (Test-Denied $out) 'a guard moved to an event it cannot act on was allowed'
        Assert ((Get-HookField-FromOutput $out 'permissionDecisionReason') -match 'PreToolUse') 'the refusal did not name the event the guard belongs on'
    }

    # Unparseable.
    [IO.File]::WriteAllText($fixtureSettings, "{ this is not json", $utf8)
    Assert (Test-Denied (Invoke-SettingsGuard 'project_settings')) 'an unparseable settings file was accepted'

    # An OPTIONAL hook dropped: allowed, and said out loud rather than silently.
    $withoutOptional = [IO.File]::ReadAllText($liveSettings).Replace('Add-SearchHitReminder.ps1', 'Add-Removed.ps1')
    [IO.File]::WriteAllText($fixtureSettings, $withoutOptional, $utf8)
    $out = Invoke-SettingsGuard 'project_settings'
    Assert (-not (Test-Denied $out)) 'dropping an optional guidance hook was refused'
    Assert ((Get-HookField-FromOutput $out 'systemMessage') -match 'Add-SearchHitReminder') 'an optional hook disappeared without a word'
    Remove-Item -LiteralPath $fixtureSettings -Force

    # === 6. A hit is a location ===================================================================
    function Invoke-Reminder([string]$ToolName, [hashtable]$ToolInput) {
        Invoke-Hook 'Add-SearchHitReminder.ps1' @{ hook_event_name = 'PostToolUse'; tool_name = $ToolName; tool_input = $ToolInput; tool_output = 'x' } $stateDir
    }
    foreach ($tool in @('mcp__validated-book-reader__discover_book_pages', 'mcp__validated-book-reader__search_open_books')) {
        $context = Get-HookField-FromOutput (Invoke-Reminder $tool @{ query = 'x' }) 'additionalContext'
        Assert ($null -ne $context -and $context.Contains('A hit is a location')) "$tool returned results with no reminder"
    }
    $rawContext = Get-HookField-FromOutput (Invoke-Reminder 'PowerShell' @{ command = 'powershell.exe -File "tools/Search-RawBatch.ps1" -Term x' }) 'additionalContext'
    Assert ($null -ne $rawContext -and $rawContext.Contains('A hit is a location')) 'a raw batch search returned results with no reminder'
    Assert ($null -ne $rawContext -and $rawContext.Contains('not a finding of absence')) 'the reminder dropped the half about an empty result'
    Assert ([string]::IsNullOrWhiteSpace((Invoke-Reminder 'Bash' @{ command = 'ls -la' }))) 'the reminder fired on a command that searched nothing'
    Assert ([string]::IsNullOrWhiteSpace((Invoke-Reminder 'mcp__validated-book-reader__read_open_book_page' @{ page = 'x' }))) 'the reminder fired on an actual page read'

    # === 7. The serve ledger itself ===============================================================
    $ledgerPath = Join-Path $stateDir '.hook-served.json'
    Assert (Test-Path -LiteralPath $ledgerPath -PathType Leaf) 'the serve ledger was never written'
    Assert (-not (Test-HookServed $stateDir 'session-zzz' 'playbook:archive')) 'an unknown session reported a served key'
    # TWO KEYS, NOT ONE, and that is the whole point of this block. Set-HookServed assigned
    # $existing from an `if` STATEMENT, which unrolls a one-element array to a bare string, so
    # the second key was concatenated onto the first and neither could be found again. ONE key
    # round-trips perfectly under that defect, so no single-key assertion could ever have caught
    # it -- only a second key can. Assert the stored entry's Count too: two keys that both report
    # served would still pass if they were stored as one concatenated string.
    Set-HookServed $stateDir 'session-two-keys' 'playbook:alpha'
    Set-HookServed $stateDir 'session-two-keys' 'playbook:beta'
    Assert (Test-HookServed $stateDir 'session-two-keys' 'playbook:alpha') 'the first of two served keys was lost'
    Assert (Test-HookServed $stateDir 'session-two-keys' 'playbook:beta') 'the second of two served keys was lost'
    Assert (@((Read-HookLedger $stateDir)['session-two-keys']).Count -eq 2) 'two served keys were stored as one entry, so they were concatenated rather than listed'
    # A ledger that cannot be parsed reports "not served", so guidance repeats rather than vanishing.
    [IO.File]::WriteAllText($ledgerPath, 'not json at all', $utf8)
    Assert (-not (Test-HookServed $stateDir 'session-a' 'playbook:archive')) 'a corrupt ledger was read as authoritative'
    $recovered = Invoke-Playbook $archiveCommand 'session-a'
    Assert ($null -ne (Get-HookField-FromOutput $recovered 'additionalContext')) 'a corrupt ledger silenced the playbook hook instead of repeating it'

    # === 8. Two clients, two payload shapes =======================================================
    # Claude Code's Bash tool sends `command` as a string. Codex's shell tool is `exec` and its
    # transcript renders the call as an argv list, so an array is the likely shape -- unconfirmed,
    # because Codex hash-pins hook trust and an untrusted hook never fires to reveal what it is sent.
    # The guard must therefore be correct for both, and for a shape nobody has seen.
    Set-OpenBooks @()
    Assert ((Get-HookCommandText ([pscustomobject]@{ command = 'wc -c x' })) -ceq 'wc -c x') 'a string command was not read back intact'
    Assert ((Get-HookCommandText ([pscustomobject]@{ command = @('powershell.exe', '-Command', 'echo x') })) -ceq 'powershell.exe -Command echo x') 'an argv array did not join into one command string'
    Assert ((Get-HookCommandText ([pscustomobject]@{ action = [pscustomobject]@{ command = @('cat', 'x') } })) -ceq 'cat x') 'a nested action.command was not read'
    # A shape with no recognised command field falls back to the serialised input, so a Shelf path in
    # an unknown field is still judged rather than waved through.
    $unknown = Get-HookCommandText ([pscustomobject]@{ mystery_field = 'shelf/demo/wiki/_index.md' })
    Assert ($unknown -match 'shelf/demo') 'an unrecognised payload shape hid its arguments from the guard'
    Assert ([string]::IsNullOrWhiteSpace((Get-HookCommandText $null))) 'a null tool input did not read as empty'

    # THE GUARD ITSELF, against a Codex-shaped payload.
    $argvDenial = Invoke-Hook 'Guard-ShellShelfRead.ps1' @{ tool_name = 'exec'; tool_input = @{ command = @('powershell.exe', '-Command', 'Get-Content shelf/demo/wiki/_index.md') } } $stateDir
    Assert (Test-Denied $argvDenial) 'an argv-array shell payload reached a closed Shelf Book'
    $argvAllowed = Invoke-Hook 'Guard-ShellShelfRead.ps1' @{ tool_name = 'exec'; tool_input = @{ command = @('echo', 'hello') } } $stateDir
    Assert (-not (Test-Denied $argvAllowed)) 'an unrelated argv-array command was denied'

    # === 9. The Codex hooks file's shape ==========================================================
    # Codex accepts only `description` and `hooks` at the root of this file. The Library wrote the
    # events at the root until 2026-09-06, so every Codex session began with
    #   warning: failed to parse hooks config ...: unknown field `PreToolUse`
    # and registered nothing. It was valid JSON, it named the right scripts, and two checks passed on
    # it. Verified against codex 0.147.0 by driving both shapes through a real `codex exec` run.
    foreach ($codexFile in @('.codex/hooks.template.json', '.codex/hooks.json')) {
        $path = Join-Path $repo $codexFile
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            # hooks.json is generated and untracked, so a fresh checkout legitimately lacks it.
            if ($codexFile -ceq '.codex/hooks.json') { continue }
            Assert $false "$codexFile is missing"
            continue
        }
        $tree = [IO.File]::ReadAllText($path) | ConvertFrom-Json
        $roots = @($tree.PSObject.Properties | ForEach-Object { $_.Name })
        $strayRoots = @($roots | Where-Object { $_ -cnotin @('description', 'hooks') })
        Assert (-not $strayRoots.Count) "$codexFile puts $($strayRoots -join ', ') at the root; Codex rejects the whole file"
        Assert ($roots -ccontains 'hooks') "$codexFile has no top-level 'hooks' key, so Codex registers nothing"

        # THE MATCHER MUST NAME 'Bash'. Codex normalises its shell tool to the Claude Code name for
        # hooks: a payload captured from a real `codex exec` run carries tool_name 'Bash', and
        # 'exec' -- the obvious guess, and what this file shipped with for one commit -- survives
        # only inside tool_use_id. A matcher of '^exec$' matches nothing, silently.
        # The template carries __SHELL_GUARD_COMMAND__ where the generated file carries the rendered
        # path, so both spellings count as "this is the shell guard's block".
        $shellMatchers = @($tree.hooks.PreToolUse | Where-Object {
            @($_.hooks | Where-Object { (Get-HookEntryText $_) -match 'Guard-ShellShelfRead\.ps1|__SHELL_GUARD_COMMAND__' }).Count
        } | ForEach-Object { [string]$_.matcher })
        Assert ($shellMatchers.Count -eq 1) "$codexFile does not register the shell guard exactly once"
        Assert (@($shellMatchers | Where-Object { $_ -cmatch '(^|\||\()Bash($|\||\))' }).Count -eq 1) "$codexFile's shell matcher does not name Bash, so it can never fire"
    }

    # === 10. The verified Codex payload ===========================================================
    # Captured verbatim from a `codex exec` PreToolUse hook on 2026-09-06, extra fields and all. The
    # guard is fed the real thing rather than a hand-written approximation, because the approximation
    # is exactly what was wrong: an argv array was assumed, and `command` is a string.
    Set-OpenBooks @()
    $codexPayload = @{
        session_id      = '01a07a77-16d2-7e92-bde7-fffc67354e3c'
        turn_id         = '01a07a77-175d-7660-ab3e-345adfac6c2b'
        transcript_path = 'C:\fixture\codex-runtime-home\home\sessions\rollout.jsonl'
        cwd             = 'D:\Library'
        hook_event_name = 'PreToolUse'
        model           = 'gpt-5.6-sol'
        permission_mode = 'bypassPermissions'
        tool_name       = 'Bash'
        tool_input      = @{ command = 'wc -c shelf/demo/wiki/_index.md' }
        tool_use_id     = 'exec-b3011bf6-8268-49a7-bce9-c20730384873'
    }
    $codexDenial = Invoke-Hook 'Guard-ShellShelfRead.ps1' $codexPayload $stateDir
    Assert (Test-Denied $codexDenial) 'the real Codex PreToolUse payload was not judged; a shell command reached a closed Shelf Book'
    $codexReason = Get-HookField-FromOutput $codexDenial 'permissionDecisionReason'
    Assert ($null -ne $codexReason -and $codexReason.Contains('demo')) 'the Codex denial did not name the Book it refused'
    # Codex surfaces permissionDecisionReason verbatim to the model, so the deny must carry the
    # recovery step: "Command blocked by PreToolUse hook: <reason>" is all the session is told.
    Assert ($null -ne $codexReason -and $codexReason.Contains('Set-VirtualDesk.ps1')) 'the Codex denial did not tell the session how to open the Book'
    # The same payload with the Book open must pass, so the guard is not simply denying everything
    # that arrives in an unfamiliar shape.
    Set-OpenBooks @('shelf/demo')
    Assert (-not (Test-Denied (Invoke-Hook 'Guard-ShellShelfRead.ps1' $codexPayload $stateDir))) 'the real Codex payload was denied for an OPEN Shelf Book'
    Set-OpenBooks @()

    # === 11. The serve ledger AT ITS CAP ==========================================================
    #
    # THE CAP IS TWENTY SESSIONS AND EVERY ASSERTION ABOVE RUNS UNDER TEN, so until 2026-09-19
    # nothing in this suite had ever reached the branch that trims it -- and that branch was wrong.
    # It read `@($table.Keys)[-20..-1]` off a plain [hashtable] and called it insertion order; it is
    # bucket order, and a newly added key comes out FIRST, so "keep the last twenty" kept the twenty
    # oldest and evicted the session that had just served. The live ledger sat at exactly twenty
    # entries for weeks, recording nothing: every playbook section re-injected on every matching tool
    # call, for the life of every session, and nothing for PostCompact's clear to remove. It looked
    # exactly like a blank session id from the outside, which is how two reports read it.
    #
    # TWENTY-ONE SESSIONS, NOT TWO. Under the cap the trim never runs, and a fixture under the cap
    # is what let this ship.
    $capDir = Join-Path $fixture 'cap'
    New-Item -ItemType Directory -Path $capDir -Force | Out-Null
    for ($i = 1; $i -le 20; $i++) { Set-HookServed $capDir ('cap-session-{0:d2}' -f $i) 'playbook:archive' }
    Assert ((Read-HookLedger $capDir).Count -eq 20) 'the cap fixture did not reach twenty sessions, so it never exercises the trim'
    Set-HookServed $capDir 'cap-session-21' 'playbook:cutover'
    $capLedger = Read-HookLedger $capDir
    Assert ($capLedger.Count -eq 20) "the ledger holds $($capLedger.Count) sessions after the twenty-first, not 20"
    Assert (Test-HookServed $capDir 'cap-session-21' 'playbook:cutover') 'the cap evicted the session that had just served, which is the 2026-09-19 defect'
    Assert (-not (Test-HookServed $capDir 'cap-session-01' 'playbook:archive')) 'the cap evicted something other than the oldest session'
    Assert (Test-HookServed $capDir 'cap-session-20' 'playbook:archive') 'the cap evicted a session that was inside it'
    # AND THE FILE ORDER IS THE EVICTION ORDER. Asserted separately from the membership above,
    # because a trim that kept the right twenty in the wrong order would evict the wrong one next
    # time and every assertion above would still pass.
    $capKeys = @($capLedger.Keys)
    Assert ($capKeys[0] -ceq 'cap-session-02') "the oldest surviving session is '$($capKeys[0])', not cap-session-02; the ledger's order is not its age"
    Assert ($capKeys[-1] -ceq 'cap-session-21') "the newest session is '$($capKeys[-1])', not cap-session-21"

    # THE HOOK ITSELF, AT THE CAP. Everything above is about the ledger; this is about the reader,
    # and it is the assertion the live defect would have failed.
    for ($i = 1; $i -le 20; $i++) { Set-HookServed $stateDir ('fill-{0:d2}' -f $i) 'playbook:archive' }
    $atCap = Invoke-Playbook $archiveCommand 'session-at-cap'
    Assert ($null -ne (Get-HookField-FromOutput $atCap 'additionalContext')) 'the playbook hook served nothing on a first call with the ledger at its cap'
    Assert ([string]::IsNullOrWhiteSpace((Invoke-Playbook $archiveCommand 'session-at-cap'))) 'with the ledger at its cap the playbook hook re-served the same section into one session'

    # === 12. A CAPTURED payload, not a composed one ===============================================
    #
    # Section 3 supplies `session_id` itself and section 5 supplied `config_source` itself, and both
    # passed for weeks. A fixture that invents its own input can only prove the hook works when it is
    # GIVEN a field; nothing in it asserts the field ARRIVES, and twice now it has not. These drive
    # the hooks with the envelope in .claude/hooks/payload-contract.json, captured from this client,
    # with only the two values a fixture must control replaced.
    $contract = [IO.File]::ReadAllText((Join-Path $repo '.claude/hooks/payload-contract.json')) | ConvertFrom-Json
    function ConvertTo-HookTable($Object) {
        $table = @{}
        foreach ($property in @($Object.PSObject.Properties)) {
            $value = $property.Value
            if ($null -ne $value -and $value.GetType().Name -ceq 'PSCustomObject') {
                $table[$property.Name] = (ConvertTo-HookTable $value)
            }
            else { $table[$property.Name] = $value }
        }
        $table
    }
    function Get-CapturedEnvelope([string]$EventName) {
        $events = @($contract.events.PSObject.Properties | ForEach-Object { $_.Name })
        if ($events -cnotcontains $EventName) { return $null }
        $entry = $contract.events.$EventName
        if (@($entry.PSObject.Properties | ForEach-Object { $_.Name }) -cnotcontains 'envelope') { return $null }
        ConvertTo-HookTable $entry.envelope
    }

    $preToolUse = Get-CapturedEnvelope 'PreToolUse'
    Assert ($null -ne $preToolUse) 'payload-contract.json carries no captured PreToolUse envelope, so nothing here is driven by a real payload'
    if ($null -ne $preToolUse) {
        Assert (@($preToolUse.Keys) -ccontains 'session_id') 'the captured PreToolUse payload carries no session_id, so the serve ledger cannot work at all'
        $preToolUse['session_id'] = 'captured-session-1'
        $preToolUse['tool_input'] = @{ command = $archiveCommand; description = 'payload probe' }
        $capturedFirst = Invoke-Hook 'Get-PlaybookContext.ps1' $preToolUse $stateDir
        Assert ($null -ne (Get-HookField-FromOutput $capturedFirst 'additionalContext')) 'the playbook hook served nothing for a CAPTURED PreToolUse payload'
        # THE ASSERTION A COMPOSED FIXTURE CANNOT MAKE. The id in the captured envelope reached the
        # ledger under the name the hook reads, so the second serving is silent.
        Assert (Test-HookServed $stateDir 'captured-session-1' 'playbook:archive') 'a CAPTURED payload never reached the serve ledger; the session id is not arriving under the name the hook reads'
        Assert ([string]::IsNullOrWhiteSpace((Invoke-Hook 'Get-PlaybookContext.ps1' $preToolUse $stateDir))) 'a CAPTURED payload re-served the same section into one session'
    }

    # THE SETTINGS GUARD, WHICH IS THE ONE THIS CAUGHT. It read `config_source` from 2026-09-06 to
    # 2026-09-19 and the payload carries `source`, so it exited 0 on every real settings edit while
    # section 5 above asserted all four of its denials correctly against a payload section 5 wrote.
    $configChange = Get-CapturedEnvelope 'ConfigChange'
    Assert ($null -ne $configChange) 'payload-contract.json carries no captured ConfigChange envelope'
    if ($null -ne $configChange) {
        Assert (@($configChange.Keys) -cnotcontains 'config_source') 'the captured ConfigChange payload carries config_source after all; re-derive the 2026-09-19 fix before trusting this'
        Assert (@($configChange.Keys) -ccontains 'source') 'the captured ConfigChange payload carries no source field'
        $stripped = [IO.File]::ReadAllText($liveSettings).Replace('Guard-ShelfBookRead.ps1', 'Guard-Disabled.ps1')
        [IO.File]::WriteAllText($fixtureSettings, $stripped, $utf8)
        $configChange['source'] = 'project_settings'
        $capturedDenial = Invoke-Hook 'Guard-SettingsIntegrity.ps1' $configChange $stateDir
        Assert (Test-Denied $capturedDenial) 'a CAPTURED ConfigChange payload did not reach the settings guard, so a real edit removing a load-bearing guard is allowed'
        # AND IT STILL ALLOWS A VALID ONE. A guard that denied every captured payload would pass the
        # assertion above while refusing every settings edit the reader makes.
        Copy-Item -LiteralPath $liveSettings -Destination $fixtureSettings -Force
        Assert (-not (Test-Denied (Invoke-Hook 'Guard-SettingsIntegrity.ps1' $configChange $stateDir))) 'a CAPTURED ConfigChange payload for valid settings was refused'
        Remove-Item -LiteralPath $fixtureSettings -Force
    }

    # THE CONTRACT AND THE SessionStart FIXTURE ARE TWO COPIES OF ONE MEASUREMENT, so they are
    # compared rather than trusted. New-SessionStartPayload is the surviving record of the 2026-09-09
    # capture; the contract quotes it, and a list standing for a table is checked BOTH WAYS.
    $fixtureFields = @((New-SessionStartPayload 'resume' 'session-x').Keys)
    $contractSessionStart = @($contract.events.SessionStart.fields)
    $missingFromContract = @($fixtureFields | Where-Object { $contractSessionStart -cnotcontains $_ })
    Assert (-not $missingFromContract.Count) "payload-contract.json's SessionStart entry omits $($missingFromContract -join ', '), which this suite's captured fixture sends"
    $missingFromFixture = @($contractSessionStart | Where-Object { $fixtureFields -cnotcontains $_ })
    Assert (-not $missingFromFixture.Count) "New-SessionStartPayload no longer sends $($missingFromFixture -join ', '), which payload-contract.json records as captured"

    # === 13. The payload contract's own detector, both directions =================================
    #
    # `hooks.payload-fields-are-captured` runs against the real tree, where a green result proves
    # only that nothing is wrong today. These are its fixture cases: the two field names that have
    # actually gone wrong here, the safe forms that must NOT be flagged, the exemption in both its
    # live and its stale state, and the detector emptied so its positives can be watched going green.
    $contractFixture = Join-Path $fixture 'contract-hooks'
    New-Item -ItemType Directory -Path $contractFixture -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $contractFixture 'Good-Hook.ps1'), '$x = [string](Get-HookField $call ''session_id'')', $utf8)
    [IO.File]::WriteAllText((Join-Path $contractFixture 'Stale-Hook.ps1'), '$x = [string](Get-HookField $call ''startup_reason'')', $utf8)
    [IO.File]::WriteAllText((Join-Path $contractFixture 'Config-Hook.ps1'), '$x = [string](Get-HookField $call ''config_source'')', $utf8)
    [IO.File]::WriteAllText((Join-Path $contractFixture 'Quiet-Hook.ps1'), '$x = 1', $utf8)
    # A member read reaches the payload too, and breaks the same way when a field moves.
    [IO.File]::WriteAllText((Join-Path $contractFixture 'Member-Hook.ps1'), '$x = [string]$call.tool_name; $y = @($call.PSObject.Properties)', $utf8)

    $fixtureContract = @'
{
  "events": {
    "SessionStart": { "captured": "fixture", "fields": ["hook_event_name", "session_id", "source"] },
    "ConfigChange": { "captured": "fixture", "fields": ["hook_event_name", "session_id", "source", "file_path"] },
    "PreToolUse":   { "captured": "fixture", "fields": ["hook_event_name", "session_id", "tool_name", "tool_input"] }
  },
  "unverified_reads": []
}
'@ | ConvertFrom-Json
    $fixtureShape = Get-PayloadContractShape $fixtureContract
    Assert (@($fixtureShape.captured).Count -eq 3) 'the fixture contract did not read back three captured events'

    # @() AT EVERY CALL SITE BELOW. This returns a collection that is empty whenever the contract is
    # correct, and an empty collection unrolls to $null on the way out of a function -- defect
    # family 2, production side, which took this suite's first run.
    function Get-FixtureProblems([string]$File, [string[]]$Events, $UseContract) {
        $reads = @(Get-HookPayloadReads $contractFixture @(@{ file = $File; events = $Events }))
        @(Get-PayloadContractProblems $UseContract (Get-PayloadContractShape $UseContract) $reads)
    }

    # THE SAFE FORMS, FIRST. A check that flags correct code gets suppressed, so these are the
    # assertions that keep it usable.
    Assert (@(Get-FixtureProblems 'Good-Hook.ps1' @('SessionStart') $fixtureContract).Count -eq 0) 'a read of a field the captured event carries was flagged'
    Assert (@(Get-FixtureProblems 'Member-Hook.ps1' @('PreToolUse') $fixtureContract).Count -eq 0) 'a direct $call.tool_name read of a captured field was flagged, or PSObject was counted as a payload field'
    # A field carried by ONE of the events a hook is registered on is verified; Restore-CompactedGuidance
    # reads `source` and is registered on PostCompact as well as SessionStart, and that is correct.
    Assert (@(Get-FixtureProblems 'Good-Hook.ps1' @('PreToolUse', 'SessionStart') $fixtureContract).Count -eq 0) 'a field carried by one of two registered events was flagged'

    # THE TWO NAMES THAT HAVE ACTUALLY GONE WRONG IN THIS TREE.
    $staleProblems = @(Get-FixtureProblems 'Stale-Hook.ps1' @('SessionStart') $fixtureContract)
    Assert ($staleProblems.Count -eq 1) "the startup_reason read produced $($staleProblems.Count) problems, not 1"
    Assert ($staleProblems.Count -eq 1 -and $staleProblems[0] -match 'startup_reason') 'the problem did not name the field that is not on the payload'
    $configProblems = @(Get-FixtureProblems 'Config-Hook.ps1' @('ConfigChange') $fixtureContract)
    Assert ($configProblems.Count -eq 1) "the config_source read produced $($configProblems.Count) problems, not 1"

    # THE EXEMPTION, IN BOTH STATES. Live: the read is declared and no problem is reported. Stale:
    # the same declaration against a read that now verifies is itself the problem, because an
    # exemption nobody re-derives is how both historical instances stayed invisible.
    $exemptedContract = @'
{
  "events": {
    "SessionStart": { "captured": "fixture", "fields": ["hook_event_name", "session_id", "source"] }
  },
  "unverified_reads": [
    { "hook": "Stale-Hook.ps1", "field": "startup_reason", "reason": "fixture" }
  ]
}
'@ | ConvertFrom-Json
    Assert (@(Get-FixtureProblems 'Stale-Hook.ps1' @('SessionStart') $exemptedContract).Count -eq 0) 'a declared unverified read was still reported'
    $staleExemption = @(Get-FixtureProblems 'Good-Hook.ps1' @('SessionStart') $exemptedContract)
    Assert ($staleExemption.Count -eq 1) "an exemption for a read nobody makes produced $($staleExemption.Count) problems, not 1"
    Assert ($staleExemption.Count -eq 1 -and $staleExemption[0] -match 'no longer needs it') 'the stale-exemption problem did not say what was wrong with it'

    # AN EXEMPTION WITHOUT A REASON IS NOT AN EXEMPTION.
    $reasonless = @'
{
  "events": { "SessionStart": { "captured": "fixture", "fields": ["session_id"] } },
  "unverified_reads": [ { "hook": "Stale-Hook.ps1", "field": "startup_reason" } ]
}
'@ | ConvertFrom-Json
    $threw = $false
    try { Get-FixtureProblems 'Stale-Hook.ps1' @('SessionStart') $reasonless | Out-Null } catch { $threw = $true }
    Assert $threw 'an unverified_reads entry with no reason was accepted'

    # AN EVENT WITH NO PROVENANCE PROVES NOTHING, and must say so rather than verify against itself.
    $noProvenance = '{ "events": { "SessionStart": { "fields": ["session_id"] } } }' | ConvertFrom-Json
    $threw = $false
    try { Get-PayloadContractShape $noProvenance | Out-Null } catch { $threw = $true }
    Assert $threw "a contract event claiming neither 'captured' nor 'uncaptured' was accepted"
    $documentedOnly = '{ "events": { "PostCompact": { "uncaptured": "why", "fields": ["session_id"] } } }' | ConvertFrom-Json
    $documentedShape = Get-PayloadContractShape $documentedOnly
    Assert (@($documentedShape.captured).Count -eq 0) 'an uncaptured event was counted as captured, so a documented guess would verify a read'

    # EMPTYING THE DETECTOR'S OWN MATCH SET TURNS EVERY POSITIVE GREEN, and this is that done rather
    # than reasoned about: the same failing contract against a hook that reads no payload field
    # reports nothing at all. A count is not a detector, which is why the gate check throws on zero
    # reads instead of reporting a clean run.
    $silentReads = @(Get-HookPayloadReads $contractFixture @(@{ file = 'Quiet-Hook.ps1'; events = @('SessionStart') }))
    Assert ($silentReads.Count -eq 0) 'the fixture hook that reads no payload field was credited with a read'
    Assert (@(Get-PayloadContractProblems $fixtureContract $fixtureShape $silentReads).Count -eq 0) 'an empty match set still reported a problem, so the assertion above measures something else'

    # === 14. THE CAPTURE FACILITY MUST NOT COLLECT THIS SUITE'S OWN PAYLOADS ======================
    #
    # A capture directory left switched on during three runs of this suite on 2026-09-19 collected
    # 694 payloads the suite had COMPOSED -- `session-a`, `session-d`, `wc -c shelf/demo/...` --
    # beside four real ones, and the first PostCompact and SessionStart files in it were both the
    # suite's. Rebuilding the contract from that directory would have stamped `captured` provenance
    # on a payload this tree wrote itself, which is the exact substitution the contract exists to
    # prevent: the composed sample agreeing with the hook, and both disagreeing with the client.
    # `Read-HookPayload` now captures the stdin route only, and the two -InputJson forms -- the ones
    # this suite drives every hook through -- write nothing. This is what keeps that true.
    #
    # It runs against the REAL hooks directory, because `$PSScriptRoot` inside the dot-sourced
    # HookContext.ps1 is where the facility looks and a fixture copy would prove nothing about it.
    # A directory the developer left on is counted, not cleared, and only a directory this case
    # created is removed.
    $captureDir = Join-Path $hooks '.capture'
    $capturePreExisting = Test-Path -LiteralPath $captureDir -PathType Container
    if (-not $capturePreExisting) { New-Item -ItemType Directory -Path $captureDir -Force | Out-Null }
    try {
        $captureBefore = @(Get-ChildItem -LiteralPath $captureDir -File -ErrorAction SilentlyContinue).Count
        Invoke-Playbook $archiveCommand 'capture-scope-session' | Out-Null
        Invoke-Compacted @{ hook_event_name = 'PostCompact'; session_id = 'capture-scope-session'; compact_reason = 'auto' } | Out-Null
        Invoke-Shell 'ls -la' | Out-Null
        $captureAfter = @(Get-ChildItem -LiteralPath $captureDir -File -ErrorAction SilentlyContinue).Count
        Assert ($captureAfter -eq $captureBefore) "the capture directory collected $($captureAfter - $captureBefore) payload(s) this suite composed; a contract rebuilt from it would carry invented provenance"
    }
    finally {
        if (-not $capturePreExisting) { Remove-Item -LiteralPath $captureDir -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
finally {
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($script:Failures.Count) {
    foreach ($failure in $script:Failures) { Write-Output "FAIL: $failure" }
    Write-Output "$($script:Failures.Count) hook assertion(s) failed"
    exit 1
}

Write-Output 'all Library hook assertions pass'
exit 0
