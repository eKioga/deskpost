/**
 * STRAY CONTROL CHARACTERS ARE REFUSED BEFORE ANY WRITE (kickoffs/s94 row 3; the Report "Suspected: hub edit writes a
 * bare carriage return into a page without a warning"). A page's text may hold a tab, a line feed, and a carriage return
 * only as the first half of a CRLF line end. Any other control character (Unicode category Cc: U+0000-U+001F, U+007F,
 * U+0080-U+009F) is refused by every writer that takes --content, --content-path or --body text, naming the line and
 * the code point, so a page never carries a character no reader shows. A bare CR is the case that was seen: Markdown
 * renders the line whole, while a line-based edit splits it.
 */

const NAMES: Record<number, string> = {
  0x00: 'a null character',
  0x08: 'a backspace',
  0x0b: 'a vertical tab',
  0x0c: 'a form feed',
  0x0d: 'a carriage return that is not part of a CRLF line end',
  0x1b: 'an escape character',
  0x7f: 'a delete character',
};

/** The first stray control character in a text, with its 1-based line, or null when there is none. */
export function strayControlCharacter(text: string): { line: number; codePoint: string; name: string } | null {
  let line = 1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0a) {
      line += 1;
      continue;
    }
    if (code === 0x09 || (code === 0x0d && text.charCodeAt(index + 1) === 0x0a)) continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return { line, codePoint: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`, name: NAMES[code] ?? 'a control character' };
    }
  }
  return null;
}

const LINE_NAMES: Record<number, string> = { 0x09: 'a tab', 0x0a: 'a line feed', 0x0d: 'a carriage return' };

/**
 * THE FIRST CONTROL CHARACTER IN ONE LINE OF TEXT, tab, line feed and carriage return included (kickoffs/s96 ruling 3):
 * a seat card is one line of terminal text, so it refuses every Cc character where a page allows a tab and a line end.
 */
export function controlCharacterInLine(text: string): { index: number; codePoint: string; name: string } | null {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return { index, codePoint: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`, name: LINE_NAMES[code] ?? NAMES[code] ?? 'a control character' };
    }
  }
  return null;
}

/** The refusal a writer gives for a text holding a stray control character, or null when it holds none. */
export function strayControlRefusal(text: string, what: string): string | null {
  const stray = strayControlCharacter(text);
  if (stray === null) return null;
  return (
    `${what} has a stray control character on line ${stray.line}: ${stray.codePoint} (${stray.name}). Remove it and run ` +
    'the command again; a tab, a line feed and a CRLF line end are allowed. Nothing was written.'
  );
}
