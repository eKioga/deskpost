# Seats: one Library, many Desks

The reader's bottleneck was that hour-long tasks serialise. One workspace held one Virtual Desk, so a
second research topic meant closing the first topic's Books or cloning the checkout.

The finding that shapes all of this is that the Library was **already multi-topic**.
`raw/<project-slug>/`, `notebook/<project-slug>/`, both Catalogs and the shared collection already
held many subjects, and the lock primitive had been generalised past Books long before. The only
single-seat thing in the whole system was the Desk — two gitignored files.

So this adds **seats to the reading room** rather than cloning the library. One checkout, one
collection, one Shelf, one Notebook, one lock namespace, one Discovery index, N Desks.

A **seat** is a named place to work, carrying its own Desk and bound to exactly one Project.
`CONTEXT.md` is the authority for the term; [ADR-0015](adr/0015-the-desk-is-per-seat-one-library-many-seats.md)
is the decision, and [ADR-0016](adr/0016-reset-is-seat-scoped-recoverable-and-refuses-claimed-seats.md)
is the reset half.

[ADR-0018](adr/0018-a-seat-binds-to-a-conversation-by-verified-process-identity.md) amends the
**entry route** and nothing else: a seat may also be **bound** to a running agent process, verified
by process identity, which demotes `LIBRARY_SEAT` to a convenience that must agree with the binding
or be refused. Its code is landing in stages under `PLAN-seat-launch.md`. The **record**, the
**resolver** and the **Enter helper** landed on 2026-09-09, so a binding decides which seat every
guard, hook, helper and reader is on -- see *How a seat resolves* and *How a seat is entered* below.
**The one-click half landed on 2026-09-10** (steps 9 and 10): a session that starts with no seat is
handed the roster and the ask, and a resumed conversation is put back at the seat it last held if
that seat is free.

**And the reader can see that seat, which was the last thing standing between the one-click route
and a usable session.** *(Step 11, landed 2026-09-10.)* A session bound by the hook holds no
`LIBRARY_SEAT` — the agent button never set one — and step 0b measured that `CLAUDE_PID` does not
reach an MCP server, so for a day the **validated reader adapter had no identity at all**: it
resolved `unset` and refused every Book and Project page at a seat its guards agreed was open.
Measured before the fix: guard `named / omega / binding`, adapter `unset` — precisely the state
[ADR-0015](adr/0015-the-desk-is-per-seat-one-library-many-seats.md) rejects, a Desk open for the
guard and closed for the reader. The adapter resolves its seat **per request** now, identifying its
agent by its own process **ancestry**, so a seat bound while it is already serving is the seat its
very next request answers from — see *How a seat resolves*. Steps 12 to 14 (the terminal picker, the
Orca recipe, the overview) are conveniences beside it.

Landed 2026-09-07 as `PLAN-multi-desk.md` Release 2, steps 7-30, in one release. It could not be
phased: a half-migrated Desk leaves a Book **open for reading and closed for searching**, because the
reader and the search helpers resolve the Desk independently.

## There is no default seat

*(Ruled by Eric, 2026-09-07.)* The cosmetic tier had locked `main`, which collided with
`BASIC_MEMORY_DEFAULT_PROJECT=main` in the reader's own deployment — one word for two unrelated
concepts, exactly what the glossary's `_Avoid_` lines exist to prevent. Renaming it to `primary`
would have removed the collision and kept the real hazard.

**A default is the seat an unset `LIBRARY_SEAT` falls back to, and under the one-project-per-seat
binding that same seat holds live work.** So a process that lost its seat would not fail; it would
silently join whatever was in play there. That is the silent-merge shape this repository has paid for
twice already — a denylist that admitted `Append`, a guard that exited 0 when it could not resolve
its anchor.

Two refusals, deliberately different, each naming its own fix:

| State | What it means | What it says |
| --- | --- | --- |
| `unset` | `LIBRARY_SEAT` is not set | Start work with `tools/Start-LibrarySeat.ps1 -Seat <name>` |
| `malformed` | not a valid seat slug | what a seat name looks like |
| `unknown` | a valid name, no such seat | the seats that do exist, and how to create this one |

`Resolve-SeatName` classifies and never throws; `Get-DeskStateDirectory` is the single place the
refusal is worded, so a new caller cannot invent a friendlier message that means something else.

**`unset` is worded twice, and which one you get depends on the helper you ran** (2026-09-18). Most
helpers take a `-Seat` that names the seat the call is about, so their refusal offers it: *"or pass
`-Seat` explicitly"*. A few take a `-Seat` that means something else entirely —
`Set-NotebookTopicOwner.ps1`'s names the topic's **assignee**, which may be any seat — and for those
the acting seat can come only from a binding or `LIBRARY_SEAT`. Offering `-Seat` there sent the
reader round a circle at the point they were already blocked, which is what happened live on
2026-09-15: they had passed `-Seat` and were told to pass `-Seat`. Such a helper now declares itself
with `-ActingSeatOnly`, and its refusal names `tools/Enter-LibrarySeat.ps1` and the environment
instead, then says what its own `-Seat` is for. `seat.resolution-contract` pins that the two
refusals differ on **both** routes that word one — the seatless case and the
binding-versus-environment disagreement — and pins the ordinary remedy just as hard, because the
regression is a later edit merging the two branches back into one.

**The cost, stated rather than discovered.** Seat resolution sits upstream of the claim, so a session
that **names no seat** has no Desk: it can read the Library's own files and answer from them, and it
can open nothing, read no Book, and change nothing. All three Desk-reading surfaces already failed
closed on unreadable Desk state, so the direction was not invented here — but each takes an explicit
`-Seat` so an ad-hoc run never needs the launcher.

*(This said "started outside the launcher" until 2026-09-08, which the same sentence's own last clause
contradicts. The condition is the seat, never the launcher, and the difference is load-bearing: a
session handed a `LIBRARY_SEAT` by the IDE has a full Desk and reads with it, and it is only the
claim-gated mutators below that a missing claim stops. Proven by driving the validated reader as a
one-shot with `-Seat library-dev` from a session that held no claim, which read this workspace's own
Hub.)*

## How a seat resolves

*(Landed 2026-09-09, ADR-0018 and `PLAN-seat-launch.md` step 5. Pinned by `seat.resolution-contract`
and by case 13 of `seat.lifecycle`.)*

One function answers "which seat is this call about", and it consults three sources in one order.
The answer carries a `source` saying which one spoke, because a seat name from a verified binding and
the same name from an inherited environment variable are different facts.

| Order | `source` | What it is | When it is consulted |
| --- | --- | --- | --- |
| 1 | `explicit` | a `-Seat` argument | always first; nothing else is read, and no disk is touched |
| 2 | `binding` | a **committed** binding whose recorded agent is this process's own agent, matched on PID **and** start time | whenever no seat was named |
| 3 | `environment` | `LIBRARY_SEAT` | only when this process holds no binding |

**A binding and a disagreeing `LIBRARY_SEAT` are a refusal naming both**, never a silent preference
for either. The environment identifies a session and authenticates nothing, so a stale inherited
value that quietly won would read one seat's Desk while every write refused at another -- the
half-migration ADR-0015 rejects, arriving one variable at a time.

Three more refusals, each fail-closed for the same reason: treating "I cannot tell" as "there is no
binding" falls through to `LIBRARY_SEAT`, which resolves *a* seat, which is *a* Desk.

- **An unreadable binding** is refused rather than treated as absent.
- **Two committed bindings naming one agent** is corrupt state and is refused naming both: one agent
  process holds one seat for the life of that process.
- **A binding whose PID has been reused by a different process** binds nothing, and does not admit a
  mutation either. That is what recording the start time is for.

**A name that is not a seat name is told so, and told which seats there are** (2026-09-18).
That refusal names `tools/Get-DeskOverview.ps1` as the way to list them, and until this landed the
helper refused the very same input with the very same sentence -- the remedy was the thing that had
just turned the reader away. The overview now answers it. It is **still a refusal**: no Desk is
shown and the exit code stays non-zero, because the reader asked for a Desk and there is none to
give. What it carries now is the roster it sent them for -- the registered seats, and separately
any `.claude/seats/<name>` directory no registry entry claims, which is reported as what it is
rather than offered as a seat nothing can enter. One sentence serves every helper that resolves a
seat, so the fix went into the named remedy rather than into the wording, and `seat.resolution-contract`
reads the helper **out of the refusal** and runs it, both ways: the remedy must answer, and it must
still refuse.

### And which agent is asking: two routes, because one of them is missing where it matters

*(Landed 2026-09-10, step 11. Pinned by case 18 of `seat.lifecycle` and by section 7 of
`desk.two-seat-acceptance`.)*

The `binding` source above matches the binding's recorded agent against **this process's own agent**,
so something has to say which process that is. There are two routes and they are not
interchangeable:

| Route | What it reads | Who has it |
| --- | --- | --- |
| `environment-pid` | `CLAUDE_PID` | every helper, guard and hook — it is set in the agent's tool and hook children |
| `parent-chain` | the nearest **agent client** process above this one, found by walking parents | the validated reader adapter, which has no `CLAUDE_PID` at all (measured, step 0b) |

**`CLAUDE_PID` is INHERITED, and that is why the adapter asks for the ancestry route by name.** An
agent sets it for its *own* children, and everything those children spawn inherits it — which is not
the same claim. A Library-delegated `codex exec` runs from a Bash tool, so `codex.exe` inherits the
Claude session's value and hands it to the validated reader it launches; an adapter that read the
environment would resolve the *Claude* session's binding and serve that seat's Desk to Codex, while
Codex's own guards resolved Codex's seat. That is the guard-versus-reader disagreement this whole
step ends, arriving by the route meant to fix it. An MCP server is given no `CLAUDE_PID` of its own,
so any value it can see belongs to something else, and `Resolve-CurrentAgentProcess -AncestryOnly` is
what the adapter calls. A hook or tool child keeps the environment route, where the value really is
about the process reading it.

**The walk is not a `claude.exe` test.** The Codex Librarian's adapter has `codex.exe` for a parent
and carries neither `CLAUDECODE` nor `LIBRARY_SEAT`, so a name test written for one client would
refuse the other outright. The recognised names are declared in one place,
`Get-AgentClientProcessNames`, and each is pinned against a real process named after it — a copy of
`powershell.exe`, so the detector matches for the reason it matches in production. The comparison is
deliberately case-INSENSITIVE, the one such comparison in that file: an image name is the vendor's
to case, not ours. And the cost of getting that wrong is worse than a refusal, measured by making it
wrong: a case-sensitive match does not stop at a client shipped as `Claude.exe`, it walks **past** it
to whatever client sits higher in the chain — so the reader would serve another agent's seat rather
than say it could not tell.

Three properties of the walk are each a refusal a reader could meet:

- **Nearest wins.** A `codex exec` delegated from a Claude session puts `codex.exe` below
  `claude.exe` in one chain, and the adapter Codex launched belongs to Codex.
- **A shell in between is crossed, not tripped over.** The measured Orca chain is `claude.exe` under
  `powershell.exe -EncodedCommand`, so the walk climbs rather than inspecting one parent.
