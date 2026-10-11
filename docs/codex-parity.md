# Codex parity record (first draft)

This first draft compares reader-visible Deskpost behavior in Claude Code and Codex against the approved `deskpost-desk` Codex parity plan. Status means **same** (the same result), **close** (a visible difference), or **not possible yet** (no working Codex route has been proved). A registration alone does not establish a real-session effect.

## Hook and tool surface inventory

The inventory below is from the tool catalog exposed to the `deskpost-codex-dev` session on 2026-10-11, the tracked Codex hook templates, and the kernel hook implementations. A hook matcher runs only for names it matches. Hooks are best effort: if one is untrusted, disabled, errors or times out, a direct file read may proceed. The kernel and validated reader enforce closed content only for calls through the reader. An instruction is guidance, not a guard.

| Codex surface | Deskpost hook coverage | Fallback or limit |
| --- | --- | --- |
| `Bash` and `exec` shell calls | `shell-shelf-read` on `PreToolUse`; `search-hit` on `PostToolUse` for raw search | No kernel fallback for a direct file read. The shell guard judges command text, not resolved paths. An untrusted, disabled, failed or timed-out hook leaves this surface below the trust bar. |
| `apply_patch` | `shelf-read` on `PreToolUse` | No kernel fallback for a direct file edit. The patch guard judges paths in the patch envelope. Other file tools have no Codex matcher in the project template. |
| `mcp__basic_memory__*` | `basic-memory-read` on `PreToolUse` | The project config disables this server in this Library workspace. Where enabled, direct Book and Project reads still depend on the guard and the open Desk. |
| `mcp__validated_book_reader__*` | `search-hit` on `PostToolUse` for `discover_book_pages` and `search_open_books` | The validated reader enforces open Book and Project reads. Catalog and discovery locate material; page reads are required for answers. This session read the open parity plan through it after the seat binding was repaired. |
| `mcp__agent_mail__*` | No Deskpost hook in the Codex template | Separate service. Deskpost letters use `deskpost capture letters`; the letter and ring rules are instruction-led. |
| `mcp__codex_apps__*` connector calls | No Deskpost hook in the Codex template | The Library workspace disables the computer-use plugins that serve `cua_repl`; other connector calls remain instruction-led. |
| `web__run`, `image_gen__imagegen`, `view_image` | No Deskpost hook in the Codex template | No Library-content guard. Do not direct these tools at a Book or Project page. |
| MCP resource list/read calls | No Deskpost hook in the Codex template | No Library-content guard. Do not use them as an alternate Book or Project content reader. |
| `exec_command`, `apply_patch`, and other host tool APIs exposed through orchestration | Only tool names actually delivered to `PreToolUse` are covered; captured shell name is `Bash`, captured patch name is `apply_patch` | No fallback for direct file access. A wrapper or new tool name needs a real-session capture before claiming guard coverage. |
| Session start, compaction, prompt, and completed tool events | `desk-context` on `UserPromptSubmit`; `seat-start` and `compact-clear` on `SessionStart`; `compact-clear` on `PostCompact`; `search-hit` on `PostToolUse` | Trust and hook review in the active Codex home are required. `doctor` currently reports review presence, not a stale hash; launcher preflight and hash accuracy are later units. Real-session output contract rows remain to be exercised. |

The `node_repl` server and computer-use plugins that serve `cua_repl` are disabled in this Library workspace, as is `librarian`. Those are workspace config exclusions, not Deskpost hook coverage. Since 1.4.3 the render turns off every server and plugin the Codex user config turns on, except the validated reader (`docs/hook-enforced-boundaries.md`, "Servers and plugins load in layers too"). An effective-server allowlist and launcher preflight belong to plan steps 4b and 4c. Until then, a supported Codex tool that can read files without a working guard means the trust bar is not met.

## Reader-visible behavior

| Behavior | Claude Code form | Codex form | Status |
| --- | --- | --- | --- |
| Find the current seat and open Desk | `UserPromptSubmit` Desk context plus `deskpost desk` | Same Desk command and project `UserPromptSubmit` hook | Same after the reader's seat binding was repaired; first-prompt delivery remains a real-session check. |
| Refuse a closed shared Book or Project read | Basic Memory guard and validated reader | Basic Memory guard for `mcp__basic_memory__*`; validated reader | Same through the validated reader. Direct Basic Memory access depends on a trusted hook and is part of step 4c. |
| Refuse a closed Shelf Book shell read | `PreToolUse` shell guard | `PreToolUse` matcher for `Bash|exec` | Same for captured `Bash` calls; real-session denial was established before this draft. |
| Refuse a closed Shelf Book edit | `Read|Grep|Glob|Write|Edit` guard | `apply_patch` guard | Close: the captured patch path is covered; other Codex file surfaces require inventory and captures. |
| Restore seat context on session start and resume | `seat-start` on `SessionStart` | Same kernel verb registered for Codex; `source` is read from its SessionStart payload | Close until a real Codex session shows the text in model context. |
| Clear served Desk context on session start and after compaction | `compact-clear` on `SessionStart` and `PostCompact` | Same kernel verb registered for both events | Close until a real compaction shows the ledger clear and Desk context re-serve. |
| Remind that search hits are locations | `search-hit` on `PostToolUse` | Same kernel verb registered for MCP and shell search | Close until the reminder is observed in the next real Codex model context after both searches. |
| Protect changes to harness settings | `settings-integrity` on `ConfigChange` | No Codex `ConfigChange` event | Not possible yet; independent launcher preflight is planned in 4b. |
| Use one instruction file | Claude Code imports `CLAUDE.md` | Codex reads `AGENTS.md` | Close: the repository currently carries separate prose; the approved plan schedules a one-line Claude import later. |
| Operate the Library from the command line | `deskpost` kernel verbs | The same `deskpost` kernel verbs | Same where the launcher supplies the same workspace and seat context. |
| Dashboard, relay, gates, and closeout controls | `deskpost-mods` Claude Code plugin | No Codex mod port in this unit | Not possible yet; planned later. |

Sources: the open `deskpost-desk` Project pages `notes/2026-10-10-codex-parity-plan` and its review log (read through the validated reader); `.codex/hooks.template.json`; `.codex-plugin/hooks.json`; `.claude/settings.json`; `kernel/src/hookregistry.ts`, `hookclear.ts`, `hooksearchhit.ts`, `hookseatstart.ts`, and `doctor.ts`; ADR-0047; and this session's live tool catalog. The initial reader failure is recorded at Report Inbox page `2026-10-11-validated-reader-has-no-seat-in-codex-launcher-session`; the subsequent successful plan read supersedes that session condition.
