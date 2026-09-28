# ADR-0059: Bare `deskpost` is the main menu, and `seat start` is its one launcher

**Status:** accepted
**Date:** 2026-09-27
**Effective from:** 1.1 (S55, `PLAN-install-onboarding.md` steps 5 and 5a)
**Relates to:** [ADR-0021](0021-a-cosmetic-reversible-action-is-performed-not-offered.md) (the tab title),
[ADR-0055](0055-the-command-is-deskpost-and-the-binary-stays-library-exe.md) (the command),
[ADR-0057](0057-setup-asks-plans-and-applies-and-the-installer-only-fetches.md) (the default Library and the answers)

## Context

Eric's daily use of the PowerShell Library runs through an Orca Quick Command that opens its seat picker
(`tools/Start-LibrarySeat.ps1` with no `-Seat`); without it the Library is unusable for him. 1.0's kernel had no
picker at all: `library seat start` refused without a name, recorded no conversation (`conversation_recorded: false`),
and could not start Codex on Windows, because Node cannot spawn npm's `codex.cmd` (EINVAL, probed in S55). The plan
brings the picker forward into 1.1 as the product's front door, and makes the product's own name the one command to
come back to.

## Decision

- **Bare `deskpost` opens the main menu** where a person can answer (stdin and stdout both terminals). Anywhere else it
  prints usage, as before, so a caller that cannot be prompted never waits. `deskpost menu` is the same menu by name;
  without a terminal it refuses, naming `seat start` and the seats. `--script <file>` supplies typed answers for a
  suite; it bypasses no gate, and running out of answers is a named failure.
