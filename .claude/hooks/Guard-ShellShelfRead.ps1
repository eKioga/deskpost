[CmdletBinding()]
param(
    [string]$StateDirectory,
    [string]$WorkspacePath,
    [string]$Seat,
    # The reader's callable prefix, which the REGISTRATION supplies (S38): HookContext.ps1 says why.
    [string]$ReaderToolPrefix,
    [Parameter(ValueFromPipeline = $true)]
    [string]$InputJson,
    [string]$InputJsonBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
    THE HOLE THIS CLOSES, MEASURED RATHER THAN REASONED ABOUT.

    On 2026-09-06, in a session whose `Read` of `shelf/holding/wiki/_index.md` had just been denied
    by Guard-ShelfBookRead with "Shelf Book 'holding' is closed", this ran and returned a byte count:

        $ wc -c shelf/holding/wiki/_index.md
        328 shelf/holding/wiki/_index.md

    `cat` would have returned the page. Guard-ShelfBookRead matches `Read|Grep|Glob`; Bash is not in
    that set, and Bash's tool_input carries `command` rather than the `file_path`/`glob` fields that
    guard reads, so registering it there would have matched and then found nothing to judge.

    It is not a theoretical gap. Bypass-permissions mode instructs sessions to PREFER `cat` and
    `grep` over the Read tool, so the harness actively steers around the guard that was there.

    WHY THIS IS TEXT MATCHING AND NOT PATH RESOLUTION. A shell command is not a path; it is a
    program. `cat $(ls shelf/*/wiki/*.md | head -1)` reaches a closed Book through a construction no
    path parser will see, and `cd /tmp && cat ...` moves the ground a relative path stands on. This
    guard therefore judges the literal text, denies on doubt, and accepts that some commands which
    merely MENTION a closed Book are refused along with the ones that would read it. The escape
    hatch for a false positive is the same as for a true one and is the intended workflow anyway:
    open the Book.

    It follows that this is a guard against the ordinary path, not a sandbox. A session determined
    to defeat it can. The Desk boundary has never claimed otherwise -- what it claims is that
    reaching a closed Book is never something that happens by accident or by habit.
#>

# HOOKCONTEXT FIRST, AND OUTSIDE THE TRY -- see the note in Guard-ShelfBookRead.ps1. It reaches for
# nothing, so it loads in any layout, and it is what lets a failure below refuse out loud instead of
# exiting 1 with an empty stdout, which Claude Code treats as non-blocking and proceeds past.
. (Join-Path $PSScriptRoot 'HookContext.ps1')
try {
    . (Join-Path $PSScriptRoot 'ProgramRoot.ps1')
    . (Join-Path $PSScriptRoot 'ShelfBoundary.ps1')
    # Step 20. The rules below resolve every path against THIS workspace, so an absolute path into
    # another registered one answers `outside` and this guard says nothing. The registry answers
    # which workspace a path belongs to; the Desk rules then apply to the right one.
    . (Get-LibraryProgramFile -Name 'WorkspaceRegistry.ps1' -From $PSScriptRoot)
}
catch {
    Write-HookDeny 'PreToolUse' "Virtual Desk failed closed: the guard could not load its own rules. $($_.Exception.Message)"
    exit 0
}

# Every `shelf/<something>` the command names, whatever quoting or absolute prefix it wears.
#
# The lookbehind stops `bookshelf/x` and `my-shelf/x` from matching. It deliberately ALLOWS a
# preceding `/`, because that is how the segment appears inside `D:/Library/shelf/...` and
# `/d/Library/shelf/...`; anchoring on the segment rather than on the workspace prefix is what makes
# the guard indifferent to which spelling of the workspace root the command used.
#
# A FIXTURE SHELF UNDER THE SYSTEM TEMP DIRECTORY IS IN SCOPE, decided 2026-09-19 and recorded here
# because the question is about this scanner and will be asked again. Every suite in `tools/` builds
# one, none of them is the reader's Shelf, and a development session naming such a path is refused
# for nothing. The exemption was still declined. It would mean resolving the prefix above and asking
# whether it lands outside the workspace -- which is what `Guard-ShelfBookRead` does through
# `ConvertTo-WorkspaceRelative`, and which carries a hole this text match does not have: an aliased
# root (`subst X: D:\Library`, a junction) normalises to a path outside the workspace and would be
# waved through, one collection over from the four aliased spellings that walked past this boundary
# on 2026-09-07. A text match needs to establish nothing about where a path points, and that is the
# whole of its strength; trading it for convenience is the wrong direction for a guard. What was
# actually harming the reader in the 2026-09-12 report was the MESSAGE -- a temp fixture path was
# reported as spanning the whole Shelf -- and that is fixed below.
#
# The trailing class stops at a quote, a space, or a shell metacharacter. That is load-bearing for
# one specific false positive: `grep -rn "shelf/" docs/` yields the token `shelf/` with nothing
# after it, and a bare prefix naming no Book is a search string, not a read. Returned tokens always
# carry at least one character past the slash.
# A quoted-delimiter heredoc body is DATA, and the one exemption this guard makes.
#
# `<<'EOF'` and `<<"EOF"` suppress every form of expansion, so the text between the delimiters is
# never parsed as a path, a command, or a substitution -- the shell hands it to the process on stdin
# and opens nothing. Scanning it produced two false denials within an hour of the guard shipping,
# both of them the reader trying to WRITE ABOUT the boundary: a commit message quoting the incident
# that motivated the hook, and a script documenting the path it refuses.
#
# The exemption is deliberately narrow. An UNQUOTED `<<EOF` still expands `$(...)` and `${...}`
# inside the body, so those bodies are still scanned; and a redirection on the heredoc's own line
# (`cat <<'EOF' > shelf/demo/x`) sits outside the body and is scanned too.
function Remove-HeredocBodies([string]$Text) {
    # \1 backreferences the delimiter, so the body ends at ITS OWN terminator rather than at the
    # first line that happens to look like one. Singleline so . spans the body; multiline so ^$
    # anchor the terminator to its own line.
    #
    # `([^\n]*)\n` IS LOAD-BEARING: the body begins after the first newline, and group 3 is the rest
    # of the delimiter's own line, which is put back by the replacement. Without it a `.*?` starting
    # at `<<'EOF'` swallowed `> shelf/demo/wiki/new.md` in `cat <<'EOF' > shelf/demo/wiki/new.md` --
    # a redirection INTO a closed Book, elided as if it were data. Caught by its own assertion.
    [regex]::Replace($Text, "(?sm)<<-?\s*(?:'(\w+)'|`"(\w+)`")([^\n]*)\n.*?^\s*(?:\1|\2)\s*$", ' $3 <<heredoc-body-elided ')
}

# A BACKSLASH IS A PATH SEPARATOR ONLY WHERE IT INTRODUCES A SEGMENT. Everywhere else it is an
# ESCAPE, and reading an escape as a separator is what refused this on 2026-09-12:
#
#     grep -n -A4 '^\*\*Shelf\*\*\|^\*\*Holding Shelf\*\*' CONTEXT.md
#
# The only path argument there is `CONTEXT.md`. A flat `.Replace('\', '/')` turned `\*\*Shelf\*\*\|`
# into `/*/*Shelf/*/*/|`, the scanner lifted `Shelf/*/*` out of it, and the reader was told to open a
# Book that was never named -- a refusal that sends the diagnosis somewhere there is nothing to find.
# A second refusal the same session had the same cause one layer down: a Windows fixture path written
# with doubled backslashes collapsed to `shelf////holding////...`, which parses as no Book root at
# all, so a single Book was reported as the whole Shelf.
#
# THE RULE HAS THREE BRANCHES, AND WHICH WAY EACH LEANS IS THE WHOLE DESIGN.
#
#   `\` before a letter, a digit, `_`, another `\`, or `/`   ->  a path SEPARATOR, emitted as `/`
#   `\` before anything else                                 ->  an ESCAPE, emitted as a SPACE
#   a trailing `\`                                           ->  escapes nothing, separates nothing
#
# Digits are in the separator set because a Shelf slug may begin with one, which costs a `\1`
# backreference written directly after the word `shelf` a false denial -- the direction this guard is
# required to lean. `/` is there because `cat shelf\/demo\/wiki\/_index.md` is a real read that the
# shell performs: bash strips those backslashes and opens the page.
#
# AN ESCAPE BECOMES A SPACE RATHER THAN THE CHARACTER IT ESCAPED, and the first attempt at this fix
# got that wrong in a way its own suite caught. Dropping the backslash and keeping the character
# turned `s/\*\*Shelf\*\*/x/` into `s/**Shelf**/x/`, and the scanner -- which must tolerate `shelf*/`
# because the shell expands it -- then read those two asterisks as a glob and refused a `sed` script.
# The distinction the scanner needs is precisely whether a `*` was escaped, so an escape has to
# BREAK the token rather than contribute a character to it. A space cannot appear in the token class,
# so it breaks. Nothing is lost by breaking: the root is decided by the first segment, and the text
# up to the escape still carries it -- `shelf/demo/my\ page.md` still resolves to the Book `demo`.
#
# IT RETURNS A MAP, one source index per emitted character, because this normalisation is no longer
# length-preserving and a refusal has to be able to quote the command's OWN characters back.
function ConvertTo-PathSeparators([string]$Text) {
    $out = [Text.StringBuilder]::new($Text.Length)
    $map = [Collections.Generic.List[int]]::new($Text.Length)
    for ($i = 0; $i -lt $Text.Length; $i++) {
        $ch = $Text[$i]
        if ($ch -cne '\') { [void]$out.Append($ch); [void]$map.Add($i); continue }
        if ($i + 1 -ge $Text.Length) { continue }
        $next = $Text[$i + 1]
        # The escaped character is NOT consumed here: `\\demo` emits `/` for the first backslash and
        # `/` again for the second, and the doubled separator is collapsed where the token is formed.
        if ($next -ceq '\' -or $next -ceq '/' -or ([string]$next) -cmatch '^[A-Za-z0-9_]$') {
            [void]$out.Append('/'); [void]$map.Add($i); continue
        }
        [void]$out.Append(' '); [void]$map.Add($i); $i++
    }
    [pscustomobject]@{ text = $out.ToString(); map = $map }
}

# Every `shelf/<something>` the command names, as a pair: the canonical token the Desk is asked
# about, and the command's own characters that produced it.
function Get-ShelfTokens([string]$Command) {
    if ([string]::IsNullOrWhiteSpace($Command)) { return @() }
    $stripped = Remove-HeredocBodies $Command
    $normalized = ConvertTo-PathSeparators $stripped
    # `shelf*/` IS `shelf/`, because the SHELL expands it before anything here sees it. Until
    # 2026-09-19 this pattern required a literal slash, so `cat shelf*/holding/wiki/_index.md` was
    # allowed and printed the page -- the 2026-09-06 hole again, wearing one glob character. Measured
    # in Git Bash, which expands `shelf*/` to `shelf/`, rather than reasoned about.
    #
    # NOT $matches: that is PowerShell's automatic variable for the last -match's capture groups, and
    # Get-ShelfRootForPath reads it one frame away.
    $found = [regex]::Matches($normalized.text, '(?i)(?<![A-Za-z0-9_.-])shelf\**/[A-Za-z0-9_*?.\[\]/-]+')
    $seen = [Collections.Generic.HashSet[string]]::new()
    $hits = [Collections.Generic.List[object]]::new()
    foreach ($match in $found) {
        # The glob folds back to the slash it expands to, and a run of separators to one, so that
        # `shelf\\demo\\wiki` resolves to the Book `demo` instead of parsing as no root and being
        # reported as a span. That was the half of the 2026-09-12 report which was a wrong ANSWER
        # rather than only a wrong message.
        $canonical = ([regex]::Replace($match.Value, '(?i)^(shelf)\*+/', '$1/') -replace '/{2,}', '/').TrimEnd('/')
        if ($canonical -ieq 'shelf') { continue }
        if (-not $seen.Add($canonical)) { continue }
        $from = $normalized.map[$match.Index]
        $to = $normalized.map[$match.Index + $match.Length - 1]
        [void]$hits.Add([pscustomobject]@{ token = $canonical; text = $stripped.Substring($from, $to - $from + 1) })
    }
    @($hits)
}

# THE OTHER HALF OF A FALSE POSITIVE'S REMEDY, and it belongs in the refusal rather than in a doc.
# This guard judges literal text, so a search PATTERN spelling a Shelf path is refused along with a
# read of one, and that will not change: nothing in a command's text tells `grep -rn "shelf/demo" .`
# from `grep -rn x shelf/demo`. What the reader needs is the route that is NOT refused, and there is
# one -- `Guard-ShelfBookRead` reads the Grep tool's `path` and `glob` and never its `pattern`.
$script:PatternRemedy = 'If that text is a search pattern rather than a path, the Grep tool is judged on its path and glob, never on its pattern.'

function Format-MatchedText([string]$Text) {
    if ($Text.Length -gt 120) { return "'" + $Text.Substring(0, 117) + "...'" }
    "'" + $Text + "'"
}

try {
    # A PREFIX THAT NAMES NO TOOL IS A BROKEN REGISTRATION (S38), refused before anything is judged:
    # a denial naming a tool that does not exist sends the session nowhere, which is the defect the
    # parameter exists to remove. Failing closed on every call is loud, and loud is what gets it fixed.
    if (-not $ReaderToolPrefix) { $ReaderToolPrefix = $script:DefaultReaderToolPrefix }
    if (-not (Test-ReaderToolPrefix $ReaderToolPrefix)) {
        Write-HookDeny 'PreToolUse' "Virtual Desk failed closed: $(Get-ReaderToolPrefixFault $ReaderToolPrefix)"
        exit 0
    }
    # STEP 20 (2026-09-20). `Split-Path -Parent (Split-Path -Parent $PSScriptRoot)` used to answer
    # "which workspace am I guarding" with this file's own location. Installed as a plugin the hooks
    # sit ONE level below the package root, so that named the directory the package was dropped into
    # and every rule below went quiet. The workspace is asked for now; the old anchor survives only
    # where it really is a workspace, which keeps every un-split checkout working unchanged.
    # AN EXPLICIT -StateDirectory NAMES THE WORKSPACE, and this is a contract that predates the
    # resolver: `.claude` belongs to a workspace, so a caller that hands a hook a state directory has
    # already said which workspace it is talking about. Every fixture in this tree drives a hook that
    # way. Letting the working directory win instead would point a suite at THIS repository while its
    # Desk state came from a temp fixture -- every assertion about the wrong workspace, and a
    # conversation record written into live material by a test.
    $selected = $WorkspacePath
    if (-not $selected -and $StateDirectory) { $selected = Split-Path -Parent $StateDirectory }
    $resolved = Resolve-LibraryWorkspace -Explicit $selected -Anchor (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
    if ($resolved.kind -ceq 'conflict') {
        Write-HookDeny 'PreToolUse' "Virtual Desk failed closed: $($resolved.reason)"
        exit 0
    }
    $WorkspacePath = [string]$resolved.workspace
    # The Desk belongs to the workspace being guarded, not to the installation the hook was run from.
    if (-not $StateDirectory) {
        $StateDirectory = if ($WorkspacePath) { Join-Path $WorkspacePath '.claude' } else { Split-Path -Parent $PSScriptRoot }
    }
    $call = Read-HookPayload -BoundParameters $PSBoundParameters -InputJson $InputJson -InputJsonBase64 $InputJsonBase64
    $toolInput = Get-HookField $call 'tool_input'
    $command = Get-HookCommandText $toolInput
    if ([string]::IsNullOrWhiteSpace($command)) { exit 0 }

    # STEP 20: A PATH IN ANOTHER REGISTERED WORKSPACE, judged BEFORE the Shelf tokeniser, because
    # the tokeniser cannot answer this question and looks as though it can. It matches `shelf/...`
    # wherever the text puts it -- including inside `D:/Other/shelf/...` -- and then asks THIS
    # workspace's Desk about the Book it names. So a foreign Book whose slug happens to be open here
    # would be ALLOWED, which is worse than silence: it is the wrong Desk answering confidently. A
    # foreign Notebook write names no Shelf token at all and was never reached.
    #
    # Costs one regex and, on a machine with no registry, one Test-Path.
    foreach ($rooted in [regex]::Matches((ConvertTo-PathSeparators $command).text, '(?i)[A-Za-z]:/[^\s"''|;&<>]*')) {
        $crossDenial = Get-CrossWorkspaceDenial -Target $rooted.Value -HookWorkspace $WorkspacePath
        if ($crossDenial) {
            Write-HookDeny 'PreToolUse' "This command names '$($rooted.Value)'. $crossDenial"
            exit 0
        }
    }

    # THE TOKEN HALF NEEDS A WORKSPACE AND THE ROOTED-PATH HALF ABOVE DOES NOT, which is the whole
    # shape of step 20's silence rule. `Get-ShelfTokens` finds workspace-RELATIVE text -- `shelf/x`
    # -- and then asks THIS workspace's Desk about the Book it names; with no workspace there is no
    # Desk to ask and no ground for the path to stand on. The absolute-path scan above has already
    # run, so a command naming another registered workspace's Shelf is still refused from here.
    if (-not $WorkspacePath) { exit 0 }

    $hits = @(Get-ShelfTokens $command)
    if (-not $hits.Count) { exit 0 }

    # Read AFTER the cheap text test, so a command naming no Shelf path never pays for a state read
    # and never fails closed on state it was not going to consult. That now covers the SEAT as well:
    # resolving it here is what lets a seatless session still run commands that name no Shelf path.
    $openShelfRoots = @(Get-OpenShelfRoots -Directory (Get-DeskStateDirectory -StateDirectory $StateDirectory -Seat $Seat))

    foreach ($hit in $hits) {
        if (Test-ShelfBrowseSurface $hit.token) { continue }
        $target = Get-ShelfPatternTarget -Pattern $hit.token -OpenRoots $openShelfRoots
        if ($null -eq $target) { continue }
        # THE REFUSAL QUOTES WHAT THE READER TYPED, not the token this scanner derived. Told it had
        # named `Shelf/*/*`, a reader goes looking for a Book, and `grep '^\*\*Shelf\*\*' CONTEXT.md`
        # names none -- so the message sent the diagnosis further from the cause than silence would
        # have. Quoting the command's own characters makes a false positive self-evident instead of
        # mystifying, and it is the half of this that survives the next spelling nobody has thought of.
        $quoted = Format-MatchedText $hit.text
        if ($target -ceq '*') {
            Write-HookDeny 'PreToolUse' "This command's text $quoted spans Shelf Books that are closed. Narrow it to an open Book, or open the one you need with tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug <slug>. $script:PatternRemedy"
            exit 0
        }
        $parts = Split-BookRoot $target
        $kind = if ($parts.shelf -ceq 'archive') { 'Archived Shelf Book' } else { 'Shelf Book' }
        Write-HookDeny 'PreToolUse' "$kind '$($parts.slug)' is closed, and a shell command cannot read around that. This command names it as $quoted. Open it with $(Get-ShelfOpenCommand $target), then read its pages with $($ReaderToolPrefix)read_open_book_page. $script:PatternRemedy"
        exit 0
    }
}
catch {
    Write-HookDeny 'PreToolUse' "Virtual Desk failed closed: $($_.Exception.Message)"
}
