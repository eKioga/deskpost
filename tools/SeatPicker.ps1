<#
.SYNOPSIS
    The terminal seat picker: the roster, the choice grammar, and the one place each of its refusals
    is worded. Dot-sourced by `tools/Start-LibrarySeat.ps1`; never invoked directly.

.DESCRIPTION
    WHY A SECOND ENTRY SURFACE EXISTS AT ALL. `PLAN-seat-launch.md` step 12. The one-click route --
    an IDE agent button, the SessionStart hook, `tools/Enter-LibrarySeat.ps1` -- is now the ordinary
    way in, and it needs a running agent with hooks enabled. This is the route beside it: a session
    started with hooks disabled, a non-Orca terminal, or a recovery still has a way to sit down, and
    it should not require the reader to remember two slugs.

    IT DECIDES WHERE TO SIT AND NOTHING ELSE. Every action it offers goes through the gate that
    already owns it: the claim is `Enter-SeatClaim`'s, creation is `Assert-NewSeatIsCreatable`'s,
    retirement is `Retire-Seat.ps1`'s own preflight and `plan_id`. The picker composes those; it
    re-implements none of them, and it authorises nothing on its own.

    THE ROSTER IS DISPLAY, AND DISPLAY IS ALL IT IS. Two of the five columns come from records that
    are explicitly advisory -- `activity.json` is lock-free and never a lease, and a conversation
    title is read out of a transcript this repository does not own. So nothing the reader is shown
    here gates anything: the state column can be stale by the time they type, which is exactly why
    the acquisition below refuses atomically rather than the picker refusing from a probe.

    WHICH CONVERSATION A SEAT REMEMBERS, AND WHAT IT IS CALLED, MOVED OUT ON 2026-09-10. The Desk
    overview needed the same two answers for its own seat (`PLAN-seat-launch.md` step 14), so the
    derivation, the transcript measurement behind the head budget and the never-blank wording all
    live in `tools/SeatConversation.ps1` and are not restated here. What stays this file's is the
    ROSTER: one line per seat, its columns measured across all of them, and a resume the picker
    declines to offer for a seat that has nothing on record.
#>

Set-StrictMode -Version Latest

# The creation gate brings LibrarySeat.ps1 with it. Dot-sourced unconditionally, as
# Start-LibrarySeat.ps1 already dot-sources both: a conditional load would make what is in scope
# depend on the caller, and this file's own suite cases would then prove nothing about the launcher.
. (Join-Path $PSScriptRoot 'SeatCreation.ps1')

# The conversation record and the transcript title (SeatConversation.ps1). Extracted on 2026-09-10
# when the Desk overview needed the same two answers for its own seat: the derivation and the
# never-blank wording live in one file, and each surface renders its own shape around them.
. (Join-Path $PSScriptRoot 'SeatConversation.ps1')

# --- The roster ---------------------------------------------------------------------------------

