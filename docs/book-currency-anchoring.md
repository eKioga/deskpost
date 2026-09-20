# Compiling and refreshing a Book from a git URL

**Shipped 2026-09-04.** The design this implements is `PLAN-book-currency.md`, hardened over five
adversarial review rounds (`PLAN-REVIEW-LOG-book-currency.md`). The reasoning for the *shape* of the
design — why a remote pin rather than a local worktree, why no source registry — lives in
[Book currency anchoring — deferred design](book-currency-anchoring-deferred.md), which remains the
record of how it got here.

## Reader benefit and safety boundary

**Benefit.** Compiling a Book straight from a GitHub URL used to bypass
`Compile-RawBatchToNotebook.ps1` entirely, so the articles it produced carried no `## Sources` block,
no source hashes, and no index link. The URL is now an ordinary route: it produces a real `raw/`
batch, the existing compiler runs unchanged, and each article additionally records the remote commit
it was compiled from. That record makes a **Currency check** possible — asking the upstream whether a
Refresh is due, without a clone and without the raw batch still being present.

**Boundary.** Nothing here writes to the shared collection, and nothing decides that a Book is
correct. A matching pin proves the source has not moved; it never proves an article reflects it. This
is a staleness detector, and no output may be worded as verifying a Book. A Book whose upstream is
unreachable is **unverified, not defective** — `CONTEXT.md` already says a Book with no surviving
source is finished, not orphaned.

## The four pieces

| Helper | Role | Writes |
| --- | --- | --- |
| `tools/GitSource.ps1` | internal | nothing — the hardened git boundary every other piece calls |
| `tools/SourcesBlock.ps1` | internal | nothing — the one authority for the `## Sources` grammar |
| `tools/Sync-RawUpstream.ps1` | public | a new `raw/<batch>`, create-only |
| `tools/Get-BookCurrency.ps1` | public | nothing |
| `tools/Restore-BookSource.ps1` | public | a new `notebook/<slug>`, create-only |

`Compile-RawBatchToNotebook.ps1` gains the pin, `-AllowHost` and `-RequirePin`. Its front door is
otherwise unchanged. `BookManifest.ps1` gains the upstream roll-up at manifest body schema 2, which
[ADR-0011](adr/0011-a-sanitized-upstream-identity-is-catalog-class.md) authorises.

## Why these are ungated, when everything adjacent is not

Worth stating plainly, because the asymmetry would otherwise read as an oversight.

**The gate protects writes that lose text or leave this machine.** Every gated helper in `tools/`
writes to a Book, a Project Hub, the shared collection, or an `internal/` record.
`Get-BookCurrency.ps1` writes nothing at all. `Sync-RawUpstream.ps1` and `Restore-BookSource.ps1` are
**create-only**: each refuses a destination that already exists, so there is nothing to overwrite,
and git objects are immutable.

The create-only rule is not a convenience — it is what earns the ungating. An in-place update would
move a checkout and silently invalidate every SHA-256 that every article compiled from that batch
cites. This repository's own rule is that *a write that provably cannot lose text applies directly;
if you find yourself filtering the damage an "additive" write can do, it is not additive.* Newer
material is therefore a **new batch**, leaving the old one's bytes intact so the old articles still
verify. Disk is the price; verifiable provenance is what it buys.

Note that `raw/` is **not** reset-scoped — `CONTEXT.md`'s `Reset` entry says a Reset touches no `raw/`
batch. It is disposable and gitignored, which is a different thing, and eviction stays manual.

## The pin

One line per distinct repository, in the article's generated `## Sources` block, ahead of the file
lines:

