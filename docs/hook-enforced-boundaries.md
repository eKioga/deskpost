# Hook-Enforced Boundaries

How the Library uses Claude Code hooks, what each one is for, and the two things they are not
allowed to do.

## Why the Library has a hook layer at all

Most of what the Librarian is asked to do is carried by prose — `CLAUDE.md`, the playbooks, the
Skill. Prose is the right medium for judgement, and the wrong one for a boundary, because it depends
on being *remembered*. Two properties of a long session defeat it:

- **Attention decays with distance.** An instruction loaded at turn one competes against everything
  that arrives afterwards. The operations that most need it — publishing, archiving, resetting — are
  the ones a session reaches last.
- **The harness can steer around it.** Bypass-permissions mode instructs sessions to prefer `cat` and
  `grep` over the `Read` tool. That instruction is not wrong, and it walked straight through a guard
  registered only for `Read`.

A hook has neither weakness. It is executed by the harness at a fixed event, with no dependence on
what the model currently believes. So the Library puts its **boundaries** in hooks and leaves its
**judgement** in prose.

## The two jobs

A hook here does exactly one of these, and the file says which:

| | **Guard** | **Informer** |
| --- | --- | --- |
| Can refuse a call | yes | never |
| Fails | closed | silent |
| Examples | `Guard-BasicMemoryRead`, `Guard-ShelfBookRead`, `Guard-ShellShelfRead` | `Get-VirtualDeskContext`, `Get-PlaybookContext`, `Add-SearchHitReminder` |

The split matters at the failure edge. A guard that cannot read Desk state must deny, because the
cost of a wrong allow is disclosure. An informer that fails must say nothing at all, because it
stands in front of a tool call that is entitled to proceed without it. Putting both behind one shared
dependency would make one of them wrong, which is why `HookContext.ps1` is deliberately narrow —
payload in, JSON out, serve ledger — and does not absorb the guards' state parsing.

`Guard-SettingsIntegrity` is the one hook that guards and *fails open*, and it says why in its own
header: it stands between the reader and their own configuration file, so a bug in it that refused
every settings edit would lock them out of the file that could disable it.

## The hole this layer was extended to close

On 2026-09-06, in a session whose `Read` of a page in the closed `holding` Book had just been denied
with *"Shelf Book 'holding' is closed"*:

```
$ wc -c shelf/holding/wiki/_index.md
328 shelf/holding/wiki/_index.md
```

`cat` would have returned the page. `Guard-ShelfBookRead` matched `Read|Grep|Glob`; `Bash` was not in
that set, and `Bash`'s `tool_input` carries `command` rather than the `file_path` and `glob` fields
that guard reads — so registering it there would have matched and then found nothing to judge.

Two changes followed. `Guard-ShellShelfRead` now judges the text of every `Bash` and `PowerShell`
command, and the original guard's matcher gained `Write` and `Edit`: reading a closed Book was
guarded and *writing into one* was not, which is the same boundary with a larger blast radius.

Both now share `ShelfBoundary.ps1`. Two guards with two copies of "where does this path sit relative
to the Desk" is the shape `BookRootSchema.ps1` exists to prevent one layer down.

### The same hole, one directory over (2026-09-10)

`Guard-ShelfBookRead` judged Shelf paths and nothing else, so a plain `Write` into `notebook/` took
no claim and checked no ownership — while three documents promised a seatless session *changes
nothing*. The obvious fix was **wrong**: authoring a Notebook article *is* a direct write with no
helper behind it, so refusing `notebook/` would have bricked the flow `CLAUDE.md` tells the Librarian
to perform. What landed guards the **claim and the ownership, never the authoring** — a seatless
write, and a write into a topic another seat owns, using the same `Test-NotebookTopicWritable`
verdict the helpers enforce. `docs/seats.md`, *Writing into `notebook/`*, carries the boundary.

The shell guard is still Shelf-only, so a heredoc write into `notebook/` is ungated. Stated rather
than left to be discovered; it is the same asymmetry the 2026-09-06 entry above closed for reading.