- **A parent that started after its child is a reused pid, and the walk stops there.** A parent id is
  only a number and is not cleared when the parent exits, so an adapter outliving its client would
  otherwise walk into whatever now holds that number — and attach to a *different* agent's binding if
  that happened to be another client. Stopping resolves no seat, which is the seatless refusal.

**One agent can have several adapters and nothing may assume otherwise**: measured on 2026-09-10, one
`claude.exe` had two validated-reader instances live at once. Both resolve the same agent.

**The seat is read per request; only the ancestry is held.** A process's parent is fixed at creation,
and a two-step walk costs about 42 ms against 1.6 ms to re-read one process's start time — so the
client is found once and its identity re-checked on every call, and a pid whose process has been
replaced stops answering. The **binding** is read from disk every single time, which is what makes a
seat bound after the adapter started the seat its next request serves.

**The reader lives in `BookRootSchema.ps1`, beside the resolver, and the writers do not.** Both
guards, the Desk-context hook and the validated-reader adapter resolve a seat with that file
dot-sourced and nothing else, so a resolver that could not see a binding would leave four consumers
reading the environment while every write verified identity. Writing a binding asserts the registry
lock, which is `LibrarySeat.ps1`'s, so `Write-SeatBinding` and `Remove-SeatBinding` stay there.

## How a seat is entered

*(Landed 2026-09-09, `PLAN-seat-launch.md` steps 4 and 7; the hook route 2026-09-10, step 9. Pinned
by cases 14 to 17 of `seat.lifecycle`, and by `seat.create-acceptance` under `-IncludeShared`.)*

Two routes, and they differ in **who holds the claim handle**, which is the only real difference
between them. A third is not a route the reader takes: the SessionStart hook calls the second one.

| Route | Use it when | Who holds the claim |
| --- | --- | --- |
| `tools/Start-LibrarySeat.ps1 -Seat <name>` | you are starting the agent, from a terminal | the launcher itself, in-process, for the life of the session it started |
| `tools/Enter-LibrarySeat.ps1 -Seat <name>` | the conversation has already started and has no seat | a **claim holder** the helper spawns, which outlives the helper and dies with the agent |
| the SessionStart hook, on a **resumed** conversation | never typed; it happens | the same claim holder — the hook calls the helper above and holds no rule of its own |

**With no `-Seat`, the launcher is a picker** *(2026-09-10, `PLAN-seat-launch.md` step 12)*. It is the
route beside the one-click one, for a session with hooks disabled, a non-Orca terminal, or a
recovery. One numbered line per seat -- seat, Project, `free`/`held`/`orphaned`, when it was last
active, and its last conversation -- and then a number resumes that seat's last conversation through
`claude --resume <id>`, `n<number>` starts a new one under a minted `--session-id`, `+` creates a
seat, `r<number>` retires one, and `q` leaves without sitting down. **A number on an EMPTY
conversation starts it again rather than resuming it** *(2026-09-11)*, under that same id and with one
line saying so; the paragraph below says when and why. Inside an Orca terminal it titles the tab
`seat: <name>` — not offered, and only once the claim is actually held.

**It decides where to sit and authorises nothing.** Every route it offers ends at the gate that
already owns it: the claim is `Enter-SeatClaim`'s atomic acquisition, so a seat that went `held`
between the list and the keystroke is refused exactly as a typed `-Seat` would be; creation runs
`Assert-NewSeatIsCreatable` and needs one confirmation bound to a `plan_id` the launcher revalidates
under the registry lock; retirement is `Retire-Seat.ps1`'s own preflight and approval. Two of the
five columns come from records that are explicitly advisory, so nothing shown gates anything.

**The roster has two layouts, and the terminal's width is only half of what chooses** *(2026-09-11)*.
The five-column table derives each column's width from the content, so it has no upper bound. Two sources feed that.
An orphaned seat carries a note, the note is parenthesised onto its state cell — 47 characters where
a healthy seat's is 4 — and because the widths are shared, that one row widens the state column **for
every row**. And the conversation cell is capped at 52 characters on its title path while its
`entry_note` path returns an **uncapped** sentence. No total is recorded here: it is a property of
whichever seats happen to exist, and it moved by 58 characters during the session that added this
paragraph. Read it from the roster, not from this page.

**Two rules choose the layout, and both end in the cards.** A terminal under **120 columns** takes
the cards, because the table can fit nothing there. And a table *measured wider than the terminal*
takes the cards as well, however wide that terminal is — which is the half a breakpoint alone would
have missed, since a long `entry_note` wraps a wide monitor too. Cutting the table's last column to
fit was tried on 2026-09-11 and reverted within the hour: with a 47-character state note in the
fixture the room left at 120 columns was 14, and the roster stopped showing the conversation title it
had just read, which `seat.lifecycle` case 19f caught. The table's whole value is density, and a
table that fits by deleting its content is worth less than a card that gives the same sentence a line
of its own. Otherwise the table is drawn exactly as before, uncut.

**A card carries one field per line.** The number, a state mark and the seat name sit on a head line,
then `Project`, `Last` and `Says` one per line — with the state note promoted to a `Note` field
rather than appended to the state, so the head line's length depends on the seat name alone and the
number the reader types stays at a fixed column on every card. No card line is sized from another
row, which is why this layout cannot overflow at all rather than merely overflowing less. The
wordmark banner is drawn **once on entry**, never inside the loop, because the loop redraws after
every refused keystroke and every retirement, and a banner per pass would push the list a reader is
choosing from off the top of a short screen.

**The alphabet and the colour are decided by the same probe, and a redirected run gets neither.**
Three measurements from 2026-09-11 sit behind that. A fresh `powershell.exe` runs at **codepage
437**, where the frame degrades to CP437's own box characters but the state marks become `?`, so the
picker raises `[Console]::OutputEncoding` to UTF-8 for a human and restores it afterwards — the
setting is process-global and the agent is launched after. Every file in `tools/` is stored
**BOM-less**, and PowerShell 5.1 reads a BOM-less file as ANSI, so a literal box character in
`SeatPicker.ps1` is a **parse error** rather than mojibake and the picker would not start; every
glyph is therefore built from its code point, and `seat.lifecycle` fails on any non-ASCII byte in
that file. And the width is read from `$Host.UI.RawUI`, never `[Console]::WindowWidth`, which throws
`The handle is invalid.` under a redirected stdin — which is how the gate spawns the suite and how
`-PickerInput` drives the picker. A **redirected** run renders plain ASCII without colour and
changes no encoding, so the gate, a pipe and a transcript all read the same bytes whatever codepage
the machine is in. Colour is suppressed by `NO_COLOR` on its presence, and carries only the seat
state, so turning it off loses no information.

### The one-click route from Orca: a Quick Command

*(`PLAN-seat-launch.md` step 13, verified by doing it on 2026-09-10 against Orca 1.4.198. This is a
wrapper around the first route above, not a fourth one — the launcher still holds the claim.)*

**The recipe.** Settings → **Quick Commands**, or the tab bar's **Add command**:

| Field | Value |
| --- | --- |
| Label | `Library Seat` — it names the button *and* titles the tab it opens |
| Action | Terminal (**not** *agent prompt*, which starts the agent directly with no launcher and no claim) |
| Scope | **Project**, this repository, so it appears in no other workspace |
| Command | `tools/Start-LibrarySeat.ps1` |
| Append Enter | on |

**The command is a bare relative path, and the obvious wrapper is wrong.** This plan first drafted
`powershell -NoExit -File tools/Start-LibrarySeat.ps1`. Orca's own source says the split-button
spawns a fresh terminal tab **in the worktree** and queues the text as that tab's startup command, so
that wrapper would spawn a *nested* shell inside the tab — and the launcher's claim is an open file
handle held for the life of its process, so the seat would belong to the inner shell rather than to
the tab. The bare path runs in the tab's own shell.

**What the run showed, which is the part no source could answer.** The button appears in the **tab
bar** as a split-button carrying the command's label, with a chevron for the rest. Clicking it opens
a new tab titled `Library Seat`, whose shell is **PowerShell** (the Windows default-shell setting)
and whose working directory is the **worktree root** — proven by the bare relative path resolving at
all. The picker's roster then renders and waits at `Seat:`.

Two independent measurements agree there: Orca's source says *in the worktree*, and a relative path
that resolved says the same thing from the other side.

**The tab carries the label until a seat is held, then the seat's name.** At the roster every tab
this button opens is titled `Library Seat`, because that is the Quick Command's label. Once a seat is
chosen and its claim is actually held, the launcher retitles the tab `seat: <name>`.

**That rename stopped being a question on 2026-09-14**, ruled by Eric after meeting the prompt. It had
been offered with a yes, and the only other outcome was the label above — the **same string on every
tab the button opens**, so declining bought a reader identical tabs and no way to tell which seat each
one held. A custom title was considered and is deliberately not a route. The move is a boundary one
rather than one keystroke: a tab title touches nothing durable and Orca undoes it in a keystroke,
while this picker's real confirmations are a seat created, a Hub written to the shared collection and
a Desk archived — and a cosmetic yes standing beside those is what teaches a reader to type yes
without reading the plan above it. Nothing is printed on success, because the tab bar is showing them
the answer; a failure still speaks, since that is the case where the tab does *not* say where they are
sitting. The one opt-out left is `-TerminalHandle ''`, which is the suite's rather than the reader's:
it is how `seat.lifecycle` runs inside an Orca terminal without retitling the developer's own tab.
The rule it generalises to — what earns a confirmation and what does not —
is [ADR-0021](adr/0021-a-cosmetic-reversible-action-is-performed-not-offered.md).

**The seat this session is at renders `held`, and that is the button working.** A reader who clicks it
while a session is running sees their own seat as occupied and picks another or types `q`; the claim
is only ever refused atomically at acquisition, never from the roster's probe.

**Expect the last-conversation column to be empty at a seat entered with a typed `-Seat`.** The
launcher can only record a conversation it *minted*, which is the picker's own `n<number>` route — a
reader who typed `-Seat` started a conversation whose id the launcher never saw. That is the honest
answer rather than a fault, and giving a seat a conversation *history* is step 8's item.

**A caller that cannot be asked is refused, not waited on.** A script, a hook, an agent tool call and
a piped invocation all reach it with stdin redirected -- measured -- and are told to pass `-Seat
<name>`. `-Preflight` with no seat is a different refusal, because a plan for a seat nobody has
chosen is not a plan.

**Where the conversation and its title come from.** A seat still remembers ONE conversation, not a
history: whichever of two records is newer -- the binding's own `session_id`, or the advisory one the
launcher writes when it mints a conversation, which is the only record a launcher-started session can
leave, since the launcher holds the claim handle itself and the agent inside it is refused a binding.
The title is read out of the transcript's `ai-title` record; measured over the 165 transcripts in this
checkout on 2026-09-10, 92 carry one and 73 do not, and none changed within a session, so a bounded
head read finds every title that exists. Six ways a title can be missing each get their own sentence
on the line -- an old client wrote none, this configuration has no transcript for that id, the id is
not an id, the file would not open, the head budget ran out, nothing recorded a conversation at all --
because a blank column reads as an untitled conversation and cannot tell them apart.