function Get-SeatPickerRows {
    <#
    .SYNOPSIS
        One row per registered seat, newest-activity information included, numbered from 1.

    .DESCRIPTION
        THE REGISTRY IS THE ROSTER, not the seat directory. A directory with no registry entry is a
        seat nothing admits to, and reporting it here as pickable would offer a seat whose Project
        binding is unknown -- registry-versus-directory consistency is the *give retirement an
        identity* item's, and inventing a state for it here would pre-empt that decision.

        ONE UNREADABLE SEAT DOES NOT TAKE THE ROSTER DOWN. A seat whose binding cannot be parsed
        gets state `unreadable` carrying the reason, because "I could not read seat X" is an answer
        while an empty list is a wrong one -- the same reading the SessionStart hook's roster makes.

        NO LOCK. Every read here is one seat's own file plus the registry, exactly the set the
        SessionStart hook reads lock-free; it calls none of Get-RegistryLockedFunctions, so it stays
        outside the cross-seat surface that needs the registry lock.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [string]$TranscriptRoot,
        [switch]$SkipTitles
    )
    if ([string]::IsNullOrWhiteSpace($TranscriptRoot)) { $TranscriptRoot = Get-SeatTranscriptRoot }
    $registry = Read-SeatRegistry -StateDirectory $StateDirectory
    $entries = @(@($registry.seats) | Sort-Object -Property @{ Expression = { [string]$_.seat } })
    $rows = [Collections.Generic.List[object]]::new()
    $index = 0
    foreach ($entry in $entries) {
        $index++
        $seatName = [string]$entry.seat
        $row = [ordered]@{
            index = $index
            seat = $seatName
            project = [string]$entry.project
            state = 'unreadable'
            state_note = ''
            last_active_utc = ''
            session_id = ''
            conversation_source = 'none'
            title = ''
            title_status = 'no-conversation'
            title_note = ''
            entry_action = 'none'
            entry_note = ''
        }
        try {
            $state = Get-SeatClaimState -StateDirectory $StateDirectory -Seat $seatName
            $row['state'] = [string]$state.state
            if ([string]$state.state -ceq 'orphaned') {
                $row['state_note'] = "agent $([int]$state.agent_pid) alive, claim holder gone"
            }
            $activity = Read-SeatActivity -StateDirectory $StateDirectory -Seat $seatName
            if ($null -ne $activity) {
                $activityFields = @($activity.PSObject.Properties | ForEach-Object { $_.Name })
                if ($activityFields -ccontains 'last_seen_utc') { $row['last_active_utc'] = [string]$activity.last_seen_utc }
            }
            # WHICH CONVERSATION AND WHAT IT IS CALLED, IN ONE CALL. The three-arm decision behind it
            # -- a present-but-unusable record looked up for nothing, a caller that asked for no
            # titles, everything else read -- is SeatConversation.ps1's since 2026-09-10, because the
            # Desk overview's own line needs the same answer and a second copy of it is how one
            # surface's `malformed` becomes the other's `no title`.
            $view = Get-SeatConversationView -StateDirectory $StateDirectory -Seat $seatName `
                -TranscriptRoot $TranscriptRoot -SkipTitle:$SkipTitles
            foreach ($field in @('session_id', 'conversation_source', 'title', 'title_status', 'title_note',
                                 'entry_action', 'entry_note')) {
                $row[$field] = [string]$view.$field
            }
        }
        catch {
            $row['state'] = 'unreadable'
            $row['state_note'] = $_.Exception.Message
        }
        [void]$rows.Add([pscustomobject]$row)
    }
    @($rows)
}

# --- The shape of one render: width, alphabet, colour ---------------------------------------------
#
# READER BENEFIT. The roster below is a five-column table whose widths are DERIVED from content, so
# it has no upper bound. Two sources feed that, and NO TOTAL IS WRITTEN DOWN HERE because the total
# is a property of whichever seats exist at the moment -- it moved by 58 characters during the single
# session that added this section, which is the whole argument against recording it. What is stable
# is the mechanism. A state note makes an orphaned seat's state cell 47 characters where a healthy
# one is 4, and the widths are shared, so that ONE row widens the state column for EVERY row. And the
# conversation cell is capped at 52 characters on its title path but returns an UNCAPPED sentence on
# its entry_note path. On a narrow or portrait terminal the result wraps mid-column, and the number
# the reader is about to type ends up the hardest thing on the screen to find. Below the breakpoint
# each seat becomes a card -- one field per line -- which cannot wrap for that reason at all, because
# no line is sized from another row's content. Above it, -Width cuts the last column instead.
#
# SAFETY BOUNDARY. Display only, and the roster was already display that authorises nothing: what is
# pickable, what a number means, and what any action does are untouched by everything in this
# section. Two further limits, because a picker that cannot draw is a picker nobody can use.
# Nothing here may throw -- every host probe is guarded and falls back to a usable answer. And a
# REDIRECTED run renders plain ASCII, without colour and without changing the console encoding, so
# the gate, a pipe and a transcript all read the same bytes whatever codepage the machine is in.

# The fallback when the host cannot be measured at all. Deliberately wide enough to carry the table:
# a host that answers nothing is not silently handed the narrow layout.
$script:SeatPickerFallbackWidth = 120

# Below this, the table is abandoned for cards. 120 is the table's own measured cost rather than a
# round number -- at 134 characters for four healthy seats it has already lost its argument.
$script:SeatPickerCardBreakpoint = 120

function Get-SeatPickerRenderWidth {
    <#
    .SYNOPSIS
        The terminal's width, or the fallback when it cannot be had. NEVER THROWS.

    .DESCRIPTION
        [Console]::WindowWidth IS THE WRONG PROBE, AND IT FAILS EXACTLY WHERE THIS RUNS. Measured
        2026-09-11: it throws 'The handle is invalid.' whenever stdin is redirected -- which is how
        the suite drives this picker through -PickerInput, and how the gate spawns it. RawUI answers
        120 under the same conditions, so RawUI is the one asked. Both are still guarded, because a
        host with no raw UI at all answers neither.
    #>
    param([int]$Width = 0)
    if ($Width -gt 0) { return $Width }
    try {
        $measured = [int]$Host.UI.RawUI.WindowSize.Width
        if ($measured -gt 0) { return $measured }
    }
    catch { }
    $script:SeatPickerFallbackWidth
}

function Get-SeatPickerGlyphs {
    <#
    .SYNOPSIS
        Every non-letter mark the roster draws, in one place, in both alphabets.

    .DESCRIPTION
        ONE PLACE TO DEGRADE, because the alternative has already shipped once. A cut conversation
        title has emitted [char]0x2026 since that column was written, and a default powershell.exe
        console runs at codepage 437 where it degrades to a bare '.' -- so a truncated title reads
        'some long titl.' today. Holding both alphabets in one function is what stops the next glyph
        being added to the Unicode half alone.

        EVERY GLYPH IS BUILT FROM ITS CODE POINT, WHICH IS NOT A STYLE CHOICE. Measured 2026-09-11:
        every file in tools/ is stored BOM-less, and Windows PowerShell 5.1 reads a BOM-less file as
        ANSI. So a literal box character pasted into this file is not mojibake but a PARSE ERROR --
        'The string is missing the terminator: "' -- and the picker would not start at all.
    #>
    param([switch]$Ascii)
    if ($Ascii) {
        return @{
            ascii = $true
            tl = '+'; tr = '+'; bl = '+'; br = '+'
            h = '-'; v = '|'; sep = '-'
            held = '*'; free = 'o'; other = '!'
            ellipsis = '...'; dot = '-'
        }
    }
    @{
        ascii = $false
        tl = [string][char]0x256D; tr = [string][char]0x256E
        bl = [string][char]0x2570; br = [string][char]0x256F
        h = [string][char]0x2500; v = [string][char]0x2502; sep = [string][char]0x2500
        held = [string][char]0x25CF; free = [string][char]0x25CB; other = [string][char]0x25B2
        ellipsis = [string][char]0x2026; dot = [string][char]0x00B7
    }
}

function Get-SeatPickerPalette {
    <#
    .SYNOPSIS
        The ANSI sequences, or empty strings when colour is off. Every caller concatenates blindly.

    .DESCRIPTION
        RAW ESCAPES RATHER THAN $PSStyle, because this runs under Windows PowerShell 5.1 where
        $PSStyle does not exist -- it arrived in 7.2. Colour carries MEANING here and decorates
        nothing: the seat state, and the mark beside it. A reader who turns colour off loses no
        information at all, which is the property that makes honouring NO_COLOR free.
    #>
    param([switch]$Enabled)
    if (-not $Enabled) {
        return @{ enabled = $false; reset = ''; dim = ''; bold = ''
                  held = ''; free = ''; other = ''; frame = ''; accent = '' }
    }
    $esc = [string][char]27
    @{
        enabled = $true
        reset = "$esc[0m"; dim = "$esc[2m"; bold = "$esc[1m"
        held = "$esc[38;5;179m"; free = "$esc[38;5;108m"; other = "$esc[38;5;131m"
        frame = "$esc[38;5;66m"; accent = "$esc[38;5;180m"
    }
}

function Get-SeatPickerRenderPlan {
    <#
    .SYNOPSIS
        Width, alphabet, colour and layout for one render. The single decision point. NEVER THROWS.

    .DESCRIPTION
        A REDIRECTED RUN IS A CAPTURED RUN, and that decides every half at once: plain ASCII, no
        colour, and no console encoding change. The gate spawns this suite with 2>&1, so every check
        reads the same bytes whatever codepage the machine is in. A check that varied with the
        console's encoding would pass or fail by WHERE it ran, which is the green-and-unreached
        failure wearing a different coat.

        THE EXPLICIT -Width IS WHAT LETS A SUITE REACH THE CARD PATH AT ALL. A redirected run
        measures a real host and would take the table every time, so the card renderer would
        otherwise be shipped code that no check has ever drawn.

        TWO RULES CHOOSE THE LAYOUT, AND -TableWidth IS THE SECOND. A terminal below the breakpoint
        takes the cards because the table cannot fit anything there. But the table overflows WIDE
        terminals too -- an uncapped entry_note measured 106 characters on this checkout's own seats
        on 2026-09-11 -- so a table measured wider than the terminal takes the cards as well. The
        alternative was cutting the table's last column, which was tried the same day and reverted:
        it fits by deleting the conversation title the reader is choosing between, and density is
        the whole of the table's value. Pass 0 when the rows are not known, and only the first rule
        applies.
    #>
    param([int]$Width = 0, [switch]$ForcePlain, [int]$TableWidth = 0)
    $redirected = $true
    try { $redirected = [bool][Console]::IsOutputRedirected } catch { $redirected = $true }
    $virtualTerminal = $false
    try { $virtualTerminal = [bool]$Host.UI.SupportsVirtualTerminal } catch { $virtualTerminal = $false }
    $plain = ([bool]$ForcePlain) -or $redirected
    # NO_COLOR IS HONOURED ON ITS PRESENCE, which is that convention's own rule: any value at all,
    # an empty one included, means do not colour.
    $colorSuppressed = $null -ne $env:NO_COLOR
    $resolvedWidth = Get-SeatPickerRenderWidth -Width $Width
    $mode = 'table'
    $modeReason = 'the table fits this terminal'
    if ($resolvedWidth -lt $script:SeatPickerCardBreakpoint) {
        $mode = 'cards'
        $modeReason = "the terminal is $resolvedWidth columns, under the $($script:SeatPickerCardBreakpoint)-column breakpoint"
    }
    elseif ($TableWidth -gt 0 -and $TableWidth -gt $resolvedWidth) {
        $mode = 'cards'
        $modeReason = "the table would be $TableWidth columns against a terminal of $resolvedWidth"
    }
    [pscustomobject]@{
        width = $resolvedWidth
        ascii = $plain
        color = ((-not $plain) -and $virtualTerminal -and (-not $colorSuppressed))
        mode = $mode
        mode_reason = $modeReason
        redirected = $redirected
    }
}

function ConvertTo-SeatPickerPlainText {
    <#
    .SYNOPSIS
        Text an ASCII console can print. Known punctuation transliterates; anything else becomes '?'.

    .DESCRIPTION
        A CONVERSATION TITLE IS NOT OURS. It is read out of a transcript written by a tool this
        repository does not own, so it can carry any character at all: an em-dash, a curly quote, a
        name in another script. Every other column is a slug or a date, but this one is arbitrary --
        and at codepage 437 an untransliterated character is dropped or rendered as something else
        entirely.
    #>
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $map = @{
        0x2026 = '...'; 0x2014 = '--'; 0x2013 = '-'; 0x00B7 = '-'
        0x201C = '"'; 0x201D = '"'; 0x2018 = "'"; 0x2019 = "'"
        0x25CF = '*'; 0x25CB = 'o'; 0x25B2 = '!'
    }
    $builder = [Text.StringBuilder]::new()
    foreach ($character in $Text.ToCharArray()) {
        $code = [int]$character
        if ($map.ContainsKey($code)) { [void]$builder.Append([string]$map[$code]) }
        elseif ($code -ge 32 -and $code -lt 127) { [void]$builder.Append($character) }
        elseif ($code -eq 9) { [void]$builder.Append(' ') }
        else { [void]$builder.Append('?') }
    }
    $builder.ToString()
}

function Format-SeatPickerFit {
    <# One cell cut to a width, saying so in the alphabet's own ellipsis. #>
    param([string]$Text, [int]$Width, [Parameter(Mandatory = $true)][hashtable]$Glyphs)
    $value = [string]$Text
    if ($Width -le 0) { return '' }
    if ($value.Length -le $Width) { return $value }
    $marker = [string]$Glyphs['ellipsis']
    if ($Width -le $marker.Length) { return $value.Substring(0, $Width) }
    $value.Substring(0, $Width - $marker.Length).TrimEnd() + $marker
}

# --- The derivations both layouts share -----------------------------------------------------------
#
# EXTRACTED RATHER THAN COPIED. The table derived both of these inline, and a card renderer carrying
# its own copy is exactly how one layout's 'never active' becomes the other's blank cell. This file
# already carries a comment about the state cell and its measured width drifting apart, which is
# what broke the columns the first time; two layouts doubles the surface for that.

function Format-SeatPickerLastActive {
    <# The local-time stamp, or the words for a seat that has none. #>
    param([Parameter(Mandatory = $true)][object]$Row)
    $raw = [string]$Row.last_active_utc
    if ([string]::IsNullOrWhiteSpace($raw)) { return 'never active' }
    $parsed = [DateTime]::MinValue
    if ([DateTime]::TryParse($raw, [ref]$parsed)) { return $parsed.ToLocalTime().ToString('yyyy-MM-dd HH:mm') }
    $raw
}

function Format-SeatPickerStateCell {
    <# 'state', or 'state (note)' where a note exists. The note is why widths are measured late. #>
    param([Parameter(Mandatory = $true)][object]$Row)
    $cell = [string]$Row.state
    if (-not [string]::IsNullOrWhiteSpace([string]$Row.state_note)) { $cell = "$cell ($([string]$Row.state_note))" }
    $cell
}

function Get-SeatPickerStateMark {
    <# The glyph and the colour for one seat's state. An unknown state is marked, never left blank. #>
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$State,
        [Parameter(Mandatory = $true)][hashtable]$Glyphs,
        [Parameter(Mandatory = $true)][hashtable]$Palette
    )
    if ($State -ceq 'held') { return @{ mark = [string]$Glyphs['held']; color = [string]$Palette['held'] } }
    if ($State -ceq 'free') { return @{ mark = [string]$Glyphs['free']; color = [string]$Palette['free'] } }
    @{ mark = [string]$Glyphs['other']; color = [string]$Palette['other'] }
}

# --- Rendering ------------------------------------------------------------------------------------

function Format-SeatPickerRows {
    <#
    .SYNOPSIS
        The numbered lines, as an array of strings. Column widths are DERIVED from the rows.

    .DESCRIPTION
        IT STILL HAS NO UPPER BOUND, AND THAT IS NOW SOMEBODY ELSE'S PROBLEM TO SOLVE. Two sources
        feed the overflow: a state note, which widens the state column for every row, and the
        conversation cell, whose TITLE path is capped at 52 characters while its entry_note path
        returns an uncapped sentence.

        CUTTING THE LAST COLUMN HERE WAS TRIED ON 2026-09-11 AND REVERTED THE SAME HOUR. With a
        47-character state note in the fixture, the room left at 120 columns was 14, and the cut
        reduced a conversation titled 'Picker roster subject' to 'Picker roster su...' -- which case
        19f caught, because a roster that does not show the title it read is not a roster. The table
        is a DENSE layout and density is the whole of its value; a table that fits by deleting its
        content is worth less than the cards, which give that sentence a line of its own. So the
        overflow decides the LAYOUT instead, in Get-SeatPickerRenderPlan, and this renderer is left
        to do the one thing it is good at.
    #>
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Rows)
    if (-not @($Rows).Count) { return @() }
    # THE CELLS ARE BUILT BEFORE THE WIDTHS ARE MEASURED, and the first version measured `state`
    # while rendering `state (note)` -- so the one row that carried a note pushed every column after
    # it out of line, which is exactly the row a reader most needs to read.
    $cells = @(@($Rows) | ForEach-Object {
        [pscustomobject]@{
            index = [int]$_.index
            seat = [string]$_.seat
            project = [string]$_.project
            state = (Format-SeatPickerStateCell -Row $_)
            last_active = (Format-SeatPickerLastActive -Row $_)
            conversation = (Format-SeatConversationCell -Row $_)
        }
    })
    $widths = @{}
    foreach ($column in @('seat', 'project', 'state', 'last_active')) {
        $widest = 0
        foreach ($cell in @($cells)) {
            $text = [string]$cell.$column
            if ($text.Length -gt $widest) { $widest = $text.Length }
        }
        $widths[$column] = $widest
    }
    $lines = [Collections.Generic.List[string]]::new()
    foreach ($cell in @($cells)) {
        [void]$lines.Add(('  {0,2}  {1}  {2}  {3}  {4}  {5}' -f `
            [int]$cell.index,
            ([string]$cell.seat).PadRight($widths['seat']),
            ([string]$cell.project).PadRight($widths['project']),
            ([string]$cell.state).PadRight($widths['state']),
            ([string]$cell.last_active).PadRight($widths['last_active']),
            [string]$cell.conversation))
    }
    @($lines)
}

