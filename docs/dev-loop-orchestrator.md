# The Dev Loop: the orchestrator's page

The orchestrator seat reads this page to write and review a Kickoff, give out work by usage, assemble its own
integration branch and set up a seat. A build seat runs its Kickoff from [the builder's page](dev-session-loop.md),
which also holds what both roles share (the roles, the session shape, messages, the CHARTER and the gates). What
the loop has not proved, its limits and the records behind its rules are on [history and limits](dev-loop-history.md).

## The Kickoff

Each Kickoff names its open train item with `TRAIN:`; the orchestrator runs `kickoff-check` with `--train <register file>` on the real train record before posting it (Decision, 2026-10-27).

The orchestrator dates each car: `deskpost train car car:<name> --opened` when its first unit is posted, and `--arrived` when Eric can use it. One car is open at a time, so the next car opens only after the front car arrives. The Desk and its pane show the front car's days open and the cars arrived in the last 7 days.

The orchestrator writes `kickoffs/sNN` on the build seat's Hub with `hub edit --mode new-page` (Decision, 2026-09-29). Segments are
lowercase. It then appends one pointer to that Hub's `## Next`:

```
- [ ] Run sNN: [[projects/<hub>/kickoffs/sNN]]
```

Anything more the pointer says (a condition, `(supersedes ...)`) goes after the link, so the line still holds
`Run sNN:` with its colon and the builder's `--match-text "Run <p><NN>:"` finds it (s128's pointer put a condition
before the colon, and the Kickoff's match text found nothing) (Report, 2026-10-17).

`deskpost-dev`'s Kickoffs are `sNN`; `deskpost-codex-dev`'s are `cNN` on its own Hub, by the same rules. A unit reaches a
builder **only** as a Kickoff (Eric, 2026-10-11): not by letter, message or a list on its Hub.

**A Kickoff is write-once by rule, not by construction.** (Decision, 2026-09-29) `new-page` refuses to overwrite, but other
modes can still edit a page, so no seat edits a `kickoffs/` page after creating it. A revision is a
new page, `kickoffs/sNN-r2`. When the orchestrator writes one, it ticks the old pointer and appends the new one,
whose text says `(supersedes kickoffs/sNN)`. At most one pointer stays unticked. A revision names its own evidence
folder, `D:/dev/scratch/deskpost/<id>-r<n>/`; its OPEN accepts a unit branch at `<base>` with no commit of its own.
Before posting a revision, the orchestrator reads the builder's checkout (branch, commits past base and evidence
folder) and puts what it found in the dry-run line.
The orchestrator revises only a Kickoff no builder has started: first it reads the builder's Hub for an attempt page
naming that Kickoff (Eric, 2026-10-29). Once one exists, the Kickoff stands as Eric approved it, and a change is a
follow-up Kickoff after its handback (c13, 2026-10-13: r2 replaced the pointer one minute after the
builder's yes for r1).

**Every Kickoff starts from [the one-page template](kickoff-template.md).** Fill the block in a file and run
`node tools/kickoff-check.mts <file> --train <register file>` before `hub edit --mode new-page --content-path <file>`.
Run that check in a clean detached checkout at the Kickoff's pinned base: `git worktree add --detach <path> <base-sha>`.
Then give its `kernel/node_modules` a junction to an existing checkout's dependencies with
`New-Item -ItemType Junction -Path <path>/kernel/node_modules -Target <existing-checkout>/kernel/node_modules`.
For a handback, make the detached checkout at its tip instead, set `LIBRARY_SELFTEST_SECTIONS` to its named sections
and run `node test/run-parallel.ts` from that checkout's `kernel/`. Never run either proof in the orchestrator's own worktree.

Seven headings are required, in order: `TRAIN`, `WHY NOW`, `OWNS PATHS`, `STAY OUT OF`, `ROWS`, `CHARTER`, `CLOSE`.
The checker also recognizes `SIZE`, `OWNS`, `WHERE THINGS STAND`, `MERGE`, `COMMANDS`, `NOT CHARTERED`, `RULES`,
`STANDING ANSWERS` and `OPEN`; write one only when the unit needs its detail, in its existing relative order
(see `KNOWN_SECTIONS` in `kernel/src/kickoffcheck.ts`). Older sixteen-heading Kickoffs remain valid.
Until a release carries the seven-heading checker, posting with the installed program still needs all sixteen.

The header pins the base and loop-doc SHA in full (40 characters), branch, builder and integrator. While the slot
file exists, the source checker refuses a base older than its recorded U2 tip. `WHY NOW` gives the goal and facts
the rows depend on, with `file:line` at the base. A release TRAIN id needs an `- **Audit:**` line naming
library-auditor and its answering `[[letters/notes/<page>]]`; sensitive paths in OWNS or OWNS PATHS need a
`- **Second read:**` line naming library-auditor. Those checks apply to both Kickoff forms (Decision, 2026-10-27).

OWNS PATHS lists whole files, one backticked path or pattern per bullet; sensitive files appear by their exact names.
Use optional OWNS for parts of files, section allocations and pins, and MERGE for each branch's base, tip and gate
digest, in merge order. A clean non-fast-forward merge runs `commit-msg` (the identity scan), without pre-commit;
only a hand-finished merge's commit runs pre-commit. MERGE records the identity line, and the push
tier judges the outgoing range. A gate digest is the summary at that tip and `git config core.bare`,
never a hash or a digest from before a rebase. Put unit-specific setup in OPEN, exceptional decisions in STANDING ANSWERS and command families
in COMMANDS when needed. The builder's OPEN, yes, rules, default limits and CLOSE live in
[the session loop](dev-session-loop.md); copying them into each Kickoff adds no authority. A section must carry its
own unit-specific text, never point to another Kickoff instead. Every numbered row ends with `Done when:` and CLOSE
ends with **Stop.** The handback answers every row against its criterion.

Read your Hub's `## Next` pointer and the `## Now` resume item by `section`, never the whole `_project`.
A Kickoff may add a `REVIEW OF <unit>:` after the header. Cross-office units carry OFFICE, EXPORT (private base and
export root) and HANDBACK FOLDER under WHERE THINGS STAND; same-office units omit them.

A row that runs a step against a published release names a route the orchestrator has run against that release, with the
line it printed (Report, 2026-10-14). c17's row 3 piped input into 1.4.4's `menu --plain`, which answers only a terminal, and the release
attempt parked on it; c18's answers file was the route that worked.

**A row that waits says what it can catch here** (Decision, 2026-11-03;
`PLAN-checks-earn-their-wait.md` U7). A row that runs a hook over every section, a push tier, a matrix,
a build, compiled sections, an upgrade or Linux run, or that asks for a second read, adds `Catches here:`
and what that wait can find in this unit's own change, in a few words. A wait whose line can name nothing
in this change is not chartered. A revision carries over every proof whose inputs did not change
(`docs/releasing.md`, "What a changed candidate voids"). WHY NOW carries one bullet,
`**How this could cost time later:**`, naming the likeliest way this unit wastes a run and what stops it.

Before writing OWNS, the orchestrator finds the existing tests, fixtures and generated files that pin what the rows will
change (a count, an inventory, a probe table, a fixture's copy list: `git grep` for the changed names and counts at
the base) and names each in OWNS with its pins, so the yes at OPEN already covers them (Eric, 2026-10-15). c21 stopped for section 8's
probe table, c22 for sections 21, 39, 109, 216 and 219, each a pin its own change moved. A row that adds a step to
`.githooks/pre-commit` names in OWNS every self-test section that copies the hook (`git grep -n "githooks/pre-commit"
kernel/test/selftest.ts` at the base: sections 270, 577, 579 and 595 to 597 at s180's base), since each needs a
stand-in for the new step (c106, 2026-11-03).


**A required read is one the builder can open.** (Report, 2026-10-12) Its own Hub, a letter addressed to it, or a file at a named
SHA in the checkout. Another seat's Hub is closed on the builder's Desk and the reader refuses it, so a
Kickoff names the copy the builder can read (that seat's handback letter) instead (S118, 2026-10-12).

**Lean Kickoffs** (Decision, 2026-10-21; `kernel/src` grew from 38,581 lines on 2026-10-01 to 61,671 by 2026-10-21,
much of it specified on the orchestrator's pages). Each row answers three things before it is written: why it must exist
(the Report, ruling or plan step); what already does it, by `file:line`, or "nothing, searched: <command>"; and its
smallest form (a deletion, a fixture change or a reuse before a new helper, verb, option or section). Each Kickoff
adds `NOT BUILDING:` (what was asked or tempting and left out, and why) and `NET LINES:` (expected `kernel/src`
lines added minus removed); the orchestrator's review compares the Handback's measured `--shortstat` with it. Never cut
to save lines: validation at trust boundaries, data-loss handling, security, a section's negative control.

**Pins find tests by name, not only by the claim map.** (Report, 2026-10-23) `section-covers.json` claims only `kernel/src` files, so a
row that changes a `kernel/test/*.ts` or `tools/*.mts` file also pins every section that `git grep -n <file name>
kernel/test/selftest.ts` shows running or importing it (s156's pins missed section 378, which runs
`run-parallel.ts` and required the opposite of its row).

**Code audits feed the next Kickoff** (Decision, 2026-10-21) and (Decision, 2026-10-23). library-auditor audits one area of the
code per round, read-only, when the area's last audit is 30 days old or five units have pushed since. The orchestrator
verifies each finding as a claim; a confirmed one, defect or cleanup, becomes a row in the owning builder's next
Kickoff written after the verification. One that cannot fit gets a Hub line naming why and the unit that takes it,
deferred once at most; each review names the audit findings its unit carried, and a confirmed finding still in no
Kickoff after two Kickoffs for its builder is the orchestrator's to explain to Eric.

**A request letter names the yes it needs.** (Decision, 2026-10-21) A letter asking another seat to act says which of Eric's standing yeses
covers the work, or that it needs his fresh yes, so that seat asks him instead of parking the letter (library-auditor
parked the first code-audit request by the letters rule, 2026-10-21).

The template is the reference, not the most recent real Kickoff: a change to what every Kickoff carries is a change
to `docs/kickoff-template.md` (and its check), made on a `desk/*` branch (Eric, 2026-10-13).

**A pre-run is written only when it answers a question no row of the Kickoff answers** (Decision, 2026-11-03;
`PLAN-checks-earn-their-wait.md` U7): a fact the Kickoff's text depends on (a section that is red at the base, a count a
row must pin), never a repeat of a proof a row runs anyway. c105's full source matrix at its base repeated its own
row 4 on the candidate.

**Standing rules retained from the former template.** These apply without a RULES heading:

- Read Library command output whole before disposing it; never filter away a refusal or warning.
- A hook failure in an owned file is fixed in that row. A failure elsewhere gets a Report; continue only with
  independent work. A proof that fails then passes needs a Report and three consecutive agreeing runs.
- Before each heavy job and at CLOSE, list this session's running or waiting processes and other seats' gates,
  tests, builds and matrices by command line. Stop only your own unneeded processes by their own identifiers;
  confirm they are gone with another process list. Record each gate-lock wait's start and end; let its holder finish.
- The Orca card is attention only. If available, at each row start run
  `orca worktree set --worktree "path:<Library folder>" --comment "<seat>: <unit> row <n>, <work>" --json`;
  after the handback letter use `--comment "<seat>: <unit> handback ready (<outcome>)" --unread`.
  Always name the seat on the shared card; an unavailable or failing call is recorded once, without stopping work.
- Eric's reserved decisions: credentials and secrets; money; publishing and public pushes; his notes and vaults;
  Claude Code's and Codex's settings; anything outside Deskpost; product goals, scope and name; and one priority
  call after each release. These always go to Eric; a Kickoff's standing answers cannot decide them for him.

### Sizing by context, and spare items

(Decision, 2026-11-03; `PLAN-context-sized-kickoffs.md`.) Size a Kickoff's main rows at about 35-40% of the builder's
context window, against measured runs, by what the builder reads and runs. Then add two to four spare items from the
front of the train, in train order, skipping any that need a decision or a yes not already given, change a file a main
row changes or one another open Kickoff owns (except a pair's shared append files), need a live server, or would cost
more than about 6%. Write each like a row, list its files in OWNS PATHS, give it its own section numbers and a context
estimate, and put its ids on `SPARE TRAIN:`; `kickoff-check --train` checks only `TRAIN:`, so check each spare id is
open in `deskpost train --json` before posting and say so in the dry-run line. At every handback review, write
`Context: <window> window, <tokens> at handback (<n>%), peak <n>%, compactions <n>` from the run's own session file,
with the spares taken and skipped and the readings that decided them; close on the train only the spares taken.

## The second reader

A sensitive change touches guards or shell guards; hooks or their registration; seat launch flags,
sandbox or approval settings; secrets or the 1Password route; release, publish or mirror tooling;
or policy-bearing prose (`AGENTS.md`, `CLAUDE.md`, workspace instructions, seat-template purposes,
library-help, or this loop's rules). The orchestrator may name another sensitive path in a Kickoff.

Before every release, library-auditor audits every commit since its last audit (Decision, 2026-10-27), except a
commit whose every change is test code with the same parsed structure (comments and whitespace only; judged by the
orchestrator from the diff until `tools/section-select.mts` does it) or a document that is neither sensitive (above)
nor shipped or read at runtime (`tools/docs-gate.ts`'s contract documents, `docs/templates/`, anything the release
archive's program reads). The orchestrator's review record names each such commit and why (Decision, 2026-11-03;
`PLAN-checks-earn-their-wait.md` U7).
Every sensitive second read goes to library-auditor by letter (Decision, 2026-10-27). Every other
handback's first read is a fresh reviewer subagent the orchestrator starts with only the Kickoff, the
diff and the handback; it is not a seat (Decision, 2026-10-27). Review is due before the first
credential-bearing release step, and does not gate a merge or a private `origin` push (Decision, 2026-10-12).

The orchestrator's Hub review record names base and candidate SHA, reviewer and harness, commits and
paths covered, and each finding's disposition (Decision, 2026-10-12). A later covered-path change voids that part of the
record. An unresolved finding needs Eric's written acceptance.

**The fresh Claude reader's profile (2026-10-12, k1e-r2).** (Eric, 2026-10-12) A fresh Claude Code reader, when one is run,
is given only a staging folder of clean review files (Decision, 2026-10-27). The orchestrator writes the two
fixture files and launches this exact tested profile with the staging folder as working directory,
using subprocess argv without a command shell (installation and fixture paths are generalized
for publication; the flags and empty setting-source value are verbatim):

```text
<claude-executable> -p --safe-mode --restricted --disable-slash-commands --setting-sources "" --tools Read,Grep,Glob --strict-mcp-config --mcp-config <fixture>/empty-mcp.json --settings <fixture>/claude-settings.json --permission-mode dontAsk --output-format stream-json --verbose --include-hook-events --no-session-persistence
```

This is the tested `claude-1` profile; its original fixture paths were removed after the proof.
For a real review, the orchestrator supplies equivalent newly created fixture paths and the installed
Claude executable, preserving every flag and the empty `--setting-sources` argv value. The settings
file is `{"permissions":{"allow":["Read","Grep","Glob"]}}`; the MCP file is `{"mcpServers":{}}`.
Only Read, Grep and Glob were exposed; no user skills, plugins, hooks or MCP servers loaded.
Tested limits: Grep/Glob outside the folder, links and aliases untested; the environment reaches
the child, but no tool can read it; built-in telemetry on.

Codex failed k1e-r2 (Eric, 2026-10-12), so this profile is proven for a Claude reader only. Sensitive
second reads do not depend on it: they go to library-auditor by letter, whichever harness wrote the
change, and library-auditor audits every commit before a release (Decision, 2026-10-27).

**The mirror source.** (Decision, 2026-09-29) The chartered push is safe only because `Kioga/library` is not the mirror
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
`docs/releasing.md`. That push is never chartered (Decision, 2026-09-29): it is its own question at a session's close.

## The orchestrator's code: one integration branch per Kickoff

Keep Kickoff checks and handback section runs in the clean detached checkouts described under
[The Kickoff](#the-kickoff). Their pinned base or tip fixes which source each proof reads.

The orchestrator works in its own worktree, `git worktree add -b desk/scratch <repo>-desk master`, and commits only
on `desk/*` branches, never on `master` or in a builder's tree (Decision, 2026-09-29). The worktree shares `core.hooksPath`, so
every commit there passes the same pre-commit gate. A new worktree needs its gitignored machine-local
bindings once: run `tools/Initialize-CodexLibrary.ps1` in it, or the gate fails on
`codex.project-access-config` (`.codex/config.toml is missing`) (Report, 2026-10-11). The script needs `-McpUrl` and
`-CollectionId`, or the three gitignored state files `.claude/.library-mcp-url`,
`.claude/.library-project` and `.claude/.library-shared-root` copied from an existing worktree; it has
no default. A merge that changes the required Codex hooks (`CODEX_REQUIRED_HOOKS`,
`kernel/src/hookregistry.ts`) needs the script re-run in **every** checkout before its next gate (Report, 2026-10-11):
`.codex/hooks.json` is gitignored, so no merge carries it.

For each Kickoff, the orchestrator assembles one branch, `desk/sNN`, rebased onto current `master`, and records its
base and tip SHAs and the gate digest in MERGE (Decision, 2026-09-29). After recording the tip, the orchestrator does not commit to
`desk/sNN` again; later fixes go on the next Kickoff's branch. The independent-addition conflict
rule in [OPEN step 4](dev-session-loop.md#open) applies; other conflicts return to a chartered reconciliation. The orchestrator deletes its
merged branch only once the integrator's handback confirms the merge (Eric, 2026-10-08). Delete it without force with
`git branch -u origin/master <branch> && git branch -d <branch>`, which still refuses a branch not merged.

## Assigning work by usage

The orchestrator reads both weekly meters with `orca account list --json`:
`result.rateLimits.<harness>.weekly.usedPercent`, `resetsAt`, and the provider's `updatedAt` (Decision, 2026-10-12).
Check the account by the login the seat uses (`claude auth status`), not by Orca's `activeAccountId`:
on this PC `result.rateLimits.claude` follows the login in use, while the active label can name the
other account (2026-10-13), so a label mismatch alone does not make a reading unknown (Report, 2026-10-13).
Missing, refused, older than about 15 minutes, or
already past `resetsAt` means unknown (Decision, 2026-10-12); a Codex session log can fill only Codex's figure.
Without Orca every reading is unknown unless that Codex fallback is available.

Until the gate-lock goal is met, Codex Builder takes the builds, and Claude Builder takes only work that
does not hold the gate lock (Decision, 2026-10-27). For what that leaves open: with both known, give work
either harness can do to the seat with more of its week left, weighing how far off each reset is
(Decision, 2026-10-12). The percentages are different subscriptions, not equal amounts of work.
A seat past about 90% gets no new unit, even one only it can do, unless Eric overrides (Decision, 2026-10-11). With an
unknown reading the orchestrator judges and says so. This is advisory, not automatic dispatch.

WHY NOW carries one line: `Usage: Claude NN% / Codex NN% (Orca, updated HH:MM by date) -> <seat>: <reason>` (Decision, 2026-10-12).
Use `unknown` for any unavailable reading. Record the meters at OPEN and CLOSE.

## Setting up an orchestrator seat

What S68 learned setting up `deskpost-desk` (stalls 1, 2, 4 and 5), in the order it has to happen:

1. **`seat start --preflight` issues a plan_id for a new seat; `hub new` issues none.** (Report, 2026-10-07) The seat's
   plan_id is required with `--department`, `--role`, `--card`, `--template` or `--open-book`, and
   accepted without them (since 1.3.8). A gate that covers both shows the commands it will run and
   the seat's plan_id, and the reader's yes covers those commands.
2. **A new worktree needs `tools/Initialize-CodexLibrary.ps1`** (Decision, 2026-09-29), run once in it, or its first commit
   fails the gate on `codex.project-access-config` (see above).


## Kickoffs for another office

Write the cross-office Kickoff under `kickoffs/<id>` on your own Hub (Decision, 2026-10-20).
The receiving builder gets a local copy through a letter; it does not read your Hub.

1. Have the chartered integrator export the private base with (Decision, 2026-10-20):

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
   The manifest must come from the Handback letter in open Shelf letters, never from the share as authority (Decision, 2026-10-20).
   A mismatch parks integration with its diagnostic (Decision, 2026-10-20); no inferred base or manifest replaces it.

The builder's publication and reconstruction procedure is in [the builder's page](dev-session-loop.md#a-builder-in-another-office).
The first live Webtop trial and the recreation proofs remain separate chartered units.
