# Shelf Books accept new pages when open

Until now every Shelf Book was create-once: `Publish-BookCopy.ps1` refuses an existing destination,
and only a Book marked `Kind: capture` could be appended to. That made "graduate this to the Godot
Book" impossible, so the only moves available were creating yet another Book or dumping the material
on the Holding Shelf — which is how the Shelf reached twelve Books with four documented, unresolved
overlaps. We are making any Shelf Book able to accept new pages, gated on that Book being **open on
the Desk**.

## Status

accepted — 2026-08-17

## Considered options

Leaving the Shelf create-once and letting the Holding Shelf absorb everything was the alternative.
It preserves the `Kind: capture` protection exactly, but it is the status quo that produced the
duplication, and it makes "graduate to a Book" a euphemism for "file it somewhere else and hope."

## Consequences

The open-Desk requirement is what replaces the `Kind: capture` protection, and it is deliberately the
Library's existing idiom: capture is ungated because it is unvetted material going somewhere
disposable, while triage already requires an open Book because naming an individual note is a
curatorial act. Adding a page to a curated Book is curatorial, so the reader must have deliberately
opened it. The write itself stays additive, so it cannot lose text and applies directly once the
Book is open.

Raw material can still never reach a curated Book by accident, because `Add-ShelfNote.ps1` continues
to refuse any Book not marked `Kind: capture`. The two paths stay distinct: capture is ungated into
disposable Books, graduation is deliberate into open curated ones.
