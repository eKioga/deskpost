# Library Learning Path

> Nine things to try, in order. Each one is safe, each proves a specific piece of how the Library
> works, and each names what to look at afterwards so you can see that it worked. Written for
> someone **using** the Library, not maintaining it.
>
> Every one of these is a sentence you say to the Librarian. Nothing here destroys anything, and two
> steps stop at a preview on purpose — that is the exercise.

## 1. Find out what a session without a seat can do

When a fresh session tells you it has no seat and asks where you want to sit, **say "not yet — I
want to look around first."**

Then ask it something about the Library's own documentation, which it will happily answer. Then ask
it to open a Book.

**What it proves.** There is no default seat, and the boundary is real rather than advisory. A
session that is not sitting anywhere reads the Library's own files and nothing else.

**Look at afterwards.** The refusal itself. It names the fix, and it is the same sentence every
time, because it is worded in exactly one place — you will meet it again and recognise it.

Then say where you want to sit, and carry on. Everything from step 2 assumes a seat.

## 2. See where you landed

> "What's on my desk?"

**What it proves.** The Desk is per-seat. Yours comes back in full; every other seat is a single
line — whether someone is at it and roughly when it was last active, never what is open on it.
Another reader's material does not appear on your Desk just because you asked.

**Look at afterwards.** What it says about **your** seat: how the seat was identified, and whether
the hold on it is yours, free, or stale. "Named by the environment" and "bound to this conversation"
are different facts, and this is where you can tell them apart — which matters the first time
something refuses you for want of a claim.

## 3. Open a Book, then read a page

> "What Books are there?" … then … "Open the *X* Book." … then ask it something the Book covers.

**What it proves.** Browsing is free; opening is a change. Listing the collection works whether or
not you are sitting down, and opening needs your seat. Once a Book is open, the Librarian reads it
properly — a validated read of a real page, not a guess assembled from a search.

**Look at afterwards.** Ask "what's on my desk?" again. The Book is now on it. That list **is** your
Desk — it is what "open" means, and it is the only thing that makes the next question answerable
from that Book.

## 4. Meet a guard on purpose

Pick a Book that is **closed** and ask the Librarian to read something inside it — by file, by page,
however you like. Push a little: ask it to just peek at the file directly.

**What it proves.** Closed means unavailable, on the local Shelf exactly as on the network, even
though the Shelf's files are sitting on this machine. The guard covers the side doors too, not only
the front one — a plain shell command reaching into a closed Book is refused the same way a proper
read is.

**Look at afterwards.** The refusal names the Book and offers to open it. Notice that the Shelf's
own catalog stays readable: browsing what exists is not reading a Book. And notice what the
Librarian does **not** do — work around its own guard.

## 5. Save something for later

> "Save this for later: *…whatever you just worked out.*"

**What it proves.** Capture is the cheapest path in the Library on purpose. No open Book, no
confirmation, nothing to decide. It can only ever add a page, which is exactly why it needs no
approval — and it survives a reset.

**Look at afterwards.** Ask what's on your desk again: the Holding Shelf's pending count went up.
Then try to read the note back — that **does** need the Book open. Writing in is free; reading out
is not, and that asymmetry is the whole design in miniature.

## 6. Ask what a reset would do, and stop there

> "Show me what a reset would do to my Notebook. Don't do it."

**Do not approve it.** The preview is the exercise.

**What it proves.** Four things at once, and they are the four most useful facts about the Library:
a reset is **seat-scoped by default** — it names the seat it would act on — it **sets material aside
rather than deleting it**, your **Desk stays open** unless you ask otherwise, and your approval is
tied to that exact preview.

**Look at afterwards.** Three things in the preview: whether your Desk would be preserved or
cleared, which loose files would be set aside, and the list of topics with who owns each one. If any
topic is owned by nobody, the preview refuses outright and tells you to settle that first — which is
step 8.

**Then ask for the wider one, and stop there too.**

> "Now show me what it would do if it cleared every idle seat's topics as well. Still don't do it."

**What it proves.** "Clear my notebook" usually means the Notebook rather than your slice of it, so
there is a second shape that takes the topics of every seat that is **idle right now** as well as
your own. A seat somebody is working at is **named and left**, and the run carries on — one busy
seat does not cancel the request. A **retired** seat's topics are a separate ask the Library will
not fold into the same operation, because quiet today is not the same as finished; you would ask for
that one afterwards, and approve it separately.

**Look at afterwards.** The preview now names every topic it would take, **whose each one is**, and
how much of each already exists in a Book or a Project Hub — plus every topic it is leaving and the
rule that left it there. This is the one preview worth reading slowly, because it is the only
operation in the Library that moves somebody else's material. If yours is the only seat, the answer
is that there is nothing extra to take, and that is the correct answer rather than a failure.

**Notice what is still left over, because that is the lesson.** Even the widest reset leaves topics
behind, and *"empty my Notebook"* is not something any of them delivers on its own. Four reasons a
topic stays: another seat owns it and you ran the narrow one; its seat is busy right now; its seat
is retired, which is a separate request; or it is **declared out of reach** — shared ground, or
deliberately protected — which no reset of any width takes. If you want the count, ask *"what will
be left?"* rather than reading the take-list, because the preview is written around what goes.

**And do not treat the fourth one as a wall to climb.** A topic is declared out of reach because
something would be lost if a reset took it — one in this Library is a published Book's refresh
source. The declaration can be changed and then the topic reset, but that is its own decision with
its own consequence. Ask what it is protecting first; "this should stay" is frequently the right
answer, and a nearly-empty Notebook is then the correct outcome.

## 7. Ask what survived a reset

> "What's in quarantine? What survived the last reset?"

**What it proves.** Setting material aside is reversible, and the route back is an ordinary request
rather than a rescue operation. This one is **a read that works even with no seat at all** —
deliberately, because a reader whose session lost its seat is exactly the reader who needs to ask
this.

**Look at afterwards.** If you have never reset, the answer is empty, and that is the correct
answer rather than a failure. Notice the difference between "nothing is in quarantine" and "I could
not check" — the Librarian is expected to say which.

## 8. Look at who owns your Notebook

> "Who owns my Notebook topics?"

**What it proves.** Notebook topics have owners, and ownership is what makes a seat-scoped reset
possible at all. A topic owned by nobody is not a bug — it is an unanswered question that the reset
refuses to answer on your behalf.

**Look at afterwards.** Anything reading as unmapped. Claim it for your seat, or say two seats
genuinely share it. Either answer unblocks a reset; guessing is the one thing the Library will not
do for you.

## 9. Ask a question the Notebook cannot answer

Ask the Librarian something your open Books and Notebook do not cover.

**What it proves.** The answer is layered, and it tells you which layers it actually checked. A hit
from a search is a **location, not a reading** — it earns the question "shall I open that Book?" and
nothing more.

**Look at afterwards.** Whether the answer names what it checked **without result**. An answer that
stopped early is never a finding of absence, and the Librarian is supposed to say so plainly rather
than imply coverage it does not have. If it ever quietly implies it, that is worth telling us.

---

## When you are ready to do real work

- [Starting a New Project](starting-a-new-project.md) — the Hub, the seat, and the first compile,
  in the order they have to happen.
- [Library Workflow Guide](workflow-guide.md) — the same behaviour drawn as pictures.
- [Returning Reader Quick Start](quick-start-returning-reader.md) — if your habits come from the
  pre-seat Library.
- The `library-help` Skill answers meta questions directly — "how do I…", "what happens if I
  reset?", "where should this go?", "why can't I read that?" — without you having to reconstruct
  the procedure from these pages.