```
- Upstream `https://github.com/obsidianmd/obsidian-help` ref `refs/heads/master` at `b2bbfc141948816ed46f3360cef38ce59f118013`; repo root `raw/obsidian-help`; captured `2026-09-05`
```

It rides the **article**, not `_book.md`. That is what removed the deferred design's largest blocker:
a Refresh rewrites articles anyway, so any Book gains its anchor on its next Refresh with no
shared-Book editor. A file line always begins with a backtick, so the literal `Upstream ` token
discriminates the two kinds with no ambiguity.

The `captured` date is **UTC**, stamped by the compiler, while the Library's written records use
the reader's local day. A pin captured on a US evening therefore reads as the following date --
the sample above was written on 2026-09-04. Harmless, but worth knowing before treating the two
as the same clock.

**The OID must be full** — 40 hex for SHA-1, 64 for SHA-256, both accepted so a SHA-256 repository is
anchorable. A bare-commit fetch is refused by the server on an abbreviated one. The value is never
parsed semantically, only compared.

**`repo root` is workspace-relative and is not the batch root.** `raw/obsidian-help` *is* its
repository; `raw/obsidian-pika/batch1/repo` sits two levels below its batch. The recorded root is
what maps a cited path onto `git diff --name-status` output, by longest-prefix strip.

### What the pin claims, exactly

*These bytes are git's own checkout of that commit under this repository's filters, and git reported
them unmodified at HEAD — sampled before the article was read and again after.*

It deliberately does **not** claim byte identity with the committed blob, because on Windows that
would be false. `core.autocrlf` is true by default in Git for Windows, so a checked-out file is CRLF
while its blob is LF: `raw/obsidian-help`'s `en/Bases/Bases syntax.md` is 17,795 bytes on disk against
17,429 in the blob. Git calls the tree clean because it applies the filter when it compares. The
Currency check compares tree OIDs between commits, never bytes, so it rests on exactly this claim and
no more.

### When the pin is withheld

The article still compiles and is simply `not anchored`, which is what an imported wiki export has
always been. Pass `-RequirePin` to turn a withholding into a refusal.

- no git repository between the cited file and the batch root
- the repository's metadata (`.git` redirect, `commondir`) leaves the batch
- the repository's own config carries an include or an execution-bearing key
- a cited file is untracked, or has uncommitted changes
- `HEAD` is detached, or its branch tracks no upstream
- the checkout moved while the article was being read
- the URL fails the grammar, or its host is not allowlisted
- **the pinned commit is not fetchable from the recorded remote**

That last one is why capture makes a network call. A remote-tracking ref proves only what a local
refs file says, and `raw/` is user-controlled, so the commit is confirmed against the remote before it
is recorded. No network means an unanchored article, not a failed compile.

## The Currency check

```powershell
tools/Get-BookCurrency.ps1 -Book <slug>
```

**The cheap path is the common path.** `git ls-remote <url> <ref>` costs about a third of a second and
settles the whole question whenever the remote tip still equals the pin: `current`, with no clone, no
fetch, and no temporary store. Only a moved tip pays for a blobless fetch of both commits and a
tree-level diff over the cited paths — and even then no file content is downloaded, because
`--name-status` compares tree OIDs and `--no-renames` stops rename detection pulling blobs.

Per-article verdicts, in the order they are decided:

| Verdict | Meaning |
| --- | --- |
| `skipped` | no `## Sources` block; not a compiled article, and not a defect |
| `cannot verify / malformed anchor` | two `## Sources` headings, an unparseable line, or two pins disagreeing about one repo root |
| `not anchored` | a Sources block with no `Upstream` line — a pre-pin article |
| `partially anchored` | some cited files belong to no recorded upstream; **never reported as current** |
| `cannot verify / refused source` | the URL fails grammar, or its host is not allowlisted |
| `cannot verify / source unreachable` · `source moved` · `ref unavailable` · `pinned commit unavailable` | the remote could not answer the question |
| `current` | the tip equals the pin, or the cited paths are unchanged between them |
| `refresh due` | cited source files changed upstream, and they are named |

The Book's overall status is decided in the order `cannot verify` → `refresh due` →
`not anchored`/`partially anchored` → `current`, and a Book whose pages are **all** `skipped` reports
`nothing to check`. A capture Book is the ordinary case for that last one: nothing there was ever a
compiled article, and "no upstream is recorded" would imply a Refresh would record one. A
`partially anchored` roll-up is reported as `not anchored`: to a reader deciding whether to Refresh
it is the same absence, and the per-article rows already say which pages are which.

