# Book currency anchoring — deferred design

**Status: built 2026-09-05.** This file is now the *reasoning*, not the guidance. What shipped, how
to use it, and what it deliberately leaves out are in
[Compiling and refreshing a Book from a git URL](book-currency-anchoring.md); the plan it was built
from is `PLAN-book-currency.md`. Read on for how the design was reached -- including the four
blockers a remote pin dissolved, which is why it was deferred in the first place.

**Revised 2026-09-04.** The final section revisits this: anchoring to a remote pin rather
than a local worktree removes four of the five reasons it was deferred, and the registry with
it. The design above still governs everything that revision does not name.

## Why it was deferred

The design survived two adversarial review rounds and came out correct but disproportionate. It
had grown two new public helpers, a registry with its own lock and transaction, modifications to
three or more publication writers, a security surface (path classes, equality oracles, OID formats),
an eleven-branch state machine, and two unsolved problems — while delivering **nothing on day one**:

- No bounded helper edits an existing shared Book's `_book.md` in place, so no existing Book can be
  anchored.
- `books/2nd-b-vault` — the case that motivated the `declared` kind — is therefore unanchorable.
- Anchors would appear only on Books created *after* it shipped, and Books are created rarely.

The Hub half of the same plan (ADR-0003, the dev template, the decisions convention) delivers
immediately, so it was landed first. Revisit this when either enough new Books have accumulated to
make anchoring worth its cost, or a bounded shared-Book editor exists for other reasons.

## The problem it solves

A Book compiled from a live codebase is a point-in-time copy that reads as verified long after its
source has moved on. The Library's existing `Source check` cannot help: it compares a Book's claims
against a `raw/` batch, and `raw/` batches are deliberately deleted as projects close. A **repo,
unlike a raw batch, is not deleted** — so a versioned source enables a durable check that raw
batches never could.

## Vocabulary (settled, and it constrains the design)

`Source check`, `Refresh`, and `Superseded` are all taken in `CONTEXT.md`, and **`stale` is on
`Superseded`'s `_Avoid_` list**. The settled term is **`Currency check`**: asking a Book's source
what version it is now and comparing it to the version the Book records. It reports that **a Refresh
is due** — reusing the existing verb rather than inventing a competitor.

`Currency check` must be distinguished from `Source check` in both glossary entries:

| | Source check (exists) | Currency check (this design) |
|---|---|---|
| Compares | the Book's *claims* | the Book's *recorded version* |
| Against | a raw batch | the source itself |
| Needs | the batch still present | nothing local |
| Asks | *is this true?* | *is this current?* |

A Book whose source is unreachable is **unverified, not defective** — `CONTEXT.md` already states a
Book with no surviving source is *finished, not orphaned*, and the output wording must not
contradict it.

## Schema

**The field prefix must be `Currency-`, never `Source-`.** `- **Source:**` is already emitted by
`Publish-BookCopy.ps1:96` and `Import-ExternalWikiToShelf.ps1:84` with free-prose values and exists
in live pages today (`shelf/holding/wiki/_book.md:6`,
`shelf/_archive/godot-engine-reference/wiki/_book.md:4`). Reusing it would misread existing Books as
partially anchored — the day-one-data failure this workspace has hit before.

Book fields, restricted to **one contiguous metadata block near the `_book.md` heading**; occurrences
in fenced code, indented blocks, or prose are inert:

- `- **Currency-Source:**` — an opaque **source ID**, never a path
- `- **Currency-Kind:**` — from a closed set
- `- **Currency-Version:**` — the recorded version string

`Currency-Key` was proposed and **must not be Book-controlled**: a hostile Book could select any
valid key in a registered file, turning the helper into an equality oracle over fields the reader
never registered for disclosure. The key belongs in the registry.

## The source registry

A local, reader-owned registry (`internal/currency-sources.json`) maps source ID to a canonical
target. **The Book never carries a filesystem path.** This is what closes the path-injection surface
and what makes a shared Book portable: an ID means the same thing wherever it is registered and
resolves to `cannot verify` where it is not.

Kind-specific records, because a git source needs a repository while a declared source needs an
exact file:

- `{ id, kind: "git", worktree, ref }`
- `{ id, kind: "declared", file, key }`

