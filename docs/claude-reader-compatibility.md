# Claude Reader Compatibility

The validated Book and Project reader is designed for Claude Code's local MCP connection as well
as direct helper tests. A 2026-08-14 acceptance run found and fixed a Windows PowerShell output
encoding defect that otherwise made a normal Book read appear to hang indefinitely in Claude.

## What happened

The adapter returned JSON-RPC through Windows PowerShell 5.1's OEM console encoding. A Buzz
operations page contains a right-arrow character in an example command. That character cannot be
represented by the active OEM code page, which replaced it with raw `0x1A` inside the JSON string.
Raw control characters are invalid in JSON.

Claude received the response quickly but discarded the malformed line. Its pending tool call then
waited until the transport closed, so the visible symptom was a hanging Book reader rather than a
useful parse error. The Library, the canonical-path guard, and persistent stdio transport were not
at fault.

## Fix

`New-McpResult` now uses the adapter's existing `ConvertTo-AsciiJson` helper. Every non-ASCII
character is emitted as a JSON `\u` escape before PowerShell writes stdout. This makes response
validity independent of the Windows console code page and covers normal replies and reader errors.

The smallest correction was preferable to replacing the MCP server: persistent PowerShell stdio,
large responses, the tool schema, and the shared Library all passed direct checks once output was
valid JSON.

## Regression guard

A development regression check starts the real reader as a persistent stdio process with an
isolated Virtual Desk, reads `buzz-self-hosting/buzz/operations`, and verifies:

- the response is valid JSON;
- it contains no raw control characters;
- the formerly breaking right arrow is represented as `\u2192`; and
- the full operations page is returned.

The test uses one read-only shared-Library request and reports `shared_library_write: false`.

## Key Takeaways

- A tool that works in a direct process test can still fail at the JSON boundary used by a client.
- On Windows PowerShell 5.1, stdout encoding is part of an MCP server's protocol contract.
- A failed JSON response must be treated as a visible tool error; until client behavior improves,
  the adapter prevents the malformed output at its source.

> Source: direct Claude Code compatibility diagnosis and acceptance tests on 2026-08-14.
