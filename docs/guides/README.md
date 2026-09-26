# Library Guides

**Everything in this folder is written for you, the person using the Library.** You work by talking
to the Librarian, so that is how these guides are written: what to ask for, what you will be shown,
and what you are agreeing to when you say yes. Getting into a session takes one command in a
terminal. After that, everything in these guides is a sentence you say.

The rest of `docs/` is design records: dated snapshots of why something was built the way it was,
written for whoever is changing the code. They are not wrong. They are just not addressed to you.

That split is the point of this folder. A guide has to stay **current**, while a design record is
supposed to **freeze**.

## Which one do I want?

| If you… | Read |
| --- | --- |
| have **just installed** and want your first session | [Quick Start](quick-start.md) |
| want to **learn by doing**, safely, in a sensible order | [Learning Path](learning-path.md) |
| are **beginning a new subject** you expect to work on for months | [Starting a New Project](starting-a-new-project.md) |
| want the whole shape **as a picture** | [Workflow Guide](workflow-guide.md) |

**None of the above, and something just refused you?** Ask the Librarian: "why can't I read that?",
"what happens if I reset?", "where should this go?". Every refusal names what stopped you and what
fixes it.

## In two minutes

A Library is one workspace folder. It holds your **Books** and **Project Hubs**, a **Shelf** of
local Books, and a **Notebook** of working knowledge. The collection is on your own disk unless you
choose to share it. A **seat** is a named place to work, bound to one Project, and it carries its
own **Desk** and its own **Notebook**. There is no default seat, so work starts by sitting down:

```
library seat start <seat> --project <project-slug>
```

That line makes the seat the first time. After that, `library seat start <seat>` is enough. Add
`--command codex` to work in Codex instead of Claude Code.

> Then ask **"What's on my desk?"** to see your seat, what is open on it, and what is waiting for
> you.

A session that has no seat **tells you so and asks** which one you want. In Claude Code you can
answer in the conversation. On Windows it also lists the seats that exist.

Anything that could lose something **shows you exactly what it would do first**, and waits for one
clear yes. Your yes covers that one previewed action and nothing else.

Nothing here will destroy your work by accident. A reset **sets material aside** rather than
deleting it, and asking **"what survived the reset?"** works even in a session with no seat at all.

## A Library still on the PowerShell tools

These guides describe the Library that the `library` program installs. A Library that is still run
by the repository's PowerShell tools has **one shared Notebook** whose topics seats own. That is the
layout before ADR-0029. Its reset and ownership rules are the ones in
[`docs/seats.md`](../seats.md), not the ones here.

## Where everything else lives

- [`docs/_index.md`](../_index.md): the map to all documentation, guides and design records alike.
- [`CONTEXT.md`](../../CONTEXT.md): the glossary, and the only authority on what these words mean.

Two more are **not** written for you, in case a guide sends you there for the fine print.
[`docs/seats.md`](../seats.md) is the full seat contract, and
[`docs/librarian-operation-playbooks.md`](../librarian-operation-playbooks.md) is the exact procedure
the Librarian follows for every consequential operation. Both are maintenance documents: useful if
you want to know precisely what a refusal means, never required to do the work.
