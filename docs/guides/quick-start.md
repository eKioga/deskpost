# Quick Start

> Your first session, from a fresh install to your first answer. It takes about ten minutes.
>
> Not installed yet? The [README](../../README.md#install) has the one line for Windows and the one
> line for Linux. Come back when `library doctor` has passed.

## The one sentence

Your assistant, the **Librarian**, reads only what you have deliberately **opened** on your **Desk**,
so "what does it know right now?" always has an answer you can point at.

Everything else follows from that. A Desk belongs to a **seat**, which is a named place to work.
Nothing sits you at one by default, so the first thing any session needs is a seat.

## 1. Make a Library, a Project and a seat

A Library is a workspace folder. This is the only part of this guide that you type:

```
library init ~/Library
cd ~/Library
library hub new my-project --title "My project"
library seat start me --project my-project
```

On Windows, write `$HOME\Library` for the folder. Here is what each line does:

- `init` lays the workspace out. You get the Notebook, the Shelf with its **Holding Shelf** and
  **Report Inbox**, and a local collection for your Projects and Books, all on your own disk.
- `hub new` makes a **Project Hub**. It is the durable record of one piece of work: what it is for,
  what is open, what was decided.
- `seat start` makes the seat `me`, binds it to `my-project`, opens the Hub on its Desk, and starts
  Claude Code there. For Codex, add `--command codex`.

Next time, `library seat start me` is enough. The seat remembers its Project.

## 2. Ask where you are

In the session that just opened, say:

> **"What's on my desk?"**

You get your seat, what is open on it, your Notebook, and anything waiting on the Holding Shelf.
Whenever something surprises you, ask this again. It answers most questions about why something
happened.

## 3. Open a Book and read from it

> **"What Books are there?"** … then … **"Open the *X* Book."** … then ask it something the Book
> covers.

Browsing the catalog changes nothing. Opening a Book is a change, so it needs your seat. Once a Book
is open, the Librarian reads real pages through the Library's validated reader and cites them. It
never assembles an answer from a search.

A new Library has no Books yet. You make your first one on the Shelf by asking, for example "make a
Shelf Book for my recipes".

## 4. Meet a guard

Ask the Librarian to read a page of a Book that is **closed**. It will refuse, name the Book, and
offer to open it. Ask it to "just peek at the file" and it will refuse again. The guard covers
shell commands too, not only the proper read.

**That refusal is the product working.** A closed Book is unavailable, even though its files are
sitting on your disk.

## 5. Save something for later

> **"Save this for later: *…whatever you just worked out.*"**

This lands on the **Holding Shelf**. Saving needs no open Book and no approval, because it can
only add a page, and it survives a reset. **Reading the note back does need the Book open**, as it
does for any Shelf Book: say "open the Holding Shelf" first. The note's name carries today's date
as your own clock reads it.

If something in the Library itself misbehaves, say **"report this to the Report Inbox"** instead. It
is the same kind of note, filed where a defect belongs, with the command that failed and what it
printed.

## 6. See a preview, and stop there

> **"Show me what a reset would do. Don't do it."**

Anything that could lose something **shows you exactly what it would do first**, and waits for one
clear yes. Your yes covers that one previewed action and nothing else. A reset is the example
because it is the one people worry about, and it is gentler than the word suggests:

- it takes **your seat's** Notebook and nothing else;
- it **sets the material aside** in a dated quarantine rather than deleting it;
- it **leaves your Desk open** unless you ask for it to be cleared.

"What survived the reset?" lists the quarantines, and "put that back" restores one.

## When something refuses you

Three questions answer almost everything, and "what's on my desk?" answers all three:

1. **Is this session at a seat?** A session with no seat can read the Library's own files and
   nothing else. It will say so and ask which seat you want.
2. **Does it hold the seat?** Only one session at a time works at a seat. A second session at the
   same seat is refused, so start another seat. Seats cost nothing.
3. **Is the Book open at *this* seat?** Desks do not share. What is open at another seat is not
   open at yours.

`library doctor` in your Library checks the installation itself: the guards, the reader, and each
assistant's settings. Every result it prints names its own remedy.

## Where to go next

- [Library Learning Path](learning-path.md): eight things to try in order, each proving one piece
  of the design, with what to look at afterwards.
- [Starting a New Project](starting-a-new-project.md): a real long-running subject, from Hub to seat
  to first compile.
- [Library Workflow Guide](workflow-guide.md): the same behaviour, drawn as pictures.
