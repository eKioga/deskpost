<#
.SYNOPSIS
    `library init <folder>`: make a directory a Library workspace, and tell this machine about it.

.DESCRIPTION
    PLAN-public-release.md step 20. Until this file existed there was no such thing as creating a
    workspace -- a workspace was wherever the program happened to be checked out, which is why every
    hook and every helper could get away with answering "which workspace" by looking at its own
    location. `tools/WorkspaceRegistry.ps1` gave that question a real answer on 2026-09-20 (S10) and
    S12 wired the hooks to ask it. Both were inert until something wrote a marker. This writes it.

    FIVE THINGS, AND THE ORDER IS THE SAFETY.

      1. `.library/workspace.json`      the marker, which is what MAKES a directory a workspace
      2. `~/.library/workspaces.json`   the registry, an index over markers and never the authority
      3. `CLAUDE.md` / `AGENTS.md`      the operating rules, whole when absent, a managed SECTION when not
      4. `.mcp.json`, `.claude/settings.json`   merged, never overwritten
      5. `.codex/hooks.json`, `.codex/config.toml`   the same guards and reader, for the other harness

    Steps 3 and 4 touch files the reader may have written themselves, so both are preflighted
    together BEFORE anything is written: a run that would refuse at step 4 must not have already
    rewritten the reader's CLAUDE.md at step 3. Nothing here is gated -- creating a workspace is an
    additive, reversible act -- but a half-applied one is not, so it is applied as a plan.

    THIS TOOL'S OWN FIRST RUN IS DAY-ONE DATA FOR EVERY INVARIANT IT INTRODUCES, which is not a
    slogan here but the reason for two specific decisions. `D:\Library` is an UN-SPLIT checkout: the
    program and the workspace are one directory, it has no marker, and until this runs the registry
    on this machine is empty. So (a) re-running init must be idempotent rather than an error, because
    the first thing anyone does with a new tool is run it twice; and (b) an existing marker keeps its
    id and its created stamp, because a workspace's identity is not something a re-run gets to
    reissue -- the registry, the Desk and eventually the collection's ownership record all key on it.

    ATTACHMENT IS READ-ONLY BY DEFAULT (step 21). `writable` in the marker is a REQUEST recorded at
    init time, not a role held: `tools/Set-CollectionOwner.ps1 -Acquire` is what grants the writable
    role, by exclusive create of one per-incarnation claim record under the collection's own
    `.owner/` directory, and nothing here acquires it. A marker that said `writable: true` and meant
    nothing would be worse than one that says false. (Step 21's plan text said a single
    `collection/.owner` FILE; a single file cannot be handed from one owner to the next atomically,
    which is why the record is a directory -- docs/collection-ownership.md.)
#>
[CmdletBinding()]
param(
    # The folder to make a workspace. Defaults to the current directory, which is what `library init`
    # with no argument means.
    [string]$Path,
    [string]$McpUrl,
    [string]$CollectionId,
    # Recorded in the marker as a request; step 21's ownership file is what actually grants it.
    [switch]$Writable,
    # Refresh the managed sections and the marker's program version against an existing workspace.
    [switch]$Force,
    # Fixtures point the registry somewhere of their own. Callers pass nothing.
    [string]$RegistryRoot,
    [switch]$Json,
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
. (Join-Path $PSScriptRoot 'AtomicFile.ps1')
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
# The catalog renderer and the empty master index's text (S42), each the one its own writers use.
. (Join-Path $PSScriptRoot 'ShelfCatalog.ps1')
. (Join-Path $PSScriptRoot 'NotebookIndex.ps1')
# For Get-HookEntryText: a hook entry's path arrives through `command` in one layout and through
# `args` in the other, and one reader of that shape is enough for this tree.
# HookRegistry.ps1 also brings Test-ClaudeHookShape, which used to live in PluginPackage.ps1 and
# moved here on 2026-09-21 so this file could reach it. PluginPackage.ps1 declares a param block, and
# dot-sourcing a file that does REBINDS the caller's variables to that block's defaults -- measured
# the moment it was tried here: `-SelfTest` became $false, the self-test was skipped, and the run
# fell through and initialised the PROGRAM ROOT as a workspace. That is the hazard
# `powershell.dot-sourced-files-declare-no-parameters` exists for, met from the one direction it
# could not see, because nothing had ever dot-sourced that file before.
. (Join-Path $PSScriptRoot 'HookRegistry.ps1')
# The Codex half of the same boundary: one renderer for the hooks document both harnesses' files
# are built from, and the trust reader the gate needs. No param() block, so dot-sourcing is safe.
. (Join-Path $PSScriptRoot 'CodexBindings.ps1')

$script:Utf8 = [Text.UTF8Encoding]::new($false)
$script:SectionBegin = '<!-- library:begin -->'
$script:SectionEnd = '<!-- library:end -->'
$script:InstructionFiles = @('CLAUDE.md', 'AGENTS.md')

# ==================================================================================================
# THE MARKER
# ==================================================================================================
function Get-LibraryProgramVersion {
    <#
        The version the workspace was initialised by, read from the package manifest rather than
        kept as a second literal. A version this file spelled itself would be a copy that drifts.

        IT DRIFTED ANYWAY, BY ADDRESS RATHER THAN BY VALUE. Until 2026-09-21 this looked for
        `plugin/plugin.json`, which is where the package lived until the plugin root became the
        PROGRAM root and the canonical manifests moved under `.codex-plugin/`. Nothing failed: the
        read returns 'unknown' when the file is absent, so every workspace initialised after the
        move quietly recorded `program_version: unknown`. Two markers on this machine date it --
        D:\Library's, written 2026-09-20, says 0.1.0, and the one written the next day says unknown.

        So the address is not spelled here at all any more. `Read-PluginCanonical` owns where the
        canonical manifests live and throws when the package is incomplete; this asks it, and keeps
        'unknown' for that throw, because a program whose package is broken can still initialise a
        workspace and should say so in the marker rather than refuse.
    #>
    param([string]$ProgramRoot)
    # SPELLED HERE RATHER THAN ASKED OF tools/PluginPackage.ps1, which owns this address, and the
    # reason is worth the duplication. That module is a SCRIPT with its own
    # `param([switch]$SelfTest, ...)`, and a dot-sourced param block binds in the CALLER: loading it
    # from here silently cleared this script's own -SelfTest, so `-SelfTest` ran the real
    # initialisation against the current directory instead. Measured 2026-09-21, twice, on the
    # program root. `plugin.generated-files-match` is what catches this literal drifting from the
    # package it names.
    $manifest = Join-Path $ProgramRoot (Join-Path '.codex-plugin' 'plugin.json')
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return 'unknown' }
    try {
        $doc = [IO.File]::ReadAllText($manifest, $script:Utf8) | ConvertFrom-Json
        $version = Get-WorkspaceMarkerField $doc 'version'
        if ([string]::IsNullOrWhiteSpace($version)) { return 'unknown' }
        return $version
    }
    catch { return 'unknown' }
}

function New-WorkspaceMarkerContent {
    <#
        The marker's fields, as step 20 names them: workspace id, program version, collection id and
        backend, writable flag, created stamp.

        THE BACKEND IS DERIVED FROM WHETHER AN ENDPOINT IS CONFIGURED, not asked for separately. A
        workspace with no endpoint is `local` and says so; one with an endpoint is `basic-memory`.
        Two fields that can disagree about the same fact are two chances to be wrong.
    #>
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$ProgramVersion,
        [string]$CollectionId,
        [string]$McpUrl,
        [bool]$Writable,
        [Parameter(Mandatory)][string]$Created
    )
    [ordered]@{
        id              = $Id
        program_version = $ProgramVersion
        collection_id   = [string]$CollectionId
        backend         = if ([string]::IsNullOrWhiteSpace($McpUrl)) { 'local' } else { 'basic-memory' }
        writable        = $Writable
        created         = $Created
    }
}

# ==================================================================================================
# THE MANAGED SECTION
# ==================================================================================================
# A workspace's CLAUDE.md is very often the reader's own file with their own project in it. The rule
# the step sets is narrow and is the whole reason this is not a template copy: insert or update ONE
# section between the markers, touch nothing outside it, and refuse if the markers are malformed.
#
# MALFORMED IS A REFUSAL AND NOT A REPAIR, deliberately. Every repair this could attempt -- treating
# a lone begin as "append an end at EOF", taking the first of two blocks, ignoring an inverted pair
# -- guesses at where the reader's own words stop. Guessing wrong silently deletes prose somebody
# wrote. A refusal costs one message and loses nothing.
function Get-ManagedSectionPlan {
    <#
        What this file needs, as one of: `create` (no file), `append` (file, no markers),
        `replace` (file, one well-formed pair), `unchanged`, or a `refuse` carrying its reason.
    #>
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string]$Body
    )

    $block = $script:SectionBegin + "`n" + $Body.TrimEnd() + "`n" + $script:SectionEnd

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        return [pscustomobject]@{ action = 'create'; content = $block + "`n"; reason = $null }
    }

    $text = [IO.File]::ReadAllText($FilePath, $script:Utf8)
    $begins = [regex]::Matches($text, [regex]::Escape($script:SectionBegin))
    $ends = [regex]::Matches($text, [regex]::Escape($script:SectionEnd))

    if ($begins.Count -eq 0 -and $ends.Count -eq 0) {
        # A file with no markers keeps every byte it has; the section is appended after it.
        $separator = if ($text.EndsWith("`n")) { "`n" } else { "`n`n" }
        return [pscustomobject]@{ action = 'append'; content = $text + $separator + $block + "`n"; reason = $null }
    }

    if ($begins.Count -ne 1 -or $ends.Count -ne 1) {
        return [pscustomobject]@{
            action = 'refuse'
            content = $null
            reason = ("$FilePath carries $($begins.Count) '$($script:SectionBegin)' marker(s) and $($ends.Count) " +
                      "'$($script:SectionEnd)' marker(s). A managed section needs exactly one of each, and which of " +
                      'these encloses the managed text cannot be established without guessing at where your own ' +
                      'writing stops. Repair the markers by hand, or remove them and re-run.')
        }
    }

    $beginAt = $begins[0].Index
    $endAt = $ends[0].Index
    if ($endAt -lt $beginAt) {
        return [pscustomobject]@{
            action = 'refuse'
            content = $null
            reason = ("$FilePath has '$($script:SectionEnd)' before '$($script:SectionBegin)', so the managed section " +
                      'has no inside. Repair the markers by hand, or remove them and re-run.')
        }
    }

    $before = $text.Substring(0, $beginAt)
    $after = $text.Substring($endAt + $script:SectionEnd.Length)
    $rebuilt = $before + $block + $after
    if ($rebuilt -ceq $text) { return [pscustomobject]@{ action = 'unchanged'; content = $text; reason = $null } }
    [pscustomobject]@{ action = 'replace'; content = $rebuilt; reason = $null }
}