function Measure-SeatPickerTableWidth {
    <# The widest line the table would draw for these rows, which is what decides the layout. #>
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Rows)
    $widest = 0
    foreach ($line in @(Format-SeatPickerRows -Rows $Rows)) {
        if ($line.Length -gt $widest) { $widest = $line.Length }
    }
    $widest
}

function Get-SeatPickerLegend {
    <# The commands, worded once. #>
    @(
        'Type a number to resume that seat''s last conversation, or:',
        '  n<number>  start a NEW conversation at that seat',
        '  r<number>  retire that seat (its own preflight and approval)',
        '  +          create a seat',
        '  q          quit without sitting down'
    )
}

function Get-SeatPickerBanner {
    <#
    .SYNOPSIS
        The framed masthead: the wordmark, and one line saying how many seats there are.

    .DESCRIPTION
        DRAWN ONCE ON ENTRY AND NEVER INSIDE THE LOOP. Invoke-SeatPicker re-renders the roster after
        every refused keystroke and after every retirement, so a banner on each pass would push the
        list the reader is choosing from off the top of a narrow screen -- the one place a tall
        terminal is short of room.

        THE WORDMARK IS PURE ASCII IN BOTH ALPHABETS, so it needs no fallback of its own; only the
        frame around it changes. It is skipped entirely when the frame would not fit, because a
        wrapped wordmark is worse than none.
    #>
    param(
        [int]$Width = 80,
        [Parameter(Mandatory = $true)][hashtable]$Glyphs,
        [Parameter(Mandatory = $true)][hashtable]$Palette,
        [int]$SeatCount = 0,
        [int]$InUse = 0
    )
    $wordmark = @(
        ' _    ___ ___ ___    _   ___ __   __',
        '| |  |_ _| _ ) _ \  /_\ | _ \\ \ / /',
        '| |__ | || _ \   / / _ \|   / \ V / ',
        '|____|___|___/_|_\/_/ \_\_|_\  |_|  '
    )
    # The frame costs a bar, a space, a space and a bar. Below that the wordmark cannot be shown at
    # all, and a bare heading is drawn instead.
    $content = $Width - 4
    $frame = [string]$Palette['frame']
    $reset = [string]$Palette['reset']
    $lines = [Collections.Generic.List[string]]::new()
    $summary = "$SeatCount seats"
    if ($SeatCount -eq 1) { $summary = '1 seat' }
    if ($InUse -gt 0) { $summary = "$summary $([string]$Glyphs['dot']) $InUse in use" }
    if ($content -lt 40) {
        [void]$lines.Add('')
        [void]$lines.Add("  $([string]$Palette['bold'])THE LIBRARY$reset  $([string]$Palette['dim'])$summary$reset")
        [void]$lines.Add('')
        return @($lines)
    }
    $top = [string]$Glyphs['tl'] + ([string]$Glyphs['h'] * ($Width - 2)) + [string]$Glyphs['tr']
    $bottom = [string]$Glyphs['bl'] + ([string]$Glyphs['h'] * ($Width - 2)) + [string]$Glyphs['br']
    [void]$lines.Add('')
    [void]$lines.Add("$frame$top$reset")
    foreach ($art in $wordmark) {
        $body = ([string]$art).PadRight($content)
        [void]$lines.Add("$frame$([string]$Glyphs['v'])$reset $([string]$Palette['accent'])$body$reset $frame$([string]$Glyphs['v'])$reset")
    }
    $heading = 'Pick a seat'
    $gap = $content - $heading.Length - $summary.Length
    if ($gap -lt 1) { $gap = 1 }
    $caption = "$([string]$Palette['bold'])$heading$reset" + (' ' * $gap) + "$([string]$Palette['dim'])$summary$reset"
    [void]$lines.Add("$frame$([string]$Glyphs['v'])$reset " + (' ' * $content) + " $frame$([string]$Glyphs['v'])$reset")
    [void]$lines.Add("$frame$([string]$Glyphs['v'])$reset $caption $frame$([string]$Glyphs['v'])$reset")
    [void]$lines.Add("$frame$bottom$reset")
    @($lines)
}