### What the shell guard gives up

It matches text; it does not resolve paths. It cannot: `cat $(ls shelf/*/wiki/*.md | head -1)`
reaches a closed Book through a construction no path parser sees, and a `cd` moves the ground a
relative path stands on. So it denies on doubt, and it will occasionally refuse a command that merely
*mentions* a closed Book — `grep -rn "shelf/holding" docs/` is refused along with `cat` of the same
path. One deliberate exception keeps that bearable: a bare `shelf/` naming no Book is a search
string, not a read, and is allowed.

This is a guard against the ordinary path, not a sandbox. A session determined to defeat it can. What
it claims is that reaching a closed Book never happens by accident or by habit.

### An escape is not a path separator (2026-09-19)

Matching text still meant normalising Windows separators, and a flat `\` → `/` read every **regex
escape** as one. So this was refused:

```
grep -n -A4 '^\*\*Shelf\*\*\|^\*\*Holding Shelf\*\*' CONTEXT.md
```

The only path argument is `CONTEXT.md`. `\*\*Shelf\*\*\|` became `/*/*Shelf/*/*/|`, the scanner lifted
`Shelf/*/*` out of it, and the refusal named a glob the reader never typed — which sends the
diagnosis toward opening a Book when no Book is involved. A backslash is now a separator only before
a letter, a digit, `_`, `/` or another `\`; anywhere else it is an escape, and it **breaks** the token
rather than contributing a character to it.

Three things came with it. `shelf*/holding/…` is now refused — the shell expands that glob back to
`shelf/`, so it had been a way past the guard rather than a false positive, found while reading the
code for the friction report and not claimed by it. A run of separators collapses, so a doubled
backslash names the Book it points at instead of being reported as the whole Shelf. And **a refusal
quotes the command's own characters** and names the route that is not refused: this guard cannot tell
`grep -rn "shelf/demo" .` from `grep -rn x shelf/demo`, and does not try, but the Grep *tool* is
judged on its `path` and `glob` and never on its `pattern`.

**A fixture Shelf under the system temp directory is in scope, and that is a decision.** Every suite
in `tools/` builds one and none is the reader's Shelf, so exempting them was considered. It would
mean resolving the prefix and asking whether it lands outside the workspace — which is what
`Guard-ShelfBookRead` does, and which carries a hole this text match does not: an aliased root
(`subst`, a junction) normalises to a path outside the workspace and would be waved through, one
collection over from the four aliased spellings that walked past this boundary on 2026-09-07. What
was actually harming the reader was the message, and the message is fixed.

## Hooks deliver documents; they do not hold rules

Recorded as [ADR-0014](adr/0014-a-hook-delivers-a-document-it-does-not-hold-a-rule.md).

`Get-PlaybookContext` carries no procedure of its own. It holds a routing table from helper filename
to a **heading in `librarian-operation-playbooks.md`**, cuts that section out at the moment the
helper is invoked, and hands it over. `Restore-CompactedGuidance` does the same against
`.claude/rules/library-development.md`.

`Get-SeatStartContext` is the third, added 2026-09-10 for `PLAN-seat-launch.md` step 9: it serves
*Sitting down at a seat* from `seats.md` to a session that has no seat. What it adds to the served
text is **state** — the seat roster, generated at the moment it is read — which is the one thing a
tracked document must not hold, because a written roster is stale the moment a seat is created.

The consequence worth stating: `library-hooks.boundary-suite` asserts every routed heading resolves
in the tracked document, and `seats.session-start-section-resolves` does the same for the seat
section, so rewording a heading fails the gate rather than silently serving nothing.

### The output shape, measured rather than assumed (2026-09-09)

A hook has two ways to speak and only one of them arrives. Emitting both with distinct tokens on
`SessionStart` and asking the model to echo what it was given, only the **`additionalContext`** token
came back; **`systemMessage` did not**. Both instruction hooks now emit `additionalContext` only.

`PostCompact`'s output shape was **not** measured — neither field was proven there, and `--print`
mode cannot be made to compact — so it emits the shape that is known to work somewhere rather than
the one known to fail somewhere. That is a bet, and it is recorded as one.

The same measurement found the field that decides *when*: a SessionStart payload carries **`source`**
(`startup`, `resume`, `fork`, and per the documentation `clear` and `compact`), and never
`startup_reason`. `Restore-CompactedGuidance` read `startup_reason` from the day it was written, so
its comparison was always against an empty string and it **exited 0 on every session start it had
ever seen** — with a green gate throughout, because the suite covering it fed the same absent field.
The lesson is narrower than "test hooks": a fixture that invents the payload proves the code agrees
with the fixture. Capture one.

### The serve ledger, and its contract with compaction

A playbook section injected on *every* call charges for it every time. Injected **once per session**
it costs once — and then rots along with everything else. `.claude/.hook-served.json` (untracked,
keyed by session id) splits the difference, and `Restore-CompactedGuidance` empties the session's
entry on `PostCompact`, because a compaction is precisely the event that summarises the first
injection away. That ledger clear runs before anything else in that hook and does not depend on the
rule file being present.

Since 2026-09-10 it also runs on **every** `SessionStart` source, not only the two that are served.
A `clear` may keep its session id — that event could not be captured — and if it does, a ledger left
in place withholds every playbook from a context that has just been thrown away. A redundant clear
costs one repetition; a missed one costs the guidance.

### Why the post-compact hook does not restate CLAUDE.md

Its first design did. `.claude/rules/library-development.md` says otherwise, about this harness
specifically: *"a project-root CLAUDE.md is re-injected after a /compact, and a path-scoped rule is
not — it reloads the next time a matching file is read."*

So the Library had already solved that problem by putting those rules in the file that comes back. A
hook restating them would be a second copy of text the harness re-injects for free, charged against a
workspace that budgets its always-on instruction surface in *words*. What compaction genuinely drops
here is the **path-scoped rule** — the six PowerShell defect families and the durable-write rules —
and the dangerous window is a session that resumes by *writing* a `tools/` file rather than reading
one. That is what the hook re-serves, and `library-hooks.boundary-suite` asserts it does **not**
repeat phrases that `CLAUDE.md` still carries.

## Two windows on the same failure

`.githooks/pre-commit` exists because *"a hook defined inside settings.json cannot validate the file
that defines it. A malformed settings file has already disabled the permission allowlist and both
guard hooks once, silently."*

That is still true. What `Guard-SettingsIntegrity` adds is the window the commit gate cannot reach:

| | edit made while a session runs | edit that reaches a commit |
| --- | --- | --- |
| `ConfigChange` hook | refuses the change | — |
| `.githooks/pre-commit` | — | refuses the commit |

Both read the same list, from `tools/HookRegistry.ps1`, and both judge **structurally**: a guard
moved from `PreToolUse` to `PostToolUse` is still named in the file, still passes a substring search,
and no longer guards anything, because the tool has already run by the time it is consulted. Removing
a load-bearing guard is refused; removing an optional informer is allowed and said out loud.

## The Codex bindings had never loaded

Extending the boundary to Codex started as a question about its shell tool's name and turned up
something larger. Codex rejects the whole hooks file if an event appears at the root:

```
warning: failed to parse hooks config ...\hooks.json:
unknown field `PreToolUse`, expected `description` or `hooks` at line 3 column 14
```

Events must nest under a top-level `hooks` key. The Library had written them at the root since the
Codex bindings were introduced, so **every Codex session started with that warning and registered no
Library hook at all** — no Desk guard on Basic Memory, no Desk context on prompt submission.

Two checks passed on that file the whole time. `codex.project-access-config` confirmed it existed,
parsed as JSON, and named the right scripts; `codex.portability-selftest` read the events from the
root, which is where the generator put them. Test and generator agreed with each other and both
disagreed with Codex. Valid JSON was never the bar, and nothing was measuring the only thing that
mattered.

Verified against codex 0.147.0 by rendering both shapes into a real `CODEX_HOME` and driving each
through a `codex exec` run: the flat shape produces the warning above, the nested shape does not.
Both checks now assert the root keys first, and `library-hooks.boundary-suite` asserts the shape of
the tracked template and the generated file.

### Codex's hook contract is Claude Code's

This was worth asking rather than assuming, and the assumption held — but not in the way the first
attempt guessed. Codex presents **Claude-Code-compatible** hooks: same event names, same payload
field names, same `hookSpecificOutput` envelope. A `PreToolUse` payload captured verbatim from a
`codex exec` run:

```json
{ "session_id": "...", "turn_id": "...", "transcript_path": "...", "cwd": "...",
  "hook_event_name": "PreToolUse", "model": "gpt-5.6-sol",
  "permission_mode": "bypassPermissions",
  "tool_name": "Bash", "tool_input": { "command": "echo payload-probe" },
  "tool_use_id": "exec-b3011bf6-..." }