# ==================================================================================================
# THE HARNESS SETTINGS MERGE
# ==================================================================================================
# "Merges without overwriting unrelated entries, refusing on a conflict it cannot merge."
#
# WHAT A CONFLICT IS, EXACTLY. Every leaf this tool wants to set is compared with what is there:
#
#   absent          set it
#   present, equal  leave it, and report nothing changed
#   present, other  REFUSE, naming the key, both values and the remedy
#
# A list is merged by VALUE and never replaced: the permission allowlist is a set, and a reader's own
# entries are theirs. A nested object recurses. Anything the tool does not name is not read and not
# written -- which is what "unrelated entries" means, and it is checked by a fixture whose settings
# file carries entries this tool has never heard of.
function Merge-LibraryJsonValue {
    <#
        Returns @{ value = <merged>; changed = <bool>; conflicts = @(<text>) }. Conflicts are
        COLLECTED rather than thrown on the first one, so a reader who has three of them is told
        about three of them instead of discovering them one run at a time.
    #>
    param(
        [AllowNull()]$Existing,
        [AllowNull()]$Desired,
        [Parameter(Mandatory)][string]$KeyPath
    )

    $conflicts = [Collections.Generic.List[string]]::new()

    if ($null -eq $Existing) { return @{ value = $Desired; changed = $true; conflicts = @() } }

    if ($Desired -is [System.Collections.IDictionary]) {
        # A scalar where an object is wanted cannot be merged into.
        if ($Existing -isnot [psobject] -or $Existing -is [string] -or $Existing -is [Array]) {
            return @{ value = $Existing; changed = $false; conflicts = @("$KeyPath holds a value where the Library needs an object") }
        }
        $merged = [ordered]@{}
        foreach ($property in @($Existing.PSObject.Properties)) { $merged[[string]$property.Name] = $property.Value }
        $changed = $false
        foreach ($key in @($Desired.Keys)) {
            # ASSIGNED IN A STATEMENT, NOT PASSED AS `$(if ...)`. It was written as a subexpression,
            # and a subexpression puts its branch's output on the PIPELINE -- where a one-element
            # array unrolls to a bare scalar. A settings.json whose `allow` list held exactly one
            # entry therefore arrived here as a string, the list branch below said "holds a value
            # where the Library needs a list", and `library init` refused a perfectly ordinary file.
            # Defect family 2, production side, wearing `if` clothing: the same shape recorded at
            # .claude/hooks/HookContext.ps1's Set-HookServed, reproduced three weeks later.
            $existingChild = $null
            if ($merged.Contains([string]$key)) { $existingChild = $merged[[string]$key] }
            $child = Merge-LibraryJsonValue -Existing $existingChild `
                -Desired $Desired[$key] -KeyPath "$KeyPath.$key"
            foreach ($conflict in @($child.conflicts)) { [void]$conflicts.Add($conflict) }
            if ($child.changed) { $merged[[string]$key] = $child.value; $changed = $true }
        }
        return @{ value = $merged; changed = $changed; conflicts = @($conflicts) }
    }

    if ($Desired -is [Array]) {
        if ($Existing -isnot [Array]) {
            return @{ value = $Existing; changed = $false; conflicts = @("$KeyPath holds a value where the Library needs a list") }
        }
        # @() on BOTH sides: a one-element JSON array round-trips as a bare scalar, and `-contains`
        # against a bare string is a substring-free equality that silently reads as "already there"
        # for the wrong reason.
        $merged = [Collections.Generic.List[object]]::new()
        foreach ($item in @($Existing)) { [void]$merged.Add($item) }
        $changed = $false
        foreach ($item in @($Desired)) {
            if (@($merged) -ccontains $item) { continue }
            [void]$merged.Add($item)
            $changed = $true
        }
        return @{ value = @($merged); changed = $changed; conflicts = @() }
    }

    if ($Existing -ceq $Desired) { return @{ value = $Existing; changed = $false; conflicts = @() } }
    @{ value = $Existing; changed = $false; conflicts = @("$KeyPath is '$Existing' where the Library needs '$Desired'") }
}

function Get-JsonMergePlan {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Desired
    )

    $existing = $null
    if (Test-Path -LiteralPath $FilePath -PathType Leaf) {
        $text = [IO.File]::ReadAllText($FilePath, $script:Utf8)
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            try { $existing = $text | ConvertFrom-Json }
            catch {
                return [pscustomobject]@{
                    action = 'refuse'; content = $null
                    reason = "$FilePath is not readable JSON, so the Library's entries cannot be merged into it without replacing what is there."
                }
            }
        }
    }

    $result = Merge-LibraryJsonValue -Existing $existing -Desired $Desired -KeyPath (Split-Path -Leaf $FilePath)
    if (@($result.conflicts).Count) {
        return [pscustomobject]@{
            action = 'refuse'; content = $null
            reason = ("$FilePath cannot be merged: " + (@($result.conflicts) -join '; ') +
                      '. Reconcile those entries by hand and re-run; nothing has been written.')
        }
    }
    if (-not $result.changed) { return [pscustomobject]@{ action = 'unchanged'; content = $null; reason = $null } }
    # Depth 12: the settings file nests hooks -> matcher -> hooks -> command, and ConvertTo-Json
    # silently renders anything deeper as a type name.
    [pscustomobject]@{ action = 'merge'; content = (($result.value | ConvertTo-Json -Depth 12) + "`n"); reason = $null }
}

function Get-DesiredPermissionAllowlist {
    <#
        The permission entries a workspace needs so the validated reader's tools do not raise a
        prompt on every read.

        DERIVED FROM THE PROGRAM'S OWN SETTINGS, NEVER SPELLED OUT HERE. A second list of tool names
        is a copy, and `docs/mcp-tool-allowlist-check.md` already settled that argument for this
        tree: the tool list is asked of the thing that has it, not kept beside it. The program's
        `.claude/settings.json` is what the gate checks against the live adapter, so taking the
        `mcp__validated-book-reader__*` entries from there means a tool added to the reader reaches a
        newly initialised workspace by the same edit that makes the gate pass.

        AN EMPTY RESULT IS NOT AN ERROR. A packaged install supplies the server through the plugin
        under a different, harness-composed prefix (step 19), and there is nothing here to copy.
    #>
    param([Parameter(Mandatory)][string]$ProgramRoot)

    $settings = Join-Path $ProgramRoot (Join-Path '.claude' 'settings.json')
    if (-not (Test-Path -LiteralPath $settings -PathType Leaf)) { return @() }
    $doc = $null
    try { $doc = [IO.File]::ReadAllText($settings, $script:Utf8) | ConvertFrom-Json } catch { return @() }
    $permissions = Get-WorkspaceMarkerField $doc 'permissions'
    if ($null -eq $permissions) { return @() }
    # Get-WorkspaceMarkerField stringifies, which is right for an id and wrong for a list; the
    # permissions object is read off the document directly for that reason.
    $names = @($doc.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -notcontains 'permissions') { return @() }
    $allowNames = @($doc.permissions.PSObject.Properties | ForEach-Object { $_.Name })
    if ($allowNames -notcontains 'allow') { return @() }
    @(@($doc.permissions.allow) | Where-Object { [string]$_ -clike 'mcp__validated-book-reader__*' } | Sort-Object)
}

function Get-DesiredMcpServers {
    <#
        The reader's own `.mcp.json` entry for the validated reader, for a DIRECT install. A plugin
        install supplies the same server through the package and needs no entry here at all.

        TWO DIRECT LAYOUTS, AND THE SECOND ONE HAS TO NAME ITSELF. Where the adapter sits in the
        workspace, its own anchor IS the workspace and it binds correctly with no help. Where it
        sits in the PROGRAM -- which is every split install, including this machine's after step 22
        -- the anchor is the program, and the program is not a workspace at all; the only thing then
        left to answer "which Library" is whatever directory the harness happened to launch the
        server in. The adapter's own contract, at its line 40, is that an explicit `-StateDirectory`
        names the workspace. So it is named, rather than derived from a cwd nobody here controls.
    #>
    param(
        [Parameter(Mandatory)][string]$AdapterPath,
        [string]$StateDirectory
    )
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $AdapterPath)
    if (-not [string]::IsNullOrWhiteSpace($StateDirectory)) {
        $arguments = @($arguments + @('-StateDirectory', $StateDirectory))
    }
    [ordered]@{
        mcpServers = [ordered]@{
            'validated-book-reader' = [ordered]@{
                command = 'powershell.exe'
                args    = $arguments
            }
        }
    }
}

# ==================================================================================================
# THE GUARDS, IN A SPLIT WORKSPACE
# ==================================================================================================
# WHY `library init` REGISTERS HOOKS, WHEN THE SPLIT DESIGN SAYS HOOKS ARE THE PLUGIN'S JOB.
#
# It said so, and until 2026-09-21 this tool wrote only the permission allowlist on that basis. What
# the first session rooted in a split workspace found is that the plugin supplies nothing: its
# components do not activate (S14, four controlled negatives), and its package declares FOUR of the
# program's nine hooks, two of them under Codex tool names -- `^apply_patch$` and `^(Bash|exec)$` --
# that a Claude session never emits. So there was no route at all by which a session sitting inside
# a workspace was guarded: no Desk boundary, no closed-Book guard, no shell Shelf guard, and no
# check that reported any of it. A workspace nobody can sit in safely is not a split, it is a hole.
#
# THE PRICE, NAMED RATHER THAN HIDDEN. These entries carry ABSOLUTE paths into the program, because
# `${CLAUDE_PROJECT_DIR}` in a workspace session resolves to the workspace and the hooks are not
# there. That makes them pointers, and a program that moves must rewrite them -- which is what the
# cutover protocol's pointer stage (step 6c) exists for, and what a re-run of `library init` does in
# one step. They are deliberately NOT mirrored into the marker: the registered paths are the
# pointer, and a second copy of a fact is a second chance to be wrong.
#
# OWNERSHIP IS READ FROM THE ENTRIES THEMSELVES rather than kept in a fingerprint file. A block
# whose every entry names a script under this program's hook directory is one this tool wrote, and
# it is replaced whole -- which is how a retired hook LEAVES, where a merge would union the old
# entry back in and leave a registration pointing at a script that no longer exists. Anything else
# is the reader's, and the reader's work is refused rather than overwritten.
function ConvertTo-ProgramRootedValue {
    <#
        The program's own hook registrations with `${CLAUDE_PROJECT_DIR}` resolved to the program
        root, so they can be read from a session whose project directory is the workspace.

        Forward slashes on purpose: the program's own settings spell the rest of the path that way,
        PowerShell accepts either, and one separator in one string beats two.
    #>
    param([AllowNull()]$Value, [Parameter(Mandatory)][string]$ProgramRoot)

    $rooted = ([string]$ProgramRoot).Replace('\', '/').TrimEnd('/')
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) { return ([string]$Value).Replace('${CLAUDE_PROJECT_DIR}', $rooted) }
    if ($Value -is [Array]) {
        # THE LEADING COMMA IS THE WHOLE OF THIS BRANCH'S CORRECTNESS, AND ITS ABSENCE SHIPPED TWICE.
        # `return @(...)` UNROLLS a one-element array on the way out of a function, so every hook
        # event holding exactly one matcher came back as a bare object -- and `ConvertTo-Json` then
        # wrote an object where Claude Code requires an array. Measured 2026-09-21, the first time
        # any session was rooted in the reader's workspace: five of the six events and two of the
        # three PreToolUse entries were objects, and the harness answered
        #
        #   Hook event "SessionStart" must be an array of matchers; received object. This entry was
        #   ignored. ... Files with errors are skipped entirely, not just the invalid settings.
        #
        # So the workspace ADR-0036 exists to guard had NO guards at all, which is the exact hole
        # that ADR was written to close. S13 found this same defect in ConvertTo-ClaudeHookRoot and
        # fixed it there; this is defect family 2 in tools/../.claude/rules/library-development.md,
        # and `,` is the documented remedy. Do not "tidy" it away.
        $items = @(@($Value) | ForEach-Object { ConvertTo-ProgramRootedValue -Value $_ -ProgramRoot $ProgramRoot })
        return , $items
    }
    if ($Value -is [System.Management.Automation.PSCustomObject] -or $Value -is [System.Collections.IDictionary]) {
        $map = [ordered]@{}
        $properties = if ($Value -is [System.Collections.IDictionary]) {
            @(@($Value.Keys) | ForEach-Object { [pscustomobject]@{ Name = $_; Value = $Value[$_] } })
        }
        else { @($Value.PSObject.Properties) }
        foreach ($property in $properties) {
            $map[[string]$property.Name] = ConvertTo-ProgramRootedValue -Value $property.Value -ProgramRoot $ProgramRoot
        }
        return $map
    }
    $Value
}

function Get-ProgramHookDirectory([string]$ProgramRoot) {
    Join-Path $ProgramRoot (Join-Path '.claude' 'hooks')
}

function Get-DesiredHookRegistration {
    <#
        The hook block a split workspace needs, DERIVED FROM THE PROGRAM'S OWN SETTINGS and never
        spelled out here -- the same rule, and for the same reason, as the permission allowlist
        above it: a hook added to the program reaches a newly initialised workspace by the edit that
        registers it, rather than by somebody remembering this file exists.

        $null when the program declares none, which is not an error: a packaged install is expected
        to have its hooks supplied by the plugin, and an un-split checkout is skipped by its caller.
    #>
    param([Parameter(Mandatory)][string]$ProgramRoot)

    $settings = Join-Path $ProgramRoot (Join-Path '.claude' 'settings.json')
    if (-not (Test-Path -LiteralPath $settings -PathType Leaf)) { return $null }
    $doc = $null
    try { $doc = [IO.File]::ReadAllText($settings, $script:Utf8) | ConvertFrom-Json } catch { return $null }
    if ($null -eq $doc) { return $null }
    $names = @($doc.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -cnotcontains 'hooks' -or $null -eq $doc.hooks) { return $null }
    $rooted = ConvertTo-ProgramRootedValue -Value $doc.hooks -ProgramRoot $ProgramRoot

    # AND IT IS JUDGED BEFORE IT IS OFFERED, by the judge S13 already wrote for the plugin.
    #
    # THE TRANSFORM ABOVE IS NOT SELF-EVIDENTLY SHAPE-PRESERVING, and for three days it was not. It
    # rebuilds every node, so any unrolling defect in it emits a block the harness silently skips --
    # and "silently" is the word that matters, because the failure lands in a reader's session rather
    # than in this process. A round trip through a serializer deserves a judge on the far side, and
    # there is no reason to write a second one: `Test-ClaudeHookShape` asks exactly this question,
    # per event and per matcher, and `plugin.generated-files-match` was green over the same defect in
    # the package for exactly as long as nothing asked it.
    #
    # IT THROWS RATHER THAN RETURNING $null. A null here reads as "the program declares no hooks",
    # which is a legitimate state its caller skips quietly -- the one answer this must never give,
    # since it would register nothing and report success.
    # JUDGED ON THE SERIALIZED FORM, NOT THE OBJECT IN HAND. The round trip through ConvertTo-Json
    # and back is precisely what the harness will read, and it is where the unrolling shows up: an
    # in-memory check would also have to decide what an OrderedDictionary means, which is a second
    # opinion about a question the serializer already answers.
    $asWritten = ([ordered]@{ hooks = $rooted } | ConvertTo-Json -Depth 12) | ConvertFrom-Json
    $faults = @(Test-ClaudeHookShape -Document $asWritten -Label "the hook block derived from $settings")
    if ($faults.Count) {
        throw ('The hook block derived from ' + $settings + ' is not a shape Claude Code will load, so it was not ' +
               'written: ' + ($faults -join '; ') + '. A file with a malformed hooks block is skipped ENTIRELY by ' +
               'the harness, so writing it would leave the workspace with no Desk boundary and no closed-Book guard.')
    }
    $rooted
}

function Get-WorkspaceHookOwnership {
    <#
        Who wrote the hook block that is already there: `absent`, `library` or `foreign`, with the
        entries that make it foreign named so the refusal can name them too.
    #>
    param([AllowNull()]$ExistingHooks, [Parameter(Mandatory)][string]$HookDirectory)

    if ($null -eq $ExistingHooks) { return [pscustomobject]@{ kind = 'absent'; foreign = @() } }
    $ours = ([string]$HookDirectory).Replace('\', '/').TrimEnd('/')
    $foreign = [Collections.Generic.List[string]]::new()
    $entries = 0
    foreach ($eventProperty in @($ExistingHooks.PSObject.Properties)) {
        foreach ($matcherBlock in @($eventProperty.Value)) {
            if ($null -eq $matcherBlock) { continue }
            $blockNames = @($matcherBlock.PSObject.Properties | ForEach-Object { $_.Name })
            if ($blockNames -cnotcontains 'hooks') { continue }
            foreach ($entry in @($matcherBlock.hooks)) {
                if ($null -eq $entry) { continue }
                $entries++
                $text = (Get-HookEntryText $entry).Replace('\', '/')
                if ($text -notmatch [regex]::Escape($ours)) {
                    [void]$foreign.Add("$($eventProperty.Name): $text")
                }
            }
        }
    }
    if (-not $entries) { return [pscustomobject]@{ kind = 'absent'; foreign = @() } }
    if ($foreign.Count) { return [pscustomobject]@{ kind = 'foreign'; foreign = @($foreign) } }
    [pscustomobject]@{ kind = 'library'; foreign = @() }
}

function ConvertTo-OrderedMap {
    <# A parsed JSON document as something this file can set a key on, whatever shape it arrived in. #>
    param([AllowNull()]$Value)
    $map = [ordered]@{}
    if ($null -eq $Value) { return $map }
    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($key in @($Value.Keys)) { $map[[string]$key] = $Value[$key] }
        return $map
    }
    foreach ($property in @($Value.PSObject.Properties)) { $map[[string]$property.Name] = $property.Value }
    $map
}

function Get-WorkspaceSettingsPlan {
    <#
        ONE PLAN FOR ONE FILE, and the caller decides which facts belong in which file. The rule it
        still enforces is that a path is planned ONCE: two plans for one path would have written it
        twice, the second silently dropping the first.

        The allowlist merges as a SET, exactly as before. The hook block is replaced whole when it is
        absent or ours, and refused when it is not.

        THE TWO FACTS NOW LIVE IN DIFFERENT FILES, ruled by Eric on 2026-09-21 (ADR-0036, amended).
        The allowlist is portable text -- tool names, the same on every machine -- and belongs in the
        tracked `.claude/settings.json`. The hook block is ABSOLUTE PATHS INTO THIS PROGRAM, which is
        a machine-local value, and the reader's workspace is a repository whose own `.gitignore` says
        in writing that what stays out is "anything that is large, re-fetchable, machine-local, or
        somebody's network address". Committed, those paths reach another machine as registrations
        naming scripts that are not there -- and Claude Code treats a hook that exits non-zero with
        empty stdout as a non-blocking error, so that is the boundary failing OPEN in a clone.
        `.claude/settings.local.json` is where they go: the harness reads it beside the tracked file,
        every consumer that asks "are the guards registered" already reads both
        (`Get-HookRegistrationProblems`, `workspace.guards-registered`, `Guard-SettingsIntegrity.ps1`
        and the adapter's launch validation), and the workspace's `.gitignore` already excludes it.

        MOVING THE WHOLE BLOCK IS WHAT MAKES THAT SAFE, and a partial move would not be. The adapter's
        launch validation faults on a `settings.local.json` that declares its own `hooks` block
        WITHOUT the guards in it -- the shadowing case -- so half the block here and half there is
        the one arrangement that reads as a fault whichever way the harness resolves the two files.
    #>
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$DesiredAllow,
        [AllowNull()]$DesiredHooks,
        [string]$HookDirectory,
        [switch]$RemoveOwnedHooks
    )

    # NORMALISED ONCE, HERE. An unbound [string[]] parameter is $null, and under StrictMode
    # `@($null).Count` THROWS rather than answering 0 -- the same class of defect this file already
    # records against one-element lists, met from the other end the first time this function was
    # called for a file that wants hooks and no allowlist.
    $allow = @()
    if ($null -ne $DesiredAllow) { $allow = @($DesiredAllow) }

    $existing = $null
    if (Test-Path -LiteralPath $FilePath -PathType Leaf) {
        $text = [IO.File]::ReadAllText($FilePath, $script:Utf8)
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            try { $existing = $text | ConvertFrom-Json }
            catch {
                return [pscustomobject]@{
                    action = 'refuse'; content = $null
                    reason = "$FilePath is not readable JSON, so the Library's entries cannot be merged into it without replacing what is there."
                }
            }
        }
    }

    $value = $existing
    $changed = $false
    if ($allow.Count) {
        $merged = Merge-LibraryJsonValue -Existing $existing `
            -Desired ([ordered]@{ permissions = [ordered]@{ allow = $allow } }) `
            -KeyPath (Split-Path -Leaf $FilePath)
        if (@($merged.conflicts).Count) {
            return [pscustomobject]@{
                action = 'refuse'; content = $null
                reason = ("$FilePath cannot be merged: " + (@($merged.conflicts) -join '; ') +
                          '. Reconcile those entries by hand and re-run; nothing has been written.')
            }
        }
        $value = $merged.value
        if ($merged.changed) { $changed = $true }
    }

    $map = ConvertTo-OrderedMap $value

    # THE MIGRATION HALF, AND WITHOUT IT THE MOVE IS NOT A MOVE. Every workspace initialised between
    # ADR-0036 and its amendment -- which on this machine is the reader's own -- carries the block in
    # the TRACKED file. Writing the new copy without removing the old one leaves two registrations of
    # the same nine hooks, the harness running whichever it resolves, and the machine-local paths
    # still sitting in the file that travels. So the tracked file is asked the same ownership
    # question, and a block this tool wrote LEAVES. A block the reader wrote is theirs and stays:
    # this removes what `library init` put there, never what it found.
    if ($RemoveOwnedHooks -and $map.Contains('hooks')) {
        $owned = Get-WorkspaceHookOwnership -ExistingHooks $map['hooks'] -HookDirectory $HookDirectory
        if ($owned.kind -ceq 'library') {
            $map.Remove('hooks')
            $changed = $true
        }
    }

    if ($null -ne $DesiredHooks) {
        $existingHooks = $null
        if ($map.Contains('hooks')) { $existingHooks = $map['hooks'] }
        $ownership = Get-WorkspaceHookOwnership -ExistingHooks $existingHooks -HookDirectory $HookDirectory
        if ($ownership.kind -ceq 'foreign') {
            return [pscustomobject]@{
                action = 'refuse'; content = $null
                reason = ("$FilePath already registers hooks the Library did not write (" +
                          (@($ownership.foreign) -join '; ') + '), so its hook block cannot be replaced ' +
                          'without discarding them. Move those entries to .claude/settings.json, or ' +
                          'remove them, and re-run; nothing has been written.')
            }
        }
        # Compared through ONE serializer, so a block this tool wrote on a previous run reads as
        # unchanged rather than being rewritten byte-identically on every init.
        $desiredText = ($DesiredHooks | ConvertTo-Json -Depth 12)
        $existingText = if ($null -eq $existingHooks) { '' } else { ($existingHooks | ConvertTo-Json -Depth 12) }
        if ($desiredText -cne $existingText) {
            $map['hooks'] = $DesiredHooks
            $changed = $true
        }
    }

    if (-not $changed) { return [pscustomobject]@{ action = 'unchanged'; content = $null; reason = $null } }
    [pscustomobject]@{ action = 'merge'; content = (($map | ConvertTo-Json -Depth 12) + "`n"); reason = $null }
}


# ==================================================================================================
# THE SAME GUARDS, IN THE OTHER HARNESS
# ==================================================================================================
# WHY `library init` WRITES CODEX BINDINGS TOO, AND WHY IT COULD NOT BEFORE.
#
# ADR-0036 ruled that a direct install takes its guards and its reader from `library init`, and the
# ruling was implemented for Claude Code alone. The reader's workspace therefore carried no `.codex/`
# configuration AT ALL -- so a Codex seat opened there had no Desk boundary, no closed-Book guard and
# no shell guard, which is precisely the hole ADR-0036 exists to close, standing open beside the half
# that was closed. `workspace.guards-registered` could not see it either, because it reads `.claude/`.
#
# WHAT HELD IT UP WAS A REAL QUESTION AND IT NOW HAS A MEASURED ANSWER. Step 20 named
# `.codex/config.toml` among the files this merges, and nobody knew whether Codex read a project-level
# one. Measured 2026-09-22 on codex-cli 0.153.4: it does -- and so does it read `.codex/hooks.json` --
# but ONLY when the project is trusted in `$CODEX_HOME/config.toml`. Untrusted, both are ignored in
# silence. tools/CodexBindings.ps1 carries the four cells.
#
# SO THIS WRITES THE FILES AND REPORTS THE GATE; IT NEVER GRANTS IT. Trust is a security decision
# about a machine, recorded in a file no workspace owns, and the reader's own client asks for it on
# first launch. `workspace.codex-guards-registered` is what says whether it has been given, and names
# which of this machine's two Codex homes it looked in.

function Get-CodexHooksPlan {
    <#
        What to do about `<workspace>/.codex/hooks.json`, using the SAME ownership rule as the Claude
        hook block: a document whose every entry names a script under this program's hook directory
        is one this tool wrote and is replaced whole; anything else is the reader's and is refused.

        Replaced WHOLE rather than merged, for the reason the Claude half records: a merge unions a
        retired hook's entry back in and leaves a registration pointing at a script that is no longer
        there -- which in this harness is not an error but a silence.
    #>
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Desired,
        [Parameter(Mandatory)][string]$HookDirectory
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        return [pscustomobject]@{ action = 'created'; content = $Desired; reason = $null }
    }
    $text = [IO.File]::ReadAllText($FilePath, $script:Utf8)
    if ($text -ceq $Desired) { return [pscustomobject]@{ action = 'unchanged'; content = $null; reason = $null } }

    $existing = $null
    try { $existing = $text | ConvertFrom-Json }
    catch {
        return [pscustomobject]@{
            action = 'refuse'; content = $null
            reason = "$FilePath is not readable JSON, so the Library's Codex hooks cannot replace it without discarding what is there."
        }
    }
    $existingHooks = $null
    if ($null -ne $existing) {
        $names = @($existing.PSObject.Properties | ForEach-Object { $_.Name })
        if ($names -ccontains 'hooks') { $existingHooks = $existing.hooks }
    }
    $ownership = Get-WorkspaceHookOwnership -ExistingHooks $existingHooks -HookDirectory $HookDirectory
    if ($ownership.kind -ceq 'foreign') {
        return [pscustomobject]@{
            action = 'refuse'; content = $null
            reason = ("$FilePath already registers Codex hooks the Library did not write (" +
                      (@($ownership.foreign) -join '; ') + '), so it cannot be replaced without discarding them. ' +
                      'Move them into $CODEX_HOME/hooks.json, which Codex loads alongside this file, or remove ' +
                      'them, and re-run; nothing has been written.')
        }
    }
    [pscustomobject]@{ action = 'merge'; content = $Desired; reason = $null }
}

