# Full text over open Books

Plan item **2.3**, landed 2026-08-19, under [ADR-0002](adr/0002-discovery-spans-closed-books.md).
This is the design record for the second of Phase 2's three retrieval tiers, and for
`tools/SearchBoundaries.ps1`, which item **2.5** owns and which 2.3 pulled forward.

Discovery ([docs/discovery-manifests.md](discovery-manifests.md)) answers *which Book covers this*
across all 25 Books, open or closed, because it reads only catalog-class metadata. This tier answers
*where in this Book does it actually say that*, and it returns the body itself — so it is confined to
Books the Desk says are **open**. The two are two halves of one boundary, not two settings of one
dial. ADR-0002 settles it and it is not re-litigated here.

| | Discovery (2.2) | Full text (2.3) |
| --- | --- | --- |
| Reads | manifests | page bodies |
| Covers | every Book, closed included | Shelf Books open on the Desk |
| Collections | Shelf and shared | Shelf only, for now |
| A capture Book | pages withheld unless open | note bodies returned when open |
| The canary asserts | body text **never** appears | body text appears **only** for an open Book |
| A hit licenses | *shall I open it?* | *open that page and read it* |

## The surface

`tools/BookFullText.ps1` is internal and dot-sourced, exactly as `BookDiscovery.ps1` is, so the
query, the leak canaries, and the Desk gate have one implementation and one suite. The reader reaches
it as **`search_open_books`** on the validated reader MCP, beside `discover_book_pages`.

It is a **separate module from Discovery**, deliberately. One file holding both would make the
boundary between them a branch rather than a structure, and the boundary is the whole point of
ADR-0002. They share `SearchBoundaries.ps1` and nothing else.

Every hit carries the canonical page path and the line number, so the answer feeds
`read_open_book_page` directly rather than being a riddle.

## Where the text comes from for an open *shared* Book — nowhere, and the answer says so

This was the question everything else hung on. A Shelf Book is a file scan. A shared Book has no
filesystem: its pages arrive one `read_note` at a time over MCP, and an open shared Book can hold
118 pages (`godot-engine-architecture-reference`). Rung 7's `tools/SharedBookSource.ps1` already has
the primitive, so the question was never *how* — it was what a query costs and what the reader
watches while it runs.

**A hundred-odd sequential network reads is a backfill, not a query.** It cannot finish inside any
wall-clock budget worth having, and there is no cache that could stand in: an open Book's pages
change and nothing marks them, so a cached scan would be derived state no writer invalidates — the
exact shape rung 6 refused when it read an open capture Book's pages live instead of storing them.

So the first form of this tier covers the local Shelf, and **an open shared Book is named in the
answer as out of scope**, with its reason and the alternative:

```
Full text covers the local Shelf only. A shared Book's pages arrive one read over the network at a
time, which no query-time budget can complete, so an open shared Book is named below rather than
searched.
- godot-engine-architecture-reference [shared], open but NOT searched: ... -- read it a page at a
  time with read_open_book_page, or use discover_book_pages for its headings
```

Rung 6 said *local Shelf only* in every answer for the same reason. The Desk's own `.open-books` is
the roster that makes this possible, and it is a better roster than rung 7's: it is local and
authoritative, so there is no staleness to declare. An open shared Book is **unavailable, never
invisible**.

## The caps are 2.5's, and they live where all three tiers can share them

2.5 owns query length, result count, matched bytes, and wall clock across every tier. 2.3 is the
first tier that returns body text, so they bind now rather than eventually. The choice was to build
2.3's own set and reconcile later, or pull 2.5 forward — and Discovery had already declined regex for
exactly this reason rather than improvise a second matching rule.

`tools/SearchBoundaries.ps1` holds all of it: the seven caps, the normalise/flatten/sanitise
pipeline, literal containment, canonical-path containment with reparse-point rejection, and the one
parser of `.open-books`. Discovery's three constants **moved there unchanged**, and
`book-discovery.selftest` (103 checks) passing untouched is what proves moving a cap moved no answer.