The registry needs a bounded public writer (`Set-CurrencySource.ps1`) with Register / Withdraw /
List / Validate, a registry-wide lock, atomic replacement, and verified readback — direct editing of
`internal/` is prohibited, and the analogous raw-batch ownership registry already has a dedicated
writer.

**Path validation belongs at registration, not at check time**, and must state its position on
junctions, reparse points, UNC and device paths, git parent discovery, `.git` file redirection,
`commondir`, and external config includes. A registered target can also be replaced after
registration, so the resolved identity must be revalidated immediately before and after each check.

## The check

Read-only helper (`Get-BookCurrency.ps1`). **Never executes text from a Book. Never parses a version
semantically** — string equality only, so a SHA and `1.66.14` are handled by identical code.

Ordered terminal branches, evaluated before any source access where possible. Comparison runs only
on a fully valid tuple, so an absent anchor can never yield `refresh due` and two empty values can
never yield `current`:

1. zero `Currency-*` fields → `cannot verify / not anchored`
2. registry unreadable or carrying duplicate IDs → `cannot verify / registry invalid`
3. incomplete, empty, or duplicated tuple → `cannot verify / malformed anchor`
4. kind outside the closed set → `cannot verify / unknown kind`
5. ID absent from the registry → `cannot verify / source not registered`
6. Book kind disagrees with registry kind → `cannot verify / kind mismatch`
7. target not a valid repository or file → `cannot verify / source invalid`
8. declared parsing finds zero or multiple valid top-level matches → `cannot verify / malformed source`
9. recorded ref unavailable, or source dirty at check time → `cannot verify / source unstable`
10. target unreachable, or the check times out → `cannot verify / source unreachable`
11. valid tuple compares equal → `current`; unequal → `refresh due`

**Canonicalization before ordinal comparison:** strict UTF-8, BOM stripped, CRLF and trailing
whitespace normalized, surrounding quotes removed, control characters rejected, values length-capped.
Git OIDs must be full, and the design must either detect `git rev-parse --show-object-format` to
accept 40- or 64-character OIDs, or state and enforce SHA-1-only registration — otherwise a valid
SHA-256 repository is permanently malformed.

**`declared` parsing** needs one supported grammar with exactly one syntactically valid top-level
match; never first-match-wins.

**git hardening:** resolve a trusted executable before touching the source; `-C` with an argument
array, never a shell string and never after a `cd`; `GIT_*` sanitized; per-check timeout. Record
**ref and commit** — and note the schema above has nowhere to put a ref, so either the registry holds
it or a git-only `Currency-Ref` is added.

**Clean-at-capture is not sufficient.** If the tree becomes dirty after publication while `HEAD` is
unchanged, the check still reports `current` though the live files no longer match the anchored
commit. Both capture and check need a clean-tree requirement with double sampling.

**Per-Book isolation:** every check independently bounded and independently failed; one Book erroring
yields exactly one `cannot verify` and never suppresses the others. Every value originating in Book
text is control-character-rejected and length-capped before rendering, because output is itself an
injection surface.

## The writer — the part that makes it real

Documenting fields and building a reader is not a feature. Without a writer, "anchor at Refresh
time" is aspirational. Required:

- **The full call chain**, not just the front door. `Publish-BookCopy.ps1:28` splats
  `@PSBoundParameters` into `Publish-SharedBookCandidate.ps1`, so anchor parameters added to one and
  not the other break `-Destination Shared` outright. Enumerate every downstream writer and wrapper.
- **A transaction.** `Publish-BookCopy.ps1:99` creates the directory and writes `_book.md` directly,
  with no staging or journal, so a late refusal leaves a partial Book. The shape:
  resolve registry → capture V1 → bind V1 and the generated root into the preflight `plan_id` →
  write to staging or a journaled transaction → capture V2 → require V1 = V2 and a clean source →
  publish atomically → exact readback, else roll everything back.
- **Provenance binding (unsolved).** Nothing stops a caller publishing material compiled from project
  A while supplying project B's source ID, producing a Book that reports `current` against an
  unrelated source. Either carry source ID and version as compilation provenance from the Notebook
  through to publication, or require the writer to prove its actual source lies within the
  registered content root.
