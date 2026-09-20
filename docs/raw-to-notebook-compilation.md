# Compile a raw batch into the Notebook

## Reader benefit and safety boundary

The Library now has one mechanical bridge between scoped source reading and its existing triage
tools. A finished synthesis can become a correctly indexed Notebook article with exact source paths
and hashes, ready to graduate to a Project Hub or Book. The reader no longer has to trust three
unrelated manual file edits before the hash-bound triage begins.

The boundary is deliberately narrow. The helper reads one explicitly named raw batch and only the
source files explicitly named within it. It never searches all of `raw/`, follows a reparse point,
copies source text, synthesizes a claim, edits a source, or writes to the shared collection. The
Librarian still does the intellectual work: read the sources, write a concise synthesis, state its
limits, and choose what belongs in `## Key Takeaways`.

## The helper

`tools/Compile-RawBatchToNotebook.ps1` takes:

- `-Batch`, the same reader-named batch understood by `Search-RawBatch.ps1`;
- a lowercase `-Topic` and `-ArticleSlug`, plus the topic title and short overview;
- `-ContentPath`, a finished Markdown article beginning with one H1 and carrying
  `## Key Takeaways`; and
- one or more `-SourceFile` paths relative to that batch.

The helper generates `## Sources` itself. Every source entry names the canonical `raw/...` path,
the SHA-256 of the bytes actually present, and the raw tier's `external` or `historical` provenance
label. Supplying a handwritten `## Sources` section is refused so the recorded manifest cannot
silently disagree with the prose.

**Since 2026-09-05 it also records the upstream it compiled from**, when the batch is a git checkout:
one `Upstream` line per repository, naming the remote URL, the full ref and the commit, confirmed
against that remote before it is written. That is what makes a later Currency check possible. A batch
that is not a git checkout, or whose cited files have uncommitted changes, simply gets no pin and the
article compiles as before -- pass `-RequirePin` to make that a refusal instead, and `-AllowHost` to
permit a forge other than `github.com`. Detail: [Compiling and refreshing a Book from a git URL](book-currency-anchoring.md).

On the first article in a topic it stages the whole topic folder, `_index.md` included, and promotes
it by one atomic directory move — so a killed run cannot leave a topic directory with no index in it.
`notebook/_master-index.md` is then **rendered** from the topic directories and their headings rather
than appended to, under the Notebook render lock. Later articles into a topic that already exists
change nothing that index derives from, so they take no render lock at all and leave its bytes
untouched. A compile into a topic directory that has no `_index.md` is refused, naming that
directory. An identical rerun is `unchanged`, which also makes an interrupted first run recoverable
without duplicating links.

The plan reports `topic_is_new` and `takes_render_lock`, so a preflight says whether the run will
serialize against every other Notebook writer or only against its own topic. Detail:
[Derived Indexes](derived-indexes.md).

Creating a new article is additive and needs no approval. A divergent existing article is refused
unless `-ReplaceExisting` is explicit. Replacement then follows the Library's ordinary destructive
pattern: run `-Preflight`, show the exact `plan_id`, and after one approval rerun with
`-UserConfirmed -ApprovedPlanId`. The plan binds the draft, prior article, both indexes, and every
source hash. A changed source or Notebook file invalidates the approval. Before mutation the three
Notebook paths are journaled under the topic lock; failure restores and verifies their prior bytes.

## Ordinary use

Prepare the synthesis outside the Notebook, then preview it:

```powershell
tools/Compile-RawBatchToNotebook.ps1 -Batch '<named batch>' -Topic '<topic>' -TopicTitle '<title>' -TopicOverview '<one sentence>' -ArticleSlug '<article>' -ContentPath '<draft.md>' -SourceFile '<path-inside-batch>' -Preflight
```

For a new article, rerun without `-Preflight`; it applies directly. The returned `article_path` is a
valid `source_path` for `tools/Invoke-LibraryTriage.ps1`. A topic folder can also go directly to
`Copy-LocalPagesToProject.ps1` or `Publish-BookCopy.ps1`, using their own existing preflight and
approval boundaries.

## Acceptance boundary

The fixture suite proves creation, generated provenance, both index links, identical rerun,
replacement approval, source-change invalidation, and path containment. The first reader exercise
still matters: it must establish whether the command surface and returned next step feel natural
while compiling real material. That exercise should use a new Notebook article; publication or a
Project write remains a separate preview and approval.
