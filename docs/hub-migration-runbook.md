# Running the Library Development Hub's Now/Next migration

One-time procedure, written down because it needs a defined exclusive window, four writes in a fixed
order, two separate reader approvals, and a verifier that only means something if the snapshot it
reads was captured at the right moment. It exists so the next session follows a procedure rather than
reconstructing one from `PLAN-token-efficiency.md`.

The frozen spec is `PLAN-token-efficiency.md` section 2; the argument behind each decision, including
what was rejected, is in `PLAN-REVIEW-LOG-token-efficiency.md`. This file is the executable form.
Where the two disagree, the spec wins and this file is wrong.

## Who runs it

**The Librarian, with the reader present. Not a delegate.** This is not a build task. It needs the
validated reader and two `Edit-ProjectHub.ps1` writes that reach the NAS, and the two approvals are
the reader's to give in the moment. Delegating implementation work is
`docs/librarian-operation-playbooks.md`'s *Delegating implementation work* section and
`docs/model-division-of-labor.md`; a gated shared-collection write is outside it.

## State it depends on

| Artifact | Where | What it is |
| --- | --- | --- |
| Approved plan | `internal/hub-migration/migration-plan-2026-08-25.json` | The reader-approved classification of every `Now` and `Next` block. Gitignored with the rest of `internal/`, so it lives on this checkout's disk only; the table below is how it is rebuilt if lost. |
| Producer | `tools/New-HubMigrationSnapshot.ps1` | Resolves the plan against the live Hub and emits the snapshot, the verifier manifest, and the three exact write inputs. |
| Verifier | `tools/Test-HubMigrationAcceptance.ps1` | Read-only acceptance, run after the writes. |

The plan binds to the page by **exact anchor text**: each item names the first line of the block it
classifies. Any edit to `Now` or `Next` before the migration moves those anchors, and the producer
refuses rather than guessing. That is the intended behaviour — re-draft the classification instead.

## The window

1. **Acquire.** Stop or pause every other Claude and Codex session that can write this Hub, and
   confirm no writer is active. The concurrency hole is real and unfixed: `ReplaceSection` is a
   whole-page read-modify-write, and a write landing between the apply-read and the overwrite is
   clobbered despite a valid `plan_id`. There is no lock and no compare-and-swap. The window is a
   procedure, not a technical guarantee, and it is accepted as residual risk for this one operation.
2. **Hold.** Perform only the four steps below, with no unrelated work interleaved, and do not edit
   the Hub by any other route while the window is open.
3. **Verify.** Run the acceptance verifier to completion.
4. **Release.** Reopen access only after the verifier reports clean.

If a concurrent write is discovered mid-window, stop and reconcile explicitly. Do not re-apply a
`plan_id` issued before the discovery.

## Step 0 — capture, inside the window

The snapshot records the destination page's exact byte length and prefix hash, so **it is only valid
until the next write to that page.** Capture immediately before step 1, never earlier.

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/New-HubMigrationSnapshot.ps1 -Plan internal/hub-migration/migration-plan-2026-08-25.json -OutputDirectory <temp-dir>
```

`<temp-dir>` is a caller-chosen temporary directory outside the workspace. The snapshot and manifest
are migration scaffolding, not Library material; they are not committed, and `output/` is forbidden
for test evidence. It writes five files: `snapshot.json`, `manifest.json`, and the three write inputs
`append-content.md`, `now-content.md`, `next-content.md`.

The producer refuses, rather than producing a snapshot that would fail later, if the plan leaves any
block unclassified, if an anchor matches zero or more than one block, if a block index has moved, if
a closed item is already present on the destination page, if an entry would stay open without a
status marker, or if the simulated final body would not pass `Edit-ProjectHub.ps1`'s own `Now` guard.

**Read `now-content.md` and `next-content.md` before going on.** They are exactly what the two gated
writes will put on the page.

## Step 1 — append to the history page

Additive, so it applies directly with no gate.

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/Edit-ProjectHub.ps1 -ProjectSlug library-dev -Page notes/library-dev-history-2026-08-part-2 -Mode AddSection -Section '<destination_heading from the plan>' -ContentPath <temp-dir>/append-content.md
```

Destination is `part-2` unconditionally. History pages are append-only with no size limit
(`docs/project-hub-design.md`), so a size-based `part-3` would contradict the design and make the
destination nondeterministic.

## Step 2 — read the append back

Read the page through the validated reader and confirm the new section is present and the previous
content is intact **before** issuing any removal. The append and the removals are separate operations
bound only by ordering, readback, and the manifest's zero-pre-count precondition; there is no
destination binding in the `plan_id`.

## Step 3 — `Now`

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/Edit-ProjectHub.ps1 -ProjectSlug library-dev -Mode ReplaceSection -Section Now -ContentPath <temp-dir>/now-content.md -Preflight
```

Show the reader the before and after with the returned `plan_id`, then rerun with
`-UserConfirmed -ApprovedPlanId <that exact plan_id>` after one clear yes. Read the section back.

## Step 4 — `Next`, with a fresh preflight

The `plan_id` hashes the **entire page body**, so applying `Now` invalidates any `Next` `plan_id`
issued beforehand. Issue the `Next` preflight only after step 3 has applied.

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/Edit-ProjectHub.ps1 -ProjectSlug library-dev -Mode ReplaceSection -Section Next -ContentPath <temp-dir>/next-content.md -Preflight
```

Same approval shape, then read back.

