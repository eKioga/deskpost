<#
.SYNOPSIS
    Shared action schema for Library Triage v3. Dot-sourced; never invoked directly.

.DESCRIPTION
    Renamed from HandoffPlanCommon.ps1 on 2026-08-28, when Handoff collapsed into Triage (fork A).
    One verb now covers both local buffers, and the SOURCE decides which destinations are reachable:

      from notebook   holding, shelf-book, project, book
      from holding    notebook, shelf-book, project, book, plus in-place review / discard

    There is deliberately no `discard` from `notebook`. The Holding Shelf survives a Reset, so
    leaving a note there is a durable commitment and discarding it means something; `notebook/` is
    volatile, but a Reset QUARANTINES it rather than deleting it (ADR-0016) -- so a notebook discard
    is not "delete it now rather than at the reset", it is strictly worse than the reset, destroying
    what the reset would have kept recoverable. It buys nothing and adds a destructive mode to the
    one helper whose purpose is losing nothing. The honest fifth option is to leave it.
    (Reasoning corrected 2026-09-10, the rule unchanged: docs/library-triage-design.md:440-448.)

    THE REASON ABOVE ANSWERS DELETION ONLY, AND THAT IS WHY IT KEPT INVITING THE SAME QUESTION: if
    removal QUARANTINED instead of deleting, nothing would be destroyed and the argument would not
    reach it. ADR-0024 settled that on 2026-09-15 and the refusal is upheld on wider ground --
    removal from `notebook/` has nowhere to go at all. Deletion is refused above; the quarantine is a
    reset's recovery route rather than a destination, and its restore is per-topic and refuses a
    topic that exists in `notebook/` again, so a drained ARTICLE could never be returned; and a new
    local store is the Notebook archive this Library refuses on three surfaces. A proposal to remove
    from `notebook/` answers that enumeration, not this paragraph.
    (docs/adr/0024-removal-from-the-notebook-has-no-destination.md)

    THE GATE RULE, STATED ONCE. Writing *into* a capture Book is ungated, because capture is
    deliberately cheap: a note that costs anything stops being written down. Any action whose
    *source* is a capture Book requires that Book open on the Desk, because naming an individual
    note is a read. That asymmetry is the capture-Book model (docs/capture-book-model.md) and it was
    previously spread across two helpers, which is the easiest thing to flatten by accident when two
    helpers become one. `required_desk_state` is therefore a LIST -- a shelf-book action sourced from
    holding needs two Books open, and one string could only ever name one of them.

    Every action is **create-and-additive only**, with `discard` the single named exception, which
    binds what it destroys into `delete_set` and needs its own approval. `replace_existing` is
    rejected here, at plan validation, rather than merely left unused: publication journals record
    new manifests and hashes, not the bodies an overwrite destroyed, so a misclassified replace
    inside a batch has no rollback. Refreshing an existing shared Book is a separate, separately
    approved operation.

    Three sets are computed per action and they are not the same thing:

      write_set   paths the action must CREATE. These must be absent when the action runs, they are
                  checked for overlap across the batch, and they are bound into the approval digest.
      delete_set  paths the action DESTROYS. Bound into the digest for the same reason write_set is:
                  a discard whose approval covered nothing would be an approval in name only.
      touch_set   paths the action updates additively -- a Book's reader map, a note's own review
                  field, the shared Book Catalog. Two actions may share these: the writers regenerate
                  or append under the Book's own lock, so a shared index is not the guaranteed-
                  partial-batch hazard a shared create is. Recorded for transparency, never used to
                  refuse a batch.

    The write set is computed here, from the same path rules the child writers use, because
    validation must not need the NAS. Invoke-LibraryTriage.ps1 then asserts each child's own
    preflight agrees with the persisted set. That equality check is the point: it is what stops the
    two definitions from silently drifting apart the way two independent parsers of one record
    always eventually do.

    SCHEMA 3 IS NOT BACKWARD COMPATIBLE, BY DECISION. The digest recipe gained `source`,
    `source_slug`, `delete_set`, a list-valued `required_desk_state`, and the delivered-body hash, so
    a version-2 handoff plan cannot re-resolve to its recorded digest. Supporting both would mean two
    digest recipes in one file -- the exact "two parsers of one record" failure the paragraph above
    describes. Version-2 plans under internal/handoff-plans/ therefore stay READABLE and are refused
    execution with an exact message. Nothing re-runnable was lost: every stored plan was spent and
    both batch journals record every action succeeded.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'ShelfNoteCommon.ps1')

$script:TriagePlanSchema = 3

