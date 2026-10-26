# The Dev Loop: the planner's page

The planner seat reads this page to write and review a Kickoff, give out work by usage, assemble its own
integration branch and set up a seat. A build seat runs its Kickoff from [the builder's page](dev-session-loop.md),
which also holds what both roles share (the roles, the session shape, messages, the CHARTER and the gates). What
the loop has not proved, its limits and the records behind its rules are on [history and limits](dev-loop-history.md).

## The Kickoff

The planner writes `kickoffs/sNN` on the build seat's Hub with `hub edit --mode new-page`. Segments are
lowercase. It then appends one pointer to that Hub's `## Next`:

```
- [ ] Run sNN: [[projects/<hub>/kickoffs/sNN]]
```

Anything more the pointer says (a condition, `(supersedes ...)`) goes after the link, so the line still holds
`Run sNN:` with its colon and the builder's `--match-text "Run <p><NN>:"` finds it (s128's pointer put a condition
before the colon, and the Kickoff's match text found nothing).

`deskpost-dev`'s Kickoffs are `sNN`; `deskpost-codex-dev`'s are `cNN` on its own Hub, by the same rules. A unit reaches a
builder **only** as a Kickoff: not by letter, message or a list on its Hub.

**A Kickoff is write-once by rule, not by construction.** `new-page` refuses to overwrite, but other
modes can still edit a page, so no seat edits a `kickoffs/` page after creating it. A revision is a
new page, `kickoffs/sNN-r2`. When the planner writes one, it ticks the old pointer and appends the new one,
whose text says `(supersedes kickoffs/sNN)`. At most one pointer stays unticked.
The planner revises only a Kickoff no builder has started: first it reads the builder's Hub for an attempt page
naming that Kickoff. Once one exists, the Kickoff stands as Eric approved it, and a change is a
follow-up Kickoff after its handback (c13, 2026-10-13: r2 replaced the pointer one minute after the
builder's yes for r1).

**Every Kickoff starts from `docs/kickoff-template.md`** (since 2026-10-13, the dev loop review). The planner fills the
template in a file and runs `node tools/kickoff-check.mts <file>` before `new-page`; the check refuses a missing
section, a section out of order, a pointer to another Kickoff, a row with no `Done when:` line, or a CLOSE that does
not end with **Stop.** Self-test section 240 holds the check to the template. Every Kickoff carries these sections,
in this order:

- **WHY NOW**: why this session, now, and the usage line ("Assigning work by usage").
- **SIZE**: the time budget, gate minutes per row and per cut, and the stop rule.
- **OWNS**: the files, and the new self-test section numbers, this Kickoff's rows may change; `none other open`
  when no other builder's Kickoff is open. See ["Two builders at once"](dev-session-loop.md#two-builders-at-once).
- **STAY OUT OF**: what the session must not touch.
- **WHERE THINGS STAND**: the checkout's SHA, the installed version, and what is not in scope. It pins the
  checkout, the branch the rows land on, and its base SHA (for `deskpost-codex-dev`, `codex/cNN`, created once at OPEN
  from that base; `deskpost-dev`'s rows land on `dev/sNN`), the integrator and its pinned integration base when applicable,
  and names the loop-doc SHA the base must contain ([OPEN step 0](dev-session-loop.md#open)).
- **MERGE** (integrator Kickoffs; otherwise `none`): `desk/sNN` with `base=<master SHA>`, `tip=<commit SHA>` and
  the gate digest for that tip, and/or a builder's `codex/cNN` with its handback's base, tip and gate line. The
  **gate digest** is the `-Fast` gate's summary line at the tip
  (`N passed, N warned, N failed, N skipped`) and `git config core.bare` after it. It is a summary,
  not a hash, so a branch rebased onto `master` takes it from a `-Fast` run at the new tip, never from
  an amend.
- **ROWS**: the rows, in order, committed one commit per cut as ["The gates"](dev-session-loop.md#the-gates-what-green-means) says. **Every row ends with a
  `Done when:` line** naming the check that proves it, and the Handback answers each row against that line.
- **COMMANDS**: the command families it will run, so the reader can widen the harness allowlist
  beforehand.
- **CHARTER**: the commits and the one private push the session may make. See ["The CHARTER"](dev-session-loop.md#the-charter).
- **NOT CHARTERED**: what the yes does not cover, so a builder does not infer it.
- **RULES**: the session's working rules, including the four messaging rules in ["Messages between the
  seats"](dev-session-loop.md#messages-between-the-seats).
- **STANDING ANSWERS**: how the builder decides without waiting: the template's defaults, then this unit's own. See
  "Decide and record" under [Work](dev-session-loop.md#work).
- **OPEN**: the fresh-session check, the required reads, the refs, the meters, the gate and its one yes.
- **CLOSE**: what the handback must hold, ending with **"Stop."**: after the handback the session takes no
  further row, unit or letter-borne work.

Every Kickoff is self-contained: its RULES and STANDING ANSWERS are written out from the template, word for word,
not "as kickoffs/sNN's" (S118 and S119 pointed to their predecessors, a chain the builder could not follow), so a
session that skipped [OPEN step 0](dev-session-loop.md#open) still has them.

**A required read is one the builder can open.** Its own Hub, a letter addressed to it, or a file at a named
SHA in the checkout. Another seat's Hub is closed on the builder's Desk and the reader refuses it, so a
Kickoff names the copy the builder can read (that seat's handback letter) instead (S118, 2026-10-12).

**Lean Kickoffs** (Decision 2026-10-21; `kernel/src` grew from 38,581 lines on 2026-10-01 to 61,671 by 2026-10-21,
much of it specified on the planner's pages). Each row answers three things before it is written: why it must exist
(the Report, ruling or plan step); what already does it, by `file:line`, or "nothing, searched: <command>"; and its
smallest form (a deletion, a fixture change or a reuse before a new helper, verb, option or section). Each Kickoff
adds `NOT BUILDING:` (what was asked or tempting and left out, and why) and `NET LINES:` (expected `kernel/src`
lines added minus removed); the planner's review compares the Handback's measured `--shortstat` with it. Never cut
to save lines: validation at trust boundaries, data-loss handling, security, a section's negative control.

**Pins find tests by name, not only by the claim map.** `section-covers.json` claims only `kernel/src` files, so a
row that changes a `kernel/test/*.ts` or `tools/*.mts` file also pins every section that `git grep -n <file name>
kernel/test/selftest.ts` shows running or importing it (s156's pins missed section 378, which runs
`run-parallel.ts` and required the opposite of its row).

**Code audits feed the next Kickoff** (Decisions 2026-10-21 and 2026-10-23). library-auditor audits one area of the
code per round, read-only, when the area's last audit is 30 days old or five units have pushed since. The planner
verifies each finding as a claim; a confirmed one, defect or cleanup, becomes a row in the owning builder's next
Kickoff written after the verification. One that cannot fit gets a Hub line naming why and the unit that takes it,
deferred once at most; each review names the audit findings its unit carried, and a confirmed finding still in no
Kickoff after two Kickoffs for its builder is the planner's to explain to Eric.

**A request letter names the yes it needs.** A letter asking another seat to act says which of Eric's standing yeses
covers the work, or that it needs his fresh yes, so that seat asks him instead of parking the letter (library-auditor
parked the first code-audit request by the letters rule, 2026-10-21).

The template is the reference, not the most recent real Kickoff: a change to what every Kickoff carries is a change
to `docs/kickoff-template.md` (and its check), made on a `desk/*` branch.

## The second reader

A sensitive change touches guards or shell guards; hooks or their registration; seat launch flags,
sandbox or approval settings; secrets or the 1Password route; release, publish or mirror tooling;
or policy-bearing prose (`AGENTS.md`, `CLAUDE.md`, workspace instructions, seat-template purposes,
library-help, or this loop's rules). The planner may name another sensitive path in a Kickoff.

One review per release candidate covers all unreleased sensitive commits. A fresh read-only session
of the other harness than each commit's author reads the whole sensitive diff from the release base,
including how the commits combine in the final tree. A conflict resolution touching a sensitive
path counts as the integrator's commit. Earlier review is optional; review is due before the first
credential-bearing release step, and does not gate a merge or a private `origin` push.

The planner's Hub review record names base and candidate SHA, reviewer and harness, commits and
paths covered, and each finding's disposition. A later covered-path change voids that part of the
record. An unresolved finding needs Eric's written acceptance.

**Current one-way rule (2026-10-12, k1e-r2).** A Codex-authored sensitive commit is read by a fresh
Claude Code session given only a staging folder of clean review files. The planner writes the two
fixture files and launches this exact tested profile with the staging folder as working directory,
using subprocess argv without a command shell (installation and fixture paths are generalized
for publication; the flags and empty setting-source value are verbatim):

```text
<claude-executable> -p --safe-mode --restricted --disable-slash-commands --setting-sources "" --tools Read,Grep,Glob --strict-mcp-config --mcp-config <fixture>/empty-mcp.json --settings <fixture>/claude-settings.json --permission-mode dontAsk --output-format stream-json --verbose --include-hook-events --no-session-persistence
```

This is the tested `claude-1` profile; its original fixture paths were removed after the proof.
For a real review, the planner supplies equivalent newly created fixture paths and the installed
Claude executable, preserving every flag and the empty `--setting-sources` argv value. The settings
file is `{"permissions":{"allow":["Read","Grep","Glob"]}}`; the MCP file is `{"mcpServers":{}}`.
Only Read, Grep and Glob were exposed; no user skills, plugins, hooks or MCP servers loaded.
Tested limits: Grep/Glob outside the folder, links and aliases untested; the environment reaches
the child, but no tool can read it; built-in telemetry on.

A Claude-authored sensitive commit has no proven second reader: Codex failed k1e-r2. The planner
steers sensitive work to Codex where possible. A release still carrying Claude-authored sensitive
work records Eric's written acceptance of this gap in its review record before its first credential
step. The one-way rule ends only when a Codex profile passes k1e-r2's five criteria in a chartered proof.

**The mirror source.** The chartered push is safe only because `Kioga/library` is not the mirror
job's `SOURCE_REPO`. Its value is a secret on the `Kioga/deskpost-ops` repository and cannot be read
back, and the workflow's files name only `${{ secrets.SOURCE_REPO }}`.

**Confirmed 2026-09-29 (S68): `SOURCE_REPO` is `Kioga/deskpost`, not `Kioga/library`.** The private
record of the S9 deployment (2026-09-20) holds the one API call that ever set it, with that value.
Releases reach `Kioga/deskpost` as their own pushes from a release checkout, and the mirror publishes
those: after the v1.2.3 release, the public side carried `Kioga/deskpost`'s `main`, not
`Kioga/library`'s `master`. A push to `origin` therefore publishes nothing, and a push to
`Kioga/deskpost` publishes when the mirror job next runs: the release session starts it right after
the publish push, and its daily run catches a missed start. If the secret's timestamp on
`Kioga/deskpost-ops` (Settings, Actions, Secrets) ever reads later than 2026-09-20, it was changed
after S9, and this must be checked again before a chartered push.

How a release is prepared, and the one push to `Kioga/deskpost` that publishes it, is in
`docs/releasing.md`. That push is never chartered: it is its own question at a session's close.

## The planner's code: one integration branch per Kickoff

The planner works in its own worktree, `git worktree add -b desk/scratch <repo>-desk master`, and commits only
on `desk/*` branches, never on `master` or in a builder's tree. The worktree shares `core.hooksPath`, so
every commit there passes the same pre-commit gate. A new worktree needs its gitignored machine-local
bindings once: run `tools/Initialize-CodexLibrary.ps1` in it, or the gate fails on
`codex.project-access-config` (`.codex/config.toml is missing`). The script needs `-McpUrl` and
`-CollectionId`, or the three gitignored state files `.claude/.library-mcp-url`,
`.claude/.library-project` and `.claude/.library-shared-root` copied from an existing worktree; it has
no default. Run `npm ci --offline` in `kernel/` once too, or self-test section 155 fails for want of
TypeScript. A merge that changes the required Codex hooks (`CODEX_REQUIRED_HOOKS`,
`kernel/src/hookregistry.ts`) needs the script re-run in **every** checkout before its next gate:
`.codex/hooks.json` is gitignored, so no merge carries it.

For each Kickoff, the planner assembles one branch, `desk/sNN`, rebased onto current `master`, and records its
base and tip SHAs and the gate digest in MERGE. After recording the tip, the planner does not commit to
`desk/sNN` again; later fixes go on the next Kickoff's branch. The independent-addition conflict
rule in [OPEN step 4](dev-session-loop.md#open) applies; other conflicts return to a chartered reconciliation. The planner deletes its
merged branch only once the integrator's handback confirms the merge. Delete it without force with
`git branch -u origin/master <branch> && git branch -d <branch>`, which still refuses a branch not merged.

## Assigning work by usage

The planner reads both weekly meters with `orca account list --json`:
`result.rateLimits.<harness>.weekly.usedPercent`, `resetsAt`, and the provider's `updatedAt`.
Check the account by the login the seat uses (`claude auth status`), not by Orca's `activeAccountId`:
on this PC `result.rateLimits.claude` follows the login in use, while the active label can name the
other account (2026-10-13), so a label mismatch alone does not make a reading unknown.
Missing, refused, older than about 15 minutes, or
already past `resetsAt` means unknown; a Codex session log can fill only Codex's figure.
Without Orca every reading is unknown unless that Codex fallback is available.

With both known, give work either harness can do to the seat with more of its week left, weighing
how far off each reset is. The percentages are different subscriptions, not equal amounts of work.
A seat past about 90% gets no new unit, even one only it can do, unless Eric overrides. With an
unknown reading the planner judges and says so. This is advisory, not automatic dispatch.

WHY NOW carries one line: `Usage: Claude NN% / Codex NN% (Orca, updated HH:MM by date) -> <seat>: <reason>`.
Use `unknown` for any unavailable reading. Record the meters at OPEN and CLOSE.

## Setting up a planner seat

What S68 learned setting up `deskpost-desk` (stalls 1, 2, 4 and 5), in the order it has to happen:

1. **`hub new` comes before `seat start`.** `seat start --preflight` refuses a seat whose Hub does
   not exist yet, so the two cannot be preflighted together. Make the Hub (`--dev` for a dev Hub),
   then preflight and start the seat (`--no-launch` when it should not start a session yet).
2. **`seat start --preflight` issues a plan_id for a new seat; `hub new` issues none.** The seat's
   plan_id is required with `--department`, `--role`, `--card`, `--template` or `--open-book`, and
   accepted without them (since 1.3.8). A gate that covers both shows the commands it will run and
   the seat's plan_id, and the reader's yes covers those commands.
3. **A new worktree needs `tools/Initialize-CodexLibrary.ps1`**, run once in it, or its first commit
   fails the gate on `codex.project-access-config` (see above).
4. **The planner seat opens its own Desk from its first live session.** `desk open ... --seat <seat>`
   refuses while that seat has no live session, so a builder cannot open it on the planner's behalf. The
   planner's first step is
   to open the build Hub on its Desk.
5. **Preflight a replace-mode edit after any additive edit to the same page.** An append, a
   `check-item` or an `add-section` changes the page, so a replace plan_id preflighted before it goes
   stale and needs a new yes.


## Kickoffs for another office

Write the cross-office Kickoff under `kickoffs/<id>` on your own Hub.
The receiving builder gets a local copy through a letter; it does not read your Hub.

1. Have the chartered integrator export the private base with:

   `node tools/export-base.ts --base <sha> --to <folder> --for <id>` (from the release that carries s158).

   Record the scanned export's private base and export root from the export receipt.
2. Fill the template's OFFICE, EXPORT and HANDBACK FOLDER fields.
   Name the receiving office and seat, the share folder and both full SHAs, and the immutable-generation folder.
   Give out files and section numbers that do not overlap another open unit.
3. Send the complete Kickoff with:

   `deskpost kickoff send kickoffs/<id> --library <card> --for <seat>` (from the release that carries s159).

   Record the envelope hash and the letter receipt.
   The receiving builder runs `deskpost kickoff receive notes/<letter-page>` (from the release that carries s159), then takes its own OPEN yes.
4. Review the full Handback and its manifest from the returned letter.
   Account for the Linux gate's named skips and each row's published generation.
   A green Linux run is evidence; the Windows push tier remains the pass mark.
5. Write `kickoffs/<id>-int` on the integrating builder's Hub, using the usual pointer and OPEN gate.
   Name the private base, export root, original Kickoff envelope hash and exact Handback letter page.
   Put these values in the apply row as arguments, copied from your reviewed records:

   `node tools/apply-handback.ts <folder> --base <private-sha> --export-root <export-root-sha> --letter notes/<page> --onto int/<id>`

   Start `int/<id>` at the named private base.
   Require review of the applied commits and printed diff against OWNS, the Windows push tier and the usual remote-tip check before the one private push.
   The manifest must come from the Handback letter in open Shelf letters, never from the share as authority.
   A mismatch parks integration with its diagnostic; no inferred base or manifest replaces it.

The builder's publication and reconstruction procedure is in [the builder's page](dev-session-loop.md#a-builder-in-another-office).
The first live Webtop trial and the recreation proofs remain separate chartered units.
