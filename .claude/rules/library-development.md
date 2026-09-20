---
paths:
  - "tools/**"
  - ".claude/**"
  - "docs/**"
  - ".githooks/**"
---

# Working on the Library itself

This is development guidance, not reader guidance. It is scoped to the files it applies to, so it
costs nothing in an ordinary session where the reader is using the Library rather than changing it.

## The standing rules

- The Library is in active development. Fix an observed defect promptly and keep the regression
  check that proves it stays fixed. A fix without a check is a fix that comes back.
- Before changing the reader experience, write down its **reader benefit** and the **safety
  boundary** it must not cross, then test the change against ordinary reader requests — not only
  against fixtures. A boundary that only fixtures have ever crossed has not been tested.
- Run `tools/Invoke-LibraryChecks.ps1 -Fast` after any change to a tool, a hook, or the reader — 23
  seconds, and exactly what the pre-commit hook fires. Static checks run in both modes.
  `-IncludeShared` adds the checks that reach the NAS. The bare full run spawns ~50 helper
  self-tests and takes 20+ minutes: a phase gate, to be backgrounded, never an interactive wait.
- For an audit or lint, report the inconsistencies, broken links, and gaps first. Make no
  non-mechanical change until that report has been read.

## Standing facts about the build recipe

Conditions of the next change rather than records of a past one. Moved here from the `library-dev`
Hub's `Now` section on 2026-09-03: a Hub holds orientation and open items, and this is neither.

- **Every new script in `tools/` needs a row in `tools/_helpers.json`, whatever its role.** An
  undeclared one is a hard `[ FAIL ]` on `helpers.manifest-matches-allowlist`, in both directions: a
  declared name missing from disk fails too. Write the row in the same pass as the file.
- The **allowlist** is the separate half, and only a **public** helper raises it. The reader adds the
  one-line entry to `.claude/settings.json`, which the Librarian is refused — that refusal is the
  guard working, and it only warns, because prompt friction is not worth blocking a commit on an edit
  the committer cannot make. An **internal** or **test** helper needs no allowlist line and must not
  have one: a dot-sourced file that IS allowlisted is silently runnable when nothing should invoke it,
  and that half throws. Corrected 2026-09-10, because the previous wording said an internal helper
  "raises nothing", which read as "a dot-sourced file owes nothing" and cost a full `-IncludeShared`
  gate run to discover otherwise.
- **DELETING a helper owes the allowlist an edit too, and that direction was unwatched until
  2026-09-19.** The check walked the manifest and asked whether each declared helper was
  allowlisted; nothing walked `.claude/settings.json` and asked whether an allowlisted path still
  existed. So step 10's two deleted delegates left their lines behind in silence, and turning the
  question around immediately found a **third**, for a helper long gone. It warns rather than fails,
  for the same reason the friction half warns — only the reader can edit that file — so a stale
  line is reported on every commit until somebody removes it. This is the both-ways rule further
  down, applied to a list nobody had noticed was a list.
- A new **MCP tool** on the validated reader needs an allowlist line too, and that one **is**
  reported: the same check asks each locally launched adapter for its tool list over JSON-RPC and
  warns on a tool the allowlist does not name. Record: `docs/mcp-tool-allowlist-check.md`.
- A `bash`-tagged fence carries a Run button in this client, so a snippet written for the reader is
  tagged `powershell` or nothing.

## The repository root is a shared namespace

More than one project is developed inside this checkout. The Library is one of them, not the only
one, and **the root's generic filenames belong to whoever writes them last.**

Every plan file at the root declares the Project Hub that owns it, on its own line under the
heading, and `workspace.plans-declare-their-owner` fails the gate without it:

```markdown
# Plan: <title>

> **Owner:** library-dev
```

**A plan whose subject is not the Library must be namespaced** — `PLAN-<slug>.md`,
`PLAN-REVIEW-LOG-<slug>.md`. The unqualified `PLAN.md` and `PLAN-REVIEW-LOG.md` are reserved for
this workspace, because roughly nineteen sources cite `PLAN.md` **by item number** — "PLAN.md 2.2",
"item 0.1", "3.1" — across `docs/discovery-manifests.md`, `docs/hit-is-a-location.md`,
`docs/scoped-raw-search.md`, `docs/book-root-state-schema.md`, `RawSearch.ps1`,
`BookManifestTransaction.ps1`, `BookRootSchema.ps1`, `Update-SharedBookManifests.ps1`, and the reader
adapter. `Rename-ShelfBook.ps1` rewrites into it as a Library self-file beside `CLAUDE.md` and
`CONTEXT.md`.

