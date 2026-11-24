---
name: meanwhile
description: Use when the reader asks what they can do meanwhile or wants side work while a builder runs.
---

# Find work to do meanwhile

Run commands from the Library folder.

1. Run `deskpost meanwhile prepare --json` to read the builder runs and the
   available work. Use its `request` as the source for the answer.
2. Act on each line in `problems` using the command it names. Follow that
   command's approval gate. If a line gives no command or a check still
   cannot run, tell the reader what information is missing.
3. Read the material the request points to before proposing work. Use the
   validated reader for pages in open Books and Project Hubs. Use the
   current run state to decide which work is ready and which depends on a
   builder's handback.
4. Offer at most seven items under the lane names in the request. Describe
   each item in plain words, give it a rough size, and name any decision,
   approval, or credential it needs. End with one recommendation and a
   short reason to pick it.
5. Ask the reader only for decisions, approvals, or credentials. Start nothing until the reader picks.

## After the reader picks

- Follow the chosen item's normal workflow and approval gates.
- Keep a running builder's working tree, `master`, and branch tips untouched.
  Follow this seat's Hub rules for any work on a desk branch.
- When you write a record, use `{{now}}` for a new time and `{{today}}` for a new
  date in the body so the writer fills them in.
