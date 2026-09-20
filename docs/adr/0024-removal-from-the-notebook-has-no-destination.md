# Removal from the Notebook has no destination; Triage keeps only ever adding

`PLAN-notebook-drain.md` deferred its item 1 — a `drain` kind that would copy a Notebook article to a
durable destination and remove the source — behind two open questions.

**D1: what does *removal from `notebook/`* mean?** `tools/TriagePlanCommon.ps1:81` refuses
`notebook → discard`, and its reason is that a Reset **quarantines** rather than deletes, so a
notebook discard "is strictly worse than the reset, destroying what the reset would have kept
recoverable" ([Library Triage Design](../library-triage-design.md), the matrix section, corrected
2026-09-10). That reason is about *deletion*. It appeared to leave a gap: if removal **quarantined**
instead, nothing would be destroyed, the 2026-09-10 objection would not apply, and the `:81` refusal
would never have covered the case.

**D2: does removal belong in Triage at all?** `CONTEXT.md` defines **Graduate** as *"Moving material
out of the Notebook to somewhere a reset cannot reach"* while **Triage** *"only ever adds"*.

**The gap does not exist, and the reason is stronger than the one at `:81`.** Every place a removed
Notebook article could go is refused by a standing position, and the three positions are
independent of each other. Deletion is refused by the 2026-09-10 argument. The quarantine is refused
by its own definition — and, separately, is structurally unable to return what a drain would put in
it. A new local store is the Notebook archive this Library has refused on three surfaces. **The
refusal at `:81` is upheld and its reason widens**: not merely that removal would be worse than the
reset, but that there is nowhere for removed material to go.

**Item 1 is closed, not deferred.** Triage keeps its "only ever adds" property, and the verb that
names moving material out of the Notebook is **Reset**, which is the operation built to do it
recoverably.

## Status

accepted — 2026-09-15. `PLAN-notebook-drain.md` item 1, ledger row 8. Settles D1 and D2; no code
implements a `drain`, and `$script:TriageSourceKinds` is unchanged.

**No part of this argument cites [ADR-0023](0023-idleness-authorises-a-sweep-retirement-still-gates-whole-tree.md).**
That decision kept itself deliberately clear of D1 in both directions and said so in its own *What
this deliberately does not decide* section, so that this question would be inherited whole. Its
recoverability premise in particular is why a reset is safe to *offer* and is not load-bearing here.

## Where a removed article could go, and why each is refused

A drain must put the article somewhere. There are four candidates and the list is exhaustive.

**1. Destroy it.** Refused by the 2026-09-10 position, which was re-derived after its original
premise expired and upheld with a better reason. `notebook/` is volatile, but a Reset moves its
topics into a recoverable quarantine rather than deleting them, so a Triage discard is not "delete it
now rather than at the reset" — it destroys what the reset would have kept, inside the one helper
whose purpose is losing nothing. Two gate assertions pin that reason as the refusal's required text
(`tools/Test-ShelfNoteBoundary.ps1`, `tools/Test-LibraryHelpers.ps1`), so a revert goes red.

**2. Move it to the reset quarantine.** Refused by what the quarantine *is*.
[Notebook and Desk Model](../notebook-and-desk-model.md): *"There is deliberately no local
Notebook-archive folder, and the quarantine is not one: it is a recovery route for material a reset
has already moved, not a place to file things on purpose."* A drain filing an article there is
filing on purpose — the sentence's own excluded case. The same passage names what a reader who wants
to retain material does instead: a local Shelf Book, a shared Library copy, or an active Project
Hub. That is what Triage already offers, without removing anything.

This is the reading D1 existed to test, and it also fails for a second, independent reason — below.

**3. A new local store built for the purpose.** This is the local Notebook archive, refused as
standing guidance on three surfaces: [Notebook and Desk Model](../notebook-and-desk-model.md)
(twice), the Reset section of [Librarian Operation Playbooks](../librarian-operation-playbooks.md)
(*"Do not offer a local Notebook archive"*), and the `library-help` Skill's retention-and-reset
reference. Founding a drain on a new store would reverse that guidance as a side effect of adding a
Triage kind, which is the wrong place to reverse it.

**4. Leave it where it is.** What the code does today, and what `:81` already calls *"the honest
fifth option."*

## Why the quarantine reading fails structurally, not only by definition

Candidate 2 is worth defeating twice, because a reader who found the definition merely rhetorical
would reach for it again.

**A quarantine is addressed per topic; a drain is per article; and the restore refuses the
collision a drain always creates.** `tools/Restore-NotebookQuarantine.ps1` tops out at `-Topic`, and
before restoring one it checks whether that topic exists in `notebook/` again:

> `a topic of that name exists in notebook/ again, and a restore never writes over newer material;`
> `move or merge it by hand`

A drain removes an **article**, not a topic, so the topic it came from is still in `notebook/` —
that is the normal case, not an edge. The article's only recovery route is therefore refused the
moment it is needed. Calling such a removal "recoverable" would be false exactly where a drain
operates, and the refusal is correct: a restore that overwrote newer material would be the worse
bug.

Two further properties compound it. The quarantine has **no age-out** and its purge is manual and
terminal, so a drain would grow a pile nothing retires, holding single articles the restore cannot
address. And a quarantine's recorded owners live only in its `reset-journal.json` — a record the
reset writes as part of the move. A Triage action writing into someone else's quarantine stamp, or
minting its own, would be a second writer of a record whose single writer is what makes it
trustworthy.

## D2 — the verb already exists, and it is not Triage

`CONTEXT.md` is the authority on what these words mean, and it already separates the two acts.