function Format-SeatPickerCards {
    <#
    .SYNOPSIS
        One card per seat: the number and the state on a head line, each remaining field on its own.

    .DESCRIPTION
        NO LINE IS SIZED FROM ANOTHER ROW, which is the whole point and the fix for the defect the
        table cannot avoid. The table shares a measured width per column, so a single orphaned seat's
        47-character note widens the state column for every row and pushes the whole roster past a
        narrow terminal. Here that note is simply its own line on its own card.

        THE STATE NOTE IS PROMOTED TO A FIELD rather than parenthesised onto the state, so the head
        line's length depends on the seat name alone -- which is bounded by the seat-name rule --
        and the reader's number stays at a fixed column on every card.
    #>
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Rows,
        [int]$Width = 80,
        [Parameter(Mandatory = $true)][hashtable]$Glyphs,
        [Parameter(Mandatory = $true)][hashtable]$Palette
    )
    if (-not @($Rows).Count) { return @() }
    $reset = [string]$Palette['reset']
    $dim = [string]$Palette['dim']
    $labelWidth = 9
    $detailIndent = 8
    $detailRoom = $Width - $detailIndent - $labelWidth - 1
    if ($detailRoom -lt 12) { $detailRoom = 12 }
    $lines = [Collections.Generic.List[string]]::new()
    foreach ($row in @($Rows)) {
        $state = [string]$row.state
        $marker = Get-SeatPickerStateMark -State $state -Glyphs $Glyphs -Palette $Palette
        # THE PLAIN HEAD IS MEASURED, NOT THE COLOURED ONE. An escape sequence has no visible width,
        # so padding computed over a coloured string right-aligns the state somewhere off the screen.
        $prefix = '  ' + ('{0,2}' -f [int]$row.index) + ' ' + [string]$marker['mark'] + ' '
        $seatRoom = $Width - $prefix.Length - $state.Length - 2
        $seat = Format-SeatPickerFit -Text ([string]$row.seat) -Width $seatRoom -Glyphs $Glyphs
        $gap = $Width - $prefix.Length - $seat.Length - $state.Length - 1
        if ($gap -lt 1) { $gap = 1 }
        $head = '  ' + ('{0,2}' -f [int]$row.index) + ' ' +
                [string]$marker['color'] + [string]$marker['mark'] + $reset + ' ' +
                [string]$Palette['bold'] + $seat + $reset + (' ' * $gap) +
                [string]$marker['color'] + $state + $reset
        [void]$lines.Add($head)
        $fields = [Collections.Generic.List[object]]::new()
        if (-not [string]::IsNullOrWhiteSpace([string]$row.state_note)) {
            [void]$fields.Add(@{ label = 'Note'; value = [string]$row.state_note })
        }
        [void]$fields.Add(@{ label = 'Project'; value = [string]$row.project })
        [void]$fields.Add(@{ label = 'Last'; value = (Format-SeatPickerLastActive -Row $row) })
        [void]$fields.Add(@{ label = 'Says'; value = (Format-SeatConversationCell -Row $row) })
        foreach ($field in @($fields)) {
            $value = Format-SeatPickerFit -Text ([string]$field['value']) -Width $detailRoom -Glyphs $Glyphs
            [void]$lines.Add((' ' * $detailIndent) + $dim + ([string]$field['label']).PadRight($labelWidth) + $reset + $value)
        }
        [void]$lines.Add('')
    }
    @($lines)
}

function Get-SeatPickerNonInteractiveRefusal {
    <#
    .SYNOPSIS
        The one wording of the fail-closed refusal for a caller that cannot be asked.

    .DESCRIPTION
        A PICKER PROMPTS, SO A CALLER THAT CANNOT ANSWER MUST BE REFUSED RATHER THAN WAITED ON. A
        script, a hook, an agent tool call and a piped invocation all reach here with stdin
        redirected; a reader at a terminal does not. The refusal names the argument that makes the
        call deterministic, and lists the seats, because the commonest reason for landing here is a
        caller that meant one of them.
    #>
    param([Parameter(Mandatory = $true)][string]$StateDirectory)
    $seats = @()
    try { $seats = @(@((Read-SeatRegistry -StateDirectory $StateDirectory).seats) | ForEach-Object { [string]$_.seat } | Sort-Object -CaseSensitive) }
    catch { $seats = @() }
    $known = if ($seats.Count) { "Seats in this checkout: $($seats -join ', ')." } else { 'No seat exists in this checkout yet.' }
    ('No seat was named and this caller cannot be asked to pick one: the seat picker prompts, and stdin is redirected ' +
     "here. Pass -Seat <name> (with -Project <project-slug> to create one). $known")
}

# --- The choice grammar ---------------------------------------------------------------------------

function Resolve-SeatPickerChoice {
    <#
    .SYNOPSIS
        What one typed line means: `resume`, `new`, `retire`, `create`, `quit`, `reprompt` or
        `invalid`, with the row index where one applies and a DISTINCT reason where it does not.

    .DESCRIPTION
        EVERY REFUSAL HAS ITS OWN REASON, because they need different next moves: a number nobody
        offered, a number where no conversation is recorded, and a line that is not a command at all
        are three different mistakes. A shared "no seat was chosen" would let any one of the three
        break while the others kept the suite green.

        CASE-INSENSITIVE ON PURPOSE, and it is the only such comparison here. `N1` and `Q` are a
        reader typing, not a rule about stored state -- the case belongs to the reader the way an
        image name belongs to its vendor. Written as explicit character classes rather than with a
        case-insensitive operator, so the intent is visible where defect family 1 is linted.
    #>
    param(
        [string]$Choice,
        [Parameter(Mandatory = $true)][int]$RowCount
    )
    $answer = [ordered]@{ action = 'invalid'; index = 0; reason = '' }
    $text = ''
    if ($null -ne $Choice) { $text = $Choice.Trim() }
    if ([string]::IsNullOrWhiteSpace($text)) {
        $answer['action'] = 'reprompt'
        $answer['reason'] = 'nothing was typed'
        return [pscustomobject]$answer
    }
    if ($text -cmatch '^[qQ]$' -or $text -cmatch '^[qQ][uU][iI][tT]$') {
        $answer['action'] = 'quit'
        return [pscustomobject]$answer
    }
    if ($text -ceq '+') {
        $answer['action'] = 'create'
        return [pscustomobject]$answer
    }

    $action = 'resume'
    $digits = $text
    if ($text -cmatch '^[nN]\s*[0-9]+$') { $action = 'new'; $digits = $text.Substring(1).Trim() }
    elseif ($text -cmatch '^[rR]\s*[0-9]+$') { $action = 'retire'; $digits = $text.Substring(1).Trim() }
    elseif ($text -cnotmatch '^[0-9]+$') {
        $answer['reason'] = "'$text' is not one of the commands: a number, n<number>, r<number>, + or q"
        return [pscustomobject]$answer
    }

    $number = 0
    if (-not [int]::TryParse($digits, [ref]$number)) {
        $answer['reason'] = "'$text' names no seat number this list offers"
        return [pscustomobject]$answer
    }
    if ($RowCount -le 0) {
        $answer['reason'] = 'no seat exists in this checkout yet, so no number applies; type + to create one'
        return [pscustomobject]$answer
    }
    if ($number -lt 1 -or $number -gt $RowCount) {
        $answer['action'] = 'out-of-range'
        $answer['reason'] = "there is no seat $number; the list offers 1 to $RowCount"
        return [pscustomobject]$answer
    }
    $answer['action'] = $action
    $answer['index'] = $number
    [pscustomobject]$answer
}

# --- Orca's tab title, whose flags come from the installed binary ---------------------------------

function Get-OrcaTerminalRenameArguments {
    <#
    .SYNOPSIS
        The argument list for retitling this Orca tab. Declared once, from
        `orca terminal rename --help` on the installed binary (1.4.198, read 2026-09-10):
        `orca terminal rename [--terminal <handle>] [--title <text>] [--json]`.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$TerminalHandle,
        [Parameter(Mandatory = $true)][string]$Seat
    )
    @('terminal', 'rename', '--terminal', $TerminalHandle, '--title', "seat: $Seat")
}

function Get-SeatPickerTabRename {
    <#
    .SYNOPSIS
        Whether this tab is retitled for the seat, and the handle to retitle it through.

    .DESCRIPTION
        IT STOPPED BEING A QUESTION ON 2026-09-14, ruled by Eric after meeting the prompt. The only
        alternative to `seat: <name>` is the Quick Command's own label, which is the SAME STRING on
        every tab that button opens -- so declining bought a reader identical tabs and no way to tell
        which seat each one held. There is no third answer to offer: a custom title was considered and
        is deliberately not a route.

        WHY THAT IS A BOUNDARY MOVE RATHER THAN ONE LESS KEYSTROKE. A tab title touches nothing
        durable and Orca undoes it in a keystroke, and this picker's other confirmations are a seat
        created, a Hub written to the SHARED collection, and a Desk archived. A cosmetic yes standing
        beside those is what teaches a reader to type yes without reading the plan above it, which is
        paid for at the prompt that needed reading.

        IT DOES NOT READ `ORCA_TERMINAL_HANDLE` ITSELF, and that is the point. The launcher's
        parameter default resolves the environment ONCE, so a caller that passes an empty handle
        renames nothing -- where a fallback here would read the variable straight back and retitle a
        real tab anyway. Found by running the picker inside Orca, where a suite that expected four
        questions was asked five; since the question went away it is the one remaining opt-out, and
        it is the suite's rather than the reader's.
    #>
    param([string]$TerminalHandle)
    if ([string]::IsNullOrWhiteSpace($TerminalHandle)) { return [pscustomobject]@{ rename = $false; handle = '' } }
    [pscustomobject]@{ rename = $true; handle = $TerminalHandle }
}