> **Closed 2026-09-05.** That order used to read `refresh due` → `current` → `cannot verify`, so a
> Book with one measurable article and thirteen unreadable ones reported `current` — the same shape
> the cross-inspection had just closed at `-All`, one tier down. It was left open for a day because
> the per-Book reader is looking at a handful of named rows rather than a collection summary, which
> made it a judgement rather than a symmetry fix. Ruled worst-row at both tiers: an absence must
> never be reported as currency, at any scope. **Both tiers now call one function**,
> `Get-RollUpVerdict`, each passing its own vocabulary but neither choosing its own rule, so a later
> edit cannot fix one tier and miss the other — which is precisely what happened the first time.
> Held by `book-currency.roll-up-is-worst-row`, which drives the function over real count mixes
> *and* reads both call sites from the AST to confirm each still leads with `cannot verify`; the
> function cannot police its own priority, because the order is the argument.

**Per-pin isolation:** one unreachable upstream yields exactly one `cannot verify` and never
suppresses the others, because a Book routinely mixes upstreams.

**The skip is bounded on three sides, and two of those bounds were added after a cross-inspection
on 2026-09-05 found the relaxation had opened them.**

- **A claim wearing a bullet this grammar does not use is a refusal, not a skip.** `* `, `+ ` and an
  indented `- ` are all bullets to Markdown and none is the canonical form, so each fell through
  into the prose skip. That is the one shape where skipping is unsafe: a dropped *file* line leaves
  the surviving pins mapping every path still visible, `fully_mapped` holds, and the article reports
  `current` while a cited source that moved was never looked at. A bullet that `Test-SourcesClaimBearing`
  reads as a claim must parse as one or the article is malformed. Prose stays skipped, bulleted
  prose included — it carries no claim this check can measure.
- **A fenced block or an HTML comment inside the block is inert.** This one was *created* by the
  relaxation rather than merely exposed by it: while every non-bullet line was a refusal, a fence
  could never be reached, because the ``` line itself condemned the article. Skipping prose lifted
  that, and a `- Upstream ...` written inside a fence or a comment — which Markdown renders as
  sample text, not as a claim — would have been read as a live pin and could have carried a Book to
  `current` on the strength of an example.

**Prose inside a `## Sources` block is skipped, and that was a correction made against real data.**
The parser first refused any line in the block that was not a bullet, which is right for a block the
generator wrote and wrong for the ones already published: `obsidian-app`'s `pika-publish-plugin` page
opens its Sources with a hand-written paragraph naming the clone commit and saying which figures came
from the GitHub API instead. One such page made the whole article `cannot verify / malformed anchor`,
and at the collection tier one such article would have made the whole Book unverifiable — a false
alarm on 1 of 14 real pages.

### What the sixteen unparseable pages turned out to be

The migration left four Books reading `cannot verify / malformed anchor` over sixteen pages, and
whether those blocks were legitimately hand-written or the parser was wrong about them was left
open. Answered **2026-09-05** by restoring three of the four Notebook sources and reading the fourth
page by page: **both, and the sixteen split three ways.** Three rules followed, each written against
the page that produced it.

**1. A canonical file line may carry a trailing annotation.** Five pages — three of `2nd-b-vault`,
two of `basic-memory` — close a perfectly well-formed file line with a note:

```
- `raw/…/llm-config.md` - SHA-256 `819487…`; provenance: `external` (both bearer keys redacted at compile time)
- `raw/…/Docker.md` - SHA-256 `b33a41…`; provenance: `external`; **partial read** (first 120 of 364 lines)
```

Path, hash and provenance are exact in every one; only the pattern's end-anchor rejected them, and a
real cited file went unmapped while the Book reported unverifiable. **This one was a parser defect,
not a hand-written block.** The annotation must open with a separator — `;`, `,` or whitespace — so
`provenance: `external`extra`, which is a mangled field rather than a note, is still a refusal; and
an annotation carrying a claim marker is refused rather than swallowed, because two claims on one
line would otherwise lose the second silently.