function Get-CodexConfigPlan {
    <#
        What to do about `<workspace>/.codex/config.toml`.

        OWNERSHIP IS A STAMP HERE RATHER THAN A WALK, and the difference is the document. A hooks file
        names scripts, so who wrote it can be read off its own entries; a config names a server and a
        handful of timeouts, and there is nothing in it that identifies an author. So the renderer
        writes one marker line and this reads it back. A file without it is the reader's.

        No TOML merge, deliberately: there is no TOML parser in this tree, and a half-understood merge
        of a file that decides which server a session talks to is a worse failure than a refusal that
        names the file.
    #>
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Desired
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        return [pscustomobject]@{ action = 'created'; content = $Desired; reason = $null }
    }
    $text = [IO.File]::ReadAllText($FilePath, $script:Utf8)
    if ($text -ceq $Desired) { return [pscustomobject]@{ action = 'unchanged'; content = $null; reason = $null } }
    if (-not $text.Contains((Get-CodexManagedMarker))) {
        return [pscustomobject]@{
            action = 'refuse'; content = $null
            reason = ("$FilePath was not written by ``library init`` -- it carries no managed marker -- so its " +
                      'Codex server registration cannot be replaced without discarding what is there. Move it ' +
                      'aside and re-run; nothing has been written.')
        }
    }
    [pscustomobject]@{ action = 'merge'; content = $Desired; reason = $null }
}

# ==================================================================================================
# THE RUN
# ==================================================================================================
$script:WorkspaceFolders = @('notebook', 'shelf', 'raw', 'output', 'internal')

# THE TWO BOOKS THE PROGRAM'S OWN INSTRUCTIONS NAME (S42, the reader's ruling). `library init` and then
# `library doctor` failed three checks in every fresh workspace -- measured on Windows and in a clean
# Linux distro alike: no shelf/_catalog.md, no notebook/_master-index.md, and a catalog that could list
# neither Book the skills and the capture helpers name (`-BookSlug 'holding'`, `shelf/reports`). So a
# workspace starts with both, empty and capture-enabled, and "save this for later" works in it at once.
# A Book already there is never touched, whatever it holds; a husk is refused before anything is written.
$script:StandardShelfBooks = @(
    [ordered]@{
        slug    = 'holding'
        title   = 'Holding Shelf'
        summary = 'Findings set aside during a session for later review, one page per note. Survives a Notebook reset; closed by default so unreviewed material never crowds a new session.'
        topics  = 'capture, holding, unreviewed'
        origin  = "created by library init as the Library's capture surface"
    }
    [ordered]@{
        slug    = 'reports'
        title   = 'Report Inbox'
        summary = 'Bugs and tooling gaps an agent found in the Library itself, kept for triage. A page here is one agent''s claim about the Library, written while the context was live -- verify it against the code before acting on it.'
        topics  = 'capture, reports'
        origin  = "created by library init as the Library's report channel"
    }
)

