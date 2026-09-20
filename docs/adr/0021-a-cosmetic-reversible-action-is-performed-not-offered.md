# A cosmetic, reversible action is performed, not offered

The terminal seat picker asked one question that was not about where to sit. Having chosen a seat,
the reader was asked `Title this Orca tab 'seat: <name>'? Type yes`, and the rename happened only on
a yes.

The reader met it on 2026-09-14 and asked what the other answer was for. It has no good one. The only
alternative to `seat: <name>` is the Quick Command's own label, `Library Seat` — the **same string on
every tab that button opens** — so declining bought a reader identical tabs and no way to tell which
seat each one held. A question whose every honest answer is the same answer is not a choice; it is a
keystroke wearing one.

## Status

accepted — 2026-09-14.

## Considered options

**Leave the offer.** Rejected, and the reason generalises past this prompt. The picker's other
confirmations are a seat created, a Project Hub written to the **shared collection**, and a Desk
archived — each shown as a plan with a `plan_id` before a yes is taken. A cosmetic yes standing
beside those teaches a reader to type yes without reading the plan above it, and that is paid for at
the prompt which needed reading. Confirmation is a budget, not a courtesy: every unnecessary one
spends the attention the necessary ones are counting on.

**Invert it — rename by default, `no` to decline.** Rejected. It still stops the reader between
their choice and their agent to collect an answer nobody has a reason to give, and it buys only the
ability to keep a tab named after a button.

**Offer a custom title.** Deliberately not a route, ruled by the reader when the question came up:
*"I can't think of a reason why the user would want a custom name, so let's not go down that route
for now."* Orca renames a tab in a keystroke, so the reader who wants one is one keystroke from it
without the Library growing a prompt, a validator and a place for that string to live.

**Perform it.** Accepted. Inside an Orca terminal the tab is titled `seat: <name>` once the claim is
actually held, and nothing is asked.

## Consequences

**The rule, stated once so the next prompt inherits it:** an action that touches nothing durable and
that the reader can undo where they are standing is **performed**, not offered. What earns a
confirmation is consequence — a shared write, a deletion, an archive, a claim taken — and
[Operation Playbooks](../librarian-operation-playbooks.md) already names those. This does not relax
any of them.

**Say nothing on success; keep the failure.** A line reporting that the tab is now called
`seat: <name>` tells the reader what the tab bar is already showing them. The failure line stays,
because that is the case where the tab does *not* say where they are sitting.

**The opt-out that remains is not the reader's.** `-TerminalHandle ''` means "not this tab", and its
customer is `seat.lifecycle`: it is how the suite runs inside a real Orca terminal without retitling
the developer's own tab. The handle is still resolved exactly once, in the launcher's parameter
default, so nothing downstream can read `ORCA_TERMINAL_HANDLE` back out of the environment and
rename anyway.

**A removed question needs a check on the branch that still acts.** Case 19l plants an answer in the
scripted-input queue and asserts it is *still there* after a decision is built **with** a handle —
the branch a re-added prompt would land in. Watching only the no-handle branch would have stayed
green through exactly that regression. Falsified by injecting the prompt back: assertion 709 went
red naming it.

**This is what the pause is for.** Development was paused on 2026-09-10 so the next input would come
from using the Library rather than from the queue. Nothing in `Next` named this prompt; the reader
met it, asked what its other answer was for, and there wasn't one.

Full record: [Seats](../seats.md), *The one-click route from Orca*.