**2. Prose on a canonical `- ` bullet is skipped, like prose on any other bullet.** Six pages of
`basic-memory` and one of `text-embeddings-inference-server` carry provenance notes a person wrote
before this grammar existed — `- Repository pinned at commit `976287…`, 2026-09-03.`,
`- Live deployment probed 2026-08-30: `ghcr.io/…``, `- Negative result: `grep -rn …` returned no
matches.`. The asymmetry that refused them had no reader-facing justification: `* Repository pinned
at …` was decoration while `- Repository pinned at …` condemned the article. None of them names a
URL or a ref, so none could ever have been measured, and refusing them hid the other fifteen Books'
honest answers behind four `cannot verify` rows.

**3. A block with no pin and no cited file is not a compiled article.** Seven pages —
`library-development-design-history`'s five `ai-library-port` pages, plus one each in `basic-memory`
and `text-embeddings-inference-server` — cite web links and a source tree in prose and nothing
machine-readable at all. A page with no `## Sources` block is already treated as
readable-and-anchorless; the heading alone must not make it a defect. An **upstream** recorded beside
no cited file is still malformed, because a pin's whole use is deciding which upstream a cited path
belongs to.

**What stayed strict, and it is the same rule in one place.** `Test-SourcesClaimBearing` decides
whether a bullet is a claim or prose, and both the wrong-bullet path and the canonical path call it.
It asks for a claim's markers **anywhere on the line**, not only at its opening — the first version
asked only whether the content began `Upstream ` or with a backtick, which is exactly the shape a
de-backticked file line does *not* have, so `- raw/x/a.md - SHA-256 `…`; provenance: `external``
would have been skipped as prose and its cited path dropped. Matching is **ordinal**, which is
load-bearing: `basic-memory` has a page saying *hashes computed with `sha256sum`*, and a
case-insensitive test would refuse it for saying the word.

**One page is still refused, and that is the rule working.**
`text-embeddings-inference-server/deployment-field-notes` carries
`- `raw/…/Dockerfile` - the `base` stage `ENV PORT=80`,` — prose that opens exactly like a file line.
"Opens with a backtick" marks it claim-bearing, and that is also what catches a file line truncated
before its hash. Loosening further was considered and declined on 2026-09-05: the Book reads
`cannot verify` on that one page until a Refresh rewrites it canonically.

**Where the articles come from:** `notebook/<slug>/` when it exists — the refresh source, and the
ordinary case while a Book is being worked on — otherwise an open Shelf Book's local pages. A shared
Book's pages are **not** read over MCP here; rebuild the Notebook source first. That keeps a second
MCP consumer out of this helper.

> **Covered 2026-09-08 by `book-currency.shelf-path`** (`tools/Test-BookCurrencyShelfPath.ps1`), and
> the Shelf half is the half that needed it. The pin comparison above was proved live against the
> shared collection in both directions — `current` at the tip, `refresh due` from a moved tip whose
> tree diff agreed with `git diff --name-status` over the same range — but the **Shelf branch** had
> been verified once by hand against the `holding` Book and by nothing else. A fixture exercising the
> pin comparison would have proved the shared branch again; the pin comparison is not where the two
> branches differ.
>
> What does differ is the whole scope of that suite. The Shelf branch is the **only** place this tier
> consults the Virtual Desk, and that guard has already failed in the direction nothing notices: it
> looked for `internal/virtual-desk.json`, a file this workspace does not have, so an *open* Shelf
> Book was refused as closed and the branch was unreachable. So both directions are asserted, and
> **per seat** — one Book on one disk answers differently at two seats (ADR-0015), a missing
> `.open-books` reads as every Book closed, and a Book open only as a *shared* Book does not open its
> Shelf namesake. The branch also excludes `_book.md` **and** `_index.md` where the Notebook branch
> excludes only `_index.md`, and the Notebook source wins whenever both exist.
>
> **It runs offline without shadowing a transport.** No `git` starts: every fixture article resolves
> before the network boundary, and the deepest case stops at `refused source` — a well-formed pin on
> a host the allowlist does not carry — which is what proves Shelf-read *text* reached the pin
> mapping rather than only a file listing. Falsified by reintroducing six faults one at a time (the
> gate deleted; the gate comparing a slug instead of a Book root; each exclusion dropped; the
> Notebook branch testing its directory instead of its articles; the branches swapped). Each was
> caught, and **each wrong answer was a wrong verdict rather than a missing file**, because every
> Book that must be refused carries a decoy article and the two excluded front-matter pages carry a
> malformed anchor — which outranks every other verdict in the roll-up, so reading one moves the
> Book's answer and not merely its article count.