# Cheapest and most reversible first, so a late failure never strands local material: a review costs
# nothing to redo, a Holding Shelf entry almost nothing, a shared Book cannot be un-created -- and a
# discard cannot be undone at all, so it runs last. That ordering is what makes "graduate this note
# into a Book, then discard it" safe: any failure upstream leaves the note where it was.
$script:TriageExecutionOrder = @('review', 'holding', 'notebook', 'shelf-book', 'project', 'book', 'discard')

# Which kinds each source can reach, and the reason a refused pairing is refused. Kept as data rather
# than as scattered `if` guards so the matrix is readable in one place and every cell has a message.
$script:TriageSourceKinds = @{
    'notebook' = @('holding', 'shelf-book', 'project', 'book')
    'holding'  = @('notebook', 'shelf-book', 'project', 'book', 'review', 'discard')
}
$script:TriageRefusalReason = @{
    'notebook|notebook'  = "A notebook action is already in the Notebook. Name the topic folder directly instead."
    'notebook|review'    = 'A review marks a capture-Book note reviewed. A Notebook article carries no review field.'
    'notebook|discard'   = 'There is no discard from the Notebook. A Reset quarantines notebook/ rather than deleting it (ADR-0016), so a discard is not deleting it sooner -- it is strictly worse than the reset, destroying what the reset would have kept recoverable, and it adds a destructive mode to the one helper whose purpose is losing nothing. Nor does quarantining instead of deleting open a route: the quarantine is a reset''s recovery route and not a destination, and its restore cannot return one article to a topic that still exists, so removal from notebook/ has nowhere to go at all (ADR-0024). Leave it, or triage it somewhere durable. (docs/library-triage-design.md:440-448, docs/adr/0024-removal-from-the-notebook-has-no-destination.md)'
    'holding|holding'    = 'This note is already on the Holding Shelf. Use shelf-book, project, book, or notebook to move it on.'
}

# The kinds whose source is a capture Book note rather than a Notebook path.
$script:TriageNoteKinds = @('notebook', 'review', 'discard')
# The kinds that rewrite the SOURCE note's own frontmatter. A discard of the same note in the same
# batch would then find bytes its approval never covered, so the two are refused together.
$script:TriageNoteMutatingKinds = @('notebook', 'review')

# Read a property that may be absent. $Object.Name throws under Set-StrictMode when it is, and a
# triage action legitimately omits most fields for most kinds.
function Get-TriageValue($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    $property.Value
}

function Get-TriageArray($Object, [string]$Name) {
    $value = Get-TriageValue $Object $Name
    if ($null -eq $value) { return @() }
    if ($value -is [array]) { return @($value) }
    @($value)
}

