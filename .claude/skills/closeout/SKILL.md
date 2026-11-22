---
name: closeout
description: Save this Library session’s work and finish with a kernel-checked closeout.
---

Use the conversation id, turn id and harness from the UserPromptSubmit checkpoint hook. If the conversation id or harness is absent, preserve the work and say the checkpoint hook context is unavailable and Safe to stop: no. Ask for a new prompt after the Library hooks are enabled. Use the id supplied by this conversation's hook.

1. Before requesting closeout, run `deskpost checkpoint prepare closeout --conversation <hook conversation id> --json`. If `ask_first` is present, ask its question in plain words with its choices, then end the turn with no checkpoint request pending. On the reader's reply, run the chosen commands. For tidy, close the named ticked items first; use the tidy preflight and its exact plan id only if the Hub is still over its limit. Record `tidied`, `declined` or `tidy-refused` from the outcome. A refusal preserves the work and goes in Needs you. With `ask_first: null`, continue without a decision option.
2. Run `deskpost checkpoint request closeout --harness <hook harness: claude or codex> --conversation <hook conversation id> --turn <hook turn id>`, adding `--decided <tidied|declined|tidy-refused>` when there was a question. Omit `--turn` only when the hook supplied none. If another request waits, read `deskpost checkpoint status --conversation <id>` and finish it, or cancel an abandoned request before requesting another.
3. Follow the returned prompt: Reports first, then each open Book and Project Hub, then this seat's Hub. Use the Library writers and their successful receipts. A checkpoint grants no approval for a writer.
4. End with the prompt's fenced `closeout` block and any Needs you list. Name the actual page for each `updated` verdict. Unfinished work and work needing approval get their accurate verdicts.
5. The Stop hook checks this actual final answer on either harness. Its result is the verification: gaps, waits, an unchecked result or a pending request mean Safe to stop: no. If the hook fails, preserve its diagnostic and read checkpoint status on the next prompt. Report the unresolved check.

Stop after the closeout answer. An Interrupt, or a new Claude prompt after an unanswered request, cancels that request and never completes it.