function Get-LocalCollectionCatalogs {
    <#
        The three catalogs a local collection starts with, in the shared collection's layout: the two
        files whose presence marks a collection root (SharedCollectionFiles.ps1), and the archived
        Projects catalog RawBatchOwnership.ps1 reads. A Project is listed as
        `- [[projects/<slug>/_project|Title]]` under `## Projects`, exactly as in the shared one.
    #>
    @(
        [pscustomobject]@{ relative = (Join-Path 'books' 'README.md'); text = "# Books`n`nThe Books in this workspace's local collection.`n" }
        [pscustomobject]@{ relative = (Join-Path 'projects' 'README.md'); text = "# Active Projects`n`nProjects are living context in this workspace's local collection. Open one when you need its current notes.`n`n## Projects`n" }
        [pscustomobject]@{ relative = (Join-Path 'archive' (Join-Path 'projects' 'README.md')); text = "# Archived Projects`n`nProjects retired from the active catalog. An archived Hub stays searchable.`n`n## Projects`n" }
    )
}

function Invoke-LibraryWorkspaceInit {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$McpUrl,
        [string]$CollectionId,
        [bool]$Writable,
        [bool]$Force,
        [string]$RegistryRoot,
        [Parameter(Mandatory)][string]$ProgramRoot
    )

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A workspace folder is required.' }
    # THE SHAPE IS JUDGED BEFORE THE DIRECTORY IS CREATED, and the order is the whole of the check.
    # Creating first meant a UNC path failed at `New-Item` with "The network path was not found" --
    # a true sentence about a machine, where the real fault is that a share can never be a workspace
    # root on this design at all. The refusal has to come from the rule, not from the weather.
    $workspace = ConvertTo-WorkspaceRoot $Path
    if (-not $workspace) {
        throw "'$Path' is not a drive-rooted local path, so it cannot be a Library workspace: a workspace root has to be a place every tool on this machine can name the same way."
    }
    if (-not (Test-Path -LiteralPath $workspace -PathType Container)) {
        New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    }

    # --- the marker ---------------------------------------------------------------------------
    $existingMarker = Read-WorkspaceMarker -Workspace $workspace
    $alreadyInitialised = $null -ne $existingMarker
    if ($alreadyInitialised -and -not $Force) {
        # Idempotent, not an error. The registry is still reconciled below, because the common reason
        # to re-run is that the registry lost its line while the marker stayed put.
        $id = Get-WorkspaceMarkerField $existingMarker 'id'
        $created = Get-WorkspaceMarkerField $existingMarker 'created'
    }
    else {
        $id = if ($alreadyInitialised) { Get-WorkspaceMarkerField $existingMarker 'id' } else { [guid]::NewGuid().ToString() }
        $created = if ($alreadyInitialised) { Get-WorkspaceMarkerField $existingMarker 'created' } else { (Get-Date).ToString('o') }
    }
    if ([string]::IsNullOrWhiteSpace($id)) { $id = [guid]::NewGuid().ToString() }
    if ([string]::IsNullOrWhiteSpace($created)) { $created = (Get-Date).ToString('o') }

    # An endpoint or collection id already written for this workspace is kept unless a new one is
    # passed: init is not a chance to silently detach a workspace from its collection.
    $resolvedMcpUrl = [string]$McpUrl
    if ([string]::IsNullOrWhiteSpace($resolvedMcpUrl)) {
        $resolvedMcpUrl = Read-LibraryDeploymentState (Get-LibraryDeploymentStatePath $workspace '.library-mcp-url')
    }
    $resolvedCollectionId = [string]$CollectionId
    if ([string]::IsNullOrWhiteSpace($resolvedCollectionId)) {
        $resolvedCollectionId = Read-LibraryDeploymentState (Get-LibraryDeploymentStatePath $workspace '.library-project')
    }
    # THE MARKER'S OWN RECORD, which the comment above always promised and this function never read
    # until S30 (the Report Inbox, 2026-09-22): a workspace whose only record of its collection was
    # the marker had it emptied by every re-run with no -CollectionId.
    if ([string]::IsNullOrWhiteSpace($resolvedCollectionId) -and $alreadyInitialised) {
        $resolvedCollectionId = [string](Get-WorkspaceMarkerField $existingMarker 'collection_id')
    }

    # THE LOCAL COLLECTION (ADR-0030; S30, the reader's three rulings). With no Basic Memory endpoint
    # a workspace's durable tier is <workspace>/collection/, in the shared collection's exact layout,
    # and init lays it out. Its persistent id is <collection>/.library/collection.json -- the workspace
    # marker's shape, in the same folder name -- minted here and recorded as the marker's
    # collection_id. It takes no ownership claim: it sits inside one workspace and is written under
    # that workspace's own locks. Every file is created only when missing, so a catalog the reader's
    # Hubs have filled is never rewritten, and an id file naming ANOTHER collection than this init
    # names refuses: replacing a folder must not silently retarget the workspace.
    $collectionPlans = [Collections.Generic.List[object]]::new()
    $collectionRefusal = $null
    $isProgramRootForCollection = Test-Path -LiteralPath (Join-Path $workspace (Join-Path 'tools' 'BookRootSchema.ps1')) -PathType Leaf
    if ([string]::IsNullOrWhiteSpace($resolvedMcpUrl) -and -not $isProgramRootForCollection) {
        $collectionRoot = Join-Path $workspace 'collection'
        $idFile = Join-Path $collectionRoot (Join-Path '.library' 'collection.json')
        if (Test-Path -LiteralPath $idFile -PathType Leaf) {
            $recordedId = ''
            try { $recordedId = [string](Get-Content -LiteralPath $idFile -Raw | ConvertFrom-Json).id } catch { $recordedId = '' }
            if ([string]::IsNullOrWhiteSpace($recordedId)) {
                $collectionRefusal = "$idFile carries no readable id, so the local collection's identity cannot be confirmed. Repair or remove it and re-run; nothing has been written."
            }
            elseif (-not [string]::IsNullOrWhiteSpace($resolvedCollectionId) -and $recordedId -ne $resolvedCollectionId) {
                $collectionRefusal = "$idFile names collection $recordedId, and this init names $resolvedCollectionId. A local collection's id is persistent, so init will not retarget the workspace; nothing has been written."
            }
            else { $resolvedCollectionId = $recordedId }
            [void]$collectionPlans.Add([pscustomobject]@{ path = $idFile; name = 'collection/.library/collection.json'; action = 'unchanged'; content = $null })
        }
        else {
            if ([string]::IsNullOrWhiteSpace($resolvedCollectionId)) { $resolvedCollectionId = [guid]::NewGuid().ToString() }
            $record = [ordered]@{ schema = 1; id = $resolvedCollectionId; created = (Get-Date).ToString('o') }
            [void]$collectionPlans.Add([pscustomobject]@{ path = $idFile; name = 'collection/.library/collection.json'; action = 'created'; content = (($record | ConvertTo-Json) + "`n") })
        }
        foreach ($catalog in (Get-LocalCollectionCatalogs)) {
            $target = Join-Path $collectionRoot $catalog.relative
            $action = if (Test-Path -LiteralPath $target -PathType Leaf) { 'unchanged' } else { 'created' }
            [void]$collectionPlans.Add([pscustomobject]@{ path = $target; name = ('collection/' + $catalog.relative.Replace('\', '/')); action = $action; content = $catalog.text })
        }
    }

    $markerContent = New-WorkspaceMarkerContent -Id $id -ProgramVersion (Get-LibraryProgramVersion -ProgramRoot $ProgramRoot) `
        -CollectionId $resolvedCollectionId -McpUrl $resolvedMcpUrl -Writable $Writable -Created $created

    # --- PREFLIGHT EVERY FILE BEFORE WRITING ANY OF THEM ----------------------------------------
    # The plan is built whole and refused whole. A run that rewrote CLAUDE.md and then discovered
    # that .mcp.json could not be merged would have left the reader half-initialised with no record
    # of which half.
    $body = [IO.File]::ReadAllText((Join-Path $ProgramRoot (Join-Path 'templates' 'workspace-instructions.md')), $script:Utf8)
    $plans = [Collections.Generic.List[object]]::new()
    $refusals = [Collections.Generic.List[string]]::new()

    # AN UN-SPLIT CHECKOUT'S INSTRUCTION FILES BELONG TO THE PROGRAM, NOT TO THE WORKSPACE, and
    # this is the first invariant `library init` met that its own first run would have broken. Where
    # the program and the workspace are still one directory -- every clone of this repository until
    # step 22 -- `CLAUDE.md` is a TRACKED SOURCE FILE written by the program's authors, budgeted
    # against `context.always-on-budget` and already carrying these rules in the form that repository
    # uses. Appending the reader template to it duplicates the Librarian's opening paragraph, blows
    # the always-on budget, and dirties the working tree, which is exactly what the accidental run on
    # 2026-09-20 did before this branch existed. After step 22 the reader's workspace has no tools/
    # and this branch is not taken, which is the correct behaviour in both layouts rather than a
    # special case for one of them.
    $isProgramRoot = Test-Path -LiteralPath (Join-Path $workspace (Join-Path 'tools' 'BookRootSchema.ps1')) -PathType Leaf
    foreach ($name in $script:InstructionFiles) {
        $target = Join-Path $workspace $name
        if ($isProgramRoot) {
            [void]$plans.Add([pscustomobject]@{ path = $target; name = $name; action = 'skipped-program-file'; content = $null })
            continue
        }
        $plan = Get-ManagedSectionPlan -FilePath $target -Body $body
        if ($plan.action -ceq 'refuse') { [void]$refusals.Add($plan.reason); continue }
        [void]$plans.Add([pscustomobject]@{ path = $target; name = $name; action = $plan.action; content = $plan.content })
    }

    # The adapter is only in a DIRECT install; a plugin brings its own server and needs no entry.
    #
    # TWO DIRECT LAYOUTS. Until step 22 there was one: the adapter sat in the workspace, and a
    # workspace with none was taken to be a packaged install with a plugin. The split made a third
    # state real and common -- the adapter is in the PROGRAM and there is no plugin -- and reading it
    # as "the plugin will provide" is what left this machine's workspace with no reader tools at all.
    # So the program's own adapter answers when the workspace has none, by absolute path, and names
    # the workspace it is to bind.
    $adapter = Join-Path $workspace (Join-Path '.claude' (Join-Path 'adapters' 'Validated-BookReader.ps1'))
    $programAdapter = Join-Path $ProgramRoot (Join-Path '.claude' (Join-Path 'adapters' 'Validated-BookReader.ps1'))
    $desiredServers = $null
    if (Test-Path -LiteralPath $adapter -PathType Leaf) {
        $desiredServers = Get-DesiredMcpServers -AdapterPath '.claude/adapters/Validated-BookReader.ps1'
    }
    elseif (-not $isProgramRoot -and (Test-Path -LiteralPath $programAdapter -PathType Leaf)) {
        $desiredServers = Get-DesiredMcpServers `
            -AdapterPath (($programAdapter -replace '\\', '/')) `
            -StateDirectory ((Join-Path $workspace '.claude') -replace '\\', '/')
    }
    if ($null -ne $desiredServers) {
        $mcpPlan = Get-JsonMergePlan -FilePath (Join-Path $workspace '.mcp.json') -Desired $desiredServers
        if ($mcpPlan.action -ceq 'refuse') { [void]$refusals.Add($mcpPlan.reason) }
        elseif ($mcpPlan.action -cne 'unchanged') {
            [void]$plans.Add([pscustomobject]@{ path = (Join-Path $workspace '.mcp.json'); name = '.mcp.json'; action = $mcpPlan.action; content = $mcpPlan.content })
        }
        else { [void]$plans.Add([pscustomobject]@{ path = (Join-Path $workspace '.mcp.json'); name = '.mcp.json'; action = 'unchanged'; content = $null }) }
    }

    # `.claude/settings.json`: the reader's permission allowlist, merged as a SET. An entry the
    # reader added is theirs and survives; an entry already present is not a change. Skipped in an
    # un-split checkout for the same reason the instruction files are -- that settings file is the
    # program's own, and it is where these entries are being copied FROM.
    #
    # AND `.claude/settings.local.json`: THE GUARDS, WHICH USED TO SHARE THE TRACKED FILE AND NO
    # LONGER DO. The reasoning is on Get-WorkspaceSettingsPlan; the short of it is that the hook
    # block is absolute paths into this program and the tracked file travels to other machines.
    # Two paths, two plans, each planned once.
    if (-not $isProgramRoot) {
        $hookDirectory = Get-ProgramHookDirectory $ProgramRoot
        $desiredAllow = @(Get-DesiredPermissionAllowlist -ProgramRoot $ProgramRoot)
        # PLANNED UNCONDITIONALLY, not only when there are permissions to merge. This file is also
        # where a hook block left by the pre-amendment `library init` has to be REMOVED from, and
        # gating that on the allowlist being non-empty would have made the migration depend on a
        # fact that has nothing to do with it. An unchanged file plans `unchanged` and writes nothing.
        $settingsPath = Join-Path $workspace (Join-Path '.claude' 'settings.json')
        $settingsPlan = Get-WorkspaceSettingsPlan -FilePath $settingsPath `
            -DesiredAllow $desiredAllow -HookDirectory $hookDirectory -RemoveOwnedHooks
        if ($settingsPlan.action -ceq 'refuse') { [void]$refusals.Add($settingsPlan.reason) }
        else {
            [void]$plans.Add([pscustomobject]@{ path = $settingsPath; name = '.claude/settings.json'; action = $settingsPlan.action; content = $settingsPlan.content })
        }

        $desiredHooks = Get-DesiredHookRegistration -ProgramRoot $ProgramRoot
        if ($null -ne $desiredHooks) {
            $localPath = Join-Path $workspace (Join-Path '.claude' 'settings.local.json')
            $localPlan = Get-WorkspaceSettingsPlan -FilePath $localPath `
                -DesiredHooks $desiredHooks -HookDirectory $hookDirectory
            if ($localPlan.action -ceq 'refuse') { [void]$refusals.Add($localPlan.reason) }
            else {
                [void]$plans.Add([pscustomobject]@{ path = $localPath; name = '.claude/settings.local.json'; action = $localPlan.action; content = $localPlan.content })
            }
        }
        # AND THE SAME TWO FACTS FOR CODEX, which had none of them until 2026-09-22. A Codex seat
        # opened in this workspace read no Library configuration whatever: the guards above are
        # Claude Code's file, and `.codex/` was not written at all. The templates are the program's;
        # a packaged install that shipped neither simply skips this, as it skips the hook block.
        $codexDirectory = Join-Path $ProgramRoot '.codex'
        $codexHooksTemplate = Join-Path $codexDirectory 'hooks.template.json'
        $codexConfigTemplate = Join-Path $codexDirectory 'workspace-config.template.toml'
        if (Test-Path -LiteralPath $codexHooksTemplate -PathType Leaf) {
            $codexHooksPath = Join-Path $workspace (Join-Path '.codex' 'hooks.json')
            $codexHooksPlan = Get-CodexHooksPlan -FilePath $codexHooksPath `
                -Desired (New-CodexHooksDocument -TemplatePath $codexHooksTemplate -HookDirectory $hookDirectory) `
                -HookDirectory $hookDirectory
            if ($codexHooksPlan.action -ceq 'refuse') { [void]$refusals.Add($codexHooksPlan.reason) }
            else {
                [void]$plans.Add([pscustomobject]@{ path = $codexHooksPath; name = '.codex/hooks.json'; action = $codexHooksPlan.action; content = $codexHooksPlan.content })
            }
        }
        # The reader's own server, by the same two-layout rule `.mcp.json` follows above: an adapter
        # in the workspace binds on its own anchor, and one in the PROGRAM has to be told which
        # workspace it is serving. With neither there is nothing to declare, and a config declaring no
        # server would be a file that turns the trust question on for no benefit.
        if (Test-Path -LiteralPath $codexConfigTemplate -PathType Leaf) {
            $codexAdapter = $null
            $codexStateDirectory = $null
            if (Test-Path -LiteralPath $adapter -PathType Leaf) { $codexAdapter = $adapter }
            elseif (Test-Path -LiteralPath $programAdapter -PathType Leaf) {
                $codexAdapter = $programAdapter
                $codexStateDirectory = Join-Path $workspace '.claude'
            }
            if ($null -ne $codexAdapter) {
                $codexConfigPath = Join-Path $workspace (Join-Path '.codex' 'config.toml')
                $codexConfigPlan = Get-CodexConfigPlan -FilePath $codexConfigPath `
                    -Desired (New-CodexWorkspaceConfigDocument -TemplatePath $codexConfigTemplate `
                        -AdapterPath $codexAdapter -StateDirectory $codexStateDirectory)
                if ($codexConfigPlan.action -ceq 'refuse') { [void]$refusals.Add($codexConfigPlan.reason) }
                else {
                    [void]$plans.Add([pscustomobject]@{ path = $codexConfigPath; name = '.codex/config.toml'; action = $codexConfigPlan.action; content = $codexConfigPlan.content })
                }
            }
        }
    }


    foreach ($collectionPlan in $collectionPlans) { [void]$plans.Add($collectionPlan) }
    if ($null -ne $collectionRefusal) { [void]$refusals.Add($collectionRefusal) }

    # The standard Books are judged with every other file, so a husk refuses the whole run.
    $bookPlans = [Collections.Generic.List[object]]::new()
    if (-not $isProgramRoot) {
        foreach ($book in $script:StandardShelfBooks) {
            $bookRoot = Join-Path (Join-Path $workspace 'shelf') $book.slug
            if (-not (Test-Path -LiteralPath $bookRoot)) { [void]$bookPlans.Add([pscustomobject]@{ book = $book; action = 'created' }); continue }
            if (Test-Path -LiteralPath (Join-Path $bookRoot 'wiki') -PathType Container) { [void]$bookPlans.Add([pscustomobject]@{ book = $book; action = 'unchanged' }); continue }
            [void]$refusals.Add("shelf/$($book.slug) exists but has no wiki/, so it is a husk rather than a Book, and init will not adopt it as the $($book.title). Remove shelf/$($book.slug) if nothing needs it and re-run; nothing has been written.")
        }
        # A SHELF THAT CANNOT BE RENDERED REFUSES HERE, not halfway through the writes below: every Book
        # init adds re-renders the catalog, and a render that throws after the marker is written leaves a
        # half-initialised workspace with no record of which half.
        $needsRender = @($bookPlans | Where-Object { $_.action -ceq 'created' }).Count -or -not (Test-Path -LiteralPath (Join-Path $workspace 'shelf/_catalog.md') -PathType Leaf)
        if ($needsRender -and (Test-Path -LiteralPath (Join-Path $workspace 'shelf') -PathType Container)) {
            try { [void](Get-ShelfCatalogText -Workspace $workspace -ProgramRoot $ProgramRoot) }
            catch { [void]$refusals.Add("the Shelf cannot be rendered, so init cannot add its Books to the catalog: $($_.Exception.Message) Nothing has been written.") }
        }
    }

    if ($refusals.Count) {
        throw ('library init refused and wrote nothing: ' + ($refusals -join ' | '))
    }

    # --- APPLY ------------------------------------------------------------------------------------
    $markerPath = Get-WorkspaceMarkerPath $workspace
    New-Item -ItemType Directory -Path (Split-Path -Parent $markerPath) -Force | Out-Null
    Write-AtomicText -Path $markerPath -Text (($markerContent | ConvertTo-Json -Depth 5) + "`n") | Out-Null

    $written = [Collections.Generic.List[object]]::new()
    foreach ($plan in $plans) {
        if ($plan.action -ceq 'unchanged' -or $plan.action -ceq 'skipped-program-file') {
            [void]$written.Add([pscustomobject]@{ file = $plan.name; action = $plan.action })
            continue
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $plan.path) -Force | Out-Null
        Write-AtomicText -Path $plan.path -Text $plan.content | Out-Null
        [void]$written.Add([pscustomobject]@{ file = $plan.name; action = $plan.action })
    }

    # THE FOLDERS THE WORKSPACE INSTRUCTIONS NAME, empty, and none of them until S30. Measured over a
    # fresh Tier 0 workspace: `library init` and then "what's on my desk?" refused with "Notebook
    # directory not found", in this helper's Get-DeskOverview.ps1 and in the kernel alike -- the Phase D
    # criterion, failing on its second command. The acceptance fixtures hid it: their seated shape
    # creates these five by hand. Directories only, so a re-run creates nothing that is there.
    if (-not $isProgramRoot) {
        foreach ($folder in $script:WorkspaceFolders) {
            $directory = Join-Path $workspace $folder
            if (-not (Test-Path -LiteralPath $directory -PathType Container)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
        }

        # THE BOOKS, THROUGH THE HELPER THAT CREATES ANY EMPTY BOOK, so an init-made Book is byte for byte
        # a New-ShelfBook one; it renders the catalog under the render lock as it creates each.
        foreach ($bookPlan in $bookPlans) {
            $book = $bookPlan.book
            if ($bookPlan.action -ceq 'created') {
                [void](& (Join-Path $PSScriptRoot 'New-ShelfBook.ps1') -Slug $book.slug -Title $book.title -Summary $book.summary `
                    -Topics $book.topics -Capture -Origin $book.origin -WorkspacePath $workspace)
            }
            [void]$written.Add([pscustomobject]@{ file = "shelf/$($book.slug)"; action = $bookPlan.action })
        }
        $catalogAction = 'unchanged'
        if (@($bookPlans | Where-Object { $_.action -ceq 'created' }).Count) { $catalogAction = 'rendered' }
        elseif (-not (Test-Path -LiteralPath (Join-Path $workspace 'shelf/_catalog.md') -PathType Leaf)) {
            [void](Invoke-ShelfCatalogRender -Workspace $workspace)
            $catalogAction = 'rendered'
        }
        [void]$written.Add([pscustomobject]@{ file = 'shelf/_catalog.md'; action = $catalogAction })

        # AN EMPTY MASTER INDEX ONLY OVER AN EMPTY NOTEBOOK. Its text is the one the layout reader counts as
        # no material at all, so a fresh workspace stays fresh; a Notebook with anything in it is left to
        # its own renderer, which a seat-owned layout never points at the root.
        $masterIndex = Get-NotebookMasterIndexPath -Workspace $workspace
        $masterAction = 'unchanged'
        if (-not (Test-Path -LiteralPath $masterIndex -PathType Leaf)) {
            if (@(Get-ChildItem -LiteralPath (Join-Path $workspace 'notebook') -Force).Count) { $masterAction = 'skipped-notebook-has-content' }
            else {
                Write-AtomicText -Path $masterIndex -Text (Get-NotebookEmptyMasterIndexText) | Out-Null
                $masterAction = 'created'
            }
        }
        [void]$written.Add([pscustomobject]@{ file = 'notebook/_master-index.md'; action = $masterAction })
    }

    $registration = Register-LibraryWorkspace -Workspace $workspace -Id $id -RegistryRoot $RegistryRoot

    [pscustomobject]@{
        status       = if ($alreadyInitialised) { 'already_initialized' } else { 'initialized' }
        workspace    = $workspace
        id           = $id
        marker       = $markerPath
        backend      = $markerContent.backend
        writable     = $Writable
        registry     = $registration.path
        registration = $registration.action
        files        = @($written)
    }
}

function Register-LibraryWorkspace {
    <#
        Add or refresh this workspace's line in the machine registry.

        THE REGISTRY IS REWRITTEN WHOLE AND MERGED BY PATH, case-insensitively, because Windows
        paths are. Registering `d:\ws` where `D:\WS` is already listed must update that line rather
        than add a second one that every containment test will then match twice.

        AN UNREADABLE REGISTRY THROWS AND IS NOT REPLACED. Read-WorkspaceRegistry already refuses to
        read a broken file as empty; writing a fresh one over it here would turn one machine's typo
        into the deletion of every other workspace's line.
    #>
    param(
        [Parameter(Mandatory)][string]$Workspace,
        [Parameter(Mandatory)][string]$Id,
        [string]$RegistryRoot
    )

    $path = Get-WorkspaceRegistryPath $RegistryRoot
    $entries = @(Read-WorkspaceRegistry -RegistryRoot $RegistryRoot)

    $out = [Collections.Generic.List[object]]::new()
    $action = 'added'
    foreach ($entry in $entries) {
        if ($entry.root.Equals($Workspace, [StringComparison]::OrdinalIgnoreCase)) {
            $action = if ($entry.id -ceq $Id) { 'unchanged' } else { 'updated' }
            continue
        }
        [void]$out.Add([ordered]@{ id = $entry.id; path = $entry.root })
    }
    [void]$out.Add([ordered]@{ id = $Id; path = $Workspace })

    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
    # `workspaces = @(...)` with the comma: a one-workspace machine is the common case, and a
    # one-element array unrolls on the way into ConvertTo-Json, writing an OBJECT where every reader
    # of this file expects a list. Read-WorkspaceRegistry would then throw on `no workspaces list`
    # for the very file this function had just written.
    $doc = [ordered]@{ version = 1; workspaces = @($out) }
    Write-AtomicText -Path $path -Text (($doc | ConvertTo-Json -Depth 5) + "`n") | Out-Null
    [pscustomobject]@{ path = $path; action = $action }
}

# ==================================================================================================
# THE SELF-TEST
# ==================================================================================================
function Invoke-LibraryWorkspaceInitSelfTest {
    $failures = [Collections.Generic.List[string]]::new()
    $script:initChecks = 0
    function Check([bool]$Condition, [string]$Message) {
        $script:initChecks++
        if (-not $Condition) { [void]$failures.Add($Message) }
    }

    $program = Split-Path -Parent $PSScriptRoot
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('library-init-' + [guid]::NewGuid().ToString('N'))
    try {
        $reg = Join-Path $tmp 'reg'
        New-Item -ItemType Directory -Path $reg -Force | Out-Null

        # --- A FRESH FOLDER ---------------------------------------------------------------------
        $fresh = Join-Path $tmp 'fresh'
        $first = Invoke-LibraryWorkspaceInit -Path $fresh -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program
        Check ($first.status -ceq 'initialized') "a fresh folder reported status '$($first.status)'"
        Check (Test-WorkspaceMarkerPresent $fresh) 'a fresh init wrote no marker'
        Check ($first.backend -ceq 'local') "a workspace with no endpoint reported backend '$($first.backend)'"

        $marker = Read-WorkspaceMarker -Workspace $fresh
        foreach ($field in @('id', 'program_version', 'collection_id', 'backend', 'writable', 'created')) {
            Check (@($marker.PSObject.Properties | ForEach-Object { $_.Name }) -contains $field) "the marker has no '$field' field"
        }
        Check ((Get-WorkspaceMarkerField $marker 'writable') -ceq 'False') "attachment defaulted to writable '$(Get-WorkspaceMarkerField $marker 'writable')'"

        # The registry must be readable BY ITS OWN READER, and with exactly one workspace on it --
        # the shape where a bare ConvertTo-Json writes an object instead of a list.
        $listed = @(Read-WorkspaceRegistry -RegistryRoot $reg)
        Check ($listed.Count -eq 1) "the registry read back $($listed.Count) entr(ies) after one init"
        Check ($listed[0].root -eq (ConvertTo-WorkspaceRoot $fresh)) "the registry recorded '$($listed[0].root)'"
        Check ($listed[0].id -ceq $first.id) 'the registry id does not match the marker id'

        # And the resolver must now find it from inside, which is the whole point of writing it.
        $deep = Join-Path $fresh 'notebook/topic'
        New-Item -ItemType Directory -Path $deep -Force | Out-Null
        $resolved = Resolve-LibraryWorkspace -StartDirectory $deep -RegistryRoot $reg
        Check ($resolved.kind -ceq 'resolved' -and $resolved.source -ceq 'cwd') "after init, a cwd inside resolved '$($resolved.kind)'/'$($resolved.source)'"

        foreach ($name in @('CLAUDE.md', 'AGENTS.md')) {
            $text = [IO.File]::ReadAllText((Join-Path $fresh $name), $script:Utf8)
            Check ($text.Contains($script:SectionBegin) -and $text.Contains($script:SectionEnd)) "$name was written without its managed markers"
            Check ($text.Contains('Virtual Desk')) "$name does not carry the operating rules"
        }

        # --- IDEMPOTENCE, because running it twice is the first thing anyone does ------------------
        $second = Invoke-LibraryWorkspaceInit -Path $fresh -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program
        Check ($second.status -ceq 'already_initialized') "a second init reported '$($second.status)'"
        Check ($second.id -ceq $first.id) 'a second init reissued the workspace id'
        Check ((Get-WorkspaceMarkerField (Read-WorkspaceMarker -Workspace $fresh) 'created') -ceq (Get-WorkspaceMarkerField $marker 'created')) `
            'a second init rewrote the created stamp'
        Check (@(Read-WorkspaceRegistry -RegistryRoot $reg).Count -eq 1) 'a second init added a duplicate registry line'
        Check ((@($second.files) | Where-Object { $_.file -ceq 'CLAUDE.md' }).action -ceq 'unchanged') 'a second init rewrote an unchanged CLAUDE.md'

        # --- A WORKSPACE ITS OWN CHECKS PASS (S42, the reader's ruling) ------------------------------
        foreach ($slug in 'holding', 'reports') {
            Check (Test-Path -LiteralPath (Join-Path $fresh "shelf/$slug/wiki/notes") -PathType Container) "a fresh init laid out no capture Book at shelf/$slug"
            Check ([string](@($first.files) | Where-Object { $_.file -ceq "shelf/$slug" }).action -ceq 'created') "a fresh init did not report shelf/$slug created"
            Check ([string](@($second.files) | Where-Object { $_.file -ceq "shelf/$slug" }).action -ceq 'unchanged') "a second init did not leave shelf/$slug unchanged"
        }
        $freshCatalog = [IO.File]::ReadAllText((Join-Path $fresh 'shelf/_catalog.md'), $script:Utf8)
        Check ($freshCatalog -match '(?m)^## Holding Shelf\n(?:- .*\n)*- \*\*Kind:\*\* capture\n(?:- .*\n)*- \*\*Path:\*\* shelf/holding$') 'the rendered catalog does not list the Holding Shelf as a capture Book'
        Check ($freshCatalog -match '(?m)^- \*\*Path:\*\* shelf/reports$') 'the rendered catalog does not list the Report Inbox'
        Check ([IO.File]::ReadAllText((Get-NotebookMasterIndexPath -Workspace $fresh), $script:Utf8) -ceq (Get-NotebookEmptyMasterIndexText)) 'a fresh init did not write the empty master index'
        Check ([string](@($second.files) | Where-Object { $_.file -ceq 'shelf/_catalog.md' }).action -ceq 'unchanged') 'a second init re-rendered a catalog it had nothing to add to'
        # Its own folder: the cases above have put a topic with no index under $fresh's notebook/.
        $green = Join-Path $tmp 'green'
        [void](Invoke-LibraryWorkspaceInit -Path $green -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program)
        $previousRegistry = $env:LIBRARY_WORKSPACES
        try {
            $env:LIBRARY_WORKSPACES = $reg
            $checksText = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Invoke-LibraryChecks.ps1') -WorkspacePath $green -WorkspaceOnly -Json 2>$null | Out-String
        }
        finally { $env:LIBRARY_WORKSPACES = $previousRegistry }
        $checks = $null
        try { $checks = $checksText | ConvertFrom-Json } catch { }
        Check ($null -ne $checks -and [int]$checks.failed -eq 0 -and [int]$checks.passed -gt 0) "the checks failed over a freshly initialised workspace: $(if ($null -ne $checks) { @($checks.checks | Where-Object { $_.status -cne 'pass' -and $_.status -cne 'warn' } | ForEach-Object { "$($_.check): $($_.detail)" }) -join '; ' } else { $checksText })"

        $kept = Join-Path $tmp 'kept-holding'
        New-Item -ItemType Directory -Path (Join-Path $kept 'shelf/holding/wiki') -Force | Out-Null
        $keptPage = Join-Path $kept 'shelf/holding/wiki/_book.md'
        [IO.File]::WriteAllText($keptPage, "# Mine`n", $script:Utf8)
        [IO.File]::WriteAllText((Join-Path $kept 'shelf/holding/_catalog-entry.md'), (New-ShelfCatalogEntryText -Slug 'holding' -Title 'Mine' -Line @('- **Summary:** mine')), $script:Utf8)
        $keptRun = Invoke-LibraryWorkspaceInit -Path $kept -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program
        Check ([IO.File]::ReadAllText($keptPage, $script:Utf8) -ceq "# Mine`n" -and [string](@($keptRun.files) | Where-Object { $_.file -ceq 'shelf/holding' }).action -ceq 'unchanged') 'init touched a Holding Shelf the workspace already had'

        $husk = Join-Path $tmp 'husk'
        New-Item -ItemType Directory -Path (Join-Path $husk 'shelf/reports') -Force | Out-Null
        $huskThrew = ''
        try { [void](Invoke-LibraryWorkspaceInit -Path $husk -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program) }
        catch { $huskThrew = [string]$_.Exception.Message }
        Check ($huskThrew -match 'is a husk rather than a Book') "a husk at shelf/reports was not refused; got '$huskThrew'"
        Check (-not (Test-WorkspaceMarkerPresent $husk) -and -not (Test-Path -LiteralPath (Join-Path $husk 'shelf/holding'))) 'a run refused over a husk still wrote'

        $unrenderable = Join-Path $tmp 'unrenderable'
        New-Item -ItemType Directory -Path (Join-Path $unrenderable 'shelf/other/wiki') -Force | Out-Null
        $renderThrew = ''
        try { [void](Invoke-LibraryWorkspaceInit -Path $unrenderable -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program) }
        catch { $renderThrew = [string]$_.Exception.Message }
        Check ($renderThrew -match 'the Shelf cannot be rendered') "a Shelf that cannot be rendered was not refused before the writes; got '$renderThrew'"
        Check (-not (Test-WorkspaceMarkerPresent $unrenderable) -and -not (Test-Path -LiteralPath (Join-Path $unrenderable 'shelf/holding'))) 'a run refused over an unrenderable Shelf still wrote'

        # --- THE LOCAL COLLECTION (ADR-0030, S30) ---------------------------------------------------
        $idFile = Join-Path $fresh 'collection/.library/collection.json'
        Check (Test-Path -LiteralPath $idFile -PathType Leaf) 'a Tier 0 init laid out no collection id file'
        foreach ($relative in 'books/README.md', 'projects/README.md', 'archive/projects/README.md') {
            Check (Test-Path -LiteralPath (Join-Path $fresh "collection/$relative") -PathType Leaf) "a Tier 0 init laid out no collection/$relative"
        }
        $collectionId = [string](Get-Content -LiteralPath $idFile -Raw | ConvertFrom-Json).id
        Check ($collectionId -match '^[0-9a-f-]{36}$') "the local collection's id is '$collectionId'"
        Check ((Get-WorkspaceMarkerField (Read-WorkspaceMarker -Workspace $fresh) 'collection_id') -ceq $collectionId) "the marker does not record the local collection's id"
        $catalogPath = Join-Path $fresh 'collection/projects/README.md'
        [IO.File]::AppendAllText($catalogPath, "- [[projects/kept/_project|Kept]]`n")
        $keptCatalog = [IO.File]::ReadAllText($catalogPath)
        [void](Invoke-LibraryWorkspaceInit -Path $fresh -Writable $false -Force $true -RegistryRoot $reg -ProgramRoot $program)
        Check ([IO.File]::ReadAllText($catalogPath) -ceq $keptCatalog) 'init --force rewrote a catalog the collection already had'
        Check ([string](Get-Content -LiteralPath $idFile -Raw | ConvertFrom-Json).id -ceq $collectionId) 'init --force re-minted the collection id'
        $retargetThrew = ''
        try { [void](Invoke-LibraryWorkspaceInit -Path $fresh -CollectionId ([guid]::NewGuid().ToString()) -Writable $false -Force $true -RegistryRoot $reg -ProgramRoot $program) }
        catch { $retargetThrew = $_.Exception.Message }
        Check ($retargetThrew -match 'will not retarget the workspace') "an init naming another collection than collection.json did not refuse: '$retargetThrew'"
        Check ((Get-WorkspaceMarkerField (Read-WorkspaceMarker -Workspace $fresh) 'collection_id') -ceq $collectionId) 'a refused retarget still changed the marker'

        # --- THE MARKER KEEPS ITS COLLECTION ON A RE-RUN (the Report Inbox, 2026-09-22) -------------
        # An endpoint means no local collection, so the marker is the only record of the id.
        $pinned = Join-Path $tmp 'pinned'
        $pinId = [guid]::NewGuid().ToString()
        [void](Invoke-LibraryWorkspaceInit -Path $pinned -McpUrl 'http://127.0.0.1:1/mcp' -CollectionId $pinId -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program)
        Check (-not (Test-Path -LiteralPath (Join-Path $pinned 'collection'))) 'a workspace with an endpoint was given a local collection'
        [void](Invoke-LibraryWorkspaceInit -Path $pinned -McpUrl 'http://127.0.0.1:1/mcp' -Writable $false -Force $true -RegistryRoot $reg -ProgramRoot $program)
        Check ((Get-WorkspaceMarkerField (Read-WorkspaceMarker -Workspace $pinned) 'collection_id') -ceq $pinId) 'a re-run with no collection id emptied the one the marker recorded'

        # --- THE READER'S OWN CLAUDE.md ------------------------------------------------------------
        # The assertion that matters: their words survive, byte for byte, above AND below the block.
        $owned = Join-Path $tmp 'owned'
        New-Item -ItemType Directory -Path $owned -Force | Out-Null
        $mine = "# My project`n`nBuild with ``make``.`n`n## Notes`n`nDo not touch this line.`n"
        [IO.File]::WriteAllText((Join-Path $owned 'CLAUDE.md'), $mine, $script:Utf8)
        Invoke-LibraryWorkspaceInit -Path $owned -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program | Out-Null
        $after = [IO.File]::ReadAllText((Join-Path $owned 'CLAUDE.md'), $script:Utf8)
        Check ($after.StartsWith($mine.TrimEnd())) "the reader's own CLAUDE.md was not preserved verbatim at the head"
        Check ($after.Contains('Do not touch this line.')) "the reader's own text was lost"
        Check ($after.Contains($script:SectionBegin)) 'the managed section was not appended to an existing file'

        # A SECOND RUN AGAINST THE SAME FILE MUST NOT APPEND A SECOND BLOCK. This is the case that
        # separates "insert or update one section" from "append every time", and the two look
        # identical after one run.
        Invoke-LibraryWorkspaceInit -Path $owned -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program | Out-Null
        $twice = [IO.File]::ReadAllText((Join-Path $owned 'CLAUDE.md'), $script:Utf8)
        Check (([regex]::Matches($twice, [regex]::Escape($script:SectionBegin))).Count -eq 1) 'a second init appended a second managed section'
        Check ($twice -ceq $after) 'a second init changed a file it had nothing to change'

        # AND AN UPDATE REPLACES ONLY THE INSIDE. Rewriting the block with different content must
        # leave the reader's surrounding text untouched.
        $stale = $after.Replace('## The Virtual Desk', '## SOMETHING OLD')
        [IO.File]::WriteAllText((Join-Path $owned 'CLAUDE.md'), $stale, $script:Utf8)
        Invoke-LibraryWorkspaceInit -Path $owned -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program | Out-Null
        $refreshed = [IO.File]::ReadAllText((Join-Path $owned 'CLAUDE.md'), $script:Utf8)
        Check (-not $refreshed.Contains('SOMETHING OLD')) 'a stale managed section was not refreshed'
        Check ($refreshed.Contains('Do not touch this line.')) "refreshing the section lost the reader's own text"

        # --- MALFORMED MARKERS ARE A REFUSAL, AND NOTHING IS WRITTEN --------------------------------
        foreach ($case in @(
                @{ name = 'lone-begin'; text = "# Mine`n`n$($script:SectionBegin)`nhalf a block`n" },
                @{ name = 'inverted';   text = "# Mine`n`n$($script:SectionEnd)`nx`n$($script:SectionBegin)`n" },
                @{ name = 'doubled';    text = "$($script:SectionBegin)`na`n$($script:SectionEnd)`n$($script:SectionBegin)`nb`n$($script:SectionEnd)`n" })) {
            $bad = Join-Path $tmp ('bad-' + $case.name)
            New-Item -ItemType Directory -Path $bad -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $bad 'CLAUDE.md'), $case.text, $script:Utf8)
            $threw = ''
            try { Invoke-LibraryWorkspaceInit -Path $bad -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program | Out-Null }
            catch { $threw = [string]$_.Exception.Message }
            Check ($threw -match 'refused and wrote nothing') "malformed markers ($($case.name)) did not refuse; got '$threw'"
            # THE REFUSAL HAS TO BE TOTAL. A marker written before the refusal would leave a
            # half-initialised workspace whose CLAUDE.md nobody managed.
            Check (-not (Test-WorkspaceMarkerPresent $bad)) "a refused init ($($case.name)) wrote the marker anyway"
            Check (([IO.File]::ReadAllText((Join-Path $bad 'CLAUDE.md'), $script:Utf8)) -ceq $case.text) `
                "a refused init ($($case.name)) modified the file it refused"
        }

        # --- THE SETTINGS MERGE ----------------------------------------------------------------------
        # Unrelated entries survive; an equal entry is not a change; a different one refuses.
        $merged = Merge-LibraryJsonValue -Existing ('{"mcpServers":{"other":{"command":"x"}},"unrelated":7}' | ConvertFrom-Json) `
            -Desired (Get-DesiredMcpServers -AdapterPath 'a.ps1') -KeyPath '.mcp.json'
        Check (@($merged.conflicts).Count -eq 0) "merging into an unrelated file conflicted: $(@($merged.conflicts) -join '; ')"
        Check ($merged.changed) 'merging a missing server reported no change'
        Check ($merged.value.Contains('unrelated')) 'the merge dropped an unrelated top-level key'
        Check ($merged.value['mcpServers'].Contains('other')) "the merge dropped the reader's own MCP server"
        Check ($merged.value['mcpServers'].Contains('validated-book-reader')) 'the merge did not add the Library server'

        $conflicting = Merge-LibraryJsonValue -Existing ('{"mcpServers":{"validated-book-reader":{"command":"bash"}}}' | ConvertFrom-Json) `
            -Desired (Get-DesiredMcpServers -AdapterPath 'a.ps1') -KeyPath '.mcp.json'
        Check (@($conflicting.conflicts).Count -ge 1) 'a server pointing somewhere else was merged over silently'
        Check ((@($conflicting.conflicts) -join ' ') -match 'command') "the conflict did not name the key: $(@($conflicting.conflicts) -join '; ')"

        $same = Merge-LibraryJsonValue -Existing ((Get-DesiredMcpServers -AdapterPath 'a.ps1') | ConvertTo-Json -Depth 8 | ConvertFrom-Json) `
            -Desired (Get-DesiredMcpServers -AdapterPath 'a.ps1') -KeyPath '.mcp.json'
        Check (-not $same.changed) 'an already-correct settings file was reported as changed'
        Check (@($same.conflicts).Count -eq 0) 'an already-correct settings file reported a conflict'

        # A LIST IS A SET AND IS NEVER REPLACED, which is what the permission allowlist is.
        $list = Merge-LibraryJsonValue -Existing (@('mine', 'shared') | ConvertTo-Json | ConvertFrom-Json) `
            -Desired @('shared', 'library') -KeyPath 'allow'
        Check (@($list.value).Count -eq 3) "a list merge produced $(@($list.value).Count) entries rather than 3"
        Check (@($list.value) -ccontains 'mine') "a list merge dropped the reader's own entry"

        # --- THE PERMISSION ALLOWLIST REACHES A NEW WORKSPACE ------------------------------------------
        # Derived from the program's own settings, so this asserts the COUNT matches that source
        # rather than a number written here: a literal would go stale the next time a reader tool is
        # added, and would go stale silently, which is the failure this whole file argues against.
        $expectedAllow = @(Get-DesiredPermissionAllowlist -ProgramRoot $program)
        Check ($expectedAllow.Count -gt 0) 'the program declares no validated-reader permissions, so this case proves nothing'
        $freshSettings = Join-Path $fresh '.claude/settings.json'
        Check (Test-Path -LiteralPath $freshSettings -PathType Leaf) 'init wrote no settings.json into a fresh workspace'
        $freshAllow = @(([IO.File]::ReadAllText($freshSettings, $script:Utf8) | ConvertFrom-Json).permissions.allow)
        Check ($freshAllow.Count -eq $expectedAllow.Count) "the fresh workspace got $($freshAllow.Count) permission(s) where the program declares $($expectedAllow.Count)"

        # A reader's own entry survives, and the Library's are not added twice.
        # EXACTLY ONE ENTRY, AND THE CARDINALITY IS THE COVERAGE. A one-element list is the shape
        # that unrolls to a bare scalar on its way through a pipeline, and that is what this fixture
        # caught on the day it was written: the merge refused an ordinary settings.json holding a
        # single permission. Two entries here would pass against the broken code. Do not "tidy" it.
        [IO.File]::WriteAllText($freshSettings,
            (@{ permissions = @{ allow = @('Bash(ls:*)') ; deny = @() } } | ConvertTo-Json -Depth 6), $script:Utf8)
        Invoke-LibraryWorkspaceInit -Path $fresh -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program | Out-Null
        $mergedAllow = @(([IO.File]::ReadAllText($freshSettings, $script:Utf8) | ConvertFrom-Json).permissions.allow)
        Check (@($mergedAllow) -ccontains 'Bash(ls:*)') "the settings merge dropped the reader's own permission"
        Check ($mergedAllow.Count -eq ($expectedAllow.Count + 1)) "the settings merge produced $($mergedAllow.Count) entries rather than $($expectedAllow.Count + 1)"
        $thirdRun = Invoke-LibraryWorkspaceInit -Path $fresh -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program
        $again = @(([IO.File]::ReadAllText($freshSettings, $script:Utf8) | ConvertFrom-Json).permissions.allow)
        Check ($again.Count -eq $mergedAllow.Count) 'a repeated init duplicated the permission entries'
        Check ((@($thirdRun.files) | Where-Object { $_.file -ceq '.claude/settings.json' }).action -ceq 'unchanged') `
            'a repeated init rewrote an already-correct settings.json'

        # --- THE GUARDS GO TO THE LOCAL FILE, AND THE TRACKED ONE KEEPS THE ALLOWLIST ------------------
        # ADR-0036 as amended on 2026-09-21. S18 built the registration and NOTHING ASSERTED WHERE IT
        # LANDED, which is how one machine's absolute program paths came to be sitting uncommitted in
        # the reader's knowledge repository with no check to say so. These cases are what the next
        # move would have to get past.
        $desiredHooks = Get-DesiredHookRegistration -ProgramRoot $program
        Check ($null -ne $desiredHooks) 'the program declares no hooks, so every case below proves nothing'
        # READ DEFENSIVELY, because this suite COLLECTS failures rather than stopping at the first
        # one, and an unguarded read of a file the injection just moved turns that into a crash --
        # which is the fail-fast trap in a suite that was built not to have one. Guarded, one
        # injection shows every assertion it breaks.
        $freshLocal = Join-Path $fresh '.claude/settings.local.json'
        $localDoc = $null
        if (Test-Path -LiteralPath $freshLocal -PathType Leaf) {
            $localDoc = [IO.File]::ReadAllText($freshLocal, $script:Utf8) | ConvertFrom-Json
        }
        Check ($null -ne $localDoc) 'init wrote no settings.local.json into a fresh split workspace'
        if ($null -eq $localDoc) { $localDoc = [pscustomobject]@{ hooks = $null } }
        # Compared through ONE serializer and against the PROGRAM'S OWN block rather than a literal:
        # a hook added to the program must reach a new workspace by that edit alone, and a literal
        # here would go stale silently the next time one is.
        Check (($localDoc.hooks | ConvertTo-Json -Depth 12) -ceq ($desiredHooks | ConvertTo-Json -Depth 12)) `
            'the block written to settings.local.json is not the program''s own hook block'

        # --- AND IT HAS TO BE A SHAPE THE HARNESS WILL LOAD ------------------------------------------
        # The assertion above compares the written block against the program's. Two blocks that AGREE
        # can both be unloadable, which is what happened: the derivation unrolled every one-element
        # array into a bare object, `ConvertTo-Json` wrote objects where Claude Code requires arrays,
        # and the harness answered "must be an array of matchers; received object. This entry was
        # ignored ... Files with errors are skipped entirely". So the workspace ADR-0036 exists to
        # guard had no guards at all, and nothing said so for three days because no session had been
        # rooted there. Judged off DISK, through the same judge the package uses.
        $writtenFaults = @(Test-ClaudeHookShape -Document $localDoc -Label 'the written settings.local.json')
        Check (-not $writtenFaults.Count) "the written hook block is not a shape Claude Code will load: $($writtenFaults -join '; ')"

        # THE CARDINALITY IS THE COVERAGE, and without this the case above can pass vacuously. ONLY a
        # ONE-ELEMENT array unrolls; the program's three-entry PreToolUse survived the defect intact
        # and would have kept every assertion here green on its own. So the fixture asserts that at
        # least one single-entry event is actually present to be got wrong.
        $singleEntryEvents = @(@($localDoc.hooks.PSObject.Properties) |
            Where-Object { $_.Value -is [Array] -and @($_.Value).Count -eq 1 })
        Check ($singleEntryEvents.Count -gt 0) `
            'no hook event holds exactly one matcher, so the unrolling this case exists for could not occur and it proves nothing'
        # THE TWO ASSERTIONS THE CHANGE IS ACTUALLY FOR, and they are about ABSENCE in each file.
        $freshDoc = [IO.File]::ReadAllText($freshSettings, $script:Utf8) | ConvertFrom-Json
        Check (@($freshDoc.PSObject.Properties | ForEach-Object { $_.Name }) -cnotcontains 'hooks') `
            'the tracked settings.json carries a hook block, which is the machine-local value this file keeps out of it'
        Check (@($localDoc.PSObject.Properties | ForEach-Object { $_.Name }) -cnotcontains 'permissions') `
            'the permission allowlist leaked into the untracked settings.local.json'

        # --- THE MIGRATION: A BLOCK ALREADY IN THE TRACKED FILE LEAVES IT -----------------------------
        # Every workspace initialised between ADR-0036 and its amendment is in this state, including
        # the reader's own. Writing the new copy without removing the old one is not a move: it is two
        # registrations of the same nine hooks with the machine-local paths still in the tracked file.
        $theirHooks = '{"PreToolUse":[{"matcher":"Read","hooks":[{"type":"command","command":"powershell.exe","args":["-File","C:/theirs/Their-Hook.ps1"]}]}]}'
        $moved = Join-Path $tmp 'moved'
        New-Item -ItemType Directory -Path (Join-Path $moved '.claude') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $moved '.claude/settings.json'),
            (([ordered]@{ permissions = [ordered]@{ allow = @('Bash(ls:*)') }; hooks = $desiredHooks } | ConvertTo-Json -Depth 12)), $script:Utf8)
        Invoke-LibraryWorkspaceInit -Path $moved -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program | Out-Null
        $movedTracked = [IO.File]::ReadAllText((Join-Path $moved '.claude/settings.json'), $script:Utf8) | ConvertFrom-Json
        Check (@($movedTracked.PSObject.Properties | ForEach-Object { $_.Name }) -cnotcontains 'hooks') `
            'a Library-owned hook block was left behind in the tracked settings.json'
        Check (@($movedTracked.permissions.allow) -ccontains 'Bash(ls:*)') "the migration dropped the reader's own permission"
        $movedLocalPath = Join-Path $moved '.claude/settings.local.json'
        $movedLocal = [pscustomobject]@{ hooks = $null }
        if (Test-Path -LiteralPath $movedLocalPath -PathType Leaf) {
            $movedLocal = [IO.File]::ReadAllText($movedLocalPath, $script:Utf8) | ConvertFrom-Json
        }
        Check (($movedLocal.hooks | ConvertTo-Json -Depth 12) -ceq ($desiredHooks | ConvertTo-Json -Depth 12)) `
            'the migrated hook block did not arrive in settings.local.json'
        $movedAgain = Invoke-LibraryWorkspaceInit -Path $moved -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program
        foreach ($file in @('.claude/settings.json', '.claude/settings.local.json')) {
            Check ((@($movedAgain.files) | Where-Object { $_.file -ceq $file }).action -ceq 'unchanged') `
                "a repeated init rewrote an already-correct $file"
        }

        # A BLOCK THE READER WROTE IS THEIRS AND THE MIGRATION MUST WALK PAST IT. The failure this
        # pins is the one that would be invisible: `library init` deleting a reader's own hook
        # registration out of a tracked file on the way past, reported as an ordinary merge.
        $keeps = Join-Path $tmp 'keeps'
        New-Item -ItemType Directory -Path (Join-Path $keeps '.claude') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $keeps '.claude/settings.json'), ('{"hooks":' + $theirHooks + '}'), $script:Utf8)
        Invoke-LibraryWorkspaceInit -Path $keeps -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program | Out-Null
        $keptText = [IO.File]::ReadAllText((Join-Path $keeps '.claude/settings.json'), $script:Utf8)
        Check ($keptText -match 'Their-Hook') "init removed or rewrote a hook block the reader wrote in the tracked settings.json"
        Check ((@(($keptText | ConvertFrom-Json).permissions.allow)).Count -eq $expectedAllow.Count) `
            'the allowlist did not reach a workspace whose tracked settings.json carries the reader''s own hooks'

        # --- A FOREIGN BLOCK IN THE LOCAL FILE REFUSES, AND REFUSES TOTALLY ---------------------------
        $foreignLocal = Join-Path $tmp 'foreign-local'
        New-Item -ItemType Directory -Path (Join-Path $foreignLocal '.claude') -Force | Out-Null
        $foreignText = '{"hooks":' + $theirHooks + '}'
        [IO.File]::WriteAllText((Join-Path $foreignLocal '.claude/settings.local.json'), $foreignText, $script:Utf8)
        $foreignThrew = ''
        try { Invoke-LibraryWorkspaceInit -Path $foreignLocal -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program | Out-Null }
        catch { $foreignThrew = [string]$_.Exception.Message }
        Check ($foreignThrew -match 'already registers hooks the Library did not write') `
            "a foreign hook block in settings.local.json was not refused; got '$foreignThrew'"
        Check (-not (Test-WorkspaceMarkerPresent $foreignLocal)) 'a refused init wrote the marker anyway'
        Check (([IO.File]::ReadAllText((Join-Path $foreignLocal '.claude/settings.local.json'), $script:Utf8)) -ceq $foreignText) `
            'a refused init modified the settings.local.json it refused'

        # --- AN UN-SPLIT CHECKOUT KEEPS ITS OWN INSTRUCTION FILES --------------------------------------
        # The case this tool's own first run failed. A workspace that is ALSO the program root has a
        # CLAUDE.md written by the program's authors; init must register the workspace and leave that
        # file alone. Asserted on the bytes, because "reported skipped" and "actually not written"
        # are different claims and only the second one matters.
        $unsplit = Join-Path $tmp 'unsplit'
        New-Item -ItemType Directory -Path (Join-Path $unsplit 'tools') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $unsplit 'tools/BookRootSchema.ps1'), '# program marker', $script:Utf8)
        $theirs = "# The program's own rules`n`nUnchanged by init.`n"
        [IO.File]::WriteAllText((Join-Path $unsplit 'CLAUDE.md'), $theirs, $script:Utf8)
        $unsplitResult = Invoke-LibraryWorkspaceInit -Path $unsplit -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program
        Check ((@($unsplitResult.files) | Where-Object { $_.file -ceq 'CLAUDE.md' }).action -ceq 'skipped-program-file') `
            "an un-split checkout's CLAUDE.md was not skipped"
        Check (([IO.File]::ReadAllText((Join-Path $unsplit 'CLAUDE.md'), $script:Utf8)) -ceq $theirs) `
            "init rewrote an un-split checkout's own CLAUDE.md"
        Check (-not (Test-Path -LiteralPath (Join-Path $unsplit 'AGENTS.md') -PathType Leaf)) `
            'init created an AGENTS.md in a checkout whose instruction files are the program''s'
        # The workspace is still REGISTERED, which is the half that must happen either way.
        Check (Test-WorkspaceMarkerPresent $unsplit) 'an un-split checkout was not given a marker'
        Check (@(Read-WorkspaceRegistry -RegistryRoot $reg | Where-Object { $_.root -eq (ConvertTo-WorkspaceRoot $unsplit) }).Count -eq 1) `
            'an un-split checkout was not registered'

        # --- THE CODEX HALF OF THE SAME BOUNDARY (2026-09-22) -----------------------------------------
        # The fresh workspace above is the subject: every assertion here reads what init actually wrote
        # into it, and the two judges that read it are the ones the GATE reads it with, so a document
        # that passes here is a document `workspace.codex-guards-registered` accepts.
        . (Join-Path $PSScriptRoot 'HookRegistry.ps1')
        $codexHooksFile = Join-Path $fresh '.codex/hooks.json'
        $codexConfigFile = Join-Path $fresh '.codex/config.toml'
        Check (Test-Path -LiteralPath $codexHooksFile -PathType Leaf) 'init wrote no .codex/hooks.json, so a Codex seat in the workspace would be unguarded'
        Check (Test-Path -LiteralPath $codexConfigFile -PathType Leaf) 'init wrote no .codex/config.toml, so a Codex seat in the workspace would have no reader'
        $codexDoc = [IO.File]::ReadAllText($codexHooksFile, $script:Utf8) | ConvertFrom-Json
        Check (@(Test-CodexHookShape -Document $codexDoc).Count -eq 0) `
            "the .codex/hooks.json init wrote is not a shape Codex will load: $((@(Test-CodexHookShape -Document $codexDoc)) -join '; ')"
        Check (@(Get-CodexRegistrationProblems -Document $codexDoc).Count -eq 0) `
            "the .codex/hooks.json init wrote is mis-registered: $((@(Get-CodexRegistrationProblems -Document $codexDoc)) -join ' ')"
        # EVERY PATH, because a registration naming a script that is not there is a hook that cannot
        # start, and the program's own generated bindings spent a day in exactly that state.
        $codexPaths = @(@($codexDoc.hooks.PSObject.Properties) | ForEach-Object {
            foreach ($block in @($_.Value)) { foreach ($entry in @($block.hooks)) { (Get-HookEntryText $entry) } }
        })
        Check ($codexPaths.Count -eq 4) "init registered $($codexPaths.Count) Codex hook(s) rather than 4"
        foreach ($text in $codexPaths) {
            foreach ($token in @($text -split '\s+')) {
                $candidate = $token.Trim('"')
                if ($candidate -cnotlike '*.ps1') { continue }
                Check ([IO.Path]::IsPathRooted($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) `
                    "a Codex registration names a script that is not there: $candidate"
            }
        }
        # THE SHAPE JUDGE IS FALSIFIED HERE RATHER THAN TRUSTED. A document with an event at the ROOT
        # is the exact file Codex rejected for months while this tree called it valid; if the judge
        # does not fire on it, every assertion above is decoration.
        $rootedEvent = '{"PreToolUse":[{"hooks":[{"type":"command","command":"x"}]}]}' | ConvertFrom-Json
        Check (@(Test-CodexHookShape -Document $rootedEvent).Count -gt 0) `
            'Test-CodexHookShape accepted a hooks document with the event at the root, which Codex rejects outright'
        # And the reader is named with THIS workspace's state directory, not with whatever directory
        # the client happens to launch the server in.
        $codexConfigText = [IO.File]::ReadAllText($codexConfigFile, $script:Utf8)
        Check ($codexConfigText.Contains((Get-CodexManagedMarker))) 'the rendered .codex/config.toml carries no managed marker, so a re-run cannot tell its own file from the reader''s'
        Check ($codexConfigText -match '(?m)^\[mcp_servers\.validated-book-reader\]\s*$') 'the rendered .codex/config.toml does not declare the validated reader'
        Check ($codexConfigText -cnotmatch '(?m)^\[mcp_servers\.basic-memory\]\s*$') 'the rendered .codex/config.toml declares basic-memory, which a workspace deliberately does not'
        Check ($codexConfigText -match '-StateDirectory') 'the rendered .codex/config.toml does not name the workspace it is serving'
        Check ($codexConfigText -match '(?m)^args\s*=\s*\[[^\r\n]+\]\s*$') 'the rendered reader argument list is not a one-line TOML array'

        # A RE-RUN CHANGES NEITHER FILE. Both were already asserted `unchanged` for CLAUDE.md above;
        # these two are rendered rather than merged, so their idempotence is a separate claim.
        $codexHooksBefore = [IO.File]::ReadAllText($codexHooksFile, $script:Utf8)
        $codexConfigBefore = [IO.File]::ReadAllText($codexConfigFile, $script:Utf8)
        $codexAgain = Invoke-LibraryWorkspaceInit -Path $fresh -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program
        Check ((@($codexAgain.files) | Where-Object { $_.file -ceq '.codex/hooks.json' }).action -ceq 'unchanged') 'a re-run rewrote an unchanged .codex/hooks.json'
        Check ((@($codexAgain.files) | Where-Object { $_.file -ceq '.codex/config.toml' }).action -ceq 'unchanged') 'a re-run rewrote an unchanged .codex/config.toml'
        Check (([IO.File]::ReadAllText($codexHooksFile, $script:Utf8)) -ceq $codexHooksBefore) 'a re-run changed the bytes of .codex/hooks.json'
        Check (([IO.File]::ReadAllText($codexConfigFile, $script:Utf8)) -ceq $codexConfigBefore) 'a re-run changed the bytes of .codex/config.toml'

        # --- AND THE READER'S OWN CODEX FILES ARE REFUSED, NOT OVERWRITTEN ----------------------------
        # Two documents, two ownership rules, so two cases. The hooks file is judged by its entries and
        # the config by its marker, and a workspace that refuses must be left exactly as it was found.
        $codexForeign = Join-Path $tmp 'codex-foreign'
        New-Item -ItemType Directory -Path (Join-Path $codexForeign '.codex') -Force | Out-Null
        $theirCodexHooks = '{"hooks":{"PreToolUse":[{"matcher":"^Bash$","hooks":[{"type":"command","command":"powershell.exe -File C:/theirs/Their-Codex-Hook.ps1"}]}]}}'
        [IO.File]::WriteAllText((Join-Path $codexForeign '.codex/hooks.json'), $theirCodexHooks, $script:Utf8)
        $codexThrew = ''
        try { Invoke-LibraryWorkspaceInit -Path $codexForeign -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program | Out-Null }
        catch { $codexThrew = [string]$_.Exception.Message }
        Check ($codexThrew -match 'already registers Codex hooks the Library did not write') `
            "a foreign .codex/hooks.json was not refused; got '$codexThrew'"
        Check (-not (Test-WorkspaceMarkerPresent $codexForeign)) 'a refused init wrote the marker anyway'
        Check (([IO.File]::ReadAllText((Join-Path $codexForeign '.codex/hooks.json'), $script:Utf8)) -ceq $theirCodexHooks) `
            'a refused init modified the .codex/hooks.json it refused'

        $codexOwnedConfig = Join-Path $tmp 'codex-own-config'
        New-Item -ItemType Directory -Path (Join-Path $codexOwnedConfig '.codex') -Force | Out-Null
        $theirCodexConfig = "[mcp_servers.mine]`ncommand = `"node`"`n"
        [IO.File]::WriteAllText((Join-Path $codexOwnedConfig '.codex/config.toml'), $theirCodexConfig, $script:Utf8)
        $configThrew = ''
        try { Invoke-LibraryWorkspaceInit -Path $codexOwnedConfig -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program | Out-Null }
        catch { $configThrew = [string]$_.Exception.Message }
        Check ($configThrew -match 'carries no managed marker') "a reader's own .codex/config.toml was not refused; got '$configThrew'"
        Check (([IO.File]::ReadAllText((Join-Path $codexOwnedConfig '.codex/config.toml'), $script:Utf8)) -ceq $theirCodexConfig) `
            'a refused init modified the .codex/config.toml it refused'
        Check (-not (Test-Path -LiteralPath (Join-Path $codexOwnedConfig '.codex/hooks.json') -PathType Leaf)) `
            'a run refused over .codex/config.toml still wrote .codex/hooks.json beside it'

        # --- A NON-DRIVE-ROOTED PATH IS REFUSED ------------------------------------------------------
        $uncThrew = ''
        try { Invoke-LibraryWorkspaceInit -Path '\\server\share\ws' -Writable $false -Force $false -RegistryRoot $reg -ProgramRoot $program | Out-Null }
        catch { $uncThrew = [string]$_.Exception.Message }
        Check ($uncThrew -match 'drive-rooted') "a UNC workspace was not refused; got '$uncThrew'"
    }
    finally {
        try { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }

    if ($failures.Count) {
        [Console]::Error.WriteLine("Initialize-LibraryWorkspace self-test FAILED: $($failures -join '; ')")
        exit 1
    }
    Write-Host "Initialize-LibraryWorkspace self-test passed ($script:initChecks checks)."
    exit 0
}

. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')

# `return`, and it is not decoration. Without it this ran the self-test and then FELL THROUGH to
# the real run below, where an omitted -Path defaults to the current directory -- so
# `Initialize-LibraryWorkspace.ps1 -SelfTest` initialised whatever folder it was invoked from as a
# workspace and added it to the machine registry. Observed 2026-09-21 doing exactly that to the
# program root, minutes after that root's marker had been deliberately retired. Every other
# self-test in tools/ either returns or exits; this one did neither.
if ($SelfTest) { Invoke-LibraryWorkspaceInitSelfTest; return }

if ([string]::IsNullOrWhiteSpace($Path)) { $Path = (Get-Location).ProviderPath }
$result = Invoke-LibraryWorkspaceInit -Path $Path -McpUrl $McpUrl -CollectionId $CollectionId `
    -Writable ([bool]$Writable) -Force ([bool]$Force) -RegistryRoot $RegistryRoot `
    -ProgramRoot (Split-Path -Parent $PSScriptRoot)

if ($Json) { $result | ConvertTo-Json -Depth 6; exit 0 }

Write-Host "Workspace $($result.status): $($result.workspace)"
Write-Host "  id        $($result.id)"
Write-Host "  backend   $($result.backend)$(if (-not $result.writable) { ' (read-only attachment)' })"
Write-Host "  registry  $($result.registry) [$($result.registration)]"
foreach ($file in @($result.files)) { Write-Host "  $($file.action.PadRight(9)) $($file.file)" }
