# Library Learning Path

> Eight things to try, in order. Each one is safe, each proves a specific piece of how the Library
> works, and each names what to look at afterwards so you can see that it worked. Written for
> someone **using** the Library, not maintaining it.
>
> Every one of these is a sentence you say to the Librarian. Nothing here destroys anything, and one
> step stops at a preview on purpose. That is the exercise.

## 1. Find out what a session without a seat can do

Open a session in your Library folder **without** `library seat start`. For example, open Claude
Code or Codex there directly. It will tell you it has no seat and ask where you want to sit. **Say
"not yet, I want to look around first."**

Then ask it something about the Library's own documentation, which it will happily answer. Then ask
it to open a Book.

**What it proves.** There is no default seat, and the boundary is real rather than advisory. A
session that is not sitting anywhere reads the Library's own files and nothing else.

**Look at afterwards.** The refusal itself. It names the fix, and it is the same sentence every
time, because it is worded in exactly one place. You will meet it again and recognise it.

Then sit down. In Claude Code, say which seat you want. In Codex, or if you would rather, leave and
run `library seat start <seat>`. Everything from step 2 assumes a seat.

## 2. See where you landed

> "What's on my desk?"

**What it proves.** The Desk is per-seat. Yours comes back in full, and every other seat is a single
line: whether someone is at it and roughly when it was last active, never what is open on it.
Another seat's material does not appear on your Desk just because you asked.

**Look at afterwards.** What it says about **your** seat: how the seat was identified, and whether
the hold on it is yours, free, or stale. "Named by the environment" and "bound to this conversation"
are different facts, and this is where you can tell them apart. That matters the first time
something refuses you because this session does not hold the seat.

## 3. Open a Book, then read a page

> "What Books are there?" … then … "Open the *X* Book." … then ask it something the Book covers.

**What it proves.** Browsing is free, and opening is a change. Listing the collection works whether
or not you are sitting down, and opening needs your seat. Once a Book is open, the Librarian reads
it properly: a validated read of a real page, not a guess assembled from a search.

**Look at afterwards.** Ask "what's on my desk?" again. The Book is now on it. That list **is** your
Desk. It is what "open" means, and it is the only thing that makes the next question answerable
from that Book.

## 4. Meet a guard on purpose

Pick a Book that is **closed** and ask the Librarian to read something inside it, by file, by page,
however you like. Push a little: ask it to just peek at the file directly.

**What it proves.** Closed means unavailable, even though a Shelf Book's files are sitting on this
machine. The guard covers the side doors too, not only the front one. A plain shell command reaching
into a closed Book is refused the same way a proper read is.

**Look at afterwards.** The refusal names the Book and offers to open it. Notice that the Shelf's
own catalog stays readable, because browsing what exists is not reading a Book. And notice what the
Librarian does **not** do: work around its own guard.

## 5. Save something for later

> "Save this for later: *…whatever you just worked out.*"

**What it proves.** Capture is the cheapest path in the Library, on purpose. There is no open Book,
no confirmation and nothing to decide. It can only ever add a page, which is exactly why it needs no
approval, and it survives a reset.

**Look at afterwards.** Ask what's on your desk again. The Holding Shelf's pending count went up.
Then try to read the note back. That **does** need the Book open, so say "open the Holding Shelf"
first. Writing in is free and reading out is not, and that asymmetry is the whole design in
miniature. The note's file name carries today's date as your own clock reads it.

The same move has a second destination. **"Report this to the Report Inbox"** files a defect in the
Library itself, with the command that failed and what it printed. Whoever reads it later treats it
as a claim to check, not as an order.

## 6. Ask what a reset would do, and stop there

> "Show me what a reset would do to my Notebook. Don't do it."

**Do not approve it.** The preview is the exercise.

**What it proves.** Four things at once, and they are the four most useful facts about the Library:

- a reset acts on **your seat's Notebook** and nothing else, and it names the seat it would act on;
- it **sets material aside rather than deleting it**;
- your **Desk stays open** unless you ask otherwise;
- your approval is tied to that exact preview.

**Look at afterwards.** Three things in the preview: whether your Desk would be preserved or
cleared, every topic and loose file it would set aside, and the plan id your yes would approve. If
anything changes between the preview and a yes, the run stops with nothing written and asks again.
That is the guard working, not a glitch.

**Notice what it cannot reach.** Another seat's Notebook is that seat's to reset, from that seat.
The Shelf, the collection, your source material in `raw/` and your deliverables in `output/` are
never part of a reset. If something must outlive one, move it somewhere durable first: a Shelf Book,
a Project Hub, or the Holding Shelf.

## 7. Ask what survived a reset

> "What's in quarantine? What survived the last reset?"

**What it proves.** Setting material aside is reversible, and the route back is an ordinary request
rather than a rescue operation. This one is **a read that works even with no seat at all**. That is
deliberate, because a reader whose session lost its seat is exactly the reader who needs to ask it.

**Look at afterwards.** If you have never reset, the answer is empty, and that is the correct
answer rather than a failure. Notice the difference between "nothing is in quarantine" and "I could
not check". The Librarian is expected to say which.

## 8. Ask a question the Notebook cannot answer

Ask the Librarian something your open Books and Notebook do not cover.

**What it proves.** The answer is layered, and it tells you which layers it actually checked. A hit
from a search is a **location, not a reading**. It earns the question "shall I open that Book?" and
nothing more.

**Look at afterwards.** Whether the answer names what it checked **without result**. An answer that
stopped early is never a finding of absence, and the Librarian is supposed to say so plainly rather
than imply coverage it does not have. If it ever quietly implies it, that belongs in the Report
Inbox.

---

## When you are ready to do real work

- [Starting a New Project](starting-a-new-project.md): the Hub, the seat, and the first compile,
  in the order they have to happen.
- [Library Workflow Guide](workflow-guide.md): the same behaviour drawn as pictures.
- [Quick Start](quick-start.md): if you skipped it, the ten-minute version from a fresh install.
