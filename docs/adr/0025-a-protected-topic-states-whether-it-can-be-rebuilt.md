# A protected Notebook topic states whether it can be rebuilt, and the preflight says what will remain

A reader asked seat `2nd-b-vault-dev` to empty their Notebook on 2026-09-15. The widest scope the
reset offers set aside two topics of four, they closed their other sessions and ran it again, and
one topic still remained. Their words for the experience were that it is *"like pulling teeth"* for
a store the Library documents as **volatile working knowledge**.

Nothing malfunctioned. `notebook/orca-ide` was declared `excluded`, `tools/NotebookOwnership.ps1`
sorts `shared` and `excluded` into `protected` before any scope switch is consulted, and no seat's
reset at any scope takes a protected topic. Every rule fired as written.

**Two things made a correct system behave like a broken one.**

## The declaration was protecting something that did not need protecting

`notebook/orca-ide` was declared `excluded` at `2026-09-15T12:29:57Z` because it is a published
Book's refresh source. That reading was checked against
[the Reset playbook](../librarian-operation-playbooks.md) and against the topic's own `_index.md`,
and it survived a Report Inbox triage the same day, which concluded the shield was the point.

It was not. `tools/Restore-BookSource.ps1`'s own header says the opposite in as many words:

> A Notebook Reset is the ordinary way it goes: the Reset deliberately clears working knowledge, and
> the published Book is then the only copy of what was written. This rebuilds the source from the
> Book, against the publication journal that recorded what was published.

The helper is **create-only and ungated** precisely because it cannot lose text. A reset clearing a
published Book's source is the case it was written for. The declaration converted a recoverable
deletion into an unreachable topic, and it did so on the one topic in the workspace that had the
strongest recovery route available.

**The failure was not the declaration; it was that nothing made the declaration answerable.** An
`excluded` row is a written assertion that something is precious, and no surface asked whether it
still was. Three separate readings — the declaring session, the triaging session, and the reader's
own — all reasoned from the declaration's existence rather than from whether it was still earned.

## The preflight could not answer the question the reader asked

`Reset-LocalNotebook.ps1` reported what it would **take** and never what would be **left**.
`remaining_in_notebook` answers exactly that and is post-run only, so a reader learned that topics
had survived after approving the operation that was supposed to remove them.

The fields to add up by hand are also not a fixed set. The classification lists **overlap**
`targets` by design: a swept foreign topic is in `foreign` *and* `targets`, and under `-WholeTree` a
retired one is in `retired` *and* `targets`. Any hand-assembled leftover set is therefore wrong at
two of the three scopes, and wrong in the direction that over-reports what survives.

## Status

Accepted 2026-09-15.

## The decision

**A reset's preflight states what will remain, and it derives that by subtracting the target set
rather than by adding up the other lists.** `predicted_remaining` mirrors `remaining_in_notebook`
field for field, so the prediction and the outcome are readable against each other in the way
`open_books_advisory` and `open_books_after` already are. It carries `notebook_will_be_empty`,
which is the question a reader asking for an empty Notebook is actually asking.

**A protected topic carries evidence about its own recoverability, and only a protected topic
does.** Every other reason a topic stays is answered by an action the reader can take — close that
session, retire that seat, map that topic. `protected` is the only one whose remedy is undoing a
declaration somebody made deliberately, so it is the only one where the reader needs to know what
that declaration is protecting. `protected_recoverability` reports, per topic, whether a completed
publication journal names a Book of that slug.

**It reports evidence, never a verdict.** `Get-NotebookTopicJournalEvidence` says a completed
journal exists and names the route. It does not say a restore will succeed: `Restore-BookSource.ps1`
additionally requires the Book **open on the Desk**, refuses any existing `notebook/<slug>`, and
aborts the whole run on one page-hash mismatch. A reader acts on this field destructively, so
promising more than was checked is the specific failure to avoid.

**It is not a second copy of the journal selector.** `Restore-BookSource.ps1` picks the journal with
the greatest `timestamp_utc` among those whose `state` is `complete`; the evidence function keys on
those same conditions to **count** them and stops. Which journal wins is the restorer's ruling, and
re-deriving it here would be a lookalike free to disagree with the real one.

## Considered options

**Widen a reset to reach `excluded` topics.** Rejected as the *general* rule, and it is the shape
the first report proposed. An `excluded` topic with no publication journal is the only copy of its
material, and a scope that reaches it destroys the thing the declaration exists for. The problem was
never that `excluded` is unreachable; it is that nothing said whether a particular declaration was
still earned.

**Derive protection instead of declaring it — let a rebuildable Book source be swept regardless of
its row.** Rejected, and it is what this ADR was first drafted as. A derivation that overrides an
explicit human declaration silently ignores the reason someone wrote it down: a topic declared
`excluded` as a long-running scratch space would become reachable the moment its slug happened to
match a published Book. The declaration stays authoritative; what changes is that it now has to
survive being looked at.

**Report recoverability for every remaining topic, not just protected ones.** Rejected as noise. The
other reasons name their own remedy already, and a recoverability row against a topic whose seat is
merely busy invites a reader to destroy recoverable material rather than wait ten minutes.

## Consequences

A reader who asks for an empty Notebook is told before approving whether they will get one, which
topic stands in the way, and whether that topic can be rebuilt if they decide to lift its
declaration. A session that reaches for `excluded` has a field that will later be read back at it.

**Encoded 2026-09-18.** `tools/Set-NotebookTopicOwner.ps1 -Scope excluded` now refuses a topic that
is provably reproducible, and `notebook.exclusion-must-be-earned` holds both directions against a
fixture in the commit gate. The verdict reads
[ADR-0022](0022-reachability-names-the-destination-class.md)'s `pages_without_current_copy` rather
than the drifted count alone: drift is one of **three** ways a page has no proven copy, and a topic
holding a page the Book never received is as legitimately `excluded` as one holding a drifted page.
A guard keyed on the drifted count alone is green on every other shape and wrong on that one.
`-AcceptReproducible` keeps the declaration the reader's, which is what stops this being the
derivation-overrides-declaration option rejected above.

**The remedy is still not reachable from an agent session, and that is outside the Library.**
`tools/Set-NotebookTopicOwner.ps1` is additive, claim-gated, needs no approval, and is carried in
`.claude/settings.json`'s allowlist — and the Claude Code auto mode classifier refuses it anyway as
a shared-resource write, in the exact allowlisted invocation. Two different seats hit this on
2026-09-15. So the documented route past an `excluded` declaration is one the **reader** runs, and
the reader-facing guidance says so rather than reporting it as a Library refusal. Hand-editing
`internal/notebook-topic-owners.json` is not the workaround: it bypasses the live-claim gate that
stops one session reassigning another seat's topic and then resetting it as its own.

## What this deliberately does not decide

**Whether the reset should gain an `-IncludeExcluded <topic>` switch.** It is now better supported
than when it was declined — the permission wall above means no in-session route past a declaration
exists at all, and `protected_recoverability` would let such a switch be approved on evidence rather
than on assertion. It is a change to a destructive helper's scope and belongs to the live-testing
loop, not to this record.

**Whether `notebook/orca-ide` keeps its declaration.** This ADR establishes that the declaration is
not earned, since two completed publication journals name that Book. Removing it is the reader's
command to run.