## Fetching an upstream

```powershell
tools/Sync-RawUpstream.ps1 -Url https://github.com/obsidianmd/obsidian-help -Batch obsidian-help -IncludePattern 'en/**/*.md'
```

`-Include` takes **directories** (cone mode); `-IncludePattern` takes gitignore-style patterns
(`--no-cone`). They are separate parameters rather than one guessed from the value, because a glob
silently treated as a directory name matches nothing and looks like an empty upstream.

Measured 2026-09-04 against `obsidianmd/obsidian-help`: **2.6 MB and 2.2 seconds** for the 176 files
actually cited, against **710 MB and minutes** for the full clone sitting on disk. The source hashes
were byte-identical to the full clone's.

The helper clones into staging *outside* `raw/` and promotes by rename only if the destination is
still absent, so a killed run cannot leave a half-finished directory that the batch roster would
enumerate as a real source batch. It declares no ownership — that is the reader's to state, and
`docs/raw-batch-ownership.md` is explicit that guessing it from a directory name would be a guess
dressed as a rule — so it names the `Set-RawBatchOwner.ps1` command instead.

## The git boundary, and what actually closes it

`tools/GitSource.ps1` is the single hardened boundary. Two findings there are measured, not assumed,
and both are worth knowing before anyone simplifies it.

**The protocol flags are not what closes the transport surface.** With
`-c protocol.allow=never -c protocol.https.allow=always` set, a global config carrying
`[url "ext::<command>"] insteadOf = https://github.com/evil/` rewrites an allowlisted `https://` URL
into git's `ext` transport, which runs a shell command — the rewrite fires before the protocol policy
is consulted. What closes it is **config isolation**: `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`
pointed at `nul`, and `GIT_CONFIG_NOSYSTEM` set. The flags stay as defence in depth, and so does the
reduced `PATH` — in the probe that produced this note, git got as far as `cannot spawn cmd` because
the child's PATH held only the git installation.

**Isolation covers system and global config only.** A repository's own config still executes, so
`Test-RepositoryConfigSafe` reads `config` **and** `config.worktree` as *files* — never through
`git config`, which would resolve an include, possibly to a UNC share — and refuses the repository on
any include directive or execution-bearing key. `extensions.worktreeConfig` is deliberately **not** on
that list: `git sparse-checkout set` sets it, so refusing it would refuse every thin clone this route
makes.

**Discovery walks the filesystem before git runs at all**, and stops at the batch root. Git's own
discovery walks upward until it finds a repository, and `raw/` is gitignored inside one — so
`git -C raw/basic-memory rev-parse --show-toplevel` answers `D:/Library` and HEAD answers the
Library's own commit. Two of the three batches on disk behave that way. A pin generated from that
would name the Library's own remote on an article about something else, and look entirely plausible.
Git is invoked last, only to confirm, and a disagreement is a refusal rather than a correction.

**The environment is an allowlist, not a scrub.** Naming variables to clear cannot be closed:
`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*` inject arbitrary config, `GIT_CONFIG_PARAMETERS` does the same,
`GIT_OBJECT_DIRECTORY` redirects object lookup, and `HTTP_PROXY` is not `GIT_*` at all. The child
environment is built empty.

One cost of isolation is paid back deliberately: it also drops system `core.autocrlf`, and an
isolated `git diff --quiet HEAD` then calls a clean CRLF file **modified**. Local inspection therefore
carries `core.autocrlf` and `core.eol` back in, read with a plain `git config --get` — a value lookup
that executes nothing. Network operations never carry them and stay fully isolated.