```

**`tool_name` is `Bash`.** Codex normalises its shell tool to the Claude Code name for hooks;
`exec` — which `codex debug prompt-input` shows as `functions.exec`, and which this repository
shipped as the matcher for one commit — survives only inside `tool_use_id`. A matcher of `^exec$`
matches nothing, silently, which is the same outcome as no guard. MCP tools keep
`mcp__server__tool`, so the Basic Memory matcher was already right. `command` is a **string**, not
the argv array the transcript's rendering suggested.

Honoured on `PreToolUse`: `permissionDecision` `deny` (and `allow`), `permissionDecisionReason`,
`additionalContext`, and `updatedInput` with `allow`. Parsed but failing open: `"ask"`,
`continue: false`, `stopReason`, `suppressOutput`. `additionalContext` on `UserPromptSubmit` is
added as developer context, which is what the Desk hook relies on. `updatedOutput` does not exist —
Codex cannot rewrite tool output, and nothing here asks it to.

**Verified end to end**, in a real Codex session in this workspace, with the closed `holding` Book
and the Library's own bindings:

```
error=Command blocked by PreToolUse hook: Shelf Book 'holding' is closed, and a shell
command cannot read around that. Open it with tools/Set-VirtualDesk.ps1 ...
Command: wc -c shelf/holding/wiki/_index.md
```

So the denial is obeyed and its reason is surfaced verbatim — which is why every deny message in
this tree names the recovery step, since that sentence is the whole of what the session is told.

### Two things the investigation corrected

**Discovery.** `<repo>/.codex/hooks.json` **is** a documented discovery location, alongside
`~/.codex/hooks.json`, and Codex loads all matching layers without replacement — a Codex session in
this workspace runs the Library's hooks *and* any user-level ones. An earlier draft of this document
claimed Codex reads only `$CODEX_HOME/hooks.json`; that was wrong, inferred from a probe that failed
for a different reason.

**Trust, which is what that probe actually hit.** Codex records a `trusted_hash` per hook in
`[hooks.state]`, keyed by the hooks file's absolute path, event and index, and **an untrusted hook
does not run** — it is skipped, with no warning at the point of use: the shipped binary carries
no "untrusted hook skipped" string at all, only `skipping empty/async/prompt/agent hook` for other
reasons. So a fresh checkout's Library hooks are inert until someone trusts them once, and
`--dangerously-bypass-hook-trust` is the non-interactive escape used for the verification above.
Nothing in this repository can assert that trust has been granted; it is a per-machine step, and it
belongs in whatever onboarding note tells a reader to run `tools/Initialize-CodexLibrary.ps1`.

*(Corrected 2026-09-07. This paragraph said trust is granted “through `/hooks`”. There is no such
command: it is not a Codex chat command in the desktop app, and `codex --help` lists no `hooks`
subcommand. Trust is granted by a **startup review in the CLI TUI** — `tui/src/startup_hooks_review.rs`
in the shipped bundle, whose panel reads “New hook - review required … to trust all … Managed
hooks are always on”. So the trust grant needs `codex` launched in a **terminal**, in this workspace,
answering that prompt; the desktop app is a different surface and does not offer it. The distinction
is the same one seats already record for Orca: which surface you launch from decides what you get.)*

One further limit: Codex hooks cover local tools only — its shell, `apply_patch`, and MCP calls.
Hosted tools are excluded.

### `apply_patch` is guarded too, and its shape was captured rather than guessed

Until 2026-09-07 this section said `Guard-ShelfBookRead`'s `Write`/`Edit` coverage had no Codex
counterpart. It has one now, and the payload was captured before a line of it was written — because
the session that first bound these hooks guessed the shell tool was `exec` and shipped a matcher that
could never fire. Captured against codex-cli 0.147.0:

```json
{ "tool_name": "apply_patch",
  "tool_input": { "command": "*** Begin Patch\n*** Update File: probe.txt\n@@\n-alpha\n+beta\n*** End Patch" } }
