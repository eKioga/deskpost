# Book Archive Model

## Working workspace

Keep active work in the Library workspace:

```text
raw/       current source material
notebook/  volatile compiled, editable knowledge
output/    user-facing drafts, reports, exports, and query results
docs/      durable Library operating guidance and harness documentation
internal/  application-managed journals, plans, and acceptance evidence
```

## NAS Library shelves

A Book published through Basic Memory is already stored on the NAS. The Library has two shelves:

```text
books/<book-slug>/    active Books in the normal Catalog
archive/<book-slug>/  inactive Books retained for later
```

Archiving is organizational, not a second backup. It moves the complete Basic Memory Book from
`books/` to `archive/`, records it in `archive/README.md`, and removes it from the active Catalog.
The local workbench remains unchanged.

The native move and archive readback are acceptance-tested. Opening an archived Book directly
through the ordinary validated reader is planned work; today the ordinary reader opens active
Books from `books/`.

### Archiving leaves no emptied directory behind (2026-09-03)

Basic Memory indexes **notes**, and `move_note ... is_directory = $true` moves notes. Until
2026-09-03 the emptied source directory -- `books/<slug>/` or `projects/<slug>/` -- survived every
archive with zero files in it.

**Why nothing caught it for two months.** Every surface the Library owns is index-backed, and an
index built from notes cannot see a directory that has none. Probed against the live server:

- `list_directory` derives its directory nodes from the notes underneath. A probe directory created
  over SMB did not appear in a depth-1 listing of `books` that correctly listed every real Book
  beside it.
- `list_directory` on the emptied directory and on a name that never existed return byte-identical
  payloads: `{"nodes":[],"page":1,"page_size":10,"total":0,"has_more":false}`. The transport cannot
  distinguish *emptied* from *absent*.
- The deployed server exports 21 tools and **no directory-delete verb of any kind**, so the removal
  could never have ridden on the transport the archivers already use.

On 2026-08-29 the reader found six husks in Explorer while the Librarian, having checked five
separate index-backed surfaces, was reporting the collection clean. None of those five was at fault.
This is the Library's standing example of a defect that no amount of care with the available
surfaces could have found -- the surface itself was the wrong instrument.

**The fix is in two halves, because one half can be unreachable.** `SharedCollectionFiles.ps1` is
the only Library code that looks at the collection's filesystem.

1. **Both archivers clean up as they go.** After the archive is complete and verified,
   `Invoke-SharedHuskCleanup` removes the emptied directory and the result carries
   `source_tree_removed`: `removed`, `absent`, `not-empty`, `unavailable`, or `failed:<message>`.
   The preflight plan names the outcome in advance, so the reader learns *before* approving when
   the share is unreachable and the directory will be left behind.
2. **`shared.archive-leaves-no-husk` catches the rest.** It WARNs -- a husk holds no content, so it
   is untidiness rather than damage -- and reports `skipped` when the share is not reachable. It
   covers what an unreachable cleanup missed and anything archived before the cleanup existed.

**Three refusals carry the safety.** A directory is removed only while it provably holds **no file
at any depth**, re-checked immediately before the delete, with `-Force` so a *hidden* file still
counts as content. The root is resolved by requiring both `books/README.md` and `projects/README.md`
to be present, so a wrong path is rejected rather than acted on. And an explicitly supplied root
that fails that validation **throws** instead of falling through to a discovered one -- a silent
fallthrough would point a fixture at the live NAS collection. The self-test asserted the opposite of
that last rule at first, and the failure is what found it.

Removal cannot lose text, which is what lets it run inside an already-approved archive without a
second approval. Override the root with `LIBRARY_SHARED_COLLECTION_ROOT` rather than editing the
candidate list.

**Proved live, not only by fixture**, on 2026-09-03: an emptied `books/<slug>/wiki/notes` planted on
the real collection, the real gate check warned and named the topmost path only, the real cleanup
removed it, and the check returned clean.