**A conversation that recorded nothing is started again, not resumed** *(2026-09-11)*. Claude Code
writes a transcript on the first turn, so a session the reader never typed into leaves none: the
launcher had minted the id, passed it to `claude --session-id` and recorded it, and the number beside
that row then composed `--resume` onto a conversation that had never existed -- `No conversation found
with session ID`, and no session at all. The roster had already said `no transcript for it under this
configuration` on the same line. So the roster now says what typing the number will DO, and the number
composes `--session-id <the same id>`: nothing is lost, because nothing is in it, and the seat's two
records go on naming the conversation actually sitting at it.

**It is narrowed to an id this checkout minted, and that narrowing is the load-bearing part.** A
transcript not found is not a deleted transcript -- a redirected `CLAUDE_CONFIG_DIR`, another machine,
a pruned history -- and for any id of unknown provenance `claude` is still the authority, still gets
`--resume`, and still answers for itself. What changes the answer is a `source: launcher` record in
that seat's own `conversations.json`: `.claude/seats/` is gitignored, so such a record was written by
this machine, and there is no configuration in which that conversation's transcript lives somewhere
this checkout cannot see. `Get-SeatConversationEntryAction` derives it beside the transcript fact it
turns on, so the line the reader reads and the decision their number makes cannot disagree. Measured
against the installed binary: `--session-id` accepts an id with no transcript and refuses one that has
a transcript, so a wrongly derived restart fails at the agent rather than forking two conversations
onto one id. `seat.lifecycle` case 19a pins both rows -- minted-here and unknown-provenance -- and
19g-2 drives the picker for the argv.

**A Desk write does not erase which conversation is at the seat** *(2026-09-11)*. `Write-SeatActivity`
replaces the advisory record whole and clears its conversation by default, which is right for an entry
that started none. Opening a Book is not an entry, and clearing there left a launcher-started seat --
which holds no binding to fall back on -- with nothing naming the conversation sitting at it: the
picker said "nothing has recorded a conversation at this seat" about a live session and refused to
resume it. `tools/Set-VirtualDesk.ps1` passes `-KeepConversation`, which carries the id and its
ORIGINAL stamp forward so the newer-record comparison above is unaffected. Pinned in
`helpers.selftest`, which asserts the record was rewritten before asserting what it kept.

**Both creation routes now build the same Desk** *(2026-09-10)*. A new seat opens its own Project Hub
and nothing else. The launcher created its Desk empty until then, so which route created a seat
decided whether the session that entered it could orient itself; `Get-NewSeatDeskEntry` is the one
definition and `seat.creation-gate` holds both routes to it, the same way it holds them to the
validation gate.

**Why the second route needs a holder at all.** A claim is an open file handle, which is what makes
it end exactly when its holder does -- including when the holder is killed. The launcher *is* the
session, so it can hold the handle for hours. A helper invoked from a tool call lives for a second
while the agent it is binding lives for the whole conversation, so something has to outlive the
helper and die with the agent. `tools/Invoke-SeatClaimHolder.ps1` is that something.

**Every holder launch is a self-abandoning attempt.** `.claude/seats/<seat>/holder-attempt.json`
carries an id, a deadline and a state; the holder opens the handle and then polls that record. If the
record is gone, already `abandoned`, or still `pending` when the deadline passes, it releases the
handle and exits. So a helper killed mid-handshake leaves a handle that lets go by itself rather than
one nobody can release, and a child that starts late never acquires one at all.

**The binding commits before the attempt, and the order is a ruling rather than a style.** A helper
that dies between the two writes leaves a committed binding whose holder never sees its attempt
committed -- the holder abandons itself, the seat reads `orphaned`, and the same agent's next entry
repairs it, which the matrix already allows. The reverse order leaves a permanently held handle over
a binding nothing can recognise.

**Entering an existing seat changes no material.** It is entered on the reader's word, with no
preflight, and the Desk is left exactly as it was (ADR-0010). Three refusals it can give, each with
its own fix: another agent holds the seat; the seat is `orphaned` and belongs to a conversation that
must re-bind it; or **this agent is already bound to another seat**, which names that seat, because
one agent process holds one seat for the life of that process.

**Creating a seat takes one confirmation bound to a `plan_id`** (ruled by Eric). The preflight reads
the Active Project Catalog **outside every lock** -- a network read inside the registry lock stalls
every other seat -- and validates that the Hub exists and is active, that no other seat holds the
Project, and that no ownership row or seat archive still cites the slug. With no `-Project` it lists
the active ones to offer rather than refusing. The confirmed run is one registry-locked transaction,
and an uncommitted creation aborts explicitly: the attempt is abandoned, the handle is waited out,
and the seat directory and registry entry are removed **only once that handle has actually closed**.
When it has not, the seat is left whole and registered rather than half-removed -- a registered seat
with a Desk and no binding is what a successful creation minus the bind looks like, so the reader can
enter it or retire it, where a directory with its Desk files deleted and its claim file refusing has
no route at all.

**Slug reuse stays refused while any record cites it.** Ownership rows are keyed by seat slug this
release, so a new seat under a retired seat's name would inherit that seat's Notebook topics at its
first reset. *Give retirement an identity* is the item that propagates `seat_id` into those rows; the
refusal is what holds the line until it lands.

**A session that starts with no seat is told so, and a resumed one is put back.** `.claude/hooks/`
`Get-SeatStartContext.ps1` runs on `SessionStart` and reads the payload's `source`. On `startup`,
`clear`, `fork` — or any value the documentation has not named, which is treated as a fresh start
because the worst that costs is a question the reader did not need — a seatless session is handed the
section below plus a **generated** roster of every seat, its Project and its liveness. On `resume` it
looks the conversation up in the seats' conversation histories, and if the newest record names a seat
that still exists under the same `seat_id` and is `free`, the hook calls `Enter-LibrarySeat.ps1` and
says so. A `held` or `orphaned` seat is reported and never taken; a retired one and a reused slug get
different sentences, because they need different next steps. A conversation with records at more than
one seat takes the newest and is TOLD about the rest. On `compact` it says nothing at all: the Desk
line below has already said it on every prompt.

**And the validated reader sees the seat it binds, since step 11 landed on 2026-09-10.** For a day
it did not: the adapter has neither `CLAUDE_PID` nor `LIBRARY_SEAT` in a button-launched session, so a
seat this hook bound was invisible to it, and a reader who asked for a Book page was refused by the
reader rather than by the Desk. The adapter resolves per request from its own ancestry now, so the
binding this hook writes is live for an adapter already running beside it, with no restart.

**Its deadline is about two seconds and its failure is the roster, never a blocked session.** Step 0d
measured the registry lock refusing at 2108 ms against a held lock and a real Desk write holding it
for under a millisecond. Every path out of the hook emits guidance or silence; none denies, and none
exits non-zero.

**The Desk line on every prompt is the status line, and the backstop recorder.** Since 2026-09-10 it
says which of four states the seat is in rather than only its name: `bound to this conversation`
(verified identity), `holder lost` (an **orphaned** seat, which reads normally and refuses every
write — the state a bare name hid, found at the moment a session tried to change something),
`named by LIBRARY_SEAT` (a launcher-started session, which a resume cannot find again), or `named
explicitly` (a one-shot run). When the process holds a binding that does not yet name this
conversation, it records it — taking the registry lock **only** in that case, and at most once per
session, so a persistently failing write is not retried before every turn.

### A seat remembers every conversation that has sat at it

*(Landed 2026-09-10, `PLAN-seat-launch.md` step 8, which closed the cost the two paragraphs it
replaces here had stated. Pinned by case 21 of `seat.lifecycle`.)*

Until this landed the resume lookup read the **binding's** own `session_id`, and a seat holds one
binding — so a seat re-bound by a second conversation forgot the first, and resuming the first was
offered the roster instead of its own seat. `.claude/seats/<seat>/conversations.json` is the history
that closes it: **versioned**, keyed by conversation id with `seat_id`, `source`, `first_seen_utc` and
`last_seen_utc`, and **written only under the registry lock**.

**It locates; it never authorises** (ADR-0018). Every read of it decides which seat to *offer*. The
hook still enters through `Enter-LibrarySeat.ps1` and meets the operation-by-state matrix exactly as a
typed `-Seat` would, which is why a record the **launcher** wrote — a minted id, no process verified —
sits in the same file as one a verified binding wrote. `source` says which of the two, and nothing
reads it as identity. Without the launcher's record the history would be blank at exactly the seats
the one-click route creates, because a launcher-started session can never hold a binding.

**Nothing is pruned automatically.** A transcript that cannot be found under the current
configuration is not a deleted transcript — a different `CLAUDE_CONFIG_DIR`, a different machine and
a pruned history all look identical from here. Retirement archives `conversations.json`,
`binding.json` and any holder attempt beside the Desk, and the preflight names which of them the seat
actually has.

**A seat bound before the record existed is migrated, and the migration runs at every
registry-locked commit point.** That is not belt-and-braces: `Enter-LibrarySeat.ps1` writes a
`pending` binding *before* it commits the new one, and that write is what destroys the committed
record being migrated — so seeding only where a conversation is recorded would seed from a binding
already overwritten. The orphan recovery path writes no binding at all and records no conversation,
so it needs the same call. Found by running the helper rather than by reading it; a probe that wrote
a committed binding directly passed.

**Which conversation a seat LAST held is a different question, and stays where it was.** The Desk
overview's line and the picker's roster still take whichever of the binding and the advisory
`activity.json` record is newer (`tools/SeatConversation.ps1`). Deriving that from the history
instead would name whatever conversation touched the seat last even after another agent bound it,
which is the opposite of what a Desk line means.

## What the Desk overview says about a seat

*(Landed 2026-09-10, `PLAN-seat-launch.md` step 14. Pinned by case 20 of `seat.lifecycle`.)*

`tools/Get-DeskOverview.ps1` answers "what's on my desk?", and until this landed it answered the
occupancy question about **every seat but this one**: it reported another seat's counts and liveness
and said nothing at all about the seat the reader was sitting at. So the one thing a reader cannot
find out any other way — am I actually sat down here, since when, and as which conversation — was the
one thing the overview did not say.

**This seat's own line now carries the agent identity, the bind time and the last conversation**, on
a `this_seat` object beside the existing `other_seats` list:

| Field | What it answers |
| --- | --- |
| `seat_source` | which of the three sources named this seat — `explicit`, `binding`, `environment`. A seat named by `LIBRARY_SEAT` is a name and not a verified binding (ADR-0018), and the overview says so rather than presenting both the same way. |
| `claim_state`, `claimed`, `state_note` | `free` / `held` / `orphaned`, with `claimed` derived from the same read so the two can never disagree. An `orphaned` seat's note names the agent still running **and** the repair. |
| `agent_pid`, `agent_start_utc` | which process holds it, and the start time that stops a reused PID inheriting the binding. |
| `bound_utc`, `seat_id`, `binding_state`, `binding_stale` | when the seat was bound, to which incarnation, and whether that record is `pending`, `committed` or outlived its agent. |
| `session_id`, `conversation_source`, `title`, `title_status`, `conversation_line` | the conversation this seat last recorded and what it is called. `conversation_line` is **never blank** — every way a title can be missing gets its own sentence, the same wording the picker's column uses. |
| `is_this_conversation` | whether that conversation is the one reading the overview, rather than the one before it. True only when the binding names this process's agent *and* the binding is the record that won. |

