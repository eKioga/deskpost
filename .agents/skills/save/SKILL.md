---
name: save
description: Save a checked point in this Library session and continue working afterward.
---

Use the conversation id and turn id supplied by the UserPromptSubmit checkpoint hook. If the conversation id is absent, say the checkpoint hook context is unavailable and Safe to stop: no. Ask for a new prompt after the Library hooks are enabled; keep the current work intact. Never infer an id from a process, seat, filename, or another conversation.

1. Run `deskpost checkpoint request save --harness codex --conversation <hook conversation id> --turn <hook turn id>`. Omit `--turn` only when the hook supplied no turn id. If a request already waits, read `deskpost checkpoint status --conversation <id>` and complete that request, or explicitly cancel an abandoned request before requesting this save.
2. Follow the returned prompt. Make the needed writes through the Library writers and keep their successful receipts. Each writer's own approval rules still apply.
3. End with the requested fenced `save` block, with one verdict for every item, and the requested Needs you list when something is unfinished. A claim of `updated` names the actual page written. Keep the answer brief.
4. The Stop hook checks this actual final answer. Its kernel result is the verification: gaps, waits, an unchecked result, or a pending request mean Safe to stop: no. Do not claim a clean checked save before that hook runs. If the hook fails, preserve its diagnostic and read `deskpost checkpoint status --conversation <id>` on the next prompt; report the unresolved check.

A save point keeps the session open. Resume the same work on the next prompt.