**Why this is enforced rather than trusted.** On 2026-08-31 a second product's plan was found in the
working tree on top of the Library's own 922-line plan, reduced to 113 lines and uncommitted. The
repository was clean; one `git add -A` would have destroyed it and left every one of those citations
pointing at a different product. Two earlier sessions had already namespaced their plans by hand, so
the convention existed — it simply had nothing behind it.

**`docs.links-resolve` cannot catch this.** It passes whenever the file exists. A link resolves
perfectly while the content it names has been replaced; ownership is what a citation actually
depends on, so ownership is what is checked.

**The plan-authoring skills default to `PLAN.md`.** `claudex-loop`, `codex-review` and
`grill-with-docs-codex` all write there unless told otherwise. In this repository that default is
wrong for anything but the Library's own plan — pass a namespaced `PLAN_FILE`, and read the file
before writing it.

Note the asymmetry worth remembering: the **shared collection is not the vector.** Books and Project
Hubs are namespaced by slug and cannot collide. Only the local root is a free-for-all.

## Defect families this codebase keeps producing

Three of the seven are linted by `powershell.defect-families` — 1, 2, and 5 — so do not sweep for
those by hand; fix what it reports. 3, 4, 6 and 7 are documented only, by decision: none can be
caught without flagging correct code, because in each the wrong call and the right one are the same
shape.

1. **Case-insensitive operators on a lowercase-only rule.** `-match`, `-notmatch`, `-like` and
   `-notlike` ignore case, so a rule spelled `[a-z0-9]` accepts `Odysseus` and writes state nothing
   else will match. Use the `-c` variants.
2. **A collection unrolled by the pipeline — in EITHER direction, and the lint reads both.**
   *Consumption:* a pipeline result counted or indexed without `@()`; a pipeline yielding exactly one
   item unrolls to a bare scalar, and `.Count` or `[0]` on it throws under `Set-StrictMode`.
   *Production*, added 2026-09-09 after the class bit three times in one hour: a call that can
   legitimately return an **empty** array — `ReadAllBytes`, `ReadAllLines`, `GetFiles`,
   `GetDirectories`, `GetFileSystemEntries` — sitting where its value travels the pipeline, which is
   `return <expr>`, a bare trailing statement, or an `if`/`foreach`/`switch` statement used as a
   value. Empty unrolls to *nothing*, so the caller receives `$null` and dies inside `GetString`,
   `ToBase64String` or `.Length` — naming a null array rather than the file, which sends the
   diagnosis to the caller. Assign it directly, or wrap it in `@()`, `$()`, a cast or a comma; all
   four are safe and none is flagged. `Split` is deliberately outside the set, because splitting even
   an empty string yields one element. **An empty file is a first-class input** — a seat's two Desk
   files and a fresh derived index are all created empty.
3. **A list parsed one line at a time.** No lint covers this one and it has bitten three times: a
   wrapped bullet loses its continuation, and a CRLF file leaves a `\r` inside the line so a `[ \t]*$`
   tail matches nothing where `\s*$` would. Parse the item, not the line.
4. **A member collection's aggregate property read without enumerating.**
   `$o.PSObject.Properties.Name` throws under `Set-StrictMode` when the collection is empty
   instead of yielding nothing, so a fresh object or an empty journal takes the whole run down. The
   lint does not cover it: that one looks for `.Count` and `[0]` on a pipeline, and this is
   neither. Enumerate instead: `@($o.PSObject.Properties | ForEach-Object { $_.Name })`.
5. **A local variable reusing a script parameter's name.** It *is* that parameter — PowerShell
   variable names are case-insensitive, so `$preflight = Get-ChildPreflight $action` assigns an
   object to a `[switch]$Preflight` declared thirty lines above. The expense is the diagnosis, not
   the bug: the failure is reported against the script's own parameter binding with the stack
   pointing at the caller, so every obvious reading sends you to the invocation. Rename the local.
   The lint exempts `[string]` parameters, because the default-if-unset idiom reassigns those on
   purpose — so a `[string]` shadow is still yours to avoid.