**The cosmetic tier is not widened by this, and that is a ruling rather than a preference** (locked
2026-09-07). Another seat stays counts and liveness. Everything in the table is read for **this** seat
alone, which is why the picker's `Get-SeatPickerRows` is deliberately *not* called here even though it
builds the same shape: it reads a title for every registered seat, because a reader choosing between
seats needs that, and calling it here would put another reader's conversation title on this Desk.
Case 20 plants a titled conversation at a foreign seat and asserts the payload never says its name —
while asserting that seat's counts and liveness *are* still there, so the guard cannot pass by the row
going missing.

**One derivation, two surfaces.** `tools/SeatConversation.ps1` holds it: the newer-of-two-records
rule, the transcript head read, the six title statuses and the never-blank cell. The picker draws a
numbered roster line whose columns are measured across every seat; the overview emits one seat in
full. Those are different shapes and each renders its own — what is shared is the facts and the
wording, because this document has already paid for one rule written twice.

**The `scope` field grew because the read did.** Reading a conversation title reads a Claude Code
transcript, which is a file outside the workspace, so the line now says so. It still promises that no
Book or Project page content was read and that no other seat's conversation was looked up. A reported
field that describes *less* than the operation performed is the same defect as one describing more.

**And a `seat_consistency` block, added 2026-09-10 with retirement's identity.** The registry and the
seat directories are written in one registry-locked transaction, so they can only disagree because
something outside this system touched them — a hand deletion, a hand-edited registry, a partial `git
clean`. Both trees are gitignored, so no commit restores either. Until that day a disagreement was
not merely unreported: **a seat missing from `.claude/seats/` was how "retired" was decided**, so
deleting one folder handed every topic it owned to the next whole-tree reset. That is inert now, and
inert-and-invisible is how a workspace stays broken.

| `state` | What it means | What clears it |
| --- | --- | --- |
| `ok` | registered, with its Desk directory present | — |
| `desk-missing` | registered, no directory: the Desk is gone and the seat is **not** retired | `tools/Retire-Seat.ps1 -Seat <name>`, which works on a seat whose Desk files are gone |
| `unregistered` | a directory no registry entry names: nothing can enter, retire or reset it | copy what you need out of it and remove it, or restore the registry entry |

`faults` carries one worded sentence per problem, each naming its route, and an archive directory
with no readable `seat.json` is a fault too — it records no retirement, so it licenses nothing.
`consistent` is the single boolean. **This does not widen the cosmetic tier**: the ruling keeps
another seat's *material* off this Desk, and whether a seat's records are coherent is workspace
integrity, the same class of fact as the `claimed` flag that row has always carried.

## Sitting down at a seat

*(Served verbatim to a seatless session by `.claude/hooks/Get-SeatStartContext.ps1`, per
[ADR-0014](adr/0014-a-hook-delivers-a-document-it-does-not-hold-a-rule.md): the hook holds no
wording of its own, and `seats.session-start-section-resolves` fails the gate if this heading is
renamed. Keep it short and keep it imperative — every word is paid for at the start of every
seatless session. The seat roster that follows it is generated, never written here.)*

This session holds no seat, so it can read the Library's own files and nothing else: no Book, no
Project Hub, and no change to anything in the Library. **Ask the reader which seat they want, in one
plain sentence, and wait.** Do not guess it from the repository, and do not start work first.

Then bind it from a tool call **in this conversation**, so the seat binds to this agent process:

    tools/Enter-LibrarySeat.ps1 -Seat <name>

A seat that does not exist yet takes one confirmation of both slugs: run `-Create -Preflight` with
that name, show the reader the seat and the Project it would be bound to, and rerun with
`-UserConfirmed` and the exact `-ApprovedPlanId` after one clear yes. A reader already at a terminal
starts one instead with `tools/Start-LibrarySeat.ps1 -Seat <name> -Project <project-slug>`.

## Writing into `notebook/`

*(Ruled by Eric 2026-09-10, after the first proposal was refuted by the flow it would have broken.
Pinned by case 3c of `desk.two-seat-acceptance`.)*

The seats review found that the `Read|Grep|Glob|Write|Edit` guard judged **Shelf paths only**, so a
plain `Write` into `notebook/` took no claim, checked no ownership and rendered no index — while
`CLAUDE.md`, `CONTEXT.md` and this document all promised that a seatless session *changes nothing*.

**The obvious fix was wrong, and checking the reader flow before building is what caught it.**
Extending the guard to refuse `notebook/` outright would have bricked the core flow: authoring a
Notebook article **is** a direct file write, the playbook describes the render and the ownership
record as the Librarian's own obligations, and no helper does it. A whole-collection guard meeting
its own day-one data.

So the guard covers the **claim and the ownership, never the authoring**. Two refusals and nothing
else:

| Refused | Why |
| --- | --- |
| a `Write`, `Edit` or `apply_patch` under `notebook/` from a session that resolves **no seat** | it would leave material in a seat's namespace with no claim, no ownership record and no rendered index — the sentence three documents already made and nothing enforced |
| a write into a topic **another seat owns** | that seat's ordinary reset would quarantine it, which is the defect `Test-NotebookTopicWritable` was written for on 2026-09-09 |

Everything else is untouched, and that list is the safety boundary rather than a summary of it: a
seat writing its **own** topic, a `shared` or `excluded` topic, a **topic that does not exist yet**
— which is how every article starts, so it needs no ceremony at all — a loose file directly under
`notebook/`, any path outside `notebook/`, and every **read**.

**The verdict is not conditioned on the other seat being live**, and the proposal said it should be.
A dormant seat's topic is precisely the one whose next reset quarantines whatever was written into
it, and a guard permitting what the helpers refuse would teach a rule the rest of the system does not
have. It is the same `Test-NotebookTopicWritable` verdict the compiler, Triage and the reset enforce
— the lock-free `Test-` form, because a PreToolUse hook may take no ordered lock.

**What it still does not reach.** `Guard-ShellShelfRead.ps1` judges shell commands for Shelf paths
only, so a heredoc write into `notebook/` from `Bash` or `PowerShell` is ungated, exactly as it was
before. And a well-formed seat name that no registry knows resolves as `named`, so it is judged by
ownership rather than by the seatless rule.

## Where a Desk lives

```
.claude/seats/<seat>/.open-books
.claude/seats/<seat>/.open-projects
.claude/seats/<seat>/.claim              the exclusive session claim
.claude/seats/<seat>/binding.json        which agent holds this seat NOW, by verified identity
.claude/seats/<seat>/conversations.json  every conversation that has sat here; registry-locked
.claude/seats/<seat>/activity.json       advisory, and never a gate
.claude/seats/_registry.json             which seats exist, and the Project each is bound to
```

`$StateDirectory` still means `.claude`. `_registry.json` cannot collide with a seat, because a seat
slug is `[a-z0-9][a-z0-9-]*` and cannot hold an underscore — the same guarantee `shelf/_archive`
relies on.

**`BookRootSchema.ps1` owns the Desk's location**, because it already owned its content schema. The
two filenames are spelled in exactly one function in the whole repository, and
`desk.seat-paths-resolve` asserts it. That check is necessary and not sufficient: it proves the
literals disappeared, not that every consumer resolves the same *seat*, which is what the two-seat
acceptance tests are for.

**A Desk file is replaced by rename and read with a retry, and the two are one contract**
(2026-09-18). `AtomicFile.ps1:6-9` states it: `Write-AtomicText` guarantees a reader never sees a
*partial* file, and `Read-AtomicBytes` is what makes that guarantee usable, because the rename-over
holds the destination for an instant and a reader arriving in that instant is refused rather than
served. Until that date the Desk had **neither half** — `Set-VirtualDesk.ps1` and the reset's
`-ClearDesk` truncated in place, and twenty-one reads across seventeen files each carried their own
copy of the same `Get-Content` pipeline.

**The registry lock is not a substitute for this, and that is the whole reason it matters.** The lock
serialises *writers*; every Desk **reader** holds no lock at all by design, because a question about
one seat is exactly what an atomic replacement already answers (`Get-DeskEntriesForSeat` says so, and
its docstring had been saying so for nine days before it was true). Three of those readers are hooks,
which is the worst place for the failure to land: a `PreToolUse` guard that reads a zero-length Desk
denies the reader's tool call and explains nothing. So every read now goes through
`Get-DeskFileEntries` — or `Read-DeskFileLines` where a caller wants the raw lines, or
`Read-AtomicBytes` where it wants the bytes verbatim — and every write through `Write-AtomicText`.
`desk.state-read-and-written-atomically` holds both halves.

**And neither of them watches the OTHER directory.** The pin `.claude/.library-project` is the
WORKSPACE's and is shared by every seat; the Desk files belong to one seat. A consumer can compose
no filename, resolve the right seat, and still hand the workspace pin's reader a seat directory —
which is what `Read-ValidatedProjectCatalog` and `Read-ValidatedActiveProjectRoot` did, measured
2026-09-08: `read_project_catalog` and `suggest_active_projects` were refused at every seat with
*Virtual Desk configuration is missing `.library-project`* while `read_open_project_page`, which
routes through `Get-DeskState`, answered in the same session. Both now resolve it through
`Get-DeskProjectId`, which takes the two directories for the two things they are, and
`reader.project-pin-selftest` is the check that holds it.

## The three synchronisation mechanisms, and only one is a lock

**1. The ordered locks.** Five classes, one total order, gate-enforced:

```
registry/Desk  ->  Book (sorted)  ->  topic (sorted)  ->  render  ->  notebook-topic-owners
```

**The last two swapped places on 2026-09-09, and it is a ruling rather than a tidy-up**
([ADR-0019](adr/0019-a-topics-ownership-changes-only-under-its-topic-lock.md)). The ownership record
lock was declared *third* while all three Notebook writers took it **inside** a topic lock — they
record ownership at the end of promoting a topic — so the declared order had been inverted by every
writer since it was written, harmless only because the reset released that lock before taking any
topic lock. Conforming the writers to the old position would have meant holding a single global
record lock for the whole duration of a compile. The rule that replaced it: **a topic's ownership
changes only while that topic's lock is held**, so the record lock covers one file's
read-modify-write and is the narrowest, last-acquired thing in the system.

Everything that mutates the registry or any Desk takes the first one: seat creation, retirement,
migration, `Set-VirtualDesk`, reset, rename, archive and remove. Before this, every cross-seat Desk
inspection was check-then-act — a seat could open a Book after archive had scanned the Desks, and
rename could overwrite another seat's simultaneous Desk edit. `Set-VirtualDesk` took no lock at all.

**That sentence became true on 2026-09-09, and until then it was wrong about four of the eight.**
The seats review found the registry lock taken by `Set-VirtualDesk`, `Start-LibrarySeat` and
`Retire-Seat` and by nobody else: reset, rename, archive and remove all scanned across seats without
it, and remove then closed only the *calling* seat's Desk before deleting — leaving every other
holder an entry naming a Book that no longer existed, and entitling it to whatever Book landed on
that slug next. No concurrency was needed for that one. The gate was green throughout, because
`desk.lock-order` flags an inversion between two acquisitions and is blind to an absence.

