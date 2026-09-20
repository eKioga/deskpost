# Library Organization Model

> **Status:** Project Hubs, their separate active/archive catalogs, and collection-aware Book
> publishing are implemented. Collections change neither Book paths nor Book-reader behavior.

See [Library Inventory and Triage](library-triage-design.md) for the implemented local-inventory,
manifest-bound copy workflow.

## One Library, three useful ways to browse

Keep one `ai-library` Basic Memory project. A Book has one primary home in the Catalog based on
the question it answers, not on a quality score or a required review process:

| Catalog collection | Starting question | Examples |
| --- | --- | --- |
| Projects | What am I doing next in this bounded effort? | a trip, house search, home-server migration |
| Reference | How does this tool or subject work? | Buzz Self-Hosting, Basic Memory, a framework |
| Workflows | How do I accomplish a recurring outcome across tools? | the AI Library Pilot, a research-to-wiki routine |

This is an orientation aid, not a lifecycle. Choosing a collection at publication is one quiet
classification; it does not make a Book more trusted, current, or complete. A Book may be
refreshed whenever it becomes useful again, from the evidence relevant to that moment.

**Buzz Self-Hosting** belongs in Reference. The **AI Library Pilot** belongs in Workflows. A
reusable closeout or reader packet for a trip or house hunt belongs in Projects. Its living active
work belongs in a Project Hub under `projects/`; see
[Project Hubs and Optional Action Boards](project-hub-design.md). A workflow should link to the
applicable tool reference instead of duplicating its explanations.

## Storage remains deliberately simple

The NAS-backed Basic Memory paths remain exactly as they are:

```text
books/<book-slug>/    active Books
archive/<book-slug>/  inactive Books retained for later
```

Do not create separate Basic Memory projects, duplicate a Book between folders, or add a tag
system to make these collections work. When a new or refreshed Book is explicitly given a
collection, the publisher creates the **Projects**, **Reference**, and **Workflows** headings if
needed and inserts that entry below the selected heading. It leaves pre-existing ungrouped Catalog
entries where they are and does not encode the collection into the physical path.

Archiving is separate from collection: an inactive Book moves to `archive/<book-slug>/`, while an
inactive Project Hub moves to `archive/projects/<project-slug>/`. Each retains its original context
for later browsing.

## Writing inside a Book

Use article forms only as a writing aid:

- **Explanation** for why something works or a decision's context.
- **Reference** for stable facts, settings, and commands.
- **How-to** for a goal-directed procedure.
- **Tutorial** for a guided first experience.

These forms help a reader find the right kind of answer. They are not Book states and need no
separate management process.

## Reader and refresh behavior

Opening an active Book reads it directly from the NAS Library through the validated reader. It is
not a checkout and does not require copying its contents into the local workbench. To refresh a
Book, revise the local Notebook from whichever current evidence matters — session context,
notebook notes, selected web research, files in `raw/`, or a mix — and deliberately replace the
shared reader copy.

The native archive move has been acceptance-tested, but opening an archived Book in place through
the ordinary validated reader is the next planned reader improvement. Until that is implemented,
archive is a safe inactive shelf, not part of the ordinary open-Book menu.

## The `D:\deskpost\` root: one folder per role

> Created 2026-09-19 (`PLAN-public-release.md` Phase A, step 5). Empty at first: nothing has moved
> into it yet, and every move into it goes through the cutover protocol below.

Everything Library-related on `D:` consolidates under one root, so that "where does this live?" has
one answer instead of eleven sibling folders accumulated over a year.

```text
D:\deskpost\
  app\         the program: the checkout that is published
  workspaces\  the reader's own material, one folder per workspace
  prompts\     the prompts-only sibling product and its sandbox
  archive\     dated folders holding anything retired
```

**The rules, and the reason each one exists.**

- **Lowercase and hyphenated.** A path that differs only by case is the same folder on Windows and a
  different one on Linux, and this product has to build on both.
- **A folder name is a ROLE, never a version.** `app\`, not `app-v2\`; `prompts\`, not
  `librarian-v2\`. A version in a folder name becomes a pointer every configuration file has to
  follow, and the day it changes is the day half of them are stale. Versions live in git tags and in
  release metadata.
- **An experiment gets a dated folder under `archive\`, never a sibling of `app\`.** The eleven
  folders this root replaces were all, at the time, "just for now" siblings.
- **Nothing under `archive\` is opened by the IDE.** It is a record, not a working copy, and a
  second copy of a working tree that an editor can reach is a second copy somebody will edit.
- **`archive\` is not a disposal rule.** Ninety days is a reminder to review a batch, and deleting
  one is its own gated operation: a preflight lists every file in the batch that has no identical
  copy in a live workspace or any repository, the reader approves that exact list, and only then is
  the batch deleted.
- **`D:\2nd_b` and `D:\2nd_b-stratch` are outside this root and are never touched.** They are a
  peer vault, not Library material.

**Nothing moves in by hand.** `tools/Move-LibraryFolder.ps1` is the one route, and it implements the
cutover protocol: a maintenance barrier that every claim-gated mutator and both seat entry routes
refuse on, raised before anything is read; a hashed preflight bound to a `plan_id` that is re-derived
under the barrier, so an approval covers the bytes the reader was actually shown; a verified copy
with a readback of every hash; the source **renamed aside rather than deleted**; each pointer file
rewritten and read back byte for byte; a final source-to-destination verification after the cutover;
an executable rollback checkpoint; and a journal of every stage under `internal/move-journals/`. The
aside copy survives the run and is deleted only by the archive purge above.

Read [Librarian Operation Playbooks](librarian-operation-playbooks.md), *Move a Library folder under
the cutover protocol*, before running it.

## Design sources

This proposal adapts three useful ideas without importing their process overhead: PARA's
project/resource/archive distinction, Diataxis's reader-oriented documentation forms, and the AI
Library Pi port's separation of a readable shelf from a writable local authoring area.

## Key Takeaways

- Collections answer “what kind of starting point is this?”, not “how good is it?”
- Keep one NAS-backed Library and the current two physical shelves.
- Refresh remains source-neutral and Notebook-first.
- Collections are applied by the publisher without metadata or path restructuring by the user.
- `D:\deskpost\` holds one folder per role -- `app\`, `workspaces\`, `prompts\`,
  `archive\` -- and nothing moves into it except through `tools/Move-LibraryFolder.ps1`.
- A collection is a decision that can be revisited: refreshing with a different `-Collection` moves
  the Catalog entry to the new heading and leaves none under the old, and the publisher reports the
  move (`catalog_entry_state` `moved`) rather than reporting a rewrite in place.