```

**Two things a guess would have got wrong.** `tool_name` is `apply_patch` **verbatim** — it is NOT
normalised to a Claude Code name the way the shell tool becomes `Bash`. And `tool_input` carries **no
`file_path` at all**: it reuses the shell tool's `command` field, holding the whole patch document
with every path inside the envelope. Registering `apply_patch` against the existing guard without a
parser would have matched and then found nothing to judge — the same silent no-op as `^exec$`.

**One patch carries many files**, so every path is judged rather than the first, and `*** Move to:`
counts as a path because a rename into a closed Book is a write into it. Both readings of a relative
path are judged — against the payload's `cwd` and against the workspace — because judging only one
leaves the other as the way around.

**The directive list is an allowlist, and its cost was measured.** The first version admitted only
`Begin Patch` and `End Patch`, which would have refused every patch that appends to the end of a
file. A second capture, asking Codex to append a final line, returned `*** End of File`. It names no
file, so admitting it cannot hide a path — but the lesson is the rule's price: an allowlist fails
closed on what it has not been taught, so what it is taught has to come from a real payload.

Column zero is what makes a directive a directive. Patch content lines are prefixed with `+`, `-` or
a space, so a file whose own text contains `*** Begin Patch` appears as `+*** Begin Patch` and cannot
be mistaken for one — the same rule, for the same reason, as the column-zero H1 the Notebook renderer
learned the expensive way.

**Proven 2026-09-07, in a live Codex session against the closed `holding` Book.** Codex attributed
the refusal itself:

```
Blocked by hook
This patch writes 'shelf/holding/__no_such_page__.md'. Shelf Book 'holding' is closed. Open it with
tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug holding, then read its pages with
mcp__validated-book-reader__read_open_book_page.
```

Every link was observed rather than inferred, and that ordering was the point: Codex's own “Command
blocked by PreToolUse hook” is what establishes the hook FIRED, because a run that denies nothing
would have proved only that it never did. The matcher matched — Codex echoed the whole patch
document back as `Command`. The parser read the path out of the envelope — the message names a path
that appears only inside the patch body and never as a `file_path` field.

**The control that makes it a measurement rather than an anecdote.** One prompt, one binary, one
workspace, run twice with a single variable changed. With `LIBRARY_SEAT` unset the guard answered
`Virtual Desk failed closed: No seat is named`; with it set to `library-dev` it answered `Shelf Book
'holding' is closed`. Two different correct answers from one input means the guard reads the live
Desk rather than emitting a canned denial. The target path deliberately did not exist, so no outcome
could have written anything. Full record: [Seats](seats.md).

### `codex exec` does run hooks; a redirected `CODEX_HOME` was hiding them (2026-09-08)

The 2026-09-07 entry that stood here said no Library hook fires under `codex exec`, and that `exec`
was therefore an unguarded surface. **The observation was real and the conclusion was wrong.**
`codex exec` runs hooks. What it will not run is an **untrusted** one, and it has no interactive
review with which to become trusted -- so an untrusted hook is skipped in silence, which is
indistinguishable at the point of use from absent hook support.

Codex records hook trust in `$CODEX_HOME/config.toml` under `[hooks.state]`, keyed by the absolute
path of the hooks file plus its event and indices. Trust for this workspace was granted, and its
four `trusted_hash` entries do exist -- in `C:\Users\<you>\.codex\config.toml`. But Library work
starts from a terminal pane inside Orca, and **Orca redirects `CODEX_HOME`** to a runtime home of
its own. `codex doctor` names the substitution outright:

    CODEX_HOME = C:\Users\<you>\AppData\Roaming\orca\codex-runtime-home\home

That home's `[hooks.state]` carries eight entries, every one of them for Orca's own `hooks.json`,
and none for this workspace's. The trust store the delegate consults is not the trust store the
grant was written to. Project trust was never the missing piece: `trust_level = "trusted"` for this
workspace is present in both homes.

**The four-cell measurement.** One prompt, one binary -- the app bundle's
`...\Codex\bin\8e5b6932251c2c1c\codex.exe`, codex-cli 0.153.4 -- one workspace, `exec`
throughout, with only the trust variable moved. The command under test was a shell read of a page in
the closed `holding` Book.

| Cell | `CODEX_HOME` | Flag | Result |
| --- | --- | --- | --- |
| control, naming no Shelf path | Orca | none | ran, not blocked |
| the closed-Book read | Orca | none | **ran -- no hook fired** |
| the closed-Book read | Orca | `--dangerously-bypass-hook-trust` | **blocked** |
| the closed-Book read | `C:\Users\<you>\.codex` | none | **blocked** |

Attribution before result, as everywhere in this file: both blocked cells are attributed by Codex's
own `Command blocked by PreToolUse hook`, quoting the guard's sentence and echoing the command back.
The control cell is what makes row two a measurement rather than a broken harness -- the same binary
in the same home ran an unguarded command to completion, so rows three and four changed the outcome
by changing trust and nothing else.

The three home-directory paths above read `C:\Users\<you>\...` and were spelled with a real
username until 2026-09-19. **A dated measurement is a record, and this one lost nothing in the
substitution**: what it records is *which trust store was consulted* -- the user's own `.codex` home
against Orca's redirected runtime home -- and the identity of the user is no part of that. The
general ruling, made once here so it does not have to be made again for every dated path the
identity scan finds (PLAN-public-release.md step 12): **generalise the account, keep the structure,
keep the date.** A path is edited only where the private segment carries none of the observation; a
measurement that genuinely turns on whose machine it was is corrected by retracting it, never by
quietly rewriting it.

Two further facts fell out of the same runs. The bypass cell proves **discovery is not the problem**:
under the Orca home Codex found this workspace's `.codex/hooks.json`, parsed it, matched the shell
matcher, and ran the guard -- trust was the only gate. And both blocked cells answered `Shelf Book
'holding' is closed` rather than `Virtual Desk failed closed: No seat is named`, so the guard read
the **live per-seat Desk** from inside a non-interactive run.

**What this costs, and what closes it.** A per-machine trust grant is invisible at the point of use,
and no check in this repository can assert that one happened. Pinning `CODEX_HOME` at the delegation
command would work on this machine and nowhere else. So the delegation recipe now carries
`--dangerously-bypass-hook-trust`, whose documented purpose is this case exactly -- "intended only
for automation that already vets hook sources" -- and this workspace's hook source is tracked in git
and rendered from a tracked template by `tools/Initialize-CodexLibrary.ps1`.
`codex.delegation-runs-hooks` asserts the flag is present on every documented delegation command,
because a recipe is the only place this fix can live and a recipe loses a flag in an ordinary edit
without anything failing.

**The two installs are no longer at different versions.** The 2026-09-07 note that `codex` on `PATH`
was the npm build and the app bundle newer no longer holds: both report codex-cli 0.153.4, and the
`PATH` entry is an npm shim that runs `node .../@openai/codex/bin/codex.js`. "Say which installed
thing" still applies; the answer just no longer distinguishes a version.

One limit is untouched by any of this, and was not re-measured here: `[windows] sandbox = "elevated"`
makes `apply_patch` fail under `exec` with `ShellExecuteExW failed to launch setup helper: 1223`, a
cancelled UAC elevation, which blocks non-interactive delegation independently of hooks. New this
session, and only a fact rather than an explanation of it: `codex features list` on 0.153.4 reports
`elevated_windows_sandbox` as **removed**, so that config key names a mode this build no longer
lists. Whether the removal is what produces the 1223 is untested.

## The direct shared-write path, narrowed (2026-09-07)

`Guard-BasicMemoryRead` has always limited a direct `write_note` or `edit_note` to an exact open
active Project Hub path. It now refuses two further shapes inside that allowance, and both are
predicates `tools/Edit-ProjectHub.ps1` already carried — the guard was simply not asking them.

**`write_note` to a Hub root page, and only the root.** `projects/<slug>/_project.md` is the page
every session touches at close, so it is where two writers actually collide; it is also the most
structured page in the collection, so a whole-page overwrite from outside the helper is the
highest-cost write available. The helper journals the previous body, holds the `projects/<slug>` lock
across the write, and verifies the readback; nothing on the direct path does any of that. Every other
page under `projects/<slug>/` keeps the direct path deliberately: `notes/` and `limits/` are
append-only narrative where collisions are least likely and the escape hatch earns its keep, because
the helper has no remove-item mode. Both spellings of the title are refused (`_project` and
`_project.md`), because the tool takes a title and a caller may or may not carry the suffix.

**`edit_note` with anything but `replace_section` or `find_replace`.** The four operations `append`,
`prepend`, `insert_before_section` and `insert_after_section` duplicate content silently on a second
application, and nothing here journals a previous body or reads back what it wrote, so a retried
append is indistinguishable from an intended one. `write_note` is permalink-keyed, `replace_section`
is idempotent, and `find_replace` self-guards through `expected_replacements`.

**It is an allowlist, and that was decided by a failing test rather than by taste.** The first
version was a denylist of those four compared with `-cin`, copying the idiom from the retry
predicates in `Edit-ProjectHub.ps1` and `Add-CatalogEntry.ps1`. One self-test run found the hole:
`'Append'` is not `-cin` a lowercase list, so capitalising the operation walked straight past the
exclusion. Comparing case-insensitively would have fixed that one spelling and still admitted any
operation added to the tool later. **A guard that admits what it has not been taught fails open,
silently** — so the two known-safe operations are named and everything else is refused, an absent
`operation` included. Both directions are asserted in `desk.book-root-selftest`, capitalisation and
an invented `move_section` among them.

Note what this does *not* bound. The deployment serves streamable-HTTP with no authentication,
LAN-private by placement rather than by policy, so any process on the network can write the
collection. This removes the dangerous operations from the paths the Library controls; it is not a
security boundary and no client-side guard ever will be.

## A field the payload does not carry (2026-09-19)

Every hook here is handed a JSON payload by the harness and reads named fields out of it.
`Get-HookField` answers `$null` for a name that is not there, deliberately, because the payload's
shape varies by event. The consequence is that **a field the client does not send, or never sent,
costs a hook its entire job and produces no error anywhere.** It has happened twice:

| hook | read | actually sent | cost |
| --- | --- | --- | --- |
| `Restore-CompactedGuidance.ps1` | `startup_reason` | `source` | exited early on every SessionStart for four days |
| `Guard-SettingsIntegrity.ps1` | `config_source` | `source` | judged **no** real settings edit from 2026-09-06 to 2026-09-19 |

The second is the worse one, because that hook refuses rather than informs: for thirteen days the
"a settings edit cannot disable the guards" window in the table above was not a window at all. The
`.githooks/pre-commit` half was working throughout, so the boundary was never open to a change that
reached a commit — only to one that lived in the working tree.

**Both were invisible to a passing suite, for the same reason.** Section 5 of
`tools/Test-LibraryHooks.ps1` spelled the field `config_source` itself and then asserted all four of
the guard's denials correctly. The fixture and the hook agreed with each other and both disagreed
with the client. A fixture that supplies the input can only prove the code works when it is *given*
that input; nothing in it asserts the input **arrives**.

What now holds the field names is measurement:

- **`.claude/hooks/payload-contract.json`** records the field set of a payload actually captured from
  the client, per event, with its provenance. `PreToolUse`, `PostToolUse` and `ConfigChange` were
  captured on 2026-09-19; `SessionStart` on 2026-09-09 under `PLAN-seat-launch.md` step 0c.
  `PostCompact` is marked uncaptured with its reason — it is not reachable in `--print` mode — and
  every field the PostCompact hook reads is verified through SessionStart, which it is also
  registered on.
- **`hooks.payload-fields-are-captured`**, above the `-Fast` branch, parses every registered hook for
  `Get-HookField $call '<name>'` and `$call.<name>`, and fails on any read no captured event covers.
  It fails on a stale entry in `unverified_reads` as well, because an exemption nobody re-derives is
  how both of the instances above stayed invisible. It throws rather than passing when it finds no
  hook, no captured event, or no read.
- **`mkdir .claude/hooks/.capture`** turns capture on: while that directory exists, every hook writes
  the raw bytes it was handed into it, one file per invocation. It is gitignored, it is how the
  contract is re-measured after a client upgrade, and removing the directory turns it off.
- Section 12 of `tools/Test-LibraryHooks.ps1` drives the playbook hook and the settings guard with the
  captured envelopes themselves rather than with composed ones, so "the id arrives" and "the source
  arrives" are assertions rather than assumptions.

Falsified on introduction: putting `config_source` back reddens both the suite and the gate check;
planting `startup_reason` reddens the check; emptying the check's own AST match set makes it throw
"read nothing rather than proving anything" instead of reporting a clean run.

## Known gaps

- **A `cd` before the command.** The shell guard reads the command text, so a relative path issued
  after changing directory is judged against the wrong root.
- **`Restore-CompactedGuidance` cannot tell a development session from a reading one**, so an
  ordinary reader pays about a hundred and twenty words, once, per compaction. Threading a marker
  through the PreToolUse hooks was judged more coupling than the saving is worth.
- **A shell write into `notebook/` is ungated.** The `notebook/` rule lives in the Write/Edit guard;
  `Guard-ShellShelfRead` judges command text for Shelf paths only, so a heredoc reaches it.
- **A well-formed seat name no registry knows resolves as `named`**, so a write under `notebook/`
  from such a session is judged by ownership rather than by the seatless rule.

## Evidence

`library-hooks.boundary-suite` (`tools/Test-LibraryHooks.ps1`) spawns every hook as the real process
the harness runs, feeds it a real payload, and reads the real JSON back. It was mutation-tested on
introduction: disabling the shell guard's token scanner and rewording one playbook heading produced
18 failures across both subjects. One assertion in it is about this checkout rather than a fixture —
that the live `.claude/settings.json` registers every required hook under the events they act on.

`seat.lifecycle` (`tools/Test-SeatLifecycle.ps1`) case 16 drives `Get-SeatStartContext.ps1` the same
way, over every `source` value on its own row rather than one standing for the rest, and asserts the
binding on disk as well as the text. Thirteen routes through it were falsified one at a time and each
reddened at its own assertion; forcing the failed-bind path is what revealed that a refusal was
injecting the child's whole PowerShell stack — CategoryInfo, source line and a FullyQualifiedErrorId
repeating the message — into a reader's first turn. Reading the code would not have shown that.