**So the contract moved out of this paragraph and into the code.** The functions that read or write
across seats — `Get-DeskEntriesAcrossSeats`, `Get-SeatsHoldingEntry`, `Update-DeskEntryAcrossSeats`,
`Set-DeskEntryForSeat` and `Get-NotebookResetTargets` — call `Assert-SeatRegistryLockHeld` and refuse
to answer at all unless this process holds the lock. `Enter-BookLock` keeps an in-process ledger of
what it has acquired, because the lock file is opened with `FileShare::None` and not even its holder
can read its own `pid=` line back. `desk.registry-lock-coverage` then reads the declaration in
`LibrarySeat.ps1` and compares it with the code in both directions, and falsifies the assertion
against a fixture, so an assertion reduced to `return $true` fails the gate rather than passing it.

One consequence worth knowing: **a helper holding this lock cannot shell out to
`Set-VirtualDesk.ps1`**, which takes the same non-reentrant lock and would wait on its own parent.
`Remove-ShelfBook.ps1` did exactly that and now writes the Desk in-process through
`Set-DeskEntryForSeat`. The claim assertion moved with the write, which is why that helper is now
one of the claim-gated set — on its Desk-writing path only. Deleting a *closed* Book still needs no
claim, exactly as before.

**2. The session claim is a non-blocking exclusion probe, and is NOT an ordered lock.** It is an open
file handle held by the launcher for the life of the session, which is a span no ordered lock may
cover. It ends exactly when the process does, including when it is killed — the property a
written-down "who is active" record can never have. Nothing waits on it.

That non-blocking property is load-bearing. If claim inspection could wait while holding an ordered
lock, reset would hold the registry lock waiting for a foreign session's claim while that session
waited for the registry to update its Desk: a deadlock between two operations that are each
individually correct.

The claim's share mode is `FileShare::Read`, and that is not a detail. `::None` excludes every other
opener including a legitimate reader, so the token of a held claim could not be read and the check
refused the very session holding the seat. Found by running it.

**3. `activity.json` is advice and never authorizes or unblocks a mutation.** It is a lock-free
atomic replacement through a unique temp file, needs no seat lock, and joins no order. It is
deliberately not called a lease, because it is not one. It carries no PID unless a durable process
identity is supplied: the hook process that would write one is dead immediately afterwards, so its
PID would name a process that no longer exists and would read as authoritative liveness.

**Liveness is the claim, never the Desk.** `CONTEXT.md` defines the Desk as what is *in play*, not
process liveness: an abandoned seat stays non-empty forever, and an active seat can be writing
Notebook material with an empty Desk.

## The launcher is mandatory for mutation; reads are unaffected

**The mutators that write `notebook/` or a Desk require a matching live claim token and fail closed
without one**: the compiler, Triage, `Reset-LocalNotebook`, `Restore-BookSource`, `Set-VirtualDesk`,
`Set-NotebookTopicOwner`, and — on its Desk-writing path only — `Remove-ShelfBook`. Read the count from
`Get-ClaimGatedHelpers`, not from here; a number written into prose is the shape this section has
already had to correct twice. Without the claim the liveness model is advisory: an
agent launched directly, inheriting a `LIBRARY_SEAT`, would carry no claim and could still change its
Desk or its Notebook — and reset would then classify genuinely active work as dormant and quarantine
it. That is what the claim is for, and it is why the set is those two surfaces rather than everything
that writes.

**Three other seat-aware mutators deliberately do not, and that is the design rather than a gap.**
`Edit-ProjectHub` and both manifest updaters consult this seat's Desk to decide entitlement and write
outside `notebook/`, so no reset ever judges their output. `Get-ClaimGatedHelpers` in
`tools/LibrarySeat.ps1` declares the set, and `desk.claim-coverage` reads that declaration rather
than restating it.

**`Set-NotebookTopicOwner` joined the set on 2026-09-09, and the question it asks is a different
one.** This section used to explain its absence: its `-Seat` names the topic's **assignee**, not the
acting session, so requiring that session to hold *that* seat's claim would answer the wrong
question, since a topic may be assigned to a seat that is deliberately dormant. All of that is still
true, and it was the wrong conclusion. What the helper needed was the **acting** session's claim —
the same question every other member of the set is asked. Without it, a session holding no seat at
all could reassign a live seat's topic to itself and then reset it as its own.

**`Remove-ShelfBook` joined that set on 2026-09-09 without changing anything a reader can do.** It
always needed a claim to delete an *open* Book, because it closed the Desk by invoking
`Set-VirtualDesk`, which demands one. Taking the registry lock made that child process impossible —
it would have waited on its own parent — so the Desk write moved in-process and the claim assertion
had to move with it or be silently dropped. `desk.claim-coverage` proves the assertion is *invoked*,
not that it is reached on every path, which is what makes a conditional assertion honest there.

*(Corrected 2026-09-08. This section, `Start-LibrarySeat.ps1`'s help and `Assert-SeatClaimHeld`'s own
docstring all said EVERY seat-aware mutator required a claim, and the help named editing a Hub as
something the launcher was needed for. Not every seat-aware mutator does: the table below is the
rendering of `Get-ClaimGatedHelpers` and is the only place to read the set from. Nothing in the gate
could have caught the prose — every one of those sentences was reachable, well-linked and false,
which is `docs.links-resolve`'s standing limit.)*

*(And corrected again 2026-09-10, which is the point. The 2026-09-08 correction wrote a **count** —
"five call the assertion" — into the fix for a stale list, and four helpers joined the set over the
following two days: `Remove-ShelfBook` and `Set-NotebookTopicOwner` on 09-09, and both quarantine
routes on 09-10. A number is a copy of a declaration exactly as a list is. The table below is
derived and checked; this paragraph now names none.)*

The deciding argument was that a per-pane mechanism to set `LIBRARY_SEAT` is needed regardless, so
the launcher **is** that mechanism rather than an extra step.

**And the mechanism has to be one the reader actually uses.** Ruled 2026-09-08. The IDE has **two
kinds of launch button and only one of them bypasses this launcher.** Its *agent* buttons (Claude,
Codex) run the agent binary directly, so a session started from one has no seat and no claim — that
is the state this contract's refusals describe. Its *terminal* buttons (`New Terminal: PowerShell`,
`Ctrl+T`) give exactly the shell parent this launcher was built for. So Library work starts in a
terminal pane and runs the launcher there. Nothing in the IDE is configured, so nothing can go stale,
and the seat stays named by `LIBRARY_SEAT` rather than derived from an opaque pane key that changes
when a pane is recreated. A non-Orca terminal session is identical, and an ad-hoc read still needs
only an explicit `-Seat`.

**What was measured, and what the measurement retired.** Orca can vary environment per agent
(`settings.agentDefaultEnv`) and per pane (`launchConfig.agentEnv`), and can replace an agent's
command (`settings.agentCmdOverrides`) — which resolves `PLAN-multi-desk.md` risk 4. But all three are
profile-global in build 1.4.197, which has no custom-agent entry and no per-repo agent field, so
aiming the Claude button here would run this launcher in every workspace and would need a
workspace-guarded wrapper to be correct. Investigated and rejected: the terminal pane needs none of
it.

*(And the first framing of this was too strong, corrected the same day. It said the launcher "assumed
a shell parent it never gets" and was "a launcher nothing launches" — written after measuring how one
button launches and then generalising to the whole IDE. Orca supplies a shell parent one keystroke
away. What is true is narrower and duller: the agent button bypasses the launcher, and Library work
had been starting there out of habit. Measuring a platform does not help if the workflow claim built
on top of it goes unmeasured, and this file asserted the stronger version for about an hour.)*

`Set-VirtualDesk -Action List` is a read and needs neither the claim nor the lock. That is how a
session without a claim still sees what is open.

## The contract, in one table

*(Added 2026-09-10. Checked by `seats.contract-table-matches-code`, which compares every column
against the declaration it renders, in both directions.)*

**This table is a rendering, not a second authority.** Four declarations in the code decide what is
in it — `Get-RegistryLockedHelpers`, `Get-ClaimGatedHelpers`, `Get-TopicLockedHelpers` and
`Get-SeatCreatingHelpers` — and the check fails if a cell here disagrees with any of them, or if a
helper they name is missing a row, or if the test a row cites is not a registered check. That
matters more here than anywhere else in this document: **the registry-lock rule was restated in
prose four times and all four were wrong for four helpers**, with the gate green throughout. The
narrative of how that happened is the next section but one; this is what is true now.

| Helper | Cross-seat: asserts the registry lock | Needs a live claim | Writes topic ownership | Creates a seat | Proved by |
| --- | --- | --- | --- | --- | --- |
| `tools/Archive-ShelfBook.ps1` | yes | no | no | no | `desk.registry-lock-coverage` |
| `tools/Compile-RawBatchToNotebook.ps1` | no | yes | yes | no | `desk.topic-lock-coverage` |
| `tools/Enter-LibrarySeat.ps1` | yes | no | no | yes | `seat.lifecycle` |
| `tools/Invoke-LibraryTriage.ps1` | no | yes | yes | no | `desk.topic-lock-coverage` |
| `tools/Remove-NotebookQuarantine.ps1` | no | yes | yes | no | `recovery.routes` |
| `tools/Remove-ShelfBook.ps1` | yes | yes | no | no | `desk.two-seat-acceptance` |
| `tools/Rename-ShelfBook.ps1` | yes | no | no | no | `desk.registry-lock-coverage` |
| `tools/Reset-LocalNotebook.ps1` | yes | yes | yes | no | `reset.vocabulary-routes` |
| `tools/Restore-BookSource.ps1` | no | yes | yes | no | `desk.claim-coverage` |
| `tools/Restore-NotebookQuarantine.ps1` | no | yes | yes | no | `recovery.routes` |
| `tools/Set-NotebookTopicOwner.ps1` | no | yes | no | no | `desk.topic-lock-coverage` |
| `tools/Set-VirtualDesk.ps1` | no | yes | no | no | `desk.claim-coverage` |
| `tools/Start-LibrarySeat.ps1` | yes | no | no | yes | `seat.lifecycle` |

**Read the first column exactly.** It says *asserts* the registry lock, which is the declared set of
helpers that call a function reading or writing **across seats**. `Set-VirtualDesk` and `Retire-Seat`
take that lock and appear as `no`, because they touch one seat and call none of those functions. The
ordering of every acquisition, including theirs, is `desk.lock-order`'s. `Start-LibrarySeat` moved to
`yes` on 2026-09-10 by the same road `Enter-LibrarySeat` took the day before: its creation path opens
the new seat's own Project Hub through `Set-DeskEntryForSeat`, because `Set-VirtualDesk.ps1` takes
this same non-reentrant lock and would wait on its own parent.