**Triage** *"only ever adds, apart from discarding one Holding Shelf note, which is named, bound, and
separately approved."* That exception is scoped to the Holding Shelf and justified by the Holding
Shelf's opposite property: it **survives a Reset**, so leaving a note there is a durable commitment
and discarding it means something. The Notebook is the buffer a Reset empties. The exception does not
generalise from the durable buffer to the volatile one; it was granted *because* the buffer is
durable.

**Graduate** is *"Moving material out of the Notebook to somewhere a reset cannot reach."* What makes
material graduated is **the durable copy existing**, not the Notebook copy vanishing — and the
Notebook copy's departure is the Reset's job, which now carries the quarantine, the journal, the
ownership record, the `plan_id`, and (since
[ADR-0022](0022-reachability-names-the-destination-class.md)) per-topic evidence of what already
exists durably elsewhere. Read that way, Graduate and Reset between them already describe the
reader's model of the Notebook as an airlock that empties as a side effect of working. Nothing is
missing for Triage to supply.

**The wording of Graduate is left exactly as it is, deliberately.** "Moving" can be read as promising
that the source disappears, and that reading is plausibly what made a `drain` kind look like a
missing feature. It is recorded here rather than repaired because the entry is correct at the level
it describes — the reader-level act, whose test is that a reset can no longer reach the material.
Tightening it to "copying" would make the glossary describe a mechanism instead of an outcome, and
the next reader would have to re-derive why the Notebook copy is nobody's problem.

**Per [ADR-0015](0015-the-desk-is-per-seat-one-library-many-seats.md), the glossary moves before the
code either way. This decision requires no glossary change**, because it confirms both entries as
written. Had it gone the other way, `CONTEXT.md`'s Triage entry would have had to lose "only ever
adds" first — which is the scale of change a drain actually implied, and is worth stating so the
cost is not rediscovered as a surprise.

## Considered options

**Found a `drain` on a quarantining removal.** The reading D1 was written to test, and the one with a
real case: nothing is destroyed, so the 2026-09-10 argument genuinely does not reach it. Rejected on
the two grounds above — the quarantine is defined as a reset's residue rather than a destination, and
its restore route cannot return a single article to a topic that still exists.

**Found a `drain` on deletion, arguing the Notebook is volatile anyway.** Rejected. This is the
argument that was already refuted on 2026-09-10 and is pinned by two gate assertions.

**Build the safety apparatus first, then decide.** The honest version of "yes": before any removal
could be safe, the six findings in the plan's item 1 would each need an answer. Rejected because the
first of them is not a gap to fill but a property that does not exist anywhere in the codebase.
**No destination verifies that what landed matches the source.** `tools/Add-ShelfBookPage.ps1` does
read its page back and compare — but against `$pageBody`, the *rendered* body produced by
`ConvertTo-ShelfPageBody`, which injects a title and strips frontmatter. That readback proves the
disk matches what the writer meant to write; it says nothing about whether the destination preserves
the source. Only the `notebook` destination binds source bytes. A removal predicated on "the copy is
safe" would be predicated on a check that does not make that claim, and building source-to-
destination content binding across three child writers is a larger piece of work than the kind it
would support.

The remaining five stand unchanged and are recorded in the plan: Triage has no rollback, and a
write-succeeded / delete-failed against a Shelf Book is permanently unrecoverable by retry because
`Assert-WriteSetWritable` then refuses the destination as existing; both seat gates are keyed on the
literal string `'notebook'` (`tools/Invoke-LibraryTriage.ps1`), so missing either removes another
seat's material with no claim and no ownership check; a folder source drags `_index.md`, and a topic
directory without one makes the master-index render refuse **workspace-wide**, for every seat; a
drain is structurally `remove_source: true` — a third axis — rather than a kind, in a codebase that
branches strictly between delegated and inline actions; and `Assert-TriageWriteSetsDisjoint` compares
write sets against write sets and delete sets against delete sets, but never a delete set against
another action's **source manifest**, so it cannot see the conflict a drain introduces.

**Close item 1 and keep Triage additive.** Accepted.

## Consequences

**`tools/TriagePlanCommon.ps1` is unchanged except for a citation.** The matrix, the refusal, and
`$script:TriageSourceKinds` all stand. The refusal's reason gains a pointer to this ADR, because the
reason as written answers deletion only, and a reader meeting it at the point of use is exactly the
reader who will otherwise ask D1 again. The two gate assertions pin the substring
`'quarantines notebook/'`, which the append preserves.

**The plan's item 1 is closed rather than deferred, and `Y` stays 9.** It becomes no new row, no new
plan, and no work this plan carries. D1 and D2 are settled here.

**A future proposal to remove from `notebook/` must answer the enumeration, not the `:81` message.**
The four candidates above are the whole space. A proposal that does not name which one it takes, and
what changed about the position refusing it, has not engaged the question.

**What is *not* claimed:** that removal from the Notebook is a bad idea in principle. The reader's
model — an airlock that empties as a side effect of working — is right, and this plan's rows 2 to 7
serve it through the operation that already owns removal. If the Library ever gains a durable,
age-aware, per-article local store with a recovery route that matches its granularity, candidate 3
becomes a live question again, and this ADR is what it amends.

## What this deliberately does not decide

**It does not decide anything about the Reset's own scope.** Whose topics a reset may take is
ADR-0016's question, amended once since; this decision concerns only what a *Triage* plan may do to
`notebook/`.

**It does not rule on `holding → discard`.** That exception is unaffected and its justification —
the Holding Shelf survives a Reset — is the reason the Notebook case comes out differently.

**It does not change how `Graduate` is worded**, and says above why the observed looseness is left
alone rather than repaired.
