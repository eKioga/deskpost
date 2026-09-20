<#
.SYNOPSIS
    The acceptance suite for tools/Export-CollectionToVault.ps1 -- PLAN-public-release.md step 15's
    five named cases, plus the guards they sit on.

.DESCRIPTION
    Dot-sourced by `Export-CollectionToVault.ps1 -SelfTest` and run in-process, never spawned: the
    exporter returns objects and a child `powershell.exe -File` would hand back their text, so every
    assertion would be reading a rendered table.

    THE FIVE CASES the step names, each with the name it is asserted under:

      fresh export                      -> case 1
      unchanged re-export writes nothing -> case 2
      an edited destination refuses      -> case 3
      an interrupted run resumes         -> case 4
      a removed source page is removed   -> case 5

    AND THE THINGS THAT MAKE THEM MEAN SOMETHING. A suite of five happy paths would go green on an
    exporter that copied everything every time and never checked anything, so each case is paired
    with the observation that separates it from that exporter: case 2 compares write timestamps as
    well as hashes, case 3 asserts the edit SURVIVES the refusal, case 4 asserts the resumed mirror
    holds the NEW generation rather than the retained one, and case 5 asserts the path left the
    manifest as well as the disk.

    THE FIXTURE CARRIES BYTES THAT TRAVEL BADLY: a page with non-ASCII text, a page with CRLF line
    endings, and a page with none. "Byte-exact" is the promise, and a copy through a text pipeline
    that normalised any of those would pass an assertion written in characters.
#>

Set-StrictMode -Version Latest

function New-VaultExportFixture {
    <#
        A workspace, a source collection and a vault, all in temp. Returns the three roots.
    #>
    $root = Join-Path ([IO.Path]::GetTempPath()) ('vault-export-' + [guid]::NewGuid().ToString('N'))
    $workspace = Join-Path $root 'workspace'
    $source = Join-Path $root 'collection'
    $vault = Join-Path $root 'vault'
    foreach ($dir in @($workspace, (Join-Path $workspace 'internal'), $source,
                       (Join-Path $source 'books'), (Join-Path $source 'projects'),
                       $vault, (Join-Path $vault '40-Resources'))) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $utf8 = [Text.UTF8Encoding]::new($false)
    $write = {
        param([string]$Relative, [string]$Body)
        $path = Join-Path $source $Relative
        $parent = Split-Path -Parent $path
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        [IO.File]::WriteAllText($path, $Body, $utf8)
    }

    & $write 'books/README.md'              "# Books`n`n- [[demo-book/_book|Demo Book]]`n"
    & $write 'books/demo-book/_book.md'     "---`ntitle: _book`n---`n`n# Demo Book`n`nSee [[wiki/first|the first page]].`n"
    & $write 'books/demo-book/wiki/first.md' "# First`n`nA link that is never rewritten: [[../../projects/demo-project/_project]].`n"
    # BYTES THAT TRAVEL BADLY, one per hazard -- and BUILT FROM CODE POINTS, never typed.
    # A .ps1 in this repository carries no BOM, and Windows PowerShell 5.1 reads a BOM-less file as
    # ANSI: an em dash written literally here decodes as three cp1252 characters, the last of which
    # is a RIGHT DOUBLE QUOTATION MARK, and PowerShell accepts that as a string delimiter. The file
    # then tokenises from there as one long string and the parse error surfaces at the last brace,
    # two hundred lines away. Composing the characters keeps this source ASCII while the fixture
    # FILE still receives the real UTF-8 bytes, which is what the byte-exact assertion needs.
    $accented = "# Caf$([char]0xE9) r$([char]0xE9)sum$([char]0xE9)`n`nNa$([char]0xEF)ve $([char]0x2014) an em dash.`n"
    & $write 'books/demo-book/wiki/accents.md' $accented
    [IO.File]::WriteAllText((Join-Path $source 'books/demo-book/wiki/crlf.md'), "# CRLF`r`n`r`nTwo carriage returns above.`r`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $source 'books/demo-book/wiki/no-eol.md'), '# No trailing newline', $utf8)
    & $write 'projects/README.md'            "# Projects`n`n- [[demo-project/_project|Demo Project]]`n"
    & $write 'projects/demo-project/_project.md' "---`ntitle: _project`n---`n`n# Demo Project`n"
    & $write 'projects/demo-project/notes/2026-09-19-note.md' "# A note`n"

    [pscustomobject]@{ root = $root; workspace = $workspace; source = $source; vault = $vault; mirror = (Join-Path $vault '40-Resources\Library') }
}

function Get-VaultExportFixtureTree {
    <# relative path -> sha256 + last write, for the "wrote nothing" comparison. #>
    param([string]$Path)
    $map = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $map }
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Recurse -Force -File)) {
        $relative = ConvertTo-VaultExportRelative -Root $Path -FullPath $item.FullName
        $map[$relative] = [pscustomobject]@{ sha256 = (Get-VaultExportSha256 $item.FullName); written = $item.LastWriteTimeUtc.Ticks }
    }
    $map
}

