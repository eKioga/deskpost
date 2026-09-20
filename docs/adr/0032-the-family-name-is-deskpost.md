# The family name is Deskpost

The product family is **Deskpost**: `Deskpost` for the full product (this program, its plugin and
its workspaces) and `Deskpost Prompts` for Librarian 2.0, the prompts-only sibling. "The Library"
remains the name of the workspace a reader works in, "the Librarian" remains the voice, and Book,
Shelf, Seat, Desk, Notebook and Project Hub remain the vocabulary; `CONTEXT.md` is unchanged by
this decision.

## Status

accepted — 2026-09-19, Eric's choice, closing ruling Q6 in `PLAN-public-release.md`. Effective
from that plan's Phase B, when the public repository is created as `Kioga/deskpost`; the D: root
of Phase A is `D:\deskpost\`.

## Why

"The Library" proved too generic to talk about and collided with "Librarian 2.0" in every
conversation, so neither product could be discussed without first explaining both. Eric wanted a
name of his own, since the work had long since left Karpathy's LLM Wiki prompt it started from.
Two rules decided the shape. Every dictionary library word checked on 2026-09-19 was already
taken on GitHub — carrel, alcove, quire, folio, athenaeum, armarium, each several times — so a
single word was out. And Eric rejected the first coined list (Kathedry, Setlum, from Greek and Old
English roots for "seat") as hard to say aloud and to spell, which is friction a product name
cannot carry.

"Deskpost" is two plain words, one syllable each, spelled the way it sounds. A post is the
station one is assigned to, which is the Seat idea the product is built around; Post is also
Eric's surname, so the name is his without being a handle. Checked 2026-09-19: no GitHub
repository or handle, nothing on npm, PyPI or Homebrew, `.dev` and `.io` unregistered; only
`deskpost.com` is registered, parked, with no visible owner or use.

## Considered options

**Latin and Greek coinages (Kathedry, Setlum, Aulect, Sedrium, Hedrum).** Rejected by Eric:
precise in meaning, unpronounceable in a sentence.

**The handle as brand (Kioga).** Rejected: reads as a person, not a product.

**Renaming only Librarian 2.0.** Rejected: leaves the generic word in place.

**Readseat and Bookpost.** Clear on every registry, but each already names a consumer brand — a
European reading cushion and a literary review newsletter. Kept as fallbacks if a trademark check
turns up something against Deskpost.

## Consequences

- Repository `Kioga/deskpost`, CLI `deskpost`, root `D:\deskpost\`. Register `deskpost.dev` and
  `deskpost.io` before the public repository exists; the parked `.com` is accepted as a limit.
- Do a trademark gut-check before the first public push; the search was for collisions, not marks.
- Librarian 2.0's own repository records its rename in its own ADRs, per ADR-0009; this record
  binds only the family name.