6. **A lone array argument passed to a script method's `.Invoke()`.** `.Invoke()` takes a `params`
   array, so `$scope.'Get-Mask'.Invoke($lines)` does not pass `$lines` as one argument — it *spreads*
   it across the function's parameters and binds only `$lines[0]`. A `[string[]]` parameter silently
   receives one line, and the failure surfaces later as an index out of bounds on a result sized to
   the wrong length. Two or more arguments bind correctly, so this only bites the single-array case
   and only where functions are reached through a module object rather than called directly. Write
   `.Invoke((, $lines))`. No lint covers it: the call is well-formed and the arity is legal.

7. **A `[hashtable]`'s `Keys` are not in insertion order, and a trim that assumes they are evicts
   the wrong entry.** `@($table.Keys)[-20..-1]` reads as "keep the last twenty". A hashtable
   enumerates by bucket, not by age: measured on 2026-09-19 against a full twenty-entry ledger, a
   newly added key came out FIRST for every id tried, so the trim kept the twenty **oldest** and
   dropped the one just written. `.claude/.hook-served.json` froze at exactly twenty sessions and
   recorded nothing from then on — every just-in-time playbook section re-injected on every matching
   tool call for the life of every session, `Clear-HookServed` with nothing to clear, and a file that
   looked healthy because its bytes came out identical. Two reports read it as a blank `session_id`
   and one of them ran an experiment that could not tell the two apart. Use `[ordered]@{}` wherever
   order is load-bearing, and type the parameter `[System.Collections.IDictionary]`: `[hashtable]`
   coerces an ordered dictionary back to an unordered one on the way in, silently, and the defect
   returns with no diagnostic at all. No lint covers it — the same expression is correct on an
   ordered dictionary, and the two are the same shape.

An eighth hazard is environmental rather than structural, and no lint can see it. **`Get-Content -Raw`
in Windows PowerShell 5.1 reads a BOM-less file as ANSI**, so a read-modify-write round trip through
`Get-Content`/`Set-Content` silently turns every em-dash into `â€"`. It bites `docs/` and `*.md`,
and it bites **most of `tools/` too**: as of 2026-08-20 only 5 of 55 PowerShell sources carry a BOM,
and two BOM-less ones already hold non-ASCII. Assume no BOM anywhere. Use `[IO.File]::ReadAllText` and
`[IO.File]::WriteAllText` with `UTF8Encoding($false)`, which also preserves the *absence* of a BOM
where `Set-Content -Encoding utf8` would add one.

## Adding a check or a self-test

Moved here from the `library-dev` Hub's `connections` page on 2026-09-08: these are conditions of
the next change, not records of a past one, so they belong beside the code they govern.

- **Check *where* it runs, not only that it passes.** A suite can be green and unreached. Two
  instances, both found by accident rather than by a failure: `Get-MeterStatus.ps1` carried a
  `-SelfTest` from 2026-08-18 that **nothing ever ran**, found only when a check was registered for
  it two days later; and a Phase 2 check sat inside the `-Fast` conditional's `else` branch, so it
  ran in the full gate and never in the pre-commit hook. Register the suite, then confirm it appears
  in the run you expect it to appear in.
- **A new spawned suite goes in the `-Fast` roster as well as in the `else` branch.** A name in one
  and not the other neither runs in `-Fast` **nor** is reported skipped, so the hook's summary
  silently counts one fewer. `gate.fast-roster-matches-suites` derives both sets from the AST and
  compares them, so a forgotten name now fails the gate instead of going quiet.
- **A list that stands for a table is checked BOTH WAYS, or the copy falls behind.** Twice now the
  same shape has shipped. `Invoke-LibraryChecks.ps1` holds the spawned-suite names as calls *and*
  as a `-Fast` roster string, and a name in one and not the other went quiet until
  `gate.fast-roster-matches-suites` compared the sets. Then on 2026-09-08
  `Test-LibraryHooks.ps1` was found asserting its `$routes` list against
  `Get-PlaybookContext.ps1` and the playbook, but never the hook's table against the list -- so a
  route added to the hook and not to the test was asserted by nothing, and
  `Copy-LocalPagesToProject.ps1`, a **gated shared write**, had no playbook served for it at all.
  Whenever a check enumerates a hardcoded list to stand for a table defined elsewhere, derive the
  other side and compare in both directions; a missing entry and a stale entry are different
  faults, and only one of them is loud. **Never a hardcoded count** -- derive both sets.
