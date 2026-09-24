/**
 * The reader's callable prefix: `HookContext.ps1`'s `Test-ReaderToolPrefix` and its sentence (S38).
 *
 * WHO REGISTERED THE READER DECIDES WHAT IT IS CALLED, each measured in a real session (S37): a
 * workspace's `.mcp.json` offers `mcp__validated-book-reader__<tool>`, the Claude plugin
 * `mcp__plugin_deskpost_validated-book-reader__<tool>`, and Codex -- which spells a server's hyphens as
 * underscores -- `mcp__validated_book_reader__<tool>`. No hook can tell which from its payload, so the
 * registration passes `--reader-tool-prefix`, and every sentence sending a session to the reader names
 * the tool that session is offered. The default is the project form, which is what a Claude
 * registration `library init` writes needs, so it passes nothing.
 */
export const DEFAULT_READER_PREFIX = 'mcp__validated-book-reader__';

/** `$` here is JavaScript's, the end of input; the oracle's `\z` is the same rule. */
export const READER_PREFIX_PATTERN = /^mcp__[A-Za-z0-9_-]+__$/;

export function isReaderPrefix(prefix: string): boolean {
  return READER_PREFIX_PATTERN.test(prefix);
}

/** `Get-ReaderToolPrefixFault`, word for word: the Desk hook and both Shelf guards say it. */
export function readerPrefixFault(prefix: string): string {
  return `the reader tool prefix '${prefix}' is not an MCP tool prefix (mcp__<server>__), so no reader tool can be named. Repair the hook registration.`;
}