| Cap | Value | Bounds |
| --- | --- | --- |
| query length | 200 chars | the request |
| result count | 50 default, 500 ceiling | the answer |
| matched bytes | 64 KB | the answer |
| per-line length | 400 chars | one pathological line |
| wall clock | 10 s | the scan |
| collected matches | 5000 | the scan |
| files scanned | 5000 | the scan |
| per-page bytes | 2 MB | one pathological page |

**Regex is still not offered, and that is a decision rather than an omission.** 2.5 specifies
literal-by-default with regex opt-in; the default is here and the opt-in is not, because a
reader-supplied pattern can be catastrophic on backtracking and needs a matcher with its own
timeout, not a flag on this one. The wall-clock budget is per query, not per match. When regex
arrives it arrives in `SearchBoundaries.ps1`, once, for all three tiers.

## The leak boundary, now that results are content

**The Desk is read twice.** Once to choose which Books may be read at all, and again after the scan,
**before anything is emitted**. A Book that was open when the query started and closed before it
answered has every line, page path, and note attributable to it discarded, and only its slug is
named — its slug is Desk state the reader already has; its page paths are not.

The two reads are genuinely redundant in the safe direction, which the mutation sweep proved:
widening the *first* gate alone leaks nothing, because the second catches it. The closed-Book leak
canary only goes red when both are removed. That redundancy is worth keeping and worth knowing about,
because it means neither gate alone is load-bearing evidence.

**An open capture Book's unvetted notes are readable here, and that is the real difference from every
canary written so far.** Discovery keeps a capture Book's page metadata out of closed-readable
storage entirely, because naming a note is reading it. Once the Book is open that protection has done
its job and ADR-0002 says its pages join normally. So this tier returns note bodies — correct, and
inherited from Discovery by *decision* rather than by habit. The answer therefore labels it:

```
Some of these lines come from UNVETTED capture notes in: holding. They are readable because the Book
is open, but nobody has triaged them.
```

The label is attached to Books that actually **contributed a line**, not to whatever happened to be
open, because the warning is about the lines on the screen.

**Control-character sanitisation is not optional**, per 2.5: `raw/` holds arbitrary converted text
and a Book page can carry anything an import gave it. Every emitted line is Unicode-normalised,
stripped of control and format characters, flattened, and cut to the per-line cap with the cut
marked. **Canonical-path containment rejects reparse points on every ancestor**, not just textual
containment: `Get-ChildItem -Recurse` walks a directory junction and every file below it still
reports a path under the Book's own root, so a junction into `raw/` would pass a `StartsWith` test.

**The permitted field set is declared once**, in `$script:FullTextHitFields`, so a later change that
adds surrounding context or a neighbouring line fails a canary rather than shipping.

## What 2.6 becomes for this tier

*A heading is not a claim* was written for Discovery. A matched **line** is much closer to a claim,
and the failure to prevent is a Librarian answering from a grep hit instead of reading the page. The
rule tightens rather than transfers:

> **A matched line is not a reading.** A Discovery hit licenses *"shall I open it?"*. A matched line
> licenses **opening the page it names**, and may be cited only as evidence that the term occurs
> there — never as what the page says or concludes. A line arrives without its context: the paragraph
> that qualifies it, the heading that scopes it, the *"superseded"* note three lines down. Answer
> from the page, and cite the line as where you found it.

Every answer carries the short form on its last line. Landing the full rule in
`docs/librarian-voice-and-wayfinding.md` and the `library-help` Skill, and the acceptance test that
proves the Librarian does not answer from a line, stays **2.6's** work — as does the
`context.always-on-budget` reallocation it lands alongside.

## What 2.3 proves

- **`book-fulltext.selftest`, 70 checks**, offline and fixture-only, registered in
  `tools/Invoke-LibraryChecks.ps1` and declared in `tools/_helpers.json`. No MCP, so no loopback stub
  is needed: the engine is a filesystem scan and the Desk is a local file.
- **Twenty mutations watched red**, each on the canary it was aimed at. The leak set:
  a closed Book's body reaching a result; a Book closed mid-query still returning its lines; an
  unreadable Book dropped instead of named; an open shared Book omitted instead of named; an oversize
  page dropped silently; a cap exceeded without saying so; the sanitisation stripped; the containment
  check defeated; an undeclared field added to a hit.
