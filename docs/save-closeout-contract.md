# Save and closeout contract

Reader benefit: both harnesses check whether session work was saved using the same evidence.
Safety boundary: a request or answer never grants writer permission. C21 supplies the kernel core;
C22 supplies hooks, skills, init/doctor wiring and live pilots. The Claude mod stays unchanged.

## Requests and answers

A save point continues the session. Its request preserves the mod's `saveText`, including
`REPORTS_EARLIER_RULE`, `WAITS_RULE` and `NEEDS_YOU_RULE`. Work is checked since the last clean
save, or this conversation's beginning. A Reports line is required only when failed Library
commands were observed. The `save` block is always required, even for unchanged items.

Closeout asks for Reports first, then each open Book and Hub, then this seat's Hub Now and Next.
Its `fillText` and `reportsStep` preserve the words of steps 1-5 of the Letters procedure
`notes/2026-10-11-how-to-close-out-a-session-until-closeout-ships`, substituting this request's open
items, own Hub and examples. The harness command is a parameter. The older letter lacks the mod's
newer duplicate-search and fix-location sentences: C21 standing answer 8 gives the letter's words
precedence for requests, the mod's code for checking rules. The mod's R9 last-save line is added
between Reports and the item list when a clean save exists; a closed own Hub is named as unavailable.

````
```closeout
reports: none: no new defects
hub example: updated _project (Now, Next)
book reference: nothing new: read only
```
````

Use `save` for the save fence. Four item verdicts (`parseCloseoutBlock`, `isWaiting`):

| Verdict | Meaning |
| --- | --- |
| `updated <page>` | Successful write to that item and page observed since the last clean save. |
| `nothing new: <why>` | No update needed; say why. |
| `needs update` | Unfinished; a gap if left in the answer. |
| `waits for Eric: <what needs his yes>` | Waiting, never completed. Still-waiting notes on other verdicts count too. |

Check the last matching fenced block (`parseCloseoutBlock`, `parseReportsLine`). Missing blocks,
item lines, required Reports lines, unresolved updates and unsupported writes are gaps
(`checkCloseout`, `checkSave`). Waiting is separate from gaps (`waitingItems`). The request asks
for a numbered `Needs you (<count>):` list after the block (`NEEDS_YOU_RULE`); the kernel does not
parse that presentation list. Past approval and descriptions such as "what waits for Eric" are
not waits (`isWaiting`). An unexplained first-save `nothing new` for this seat's Hub after
observed turns is a gap (`checkSave`).

`reports: filed "<title>"` requires successful Report capture evidence: since the last clean save
for closeout (`checkCloseout`), since this request for save (`checkSave`). An earlier Report is
`none: filed earlier, "<title>"` (`REPORTS_EARLIER_RULE`). With failed commands, no filing and no
reason, `none` is a gap. Closeout includes failures observed during its own run (`checkCloseout`);
save asks only about its original trouble snapshot. Clean checks clear only trouble included in
the request (`checkSave` R5).

Deliberate tightening over the mod: duplicate item lines are ambiguous and fail; an `updated`
for another seat's Hub fails as the request forbids it; named pages must match observed evidence,
not merely the item; Book locations remain distinct even when slugs match. Same-slug Books can
be qualified as `book name@shelf`, `book name@collection` or `book name@shared`; an unqualified
line is ambiguous when more than one location is open.

Parity fixtures in self-test section 250 retain the installed mod's actual gap and wait
strings. Cases marked `wording` compare semantic gap kinds where explanatory sentences
differ (write/Report evidence, trouble, first save and a closed own Hub); all other cases
also compare the literal gap strings. The `save-wait` case is explicitly marked
`waits-separate`: the mod's save checker includes the wait as a gap, while the kernel
records it in waits alone. Both are unfinished. Source hashes and the scratch oracle run
are recorded in that section; its unmarked results must agree.

## Evidence and records

Records live under `internal/checkpoints/<seat-id>/<conversation-id>.json`, atomically replaced
under a per-record lock. All five `checkpoint` actions require `--conversation <id>` and an
existing seat incarnation. Neither is guessed. IDs must be safe path components; corrupt or
mismatched records refuse. These rules replace UI-owned state and come from the lost-design notes.

Only a recognized Library writer command AND successful result count. Decode every JSON document,
including chained writers and shell framing, respecting quoted/escaped braces. Match canonical
page paths and locations. Preflights, `written: false`, refusals, error exits, malformed output
and reads are never writes. Replayed results count once. Report capture also writes its Book.
Sources: `shellWriteTouches`, `captureBookTouches`, `triageWriteTouches`, `removeHeredocBodies`,
`troubleNote`. Strict result/path checks replace permissive command-only fallbacks. Direct file
edits, rebuild-only and journal-only evidence are excluded: C21 observes writer output, not
arbitrary files. Failed Library commands become trouble, never evidence.
The executable must be named literally; variable Book/page arguments take their identity from the
receipt. Variable executable names and writers embedded inside another language's script are not
recognized. Adapters must forward a recognized writer command rather than guess what such a script ran.

Observation must have begun before a clean check; missing tracking is a gap (surviving stash
design). This proves observation was called, not that all tools were observed. C22 establishes
harness coverage. Save and closeout have separate state. Clean closeout is also a save; save
never completes closeout (`checkSave`, save-row R9). Successful later writes stale an answered
closeout (`recordTouch`); reads and replayed results do not.

A pending request refuses a new one until checked or cancelled (mod awaiting rule). Requests
carry an id, Desk snapshot and optional turn identity. Wrong/replayed ids and wrong turns refuse;
changed open Books/Hubs are a gap. `cancel` clears waiting without saving. C22 connects interrupt
and abandoned-prompt events to cancellation (closeout R1 and surviving checkpoint tests).

## What each harness adds

Codex 0.162.1 exposes UserPromptSubmit, PostToolUse, Stop and Interrupt in native
`hooks/list` (fixture observation, 2026-10-15). The [Codex hook documentation](https://learn.chatgpt.com/docs/hooks)
defines `session_id`, `turn_id`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id`
and nullable `Stop.last_assistant_message`. The checkpoint adapter uses those fields, not a
transcript guess. UserPromptSubmit supplies checkpoint identity and pending-request context;
PostToolUse observes results; Stop checks the actual answer; Interrupt cancels (timeout 3s).
Missing final text records `unchecked: the answer was not available` as a gap. All failures
log to stderr and let the turn proceed. A pending or failed hook check is never a clean result.
Init registers this action only in `.codex/hooks.json`, using the kernel binary or its Node
source front door. Claude Code retains its existing plugin tracker and registrations.
The native listing proves event availability, not delivery or trust; the live proof records those.

Codex's canonical `save` and `closeout` skills live in the program's `.agents/skills` and
are installed only there in Libraries, with the same ownership and collision rules as
`library-help`. They request with `--harness codex` and the hook-provided conversation/turn
identity, follow the returned work request, and leave the actual answer to Stop's check.
Missing hook identity is reported, never guessed. Doctor names three Codex skills and only
`library-help` for Claude. See the [skill installation contract](skill-installation-contract.md).

Each adapter supplies conversation/turn identity, observes tool results, passes the actual final
answer and cancels interrupted requests. Toasts, status rows, `/config`, prompt filling, resume
tests and turn/time/compaction reminders stay in the harness (`closeoutSegments`, `closeoutLines`,
`saveSegments`, `saveLines`, `needsYouLines`, `lastSaveLine` and save-row reminder tests).