- **A fixture that SUPPLIES the input proves the code works when given it, never that it arrives.**
  Two hooks have now spent weeks dead on a payload field that was not there, while a suite asserted
  their behaviour correctly the whole time: `Restore-CompactedGuidance.ps1` read `startup_reason`,
  and `Guard-SettingsIntegrity.ps1` — a guard that *refuses* — read `config_source` where the
  payload carries `source`, so it judged no real settings edit between 2026-09-06 and 2026-09-19.
  In both cases the fixture wrote the field itself, so the assertion and the hook agreed with each
  other and both disagreed with the client. Anything crossing a boundary this tree does not control
  is pinned by a CAPTURED sample: `.claude/hooks/payload-contract.json` holds one per event, the
  gate check `hooks.payload-fields-are-captured` fails on a read no capture covers, and
  `mkdir .claude/hooks/.capture` is how the captures are taken again after a client upgrade.
- **A fixture must reach the threshold, or the branch that threshold guards is never executed.** The
  serve ledger caps at twenty sessions and every case in `Test-LibraryHooks.ps1` ran under ten, so
  the trim branch — which was wrong — was reached by nothing for as long as it existed. A fixture's
  CARDINALITY is part of its coverage, not an incidental of how it was written: two items hide a
  truncation where three reveal it, and a cap of N needs N+1.
- **A new Shelf writer must route its manifest.** `shelf.writers-route-manifests` is what will tell
  you, in two parts because neither alone is enforcement: a static scan keyed on the lock's Book root
  catches a writer that never routes, and a behavioural run against a fixture Shelf catches routing
  that is present and broken. **No Claude-side hook runs in a delegate process**, so the gate is the
  only thing standing between a delegated writer and a stale manifest.
- **A check must be run against a FIXTURE as well as against the real tree, and its fixture cases are
  what stop it going vacuous.** Both halves cost a session on 2026-09-09. A new detector was given a
  guard that threw when it matched nothing — right against this repository, and wrong against the
  one-file scratch workspaces `Test-LibraryHelpers` builds, where zero is the correct answer. It
  failed two of that suite's **negative controls**, which is the guard reporting on the fixture's
  shape rather than on the detector; scope a whole-tree assertion to the whole tree
  (`$workspace -ceq (Split-Path -Parent $PSScriptRoot)`). The deeper half: a **count** cannot prove a
  detector still matches anything, because zero is legitimate somewhere. Fixture cases can — plant
  the fault, expect `fail`, and emptying the detector's own match set then turns every positive
  green. Verify that by doing it, not by reasoning about it. And pin **both directions**: the
  positives, and the safe forms that must NOT be flagged, which are what stop the check firing on
  correct code.

## Before you write to durable storage

Every writer for a Book takes **that Book's** lock from `tools/BookWriteGuard.ps1` before it reads
or journals prior state, and holds it through commit or through a completed rollback. The lock is
the Book's, not any one helper's — a lock applied to a single writer is not a lock. Journal the
prior body of every page the operation will change and the prior **absence** of every page it will
create, so a rollback deletes rather than resurrects, and verify the rollback by readback.

Anything consequential or destructive takes a preflight, an exact `plan_id`, and one approval.
Check the destination for a collision **before** issuing that `plan_id`: an approval for an
operation already certain to fail is worse than no approval.

A write that provably cannot lose text applies directly. If you find yourself filtering the damage
an "additive" write can do, it is not additive.

## The always-on context surface

`context.always-on-budget` counts every instruction surface that loads in each session: `CLAUDE.md`,
each Skill's frontmatter description, and any rule here without `paths:` frontmatter. It warns at 90%
of either ceiling.

When it binds, move words into a **path-scoped rule** like this one, or into a Skill body. Never into
an `@path` import: imports load at launch, so they move the words out of the count without moving any
of the cost, passing the check while changing nothing.

Note the tradeoff this file accepts: a project-root `CLAUDE.md` is re-injected after a `/compact`,
and a path-scoped rule is not — it reloads the next time a matching file is read. So process guidance
belongs here, and anything that must survive a long session unbroken — the Desk gate, the closed-Book
rule, the approval rule — stays in `CLAUDE.md`.