- **A real run over the real Shelf**, with `library-dev` open, then with the capture Book `holding`
  and the shared Book `godot-engine-architecture-reference` open too, then the whole path end to end
  over JSON-RPC through the reader adapter. Encoding was verified against real pages rather than
  asserted: 234 real em-dash matches, present on disk and in the emitted line.

## The two things the real run found, and one the mutations found

**One cap was doing two jobs.** The matched-byte budget was charged at *collection*, so a query for a
common word spent all 64 KB on matches that were then sorted away and never shown — and the answer
declared itself **INCOMPLETE** when every page had in fact been read. The live figures: `library`
over two open Books reported *4 matching lines from 19 pages, stopped early*, when the truth was 34
pages and 327 matches. The fix splits the two jobs, because *"your answer was shortened"* and *"the
search stopped early"* are not the same news:

- **matched bytes** is charged only against lines actually **returned**. It shortens the answer and
  reports *"Every page was still searched."* The first line is always returned whatever its size — an
  answer of nothing, because one line was large, is not a better answer.
- **collected matches**, **wall clock**, and **files scanned** bound the **scan**. They report
  *"STOPPED EARLY … the match total is a floor, not a count."*

No fixture could have seen this: every fixture Book was small enough that neither budget ever bound.

**A mutation that fired nothing was the third finding.** Blanking `match_count_is_floor` produced a
fully green suite, because every assertion tested that a *complete* search is not a floor and none
tested that an *incomplete* one is. An assertion that only ever observes one value of a flag does not
test the flag. Adding the positive case immediately exposed a second gap in the rendering: a search
stopped by its scan budget can return every line it collected, so the truncation line never renders
and the count read as exact while the budget note said the opposite. `at least N` now belongs to the
count itself.

**And one ordinary defect, from the suite rather than from real input.** PowerShell binds an array
argument to a constructor as an argument *list*, so `[List[string]]::new(@('open'))` does not mean
*a list holding `open`*. That silently left the searched count at its pre-filter value after a Book
closed mid-query — precisely the *returns less without saying so* failure the block exists to
prevent. Plain arrays now.

## Known limits, recorded now rather than when they bite

- **Open shared Books are not searched.** The largest limit, and a deliberate one — see above. Closing
  it needs a design for a long-running query the reader can watch, or a gated cache with an
  invalidation story, and neither is 2.3's to improvise.
- **Regex is not offered**, per the decision above. Literal only.
- **A line is matched, but a match spanning two lines is not.** A phrase broken across a wrap is
  invisible. Both the query and the line are whitespace-flattened first, so a phrase wrapped *within*
  one line is found; one wrapped *across* lines is not.
- **The scan is not incremental.** Every query re-reads every page of every open Book. That is
  correct — a cache would be derived state nothing invalidates — and it is why the wall-clock budget
  exists. 34 pages is nothing; a 700-page Book left open would test it.
- **The mid-query close is caught, but the window is not zero.** A Book closed between the second
  Desk read and the caller rendering the text is not detectable from here. The window is
  microseconds and closing it would need the Desk to hold a lock across the answer, which is a
  heavier boundary than the risk earns.
- **`match_count` is a floor whenever a scan budget bound the search**, and the answer says so. It is
  never silently an undercount, which was the first form of the defect above.

## Key Takeaways

- Discovery spans closed Books because it reads metadata; full text is confined to open Books because
  it returns the body. Two halves of one boundary, not two settings of one dial.
- A partial answer that does not admit it is partial is the failure this phase keeps designing
  against — so an out-of-scope Book, an unreadable Book, a skipped page, and a bound cap are all
  named, and the searched count falls to match.
- The Desk is read twice, and the second read is what makes *closed* mean closed even for a Book that
  was open when the query began.
- An open capture Book's unvetted notes are readable, and the answer says they are unvetted. That was
  decided rather than inherited.
- One cap must do one job. A budget that both shortens the answer and stops the search reports one of
  those two things wrongly, whichever sentence it picks.
- A mutation that fires nothing is a finding. A flag whose false value is asserted and whose true
  value is not has no test at all.
- 2.5's boundaries live in one file because three tiers reconciling three sets later is the drift this
  codebase has already paid for; moving Discovery's caps there changed no answer, and its suite is
  what proves it.