## Host policy

Grammar and authorization are separate gates. The **grammar** is host-independent and applies
everywhere, including at capture: `https://` only, no userinfo, port, query, fragment, percent escape,
IP-literal host, dotless host or `localhost`, and no character that would break the Sources line —
backtick or semicolon included, since `git check-ref-format` accepts refs containing both.

The **host allowlist** applies wherever a network call happens — the fetch helper, the Currency check,
and the compiler — as `-AllowHost`, defaulting to `github.com`. It arrives on a command line, never
from Book or article text, so **no stored text can widen it**. That is the property that matters; it
is not a source registry, because it holds reader policy rather than a per-Book mapping.

## Which of my Books are behind? — the collection tier

```powershell
tools/Get-BookCurrency.ps1 -All
```

The per-Book tier reads articles. `-All` cannot: article text is exactly what a closed Book does not
disclose. It reads the **Discovery manifests** instead, where schema 2 now carries each Book's
distinct `(url, ref, commit_oid)` triples, and joins them against the **live catalogs** —
`shelf/_catalog.md` and the shared collection's own Catalog over MCP. Reading a catalog is browsing,
which `CONTEXT.md` keeps available while every Book is closed; no Book page is read in either
collection. `-ShelfOnly` skips the shared Catalog and says so, for a run with no NAS in reach.

**The join is against the live Catalog, not `internal/book-manifests/shared/_roster.json`, and the
difference is not academic.** That roster is written during backfill and is a snapshot: on
2026-09-04 it held 13 Books dated 2026-08-19, while the live Catalog held **18** — and `obsidian-app`,
the Book that motivated this whole feature, was one of the five it did not know about. Joining
against the roster would have made it invisible rather than unreported.

**`-All` never says `refresh due`, and never claims its pins were fetched.** A manifest holds no
cited paths, so a moved tip cannot be narrowed to *these files changed*. It reports
`upstream advanced — article inspection required` and names the `-Book` command that can answer it.
And it performs only `ls-remote`, which says what the remote advertises now and nothing about
whether the pinned commit is still fetchable — so `pinned commit unavailable` is unreachable here
and is not claimed. Capture-time verification is what closes the fabricated-pin case.

Per-Book verdicts, in the order they are decided:

| Verdict | Meaning |
| --- | --- |
| `cannot verify / no manifest` | catalogued, never backfilled |
| `cannot verify / manifest unavailable` | the store reports dirty, corrupt or incomplete |
| `cannot verify / manifest lacks anchor data` | a stored **schema-1** manifest: it lacks the field, which is not the same as lacking anchors |
| `cannot verify / malformed anchor` | a stored triple fails the grammar, **or** the Book holds pages whose `## Sources` block does not parse |
| `not anchored` | a current manifest that scanned the Book and found no git upstream |
| `cannot verify / refused source` · `source unreachable` · `source moved` · `ref unavailable` | the remote could not answer, or its host is not allowlisted |
| `current` | every pin equals the tip its ref now advertises |
| `upstream advanced — article inspection required` | at least one tip has moved |

**Absence never reads as `current`**, in any of its four shapes. The run also reports each Book's
manifest generation and how many days old it is, because "no upstream has moved" and "this was
measured three weeks ago" are different reassurances.

**The collection's overall status is the worst row, and the order is what makes that true.** It read
`upstream advanced`, then `current`, then `cannot verify` until 2026-09-05, so **one** checkable Book
outranked any number of unmeasurable ones: a collection of nineteen Books where eighteen could not be
checked and one matched its pin reported `current`. That is the one thing this tier must never say,
at the widest scope it has. The order is now `cannot verify` → `upstream advanced` → `not anchored` →
`current`, which is the same precedence already applied among the pins *within* a single Book, and an
empty collection reports `nothing to check` rather than asserting `not anchored` about nothing. Every
row is still reported individually, so ordering the summary conservatively hides nothing. Since
2026-09-05 this tier and the per-Book tier share one implementation, `Get-RollUpVerdict`, for the
reason given under the per-Book order above.