### The archive catalog repairs its own emptiness claim (2026-09-03)

`archive/README.md` carried a pilot-era opening sentence -- `The initial pilot has no archived
content.` -- that no helper authored, and the page has listed real archived Books since 2026-08-28,
so the catalog contradicted itself. The prose `Archive-SharedBook.ps1` writes when it *creates* the
index was always correct; the stale sentence predates it and only ever survived because later runs
append an entry rather than rewrite the intro.

There is no bounded route for the reader to correct it directly: the Desk guard refuses an
`edit_note` outside an exact open active Project Hub path, and that boundary is worth more than one
tidy sentence. So the repair rides on the archive that next lists an entry:

- **One verbatim sentence, never a pattern.** `find_replace` with `expected_replacements = 1`, which
  fails loudly rather than applying if the page changed between the read and the edit. The literal is
  prose, so it cannot match an entry -- an entry is a `- [[archive/<slug>/wiki/_book|Title]]` list
  item. A duplicated sentence is reported, not written.
- **It runs last and never throws.** The entry is listed and readback-verified first, and a failed
  repair is reported as `emptiness_claim` on the result rather than aborting. A throw there would
  leave the Book in *both* catalogs -- worse than a stale sentence.
- **The limitation is deliberate.** The live page stays wrong until the next archive runs.
  `Invoke-LibraryChecks.ps1 -IncludeShared` reports the contradiction as
  `shared.archive-catalog-consistency`, emitted as a **WARN** for exactly that reason: it flags the
  live page today and turns green once a real archive repairs it, where a FAIL would block every
  commit until an unrelated archive happened to run.

The detector is broad where the repair is narrow, by decision. The check matches any claim of
emptiness; the helper replaces one known sentence. A detector that misses a variant only stays quiet,
while a writer that matches loosely edits prose it does not own. The two pattern lists are therefore
not shared code, and if they drift the symptom is a warning an archive fails to clear -- visible,
not silent. Both are proved offline by `Archive-SharedBook.ps1 -SelfTest`, which the gate drives.

See [Library Organization Model](library-organization.md) for the implemented collection-aware
Catalog grouping above these two physical shelves.

## Key Takeaways

- Opening a Book retrieves prior context; it does not replace the local workbench.
- Refresh by revising the local Notebook from whichever evidence is useful now: current session
  context, selected notebook notes, a repository in `raw/`, targeted web research, or a mix.
  `raw/` is optional; it is never an automatic refresh input.
- The shared Book is a NAS-backed reader copy, not a container for every local raw file or
  user-facing output.
- `copying` and `complete` are quiet publisher recovery states, not reader-facing judgments of
  usefulness or trust. Do not infer that a Book is gone just because a particular client view
  does not list it; confirm the Book Catalog and exact canonical reader paths.
- The archive catalog's emptiness sentence is repaired by the next archive run, not on demand.
  Until then `shared.archive-catalog-consistency` warns. A WARN here is a known state, not a defect
  to chase.
- Archiving moves notes, so the emptied source directory is a filesystem concern and **no
  index-backed check can see it**. `shared.archive-leaves-no-husk` is the only check that looks at
  the collection's filesystem, and it is the reason a leftover directory is now visible rather than
  found by accident in Explorer.
- A directory is only ever removed while it provably holds no file, hidden files included. If the
  share is unreachable the archivers report `unavailable` and leave it -- never a silent skip.

## Historical Buzz migration context (2026-08-13)

The historical local publication journal associates **Buzz Self-Hosting** with
`books/buzz-self-hosting/wiki/`, but it has no per-page digest manifest. It is evidence of a past
copy, not proof that the NAS Book is present or current. Before a Buzz refresh or separation,
re-read the live Book Catalog and exact canonical paths. Any later Book refinement remains a
separately approved operation; it is never an automatic retry or an implied archive move.