**A seat operation absent from this table holds none of the four.** `tools/Retire-Seat.ps1` is the
one to expect and not find: it takes the registry lock for its own seat, needs no claim of its own —
it refuses a seat that *is* claimed, which is the opposite question — writes no ownership, and
creates nothing. `tools/Remove-SeatArchive.ps1` is absent for the same reason and it is the one worth
pausing on: it destroys a retirement record, which is as consequential as anything here, and it still
holds none of the four — it writes neither `notebook/` nor a Desk, so no reset ever misjudges its
output, and the only direction it can move a reset is toward refusing more. What it owes instead is
its own refusal, below. `tools/Get-DeskOverview.ps1` is a read and holds none of them either.

**Two things the table cannot tell you.** Whether a control is reached on every path through a
helper — the columns prove it is invoked, and the suites prove the behaviour — and what a helper
does when it is *refused*, which is the wording each refusal owns.

## Two questions that look alike and are not

Confusing them widens a boundary rather than migrating it.

| Question | Whose Desk | Who asks |
| --- | --- | --- |
| Is this material in play anywhere? | the **union** across every seat | archive, remove, rename |
| May THIS session read or change it? | **this seat's Desk alone** | `Edit-ProjectHub`, both manifest updaters |

A missed seat in the first is worse than no check at all: it reports "nothing has this open" and is
wrong. Rename is the sharp case — a seat left behind keeps a `shelf/<old-slug>` entry pointing at a
slug a future Book could occupy, which would hand that seat read access to a Book nobody opened
there. So rename rewrites every seat that holds the entry, journals every Desk it will touch, and
verifies afterwards that no seat anywhere still names the old root.

Answering the second from the union would let another seat's open Book supply this session's
entitlement.

## Migration

`Start-LibrarySeat.ps1` migrates a pre-seat Desk into the named seat. It covers **both** files as one
unit: naming only `.open-books` strands day-one Project Hub state, and `.open-projects` is where this
workspace's own `projects/library-dev` lived, so the omission would have been immediate rather than
theoretical.

It is **additive**. Both files are copied and read back byte-for-byte; the legacy files are left
alone, because a write that provably cannot lose text applies directly while one that can needs an
approval. Retiring them is `-RetireLegacyDesk`, and it needs **no active session**. It used to need an
adapter restart as well, because the validated-reader adapter cached its Desk directory for its
lifetime and one started before the cutover kept reading the old path while every migrated helper read
the seat's. **Step 11 retired that requirement on 2026-09-10**: the adapter resolves per request, so a
running one follows the migration on its next call.

A destination that already exists and **differs** is refused with a byte-level diagnosis rather than
overwritten. The file on disk is the authority the moment it exists — the same rule the Shelf
catalog's migration settled on in Release 1.

This workspace migrated on 2026-09-07 to a seat named `library-dev`, for the Project it already had
open. That is the shape the ruling produces: the seat is named for its work, and no generic fallback
has to exist.

## What the build corrected

**The guard bricked its own author's session.** Made seat-aware, `Guard-ShelfBookRead` read Desk
state *before* judging the path, so with no seat yet created it failed closed on every `Write` —
including writes to files that had nothing to do with the Shelf. `Guard-ShellShelfRead` had always
done it the other way round, with the reason written down: read state only after the cheap text test,
"so a command naming no Shelf path never pays for a state read and never fails closed on state it was
not going to consult." The Desk is consulted last now, and only a path that actually names a Shelf
Book reaches it.

**A new invariant met day-one data, and the fixtures were the day-one data.** Three suites failed the
moment the guards became seat-aware, because every one of them composed `.claude/.open-books` by
hand. They go through the real resolver now, for the reason `Initialize-ShelfCatalogForFixture`
already records: a fixture that spells the layout itself keeps passing against a layout production
has stopped using — it defends the stale shape rather than catching the drift.

**The workspace-from-Desk-directory derivation existed in four places, not the two the plan named.**
`Guard-ShelfBookRead` and `Get-PlaybookContext` were the two it named. The reader adapter had two more
(`Read-ShelfBookPage`, `Read-ShelfCatalog`) and Discovery and open-Book search had one each, all
spelled `Split-Path -Parent $DeskStateDirectory`. Each was correct only while the Desk directory and
the state directory were the same directory; with seats they yield `.claude/seats`, so Discovery
looked for the Shelf catalog one level below the workspace and reported that the workspace had none.
The adapter's own self-test caught it, which is the only reason it was not shipped.

## Reset, and why seats forced it to change

`notebook/` is the one thing seats share that a single command could destroy. `Reset-LocalNotebook`
removed all of it with one `Remove-Item -Recurse -Force`, under no lock and with no journal. With one
Desk that was merely blunt. With N seats it is the most habitual command in the system destroying
another seat's hour-long compile — so the reset half is not separable from the seat half, and both
shipped together.

**Ownership is a separate, crash-safe record.** `internal/notebook-topic-owners.json`, keyed by
topic, maintained by all three Notebook writers — the compiler, Triage's Notebook route, and
`Restore-BookSource`. Naming only the compiler was caught as a defect twice during Release 1's
review, and Triage's route was the worse of the two, so all three record. Reusing
`internal/raw-batch-owners.json` was rejected: it is keyed by *batch*, and a topic may come from
session findings with no batch at all.

**Three scopes, and the last two are declared rather than inferred.**

| Scope | Meaning |
| --- | --- |
| `owned` | a seat's own material; that seat's reset moves it |
| `shared` | deliberately common ground; no seat's reset moves it |
| `excluded` | deliberately out of scope; no seat's reset moves it |

The preflight states which topics are shared or excluded rather than leaving them implicit in the
difference between the owned set and what is on disk. A reset that silently skips a topic and one
that silently includes one are both wrong, and the reader is approving one specific set of moves.

**A topic nobody owns blocks the reset.** `Set-NotebookTopicOwner.ps1` maps it, or declares it shared
or excluded. A `topic-slug == seat-slug` fallback was rejected: it would recognise only
`notebook/main/` and leave real directories like `notebook/library-dev/` unowned and reachable only
by the dangerous whole-tree path. This was free on the day it shipped, because `notebook/` held only
`_master-index.md`, and it gets more expensive with every compiled topic — which is precisely why
it shipped on that day.

**Reset quarantines; it does not delete.** Each target is atomically renamed into
`internal/notebook-reset-quarantine/<seat>-<stamp>/` with a journal beside it, the scaffold is
rebuilt, and restoring and purging are separate approved operations — real ones since 2026-09-10,
`tools/Restore-NotebookQuarantine.ps1` and `tools/Remove-NotebookQuarantine.ps1`. A metadata journal was the first design and
round 1 killed it: JSON cannot restore files after `Remove-Item -Recurse`, so recoverability has to
be a property of the **move**. The repository already used this shape at
`internal/shelf-delete-staging`.

**Ownership revalidated before each move, under the topic lock that makes the answer hold.** A topic
that changed hands since selection is left in place and **reported** — the reader approved a set, and
that is how they learn the set was not what ran. Until 2026-09-09 that revalidation was
check-then-move and its own comment was wrong about why: it claimed the topic lock stabilised the
answer, while the reassignment it was defending against took no topic lock at all. Both halves
changed with [ADR-0019](adr/0019-a-topics-ownership-changes-only-under-its-topic-lock.md) — the remap
takes the topic lock, and `Move-NotebookTopicToQuarantine` now refuses without it rather than
assuming its caller took it. The reset's apply path takes **no** ownership lock at all: the record is
replaced atomically, so a lock-free read is already a consistent snapshot, and a lock is what
serialises writes.

**A claim at this seat is not entitlement to another seat's topic.** The three Notebook writers call
`Assert-NotebookTopicWritable` under the topic lock and refuse a topic owned by another seat, naming
three remedies: work at that seat, reassign it if that seat is dormant, or declare the topic
`shared`. `shared`, `excluded` and `unmapped` topics stay writable — the first two by declaration,
the third because a reset already refuses to guess at material nobody has claimed. The compiler's
preflight and Triage's gate loop report the same verdict through the lock-free
`Test-NotebookTopicWritable`, so a plan is never issued for a write already certain to be refused.

**Reassignment is gated by the acting seat, not the assignee.** Another live seat's topic — `held` or
`orphaned` — may not be taken from it. That split is also why this helper's seatless refusal is
worded for an acting seat rather than offering `-Seat`: see the `unset` note above. A dormant seat's may, which is the recovery route the reset's
own refusal names, and the acting seat may hand over a topic it owns itself. That last case was
written the stricter way first, and the live workspace was the counter-example: seat `library-dev`
owned `notebook/2nd-b-vault-dev` and had to hand it to the seat named for that project, which it did
on the day the rule shipped.

**A whole-tree reset covers this seat plus explicitly retired seats, and hard-refuses every other
one.** Two review rounds got this wrong in two different ways: the first included claimed seats,
which is exactly backwards since "claimed" means active; the second left an unclaimed, unretired
foreign seat undefined. Silently excluding it makes "whole-tree" a false name; including it bypasses
retirement. So it is refused, with the remedy that fits its state — **wait** for a claimed seat,
**retire** a dormant one.

**A sweep is a third remedy, and it asks about the incarnation before it probes**
(2026-09-15, [ADR-0023](adr/0023-idleness-authorises-a-sweep-retirement-still-gates-whole-tree.md)).
`Get-SeatSweepDisposition` answers one ownership row at a time — allow for the acting incarnation and
for an **idle** foreign one, skip for `held`, `orphaned`, **retired** and **unaccounted**, each with
its own reason. The order is the guard: a claim state answers about a *slug* and an ownership row
names a slug *and* an incarnation, so probing first would read a reused slug's new seat and quarantine
the old one's material. `Get-SeatStateMatrix` gains a `sweep` row-set for the three claim states, and
`skip` is deliberately not `refuse` — a sweep names the busy seat and carries on. Nothing here widens
`-WholeTree`, and `seat.resolution-contract` now pins the table's operation set so a row named for the
whole-tree question cannot be added without going red first.

### Retired is a record, not an absence

*(2026-09-10. Pinned by case 22 of `seat.lifecycle` and by `desk.seat-retirement-identity`.)*

**And "explicitly retired" used to mean "not in `.claude/seats/`", which was one `rm -rf` from a
data-loss bug.** That directory is gitignored and nothing restores it, so deleting one seat's folder
by hand — the obvious thing to try when a stale claim will not clear — made every Notebook topic it
owned eligible for the next seat's whole-tree reset, with no refusal at all. Measured in exactly
that shape before the change: with one seat's directory deleted and the registry still naming it, a
whole-tree reset at the other seat selected both of its topics and refused nothing.

**A seat incarnation is retired when an archive record names it *and* no registry entry does.** Both
halves carry weight. The archive record is written only by `tools/Retire-Seat.ps1`, which is gated,
refuses a live seat and reads back what it wrote — so retirement is something that *happened* rather
than something inferred from a file that is missing. The registry is the durable list a deleted
directory does not change, and it is checked first, so a slug that is registered is never read off
an archive of an older incarnation. `Get-SeatIncarnationStatus` is that derivation, and it is the one
every consumer uses.

| Status | Meaning | What a whole-tree reset does |
| --- | --- | --- |
| `live` | the registry names this slug with this incarnation | refuses, naming **wait** or **retire** |
| `retired` | not live, and an archive record names this slug and this incarnation | moves it |
| `unaccounted` | neither — nothing can say that incarnation is finished | refuses, naming three routes out |

