# Library Workflow Guide

A visual companion to the other guides: the same behaviour, drawn as flow rather than prose. Each
diagram answers one question. Boxes are states or places material lives, and arrows are what moves
it. Where that is something **you** do, the box says so in the words you would actually use.

New here? Read the [Quick Start](quick-start.md) first. It is shorter, and it gets you to a seat.

## One Library, one Desk and one Notebook per seat

A Library is one workspace folder. It holds one collection of Books and Project Hubs, which lives on
your own disk unless you choose to share it, and one Shelf of local Books. What multiplies is the
**seat**. Each seat carries its own **Desk** and its own **Notebook**, and each is bound to exactly
one Project. Working three subjects at once means three seats, not three Libraries.

```mermaid
flowchart TD
    L["One Library\none collection, one Shelf"]
    L --> S1["seat: me"]
    L --> S2["seat: fallout"]
    S1 --> D1["its own Desk and Notebook\nProject: my-project"]
    S2 --> D2["its own Desk and Notebook\nProject: fallout-settlements"]
```

The binding holds in both directions and nothing undoes it. A seat cannot be re-aimed at another
Project, and a Project has at most one seat. Ask for a second seat instead. It costs nothing.

## Sitting down

**There is no default seat.** A session that is not sitting anywhere can read the Library's own
files and nothing else. It cannot open a Book, compile, reset, or change anything. That is a real
state rather than a misconfiguration, because a default would be the seat that stray work silently
joined.

```mermaid
flowchart TD
    T["You, in a terminal:\nlibrary seat start ‹seat›"] --> F["Seated: your Desk, your claim,\nyour Project open"]
    A["A session opened\nwith no seat"] --> B["It says so,\nand asks which seat"]
    B --> C["Claude Code: answer in\nthe conversation"]
    B --> T
    C --> F
```

`library seat start` is the way in that works everywhere, for Claude Code and for Codex
(`--command codex`). A seatless Claude Code session can also bind a seat when you answer its
question. On Windows, that session lists the seats that exist, and a resumed conversation is put
back at the seat it last held when nobody else is sitting there.

**One session per seat.** A second session at a seat someone is working at is refused.

## Opening and closing

Books live in the collection or on the local Shelf, and Project Hubs live in the collection. Either
way, "open" and "close" mean the same thing. On the Desk, the Librarian can read it. Off the Desk,
closed means **unavailable**, even though the files sit on this machine.

```mermaid
flowchart TD
    subgraph Closed["Closed: unavailable"]
        direction TB
        SB["Books\nin the collection"]
        SP["Project Hubs\nin the collection"]
        LB["Shelf Books\nshelf/‹slug›"]
    end
    SB --> Act
    SP --> Act
    LB --> Act
    Act["You: “open the X Book”\nor “close it”"]
    Act --> Desk["THIS seat's Desk\nopen, in play"]
    Desk --> Read["Now it can be read,\nand quoted with its page"]
```

Opening and closing act on **your** Desk and need your seat. A closed Book is never quietly read
around the edge. The Librarian says it is closed and offers to open it.

## Into the Notebook, and out to somewhere durable

The Notebook is volatile working knowledge, and each seat has its own. **Capture** is the move that
needs no decision and no open Book, and it is deliberately the cheapest path in the Library.

```mermaid
flowchart TD
    Raw["raw/‹project›/‹batch›\nsource material you put there"] --> C["You: “compile that batch”\npreview, then your yes"]
    C --> NB["Your seat's Notebook\nvolatile working knowledge"]
    NB --> Cap["You: “save this for later”\nno open Book, no approval"]
    Cap --> HS["Holding Shelf\nsurvives a reset"]
```

Putting files into `raw/<project>/<batch>/` is the one routine step you do with your own hands.

## Graduating: the durable exits

**Graduating** is moving something somewhere a reset cannot reach. Each exit needs its destination
open on your Desk.

```mermaid
flowchart TD
    NB["Your Notebook\n(a reset can reach this)"] --> A["“Put this in the X Book”"]
    NB --> B["“Add this to the project”"]
    NB --> C["“Publish this as a Book”"]
    A --> A2["a Shelf Book\ncurated, local"]
    B --> B2["the Project Hub\nactive work"]
    C --> C2["a Book in a shared collection\nonly if you have one"]
```

Publishing a Book for other machines needs a **shared collection** (see the README's *Sharing a
collection across machines*). A Library on your own disk keeps its Books on the Shelf, where they are
just as durable.

