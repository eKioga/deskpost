# The Validated Reader's Argument Guards

> **Status:** built 2026-08-20. Closes the gap recorded in the Library Development Hub's `Now`
> section on 2026-08-17 — and the gap turned out to be three tools wider than the record said.

## What was wrong

Every tool the validated reader adapter declares carries an input schema with `required` and
`additionalProperties = $false`. **Nothing enforced either.** The handlers reached straight into
`$request.params.arguments.slug`, and under `Set-StrictMode -Version Latest` a read of an argument
the caller did not send throws:

```
The property 'slug' cannot be found on this object. Verify that the property exists.
```

That is a raw engine error surfaced to the reader, in place of the schema's own word. It was
recorded on 2026-08-17 as "a small observation, not yet a defect worth fixing", with
`read_open_project_page` named as the example.

**The record understated it.** Four of the eight tools were unguarded, not one:
`read_open_book_page`, `suggest_active_projects`, `read_open_project_page`, and
`read_open_project_briefing`. Two others — `search_open_books` and `discover_book_pages` — had each
grown their own hand-rolled four-line guard, which is precisely the drift that comes of a rule
written out once per caller rather than once.

## What replaced it

Three functions, `Get-CallArguments`, `Get-RequiredArgument` and `Get-OptionalArgument`, and every
one of the eight tools routes through them. The two hand-rolled guards were deleted rather than left
alongside, so the rule now has one definition.

`tools/call` reads `params` itself through the same guard. A call carrying no `params` at all would
otherwise have thrown a strict-mode error out of the `switch` condition, before there was a tool name
to blame it on; it now falls to the default branch and gets the adapter's ordinary "this adapter
exposes only validated Book and Project reader tools" message.

**Required means present and non-blank.** Every required argument this adapter declares is a string,
so an empty `slug` is not a slug — passing it on would have failed later with a message about the
Desk rather than about the call. Absent and blank get different messages, so they stay
distinguishable.

## What this deliberately does not do

The schemas also declare `additionalProperties = $false`, and **that is still not enforced**. An
unknown argument is ignored, exactly as before. Rejecting one would be a behaviour change for every
existing caller rather than a fix, and the recorded gap was about `required`. The dispatch self-test
reports this honestly as `additional_properties_enforced: false` rather than leaving the reader to
infer that a declared schema is now fully honoured.

## Why the test drives a real process

The two existing adapter self-tests call the reader functions directly, with arguments PowerShell has
already bound — so neither can reach the dispatch loop where this defect lived. A malformed *call* is
a wire-level event.

`-DispatchSelfTest` therefore spawns the adapter as a real child process and speaks JSON-RPC to it
over stdin, the same channel the client uses and the same shape `tools/McpToolInventory.ps1` already
uses to ask it for `tools/list`. Ten cases: six malformed calls, a call with no `params`, the two
previously-guarded tools proving the refactor preserved them, and one regression case proving an
*optional* argument is still read and its absence still means the default.

Every case fails at the guard **before** any Desk or network read, which is what keeps this an
offline check — the property the whole gate depends on.

A case passes only when the response is an error **and** carries the schema's own word **and** does
not contain `cannot be found on this object`. That last clause matters: a raw strict-mode message is
also an error, and accepting it would have passed the suite while the gap stayed open. Confirmed by
mutation — reverting `read_open_book_page` to direct property access fails three of the ten cases,
including with that exact raw message.

## Where it runs

Registered as `reader.dispatch-selftest` in `tools/Invoke-LibraryChecks.ps1`, in the spawned-suite
group: it runs in the full gate and is skipped by `-Fast`, so the pre-commit hook does not pay for a
process spawn. It is named in the `-Fast` skip list as well as in the `else` branch — per the
`meter-status.selftest` lesson of 2026-08-20, **check where a new self-test runs, not only that it
passes.**

Since 2026-09-08 that pairing is asserted rather than remembered.
`gate.fast-roster-matches-suites` derives both sets from the runner's own AST -- the
`Invoke-Check` names inside the `$Fast` else branch, and the string roster in the `$Fast` arm --
and fails if either name is missing its twin, in whichever direction. The habit above is still
the right one, because the check answers only half of it: it cannot say where a *static* check
is registered, and a static check put in the else branch is skipped by the very run it exists to
protect.