`unaccounted` is the case that used to be read as retirement. It is what a partial `git clean` or a
hand-edited registry leaves, and refusing it is the same shape as the unclaimed, unretired foreign
seat above: a state nobody decided to create is not a licence.

**Ownership rows carry the recording incarnation's `seat_id`, which is what lets a slug be reused.**
A new seat under a retired seat's name gets a freshly minted id, so its *ordinary* reset — the
habitual one — sees none of the old incarnation's topics, and its whole-tree reset sees them as the
retired incarnation's. A row recorded before ADR-0018 carries no `seat_id` at all, and that absence
is a real incarnation value meaning "the pre-identity one"; it compares equal only to a registry
entry that also has none. That is why **no backfill was needed**, and a backfill would have been the
dangerous half: stamping ids onto existing rows and entries at different moments is precisely how a
seat stops matching its own material.

**So slug reuse is allowed after a real retirement, and refused when a row cannot be accounted for.**
D12 of `PLAN-seat-launch.md` refused every reuse, correctly, while ownership was keyed by slug alone.
The inheritance reason is gone. What still refuses is an ownership row whose incarnation has no
retirement record — and the reason is *stranding*, not inheritance: taking the slug would make the
question permanently unanswerable, because retirement acts on a registry entry, the name would then
belong to somebody else, and no reset would ever reach that topic again. Creation is the only moment
that can be prevented. The refusal names the row and the routes that clear it. **A seat archive is no
longer a citation at all** — it is the proof of retirement, and treating it as a blocker meant a
properly retired seat's name was refused forever, since nothing purges the archive.

**The approval binds the incarnation too.** The reset's `plan_id` digest covers each target's owning
seat *and* its incarnation, and `Move-NotebookTopicToQuarantine` revalidates both under the topic
lock — so a topic that changed hands to a new incarnation of the same name between the preview and
the run is left in place and reported, rather than moved on an approval that described the old one.

### The recovery routes, and why a purge is not tidying

*(2026-09-10. Pinned by `recovery.routes`.)*

Both stores this model sets material aside in — `internal/notebook-reset-quarantine/` and
`internal/seat-archive/` — were **write-only** until now. The reset reported material as
"recoverable", retirement archived a Desk "rather than discarding it", and nothing read either back;
both this document and the playbook named a purge as "a separate approved operation" that did not
exist. Four routes close that, each with the preflight, exact `plan_id` and one approval the rest of
`tools/` uses.

| Route | Helper | Recoverable |
| --- | --- | --- |
| Put quarantined topics back | `tools/Restore-NotebookQuarantine.ps1` | n/a — additive |
| Destroy a quarantine | `tools/Remove-NotebookQuarantine.ps1` | **no** |
| Put a retired seat's Desk back | `tools/Start-LibrarySeat.ps1 -RestoreDeskFromArchive` | n/a — additive |
| Destroy a retirement record | `tools/Remove-SeatArchive.ps1` | **no** |

