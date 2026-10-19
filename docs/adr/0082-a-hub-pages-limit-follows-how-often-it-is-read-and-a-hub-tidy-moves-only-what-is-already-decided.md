# ADR-0082: A Hub page's limit follows how often it is read, and a Hub tidy moves only what is already decided

**Status:** accepted
**Date:** 2026-10-16
**Effective from:** the release that carries s125
**Amends:** [ADR-0013](0013-a-hub-section-holds-only-what-the-project-can-close.md)'s single page budget (40,000 bytes
for every Hub page), which becomes the every-session limit
**Relates to:** `PLAN-tidy-redesign.md` (Part A, the kernel), `docs/library-rules.md` rows U1 and U4, and the glossary's
**Tidy**

## Context

A Project Hub's `_project` page, and its `connections` page where one exists, is read on every return to the Hub, by
every seat. ADR-0013 measured what keeping it small saves: a 52% cut to that read. Every other Hub page (a `backlog`, a
design queue, release notes) is read only when a seat asks for it, and costs nothing while it is not read. One 40,000-byte
limit for both kinds made an on-demand page's warning a duty with no saving behind it.

Keeping `_project` small was done by hand. From 2026-10-03 to 2026-10-16 deskpost-desk tidied its Hub fifty-seven
times, each with a new page, a preview and an apply per section, a proof script written for the session and one or more
yeses. Almost every move was the same: ticked items leaving `## Now` and `## Next`. The size the dashboard showed was
inferred from whatever `hub edit` output a hook happened to see, and twenty Reports traced to that inference.

## Decision

1. **A Hub page's limit follows how often it is read.** `_project` and `connections` at the Hub root are
   **every-session** pages, limited to 40,000 bytes. Every other page is **on-demand**, limited to 56,000. `notes/`
   pages and the `limits` page stay exempt. The table is `PAGE_SIZE_LIMITS` in `kernel/src/hubedit.ts`; `hub edit`'s
   page warning reports the page's `kind` and that kind's limit as `threshold_bytes`. The on-demand figure is
   provisional: it is the size one reader call returned whole on 2026-10-07, a readability floor, not a token budget.
2. **The Desk measures; nothing infers.** `library desk` reports `hub_pages[]` for each Hub open at the seat in a
   local collection: each non-exempt page's kind, size, limit and whether it is over, and for `_project` the number of
   ticked top-level items in `## Now` and `## Next`. It returns names and numbers, never page text. A Basic Memory
   Library gets `null`, so a Desk call never makes a network read per page.
3. **A Hub tidy moves only what is already decided.** `deskpost hub tidy <slug>` moves the ticked top-level items of
   `## Now` and `## Next`, each whole with its nested lines, and with `--section` a whole section the seat names. It
   refuses `--section` for Purpose, Now, Next and Decisions, and for any section still holding an unticked item. It
   never ticks an item, rewrites a line or deletes anything: every line it takes off the page is on a new history page
   (`notes/<date>-<word>-history-tidy-<n>`), word for word. The Desk's count and the verb's selection are one function,
   so the Desk never counts what the tidy would not move.
4. **The kernel proves it.** The preflight runs the proof over the proposed bodies and reports `proof: passed`, bound
   to its plan id; the apply runs it again over what it reads back. The proof is a multiset check over non-blank lines:
   every removed line is on the history page as often as it was removed, and the only lines the page gains are the
   new pointers. Both files are written under the Hub's lock and one journal, and a failure restores the page and
   removes the history page, or says `recovery-required`.
5. **One pointer per section, pages chained.** Each shortened section keeps one paragraph naming the newest history
   page. The next tidy of that section replaces it and carries the old line onto its own history page as `Replaced
   pointer: ...`, so the proof needs no exception. Each history page links the one before it. The kernel recognises its
   own pointer only as a standalone, unfenced paragraph of the exact form whose link names an existing history page.

## Consequences

- A seat moves decided items with one preview and one apply, and the reader's yes covers a plan whose proof the
  kernel ran; no session writes a proof script.
- A ticked item ticked by mistake goes to history; the history page and the journal hold it word for word.
- Lines that stay and still name a moved item or section are listed as `dangling_references`; repointing them is the
  seat's, with `replace-item`.
- The PowerShell oracle `tools/Edit-ProjectHub.ps1` is frozen
  ([ADR-0028](0028-the-kernel-is-typescript-shipped-as-one-binary.md)) and keeps its one limit; a compared
  preflight's new `kind` field and the Desk's `hub_pages` are kernel-only.
- The mod half (deskpost-mods reading `hub_pages` instead of `hub edit` output, and `/tidy` asking for `hub tidy`)
  waits for the release that carries this.