function Get-TriageHash([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

# Length-prefixed, so no two different values can render to the same text. A digest built by joining
# fields with a separator is only as strong as the assumption that no value contains it: with plain
# joining, one field holding "a,b" and two fields holding "a" and "b" hash identically, and an
# approval that cannot tell those apart binds less than it claims to.
function ConvertTo-TriageDigestText($Value) {
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [Collections.Specialized.OrderedDictionary] -or $Value -is [hashtable]) {
        $parts = @(@($Value.Keys) | Sort-Object | ForEach-Object {
            'k' + $_.Length + ':' + $_ + '=' + (ConvertTo-TriageDigestText $Value[$_])
        })
        return 'map' + $parts.Count + '{' + ($parts -join ';') + '}'
    }
    if ($Value -is [array]) {
        $parts = @(@($Value) | ForEach-Object { ConvertTo-TriageDigestText $_ })
        return 'arr' + $parts.Count + '[' + ($parts -join ';') + ']'
    }
    $text = [string]$Value
    'str' + $text.Length + ':' + $text
}

function Test-TriageTruthy($Value) {
    if ($null -eq $Value) { return $false }
    if ($Value -is [bool]) { return [bool]$Value }
    $text = ([string]$Value).Trim()
    if ($text -eq '') { return $false }
    $text -cin @('true', 'True', 'TRUE', '1')
}

# The leading frontmatter block, removed. A capture note opens with one; a Notebook article does not.
#
# WHERE THIS IS APPLIED IS A RULE, NOT A CASE-BY-CASE CHOICE: the frontmatter travels wherever the
# child COPIES A FILE, and is stripped wherever the child COMPOSES A PAGE BODY. Copying keeps the
# provenance with the material, which is what `notebook`, `project`, and `book` do. `shelf-book`
# composes: ConvertTo-ShelfPageBody looks for a leading H1, a '---' block means it finds none, -Title
# then becomes mandatory, and the generated heading lands ABOVE the frontmatter -- turning the
# provenance into a mid-page horizontal rule on a curated Book page.
function Get-TriageNoteBody([string]$Content) { Split-NoteFrontmatter $Content }

# Every notebook-sourced kind resolves its source the same way: inside notebook/, existing, and
# hashed. A session finding has no disk path, which is why the workflow materialises it into a
# Notebook article first -- context cannot be hashed, and an approval that binds nothing is not an
# approval.
function Resolve-TriageNotebookSource([string]$Workspace, [string]$SourcePath, [bool]$AllowFolder, [string[]]$IncludePage = @()) {
    if ([string]::IsNullOrWhiteSpace($SourcePath)) { throw 'Each notebook-sourced action needs a source_path.' }
    $notebookRoot = [IO.Path]::GetFullPath((Join-Path $Workspace 'notebook')).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $full = [IO.Path]::GetFullPath((Join-Path $Workspace $SourcePath))
    if (-not $full.StartsWith($notebookRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "source_path '$SourcePath' must name a file or folder inside notebook/."
    }
    if (-not (Test-Path -LiteralPath $full)) { throw "source_path '$SourcePath' was not found." }
    $item = Get-Item -LiteralPath $full -Force
    if ($item.PSIsContainer -and -not $AllowFolder) {
        throw "source_path '$SourcePath' must name a single Markdown article for this action kind."
    }
    $files = @(
        if ($item.PSIsContainer) { Get-ChildItem -LiteralPath $full -File -Recurse | Where-Object { $_.Extension -ceq '.md' } | Sort-Object FullName }
        else {
            if ($item.Extension -cne '.md') { throw "source_path '$SourcePath' must be a Markdown article." }
            $item
        }
    )
    if ($files.Count -eq 0) { throw "source_path '$SourcePath' contains no Markdown articles." }
    # Applied HERE, before the manifest and the write set are built, because a subset selection that
    # arrived afterwards would leave the approval describing every file while the child wrote only
    # some -- and the write-set equality check would then refuse every legitimate subset.
    if (@($IncludePage).Count) {
        if (-not $item.PSIsContainer) { throw "include_pages is available only when source_path names a Notebook folder." }
        $selected = @{}
        foreach ($page in @($IncludePage)) {
            $normalized = ([string]$page).Trim().TrimStart('\', '/').Replace('/', '\')
            if ($normalized -cnotmatch '\.md$') { throw "include_pages entry '$page' must name a Markdown file relative to source_path." }
            $candidate = [IO.Path]::GetFullPath((Join-Path $full $normalized))
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "include_pages entry '$page' is not an exact Markdown file below source_path." }
            $selected[$candidate] = $true
        }
        $files = @($files | Where-Object { $selected.ContainsKey($_.FullName) })
        if ($files.Count -ne $selected.Count) { throw 'include_pages named a file outside the resolved source.' }
    }
    $relativeRoot = $full.Substring($Workspace.Length).TrimStart('\', '/').Replace('\', '/')
    $entries = @($files | ForEach-Object {
        $relative = if ($item.PSIsContainer) { $_.FullName.Substring($full.Length).TrimStart('\', '/').Replace('\', '/') } else { $_.Name }
        $content = [IO.File]::ReadAllText($_.FullName, [Text.UTF8Encoding]::new($false, $true))
        [pscustomobject]@{
            relative     = $relative
            source_path  = if ($item.PSIsContainer) { "$relativeRoot/$relative" } else { $relativeRoot }
            content      = $content
            sha256       = Get-TriageHash $content
        }
    })
    [pscustomobject]@{
        kind         = 'notebook'
        full         = $full
        relative     = $relativeRoot
        is_container = [bool]$item.PSIsContainer
        name         = if ($item.PSIsContainer) { $item.Name } else { [IO.Path]::GetFileNameWithoutExtension($item.Name) }
        book_slug    = ''
        book_root    = ''
        note         = $null
        files        = $entries
    }
}

# One note in one capture Book. -MatchText IS RESOLVED HERE, at plan time, and the resolved page is
# what the digest binds -- never the match string. A note captured between the approval and the run
# could otherwise change what an approved -MatchText meant, and capture is ungated, so that is not a
# hypothetical race. Ambiguity is refused with the list of hits, as Move-ShelfNote always did.
function Resolve-TriageNoteSource([string]$Workspace, [string]$Slug, [string]$Page, [string]$MatchText) {
    if ([string]::IsNullOrWhiteSpace($Slug)) { $Slug = 'holding' }
    $book = Get-CaptureBook -Workspace $Workspace -Slug $Slug
    # THE GATE FIRES HERE, BEFORE THE NOTES ARE LISTED, and the placement is the point. Resolution
    # reads every note's title and filename to honour -MatchText, so asserting the Desk only through
    # required_desk_state -- which the runner checks after resolution -- would let a closed Book
    # answer 'that matches 3 notes: ...' and name them. The Book being open is a precondition of
    # READING it, so it is asserted by the function that reads. required_desk_state still carries
    # the same requirement, because the runner re-checks it immediately before the write: a Book can
    # be closed between the approval and the run.
    Assert-ShelfBookOpen -Workspace $Workspace -Slug $Slug -Action 'triaging its notes'
    $notes = @(Get-ShelfNotes -Book $book)
    if ($notes.Count -eq 0) { throw "Capture Book '$Slug' holds no notes." }

    $hasPage = -not [string]::IsNullOrWhiteSpace($Page)
    $hasMatch = -not [string]::IsNullOrWhiteSpace($MatchText)
    if ($hasPage -and $hasMatch) { throw 'Name the note with either source_page or source_match, not both.' }
    if (-not $hasPage -and -not $hasMatch) { throw 'Name the note to triage with source_page (exact) or source_match.' }

    if ($hasPage) {
        $wanted = $Page.Trim().Replace('\', '/').TrimEnd('/')
        # -cnotmatch: the 'notes/' prefix is a literal lowercase path segment, and -notmatch would
        # accept 'Notes/...' here only for the -ceq comparison below to then find nothing.
        if ($wanted -cnotmatch '^notes/[^/]+$') { throw 'source_page must be the canonical note path, for example notes/2026-08-16-my-finding.' }
        $targets = @($notes | Where-Object { $_.page -ceq $wanted })
        if ($targets.Count -eq 0) { throw "No note '$wanted' is in Book '$Slug'." }
    }
    else {
        # String.Contains is ordinal, so a match is case-sensitive like Edit-ProjectHub's -MatchText.
        $targets = @($notes | Where-Object { $_.title.Contains($MatchText) -or $_.file.Contains($MatchText) })
        if ($targets.Count -eq 0) { throw "No note title or filename in Book '$Slug' contains '$MatchText'." }
        if ($targets.Count -ne 1) {
            throw "'$MatchText' matches $($targets.Count) notes: $(@($targets | ForEach-Object { $_.page }) -join ', '). Narrow it, or name one with source_page."
        }
    }
    $note = $targets[0]
    $content = [IO.File]::ReadAllText($note.full_path, [Text.UTF8Encoding]::new($false, $true))
    $relative = "$($book.book_root)/wiki/$($note.page).md"
    [pscustomobject]@{
        kind         = 'holding'
        full         = $note.full_path
        relative     = $relative
        is_container = $false
        name         = [IO.Path]::GetFileNameWithoutExtension($note.file)
        book_slug    = $book.slug
        book_root    = $book.book_root
        note         = $note
        files        = @([pscustomobject]@{
            relative    = $note.file
            source_path = $relative
            content     = $content
            sha256      = Get-TriageHash $content
        })
    }
}

# The same title rule Add-ShelfNote.ps1 applies: a body leading with its own H1 keeps that heading,
# because a note filed under a title appearing nowhere on its page cannot be found again by the
# reader who wrote it. Kept here so a plan can name the exact target path without a NAS call; the
# runner checks this agrees with the child's own preflight before anything is written.
function Get-TriageNoteSlug([string]$Body, [string]$Title) {
    $normalized = $Body.TrimEnd()
    $heading = [regex]::Match($normalized, '(?m)\A#\s+(.+?)\s*$')
    $pageTitle = if ($heading.Success -and [regex]::IsMatch($heading.Groups[1].Value, '[a-zA-Z0-9]')) { $heading.Groups[1].Value.Trim() } else { $Title }
    if ([string]::IsNullOrWhiteSpace($pageTitle)) { throw 'A holding action needs a title, or a source whose first line is an H1.' }
    ConvertTo-NoteSlug -Title $pageTitle
}

function Assert-TriageKindReachable([string]$Kind, [string]$SourceKind) {
    if ($Kind -cnotin $script:TriageExecutionOrder) {
        throw "Unknown triage action kind '$Kind'. Use one of: $($script:TriageExecutionOrder -join ', ')."
    }
    if ($SourceKind -cnotin @($script:TriageSourceKinds.Keys)) {
        throw "Unknown triage source '$SourceKind'. Use 'notebook' or 'holding'."
    }
    if ($Kind -cin $script:TriageSourceKinds[$SourceKind]) { return }
    $reason = $script:TriageRefusalReason["$SourceKind|$Kind"]
    if ([string]::IsNullOrWhiteSpace($reason)) {
        $reason = "From source '$SourceKind' the reachable kinds are: $($script:TriageSourceKinds[$SourceKind] -join ', ')."
    }
    throw "Action kind '$Kind' is not reachable from source '$SourceKind'. $reason"
}

function ConvertTo-TriageAction($Action, [string]$Workspace, [string]$CaptureDate) {
    $kind = [string](Get-TriageValue $Action 'kind')
    $sourceKind = [string](Get-TriageValue $Action 'source')
    if ([string]::IsNullOrWhiteSpace($sourceKind)) { $sourceKind = 'notebook' }
    Assert-TriageKindReachable -Kind $kind -SourceKind $sourceKind

    # Rejected, not ignored. A batch that quietly dropped the flag would run a different operation
    # from the one the reader described, which is worse than refusing to run at all.
    if (Test-TriageTruthy (Get-TriageValue $Action 'replace_existing')) {
        throw "Action kind '$kind' declares replace_existing. Triage is create-and-additive only, apart from discard, which binds what it destroys and needs its own approval: refreshing or overwriting an existing destination is a separate, separately approved operation."
    }

    $slug = [string](Get-TriageValue $Action 'slug')
    $title = [string](Get-TriageValue $Action 'title')
    $sourcePath = [string](Get-TriageValue $Action 'source_path')
    $sourceSlug = [string](Get-TriageValue $Action 'source_slug')
    if ($sourceKind -ceq 'holding' -and [string]::IsNullOrWhiteSpace($sourceSlug)) { $sourceSlug = 'holding' }
    $includePages = @(Get-TriageArray $Action 'include_pages')
    if ($includePages.Count -and ($sourceKind -ceq 'holding' -or $kind -cin @('holding', 'shelf-book'))) {
        throw "Action kind '$kind' from source '$sourceKind' takes a single article and does not accept include_pages."
    }

    # Resolved once, before any kind branch, so every kind hashes its source the same way.
    $source = if ($sourceKind -ceq 'holding') {
        Resolve-TriageNoteSource -Workspace $Workspace -Slug $sourceSlug `
            -Page ([string](Get-TriageValue $Action 'source_page')) `
            -MatchText ([string](Get-TriageValue $Action 'source_match'))
    }
    else {
        Resolve-TriageNotebookSource -Workspace $Workspace -SourcePath $sourcePath `
            -AllowFolder ($kind -cin @('project', 'book')) -IncludePage $includePages
    }

    $writeSet = @()
    $touchSet = @()
    $deleteSet = @()
    $metadata = [ordered]@{}
    $requiredDesk = [Collections.Generic.List[string]]::new()
    # THE GATE RULE. Any action reading a named note out of a capture Book needs that Book open;
    # writing INTO one needs nothing. Applied here, once, for every holding-sourced kind rather than
    # repeated per branch, because a branch that forgot it would be silently ungated.
    if ($sourceKind -ceq 'holding') { [void]$requiredDesk.Add("shelf-book-open:$($source.book_slug)") }

    # What the child will actually be handed. Equal to the source bytes wherever the child copies a
    # file; the frontmatter-stripped body wherever it composes a page. Bound into the digest either
    # way, so the two can never drift apart unnoticed.
    $deliveredSha = 'same-as-source'
    $noteBody = if ($sourceKind -ceq 'holding') { Get-TriageNoteBody $source.files[0].content } else { $null }

    switch ($kind) {
        'holding' {
            if ([string]::IsNullOrWhiteSpace($slug)) { $slug = 'holding' }
            if ($slug -cnotmatch '^[a-z0-9][a-z0-9-]*$') { throw 'A holding action slug must use lowercase letters, digits, and hyphens.' }
            $book = Get-CaptureBook -Workspace $Workspace -Slug $slug
            $noteSlug = Get-TriageNoteSlug -Body $source.files[0].content -Title $title
            $writeSet = @("$($book.book_root)/wiki/notes/$CaptureDate-$noteSlug.md")
            $touchSet = @("$($book.book_root)/wiki/_index.md")
            $metadata['book_root'] = $book.book_root
            $metadata['note_title'] = $title
            $metadata['capture_date'] = $CaptureDate
            $destination = 'shelf'
            $operation = 'capture-note'
            # No Desk requirement is added here, and that is the ungated half of the gate rule.
        }
        'notebook' {
            $topic = [string](Get-TriageValue $Action 'topic')
            if ([string]::IsNullOrWhiteSpace($topic)) { throw 'A notebook action needs topic: the notebook/<topic>/ folder this note belongs to.' }
            $topicSlug = $topic.Trim()
            # -cnotmatch, because PowerShell's -notmatch is case-insensitive: a lowercase-only rule
            # checked with it accepts 'Graphics' and files the note under a topic folder the rest of
            # the Library will not recognise.
            if ($topicSlug -cnotmatch '^[a-z0-9][a-z0-9-]*$') { throw 'topic must contain only lowercase letters, digits, and hyphens.' }
            $slug = $topicSlug
            # The note first -- Invoke-NoteAction reports write_set[0] as the destination -- then
            # the two derived files a Notebook write also touches. Naming only the note understated
            # the write set from the day the topic index became mandatory.
            $writeSet = @("notebook/$topicSlug/$($source.note.file)", "notebook/$topicSlug/_index.md", 'notebook/_master-index.md')
            # The Shelf copy is KEPT and marked reviewed, so the durable record survives the next
            # Reset while the Notebook copy is the working version. Both the note and the reader map
            # are additive updates inside a Book, never creates.
            $touchSet = @($source.relative, "$($source.book_root)/wiki/_index.md") | Sort-Object
            $metadata['topic'] = $topicSlug
            $metadata['book_root'] = $source.book_root
            $metadata['new_review'] = 'done'
            $destination = 'notebook'
            $operation = 'copy-note-to-notebook'
        }
        'review' {
            $reopen = Test-TriageTruthy (Get-TriageValue $Action 'reopen')
            $slug = $source.book_slug
            $touchSet = @($source.relative, "$($source.book_root)/wiki/_index.md") | Sort-Object
            $metadata['book_root'] = $source.book_root
            $metadata['new_review'] = if ($reopen) { 'pending' } else { 'done' }
            $metadata['current_review'] = $source.note.review
            $destination = 'shelf'
            $operation = 'set-review'
        }
        'discard' {
            $slug = $source.book_slug
            $deleteSet = @($source.relative)
            $touchSet = @("$($source.book_root)/wiki/_index.md")
            $metadata['book_root'] = $source.book_root
            $metadata['note_title'] = $source.note.title
            $destination = 'shelf'
            $operation = 'discard-note'
        }
        'shelf-book' {
            if ([string]::IsNullOrWhiteSpace($slug)) { throw 'A shelf-book action needs the Shelf Book slug.' }
            $pagePath = [string](Get-TriageValue $Action 'page_path')
            if ([string]::IsNullOrWhiteSpace($pagePath)) { throw 'A shelf-book action needs page_path.' }
            $book = Get-ShelfBook -Workspace $Workspace -Slug $slug
            if ($book.is_capture) { throw "Shelf Book '$slug' is a capture Book. Use a holding action for it; shelf-book graduates into a curated Book." }
            $page = ConvertTo-BookPagePath -Raw $pagePath
            $writeSet = @("$($book.book_root)/wiki/$page.md")
            $touchSet = @("$($book.book_root)/wiki/_index.md")
            $metadata['book_root'] = $book.book_root
            $metadata['page_path'] = $page
            $metadata['page_title'] = $title
            [void]$requiredDesk.Add("shelf-book-open:$slug")
            $destination = 'shelf'
            $operation = 'add-page'
        }
        'project' {
            if ([string]::IsNullOrWhiteSpace($slug)) { throw 'A project action needs the Project slug.' }
            if ($slug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'A project action slug must use lowercase letters, digits, and single hyphens.' }
            if ([string]::IsNullOrWhiteSpace($title)) { throw 'A project action needs a title.' }
            if ([string]::IsNullOrWhiteSpace([string](Get-TriageValue $Action 'purpose'))) { throw "Project action '$slug' needs purpose." }
            # Mirrors Copy-LocalPagesToProject.ps1's target rule exactly; the runner asserts the
            # child's own preflight produces this same list before any write.
            $writeSet = @($source.files | ForEach-Object {
                if ($source.is_container) { "projects/$slug/notes/$($source.name)/$($_.relative)" } else { "projects/$slug/notes/$($_.relative)" }
            })
            $metadata['purpose'] = [string](Get-TriageValue $Action 'purpose')
            $metadata['next_actions'] = @(Get-TriageArray $Action 'next_actions')
            $destination = 'shared-collection'
            $operation = 'copy-pages'
        }
        'book' {
            if ([string]::IsNullOrWhiteSpace($slug)) { throw 'A book action needs the Book slug.' }
            if ($slug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'A book action slug must use lowercase letters, digits, and single hyphens.' }
            if ([string]::IsNullOrWhiteSpace($title)) { throw 'A book action needs a title.' }
            if ([string]::IsNullOrWhiteSpace([string](Get-TriageValue $Action 'summary'))) { throw "Book action '$slug' needs summary." }
            $bookRoot = "books/$slug/wiki"
            $writeSet = @("$bookRoot/_book.md", "$bookRoot/_index.md") + @($source.files | ForEach-Object {
                if ($source.is_container) { "$bookRoot/$($source.name)/$($_.relative)" } else { "$bookRoot/$($_.relative)" }
            })
            # The shared Book Catalog is appended to, not created, so it belongs in touch_set: two
            # new Books in one batch is a reasonable request and an overlap refusal there would be
            # a false alarm.
            $touchSet = @('books/README.md')
            $metadata['summary'] = [string](Get-TriageValue $Action 'summary')
            $collection = [string](Get-TriageValue $Action 'collection')
            if (-not [string]::IsNullOrWhiteSpace($collection)) { $metadata['collection'] = $collection }
            $destination = 'shared-collection'
            $operation = 'create-book'
        }
    }

    if ($includePages.Count) { $metadata['include_pages'] = @($includePages | Sort-Object) }
    if ($sourceKind -ceq 'holding') {
        $metadata['source_note_title'] = $source.note.title
        # Every destination outside the Holding Shelf itself receives the note's BODY, with the
        # frontmatter separated off: Add-ShelfBookPage composes a page and needs a leading H1;
        # Publish-SharedBookCandidate has always split frontmatter from every page it publishes; and
        # a Project record carrying a raw `---` block would collide with the note frontmatter Basic
        # Memory writes itself. Only `notebook` copies the file verbatim, because there the
        # frontmatter IS the provenance the working copy should keep.
        if ($kind -cin @('shelf-book', 'project', 'book')) {
            $metadata['frontmatter'] = if ($noteBody.has_frontmatter) { 'separated' } else { 'none' }
            $deliveredSha = Get-TriageHash $noteBody.body
        }
    }

    $writeSet = @($writeSet | Sort-Object)
    $touchSet = @($touchSet | Sort-Object)
    $deleteSet = @($deleteSet | Sort-Object)
    $requiredDeskState = @(@($requiredDesk) | Sort-Object -Unique)
    $sourceManifest = @($source.files | ForEach-Object { "$($_.source_path)|$($_.sha256)" } | Sort-Object)
    $metadataText = ConvertTo-TriageDigestText $metadata

    # The digest covers everything an approval is meant to bind: where the material comes from, where
    # it lands, what the action does, the metadata that shapes the result, the exact source bytes,
    # the exact bytes delivered when those differ, the collision policy, the Desk state required, and
    # the exact paths it will create and destroy.
    $digest = Get-TriageHash (@(
        "kind=$kind"
        "source=$sourceKind"
        "source_slug=$(ConvertTo-TriageDigestText $sourceSlug)"
        "destination=$destination"
        "operation=$operation"
        "slug=$slug"
        "title=$(ConvertTo-TriageDigestText $title)"
        "metadata=$metadataText"
        "collision_policy=create-only"
        "required_desk_state=$(ConvertTo-TriageDigestText $requiredDeskState)"
        "sources=$($sourceManifest -join "`n")"
        "delivered=$deliveredSha"
        "write_set=$($writeSet -join "`n")"
        "delete_set=$($deleteSet -join "`n")"
    ) -join "`n")

    [pscustomobject]@{
        action_id           = "action-$($digest.Substring(0, 16))"
        kind                = $kind
        source              = $sourceKind
        source_slug         = $sourceSlug
        source_note         = if ($sourceKind -ceq 'holding') { $source.relative } else { '' }
        slug                = $slug
        title               = $title
        source_path         = $source.relative
        source_is_folder    = $source.is_container
        source_file_count   = $source.files.Count
        source_manifest     = $sourceManifest
        delivered_sha256    = $deliveredSha
        destination         = $destination
        operation           = $operation
        collision_policy    = 'create-only'
        required_desk_state = $requiredDeskState
        write_set           = $writeSet
        touch_set           = $touchSet
        delete_set          = $deleteSet
        metadata            = [pscustomobject]$metadata
        action_digest       = $digest
        resolved            = $source
        raw                 = $Action
    }
}

# Per-action preflight is not enough on its own. Two actions creating the same Shelf page, Project
# record, or Book page each pass alone, then the first creates the destination and the second
# necessarily fails -- a guaranteed partial batch from a conflict that was knowable here.
#
# A NOTEBOOK ACTION'S TWO INDEXES ARE NOT CREATES, so they are not compared here (S44). Every Notebook action
# re-renders the master index under the render lock, and a topic's index is created by the first action into a
# new topic and updated by every later one -- so two Notebook actions sharing either is two updates, in order,
# not a guaranteed failure. Compared, they refused every batch carrying a second Notebook action; S43 found the
# same two paths wrongly held to "must not exist" at run time (Test-TriageDerivedWritePath) and fixed that half.
function Test-TriageSharedDerivedPath($Action, [string]$Path) {
    if ([string]$Action.kind -cne 'notebook') { return $false }
    if ($Path -cmatch '(^|/)_master-index\.md$') { return $true }
    $topicSlug = [string](Get-TriageValue $Action.metadata 'topic')
    $Path -cmatch ('(^|/)' + [regex]::Escape($topicSlug) + '/_index\.md$')
}

function Assert-TriageWriteSetsDisjoint($Actions) {
    $seen = @{}
    foreach ($action in @($Actions)) {
        foreach ($path in @($action.write_set)) {
            if (Test-TriageSharedDerivedPath $action $path) { continue }
            $key = $path.ToLowerInvariant()
            if ($seen.ContainsKey($key)) {
                throw "Two actions both create '$path' ($($seen[$key]) and $($action.action_id)). One would necessarily fail, so the batch is refused before any write. Model an ordered dependency or change one destination."
            }
            $seen[$key] = $action.action_id
        }
    }
    # Same reasoning one step further: two actions destroying one path, or one creating what another
    # destroys. Both are guaranteed partial batches, and both were invisible while only write sets
    # were compared.
    $doomed = @{}
    foreach ($action in @($Actions)) {
        foreach ($path in @($action.delete_set)) {
            $key = $path.ToLowerInvariant()
            if ($doomed.ContainsKey($key)) {
                throw "Two actions both discard '$path' ($($doomed[$key]) and $($action.action_id)). The second would find nothing there; remove the duplicate."
            }
            if ($seen.ContainsKey($key)) {
                throw "Action $($seen[$key]) creates '$path' and $($action.action_id) discards it. Run them as separate, separately approved batches."
            }
            $doomed[$key] = $action.action_id
        }
    }

    # A discard binds the note's bytes as they are now. `review` and `notebook` rewrite that note's
    # own frontmatter, so by the time the discard ran -- it runs last, deliberately -- its source
    # would no longer hash to what the approval covered, and Assert-SourceUnchanged would refuse it
    # after the other action had already landed. Knowable here, so refused here. `shelf-book`,
    # `project`, and `book` only READ the note, so they combine with a discard freely.
    $mutated = @{}
    foreach ($action in @($Actions)) {
        if ($action.kind -cnotin $script:TriageNoteMutatingKinds) { continue }
        if ([string]::IsNullOrWhiteSpace($action.source_note)) { continue }
        $mutated[$action.source_note.ToLowerInvariant()] = $action.action_id
    }
    foreach ($action in @($Actions)) {
        if ($action.kind -cne 'discard') { continue }
        $key = ([string]$action.source_note).ToLowerInvariant()
        if ($mutated.ContainsKey($key)) {
            throw "Action $($mutated[$key]) rewrites '$($action.source_note)' and $($action.action_id) discards it. The rewrite would invalidate the discard's approved source hash mid-batch, so the two cannot share a batch. Discard it separately once the other action has landed."
        }
    }

    $ids = @{}
    foreach ($action in @($Actions)) {
        if ($ids.ContainsKey($action.action_id)) { throw "Two actions are byte-identical ($($action.action_id)); remove the duplicate." }
        $ids[$action.action_id] = $true
    }
    # Two Project actions for one Hub have disjoint write sets and still cannot both run. The Hub
    # record itself is created by the first of them, and Copy-LocalPagesToProject binds whether the
    # Hub is being created or reused into its own plan_id -- so the moment the first action creates
    # it, the second's approved plan_id no longer matches and it refuses. The conflict is real,
    # invisible in the write sets, and knowable here.
    $projectSlugs = @{}
    foreach ($action in @($Actions)) {
        if ($action.kind -cne 'project') { continue }
        if ($projectSlugs.ContainsKey($action.slug)) {
            throw "Two Project actions both target '$($action.slug)'. The first would create or claim the Hub and invalidate the second's approval; combine them into one action with include_pages instead."
        }
        $projectSlugs[$action.slug] = $true
    }
}

function Get-TriageExecutionOrder($Actions) {
    $ordered = [Collections.Generic.List[object]]::new()
    foreach ($kind in $script:TriageExecutionOrder) {
        foreach ($action in @($Actions)) {
            if ($action.kind -ceq $kind) { [void]$ordered.Add($action) }
        }
    }
    @($ordered)
}

function Resolve-TriagePlanActions($Actions, [string]$Workspace, [string]$CaptureDate) {
    if ([string]::IsNullOrWhiteSpace($CaptureDate)) { $CaptureDate = [DateTime]::Now.ToString('yyyy-MM-dd') }
    $resolved = @(@($Actions) | ForEach-Object { ConvertTo-TriageAction -Action $_ -Workspace $Workspace -CaptureDate $CaptureDate })
    if ($resolved.Count -eq 0) { throw 'A Library Triage plan needs at least one action.' }
    Assert-TriageWriteSetsDisjoint $resolved
    @(Get-TriageExecutionOrder $resolved)
}
