# Returning Reader Quick Start

> For someone who knew the Library **before 2026-09-07** and is coming back. Not a tutorial from
> zero: this is what changed, what your old habits will now do, and what to ask for instead.
>
> New to the Library instead? Start with [Library Learning Path](learning-path.md).

## The one sentence

The Library used to have **one Desk**. It now has **one Desk per seat**, nothing sits at a seat by
default, and the things that used to destroy material now set it aside where you can get it back.

## What your old habits do now

### 1. There is no default seat

**Then:** you started a session and worked. The Desk was just there.

**Now:** a session that is not sitting anywhere has no Desk. It can read the Library's own files and
answer from them, and it can open nothing, compile nothing, and change nothing.

This is not something you have to remember. **A session that starts without a seat tells you so and
asks** — it lists the seats that exist, which are free, and which one this conversation last sat at.
You answer with the one you want. A conversation you resume is put back where it was automatically,
as long as nobody else is sitting there.

A default seat was rejected on purpose: it would be the seat that stray work silently joined, and
since every seat holds live work, anything that lost its own seat would quietly merge into someone
else's.

Two different things can refuse you, and knowing which saves a confusing minute:

| Your session | Open a Book · compile · reset · triage | Edit a Project Hub |
| --- | --- | --- |
| Not at a seat at all | refused — no seat | refused — no seat |
| At a seat, but not holding it | **refused — no claim** | **allowed** |
| Properly sat down | allowed | allowed |

That middle row is real rather than hypothetical. If you hit it, ask to be sat down again — the
Librarian can do it from inside the conversation, and what is on the Desk is left exactly as it was.

### 2. Sitting down is something you ask for, not something you run

**Then:** where you worked was a fact of the environment.

**Now:** it is a request. "Sit me down at the fallout seat." "Which seats are there?" "Create a seat
for this project." Each one that changes something shows you a preview first and waits for your yes.

There is also a **Library Seat** button in the tab bar that opens a picker — a numbered entry per
seat with its Project, whether anyone is at it, and what it last did. On a narrow or portrait
terminal each seat is a card rather than a row, so nothing wraps. That route is for when the
conversation cannot help you: hooks turned off, a terminal outside Orca, or a recovery. It is not
the ordinary way in any more.

### 3. One seat is bound to one Project, in both directions, permanently

Rebinding is refused, and so is the reverse — a Project has at most one seat. No route rebinds
either way. Retiring the seat and creating a new one is the only path, and that is deliberate: the
seat is what owns its Notebook topics, so re-aiming one would orphan them.

**So three subjects at once means three seats**, not three copies of the Library and not one seat
you keep re-pointing. Ask for another seat; it costs nothing.

### 4. Reset changed meaning twice

Three changes, all of which make your old mental model wrong in the safe direction:

- **It is seat-scoped.** It takes the Notebook topics *your seat* owns. Every other seat's material
  is hard-refused.
- **It sets material aside rather than deleting it.** Topics move into a dated quarantine with a
  journal. Nothing is destroyed, and asking for it back is a supported request.
- **Your Desk stays open.** Clearing it is opt-in, and you have to ask for it — because a Desk left
  open is one sentence to fix, and a Desk cleared destroys the only record of what you had open.

One thing is new rather than reversed: the confirmed run is tied to the **exact preview you
approved**. If anything changed between the preview and your yes, it stops with nothing written and
asks again. That is the guard working, not a glitch — say yes to the new preview rather than trying
to push the old approval through.

**And you can now ask for more than your own slice.** "Clear the whole Notebook, not just mine"
sweeps every seat that is **idle right now** as well. A seat someone is working at is **named and
left** and the run carries on — one busy seat does not cancel the request. A **retired** seat's
topics are a separate ask the Library will not fold into the same operation, because quiet today is
not the same as finished. The preview names whose each topic is before you say yes, and the
quarantine's journal is the only record of who owned what — which is what lets any of it go back.

**"Reset" always means the Library reset**, by the way — never a Git cleanup. A clean working tree
is not evidence that one happened.

### 5. Notebook topics have owners, and an unowned one stops a reset

A topic no seat owns is not swept up on a guess. The reset refuses and names it.

**That is the design working, not a bug to route around.** Say it is yours, or say two seats share
it, and the reset proceeds. Ask "who owns my Notebook topics?" to see the record at any time.

### 6. Closing a session retires nothing

Ending a session releases your hold on the seat. The seat, its Desk, its Project and its topics all
persist, and the next session picks them up exactly as they were.

Retiring a seat is a separate, gated thing you have to ask for — and **deleting a seat's folder by
hand is not one.** If that has happened, ask for the seat to be retired properly; it works fine on a
seat whose files are already gone, and it is the only thing that frees the name and releases the
topics.

### 7. Things come back now

| You want | Ask for | Recoverable afterwards |
| --- | --- | --- |
| To see what was set aside | "what survived the reset?" | it is only a read |
| Quarantined topics put back | "restore that quarantine" | yes — it only adds |
| A retired seat's Desk back | "restore that seat's Desk" | yes — it only adds |
| A quarantine destroyed | say so explicitly | **no** |
| A retirement record destroyed | say so explicitly | **no** |

The first one **works even when your session has no seat**, which is the point: a reader whose
session lost its seat is exactly the reader asking what survived.

The last one usually refuses, on purpose — deleting a retirement record strands that seat's Notebook
topics permanently. If you are told no there, the refusal is protecting material, and it will say
what it is protecting.

## Your first five minutes

Ask for these four things, in this order. None of them changes anything.

> **"What's on my desk?"** — your seat, what is open on it, the shape of your Notebook, and anything
> waiting on the Holding Shelf. If you are not sitting anywhere, this is where you find that out.
>
> **"What Books are there?"** — the collection, without opening anything.
>
> **"Open the *X* Book."** — this one is a change, so it needs your seat. Once it is open, just ask
> your question; the Librarian reads it properly rather than grepping at it.
>
> **"What have I got in progress?"** — the Hub's own orientation for the Project your seat is bound
> to.

**When something refuses you**, three questions answer almost everything: is there a seat, does this
session hold it, and is the Book open at *this* seat? "What's on my desk?" answers all three — it
names how your seat was identified and whether the hold on it is yours, free, or stale.

## Where to go next

- [Library Learning Path](learning-path.md) — an ordered set of things to try, each one proving a
  specific piece of the design.
- [Library Workflow Guide](workflow-guide.md) — the same behaviour drawn as pictures.
- [Starting a New Project](starting-a-new-project.md) — a new long-running subject, from Hub to seat
  to first compile.
- The `library-help` Skill — ask it "why can't I read that?" or "what happens if I reset?" directly.

*Behind the desk: the exact contract, the refusals and the evidence live in [Seats](../seats.md) and
[Librarian Operation Playbooks](../librarian-operation-playbooks.md). Those are maintenance
documents — you never need them to do the work on this page.*