## Step 5 — acceptance

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/Test-HubMigrationAcceptance.ps1 -Snapshot <temp-dir>/snapshot.json -Manifest <temp-dir>/manifest.json
```

Read-only. It reads all post-migration state through the validated reader, never by direct file
access, so it measures what a reader actually receives. It exits non-zero on any failed assertion and
also runs `tools/Invoke-LibraryChecks.ps1 -IncludeShared`, requiring zero failures.

**A smaller page that lost an open item is a regression, not a win.** The assertion that catches a
removal nobody named is `expected_post`: a block dropped from `Now` or `Next` that the manifest never
mentioned satisfies both "manifest items are absent" and "open items survive", and only the approved
expected body detects it.

## If something fails

- **The producer refuses.** Read the message; it names the block and the reason. Do not edit the plan
  to make a refusal go away without understanding which of the two moved, the page or the plan.
- **A preflight will not issue, or a `plan_id` is rejected on apply.** The page changed under you.
  Close the window, find the writer, and start again from step 0 with a fresh capture.
- **The verifier fails after the writes.** It is read-only, so a failing run costs nothing but the
  reading. `destination_prefix` failing means the history page lost content. `expected_post` failing
  means a section does not match what was approved. Reconcile explicitly; do not re-apply.
- **Partial completion.** On a retry the batch is accepted only if **every** manifest block is
  already present in the destination **exactly once**. Any partial or multiple presence stops for
  reconciliation rather than appending again.

## The approved classification, 2026-08-25

Kept here so the plan file is rebuildable if this checkout's `internal/` is lost. `Next` needed no
judgement — every entry already carried the reader's own marker, so `[x]` closes and `[ ]` stays.
`Now`'s 30 blocks, in page order:

| Block | Call | Entry |
| ---: | --- | --- |
| 1 | open, mark | Codex Desk hook should advertise the validated-reader capability |
| 2 | closed | 2026-08-22 raw-to-Notebook implemented; open tail carried by `Next` |
| 3 | closed | 2026-08-20 cross-harness portability implemented |
| 4 | closed | Plugin decision: do not adopt one now |
| 5–10 | orientation | active development · where the plan stands · Shelf inventory not recorded here · "What this section is." · "Three standing facts" · "What follows is open items only" |
| 11 | open, mark | 1.3's topic-index path is sandbox-tested, not live-tested |
| 12 | open, mark | Three meter limits — the entry states they are why it stays in `Now` |
| 13 | open, mark | Second delegate viable; three things settled, two not |
| 14 | closed | `dsh` intended destination, not yet delegate — superseded by 17 |
| 15 | closed | CORRECTION to the `dsh` revisit trigger — superseded by 17 |
| 16 | open, mark | Reasonix integration missing its bottom half |
| 17 | closed | `dsh` adopted, runtime layer exists; residual carried by 13 and 16 |
| 18 | closed | A delegate describes its sandbox, not the host |
| 19 | open, mark | `_helpers.json` cannot describe a non-PowerShell helper |
| 20 | open, mark | Shared archive — two of four faces closed, two not |
| 21 | closed | Shelf-writer helpers exercised live; both defects fixed |
| 22 | open, mark | Two standing Shelf-archive limits |
| 23 | closed | Shelf-to-shared publishing built and proved end to end |
| 24 | closed | "The Shelf is a staging area, not storage" — principle survives in `shelf-lifecycle.md` |
| 25 | closed | Shelf-to-shared live acceptance complete |
| 26 | closed | Batch Shelf exits ready for preflight — superseded by 27 |
| 27 | closed | "Shelf exit state." — completed batch record |
| 28 | closed | "Reader acceptance." |
| 29 | closed | 2026-08-21 token-efficient dev is next — superseded |
| 30 | open, mark | Route "reset my workspace" through the Library Reset contract |

"mark" means the surviving entry gains `- [ ] `. This is not cosmetic: the survivors are currently
unmarked, and `Assert-NowStructure` validates the **complete proposed section**, so a `Now` that
still held an unmarked entry would make the migration's own gated `ReplaceSection` refuse it.

Two calls the reader confirmed explicitly rather than by default, both recorded because a later
reading may want to challenge them:

- **Block 24 moves.** It is durable design intent followed by two paragraphs now superseded by the
  completed Shelf exit, one of which names a live acceptance that has since happened. The principle
  survives the move: it is the title and line 24 of `docs/shelf-lifecycle.md`, which the entry itself
  names as the authority, and `AGENTS.md` opens with a pointer there.
- **Block 27 moves.** `PLAN-token-efficiency.md` lists `**Shelf exit state.**` among the non-bullet
  prose that must still write, but that sentence constrains the *parser* — prose must not be refused
  — not the classification. It is a completed batch record carrying derived state.

## Expected result

Measured on a live read-only dry run, 2026-08-25: `_project` goes from 88,661 to 57,952 bytes,
roughly 22,165 to 14,488 estimated tokens at `chars/4`, a 34.6% reduction. The spec predicted about
47% on an estimate of ~4 surviving open items in `Now`; the approved manifest keeps 9, which is the
whole difference. `chars/4` is not a tokenizer — it ranks and shows direction, and no acceptance
criterion depends on its absolute accuracy.

**Both numbers move with every write to the Hub, so treat them as a direction rather than a target.**
An earlier dry run the same day read 86,981 to 56,271, and the only thing between them was appending
the `Next` entry that points at this file. Re-run the producer for a current figure; do not reconcile
against a figure recorded elsewhere.
