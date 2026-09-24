# ADR-0036: A direct install registers its guards from `library init`, by absolute path

**Status:** accepted; amended 2026-09-21 (the hook block goes to `.claude/settings.local.json`)
**Date:** 2026-09-21
**Effective from:** Phase C of `PLAN-public-release.md` (step 20, `tools/Initialize-LibraryWorkspace.ps1`)
**Supersedes:** nothing. It settles a question step 19 and step 20 each assumed the other had answered.

## Context

The split design gives the program its hooks and the workspace its material, and says hooks reach a
reader's session through the plugin. `library init` was written to that rule: it merges the
permission allowlist into the workspace's `.claude/settings.json` and writes no hooks, and it writes
no `.mcp.json` either unless the workspace holds an adapter of its own.

The first session rooted in a split workspace found that this leaves the reader with nothing. On
2026-09-21 the migrated workspace registered **no hooks and no MCP server**: a session sitting there
had no Desk boundary, no closed-Book guard, no shell Shelf guard, and no tool with which to read an
open Book. The program's own settings were unaffected, so a session rooted in the
program was fine — it is sitting *inside* the workspace that was unguarded, which is the only place
a reader ever sits.

Two facts closed off the route the design assumed:

- **The plugin's components do not activate.** S14 measured four negatives, each with its own
  control: no plugin MCP tool in a session (the server reports `"status": "failed"` in the harness's
  own `init` event), the adapter never launched, the hooks never fired, the skill never listed.
- **The package would not restore the boundary even if they did.** The plugin declares **four** of
  the program's nine hooks, across two of its six events, and two of its three `PreToolUse` matchers
  are Codex tool names — `^apply_patch$` and `^(Bash|exec)$` — which a Claude session never emits.
  `tools/PluginPackage.ps1` rewrites `${PLUGIN_ROOT}` to `${CLAUDE_PLUGIN_ROOT}` and translates
  nothing else, and `plugin.generated-files-match` judges agreement and shape rather than coverage.

So "the plugin supplies the guards" was not a thing waiting to be switched on. It was two unbuilt
jobs, and the workspace was unsafe to sit in for as long as either was outstanding.

## Considered options

**(a) `library init` registers the hooks and the reader, by absolute path into the program, for a
direct install.** Chosen, by Eric on 2026-09-21. The registrations are derived from the program's
own `.claude/settings.json` rather than written out a second time here, so a hook added to the
program reaches a newly initialised workspace by the same edit that registers it.

**(b) Make the plugin load first.** Rejected as the route to a guarded workspace, not as a goal. It
remains where the design is going and it is what the public one-line install needs; it is at least a
session's work on a cause four controlled measurements have not yet found, and it produces no
guarded seat until the package's missing five hooks and its two Codex-only matchers are also fixed.

**(c) Write passthrough shims into the workspace** and register those with `${CLAUDE_PROJECT_DIR}`,
so the workspace holds exactly one absolute pointer. Rejected: it puts a forwarding layer in the
guard path, where stdin, exit code 2 and stderr must each be relayed exactly, and a bug there fails
**open** and silently — the one failure mode this boundary must not have.

## Decision

`library init` registers, into the workspace's `.claude/settings.local.json`, every hook the
program's own settings declare, with `${CLAUDE_PROJECT_DIR}` resolved to the program root; it merges
the permission allowlist into the tracked `.claude/settings.json` as before; and it writes the
validated reader into the workspace's `.mcp.json`, pointing at the program's adapter and naming the
workspace with `-StateDirectory`. All three are skipped where the program and the workspace are one
directory, which already has them.

### Amended 2026-09-21 (S19): the hook block goes to the *untracked* settings file

As first written, this ADR put the hook block in the tracked `.claude/settings.json`, and S18 left
the resulting edit uncommitted rather than decide for the reader. Eric ruled on 2026-09-21 that it
belongs in `.claude/settings.local.json`.

The block is **absolute paths into one machine's program**. The reader's workspace is a repository
whose own `.gitignore` states that what stays out is "anything that is large, re-fetchable,
machine-local, or somebody's network address", and these are the third of those. Committed, they
reach another machine as registrations naming scripts that are not there — and a hook that exits
non-zero with empty stdout is a **non-blocking error** to Claude Code, so that is this boundary
failing open in a clone. Untracked, a clone has no hook block at all, which `workspace.guards-registered`
reports as the loud failure it is, with `library init` as the named repair.