## What a reset moves, and how it comes back

A reset acts on **your seat's Notebook** and **sets it aside rather than deleting it**. Nothing is
destroyed, and the way back is an ordinary request.

```mermaid
flowchart TD
    R["You: “reset my Notebook”\npreview first, then one clear yes"] --> S["Everything in YOUR seat's Notebook"]
    S --> Q["Quarantine\ndated, with a journal"]
    Q --> B["“Put that back”\nrestores it"]
```

What it leaves alone is as important as what it takes:

```mermaid
flowchart TD
    R["A reset"] --> K1["Your Desk stays open\nunless you ask to clear it"]
    R --> K2["Every other seat's Notebook\nthat seat resets its own"]
    R --> K3["Source material, deliverables,\nthe Shelf, the collection"]
```

**"What survived the reset?"** lists every quarantine, and works even in a session with no seat.

## Capture and triage on the Holding Shelf

"Save this for later" needs no open Book and cannot lose anything, because it only ever adds a
page. Reading or sorting what landed there does need the Book open, like any Shelf Book. A note's
file name carries the date as your own clock reads it.

```mermaid
flowchart TD
    F["A finding worth keeping"] --> N["“Save this for later”\nno open Book, no approval"]
    N --> HS["Holding Shelf\nwaiting for review"]
    HS --> O["“Open the Holding Shelf”\nto read and sort it"]
    O --> T1["Copy it to the Notebook"]
    O --> T2["Put it in a Shelf Book"]
    O --> T3["Mark it reviewed"]
    O --> T4["Discard it\npreviewed, then your yes"]
```

Copying to the Notebook **copies rather than moves**, so the Shelf record survives the next reset
even after you have worked on the copy. Discarding is previewed and waits for your yes, because it
is the one move here that can lose something.

**The Report Inbox** is the same kind of Book, for a different kind of note: a defect in the Library
itself, filed with the command that failed and what it printed. A report is a claim to check later,
never an order.

## The preview-and-approve pattern

Every consequential action in the Library has the same shape, so you only have to learn it once.
That includes publishing, triage, archiving, resetting, retiring, restoring and discarding.

```mermaid
flowchart TD
    R["You ask for something\nconsequential"] --> P["A preview:\nwhat it would change, exactly"]
    P --> Y{"You say yes?"}
    Y -- no --> N(("nothing changes"))
    Y -- yes --> C["It does that exact thing"]
    C --> V["Records what it changed,\nand reads it back to check"]
```

**Your yes covers that one previewed action and never carries to the next.** If anything changed
between the preview and your approval, the action stops with nothing written and shows you a fresh
preview. That is the guard working, not a glitch. And a preview that finds something it must refuse
does not offer you an approval at all.

## Answering a question, layer by layer

Search says where a term occurs, and never what the material means. Opening what a hit names is
part of answering, not an optional extra.

```mermaid
flowchart TD
    Q["Your question"] --> L1["1. Your Notebook +\nwhat is open on your Desk"]
    L1 -- covered --> A["An answer, naming\nwhat it checked"]
    L1 -- "not covered" --> L2["2. Your source material\nthe likely batch, not all of it"]
    L2 -- found --> A
    L2 -- "not found" --> L3["3. What closed Books are ABOUT\nmetadata only, never their contents"]
    L3 --> L4["“Shall I open one of these?”"]
    L4 -. "you say yes" .-> L1
    L3 -- "nothing promising" --> L5["4. An offer to research or compile\ngeneral knowledge only if you ask,\nlabelled as outside the Library"]
```

**An answer that stopped early is never a finding of absence**, and a closed Book is never opened
just to search it. Knowing what a Book is about only earns the suggestion to open it.

## Key Takeaways

- One Library, one collection and one Shelf, with a Desk and a Notebook **per seat**. There is no
  default seat, and a session holding none can read the Library's own files and nothing else.
- `library seat start <seat>` sits you down, in Claude Code or Codex. A seatless session says so
  and asks.
- Open and closed mean the same thing everywhere: on the Desk and readable, or off it and not.
- A reset sets **your seat's Notebook** aside, leaves your Desk open unless you ask otherwise, and
  has a supported way back.
- Saving something for later is free, because it can only add. Everything that could lose something
  previews first and waits for one clear yes.
- Search and discovery say where a term occurs, never what it means. Opening the hit is what
  licenses an answer.