**A manifest field that is absent is not a field that says zero.** `anchor_unreadable` is validated
at the boundary that reads it, not defaulted by the tier that consumes it: an absent, negative, or
unparseable count is `cannot verify / malformed anchor`. Defaulting it to zero — which is what the
first version did for all three — converts "the manifest does not say whether every page was
readable" into "every page was readable", which is an absence reaching `current` by the shortest
route available. `Read-ManifestAnchors` also checks the body's **schema** rather than inferring it
from the field's presence, so a schema-1 body that carries the field anyway still reads as
`lacks anchor data` — a repairable absence — and never as `not anchored`, which is a positive claim
about what the Book records.

**A schema-1 manifest needs `-Rebuild`, not a plain backfill.** The source digest is over page bytes,
which adding a manifest field does not change, so a default pass reports `already current` and never
replaces it. Discovery is unaffected either way; the Currency check names the rebuild command.

One `ls-remote` per distinct `(url, ref)` across the whole collection — twelve Books citing one
upstream cost one round trip.

### What running the migration found: the listing was paginated and nobody was paging

Every Book's manifest predated the roll-up, so `-All` could only answer `lacks anchor data` until
`-Rebuild` had run. Taking the preflight for that pass on **2026-09-05** showed `game-server-admin`
holding 4 pages — against the 25 its own stored manifest, written 2026-08-19, listed. The listing had
stopped being complete at some point between those two dates.

**`list_directory` paginates, at a default page size of 10, and both callers issued one unpaged
call.** `books/obsidian-app/wiki` holds 18 items and answered with 9 files. The guard that should
have caught it — *every Book has a `_book.md`, so if it is missing the listing was truncated* — is
satisfied by any truncation that keeps `_book.md`, and `_book.md` sorts early, so it passed on a
listing missing two thirds of the Book. The one Book it did fire on,
`godot-engine-architecture-reference`, had enough subdirectories to push `_book.md` off page one:
it fired for a reason unrelated to why it was written.

Had the rebuild run against that, it would have replaced complete schema-1 manifests with truncated
schema-2 ones and quietly removed 21 of `game-server-admin`'s 25 pages from Discovery — and an
anchored Book whose moved pin lived on an unlisted page could then have read `current`.

The paging and the completeness proof now live in one place, `tools/McpDirectoryListing.ps1`, because
**`Archive-ProjectHub.ps1` had the identical defect against the identical endpoint** — guarded by
`_project.md`, which also sorts early — and that one is a *write* path: archiving a Hub of more than
ten notes would have moved the first ten and left the rest behind. Completeness is proved from
`output_format json`, where the server states `total` and `has_more` itself, by requiring the set of
distinct node identities to equal the declared total. Counting rows would not do: a repeated page
reaches the count without adding anything, which is the hole the first fix had.

**The fixture is why this survived rung 7.** The shared backfill's test double answered with a flat
row list and no pagination at all — a lookalike of the response rather than a model of it — so the
code it exercised could not fail the way the live server made it fail. Both doubles now paginate,
and `mcp-directory-listing.selftest` holds the proof.

## Rebuilding the refresh source

```powershell
tools/Restore-BookSource.ps1 -Book obsidian-app
```

A Refresh rewrites a Book's articles from `notebook/<slug>/`, and the per-Book Currency check reads
that same source. A Notebook Reset deliberately clears it — so after one, the published Book is the
only copy of what was written. This rebuilds the source from the Book.

- **Create-only, and it refuses an empty existing `notebook/<slug>` too.** A directory that exists is
  one something else may be filling; "empty, therefore mine" is a race with an `rmdir`. It takes
  `Enter-BookLock` over `notebook/<slug>` **before** inspecting for the collision and holds it
  through promotion and readback — the same lock `Compile-RawBatchToNotebook.ps1` takes over the
  same directory class.
- **The Book must be open on the Desk.** Reading its pages goes through `SharedBookSource.ps1`,
  whose header calls it the Discovery page-enumeration primitive *"and nothing else"*; requiring the
  Book open removes that question rather than deciding it. No page text appears in the output.
