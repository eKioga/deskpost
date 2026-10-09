# Quick Start

> Your first session, from a fresh install to your first answer. It takes about ten minutes.
>
> Not installed yet? The [README](../../README.md#install) has the one line for Windows and the one
> line for Linux. Come back when the installer's `deskpost doctor` has passed.

## The one sentence

Your assistant, the **Librarian**, reads only what you have deliberately **opened** on your **Desk**,
so "what does it know right now?" always has an answer you can point at.

Everything else follows from that. A Desk belongs to a **seat**, which is a named place to work.
Nothing sits you at one by default, so the first thing any session needs is a seat.

## 1. Sit down at your first seat

The main menu is the way in, and the one you will use every day:

```
deskpost
```

Type it in any terminal. Inside a Library it opens that Library; anywhere else it opens your
**default Library**, the first one you made. The first time, with no seats yet, it offers two ways
to start (a terminal install offers the same choice as it ends):

```
This Library has no seats yet. A seat is a place to work, with its own Desk and one Project.
  [h, Enter] Show me around   a deskpost-help seat with the Librarian as your guide
  [+]        Your first seat  name a project, and start working in it
  [l]        Browse           what the Library holds, without a seat
  [q]        Later
```

**Show me around** starts the Librarian in a seat called `deskpost-help`, as your guide; it is an
ordinary seat you can come back to, and `h` offers it again from the menu any time. **`+`** makes a
seat for your own project:

```
Your first seat. A seat is a place to work, with its own Desk and one Project.
Name your project (empty to cancel) › Home lab
```

Then it asks four more questions, each skipped with Enter: a template (performer or orchestrator), a
department, a one-line card saying what the seat handles, and the Shelf Books to open at its first
launch. It shows what it will make and waits for Enter:

- a **Project Hub**, `home-lab`: the durable record of one piece of work, what it is for, what is
  open, what was decided. An existing Hub of that name is reused.
- a **seat** of the same name, bound to that Project, with the Hub open on its Desk.

Then it starts Claude Code there (or Codex, if that is the one you chose; `a` switches).

**Next time, `deskpost` shows your seats**, one numbered line each with its Project, whether anyone is
at it, when it was last used, and what its last conversation was called:

| Type | And |
| --- | --- |
| a number | you are back in that seat's last conversation, in the assistant it was held with |
| `n` and a number | a new conversation at that seat |
| `+` | a new seat |
| `r` and a number | retire that seat, after it shows you what it archives |
| `l` | what the Library holds: its Books and Projects by title, without a seat (`deskpost browse`) |
| `b` | Basic Memory, which shares your Books across machines (optional) |
| `q` | nothing; you stay where you are |

A seat already in use by another session is shown as held, and choosing it says so: one session per
seat. Seats cost nothing, so start another.

Made the program without a Library (`-Library none`)? `deskpost setup <folder>` makes one, shown
first and made on one Enter.

## 2. Ask where you are

In the session that just opened, say:

> **"What's on my desk?"**

You get your seat, what is open on it, your Notebook, anything waiting on the Holding Shelf, and
the letters other seats have left for you.
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

The Librarian first looks for its home: your Project Hub, a Book, or the Notebook. On a fresh
Library nothing fits yet, so it lands on the **Holding Shelf**, the last-resort shelf for notes with
no other home. Saving there needs no open Book and no approval, because it can only add a page, and
it survives a reset. **Reading the note back does need the Book open**, as it
does for any Shelf Book: say "open the Holding Shelf" first. The note's name carries today's date
as your own clock reads it.

If something in the Library itself misbehaves, say **"report this to the Report Inbox"** instead. It
is the same kind of note, filed where a defect belongs, with the command that failed and what it
printed. And a note meant for **another seat** is a letter: say "leave a letter for *that seat*", and
it waits in the `letters` Book until that seat reads it.

Closed notes do not pile up: "tidy the Holding Shelf" moves notes closed more than two weeks ago out
of the way, after a preview, and deletes none of them.

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

`deskpost doctor` in your Library checks the installation itself: the guards, the reader, and each
assistant's settings. Every result it prints names its own remedy.

## Where to go next

- [Library Learning Path](learning-path.md): eight things to try in order, each proving one piece
  of the design, with what to look at afterwards.
- [Starting a New Project](starting-a-new-project.md): a real long-running subject, from Hub to seat
  to first compile.
- [Library Workflow Guide](workflow-guide.md): the same behaviour, drawn as pictures.