function Set-OrcaTerminalTitle {
    <#
    .SYNOPSIS
        Retitle the Orca tab, reporting `renamed`, `no-orca` or `failed` with the reason. NEVER
        THROWS: a tab title is cosmetic and must not be able to stop a reader sitting down.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$TerminalHandle,
        [Parameter(Mandatory = $true)][string]$Seat
    )
    # THE FIRST MATCH ON PATH, WHICH IS THE ONE A SHELL WOULD RUN. Get-Command returns EVERY match,
    # and on this machine `orca` resolves to three: taking the collection made `& $orca.Source` a
    # command name built out of three paths joined together. Found by the stand-in case below, which
    # is the only context where a second `orca` exists -- reading this code would not have.
    $candidates = @(Get-Command -Name 'orca' -CommandType Application -ErrorAction SilentlyContinue)
    if (-not $candidates.Count) {
        return [pscustomobject]@{ outcome = 'no-orca'; reason = 'orca is not on PATH here' }
    }
    $orca = $candidates[0]
    $arguments = @(Get-OrcaTerminalRenameArguments -TerminalHandle $TerminalHandle -Seat $Seat)
    $preference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = @()
    $code = 1
    try {
        $output = @(& $orca.Source @arguments 2>&1)
        $code = $LASTEXITCODE
    }
    catch { $output = @($_.Exception.Message) }
    finally { $ErrorActionPreference = $preference }
    if ($code -eq 0) { return [pscustomobject]@{ outcome = 'renamed'; reason = "seat: $Seat" } }
    $why = ((@($output | ForEach-Object { [string]$_ }) -join ' ') -replace '\s+', ' ').Trim()
    [pscustomobject]@{ outcome = 'failed'; reason = $why }
}

# --- The loop -------------------------------------------------------------------------------------
#
# WHAT IS SCRIPTED AND WHAT IS NOT. `-InputLines` supplies the answers `Read-Host` would have
# returned, so a suite drives THIS loop rather than a re-implementation of it: the choices, the
# re-prompt, the creation confirmation and the retirement approval all run their real code. It is not
# a bypass of anything -- every action still goes through its own gate -- and a caller that supplies
# no answers and cannot be prompted is refused before this function is reached.

$script:SeatPickerScriptedInput = $null

function Read-SeatPickerLine {
    <#
    .SYNOPSIS
        One typed line: from the scripted answers when the caller supplied them, else from Read-Host.

    .DESCRIPTION
        RUNNING OUT OF SCRIPTED ANSWERS IS A NAMED FAILURE, not a fall back to prompting. A suite
        that fed three answers and reached a fourth question has learned something -- most often that
        a refusal it expected to end the loop did not -- and prompting there would hang the gate on a
        terminal and fail with an end-of-file error everywhere else.
    #>
    param([Parameter(Mandatory = $true)][string]$Prompt)
    if ($null -ne $script:SeatPickerScriptedInput) {
        if ($script:SeatPickerScriptedInput.Count -eq 0) {
            throw ("The seat picker asked '$Prompt' and the supplied answers ran out, so nothing was chosen. " +
                   'Either it asked a question the caller did not expect, or an answer it did expect was consumed ' +
                   'by an earlier question.')
        }
        $line = [string]$script:SeatPickerScriptedInput.Dequeue()
        Write-Host "${Prompt}: $line"
        return $line
    }
    $typed = Read-Host -Prompt $Prompt
    # END OF INPUT IS NOT AN EMPTY ANSWER, and the difference is a hang. Measured 2026-09-10: at EOF
    # `Read-Host` returns $null and keeps returning it, where a reader pressing Enter returns ''. An
    # empty answer re-prompts, so a caller with no input at all would re-prompt forever. This is the
    # backstop behind the redirected-stdin refusal in the launcher rather than a second copy of it:
    # that refusal is what a non-interactive caller actually meets, and this is what stops a wrong
    # answer from it costing a hung terminal instead of a message.
    if ($null -eq $typed) {
        throw ("The seat picker asked '$Prompt' and its input ended, so nothing was chosen. A caller that cannot answer " +
               'should name the seat instead: tools/Start-LibrarySeat.ps1 -Seat <name>.')
    }
    $typed
}

function Write-SeatPickerLine {
    <#
    .SYNOPSIS
        One rendered line on the host, transliterated when this render is a plain one.

    .DESCRIPTION
        THE ONE PLACE TEXT MEETS THE CONSOLE, so both layouts are covered by one rule and the
        formatters stay pure strings a suite can assert against. It is also what finally fixes the
        cut-title defect in the TABLE, which has emitted an ellipsis no default console can print
        since that column was written.

        SAFE ONLY BECAUSE PLAIN IMPLIES UNCOLOURED. Get-SeatPickerRenderPlan derives colour as
        (-not plain), so a line reaching the transliterator can carry no escape sequence -- and an
        escape's own [char]27 would otherwise be rewritten to '?' here, which would print the codes
        rather than suppress them.
    #>
    param([AllowEmptyString()][string]$Line, [switch]$Plain)
    if ($Plain) { Write-Host (ConvertTo-SeatPickerPlainText -Text $Line) } else { Write-Host $Line }
}