**A restore always meets an ownership row, and the row is not necessarily still the right one.** The
reset deliberately *leaves* each quarantined topic's row citing the seat that owned it — that row is
what a restore reads to learn whose material it is, and dropping it at quarantine time would make
every restore a guess. But a slug may be reused after a real retirement, so "seat `fallout`" on a row
and "seat `fallout`" in the registry can be two different incarnations; and a whole-tree reset
quarantines topics belonging to retired incarnations that were never this seat's. So the restore
classifies each topic by (seat, incarnation) with the same `Get-SeatIncarnationStatus` the reset
uses, and states a disposition per topic: **keep** (the row already names this incarnation, or
declares the name `shared`/`excluded`), **record** (no row, and the quarantine's journal says it was
this incarnation's), or **adopt** (somebody else's, or nobody's). `adopt` needs `-Adopt`, because
restoring material the record attributes elsewhere is *taking it over*. A row naming a **live** seat
is refused outright and `-Adopt` does not lift it: that seat's reset is still covering that topic.

**The reset's journal now records who owned each topic**, for exactly that comparison. It recorded
what moved and the seat that *ran* the reset, which under `-WholeTree` is not the owner of most of
what moved — so the one fact a restore most needs was the one fact not written down.

**A purge of a quarantine takes the ownership rows with it.** A purge that deleted only files would
leave the record naming material that exists nowhere: a row no reset can ever clear, because reset
acts on directories and there is no longer one, and a permanent blocker on that seat's slug. The rows
go **first** and the files second, so a failure between them leaves material a restore can still
adopt rather than rows citing nothing. A row whose topic exists in `notebook/` again is kept — it
describes the live copy.

**And purging a seat archive UN-RETIRES the incarnation it recorded.** This is the consequence
retirement's identity created, and it is why this helper is the one that most expects to refuse.
`seat.json` plus absence from the registry is what makes an incarnation `retired`; delete it and its
topics become `unaccounted`, every whole-tree reset refuses them by name, and the slug stops being
reusable — **permanently**, because retirement acts on a registry entry and there would no longer be
one to retire. The guard is measured rather than asserted: every owned row's status is computed twice,
once as things stand and once against the retirement records that would **remain**, and a row that
changes to `unaccounted` refuses the purge. Deriving it from what would remain rather than from the
archive's own seat name is what makes a duplicate record behave — two archives naming one incarnation
means deleting either strands nothing.

**A Desk restore is additive, and the conversation history travels only onto its own slug.** The
Desk lines carry no claim about where they were: `books/basic-memory` is a Book that was open, and
that is equally true wherever it is reopened, so they restore onto any seat. A conversation record
*is* a claim — that a named conversation sat at a named seat — and `Get-SeatsForConversation` acts on
it, so copying `fallout`'s history onto `fallout-2` would send a resumed session to a seat it has
never been at. The plan reports `history` as `merge`, `skipped` or `none` with the reason. Where it
merges, a conversation already on the live record keeps its own stamps (an archived entry is older by
construction, and `last_seen_utc` is what the resume lookup sorts on), and each restored entry keeps
the `seat_id` it was written with — restamping it would claim a conversation sat at an incarnation
that did not exist yet.

## Codex's `apply_patch`

The Shelf guard's `Write`/`Edit` coverage had no Codex counterpart, because Codex edits files through
`apply_patch`. Its shape was **captured, not guessed** — the session that first bound these hooks
guessed the shell tool was named `exec` and shipped a matcher that could never fire.

Captured 2026-09-07 against codex-cli 0.147.0:

```json
{ "tool_name": "apply_patch",
  "tool_input": { "command": "*** Begin Patch\n*** Update File: probe.txt\n@@\n-alpha\n+beta\n*** End Patch" } }
```

Two things that would otherwise have been wrong. `tool_name` is `apply_patch` **verbatim** — it is
not normalised to a Claude Code name the way the shell tool becomes `Bash`. And `tool_input` carries
**no `file_path` at all**: it reuses the shell tool's `command` field, holding the whole patch
document with every path inside the envelope. Registering `apply_patch` against the existing guard
without a parser would have matched and then found nothing to judge — the same silent no-op as the
`exec` matcher.

**One patch carries many files.** A captured payload adds, updates, deletes and moves in a single
call, so every path is judged rather than the first. `*** Move to:` is treated as a path-bearing
directive, because a rename **into** a closed Book is a write into it.

**The directive list is an allowlist, and its cost was measured.** The first version admitted only
`Begin Patch` and `End Patch`, which would have refused every patch that appends to the end of a file
— a false denial on one of the commonest edits there is. A second capture, asking Codex to append a
final line, returned `*** End of File`. It names no file, so admitting it cannot hide a path. The
lesson is the allowlist's own cost: it fails closed on what it has not been taught, so what it is
taught has to come from a real payload.

Column zero is what makes a directive a directive. Patch content lines are prefixed with `+`, `-` or a
space, so a file whose own text contains `*** Begin Patch` appears as `+*** Begin Patch` and cannot be
mistaken for one — the same rule, for the same reason, as the column-zero H1 the Notebook renderer
learned the expensive way.

## The path normaliser's third answer

`ConvertTo-WorkspaceRelative` returned `$null` for both "legitimately outside the workspace" and "a
path form I could not normalise", and the guard read `$null` as allow. Four aliased spellings of a
path **inside** the workspace therefore tested as outside it and walked past the closed-Book guard:
`\\?\`, `//?/`, `\\localhost\D$\` and `\\.\`. Measured against the guard's own anchor, not
reasoned about.

Denying every `$null` instead would have blocked every genuine read outside the workspace, which is
why this is a tri-state rather than a tightened boolean: `outside` is allowed, `invalid` is refused.

**The recognised forms are an allowlist, deliberately not an enumeration of those four.** An
enumeration is always incomplete. Exactly two forms are recognised: a path that is not rooted at all,
joined to the workspace, and a drive-rooted local path. Every other form is `invalid`, UNC included
— because `\\localhost\D$\` *is* a UNC path, and admitting the class to spare the genuine
remote ones would readmit the bypass wholesale. **On macOS and Linux the second form is an absolute
`/` path** ([ADR-0040](adr/0040-a-posix-workspace-is-an-absolute-path-bound-to-the-binary.md), S42):
a backslash reads as a separator, `..` is resolved before the prefix test, the test is
case-insensitive, and a leading `//` -- which POSIX leaves to the implementation -- is `invalid`.

The cost, checked rather than assumed: a genuine remote path like
`\\nas\share\basic-memory\...` is refused, and the refusal names the fix. Nothing in this
workspace reads that path through a guarded tool — `SharedCollectionFiles.ps1` reaches it in-process
with `Test-Path`, which no hook sees — so this denies no call that exists.

## The gate

| Check | What it holds |
| --- | --- |
| `desk.seat-paths-resolve` | No file outside `BookRootSchema.ps1` composes `.open-books` or `.open-projects`. |
| `desk.state-read-and-written-atomically` | Both halves of the Desk's write contract: no production source truncates a Desk path with `WriteAllText` or its kin, and none reads one with `Get-Content` or `ReadAllText`. It also refuses a Desk reader **assigned bare** — neither returns behind a comma, so an empty Desk assigned without `@( )` arrives as `$null`. Its taint walk is **scope-aware**, unlike the derived-index one: every Desk reader in the repository takes its path as a *parameter* of a local helper, so an assignment-only walk would find nothing and pass green on a repository that never had the fix, while tainting `$Path` file-wide would flag the `.library-project` pin read two functions away. Comments are blanked from the token stream rather than filtered by a leading `#`, because half the reasoning here lives in `<# #>` blocks that name `Get-Content` while explaining why it is gone. Falsified seven ways, including the parameter hop on its own and the safe form that must stay green. |
| `desk.lock-order` | Every acquisition follows the one total order; the gate rejects each observed inversion. It reads the wrapper functions from `Get-SeatLockAcquiringFunctions`, classifies a composed root by its literal head, refuses to pass with any declared class unobserved, and pins its own classifier both ways against a fixture. It still sees inversions only — an **absence** is invisible to it, which is why the row below exists — and it does not model releases, so test runners are excluded. |
| `desk.topic-lock-coverage` | Every function that acts on a topic's ownership calls `Assert-NotebookTopicLockHeld`; the declared Notebook writers are exactly those checking ownership, both ways. Falsified against a fixture with a planted **foreign owner**, so a verdict that said "writable" to everything fails rather than passes. |
| `desk.registry-lock-coverage` | Every function that reads or writes across seats calls `Assert-SeatRegistryLockHeld`; every declared caller takes `Enter-SeatRegistryLock`, and the declared set equals the observed one both ways. Falsified against a fixture, so an assertion reduced to `return $true` fails rather than passes. It is what caught `Enter-LibrarySeat.ps1` joining that set on 2026-09-09: its creation path writes the new Desk in-process, because `Set-VirtualDesk.ps1` takes this same non-reentrant lock and would wait on its own parent. |
| `seat.resolution-contract` | The resolution order, the `source` field and the binding-versus-environment refusal, driven over a live fixture so a route that went blind fails rather than passes; the operation-by-state matrix read from `Get-SeatStateMatrix` and asserted as properties -- a foreign agent refused everywhere, a mutator needing a held claim at its own seat, retirement needing an idle one, and a sweep pinned **both ways**, allowing an idle seat and skipping a `held` or `orphaned` one -- rather than copied; the table's operation set pinned at exactly `enter`, `mutate`, `retire`, `sweep`, so the standing warning against a whole-tree row is enforced rather than merely written (ADR-0023); and every `Resolve-SeatName` call site passing the state directory, without which it cannot see a binding. It proves the argument is **passed**, not that the value names the right tree. Since 2026-09-18 it also pins that the **acting-seat** refusal differs from the ordinary one on both routes that word a remedy, in both directions -- the acting-seat form must not offer `-Seat` and the ordinary form must keep offering it -- and that every call resolving an acting seat inside a scope declaring a `-Seat` of its own carries `-ActingSeatOnly`. That last scan reads the **enclosing function**, not the file: the construction it was written for sits inside `Set-NotebookTopicOwner()` in a file that declares no parameters at all. |
| `seat.creation-gate` | Both seat-creation routes call `Assert-NewSeatIsCreatable`, and both Desk-building routes call `Get-NewSeatDeskEntry`, each declared set equal to the observed one both ways; the gate itself is then run against a fixture and must refuse four illegal seats while admitting a legal one. Two declarations rather than one, because validating a creation and writing the new Desk are different routes -- the terminal picker runs the gate, shows the plan and takes the yes, and the launcher does the writing. It exists because the two routes validated different things until 2026-09-10, which let a seat be bound to a Project Hub that does not exist, and disagreed about the Desk for a day after that. |
| `seats.session-start-section-resolves` | The heading the SessionStart hook cuts out of this document resolves, its cut stops at the next section, and the section still carries the ask. Read from the hook's own `-Heading` arguments rather than retyped, and it refuses to pass having found none. ADR-0014's condition: a hook that serves a reworded heading serves nothing, silently. |
| `seats.contract-table-matches-code` | *The contract, in one table* above is a rendering: every cell is compared against the declaration it renders, both ways, every declared helper must have a row, and every proving test must name a check this runner registers. A hand-written table would have been the fifth copy of a rule this document already got wrong four times. |
| `desk.seat-retirement-identity` | Retired means an archive record present **and** absence from the registry, and this workspace's seats agree with `.claude/seats/`. Four planted states -- this seat's own, a registered foreign seat, a retired one, and one with neither a registry entry nor a retirement record -- are classified by the real `Get-NotebookResetTargets` under its own registry lock, so a classifier reduced to "everything is retired" fails and so does its opposite. Removing the archive's `seat.json` must then move the answer, which is what makes the record load-bearing rather than decorative. Its live half is lock-free and reports a disagreement in **this** checkout, including an ownership row whose incarnation nothing can account for. |
| `seat.create-acceptance` | **`-IncludeShared`.** Creating a seat end to end against a disposable workspace: the preflight offers the live active Projects and issues no `plan_id` until one is named, a stale approval is refused with nothing created, and the confirmed transaction leaves a registered seat whose Desk holds its own Hub and whose binding is committed to a live agent. One shared READ -- the Active Project Catalog -- and no shared write. |
| `desk.two-seat-acceptance` | Two seats, real processes: the properties no single-seat test can see, **one entry per section of the suite**. `seats.two-seat-row-matches-suite` compares the sections named here against the suite's own headers, both ways, so this list cannot go on crediting work the suite does not do -- which it did, for four subjects, until 2026-09-18. **1** a Book open at one seat is closed at the other for the read guard AND for the search tier, both ways round: the half-migration that leaves a Book open for reading and closed for searching. **2** an unknown seat and a malformed one each fail closed rather than falling back, with an ordinary file still readable at a seat that does not exist, because the Desk gates Books and not the workspace. **3** a reset at one seat cannot move the other's Notebook topic. **3b** a claim at this seat is not entitlement to another seat's topic (ADR-0019). **3c** the `notebook/` write rule: the six writes that must still be allowed asserted beside the two refusals and the `apply_patch` route, so a guard that denied everything fails the first half rather than passing the second. **3d** `-AllIdleSeats` takes the other seat's topic while it is idle and leaves it while it is held (ADR-0023), both halves on the same topic seconds apart. **4** a rename rewrites every seat holding the Book, the cross-seat scan refuses to answer outside the registry lock, and the single-seat Desk writer the deletion path uses adds and removes without reaching the other seat. **5** the Desk migration refuses a destination that exists and differs. **6** one session per seat, and the claim is what says so. **7** step 11's closing evidence and the widest thing this suite does: a REAL adapter process under a stand-in client named `claude.exe` is refused while no binding exists, the seat is bound while it is still serving, its very next request answers from that seat, a Book only another seat has open is still refused, and the guard -- resolving the same binding from `CLAUDE_PID`, the route a hook child actually has -- reaches the same verdict on both Books. **What it does not reach, stated rather than implied:** Discovery, which spans every Book and is not Desk-gated at all; any Hub or Project-page edit; `Archive-ShelfBook.ps1` and `Remove-ShelfBook.ps1` themselves, as against the Desk writer they share with section 4; and a client restart, which section 7 exists to prove unnecessary. |
| `seat.lifecycle` | The launcher and the retirement helper themselves, as real processes against a fixture: creation and its registry entry, a project collision, the binding refused both ways, a second live claim refused naming the fix, `-Preflight` refused on a live-claimed seat, retirement refusing that seat before a `plan_id` is issued, the plan body reached and coherent, the `plan_id` bound to the Desk it planned, the Desk archived and recoverable byte-for-byte, and malformed, unknown and unparseable input failing closed. Case 13 is the resolution half: the three sources in order, the disagreement refused naming both and reaching `Get-DeskStateDirectory`, identity admitting a mutation against a decoy token, a reused PID neither resolving nor inheriting, an agent bound elsewhere refused by a message naming its own seat, and an unreadable or doubled binding failing closed. Case 14 is the claim holder: the attempt record refused without the registry lock, a real spawned holder taking the handle with this attempt's id on it, the binding-before-attempt order read off the code, a helper that dies between the two commits leaving `orphaned` rather than a stuck handle, and a late or wrong-agent holder acquiring nothing. Case 15 drives `Enter-LibrarySeat.ps1` as a process: bind, re-enter as a no-op, a second agent refused, a second seat refused naming the first, an orphan restored without rewriting the committed binding, and the create gate's offline refusals. Case 16 is the SessionStart hook as a process, a row per `source` value rather than one standing for the rest: the ask and the roster on every fresh value, silence on a compaction, the re-bind of a resumed conversation onto its own free seat, and held, orphaned, retired, reused-slug and failed-bind each answered differently and none of them bound. Case 17 is the Desk line and the backstop recorder: bound, orphaned, environment-named and explicitly named each worded apart, a conversation recorded by the Desk hook alone, and -- with another process holding the registry lock -- the two answers that must come back without waiting for it. Case 18 is the agent-identity half of step 11: real stand-in clients named `claude.exe`, `codex.exe` and `Claude.exe` each resolving their own probe, a probe two steps down crossing an ordinary shell, two probes under one client answering the same agent, and then the walk's stop rules -- not a client, a reused parent pid, a vanished parent, a self-parent, the depth bound and a vanished start -- each driven over the chain those probes CAPTURED with one field changed, each asserted by its own stop signal rather than by the shared answer of zero. Its last part plants a decoy in the ancestry cache: a matching identity must be answered from it, and a wrong one must be discarded and re-walked. Case 19 is the terminal picker, on seats and transcripts no other case touches: six ways a conversation title can be missing each on their own seat, the newer of the two conversation records winning in both directions, a `-NoLaunch` entry keeping the record it did not replace, the columns lining up when one row carries a note, every command and every refusal in the grammar with a distinct reason, a non-interactive caller and a seatless `-Preflight` refused differently, a resume composing `--resume` and a real launch captured through a stand-in agent that writes the argv it was given, a seat with nothing to resume answered in its own words, `+` declined and refused and accepted, an approval that no longer describes the registry refused, `r<number>` declined and accepted through retirement's own gate, the Orca argv checked against the installed binary's `--help` and driven through a stand-in on PATH, and the end of input told apart from an empty answer. Case 20 is the Desk overview's own line, on its own seats and its own transcript trees: this seat resolved from its binding rather than named, its agent, its start time and a bind time edited to a distinctive past instant so a re-stamp reports a wrong VALUE, its conversation carrying the title that says which of two transcript trees was read -- the decoy tree reachable exactly as a defect would reach it, through `CLAUDE_CONFIG_DIR` -- an unbound seat still rendering a sentence rather than a blank, an orphaned seat naming the agent and the repair, the `scope` line admitting the transcript read, and the picker's row for the same seat compared field by field against the overview's line so two copies of one derivation fail rather than agree. Its cosmetic-tier half plants a titled conversation at a FOREIGN seat and asserts the payload never says its name, while asserting that seat's counts and liveness are still present -- so the guard cannot pass by the row going missing. Case 22 is retirement's identity, on its own workspace and on seats the real launcher created so they carry real incarnation ids: a hand-deleted seat directory refused rather than treated as retired and the Desk saying so with a healthy seat beside it as the control, that refusal's named remedy driven through retirement on a seat whose Desk is gone, the archive's `seat.json` removed so eligibility moves with the record, a hand-restored registry entry beating the archive, the slug reused and the new incarnation inheriting none of three topics while resetting its own, the quarantine move refused on an incarnation mismatch with the matching id as its control, and the record's one spelling for "no incarnation". |
| `context.seat-vocabulary` | Every glossary term the seat model declares in `Get-SeatVocabulary` is defined in `CONTEXT.md` with an `_Avoid_` line. It proves the definitions are **present**, never that they are good, and it cannot see a seat term the glossary defines and the code forgot to declare. |
| `codex.project-access-config` | The `apply_patch` matcher names a tool Codex actually reports. |
| `reader.project-pin-selftest` | The two Project reads that resolve the pin themselves read it from `.claude`, never from a seat's Desk directory, and a Deskless session is still refused before the transport. Executed offline against a shadowed transport, with a decoy pin planted in the seat's Desk. |

Every one of them was falsified by reintroducing the defect it guards, in the same pass.
