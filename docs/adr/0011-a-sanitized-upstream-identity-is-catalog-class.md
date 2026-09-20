# A sanitized upstream identity is catalog-class

A Book's Discovery manifest — the closed-readable record every Book contributes while every Book is
closed — now carries `anchored_upstreams`: the distinct **`(url, ref, commit_oid)`** triples its
articles record in their `## Sources` blocks, plus `anchor_unreadable`, a count of pages whose
Sources block did not parse. Manifest body schema goes to **2**.

Nothing else from the pin crosses. The `repo root` and the `captured` date stay in the article.

## Status

accepted — 2026-09-04.

Extends ADR-0002, which authorises **summaries, reader maps, page titles and headings** as
catalog-class. A repository URL is none of those, so this needed deciding rather than assuming.

## What this is for

`tools/Get-BookCurrency.ps1 -All` answers *which of my Books are behind their sources?* across the
whole collection. Without a roll-up the question is answerable one Book at a time, because the pin
lives in article text and article text is exactly what a closed Book does not disclose. With it, the
answer is one `ls-remote` per distinct upstream over both collections.

The place it lands is already the right shape. `BookManifest.ps1` holds every page's full text at
generation, for shared Books as well as Shelf ones, so extracting the triples is a pass over work
already being done. The manifest is written into `internal/book-manifests/`, a **local** record that
`BookManifestTransaction.ps1` already rewrites under the Book's own lock. Nothing on the NAS is
written and no shared-Book editor is needed, which is what let this ship at all — the deferred design
had it blocked behind one.

## Why an upstream URL is provenance about a Book, not content from it

ADR-0002's boundary is not "metadata may cross and content may not". It is that **naming a thing can
be reading it** — which is why a capture Book's note titles are withheld while its counts are not.

A repository URL fails that test in the reader's favour. It is not something the Book says; it is
where the Book came from. The Book already publishes it in its own article text, in a `## Sources`
block written to be read. And it describes an artefact outside the Library entirely — a public
repository — rather than anything the reader wrote.

The strongest counter-argument is the honest one: **a URL is more identifying than a heading.**
`https://github.com/acme-internal/payroll-notes` discloses a subject that "Payroll" in a heading
might not, and it discloses it to anyone who can read the manifest path. That is real, and it is why
this is a decision rather than an extension.

Three things bound it, and together they are why the answer is yes:

- **The capture exclusion covers it at generation, not at query.** A capture Book — the one place
  the Library holds material a reader has not vetted for disclosure — returns from
  `New-BookManifestFromPages` before the anchor scan runs at all, so its manifest carries an empty
  set and a zero count whatever its notes hold. The self-test's leak canary asserts that against a
  fixture whose capture note **does** carry a pin, which is the acceptance pattern ADR-0002 records
  for the counts-only rule.
- **A curated Book is material the reader chose to publish.** Every Book that is not capture-kind
  reached the Shelf or the shared collection through a deliberate write.
- **The narrowest useful field set, not the convenient one.** See below.

## What is deliberately left out, and why

**`repo root` is producer-local.** It names a directory on the machine that compiled the article —
`raw/obsidian-pika/batch1/repo` — which says something about the compiling workspace and nothing the
collection tier can use. That tier holds no cited paths, so it has nothing to map onto a root. Left
out.

**`captured` is the article's business.** The collection tier reports the manifest's own
`committed_utc` instead, which is the age of *the measurement it is making*. The article's capture
date answers a different question and is one more page-derived value on the wire.

**The URL is normalised before it is stored**, through the same `ConvertTo-NormalisedUpstreamUrl`
the fetch and capture paths use: `https://` only, no userinfo, port, query, fragment, percent
escape, IP-literal host, dotless host, or any character that could break a rendered line. A stored
triple is re-validated on read by the same rule, because a manifest is a file on disk and its reader
cannot know which version wrote it.

## Considered options

**Hold the roll-up outside the manifest, in a separate local index.** Rejected. It would be a second
record of the same fact, needing its own writer, its own lock, and its own staleness story, and
`docs/raw-batch-ownership.md` already names two authorities on one question as the drift this
codebase keeps paying for. The manifest is regenerated under the Book's lock whenever the Book
changes; a side index would have to be too.

**Store the whole pin line verbatim.** Rejected. It is less work and it crosses more: the repo root
and the capture date would ride along for no consumer.

**Store a hash of the upstream identity instead of the identity.** Rejected. A hash cannot be
`ls-remote`d, which is the entire point, and the collection tier would then have to open every Book
to learn what to contact.

**Leave `-All` unbuilt and answer one Book at a time.** This was the shipped state, and it is a
defensible one — the per-Book tier is complete and needs no manifest change. Rejected because the
question a reader actually asks is *which of my Books are behind?*, and answering it by opening
nineteen Books in turn is the discovery problem ADR-0002 exists to solve, in a new costume.

## Consequences

**Schema 2 does not require a regeneration sweep to stay functional.** Neither `BookManifest.ps1`
nor `BookManifestStore.ps1` validates the manifest *body's* schema, so a stored schema-1 generation
keeps answering Discovery exactly as it did. The store's own `current.json` schema is a different
number and deliberately did not move: bumping it would have read every stored pointer as corrupt and
made the whole Shelf unavailable until a rebuild — the day-one-data failure this workspace has hit
before.

**But a plain backfill will not upgrade one.** The source digest is over page bytes, which adding a
manifest field does not change, so the default pass reports `already current`. `-Rebuild` is what
lands the new field, and the Currency check's `manifest lacks anchor data` verdict names the command.

**`anchor_unreadable` is not decoration.** A page whose `## Sources` block does not parse contributes
no triple. Without the count, a Book with one broken article and one good one would report `current`
at the collection tier while the per-Book tier reported `cannot verify` — the two tiers
contradicting each other in the direction that reassures. A count discloses nothing about what was
counted.

**Discovery is untouched.** It reads kind, pages, headings and the reader map, none of which moved,
and it never reads the new field. `Get-DeskOverview.ps1` is untouched too: its promise that no Book
or Project page content was read stays literally true, and the network access stays inside a helper
the reader deliberately invokes.

The record of the whole route is [Compiling and refreshing a Book from a git URL](../book-currency-anchoring.md).