function Show-SeatPickerRoster {
    <#
    .SYNOPSIS
        The list and the legend, on the host, in whichever layout this terminal has room for.
        Returns the rows it rendered.

    .DESCRIPTION
        THE LAYOUT IS CHOSEN PER RENDER RATHER THAN ONCE, because a terminal can be resized between
        two passes of the loop -- and the loop redraws after every refused keystroke and every
        retirement, so the next pass is exactly where a resize should take effect.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [string]$TranscriptRoot,
        [int]$Width = 0,
        [switch]$ForcePlain,
        [switch]$Banner
    )
    $rows = @(Get-SeatPickerRows -StateDirectory $StateDirectory -TranscriptRoot $TranscriptRoot)
    # THE TABLE IS MEASURED BEFORE THE LAYOUT IS CHOSEN, because "does it fit" is one of the two
    # rules and nothing can answer it without rendering the table. Cheap by comparison with the row
    # build above: string formatting over a handful of rows, and no I/O at all.
    $tableWidth = 0
    if (@($rows).Count) { $tableWidth = Measure-SeatPickerTableWidth -Rows $rows }
    $plan = Get-SeatPickerRenderPlan -Width $Width -ForcePlain:$ForcePlain -TableWidth $tableWidth
    $plain = [bool]$plan.ascii
    $glyphs = Get-SeatPickerGlyphs -Ascii:$plain
    $palette = Get-SeatPickerPalette -Enabled:([bool]$plan.color)
    # THE BANNER IS DRAWN HERE RATHER THAN BY THE CALLER so that its counts come from the rows this
    # render is about to show. A caller that counted them itself would take a second lock-free pass
    # over the registry and could disagree with the list printed directly beneath it.
    if ($Banner) {
        $inUse = @(@($rows) | Where-Object { [string]$_.state -ceq 'held' }).Count
        $bannerLines = @(Get-SeatPickerBanner -Width ([int]$plan.width) -Glyphs $glyphs -Palette $palette `
            -SeatCount @($rows).Count -InUse $inUse)
        foreach ($line in $bannerLines) { Write-SeatPickerLine -Line $line -Plain:$plain }
    }
    Write-SeatPickerLine -Line '' -Plain:$plain
    if (-not $rows.Count) {
        Write-SeatPickerLine -Line 'Seats in this Library:' -Plain:$plain
        Write-SeatPickerLine -Line '  (none yet)' -Plain:$plain
        Write-SeatPickerLine -Line '' -Plain:$plain
    }
    elseif ([string]$plan.mode -ceq 'cards') {
        $cards = @(Format-SeatPickerCards -Rows $rows -Width ([int]$plan.width) -Glyphs $glyphs -Palette $palette)
        foreach ($line in $cards) { Write-SeatPickerLine -Line $line -Plain:$plain }
        $rule = '  ' + ([string]$glyphs['sep'] * ([int]$plan.width - 4))
        Write-SeatPickerLine -Line ([string]$palette['frame'] + $rule + [string]$palette['reset']) -Plain:$plain
        # THE LEGEND IS INDENTED TO THE CARDS RATHER THAN REWORDED. Get-SeatPickerLegend is the one
        # place these commands are worded, and a second copy of them for the narrow layout is how the
        # two come to describe different keystrokes.
        foreach ($line in @(Get-SeatPickerLegend)) { Write-SeatPickerLine -Line ('  ' + $line) -Plain:$plain }
        return @($rows)
    }
    else {
        Write-SeatPickerLine -Line 'Seats in this Library:' -Plain:$plain
        foreach ($line in @(Format-SeatPickerRows -Rows $rows)) { Write-SeatPickerLine -Line $line -Plain:$plain }
        Write-SeatPickerLine -Line '' -Plain:$plain
    }
    foreach ($line in @(Get-SeatPickerLegend)) { Write-SeatPickerLine -Line $line -Plain:$plain }
    @($rows)
}

function Get-SeatNameSuggestion {
    <#
    .SYNOPSIS
        A usable seat name derived from what the reader typed, or '' when none can be offered.

    .DESCRIPTION
        IT PROPOSES AND NEVER RULES. The candidate goes straight back through `Resolve-SeatName`, so a
        suggestion that would not satisfy the resolver is never offered -- there is no second copy of
        the slug pattern here, and a future change to that pattern can only make this offer FEWER
        suggestions, never a wrong one. That is the same reason the typed name is resolved rather than
        matched locally a few lines below.
    #>
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Typed,
        [Parameter(Mandatory = $true)][string]$StateDirectory
    )
    # Lowercase, then every run of anything else collapses to ONE hyphen, and the ends are trimmed --
    # a leading hyphen is precisely what the resolver refuses, so a candidate that kept one would be
    # an offer that cannot be accepted. 'Home Assistant Admin' and 'Home  Assistant_Admin!' both reach
    # 'home-assistant-admin'.
    $candidate = ([string]$Typed).ToLowerInvariant()
    $candidate = [regex]::Replace($candidate, '[^a-z0-9]+', '-')
    $candidate = $candidate.Trim('-')
    if ([string]::IsNullOrWhiteSpace($candidate)) { return '' }
    $resolved = Resolve-SeatName -Seat $candidate -StateDirectory $StateDirectory
    if ([string]$resolved.status -cne 'named') { return '' }
    [string]$resolved.seat
}

function Get-ProjectTitleSuggestion {
    <#
    .SYNOPSIS
        A slug read back as a title -- 'home-assistant-admin' as 'Home Assistant Admin'. Shown as an
        example beside the title prompt; never used as the answer.
    #>
    param([Parameter(Mandatory = $true)][string]$Slug)
    $words = @(@($Slug -csplit '-') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
        if ($_.Length -eq 1) { $_.ToUpperInvariant() }
        else { $_.Substring(0, 1).ToUpperInvariant() + $_.Substring(1) }
    })
    $words -join ' '
}

function Invoke-SeatPickerHubCreation {
    <#
    .SYNOPSIS
        The offer made when the typed Project names no active Hub: `New-ProjectHub.ps1`'s own
        preflight, shown, then its own approval. Returns the slug it created, or '' for every other
        outcome.

    .DESCRIPTION
        WHY THE PICKER MAY DO A SHARED WRITE AT ALL, ruled 2026-09-11 by Eric after meeting the dead
        end twice: sitting down at a NEW subject is the common case, and a picker that can seat a
        reader only at projects that already exist sends them out to a terminal to run a helper and
        back again. The friction was the point of the route, so removing it is worth the boundary
        move. This is disclosed rather than quiet -- the plan below says the shared collection is
        touched, in those words, and nothing is written without a yes bound to that plan.

        THE HELPER IS THE GATE, IN PROCESS, TWICE -- the same shape as the retirement route above and
        for the same reason: `-File` would return formatted TEXT and a caller projecting
        `.planned_root_sections` off it receives nothing. The slug rule, the already-exists refusal
        and the write-then-readback order are all `New-ProjectHub.ps1`'s, restated nowhere.

        ITS ARGUMENTS ARE SPLATTED, WHICH IS NOT STYLE. `New-ProjectHub.ps1` resolves its MCP endpoint
        from a PARAMETER DEFAULT, so passing `-McpUrl ''` -- which is what an unset picker argument
        would forward -- replaces a working default with an empty string and fails at the first call.
        An argument this route does not have must be ABSENT, not empty.

        NO LOCK IS HELD ACROSS IT. Every call here is a network round trip, and the registry lock in
        the caller is taken and released around the seat gate alone (D10).

        A PURPOSE IS REQUIRED HERE THOUGH THE HELPER ALLOWS AN EMPTY ONE. That is this prompt being
        stricter about what it will submit, not a new rule about what a Hub may be: an unexplained Hub
        is the one that reads as abandoned three months later, and the reader is right here.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$ProjectSlug,
        [string]$McpUrl,
        [string]$ProjectId,
        # THE WORKSPACE THE SEAT IS BEING CREATED IN, forwarded so the Hub write can be fenced.
        # Without it this branch was a dead end in a split install: New-ProjectHub.ps1 took no
        # workspace at all, so the ownership fence had nothing to resolve from and refused with
        # `no Library workspace was selected and none could be derived`. Invisible while the
        # program and the workspace were one directory, and reachable only here -- a new seat
        # naming a Project that does not exist yet.
        [string]$Workspace
    )
    Write-Host "There is no active Project Hub '$ProjectSlug' yet."
    $offer = (Read-SeatPickerLine -Prompt 'Create it now? (yes to create, anything else to name a different Project)').Trim()
    if ($offer -cne 'yes') { return '' }

    Write-Host "A title reads like '$(Get-ProjectTitleSuggestion -Slug $ProjectSlug)'."
    $title = (Read-SeatPickerLine -Prompt 'Title for the Hub (empty to cancel)').Trim()
    if ([string]::IsNullOrWhiteSpace($title)) {
        Write-Host 'No Hub was created: nothing was typed.'
        return ''
    }
    $purpose = (Read-SeatPickerLine -Prompt 'One or two sentences on what this project is for (empty to cancel)').Trim()
    if ([string]::IsNullOrWhiteSpace($purpose)) {
        Write-Host 'No Hub was created: nothing was typed, and a Hub nobody explained is the one that goes stale.'
        return ''
    }
    $devAnswer = (Read-SeatPickerLine -Prompt 'Is this development work with a repository? (yes adds the Repo and Decisions sections)').Trim()

    $hubArgs = @{ ProjectSlug = $ProjectSlug; Title = $title; Purpose = $purpose }
    if ($devAnswer -ceq 'yes') { $hubArgs['Dev'] = $true }
    if (-not [string]::IsNullOrWhiteSpace($McpUrl)) { $hubArgs['McpUrl'] = $McpUrl }
    if (-not [string]::IsNullOrWhiteSpace($ProjectId)) { $hubArgs['ProjectId'] = $ProjectId }
    if (-not [string]::IsNullOrWhiteSpace($Workspace)) { $hubArgs['WorkspacePath'] = $Workspace }

    $helper = Join-Path $PSScriptRoot 'New-ProjectHub.ps1'
    $plan = $null
    try { $plan = & $helper @hubArgs -Preflight }
    catch {
        Write-Host "No Hub was created: $($_.Exception.Message)"
        return ''
    }

    Write-Host ''
    Write-Host "Create Project Hub '$ProjectSlug'."
    Write-Host "  Title:     $title"
    Write-Host "  Hub:       $([string]$plan.project_path)"
    Write-Host "  Sections:  $((@($plan.planned_root_sections) -join ', '))"
    Write-Host "  Listed in: $([string]$plan.catalog_path)"
    Write-Host '  Touches:   the SHARED collection. Nothing in this Library deletes a Hub afterwards.'
    $answer = (Read-SeatPickerLine -Prompt 'Type yes to create it').Trim()
    if ($answer -cne 'yes') {
        Write-Host "No Hub was created: the confirmation was '$answer' rather than yes."
        return ''
    }

    try { & $helper @hubArgs | Out-Null }
    catch {
        Write-Host "No Hub was created: $($_.Exception.Message)"
        return ''
    }
    Write-Host "Project Hub '$ProjectSlug' created."
    $ProjectSlug
}

function Invoke-SeatPickerCreation {
    <#
    .SYNOPSIS
        The `+` route: both slugs asked until they are usable, the shared gate run, a plan shown, and
        one clear yes. Returns {seat, project, approved_plan_id}, or `$null` when the reader backs out.

    .DESCRIPTION
        THE GATE IS `Assert-NewSeatIsCreatable` AND THE APPROVAL IS `Get-SeatCreationPlanId`, both of
        them the shared ones -- this route validates and derives nothing of its own. What it adds is
        the ceremony step 7 requires of a creation the reader did not type as arguments: a plan they
        can read, and a yes bound to a `plan_id` the launcher revalidates under the registry lock.

        THE CATALOG READ HAPPENS FIRST AND OUTSIDE EVERY LOCK (D10), which is also what lets the
        Project question OFFER the active Projects rather than refusing a name the reader had no way
        to know.

        A REFUSED ANSWER RE-ASKS THE QUESTION IT CAME FROM, ruled 2026-09-11 by Eric after typing
        'Home Assistant Admin' and losing the whole attempt to the roster -- twice, because the second
        answer was a Project whose Hub did not exist yet. Both halves discarded work the reader had
        already done and neither said anything they could act on from that prompt. So: a malformed
        name is offered its own slug back, and a Project the gate refuses re-asks rather than exiting.
        Empty still cancels at either prompt, which is the only way out that is not an answer.

        THE SEAT'S OWN CHECKS RUN BEFORE THE PROJECT IS ASKED FOR, which is what `-SeatOnly` was built
        for: a reader whose real problem is a name some ownership row still cites must not pick a
        Project first and only then be told the name was never available.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [string]$McpUrl,
        [string]$ProjectId
    )
    $activeProjects = @()
    try { $activeProjects = @(Get-ActiveProjectSlugs -McpUrl $McpUrl -ProjectId $ProjectId) }
    catch {
        Write-Host "No seat was created: $($_.Exception.Message)"
        return $null
    }

    # --- The seat name, asked until it is one a seat could actually be created under --------------
    $newSeat = ''
    while (-not $newSeat) {
        $typedSeat = (Read-SeatPickerLine -Prompt 'New seat name (empty to cancel)').Trim()
        if ([string]::IsNullOrWhiteSpace($typedSeat)) {
            Write-Host 'No seat was created: nothing was typed.'
            return $null
        }
        # THE SLUG'S SHAPE IS THE RESOLVER'S RULE, never a second pattern written here.
        $resolvedSeat = Resolve-SeatName -Seat $typedSeat -StateDirectory $StateDirectory
        $candidate = ''
        if ([string]$resolvedSeat.status -cne 'named') {
            Write-Host "That cannot be a seat name: $([string]$resolvedSeat.message)"
            # THE SUGGESTION IS AN OFFER, NOT A CORRECTION. Typing a display name is the common way to
            # get here and slugging it silently would bind a seat to a name the reader never chose, so
            # it is shown and accepted by typing yes. Anything else re-asks, which is also what a
            # reader who wanted a different name entirely will do.
            $suggestion = Get-SeatNameSuggestion -Typed $typedSeat -StateDirectory $StateDirectory
            if ($suggestion) {
                $useIt = (Read-SeatPickerLine -Prompt "Use '$suggestion' instead? (yes to accept, anything else to retype)").Trim()
                if ($useIt -ceq 'yes') { $candidate = $suggestion }
            }
            if (-not $candidate) { continue }
        }
        else { $candidate = [string]$resolvedSeat.seat }

        $seatRefusal = ''
        $lock = Enter-SeatRegistryLock -Workspace $Workspace
        try {
            $registry = Read-SeatRegistry -StateDirectory $StateDirectory
            # THE GATE AS A VALUE, because an unusable name must come back with the gate's own sentence
            # rather than end the session. Test-NewSeatIsCreatable IS the assertion, caught -- the
            # rules stay in one function, and the two creation ROUTES keep calling the assertion
            # directly, which is what seat.creation-gate reads them for.
            $verdict = Test-NewSeatIsCreatable -Workspace $Workspace -StateDirectory $StateDirectory -Registry $registry `
                -Seat $candidate -ActiveProjects $activeProjects -SeatOnly
            if (-not [bool]$verdict.creatable) { $seatRefusal = [string]$verdict.reason }
        }
        finally { Exit-BookLock -Lock $lock }
        if ($seatRefusal) {
            Write-Host $seatRefusal
            continue
        }
        $newSeat = $candidate
    }

    # --- The Project, asked until the gate accepts it ---------------------------------------------
    Write-Host "Active Projects: $((@($activeProjects) | Sort-Object -CaseSensitive) -join ', ')"
    $newProject = ''
    $planId = ''
    while (-not $newProject) {
        $typedProject = (Read-SeatPickerLine -Prompt 'Project slug for this seat (empty to cancel)').Trim()
        if ([string]::IsNullOrWhiteSpace($typedProject)) {
            Write-Host 'No seat was created: no Project was named, and a seat is bound to exactly one.'
            return $null
        }

        # A SLUG THAT NAMES NO ACTIVE PROJECT IS AN OFFER RATHER THAN A REFUSAL (2026-09-11). This is
        # the branch, and it decides only what to ASK -- the gate below still decides what may be
        # created, against a catalog re-read from the collection rather than from this answer.
        if (@($activeProjects) -cnotcontains $typedProject) {
            $madeSlug = Invoke-SeatPickerHubCreation -ProjectSlug $typedProject -McpUrl $McpUrl -ProjectId $ProjectId -Workspace $Workspace
            if (-not $madeSlug) {
                Write-Host 'Name one of the active Projects above, or empty to cancel.'
                continue
            }
            # RE-READ RATHER THAN ASSUMED. Adding the slug to the local list by hand would make this
            # route the only one whose seat gate runs against a catalog nothing confirmed -- and a Hub
            # that was written but did not become active is exactly what the gate exists to catch.
            try { $activeProjects = @(Get-ActiveProjectSlugs -McpUrl $McpUrl -ProjectId $ProjectId) }
            catch {
                # THE HUB SURVIVES THIS, and saying so is the difference between a reader who types
                # `+` again and one who thinks the creation failed.
                Write-Host ("Project Hub '$typedProject' was created, but the catalog could not be re-read, so no seat " +
                            "was: $($_.Exception.Message) The Hub is there -- type + again to sit down at it.")
                return $null
            }
        }

        $refusal = ''
        $lock = Enter-SeatRegistryLock -Workspace $Workspace
        try {
            $registry = Read-SeatRegistry -StateDirectory $StateDirectory
            $verdict = Test-NewSeatIsCreatable -Workspace $Workspace -StateDirectory $StateDirectory -Registry $registry `
                -Seat $newSeat -Project $typedProject -ActiveProjects $activeProjects
            if ([bool]$verdict.creatable) { $planId = Get-SeatCreationPlanId -Registry $registry -Seat $newSeat -Project $typedProject }
            else { $refusal = [string]$verdict.reason }
        }
        finally { Exit-BookLock -Lock $lock }
        if ($refusal) {
            Write-Host $refusal
            Write-Host 'Name one of the active Projects above, or empty to cancel.'
            continue
        }
        $newProject = $typedProject
    }

    Write-Host ''
    Write-Host "Create seat '$newSeat' for Project '$newProject'."
    Write-Host "  Desk:     $(Join-Path (Get-SeatsDirectory $StateDirectory) $newSeat), created empty with projects/$newProject open"
    Write-Host '  Touches:  no other seat, and no shared-collection write.'
    Write-Host "  plan_id:  $planId"
    $answer = (Read-SeatPickerLine -Prompt 'Type yes to create it').Trim()
    if ($answer -cne 'yes') {
        Write-Host "No seat was created: the confirmation was '$answer' rather than yes."
        return $null
    }
    [pscustomobject]@{ seat = $newSeat; project = $newProject; approved_plan_id = $planId }
}

function Invoke-SeatPickerRetirement {
    <#
    .SYNOPSIS
        The `r<number>` route: `Retire-Seat.ps1`'s own preflight, shown, then its own approval.
        Returns `retired`, `declined` or `refused`.

    .DESCRIPTION
        THE REAL HELPER, IN PROCESS, TWICE. Retirement's gate is not re-worded here: the preflight
        that refuses a claimed seat before issuing a `plan_id`, the `plan_id` bound to the Desk it
        planned, and the archive-verify-then-remove order are all its. This shows what it reports and
        passes back the exact id it issued.

        IN PROCESS RATHER THAN AS A CHILD, because a `-File` call returns formatted TEXT across the
        process boundary and a caller projecting `.plan_id` off it receives an empty string. The
        helper takes the registry lock itself and this route holds none, so there is nothing for it
        to wait on.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Seat
    )
    $helper = Join-Path $PSScriptRoot 'Retire-Seat.ps1'
    $plan = $null
    try { $plan = & $helper -Seat $Seat -WorkspacePath $Workspace -Preflight }
    catch {
        Write-Host "Seat '$Seat' was not retired: $($_.Exception.Message)"
        return 'refused'
    }
    Write-Host ''
    Write-Host "Retire seat '$Seat' (Project $([string]$plan.project))."
    Write-Host "  Open Books:    $((@($plan.open_books) -join ', '))"
    Write-Host "  Open Projects: $((@($plan.open_projects) -join ', '))"
    Write-Host "  Archived to:   $([string]$plan.archive_destination)"
    Write-Host "  plan_id:       $([string]$plan.plan_id)"
    Write-Host '  The Desk is the only durable record of what was open, so it is archived rather than discarded.'
    $answer = (Read-SeatPickerLine -Prompt "Type yes to retire '$Seat'").Trim()
    if ($answer -cne 'yes') {
        Write-Host "Seat '$Seat' was not retired: the confirmation was '$answer' rather than yes."
        return 'declined'
    }
    try {
        $done = & $helper -Seat $Seat -WorkspacePath $Workspace -UserConfirmed -ApprovedPlanId ([string]$plan.plan_id)
        Write-Host "Seat '$Seat' retired. Its Desk is at $([string]$done.archive_directory)."
        return 'retired'
    }
    catch {
        Write-Host "Seat '$Seat' was not retired: $($_.Exception.Message)"
        return 'refused'
    }
}

function New-SeatPickerDecision {
    <#
    .SYNOPSIS
        One chosen seat, carrying whether this tab is retitled for it and the handle to do it with.

    .DESCRIPTION
        THE TAB IS DECIDED HERE AND RENAMED LATER, which is the half that survived the question going
        away on 2026-09-14. A tab titled `seat: x` before the claim is taken would be a title for a
        seat the acquisition may still refuse, so the decision travels and the launcher performs the
        rename once it actually holds the seat.

        IT ASKS NOTHING AT ALL NOW, and this is the function where that is visible. Every route out of
        the picker builds a decision, so a prompt here was the last thing between a reader and their
        agent on all four of them -- and its only other outcome was a tab named for the button rather
        than the seat. `Get-SeatPickerTabRename` carries the reasoning.

        NO HANDLE, NO RENAME. `ORCA_TERMINAL_HANDLE` is set only inside an Orca-managed terminal, so
        anywhere else this does nothing rather than shelling out to something that cannot work.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Seat,
        [string]$Project,
        [string]$ApprovedPlanId,
        [string]$ConversationId,
        [Parameter(Mandatory = $true)][ValidateSet('resume', 'restart', 'new', 'create')][string]$Action,
        [string]$TerminalHandle
    )
    $tab = Get-SeatPickerTabRename -TerminalHandle $TerminalHandle
    [pscustomobject]@{
        seat = $Seat
        project = $Project
        approved_plan_id = $ApprovedPlanId
        conversation_id = $ConversationId
        action = $Action
        rename_tab = [bool]$tab.rename
        terminal_handle = [string]$tab.handle
    }
}

function Invoke-SeatPicker {
    <#
    .SYNOPSIS
        Render the roster and act on what the reader types, until a seat is chosen or they quit.
        Returns the decision New-SeatPickerDecision builds, or `$null` when nothing was chosen.

    .DESCRIPTION
        IT CHOOSES; IT DOES NOT ENTER. The seat this returns is entered by the launcher's ordinary
        path, so a seat that went `held` between the render and the choice is refused by
        `Enter-SeatClaim`'s atomic acquisition, exactly as a typed `-Seat` would be. A picker that
        checked the state itself would move that authority to a probe and leave the acquisition's own
        refusal exercised by nothing.

        RETIREMENT LOOPS AND EVERYTHING ELSE RETURNS, because retiring a seat changes the list the
        reader is choosing from and leaves them still needing to choose.

        AN IF-CHAIN RATHER THAN A `switch`, deliberately. `continue` inside a switch continues the
        SWITCH's own input, not the enclosing loop, and `$_` inside a switch branch is the condition
        value rather than anything the branch is working on -- two traps this repository has paid for
        elsewhere, for the price of three extra keywords here.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [AllowEmptyCollection()][string[]]$InputLines = @(),
        [string]$TranscriptRoot,
        [string]$McpUrl,
        [string]$ProjectId,
        [string]$TerminalHandle,
        # THE RENDER'S OWN TWO ARGUMENTS, for a suite that must reach the narrow layout. A redirected
        # run measures a real host, so without these the card path would be shipped code no check has
        # ever drawn. Neither changes what the picker DOES -- both are display.
        [int]$Width = 0,
        [switch]$ForcePlain
    )
    $script:SeatPickerScriptedInput = $null
    if (@($InputLines).Count) {
        $script:SeatPickerScriptedInput = [Collections.Generic.Queue[string]]::new()
        foreach ($line in @($InputLines)) { $script:SeatPickerScriptedInput.Enqueue([string]$line) }
    }
    # THE CONSOLE ENCODING IS RAISED FOR A HUMAN AND LEFT ALONE FOR EVERYTHING ELSE. Measured
    # 2026-09-11: a fresh powershell.exe runs at codepage 437, where the frame degrades to CP437's
    # own box characters but the state marks become '?' outright. Raising it is what makes the
    # Unicode alphabet safe to use -- and a redirected run never reaches here, so nothing that
    # CAPTURES this picker has its bytes changed underneath it. Restored in the finally, because
    # this setting is process-global and the agent is launched by our caller afterwards.
    $previousEncoding = $null
    if (-not (Get-SeatPickerRenderPlan -Width $Width -ForcePlain:$ForcePlain).ascii) {
        try {
            $previousEncoding = [Console]::OutputEncoding
            [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
        }
        catch { $previousEncoding = $null }
    }
    $bannerDrawn = $false
    try {
        while ($true) {
            $rows = @(Show-SeatPickerRoster -StateDirectory $StateDirectory -TranscriptRoot $TranscriptRoot `
                -Width $Width -ForcePlain:$ForcePlain -Banner:(-not $bannerDrawn))
            $bannerDrawn = $true
            $choice = Resolve-SeatPickerChoice -Choice (Read-SeatPickerLine -Prompt 'Seat') -RowCount $rows.Count
            $action = [string]$choice.action

            if ($action -ceq 'quit') {
                Write-Host 'No seat was chosen.'
                return $null
            }
            elseif ($action -ceq 'create') {
                $creation = Invoke-SeatPickerCreation -Workspace $Workspace -StateDirectory $StateDirectory `
                    -McpUrl $McpUrl -ProjectId $ProjectId
                if ($null -ne $creation) {
                    return (New-SeatPickerDecision -Seat ([string]$creation.seat) -Project ([string]$creation.project) `
                        -ApprovedPlanId ([string]$creation.approved_plan_id) -ConversationId (New-SeatConversationId) `
                        -Action 'create' -TerminalHandle $TerminalHandle)
                }
            }
            elseif ($action -ceq 'retire') {
                $target = $rows[[int]$choice.index - 1]
                Invoke-SeatPickerRetirement -Workspace $Workspace -Seat ([string]$target.seat) | Out-Null
            }
            elseif ($action -ceq 'resume') {
                $target = $rows[[int]$choice.index - 1]
                # THREE ARMS, AND THE ROW ALREADY HOLDS WHICH ONE. `entry_action` is derived in
                # SeatConversation.ps1 beside the transcript fact it turns on, so the roster line the
                # reader just read and the decision their number makes cannot disagree.
                $entryAction = [string]$target.entry_action
                if ([string]::IsNullOrWhiteSpace([string]$target.session_id) -or $entryAction -ceq 'none') {
                    # ITS OWN REFUSAL, because the fix is a different keystroke rather than a
                    # different number: this seat records no conversation, and step 8 is what will
                    # give a seat more than the one its binding remembers.
                    Write-Host ("Seat '$([string]$target.seat)' has no conversation on record, so there is nothing to " +
                                "resume. Type n$([int]$choice.index) to start a new conversation there.")
                }
                else {
                    # SAID BEFORE IT HAPPENS, not discovered afterwards. The reader typed a number
                    # meaning "put me back", and they are being put back into a conversation that
                    # holds nothing -- which is a different thing from the resume they asked for even
                    # though it costs them no keystroke.
                    if ($entryAction -ceq 'restart') {
                        Write-Host ("Conversation $([string]$target.session_id) started at seat " +
                                    "'$([string]$target.seat)' and recorded nothing, so it is being started rather " +
                                    'than resumed. Nothing is lost: there is nothing in it.')
                    }
                    $decisionAction = $(if ($entryAction -ceq 'restart') { 'restart' } else { 'resume' })
                    return (New-SeatPickerDecision -Seat ([string]$target.seat) -Project ([string]$target.project) `
                        -ConversationId ([string]$target.session_id) -Action $decisionAction -TerminalHandle $TerminalHandle)
                }
            }
            elseif ($action -ceq 'new') {
                $target = $rows[[int]$choice.index - 1]
                return (New-SeatPickerDecision -Seat ([string]$target.seat) -Project ([string]$target.project) `
                    -ConversationId (New-SeatConversationId) -Action 'new' -TerminalHandle $TerminalHandle)
            }
            else {
                Write-Host ([string]$choice.reason)
            }
        }
    }
    finally {
        $script:SeatPickerScriptedInput = $null
        if ($null -ne $previousEncoding) { try { [Console]::OutputEncoding = $previousEncoding } catch { } }
    }
}

function Get-SeatPickerLaunchArguments {
    <#
    .SYNOPSIS
        The agent arguments one picker decision implies: `--resume <id>` for a conversation that
        already exists, `--session-id <id>` for one this launcher minted.

    .DESCRIPTION
        MEASURED FROM `claude --help` ON THE INSTALLED BINARY (2.1.267, read 2026-09-10):
        `-r, --resume [value]` resumes a conversation by session id, and `--session-id <uuid>` uses a
        specific session id for the conversation. Declared here so the argv is one value a suite can
        read rather than a string built at the call site.

        A RESUME IS NOT REFUSED FOR A MISSING TRANSCRIPT. The roster says when it could not find one
        -- a redirected configuration, another machine, a pruned history -- and a transcript not
        found is not a deleted transcript. What to do about that is the reader's, and `claude` is the
        authority on whether it can resume its own conversation.

        EXCEPT WHERE THE LAUNCHER IS THE AUTHORITY, WHICH IS WHAT `restart` IS (2026-09-11). An id
        this checkout's own launcher minted has no elsewhere to be -- `.claude/seats/` is gitignored,
        so that record was written here -- and a conversation that recorded nothing cannot be resumed
        by anything. It is started again under its own id instead, which is why `restart` composes
        `--session-id` rather than `--resume`. The derivation, the measurement behind it and the
        narrowing are in `Get-SeatConversationEntryAction`.
    #>
    param([Parameter(Mandatory = $true)][object]$Decision)
    $conversation = [string]$Decision.conversation_id
    if ([string]::IsNullOrWhiteSpace($conversation)) { return @() }
    if ([string]$Decision.action -ceq 'resume') { return @('--resume', $conversation) }
    # `restart`, `new` AND `create` ALL MINT-OR-REUSE AN ID NO TRANSCRIPT ANSWERS TO, which is the one
    # thing --session-id needs to be true. It refuses an id that already has one, so a `restart`
    # derived wrongly fails at the agent rather than forking a second conversation onto one id.
    @('--session-id', $conversation)
}
