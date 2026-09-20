# The Desk hook advertises the validated reader by its exact callable name

The Virtual Desk context hook tells every session what is open. It did not tell them what to *call*
to read it. A session that knows a Project is open but not the exact tool name has to guess, and a
guessed MCP tool name does not resolve — which invites the conclusion that the reader is broken and
that going around it is reasonable. That is the one conclusion the Desk guard exists to prevent.

The hook now names the exact callable tool for the kind of material actually open.

## Status

accepted — 2026-08-26, shipped as `1a6efbb`.

Moved here from the Library Development Hub's `Now` section on 2026-08-31 by ADR-0003.

## Considered options

**Name both reader tools always.** Rejected as noise. A session with only a Project open does not
need the Book reader named, and every unnecessary word on an always-on surface is charged against
the context budget.

**Say nothing and rely on the tool catalog.** Rejected. The catalog lists tools but does not connect
them to what is currently open, which is precisely the connection a returning session needs.

## Consequences

`.claude/hooks/Get-VirtualDeskContext.ps1` names
`mcp__validated-book-reader__read_open_book_page` or `..._read_open_project_page` according to what
is open, and names the catalogs when nothing is. One hook serves Claude and Codex both.

**It advertises nothing on malformed Desk state.** A session that cannot trust the Desk is not
handed a reader to use against it.

The hook's **output** had never been tested — only its registration — so it is now driven for real
in `desk.book-root-selftest`. That includes a guard that the tool prefix keeps its hyphens: the Hub
entry that originally asked for this feature spelled it `validated_book_reader`, which is not a
resolvable name. The guard exists because the mistake was already made once, in the request itself.
