# ADR 0095: A refusal asked for as JSON is also one object on standard output

Status: accepted. Kickoff c160, 2026-11-17.

A caller requesting JSON reads standard output. An empty stream on refusal makes that caller parse a second stream to find what happened.

The kernel keeps the refusal on standard error and its non-zero exit code. When the command's own arguments include `--json`, it also emits one object with `status: "refused"`, `refusal` containing the standard error text without its trailing newline, `verb`, and `action` (null for the bare verb). Host-specific remedies match standard error. An existing command-specific refusal object takes precedence; nothing is appended to output already written.

Unknown verbs, the bare menu and unexpected exceptions keep their existing output. Arguments after a passthrough `--` belong to the launched program. The installer treats a refusal object as no report and avoids repeating it beside standard error. The exit code and explicit refused status distinguish this object from a successful result.