function Invoke-VaultExportSelfTest {
    $failures = [Collections.Generic.List[string]]::new()
    $script:vaultExportChecks = 0
    function Assert([bool]$Condition, [string]$Message) {
        $script:vaultExportChecks++
        if (-not $Condition) { [void]$failures.Add($Message) }
    }
    function Get-Refusal([scriptblock]$Body) {
        try { & $Body | Out-Null; return '' }
        catch { return [string]$_.Exception.Message }
    }

    $fx = New-VaultExportFixture
    $export = {
        param([hashtable]$Extra)
        $args = @{ Workspace = $fx.workspace; SourceRoot = $fx.source; VaultRoot = $fx.vault; MirrorRelPath = '40-Resources\Library' }
        foreach ($key in $Extra.Keys) { $args[$key] = $Extra[$key] }
        Invoke-VaultExportRun @args
    }

    try {
        # ==========================================================================================
        # CASE 1: a fresh export
        # ==========================================================================================
        $plan = & $export @{ Preflight = $true }
        Assert ($plan.status -ceq 'preflight') "the preflight reported status '$($plan.status)'"
        Assert ($plan.wrote_nothing) 'the preflight did not declare itself read-only'
        Assert (-not (Test-Path -LiteralPath $fx.mirror)) 'the preflight created the mirror; it must write nothing at all'
        Assert (@($plan.added).Count -eq 9) "the preflight planned $(@($plan.added).Count) new file(s); the fixture has 9"

        $run = & $export @{ UserConfirmed = $true; ApprovedPlanId = $plan.plan_id }
        Assert ($run.status -ceq 'exported') "the first export reported status '$($run.status)'"

        $sourceFiles = Get-VaultExportSourceInventory -SourceRoot $fx.source
        $mirrored = Get-VaultExportFixtureTree -Path $fx.mirror
        foreach ($key in $sourceFiles.Keys) {
            Assert ($mirrored.Contains($key)) "the mirror is missing $key after a fresh export"
            if ($mirrored.Contains($key)) {
                # BYTE-EXACT, asserted on the hash rather than on the text. A copy that normalised
                # CRLF or re-encoded the accented page would pass a string comparison.
                Assert ($mirrored[$key].sha256 -ceq $sourceFiles[$key].sha256) "$key was not mirrored byte-exact"
            }
        }
        $manifestPath = Join-Path $fx.vault '40-Resources\.library-export\current-manifest.json'
        Assert (Test-Path -LiteralPath $manifestPath -PathType Leaf) 'a fresh export wrote no current manifest, so the next run has nothing to verify against'
        $manifest = Get-VaultExportManifestFiles (Read-VaultExportManifest $manifestPath)
        Assert ($manifest.Count -eq $sourceFiles.Count) "the manifest lists $($manifest.Count) file(s) for $($sourceFiles.Count) source file(s)"
        Assert (-not (Get-ChildItem -LiteralPath (Join-Path $fx.vault '40-Resources\.library-export\generations') -Force -ErrorAction SilentlyContinue)) 'a retained generation survived a clean run'
        Assert (-not (Get-ChildItem -LiteralPath (Join-Path $fx.vault '40-Resources\.library-export\staging') -Force -ErrorAction SilentlyContinue)) 'a staged generation survived a clean run'
        Assert (-not @(Find-VaultExportUnfinishedRuns -Workspace $fx.workspace).Count) 'a clean run left an unfinished journal'

        # ==========================================================================================
        # CASE 2: an unchanged re-export writes nothing
        # ==========================================================================================
        $before = Get-VaultExportFixtureTree -Path $fx.mirror
        Start-Sleep -Milliseconds 20
        # THE plan_id IS DELIBERATELY WRONG. An unchanged re-export must answer before approval is
        # ever consulted, because there is nothing to approve. Caught rather than called directly:
        # without the short-circuit this throws on the plan_id, and a throw here would abort the
        # suite and take every later case's result with it.
        $again = $null
        $againThrew = ''
        try { $again = & $export @{ UserConfirmed = $true; ApprovedPlanId = 'irrelevant' } }
        catch { $againThrew = [string]$_.Exception.Message }
        Assert ($againThrew -eq '') "an unchanged re-export threw instead of reporting itself unchanged: $againThrew"
        Assert ($null -ne $again -and $again.status -ceq 'unchanged') "an unchanged re-export reported status '$(if ($null -ne $again) { $again.status } else { 'nothing' })'"
        Assert ($null -ne $again -and $again.wrote_nothing) 'an unchanged re-export did not declare that it wrote nothing'
        $after = Get-VaultExportFixtureTree -Path $fx.mirror
        Assert ($after.Count -eq $before.Count) "the mirror went from $($before.Count) to $($after.Count) file(s) on a run that should have written nothing"
        $touched = @($before.Keys | Where-Object { -not $after.Contains($_) -or $after[$_].written -ne $before[$_].written -or $after[$_].sha256 -cne $before[$_].sha256 })
        # THE TIMESTAMP IS THE POINT. Hashes alone go green on an exporter that rewrites every file
        # with identical bytes, which is exactly the exporter this design replaced.
        Assert (-not $touched.Count) "$($touched.Count) mirrored file(s) were rewritten by a run that should have written nothing: $(@($touched | Select-Object -First 5) -join ', ')"
        Assert (-not (Get-ChildItem -LiteralPath (Join-Path $fx.vault '40-Resources\.library-export\staging') -Force -ErrorAction SilentlyContinue)) 'an unchanged re-export staged a generation'

        # ==========================================================================================
        # CASE 3: an edited destination refuses
        # ==========================================================================================
        $edited = Join-Path $fx.mirror 'books\demo-book\wiki\first.md'
        [IO.File]::WriteAllText($edited, "# First`n`nThe reader's own sentence.`n", [Text.UTF8Encoding]::new($false))
        $editedSha = Get-VaultExportSha256 $edited
        $refusal = Get-Refusal { & $export @{ Preflight = $true } }
        Assert ($refusal -ne '') 'an edited destination did not refuse'
        Assert ($refusal -match 'first\.md') "the refusal did not name the edited file: $refusal"
        # AND THE EDIT SURVIVES IT. A refusal that had already overwritten the file would still be
        # a refusal, and would still print the right sentence.
        Assert ((Get-VaultExportSha256 $edited) -ceq $editedSha) "the reader's edit was overwritten by the run that refused because of it"
        $confirmedRefusal = Get-Refusal { & $export @{ UserConfirmed = $true; ApprovedPlanId = 'anything' } }
        Assert ($confirmedRefusal -match 'first\.md') 'a confirmed run did not refuse on the same edit the preflight refused on'

        # Put it back so the later cases start from a clean vault.
        Copy-Item -LiteralPath (Join-Path $fx.source 'books\demo-book\wiki\first.md') -Destination $edited -Force

        # ==========================================================================================
        # CASE 5 (before 4, because 4 leaves a resumed generation behind): a removed source page
        # ==========================================================================================
        Remove-Item -LiteralPath (Join-Path $fx.source 'books\demo-book\wiki\no-eol.md') -Force
        $planRemove = & $export @{ Preflight = $true }
        Assert (@($planRemove.removed) -ccontains 'books/demo-book/wiki/no-eol.md') "the preflight did not plan to remove the deleted source page: $(@($planRemove.removed) -join ', ')"
        $runRemove = & $export @{ UserConfirmed = $true; ApprovedPlanId = $planRemove.plan_id }
        Assert ($runRemove.status -ceq 'exported') "the removal run reported status '$($runRemove.status)'"
        Assert (-not (Test-Path -LiteralPath (Join-Path $fx.mirror 'books\demo-book\wiki\no-eol.md'))) 'a page removed at the source is still in the vault'
        $manifestAfterRemove = Get-VaultExportManifestFiles (Read-VaultExportManifest $manifestPath)
        # ON DISK AND IN THE MANIFEST. A path that left the tree but stayed in the manifest reads as
        # "edited in the vault" on the next run and refuses every later export.
        Assert (-not $manifestAfterRemove.Contains('books/demo-book/wiki/no-eol.md')) 'the removed page is gone from the vault but still listed in the manifest'

        # ==========================================================================================
        # (e) an unmanaged reader file is carried forward, and a collision refuses
        # ==========================================================================================
        $readerFile = Join-Path $fx.mirror 'books\demo-book\my-own-notes.md'
        [IO.File]::WriteAllText($readerFile, "# Mine`n", [Text.UTF8Encoding]::new($false))
        $readerSha = Get-VaultExportSha256 $readerFile
        [IO.File]::WriteAllText((Join-Path $fx.source 'books\demo-book\wiki\second.md'), "# Second`n", [Text.UTF8Encoding]::new($false))
        $planCarry = & $export @{ Preflight = $true }
        Assert (@($planCarry.unmanaged_carried) -ccontains 'books/demo-book/my-own-notes.md') 'the reader''s own file was not identified as unmanaged'
        $runCarry = & $export @{ UserConfirmed = $true; ApprovedPlanId = $planCarry.plan_id }
        Assert ($runCarry.status -ceq 'exported') "the carry-forward run reported status '$($runCarry.status)'"
        Assert ((Test-Path -LiteralPath $readerFile) -and ((Get-VaultExportSha256 $readerFile) -ceq $readerSha)) 'a generation swap lost the reader''s own file, which no manifest claims and nothing else would put back'

        [IO.File]::WriteAllText((Join-Path $fx.mirror 'books\demo-book\wiki\third.md'), "# Not the export's`n", [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $fx.source 'books\demo-book\wiki\third.md'), "# The export's`n", [Text.UTF8Encoding]::new($false))
        $collision = Get-Refusal { & $export @{ Preflight = $true } }
        Assert ($collision -match 'third\.md') "a source path landing on an unmanaged vault file did not refuse: $collision"
        Remove-Item -LiteralPath (Join-Path $fx.mirror 'books\demo-book\wiki\third.md') -Force

        # ==========================================================================================
        # CASE 4: an interrupted run resumes -- and a file written into the activation window is
        # recovered rather than lost
        # ==========================================================================================
        [IO.File]::WriteAllText((Join-Path $fx.source 'books\demo-book\wiki\first.md'), "# First, revised`n", [Text.UTF8Encoding]::new($false))
        $planFault = & $export @{ Preflight = $true }
        $faulted = Get-Refusal { & $export @{ UserConfirmed = $true; ApprovedPlanId = $planFault.plan_id; FaultAfterStage = 'live-moved-aside' } }
        Assert ($faulted -match 'FAULT INJECTED') "the fault injection did not stop the run: $faulted"
        Assert (-not (Test-Path -LiteralPath $fx.mirror -PathType Container)) 'the fault stopped the run before the first rename, so it never exercised the window this case exists for'

        $unfinished = @(Find-VaultExportUnfinishedRuns -Workspace $fx.workspace)
        Assert ($unfinished.Count -eq 1) "after an interrupted run, $($unfinished.Count) unfinished run(s) were found"
        $blocked = Get-Refusal { & $export @{ Preflight = $true } }
        Assert ($blocked -match 'did not finish') "a new export was allowed to start over an unfinished one: $blocked"

        # A file appears in the retained generation: this is exactly what a vault edit that lands in
        # the activation window looks like from the outside, and it is the one thing the post-
        # activation check exists to find.
        $retainedPath = (Read-VaultExportJournal $unfinished[0].path).retained_path
        [IO.File]::WriteAllText((Join-Path $retainedPath 'books\demo-book\window-edit.md'), "# Written while the swap was happening`n", [Text.UTF8Encoding]::new($false))

        $resumePlan = & $export @{ ResumeRunId = $unfinished[0].run_id; Preflight = $true }
        Assert ($resumePlan.action -ceq 'complete-second-rename') "the resume preflight planned '$($resumePlan.action)' from stage '$($resumePlan.last_stage)'"
        Assert ($resumePlan.wrote_nothing) 'the resume preflight did not declare itself read-only'
        $resumed = & $export @{ ResumeRunId = $unfinished[0].run_id; UserConfirmed = $true }
        Assert ($resumed.status -ceq 'resumed') "the resume reported status '$($resumed.status)'"
        Assert (Test-Path -LiteralPath $fx.mirror -PathType Container) 'the resume did not put a mirror back at the vault path'
        # THE NEW GENERATION, not the retained one. A resume that renamed the retained tree back
        # would satisfy every "the mirror exists" assertion and would have undone the export.
        $resumedFirst = [IO.File]::ReadAllText((Join-Path $fx.mirror 'books\demo-book\wiki\first.md'), [Text.UTF8Encoding]::new($false))
        Assert ($resumedFirst -match 'revised') 'the resume restored the previous generation instead of completing the new one'
        Assert (@($resumed.vault_edited_during_activation).Count -eq 1) "the window check found $(@($resumed.vault_edited_during_activation).Count) file(s); one was written into the retained generation"
        Assert ($resumed.recovery_path -ne '' -and (Test-Path -LiteralPath (Join-Path $resumed.recovery_path 'books\demo-book\window-edit.md'))) 'a file written during the activation window was not copied to the recovery folder'
        Assert (-not (Test-Path -LiteralPath $retainedPath)) 'the retained generation survived a completed window check'
        Assert (-not @(Find-VaultExportUnfinishedRuns -Workspace $fx.workspace).Count) 'the resumed run is still recorded as unfinished'

        # A run that is interrupted BEFORE the swap rolls back instead, and the vault never moves.
        [IO.File]::WriteAllText((Join-Path $fx.source 'books\demo-book\wiki\first.md'), "# First, revised twice`n", [Text.UTF8Encoding]::new($false))
        $planEarly = & $export @{ Preflight = $true }
        $mirrorBefore = Get-VaultExportFixtureTree -Path $fx.mirror
        [void](Get-Refusal { & $export @{ UserConfirmed = $true; ApprovedPlanId = $planEarly.plan_id; FaultAfterStage = 'staged' } })
        $early = @(Find-VaultExportUnfinishedRuns -Workspace $fx.workspace)
        Assert ($early.Count -eq 1) "a run faulted at staging left $($early.Count) unfinished run(s)"
        $rolled = & $export @{ ResumeRunId = $early[0].run_id; UserConfirmed = $true }
        Assert ($rolled.status -ceq 'rolled-back') "resuming a run that never reached the swap reported '$($rolled.status)' rather than rolled-back"
        $mirrorAfterRollback = Get-VaultExportFixtureTree -Path $fx.mirror
        $moved = @($mirrorBefore.Keys | Where-Object { -not $mirrorAfterRollback.Contains($_) -or $mirrorAfterRollback[$_].sha256 -cne $mirrorBefore[$_].sha256 })
        Assert (-not $moved.Count) "a rollback changed $($moved.Count) mirrored file(s); a run that never reached the swap must leave the vault untouched"

        # ==========================================================================================
        # ADOPTION: a first run over a mirror some other tool wrote
        # ==========================================================================================
        # This is the state the real vault was in when the tool was first pointed at it, and the
        # case that caught the preflight describing 410 files as "carried into the new generation"
        # when adoption retains them instead. The refusal and the switch are asserted together,
        # because a switch that is never refused without is a switch nothing depends on.
        $fx2 = New-VaultExportFixture
        try {
            $legacyMirror = Join-Path $fx2.vault '40-Resources\Library'
            New-Item -ItemType Directory -Path (Join-Path $legacyMirror 'books\demo-book') -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $legacyMirror 'books\demo-book\_book.md'), "# An older tool wrote this`n", [Text.UTF8Encoding]::new($false))
            [IO.File]::WriteAllText((Join-Path $legacyMirror '_mirror-status.md'), "# Status from the tool being replaced`n", [Text.UTF8Encoding]::new($false))
            $adoptRefusal = Get-Refusal { Invoke-VaultExportRun -Workspace $fx2.workspace -SourceRoot $fx2.source -VaultRoot $fx2.vault -MirrorRelPath '40-Resources\Library' -Preflight }
            Assert ($adoptRefusal -match 'no manifest claims') "a mirror written by another tool did not refuse a first run: $adoptRefusal"

            $adoptPlan = Invoke-VaultExportRun -Workspace $fx2.workspace -SourceRoot $fx2.source -VaultRoot $fx2.vault -MirrorRelPath '40-Resources\Library' -AdoptExistingMirror -Preflight
            # THE LABEL, not just the artifact. Adoption carries nothing forward, so a preflight
            # that names files as carried is describing a run that will not happen.
            Assert (@($adoptPlan.unmanaged_carried).Count -eq 0) "an adoption preflight said it would carry $(@($adoptPlan.unmanaged_carried).Count) file(s) forward; adoption retains them instead"
            Assert ($adoptPlan.retained_not_carried -eq 2) "an adoption preflight reported $($adoptPlan.retained_not_carried) retained file(s); the legacy mirror has 2"
            Assert ($adoptPlan.summary -match 'RETAINED') 'the adoption preflight summary does not say the existing mirror is retained'

            $adopted = Invoke-VaultExportRun -Workspace $fx2.workspace -SourceRoot $fx2.source -VaultRoot $fx2.vault -MirrorRelPath '40-Resources\Library' -AdoptExistingMirror -UserConfirmed -ApprovedPlanId $adoptPlan.plan_id
            Assert ($adopted.status -ceq 'exported') "the adoption run reported status '$($adopted.status)'"
            Assert ($adopted.retained_generation -ne '' -and (Test-Path -LiteralPath $adopted.retained_generation -PathType Container)) 'the adopted mirror was not retained anywhere; an unverifiable generation must never be deleted'
            Assert (Test-Path -LiteralPath (Join-Path $adopted.retained_generation '_mirror-status.md')) 'the retained generation is missing the legacy file it was kept for'
            # And the legacy file is NOT in the new mirror: adoption replaces the tree rather than
            # merging into it, which is what stops the old tool's stamps travelling forward forever.
            Assert (-not (Test-Path -LiteralPath (Join-Path $legacyMirror '_mirror-status.md'))) 'a file from the adopted mirror was merged into the new generation'
            $adoptedBook = [IO.File]::ReadAllText((Join-Path $legacyMirror 'books\demo-book\_book.md'), [Text.UTF8Encoding]::new($false))
            Assert ($adoptedBook -match 'Demo Book') 'the adopted run left the older tool''s page in place instead of exporting the source'
        }
        finally { Remove-Item -LiteralPath $fx2.root -Recurse -Force -ErrorAction SilentlyContinue }

        # ==========================================================================================
        # (f) overlapping roots
        # ==========================================================================================
        $overlap = Get-Refusal { Invoke-VaultExportRun -Workspace $fx.workspace -SourceRoot $fx.source -VaultRoot $fx.vault -MirrorRelPath '..\collection' -Preflight }
        Assert ($overlap -ne '') 'a mirror path pointing at the source did not refuse'

        # ==========================================================================================
        # (a) the lock, in both directions
        # ==========================================================================================
        $exportLock = Enter-CollectionExportLock -Workspace $fx.workspace -RunId 'suite'
        try {
            $writerRefusal = Get-Refusal { Enter-BookLock -Workspace $fx.workspace -BookRoot 'shelf/demo' -TimeoutSeconds 1 }
            Assert ($writerRefusal -match 'collection-wide export') "a Book writer was allowed to start while an export held the workspace: $writerRefusal"
        }
        finally { Exit-BookLock -Lock $exportLock }
        # And the release really releases: the same writer must succeed once the export is done, or
        # the assertion above would pass on a guard that refuses everything forever.
        $afterRelease = Get-Refusal { $bl = Enter-BookLock -Workspace $fx.workspace -BookRoot 'shelf/demo' -TimeoutSeconds 1; Exit-BookLock -Lock $bl }
        Assert ($afterRelease -eq '') "a Book writer was still refused after the export lock was released: $afterRelease"

        $bookLock = Enter-BookLock -Workspace $fx.workspace -BookRoot 'shelf/demo' -TimeoutSeconds 5
        try {
            $exportRefusal = Get-Refusal { Enter-CollectionExportLock -Workspace $fx.workspace -RunId 'suite-2' }
            Assert ($exportRefusal -match 'Book lock') "an export was allowed to capture while a Book writer held a lock: $exportRefusal"
            # AND IT LEFT NOTHING BEHIND. An export that refused but kept its own lock file would
            # block every writer from then on, which is worse than the race it was avoiding.
            Assert (-not (Test-Path -LiteralPath (Get-CollectionExportLockPath -Workspace $fx.workspace))) 'the refused export left its own lock file behind'
        }
        finally { Exit-BookLock -Lock $bookLock }
    }
    catch {
        # AN ABORT IS A FAILURE THAT MUST STILL BE REPORTED WITH THE OTHERS. An exception escaping
        # here skips the report below, so every assertion that already failed goes unprinted and the
        # run looks like one unrelated crash. Found by injecting a regression whose named assertion
        # fired correctly and was never shown, because a later case threw on the damage it left.
        [void]$failures.Add("the suite stopped early at an unguarded call: $([string]$_.Exception.Message)")
    }
    finally { Remove-Item -LiteralPath $fx.root -Recurse -Force -ErrorAction SilentlyContinue }

    if ($failures.Count) {
        [Console]::Error.WriteLine("Export-CollectionToVault acceptance FAILED ($($failures.Count) of $script:vaultExportChecks):")
        foreach ($failure in $failures) { [Console]::Error.WriteLine("  - $failure") }
        return 1
    }
    Write-Host "Export-CollectionToVault acceptance passed ($script:vaultExportChecks checks)."
    return 0
}