- **The journal is selected by the `timestamp_utc` inside it**, filtered to `state: complete`, ties
  broken by digest. The filename embeds a source digest, not a date — there are three for
  `obsidian-app` — so "newest by filename" can verify against a superseded manifest.
- **It maps through `planned_records[].source`, not `.path`.** The publisher serialises
  `@($records | Where-Object {$_.source})`, so the generated `_book.md` and `_index.md` are absent by
  construction; and `.path` is the *shared* path while `.source` is the Notebook one. The page is
  read by `path` and written to `source`.
- **A Book published from a Shelf Book has no restore route at all, and the refusal says so.** Its
  journal `source` paths sit under `shelf/<slug>/wiki/`, never `notebook/<slug>/`, so there is no
  Notebook source to rebuild — `library-development-design-history` is the standing example. Until
  2026-09-05 it was refused only as *"does not resolve below `notebook/<slug>/`"*, which is true and
  reads like a corrupt journal: it sent the reader hunting for damage in an intact file instead of
  telling them the whole class is out of scope. Held by
  `restore-book-source.canonical-source`, which drives the real validator imported from the helper's
  AST — the helper runs its Desk gate before it defines its functions, so a `-SelfTest` switch cannot
  reach them without restructuring a helper that writes real pages.
- **Completeness is proved against the journal's own external digest**, by recomputing
  `SHA-256` over `"{source}|{sha256}"` joined by newline and requiring exact equality. "Complete
  against itself" is circular and cannot detect a journal missing one record.
- **The normalisation is a loud precondition.** Each page is normalised — CRLF→LF, leading and
  trailing newlines trimmed, exactly one re-added — and hashed against the journal's SHA-256. One
  mismatch aborts with nothing promoted.
- **The rollback removes what this run promoted, and says so when it cannot.** A destination
  promoted and then found wrong was created by this run, and the lock is still held — but the lock
  keeps other *Library writers* out, not every process, so a `-Recurse -Force` sweep of the whole
  directory could take a file this run never wrote. Only the promoted records are removed, and the
  directory only if it is then empty. The removal was also error-suppressed and unverified, so a
  file held open elsewhere left a partial Notebook source behind while the message said the restore
  had been undone; a rollback that does not complete now names the directory the reader must clear.

Measured 2026-09-04 against the live `obsidian-app` Book: 15 pages restored, every one byte-exact
against the publication journal, and the per-Book Currency check then ran against the rebuilt
source — reporting all 14 articles `not anchored`, which is the correct answer for material compiled
before the pin existed.

**Corrected 2026-09-07.** The Notebook's `_master-index.md` used to be left alone here, on the
grounds that editing an existing file would put a non-create-only write inside a create-only helper,
and the result told the reader whether the topic happened to be linked. It is now **rendered**, and
that is not a widening of the helper: the master index became derived state, so re-rendering it
restates what is on disk rather than editing anything anyone wrote. The old behaviour left a restored
topic invisible in the Notebook index until someone remembered to list it by hand.

The restore also generates the topic's `_index.md` when the publication carried none — the shared
Book's own generated `_book.md` and `_index.md` have a `$null` source and are therefore absent from
`planned_records`, so a Book published from a single article restores no topic index — and validates
it **before** promotion. Promoting a topic with no index would create exactly the state the renderer
must refuse, and refuse for the whole Notebook. Detail: [Derived Indexes](derived-indexes.md).

## What is still not built

- **The `declared` kind.** A version string in a file is a different problem. Git-only is the first
  version, and a future `declared` pin would be a new line prefix, purely additive.
- **A gate check over Book articles' Sources lines.** `sources-block.selftest` proves the generator
  and the parser agree; a collection-wide invariant would fire on every imported wiki page and every
  pre-pin article, and a shared Book's pages have no migration path except a Refresh.
- **Restoring from a Book published on another machine.** The restore needs the publication journal,
  which is local. A Book whose journal is not in `internal/publication-journals/` is refused by name
  rather than guessed at.