- **Which Library it shows** follows step 5a's five rules: the Library holding the current folder; else the registry's
  `default: true` entry, when valid (marker present, its id the entry's); else the only valid Library; else it asks
  once, offering to make the choice the default; else it says how to make one (`deskpost setup`). A default that is gone
  is said once, and resolution goes on. `LIBRARY_WORKSPACES` is honoured, because the registry reader is the existing
  one. `deskpost library default <folder>` moves the default; `deskpost library list` shows which it is.
- **The roster is `SeatPicker.ps1`'s, at parity**: a numbered row per seat with its Project, occupancy, last activity
  and last conversation's title (or which recorded reason there is none); a table on a wide terminal and cards below
  120 columns or wherever the table would not fit, same numbers either way; `<number>` resumes, `n<number>` starts a
  new conversation, `+` runs the new-seat wizard, `r<number>` retires through `seat retire`'s own preflight and
  plan_id, and a held seat is refused by name with another offered. The rules for which conversation a seat last
  recorded, its title, and the restart of an empty minted conversation are `SeatConversation.ps1`'s
  (`conversation.ts`). A redirected render is plain ASCII with no colour; box drawing and marks are drawn where they
  render. Self-test section 51 compares the rows and the grammar with the PowerShell picker on the same seats.
- **The tools footer reserves `b`**: `+ new seat   b Basic Memory   q quit`. In 1.1 `b` says what Basic Memory is for
  and how to set it up, or which server is connected; everything behind it is its own plan.
- **The first time, with no seats, the menu is only the wizard**: "Name your project", the seat named after the
  project, the title defaulting to the name, an existing Hub reused, a colliding seat name offered `<slug>-2`, a
  project that already has a seat named. **One confirmation, bound to its preview**: it carries the seat-creation
  plan_id, and `seat start --plan-id` revalidates it under the registry lock; a seat created meanwhile, or any change
  to the seats, re-previews instead of committing (`SeatPlanChanged`). It prints the commands it runs.
- **`seat start` is the one launcher** (confirmation round, #2). The menu, the wizard and the tutorial call it in
  process; there is no second launcher. It gains `--session-id <id>`, `--resume <id>`, `--plan-id <id>` and
  `--assistant`, and it **records the conversation** it starts -- the id resumed, or the one minted for Claude Code
  (explicitly, or here when the reader's own agent arguments choose none) -- in `activity.json` and the seat's
  `conversations.json`, source `launcher`, only when an agent actually starts.
- **Resume is per assistant, and an id never crosses** (confirmation round, #1). Every new record carries
  `assistant`; a pre-1.1 record carries none and is Claude Code's. Claude Code resumes with `--resume <id>` and starts
  with `--session-id <id>`; Codex resumes with `codex resume <id>` and takes no id at launch, so its conversation is
  reported by the session: the Desk context hook, in a launcher-held session whose `LIBRARY_SEAT_CLAIM` is the live
  claim's token AND whose agent is the launcher's direct agent -- the first agent client above the hook, with the
  launcher (`DESKPOST_LAUNCHER_PID`) above it and no other agent between -- records the payload's `session_id`, with
  that agent's image name as the assistant. The environment alone proves nothing: a Codex run inside a Claude seat
  inherits it (S55 post-build inspection #1). A binding
  records its assistant too. A Codex conversation's title is a recorded "not read" reason. Choosing the other
  assistant (`a`) starts a new conversation, said on screen. Any other `--command` gets no assistant arguments at all.
- **A command script is started through `cmd.exe /d /s /c`** with every argument quoted; an argument cmd would still
  change inside quotes (`"` or `%`) is refused, naming it.
- **The tab is titled `seat: <name>` once the claim is held**, from `ORCA_TERMINAL_HANDLE` read once, silent on
  success and speaking on failure (ADR-0021). An empty handle renames nothing.
- **An install ends on a fork** (step 5): `setup --welcome`, which install.ps1 runs only for a person at a first
  install, after its lock is released and `pending` cleared. `[Enter] Show me around` creates the Deskpost Help Hub
  (`deskpost-help`, with a minimal `_project` naming its purpose) and a seat of the same name, reusing either, and
  starts the chosen assistant there with "Welcome me to Deskpost and show me around." (amended S56: "Start the Deskpost
  tutorial" named a tutorial not yet written, so Eric's run met a Librarian whose first words were that it did not exist;
  the Hub's purpose now says what a first tour covers, and the preview says what Claude Code or Codex asks on its first
  start in the folder); it is then an ordinary menu seat. `[m]` opens
  the menu; `[q]` is later. With no assistant, only the menu and later are offered. `-Library none` ends with
  `Next: deskpost setup <folder>`; `-Yes`, `-Json`, `CI`, no terminal, an upgrade or a repair end with `Next: deskpost`.
  `init` and `setup <folder>` end with `Next: deskpost`, from inside the Library.

## Consequences

- The Orca Quick Command becomes the single word `deskpost` (`docs/seats.md`). A per-seat button stays out of scope.
- `tools/SeatPicker.ps1` and its launcher stay, unchanged, for the PowerShell Library; section 51 holds the two to the
  same rows and grammar.
- The tutorial's content is its own plan; until it lands the Hub is minimal and the prompt still starts a guided
  conversation.
- **Every question is answered only by what is typed after it appears** (amended S56, `kernel/src/prompt.ts`). The
  menu, the install's question and screen, the fork, and uninstall's and rollback's confirmations share one reader: it
  lets buffered input arrive, sets it aside (a half-typed line too), says so in one line, then prompts. Eric's first
  fresh install, in an Orca tab, had each answer land one prompt early, the plan screen among them; the old reader
  reproduced that cascade at a real console, and the new one did not. Ctrl+C is reported as itself, not as the input
  ending; at uninstall and rollback it answers `q`.
- The first-seat wizard's re-preview on a changed registry is driven by `seat start --plan-id`'s refusal, which the
  self-test pins; a preview left open while another session creates a seat is not reproduced by a scripted run.
- **With no seats, the menu is the fork, and Show me around is `h` everywhere** (amended S57,
  `PLAN-assistant-onboarding.md` step 5). An assistant's install ends with `Next: deskpost`, never the fork, so a
  Library it made reached only the wizard. A Library with no seats now offers `[Enter] Show me around`, `[+] Your first
  seat` (the wizard, unchanged) and `[q] Later`, whatever made it; the footer carries `h  Show me around` in every
  Library, and a first line above the roster offers it while no `deskpost-help` seat exists. It is not hidden once
  used: a conversation id is recorded before the assistant launches, so "has a conversation" would have lost it to a
  first start aborted at Claude Code's trust prompt. Show me around goes only on Enter or `y` (until S57 any answer but
  `q` went ahead), checks an existing seat of that name before creating anything, creates a new seat through the
  wizard's plan_id, and resumes an existing one, with the tour prompt only when its conversation recorded nothing.
  Self-test sections 51 and 52 hold the fork, the footer and the refusals.