- **Refresh (unspecified).** The lifecycle says anchors change on Refresh, but the replacement path,
  preservation rules, and how an anchored Shelf Book reaches shared storage are all undefined.

## Surfacing

**Not the gate, for currency state.** A Book being behind its source is a fact about the world that
no code change can fix; failing the gate on it trains the reader to ignore red and degrades a
mechanism that works. But the distinction is finer than "never gate": a **malformed anchor** is a
repository defect and *is* fixable, so that may FAIL. **A missing local registration must not FAIL** —
the registry is machine-local by design, so an unregistered source is expected on another machine
and is at most a WARN. The gate must also state whether it inspects fixtures, open Books, or a
separately authorized collection audit, since reading closed Book pages would violate the Desk
boundary.

**The Desk overview is more constrained than it looks.** `Get-DeskOverview.ps1:115` currently
promises *"No Book or Project page content was read"*, which any anchor reporting would falsify.
Reporting even anchor *presence* for an open shared Book requires the validated reader or a duplicate
of its exact-path MCP logic — so it is network access, and needs a timeout and per-Book degradation,
or anchor presence must be stored in catalog-class metadata instead.

## Open questions for the future loop

- Is `declared` worth building at all? It generated a disproportionate share of the risk (equality
  oracle, grammar ambiguity, record shape) for exactly one customer that cannot be anchored anyway.
  A git-only first version may be the right minimum.
- Does anchoring wait for a bounded shared-Book editor, or arrive with one?
- Is anchor presence catalog-class metadata rather than page content? That would resolve the Desk
  constraint cleanly.

## 2026-09-04 — Revisit: a remote pin dissolves four of these blockers

Prompted by ordinary use rather than by planned work. The reader now routinely compiles and refreshes
Books straight from a GitHub URL instead of cloning into `raw/` first, and asked for that route to
become first-class. Read against that workflow, this design's central choice — anchoring to a **local
worktree** — turns out to be what generated most of its cost. Anchoring instead to a **remote URL and
commit** removes four of the five reasons it was deferred.

Nothing here is built. This section revises the starting plan; it does not replace the design above,
whose hardening, branch ordering, and surfacing constraints still apply. The settled vocabulary is
unchanged: this is a **Currency check**, and `stale` remains on `Superseded`'s `_Avoid_` list.

### The substitution

`{ id, kind: "git", worktree, ref }` becomes a remote URL plus a full commit OID, recorded by the
compiler at the moment it hashes the batch.

| Deferred blocker | Why a remote pin does not have it |
| --- | --- |
| The registry — opaque ID, its own lock, writer, transaction, and path validation over junctions, reparse points, UNC and device paths, `.git` redirection and `commondir` | A remote URL is already portable and machine-independent. It is not a filesystem path, so there is nothing to canonicalize and no registry to hold the mapping. |
| **Provenance binding (unsolved)** — nothing stopped a caller publishing project A's material against project B's source ID | `Compile-RawBatchToNotebook.ps1` would generate the pin from the batch it actually hashed, in the same pass that refuses a handwritten `## Sources` (line 130). Provenance is bound by construction rather than checked afterwards. |
| **Clean-at-capture is not sufficient** — a worktree going dirty after publication leaves the check reporting `current` while the files no longer match | A remote commit is immutable. There is no dirty state to sample twice. |
| **Nothing on day one** — no bounded helper edits an existing shared Book's `_book.md`, so only newly created Books could be anchored | The pin rides the *article*, which a Refresh rewrites anyway. Any Book gains its anchor on its next Refresh, with no shared-Book editor. |

The last row answers the second open question above — anchoring neither waits for a bounded
shared-Book editor nor arrives with one — and it does so by moving the anchor off `_book.md` entirely.

### Where the pin lives

In the article's generated `## Sources` block, one line per upstream ahead of the existing file lines:

```
Upstream: `https://github.com/obsidianmd/obsidian-help` at `b2bbfc14...` (2026-09-04), batch `raw/obsidian-help`
```

Per-article rather than per-Book, because a Book already mixes upstreams: `obsidian-app` draws on both
`raw/obsidian-help` and `raw/obsidian-pika`. A Book's currency is then **derived** from its articles
rather than written a second time into `_book.md`, which is what removes the need for a `Currency-*`
field block and for a shared-Book editor to write one.

**That is a trade, not a free win, and it does not answer the third open question above.** Moving the
anchor onto the article solves the write problem and creates a read problem — see the next section.

### What it does not solve

- **The `declared` kind is untouched.** A version string in a file is a different problem and this
  says nothing about it. The first open question above is unaffected, and a git-only first version
  still looks like the right minimum.
- **Existing articles carry no pin** and cannot gain one without a recompile. The anchor arrives with
  the next Refresh, so day-one value reaches only Books that get refreshed.
- **Collection-wide currency gets more expensive, not less.** A per-article pin is page content, so
  deriving one Book's currency means reading every one of its articles through the validated reader.
  `Get-DeskOverview.ps1:115` cannot do that while promising no page content was read, and Discovery
  cannot do it at all. The deferred design had a clean escape — *anchor presence must be stored in
  catalog-class metadata instead* — and per-article pins make that escape harder, because such metadata
  would have to carry a roll-up of every article's pin rather than one field. Answering *which of my
  Books are behind?* without opening all of them is therefore still open, and is the strongest argument
  left for eventually writing a rolled-up anchor onto `_book.md` as well. The per-Book anchor is
  displaced by this revision, not refuted.
- **The surfacing constraints stand unchanged.** `Get-DeskOverview.ps1:115` still promises that no
  Book or Project page content was read; the gate must still not FAIL on a Book merely being behind
  its source; a malformed pin is still the fixable case that may.
- **The `## Sources` grammar is still unenforced.** Nothing checks that a compiled article's Sources
  lines parse, so a hand-edited article would drop out of a currency check silently and report as
  current because it cited nothing. That check is a prerequisite, not a nicety, once anything is
  load-bearing on the format.

### Two hazards the substitution introduces

Smaller than path injection, and not zero. Both are new work rather than inherited:

1. **Git URL schemes execute.** `ext::` is a git transport that runs a shell command, so a URL taken
   from article text and handed to `git ls-remote` is arbitrary code execution. The scheme must be
   allowlisted to `https://`, and the URL passed in an argument array, never a shell string — the
   design's existing *never executes text from a Book* rule, applied to a new input.
2. **A recorded URL is a host the checker will contact.** The check reaches a target named by stored
   text rather than by the reader, so it needs the timeout and per-Book degradation already specified
   above, and it must not silently follow a redirect to a different host.

### The check gets cheaper, and this was measured

Measured 2026-09-04 against `obsidianmd/obsidian-help`, with `raw/obsidian-help` present at `b2bbfc14`
for comparison:

| | full clone, as done today | thin clone |
| --- | --- | --- |
| download | 710 MB | 37 MB cone-mode; 20 MB restricted to `en/**/*.md` |
| wall clock | minutes | 1.2 s |
| material actually cited | 741 KB across 176 files | the same 176 files |

`git clone --depth 1 --filter=blob:none --sparse`, then `git sparse-checkout set`. The currency check
itself needs no clone at all: `git fetch --filter=blob:none --depth 1 origin <pinned OID>` took 0.59 s
and `git diff --name-status --no-renames <pin> HEAD -- 'en/**/*.md'` took 0.03 s, naming three changed
files while downloading no file contents — `--name-status` compares tree OIDs, and `--no-renames`
stops rename detection from pulling blobs. Note that `git fetch` of a bare commit needs the **full**
OID; an abbreviated one is refused by the server.

That reproduced, and improved on, a hand-run audit that had re-hashed 175 files to reach a coarser
answer. It is still only a currency check: a matching pin proves the source has not moved, never that
an article reflects it.

### The evidence this revision rests on

A Holding Shelf note captured 2026-09-05,
`notes/2026-09-05-tooling-gap-book-refresh-has-no-source-recovery-or-staleness`, records the session
that ran that audit by hand, embeds both throwaway scripts verbatim, and names the two gaps this
design's absence left: a Notebook reset deletes the refresh source, and nothing says which articles
are behind. It also records that no article names the commit it was compiled from — the omission this
revision closes.