Three facts made it a small change rather than a design one: the harness reads both settings files,
every consumer that asks whether the guards are registered already reads both
(`Get-HookRegistrationProblems`, `workspace.guards-registered`, `Guard-SettingsIntegrity.ps1`, and
the adapter's launch validation), and the workspace's `.gitignore` already excluded the local file.

Two consequences are worth stating because neither is obvious:

- **The whole block moves, or none of it.** The adapter's launch validation faults on a
  `settings.local.json` that declares a `hooks` block *without* the guards in it — the shadowing
  case. Half the block in each file is the one arrangement that reads as a fault whichever way the
  harness resolves the two.
- **`library init` removes the block it previously wrote into the tracked file**, judged by the same
  ownership rule, so the move is a move rather than a second copy. A block the *reader* wrote there
  is theirs and is left alone; a fixture pins that direction, because `library init` silently
  deleting a reader's own hook registration out of a tracked file is the failure nothing would see.

`.mcp.json` has no local variant and stays where it is. It carries the same machine-local pointer, so
it is excluded by the workspace's `.gitignore` instead.

The hook block is **owned**, and ownership is read from the entries themselves: a block whose every
entry names a script under this program's hook directory is one this tool wrote and is replaced
whole, so a retired hook leaves rather than being unioned back in. A block holding anything else is
the reader's, and `library init` refuses rather than overwriting it, naming the entries.

## Consequences

- The registrations are **absolute pointers into the program**, because `${CLAUDE_PROJECT_DIR}` in a
  workspace session resolves to the workspace and the hooks are not there. A program that moves must
  rewrite them. That is what the cutover protocol's pointer stage (step 6c) is for, and re-running
  `library init` does it in one step.
- They are deliberately **not mirrored into `.library/workspace.json`**. The registered paths are the
  pointer; a second copy of the same fact is a second chance to be wrong.
- `workspace.guards-registered` fails the gate when a workspace registers no guards, when one of
  them names a script that is not there, and warns when the reader's own server is absent. Before
  this ADR nothing reported any of the three, which is why a green gate coexisted with a workspace
  nobody could safely sit in.
- Phase C's "a seat opens from Orca in both harnesses **through the plugin**" is met by a direct
  install instead. The plugin route is unchanged as the v1 install story and keeps its own row.
- ~~Codex is **not** covered by this.~~ **Superseded 2026-09-22 by the amendment below**, which
  extends the ruling to `.codex/hooks.json` and `.codex/config.toml` and records the trust gate that
  decides whether Codex reads either.

## Amended 2026-09-22: Codex is covered too, and a third gate decides whether any of it runs

The last consequence above said Codex was not covered and named the open question. It is covered
now, and the question turned out to have a different answer from the one the plan assumed.

`library init` writes two more files into a split workspace: **`.codex/hooks.json`**, the same four
guards the program's own Codex bindings register, pointing at the same absolute program paths; and
**`.codex/config.toml`**, declaring the validated reader with this workspace's state directory. Both
are rendered from the program's tracked templates by token substitution into text — never by
rebuilding a parsed document — through one renderer, `tools/CodexBindings.ps1`, which the program's
own `Initialize-CodexLibrary.ps1` now shares. Ownership and refusal work exactly as above: the hooks
file is judged by its own entries, the config by a managed marker line, and a file the reader wrote
is refused rather than overwritten, with nothing else written either.

**The workspace's Codex config registers the validated reader and nothing else**, where the
program's also registers `basic-memory`. The reasoning is the one that keeps `basic-memory` out of a
workspace's `.mcp.json`: the two files share a trust gate but not a parser, so a hooks document that
fails to parse beside a config that parses fine would leave `mcp__basic-memory__*` serving with the
Desk boundary absent.

**And the gate that decides whether either file is read at all is neither of them.** Measured
2026-09-22 on codex-cli 0.153.4, in a fixture, one variable moved at a time:

| project trusted in `$CODEX_HOME/config.toml` | what was in the project | what Codex did |
| --- | --- | --- |
| no | `.codex/config.toml` declaring one MCP server | `codex mcp list` → `[]` |
| yes | the same file | that server, in `mcp list` and in `doctor` |
| no | a deliberately malformed `.codex/hooks.json` | **nothing at all** |
| yes | the same file | `failed to parse hooks config <path>: unknown field ...` |

So `<project>/.codex/hooks.json` and `<project>/.codex/config.toml` are both real discovery
locations, both found by walking up from the session's working directory — and both are ignored **in
silence** until the project carries `[projects.'<path>'] trust_level = "trusted"`. A workspace can
hold a perfect Codex boundary and run with none.

**Trust is reported, never granted.** It is a security decision about a machine, recorded in a file
no workspace owns, and this machine has two Codex homes because Orca substitutes `CODEX_HOME`. So
`workspace.codex-guards-registered` fails on a workspace whose Codex bindings are missing,
malformed, mis-registered or pointing at scripts that are not there, and **warns** — naming the home
it actually read — when the files are correct and the project is untrusted. Hook trust, the third and
narrowest gate, is granted by the client's own startup review panel and nothing here can assert it.

One thing this amendment also fixed rather than introduced: the program's own generated `.codex/`
bindings had named `D:\Library` since the migration retired that path on 2026-09-21, and
`codex.project-access-config` was green over it for a day — it asserted sections, events, names and
matchers, and never that any of the five files existed. It resolves every path it names now.
