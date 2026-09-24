/**
 * PowerShell-shaped JSON, because the acceptance matrix compares FILES and not just answers.
 *
 * `tools/AcceptanceMatrix.ps1` captures one entry per file left under the workspace and compares
 * the normalised text. Normalisation removes paths, timestamps, GUIDs, line endings and trailing
 * whitespace -- and nothing else. INDENTATION SURVIVES IT. Every JSON document the PowerShell arm
 * writes went through `ConvertTo-Json`, whose layout is not `JSON.stringify`'s at any indent
 * setting, so a kernel that wrote ordinary two-space JSON would differ from the oracle on every
 * byte of every settings file it touched, for a reason that has nothing to do with behaviour.
 *
 * THE RULE, MEASURED AGAINST Windows PowerShell 5.1 RATHER THAN INFERRED:
 *
 *   - A property is `"key":  value` -- TWO spaces after the colon.
 *   - A container's children are indented to (the column its own opening bracket was written at)
 *     + 4, so nesting depth is not what decides the indent: the length of the key above it is.
 *     `"mcpServers":  {` puts the brace at column 19, so its members start at column 23.
 *   - A container's closing bracket sits at its opening bracket's column.
 *   - An EMPTY container is the opening bracket, a newline, an empty line, then the close.
 *   - `<`, `>`, `&` and `'` are escaped as \uXXXX (the JavaScriptSerializer inheritance), control
 *     characters below 0x20 use the short escapes where they have one and \uXXXX otherwise, and
 *     non-ASCII is written literally.
 *
 * WRITTEN AS A SERIALIZER RATHER THAN A FORMATTER OF `JSON.stringify` OUTPUT, because the column
 * rule needs the key's length at the moment the value is written, which is exactly what a
 * re-indent pass over finished text no longer has.
 */

export type PsJsonValue =
  | string
  | number
  | boolean
  | null
  | PsJsonValue[]
  | { [key: string]: PsJsonValue };

const SHORT_ESCAPES = new Map<number, string>([
  [0x08, '\\b'],
  [0x09, '\\t'],
  [0x0a, '\\n'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
  [0x22, '\\"'],
  [0x5c, '\\\\'],
]);

/** The four printable characters PowerShell escapes anyway, for HTML contexts it no longer has. */
const UNICODE_ESCAPED = new Set([0x3c, 0x3e, 0x26, 0x27]);

export function psJsonString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const short = SHORT_ESCAPES.get(code);
    if (short !== undefined) {
      out += short;
    } else if (UNICODE_ESCAPED.has(code) || code < 0x20) {
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else {
      out += character;
    }
  }
  return out + '"';
}

function psJsonNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(
      `ConvertTo-Json has no spelling for ${value}; a non-finite number is a defect upstream of here.`,
    );
  }
  return String(value);
}

/**
 * One value, written as though `ConvertTo-Json` had written it.
 *
 * `column` is where this value's first character lands, which for a property's value is the column
 * after the key and its two spaces, and for the document root is 0.
 */
function writeValue(value: PsJsonValue, column: number): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return psJsonString(value);
  if (typeof value === 'number') return psJsonNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  const inner = ' '.repeat(column + 4);
  const close = ' '.repeat(column);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[\n\n' + close + ']';
    const items = value.map((item) => inner + writeValue(item, column + 4));
    return '[\n' + items.join(',\n') + '\n' + close + ']';
  }

  const keys = Object.keys(value);
  if (keys.length === 0) return '{\n\n' + close + '}';
  const members = keys.map((key) => {
    const label = psJsonString(key) + ':  ';
    return inner + label + writeValue(value[key] as PsJsonValue, column + 4 + label.length);
  });
  return '{\n' + members.join(',\n') + '\n' + close + '}';
}

/** A whole document, with no trailing newline. Callers that write a file add one, as the tools do. */
export function psConvertToJson(value: PsJsonValue): string {
  return writeValue(value, 0);
}
