---
name: closeout
description: Save this Library session’s work and finish with a kernel-checked closeout.
---

Use the conversation id and turn id supplied by the UserPromptSubmit checkpoint hook. If the conversation id is absent, say the checkpoint hook context is unavailable and Safe to stop: no. Ask for a new prompt after the Library hooks are enabled; preserve current work. Never guess an id from a process, seat, filename, or another conversation.

1. Run `deskpost checkpoint request closeout --harness codex --conversation <hook conversation id> --turn <hook turn id>`. Omit `--turn` only when the hook supplied no turn id. If another request waits, read `deskpost checkpoint status --conversation <id>` and complete it, or explicitly cancel an abandoned request before requesting closeout.
2. Follow the returned prompt in order: Reports first, then each open Book and Project Hub, then this seat’s Hub Now and Next. Use the Library writers and their successful receipts. A checkpoint grants no approval for a writer.
3. End with the returned prompt’s fenced `closeout` block and any Needs you list. Name the actual page for every `updated` verdict. Unfinished or approval-dependent work gets its own accurate verdict.
4. The Stop hook checks this actual final answer. Its kernel result is the verification: gaps, waits, an unchecked result, or a pending request mean Safe to stop: no. Do not claim checked completion before that hook runs. If it fails, preserve its diagnostic and read `deskpost checkpoint status --conversation <id>` on the next prompt; report the unresolved check.

Stop after the closeout answer. An Interrupt cancels a pending request; it never completes it.
