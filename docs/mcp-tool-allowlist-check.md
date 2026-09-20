# Teaching the allowlist check about the MCP adapter

**2026-08-19.** Design record for the gap that had been the closing note of three Phase 2 items
running. Built as the first act of the 2.5/2.6 session, before either of them, because it is what
tells that session whether its own work is visible.

## The gap

`helpers.manifest-matches-allowlist` compared `tools/*.ps1` against the permission allowlist in
`.claude/settings.json` and knew nothing about the validated reader adapter's tool list. The
consequence was asymmetric in the worst direction:

- A new **public helper** landed and the check **warned**, so the reader saw a line to add.
- A new **MCP tool** landed and the check raised **nothing at all**. The tool simply prompted once
  per session until a human happened to notice.

That is not hypothetical. Rung 6 added `discover_book_pages` and it went unnoticed until someone
tripped over the prompt. Item 2.3 added `search_open_books` and it sat unallowlisted for a day — the
only route by which anyone would have learned of it was a human reading a closing note. Item 2.4
deliberately added no MCP tool, partly for this reason, and recorded the gap for a fourth time.

## What was built

`tools/McpToolInventory.ps1` — an internal dot-sourced module, covered by
`mcp-tool-inventory.selftest` (43 checks, offline) and declared in `tools/_helpers.json`.
`helpers.manifest-matches-allowlist` now calls it and reports both halves of the same question in
one line.

Three decisions carry the design.

**The tool list is asked of the adapter, not kept beside it.** A check comparing the allowlist
against a hand-maintained roster of tool names would have built the drift it exists to fix — the
roster becomes one more place to forget, and it would have read clean on exactly the day a tool was
added. So nothing in this module knows the name of a single tool. `.mcp.json` names the servers and
the exact command line each one launches; the adapter answers `tools/list` over the same JSON-RPC
stdio channel the reader's client uses; the allowlist is read from the settings file as exact
entries. Every input is tracked configuration.

**It runs the adapter rather than reading its source.** The cheap implementation is a regex over the
adapter's source text for its `tools/list` block. This codebase has already paid for that shape:
rung 4's static scan counted a mention inside a block comment as a call, so its enforcement was
satisfiable by documentation. A static reader here would have to strip block comments before
matching and would *still* be a guess at what the adapter declares. Asking it is not a guess. The
`tools/list` branch reaches no network — the reader adapter establishes its remote session lazily, on
the first read that needs one — so the check stays offline, which is the property the whole gate
depends on. The trap is covered anyway: the suite's fixture adapter carries a tool name inside a
block comment, and a case asserts it never reaches the inventory.

**It warns, and does not fail.** `.claude/settings.json` is the reader's file and the Librarian is
refused it, so a missing allowlist line cannot be fixed by the process that finds it. Failing the
gate would block a commit on an edit the committer is not permitted to make. This is the same
asymmetry the public-helper half already draws, drawn the same way on purpose.

## What it cannot see, and says out loud

Only a server this workspace launches itself can be enumerated offline. `basic-memory` is an HTTP
server on the NAS: listing its tools needs the network and a session, and its allowlist is a curated
subset by deliberate policy rather than the whole tool list, so "declared but not allowlisted" would
be noise rather than a finding. Such servers come back as `not_enumerable` with the reason, and the
check names them **in every answer, clean or not** — a coverage figure that appears only when
something is wrong is a coverage figure nobody reads.

Three states fail rather than warn, because none of them is friction:

- `.mcp.json` missing, or declaring no servers.
- An adapter named in `.mcp.json` that is not a file in this workspace. The reader's client is
  pointed at nothing; the tool is not prompting, it is absent.
- An adapter that starts and returns no `tools/list` result, declares a tool with no name, or does
  not answer within 30 seconds. A silent adapter read as "declares nothing" is exactly the quiet
  clean answer this check exists to prevent, and an adapter that blocks would otherwise hang the
  pre-commit hook rather than fail it.

## What it proves

**43 offline checks.** The fixture adapter is a real script launched as a real process over
redirected stdin, because the invocation is the half that can actually break; a mocked invoker would
have tested the comparison, which cannot.

**Two defects fell out before the suite was green**, both in the module rather than in the fixtures.
`, @(...)` at a function's return prevents PowerShell unrolling the array, so every caller received
one array object where it expected a list — the comparison was being handed a whole collection as a
single tool name. And reading `[string]$_.name` on a tool object that has no `name` threw a raw
`Set-StrictMode` error instead of reporting the nameless tool, so the case written to catch it
failed for the wrong reason. A third was in the suite itself: an assertion passed a string where a
boolean was required, which aborted that block and hid every check after it — the same shape as
2.2's rung 6 finding, and the reason the count is 43 rather than the 25 the first run reported.

**Both mutations were watched fire against real input**, not against fixtures:

- A copy of the real `.claude/settings.json` with `search_open_books` removed → the status reports
  `mcp__validated-book-reader__search_open_books` missing.
- A copy of the real adapter declaring one extra tool → the status reports
  `mcp__validated-book-reader__brand_new_tool` missing.

Neither mutation touched the reader's own settings file or the live adapter.

**A near-miss cannot satisfy a tool.** Comparison is against exact allowlist entries, case-sensitive,
so `mcp__srv__search_thing_extra` does not cover `search_thing` and `mcp__srv__Search_Thing` does not
either. Substring matching would have let a check read clean while the prompt still fired — which is
the failure being fixed, in a subtler form. Server-wide entries (`mcp__srv` and `mcp__srv__*`) do
cover, because they genuinely do.

## Gate after this change

`27 passed, 1 warned, 0 failed` with `-IncludeShared`. The added check is
`mcp-tool-inventory.selftest`; `helpers.manifest-matches-allowlist` now reads
`48 helpers and 8 MCP tool(s) from 1 local adapter(s); not enumerable offline: basic-memory --
allowlist consistent`. The single remaining warning is `context.always-on-budget`, which item 2.6
owns.

From here, an MCP tool added by a later item warns exactly as a public helper does, and the fourth
recording of this gap is not needed.
